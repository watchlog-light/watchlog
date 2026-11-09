// SPDX-License-Identifier: AGPL-3.0-only

package redis

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/integrations/resp"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

const info72 = "# Server\r\nredis_version:7.2.5\r\nuptime_in_seconds:3600\r\n# Clients\r\nconnected_clients:12\r\nblocked_clients:1\r\n" +
	"# Memory\r\nused_memory:104857600\r\nused_memory_rss:125829120\r\nmem_fragmentation_ratio:1.20\r\n" +
	"# Persistence\r\nrdb_changes_since_last_save:42\r\nrdb_last_save_time:1794200000\r\nrdb_last_bgsave_status:err\r\naof_enabled:0\r\n" +
	"# Stats\r\nkeyspace_hits:900\r\nkeyspace_misses:100\r\nevicted_keys:7\r\nexpired_keys:3\r\ntotal_commands_processed:5000\r\nrejected_connections:2\r\n" +
	"# Replication\r\nrole:master\r\nconnected_slaves:1\r\nslave0:ip=10.244.1.5,port=6379,state=online,offset=900,lag=1\r\nmaster_repl_offset:1000\r\n" +
	"# Commandstats\r\ncmdstat_get:calls=300,usec=600,usec_per_call=2.00\r\ncmdstat_set:calls=100,usec=500,usec_per_call=5.00\r\n" +
	"# Keyspace\r\ndb0:keys=50,expires=10,avg_ttl=0\r\n"

func values(s []metrics.Sample) map[string]float64 {
	out := map[string]float64{}
	for _, x := range s {
		key := x.Name
		for _, l := range x.Labels {
			if l.Name != "member" {
				key += "{" + l.Name + "=" + l.Value + "}"
			}
		}
		out[key] = x.Value
	}
	return out
}

func TestInfoSamples(t *testing.T) {
	info := ParseInfo(info72)
	if info.Version() != "7.2.5" || ParseInfo("valkey_version:8.0.1\nredis_version:7.2.4").Version() != "8.0.1" {
		t.Fatalf("versions: %q", info.Version())
	}
	v := values(InfoSamples(info, "redis-0"))
	want := map[string]float64{
		"watchlog_redis_memory_used_bytes":                        104857600,
		"watchlog_redis_blocked_clients":                          1,
		"watchlog_redis_keyspace_hits_total":                      900,
		"watchlog_redis_evicted_keys_total":                       7,
		"watchlog_redis_rdb_last_save_ok":                         0,
		"watchlog_redis_is_primary":                               1,
		"watchlog_redis_replica_offset_lag_bytes{replica=slave0}": 100,
		"watchlog_redis_replica_ack_age_seconds{replica=slave0}":  1,
		"watchlog_redis_replica_online{replica=slave0}":           1,
		"watchlog_redis_keys{db=db0}":                             50,
		"watchlog_redis_keys_expiring{db=db0}":                    10,
		"watchlog_redis_command_calls_total{command=get}":         300,
		"watchlog_redis_command_usec_total{command=set}":          500,
		"watchlog_redis_rejected_connections_total":               2,
	}
	for k, w := range want {
		if v[k] != w {
			t.Errorf("%s = %v, want %v", k, v[k], w)
		}
	}
	replica := values(InfoSamples(ParseInfo("role:slave\nmaster_link_status:down\nmaster_last_io_seconds_ago:42\n"), "redis-1"))
	if replica["watchlog_redis_master_link_up"] != 0 || replica["watchlog_redis_master_last_io_seconds"] != 42 {
		t.Errorf("replica = %v", replica)
	}
}

func TestSlowlogIsNormalised(t *testing.T) {
	entry := []any{int64(1), int64(1794200000), int64(25000),
		[]any{"SET", "session:9f2c", "secret-value", "EX", "60"}, "10.244.2.9:51234", "app"}
	rows := Slowlog([]any{entry}, "redis-0", true)
	if rows[0]["command"] != "SET session:* ? ? ?" || rows[0]["client"] != "10.244.2.9" || rows[0]["usec"] != int64(25000) {
		t.Errorf("row = %v", rows[0])
	}
	if strings.Contains(fmt.Sprint(rows), "secret-value") || strings.Contains(fmt.Sprint(rows), "9f2c") {
		t.Error("a value or a key name reached the slow log row")
	}
	if off := Slowlog([]any{entry}, "redis-0", false); off[0]["command"] != "SET" {
		t.Errorf("query text off = %v", off[0])
	}
	if Prefix("user:{42}:cart") != "user:" || Prefix("plainkey") != "" || Prefix("{tag}x") != "{" {
		t.Error("prefix")
	}
}

