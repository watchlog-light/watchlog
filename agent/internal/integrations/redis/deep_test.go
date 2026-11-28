// SPDX-License-Identifier: AGPL-3.0-only

package redis

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
)

// CLIENT LIST lines as Redis 7.2.17 gave them in Step 0 (the Sentinel's two links, a writer,
// a blocked stream reader, a subscriber with a full buffer, the collector itself).
const clientList = `id=4 addr=172.26.0.11:44562 laddr=172.26.0.9:6379 fd=10 name=sentinel-0815b537-cmd age=222 idle=0 flags=N db=0 sub=0 psub=0 ssub=0 multi=-1 omem=0 tot-mem=23424 cmd=ping user=default
id=8 addr=172.26.0.30:5000 laddr=172.26.0.9:6379 fd=12 name= age=3 idle=0 flags=N db=0 sub=0 psub=0 ssub=0 multi=-1 omem=0 tot-mem=20000 cmd=set user=default
id=9 addr=172.26.0.30:5001 laddr=172.26.0.9:6379 fd=13 name= age=400 idle=2 flags=N db=0 sub=0 psub=0 ssub=0 multi=-1 omem=0 tot-mem=20000 cmd=set user=default
id=10 addr=172.26.0.31:6000 laddr=172.26.0.9:6379 fd=14 name=billing age=900 idle=1 flags=b db=0 sub=0 psub=0 ssub=0 multi=-1 omem=0 tot-mem=21000 cmd=xreadgroup user=default
id=11 addr=172.26.0.32:7000 laddr=172.26.0.9:6379 fd=15 name= age=900 idle=0 flags=P db=0 sub=2 psub=0 ssub=0 multi=-1 omem=30000000 tot-mem=30020000 cmd=subscribe user=default
id=3 addr=172.26.0.8:45544 laddr=172.26.0.9:6379 fd=8 name= age=225 idle=0 flags=S db=0 sub=0 psub=0 multi=-1 omem=0 tot-mem=20512 cmd=replconf user=default
id=12 addr=172.26.0.40:1 laddr=172.26.0.9:6379 fd=16 name= age=0 idle=0 flags=N db=0 sub=0 omem=0 tot-mem=1 cmd=client|list user=watchlog`

func TestClientsDetail(t *testing.T) {
	rows := ClientsDetail(clientList, 30)
	by := map[string]ClientRow{}
	for _, r := range rows {
		by[r.Addr] = r
	}
	if len(rows) != 4 {
		t.Fatalf("%d rows: %+v", len(rows), rows)
	}
	if w := by["172.26.0.30"]; w.Connections != 2 || w.Young != 1 || w.Command != "set" || w.IdleMin != 0 {
		t.Fatalf("%+v", w)
	}
	if b := by["172.26.0.31"]; b.Blocked != 1 || b.Name != "billing" {
		t.Fatalf("%+v", b)
	}
	if s := by["172.26.0.32"]; s.Subscribed != 1 || s.Class != "pubsub" || s.OutputMax != 30000000 {
		t.Fatalf("%+v", s)
	}
	lim := BufferLimits("normal 0 0 0 slave 268435456 67108864 60 pubsub 32mb 8mb 60")
	if lim["pubsub"] != 32<<20 || lim["normal"] != 0 || lim["replica"] != 268435456 {
		t.Fatalf("%v", lim)
	}
}

func TestSlowerNeedsThreeInARow(t *testing.T) {
	p := newPass(time.Now())
	for _, d := range []time.Duration{time.Millisecond, 500 * time.Microsecond, 700 * time.Microsecond} {
		if p.slower(d) {
			t.Fatal("baseline")
		}
	}
	if p.baseline != 700*time.Microsecond {
		t.Fatalf("%v", p.baseline)
	}
	// Two slow calls, a normal one, two slow again: never three in a row.
	for i, d := range []time.Duration{5, 5, 1, 5, 5} {
		if p.slower(d * time.Millisecond) {
			t.Fatalf("call %d: a spike stopped it", i)
		}
	}
	if !p.slower(5 * time.Millisecond) {
		t.Fatal("three in a row didn't")
	}
}