func TestClientsAndHistogram(t *testing.T) {
	list := "id=3 addr=10.244.1.7:4001 fd=8 flags=N\nid=4 addr=10.244.1.7:4002 fd=9 flags=N\nid=5 addr=[::1]:4003 flags=N\nid=6 addr=10.244.1.9:4004 flags=S\n"
	c := Clients(list, "redis-0")
	if len(c) != 2 || c[0]["addr"] != "10.244.1.7" || c[0]["connections"] != 2 || c[1]["addr"] != "::1" {
		t.Errorf("clients = %v", c)
	}
	h := Histogram([]any{
		"get", []any{"calls", int64(10), "histogram_usec", []any{int64(1), int64(4), int64(8), int64(10)}},
		"set", []any{"calls", int64(2), "histogram_usec", []any{int64(8), int64(2)}},
	})
	if h["1e-06"] != 4 || h["8e-06"] != 12 {
		t.Errorf("histogram = %v", h)
	}
}

// ---------------------------------------------------------------- real servers

// WATCHLOG_TEST_REDIS: name=host:port,… of servers without a password (Redis 6.2, 7.2,
// Valkey 8 …). The tests make users, keys and slow log entries in them.
func servers(t *testing.T) map[string]string {
	t.Helper()
	env := os.Getenv("WATCHLOG_TEST_REDIS")
	if env == "" {
		t.Skip("set WATCHLOG_TEST_REDIS=name=host:port,… to test against real servers")
	}
	out := map[string]string{}
	for _, p := range strings.Split(env, ",") {
		if name, addr, ok := strings.Cut(p, "="); ok {
			out[name] = addr
		}
	}
	return out
}

func admin(t *testing.T, addr string, args ...string) any {
	t.Helper()
	ctx := context.Background()
	c, err := resp.Dial(ctx, addr, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	v, err := c.Do(ctx, args...)
	if err != nil {
		t.Fatalf("%v: %v", args, err)
	}
	return v
}

// The generated user's ACL, as the backend's command writes it (connectCommand).
var generatedACL = []string{"reset", "on", ">wl_mon_EXAMPLExEXAMPLExEXAMPLEx", "~*", "+info", "+ping", "+slowlog", "+latency", "+config|get", "+client|list", "+memory|stats", "+memory|usage", "+scan"}

func TestAgainstRealServers(t *testing.T) {
	for name, addr := range servers(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			admin(t, addr, "FLUSHALL")
			for i := range 30 {
				admin(t, addr, "SET", fmt.Sprintf("session:%d", i), strings.Repeat("x", 100))
				admin(t, addr, "SET", fmt.Sprintf("cart:%d", i), "v")
			}
			admin(t, addr, "CONFIG", "SET", "slowlog-log-slower-than", "0")
			admin(t, addr, "GET", "session:1")
			admin(t, addr, "CONFIG", "SET", "slowlog-log-slower-than", "10000")
			admin(t, addr, append([]string{"ACL", "SETUSER", "watchlog"}, generatedACL...)...)
			admin(t, addr, "ACL", "SETUSER", "noinfo", "reset", "on", ">a-password-for-tests", "+ping")
			admin(t, addr, "ACL", "SETUSER", "nolatency", "reset", "on", ">a-password-for-tests", "~*", "+info", "+ping", "+config|get")
			r := New()
			members := []integrations.Member{{Name: name + "-0", Address: addr}}
			target := func(user, pass string) integrations.Target {
				t := integrations.Target{ID: "svc", Type: "redis", Members: members, Settings: integrations.Settings{QueryText: true}}
				if pass != "" {
					t.Auth = &integrations.Auth{Username: user, Password: pass}
				}
				return t
			}

			// Probes: the default user works but can do too much; the generated user is
			// exactly right; a user without +info, a wrong password, missing commands.
			def := r.Probe(ctx, target("", ""))
			if def.Code != integrations.ProbeOK || len(def.Excess) == 0 || def.Version == "" {
				t.Errorf("default user probe = %+v", def)
			}
			// Valkey says it is Valkey, with its own version (8.x, not the Redis 7.2 it
			// emulates); Redis says nothing.
			if strings.HasPrefix(name, "valkey") {
				if def.Facts["product"] != "valkey" || !strings.HasPrefix(def.Version, "8.") {
					t.Errorf("valkey probe = %+v", def)
				}
				if res := r.Scrape(ctx, target("", ""), false); res.Product != "valkey" || !strings.HasPrefix(res.ServiceVersion, "8.") {
					t.Errorf("valkey scrape: product %q version %q", res.Product, res.ServiceVersion)
				}
			} else if def.Facts["product"] != nil {
				t.Errorf("redis probe names a product: %+v", def.Facts)
			}
			gen := r.Probe(ctx, target("watchlog", "wl_mon_EXAMPLExEXAMPLExEXAMPLEx"))
			if gen.Code != integrations.ProbeOK || len(gen.Excess) != 0 || len(gen.Missing) != 0 {
				t.Errorf("generated user probe = %+v", gen)
			}
			if p := r.Probe(ctx, target("noinfo", "a-password-for-tests")); p.Code != integrations.ProbePermission || p.Missing[0] != "+info" {
				t.Errorf("no +info probe = %+v", p)
			}
			if p := r.Probe(ctx, target("watchlog", "wrong")); p.Code != integrations.ProbeAuthFailed {
				t.Errorf("wrong password probe = %+v", p)
			}
			if p := r.Probe(ctx, target("nolatency", "a-password-for-tests")); p.Code != integrations.ProbePermission || !strings.Contains(strings.Join(p.Missing, " "), "+latency") {
				t.Errorf("missing commands probe = %+v", p)
			}

			// A heavy scrape with the generated user: every source answers.
			res := r.Scrape(ctx, target("watchlog", "wl_mon_EXAMPLExEXAMPLExEXAMPLEx"), true)
			if res.State != integrations.StateOK || !res.Members[0].Up || len(res.Permissions) != 0 {
				t.Fatalf("scrape = state %s err %q members %+v perms %+v", res.State, res.Error, res.Members, res.Permissions)
			}
			v := values(res.Samples)
			for _, k := range []string{"watchlog_redis_memory_used_bytes", "watchlog_redis_memory_dataset_bytes", "watchlog_redis_maxclients", "watchlog_redis_keys{db=db0}"} {
				if _, ok := v[k]; !ok {
					t.Errorf("no %s", k)
				}
			}
			if v["watchlog_redis_prefix_keys{prefix=session:}"] != 30 {
				t.Errorf("prefix sample: %v", v["watchlog_redis_prefix_keys{prefix=session:}"])
			}
			slow, _ := res.Extra["slowlog"].([]map[string]any)
			found := false
			for _, s := range slow {
				found = found || s["command"] == "GET session:*"
			}
			if !found {
				t.Errorf("slow log = %v", slow)
			}
			// A user without +info: the member is down with the fix in its error.
			down := r.Scrape(ctx, target("noinfo", "a-password-for-tests"), false)
			if down.State != integrations.StateError || !strings.Contains(down.Members[0].Error, "+info") {
				t.Errorf("no +info scrape = %+v", down)
			}
			// A user without +latency: that panel needs a permission, the rest works.
			partial := r.Scrape(ctx, target("nolatency", "a-password-for-tests"), true)
			if partial.State != integrations.StateOK || len(partial.Permissions) == 0 {
				t.Errorf("partial scrape = %+v", partial.Permissions)
			}
		})
	}
}

// A server that requires a password: probing without one says so.
func TestNeedsAPassword(t *testing.T) {
	addr := os.Getenv("WATCHLOG_TEST_REDIS_AUTH")
	if addr == "" {
		t.Skip("set WATCHLOG_TEST_REDIS_AUTH=host:port of a requirepass server")
	}
	p := New().Probe(context.Background(), integrations.Target{Type: "redis", Members: []integrations.Member{{Name: "r", Address: addr}}})
	if p.Code != integrations.ProbeAuthFailed || p.Error != "the server needs a password" {
		t.Errorf("probe = %+v", p)
	}
	// A scrape says the same, so the page reads "can't log in", not "unreachable".
	tg := integrations.Target{ID: "t", Type: "redis", Members: []integrations.Member{{Name: "r", Address: addr}}}
	for _, auth := range []*integrations.Auth{nil, {Password: "wrong"}} {
		tg.Auth = auth
		if res := New().Scrape(context.Background(), tg, true); res.ErrorCode != integrations.ProbeAuthFailed {
			t.Errorf("scrape with %v: %s %q", auth, res.ErrorCode, res.Error)
		}
	}
}

// Commands whose arguments can be credentials keep only their name in the slow log,
// whatever the server redacts itself (a password with ':' would look like a key prefix).
func TestSlowlogCredentials(t *testing.T) {
	for _, args := range [][]any{
		{"AUTH", "app:s3cret"},
		{"AUTH", "app", "s3cret:x"},
		{"HELLO", "3", "AUTH", "app", "s3cret"},
		{"MIGRATE", "h", "6379", "k", "0", "5000", "AUTH", "s3cret"},
		{"ACL", "SETUSER", "watchlog", "on", ">s3cret:x"},
		{"CONFIG", "SET", "requirepass", "s3cret:x"},
	} {
		got := normalise(args, true)
		if strings.Contains(got, "s3cret") || strings.Contains(got, "app") || strings.Contains(got, "watchlog") {
			t.Errorf("normalise(%v) = %q", args, got)
		}
	}
	if got := normalise([]any{"ACL", "SETUSER", "watchlog"}, true); got != "ACL SETUSER" {
		t.Errorf("ACL: %q", got)
	}
}