func TestAgeOfID(t *testing.T) {
	now := time.UnixMilli(1795884277031)
	if a := AgeOfID("1795884217031-0", now); a != 60 {
		t.Fatalf("%v", a)
	}
	if AgeOfID("junk", now) != 0 {
		t.Fatal("junk")
	}
}

func TestSentinelAndShards(t *testing.T) {
	info := ParseInfo("# Sentinel\r\nsentinel_masters:1\r\nmaster0:name=shop,status=ok,address=172.26.0.9:6379,slaves=1,sentinels=1\r\n")
	m := SentinelMasters(info)
	if len(m) != 1 || m[0]["name"] != "shop" || m[0]["status"] != "ok" {
		t.Fatalf("%v", m)
	}
	shards := []any{[]any{"slots", []any{int64(0), int64(5460)}, "nodes", []any{[]any{"id", "a", "port", int64(6379), "ip", "172.26.0.13", "role", "master", "health", "online"}}}}
	s := Shards(shards)
	if len(s) != 1 || s[0]["slots"] != 5461.0 || s[0]["node"] != "172.26.0.13:6379" {
		t.Fatalf("%v", s)
	}
}

func TestPassRows(t *testing.T) {
	p := newPass(time.Now())
	p.prefixes["session:"] = &prefixAgg{bytes: 600, keys: 6, ttl: 0, types: map[string]float64{"string": 6}}
	p.prefixes["cart:"] = &prefixAgg{bytes: 300, keys: 3, ttl: 3, types: map[string]float64{"string": 2, "hash": 1}}
	p.prefixes["rate:"] = &prefixAgg{bytes: 100, keys: 1, ttl: 1, types: map[string]float64{"string": 1}}
	p.sampled, p.total = 10, 1000
	rows := p.Rows(2)
	if len(rows) != 3 || rows[0].Prefix != "session:" || rows[0].Bytes != 60000 || rows[0].Keys != 600 || rows[0].TTLShare != 0 {
		t.Fatalf("%+v", rows)
	}
	if rows[1].Type != "string" || rows[1].TTLShare != 1 || rows[2].Prefix != "other" || rows[2].Keys != 100 {
		t.Fatalf("%+v", rows)
	}
	if thp, oc, ok := hostSettings(func(p string) ([]byte, error) {
		if strings.Contains(p, "hugepage") {
			return []byte("[always] madvise never\n"), nil
		}
		return []byte("0\n"), nil
	}); !ok || thp != "always" || oc != 0 {
		t.Fatalf("%s %v", thp, oc)
	}
	if _, _, ok := hostSettings(func(string) ([]byte, error) { return nil, errors.New("no") }); ok {
		t.Fatal("no file")
	}
}

func TestInfoSamplesDeep(t *testing.T) {
	info := ParseInfo("redis_version:7.2.17\r\nused_cpu_user_main_thread:0.3\r\nused_cpu_sys_main_thread:0.8\r\nlatest_fork_usec:248\r\nmaxmemory:67108864\r\nmaxmemory_policy:noeviction\r\ncmdstat_set:calls=39000,usec=35484,usec_per_call=0.91,rejected_calls=2,failed_calls=5\r\nlatency_percentiles_usec_set:p50=1.003,p99=7.007,p99.9=22.015\r\nrole:master\r\n")
	got := map[string]float64{}
	for _, s := range InfoSamples(info, "m") {
		k := s.Name
		for _, l := range s.Labels {
			if l.Name == "quantile" {
				k += "/" + l.Value
			}
		}
		got[k] = s.Value
	}
	want := map[string]float64{"watchlog_redis_main_thread_cpu_seconds_total": 1.1, "watchlog_redis_fork_seconds": 0.000248,
		"watchlog_redis_memory_max_bytes": 67108864, "watchlog_redis_command_failed_total": 7,
		"watchlog_redis_command_latency_seconds/0.99": 7.007e-6}
	for k, v := range want {
		if d := got[k] - v; d > 1e-9 || d < -1e-9 {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
}

// TestLabScrape scrapes the Step 0 instances (WATCHLOG_TEST_REDIS_LAB: "name=host:port,…;…"
// one target per ";", ACL user watchlog with WATCHLOG_TEST_REDIS_LAB_PASSWORD; a name starting
// with "noauth" connects without one) heavy, 25 times with the sampler's passes, prints the
// series families and extras, and fails if a value or a full key name left the agent.
func TestLabScrape(t *testing.T) {
	lab := os.Getenv("WATCHLOG_TEST_REDIS_LAB")
	if lab == "" {
		t.Skip("WATCHLOG_TEST_REDIS_LAB not set")
	}
	for _, target := range strings.Split(lab, ";") {
		var members []integrations.Member
		for _, m := range strings.Split(target, ",") {
			name, addr, _ := strings.Cut(m, "=")
			members = append(members, integrations.Member{Name: name, Address: addr})
		}
		tg := integrations.Target{ID: "lab", Type: "redis", Members: members, Settings: integrations.Settings{QueryText: true}}
		if !strings.HasPrefix(members[0].Name, "noauth") {
			tg.Auth = &integrations.Auth{Username: "watchlog", Password: os.Getenv("WATCHLOG_TEST_REDIS_LAB_PASSWORD")}
		}
		r := New()
		// The collector's clock, 30 s a heavy scrape as in production, so the sampler's
		// 10-minute windows pass without waiting for them.
		fake := time.Now()
		r.Now = func() time.Time { return fake }
		scrapes := 25
		if n, err := strconv.Atoi(os.Getenv("WATCHLOG_TEST_REDIS_LAB_SCRAPES")); err == nil {
			scrapes = n
		}
		var res integrations.Result
		var took []time.Duration
		for i := 0; i < scrapes; i++ {
			fake = fake.Add(30 * time.Second)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			t0 := time.Now()
			res = r.Scrape(ctx, tg, true)
			took = append(took, time.Since(t0))
			cancel()
			if res.State != integrations.StateOK {
				t.Fatalf("%s: %s %s", target, res.State, res.Error)
			}
		}
		fams := map[string]int{}
		for _, s := range res.Samples {
			fams[s.Name]++
		}
		names := make([]string, 0, len(fams))
		for n := range fams {
			names = append(names, n)
		}
		sort.Strings(names)
		t.Logf("== %s %s: heavy scrapes %v … %v; %d series; permissions %v", members[0].Name, res.ServiceVersion,
			took[0].Round(time.Millisecond), took[len(took)-1].Round(time.Millisecond), len(res.Samples), res.Permissions)
		for _, n := range names {
			t.Logf("  %s ×%d", n, fams[n])
		}
		for _, smp := range res.Samples {
			if strings.HasPrefix(smp.Name, "watchlog_redis_sampler_") || strings.HasPrefix(smp.Name, "watchlog_redis_stream_") {
				t.Logf("  %s %v = %v", smp.Name, smp.Labels, smp.Value)
			}
		}
		for k, v := range res.Extra {
			b, _ := json.Marshal(v)
			t.Logf("  extra %s: %s", k, string(b)[:min(len(b), 600)])
		}
		all, _ := json.Marshal(res)
		// A value written by the lab's workloads, and full key names (session:<n>, cart:<n>).
		for _, lit := range []string{"vvvvvvvv", `"session:1`, `"session:2`, `"cart:1`, `"user:1`, "kind", "order"} {
			// "order" may appear as the stream "orders" (a stream's name is sent, ADR-248).
			if strings.Contains(string(all), lit) && (lit != "order" || !strings.Contains(string(all), `"orders"`)) {
				t.Errorf("%s: %s left the agent", members[0].Name, lit)
			}
		}
		_ = reflect.DeepEqual
	}
}
