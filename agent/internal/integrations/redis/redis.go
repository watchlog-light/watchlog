// SPDX-License-Identifier: AGPL-3.0-only

// Package redis is the Redis (and Valkey) integration (SPEC §4.12, ADR-131): INFO,
// CONFIG GET, MEMORY STATS, SLOWLOG, LATENCY HISTOGRAM and CLIENT LIST, each member on
// its own connection, read-only. Key values are never read: the biggest key prefixes
// come from SCAN and MEMORY USAGE on a sample of key names.
package redis

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/integrations/resp"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Caps (ADR-136).
const (
	TopCommands  = 20
	SlowEntries  = 20
	TopClients   = 50
	TopPrefixes  = 30
	CallTimeout  = integrations.DialTimeout
	maxSlowField = 120
)

// Redis is the integration; it keeps the last key-prefix sample per member.
type Redis struct {
	mu       sync.Mutex
	samplers map[string]*sampler // by target id and member
	// heavyPerms are the heavy scrape's permission notes per target, repeated by the
	// light scrapes in between so a panel's note doesn't come and go.
	heavyPerms map[string]map[string]string
	// Now is replaced in tests.
	Now func() time.Time
}

// New returns the integration.
func New() *Redis {
	return &Redis{samplers: map[string]*sampler{}, heavyPerms: map[string]map[string]string{}, Now: time.Now}
}

// Scrape implements integrations.Integration.
func (r *Redis) Scrape(ctx context.Context, t integrations.Target, heavy bool) integrations.Result {
	res := integrations.Result{State: integrations.StateOK}
	var slow []map[string]any
	var clients []map[string]any
	lists := map[string][]map[string]any{}
	perms := map[string]string{}
	up, authFailed := 0, 0
	for _, m := range t.Members {
		ms, out := r.member(ctx, t, m, heavy)
		res.Members = append(res.Members, ms)
		if out.authFailed {
			authFailed++
		}
		if !ms.Up {
			continue
		}
		up++
		res.Samples = append(res.Samples, out.samples...)
		if res.ServiceVersion == "" {
			res.ServiceVersion, res.Product = out.version, out.product
		}
		slow = append(slow, out.slow...)
		clients = append(clients, out.clients...)
		for k, rows := range out.lists {
			lists[k] = append(lists[k], rows...)
		}
		for k, v := range out.perms {
			perms[k] = v
		}
	}
	r.mu.Lock()
	if heavy {
		r.heavyPerms[t.ID] = perms
	} else {
		for k, v := range r.heavyPerms[t.ID] {
			if _, ok := perms[k]; !ok {
				perms[k] = v
			}
		}
	}
	r.mu.Unlock()
	for tab, missing := range perms {
		res.Permissions = append(res.Permissions, integrations.Permission{Tab: tab, Missing: missing})
	}
	sort.Slice(res.Permissions, func(i, j int) bool { return res.Permissions[i].Tab < res.Permissions[j].Tab })
	if heavy {
		sort.Slice(slow, func(i, j int) bool { return slow[i]["at"].(int64) > slow[j]["at"].(int64) })
		if len(slow) > SlowEntries {
			slow = slow[:SlowEntries]
		}
		if len(clients) > TopClients {
			clients = clients[:TopClients]
		}
		res.Extra = map[string]any{"slowlog": slow, "clients": clients}
		for k, rows := range lists {
			if len(rows) > 100 {
				rows = rows[:100]
			}
			res.Extra[k] = rows
		}
	}
	switch {
	case len(t.Members) == 0:
		res.State, res.Error = integrations.StateError, "no member to connect to: no pod or container of this service has an address yet"
	case up == 0:
		res.State = integrations.StateError
		res.Error = res.Members[0].Error
		if authFailed > 0 {
			res.ErrorCode = integrations.ProbeAuthFailed
		}
	}
	return res
}

type memberOut struct {
	samples []metrics.Sample
	version string
	slow    []map[string]any
	clients []map[string]any
	perms   map[string]string
	// authFailed: the user or password was refused.
	authFailed bool
	product    string
	// lists are 1.4's other rows (prefixes, largest keys, streams, settings…), by name.
	lists map[string][]map[string]any
}

// login connects to a member and authenticates with the target's user, if any.
func login(ctx context.Context, m integrations.Member, auth *integrations.Auth) (*resp.Conn, time.Duration, error) {
	start := time.Now()
	c, err := resp.Dial(ctx, m.Address, CallTimeout)
	if err != nil {
		return nil, 0, err
	}
	elapsed := time.Since(start)
	if auth != nil && auth.Password != "" {
		args := []string{"AUTH", auth.Password}
		if auth.Username != "" && auth.Username != "default" {
			args = []string{"AUTH", auth.Username, auth.Password}
		}
		if _, err := c.Do(ctx, args...); err != nil {
			_ = c.Close()
			return nil, elapsed, err
		}
	}
	return c, elapsed, nil
}

func short(err error) string {
	s := err.Error()
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

func (r *Redis) member(ctx context.Context, t integrations.Target, m integrations.Member, heavy bool) (integrations.MemberStatus, memberOut) {
	out := memberOut{perms: map[string]string{}, lists: map[string][]map[string]any{}}
	ms := integrations.MemberStatus{Name: m.Name}
	c, connect, err := login(ctx, m, t.Auth)
	if err != nil {
		ms.Error = short(err)
		out.authFailed = isAuth(err)
		return ms, out
	}
	defer func() { _ = c.Close() }()
	lbl := func(name string, v float64, pairs ...string) {
		out.samples = append(out.samples, metrics.New(name, v, append([]string{"member", m.Name}, pairs...)...))
	}
	lbl("watchlog_integration_connect_seconds", connect.Seconds())

	text, err := c.String(ctx, "INFO", "all")
	if err != nil {
		if resp.IsCode(err, "NOPERM") {
			ms.Error = "the user may not run INFO: add +info to its ACL"
		} else if isAuth(err) {
			ms.Error, out.authFailed = "the server needs a password", true
		} else {
			ms.Error = short(err)
		}
		return ms, out
	}
	ms.Up = true
	info := ParseInfo(text)
	out.version = info.Version()
	out.product = info.Product()
	out.samples = append(out.samples, InfoSamples(info, m.Name)...)
	if noPassword(t.Auth) {
		lbl("watchlog_redis_no_password", 1)
	}
	if info["redis_mode"] == "sentinel" {
		// A Sentinel answers INFO with its masters; the data commands don't apply.
		for _, mm := range SentinelMasters(info) {
			ok := 0.0
			if mm["status"] == "ok" {
				ok = 1
			}
			name := trimTo(mm["name"], 64)
			lbl("watchlog_redis_sentinel_master_ok", ok, "master", name)
			lbl("watchlog_redis_sentinel_master_replicas", num(mm["slaves"]), "master", name)
			lbl("watchlog_redis_sentinel_master_sentinels", num(mm["sentinels"]), "master", name)
			if heavy {
				out.lists["sentinel_masters"] = append(out.lists["sentinel_masters"], map[string]any{"master": name,
					"status": trimTo(mm["status"], 16), "address": trimTo(mm["address"], 64), "replicas": num(mm["slaves"]),
					"sentinels": num(mm["sentinels"]), "member": m.Name})
			}
		}
		return ms, out
	}

	// CONFIG GET: the limits (memory, clients).
	if cfg, err := c.Do(ctx, "CONFIG", "GET", "max*"); err == nil {
		kv := pairs(cfg)
		if _, inInfo := info["maxmemory"]; !inInfo {
			lbl("watchlog_redis_memory_max_bytes", num(kv["maxmemory"]))
		}
		lbl("watchlog_redis_maxclients", num(kv["maxclients"]))
		if p := kv["maxmemory-policy"]; p != "" && info["maxmemory_policy"] == "" {
			lbl("watchlog_redis_maxmemory_policy_info", 1, "policy", p)
		}
	} else if resp.IsCode(err, "NOPERM") {
		out.perms["memory/capacity"] = "+config|get"
	}

	if !heavy {
		return ms, out
	}
	// MEMORY STATS: dataset and overhead.
	if v, err := c.Do(ctx, "MEMORY", "STATS"); err == nil {
		kv := pairsAny(v)
		lbl("watchlog_redis_memory_dataset_bytes", toFloat(kv["dataset.bytes"]))
		lbl("watchlog_redis_memory_overhead_bytes", toFloat(kv["overhead.total"]))
	} else if resp.IsCode(err, "NOPERM") {
		out.perms["memory/breakdown"] = "+memory|stats"
	}
	// SLOWLOG GET: the slowest recent commands, normalised (ADR-138).
	if v, err := c.Do(ctx, "SLOWLOG", "GET", strconv.Itoa(SlowEntries)); err == nil {
		out.slow = Slowlog(v, m.Name, t.Settings.QueryText)
	} else if resp.IsCode(err, "NOPERM") {
		out.perms["commands/slowlog"] = "+slowlog"
	}
	// LATENCY HISTOGRAM (Redis 7+): every command's latency, merged.
	if v, err := c.Do(ctx, "LATENCY", "HISTOGRAM"); err == nil {
		for le, n := range Histogram(v) {
			lbl("watchlog_redis_command_latency_bucket", n, "le", le)
		}
	} else if resp.IsCode(err, "NOPERM") {
		out.perms["commands/latency"] = "+latency"
	}
	// Settings read by name, one per call (6.2 takes one pattern): never a pattern that
	// could match requirepass or masterauth.
	cfg := map[string]string{}
	for _, name := range []string{"client-output-buffer-limit", "save", "appendonly", "bind", "protected-mode", "latency-monitor-threshold"} {
		if v, err := c.Do(ctx, "CONFIG", "GET", name); err == nil {
			cfg[name] = pairs(v)[name]
		}
	}
	for _, name := range []string{"save", "appendonly", "bind", "protected-mode", "latency-monitor-threshold"} {
		if v, ok := cfg[name]; ok {
			out.lists["settings"] = append(out.lists["settings"], map[string]any{"name": name, "value": trimTo(v, 120), "member": m.Name})
		}
	}
	if v, ok := cfg["latency-monitor-threshold"]; ok {
		lbl("watchlog_redis_latency_monitor_threshold_ms", num(v))
	}
	limits := BufferLimits(cfg["client-output-buffer-limit"])
	// CLIENT LIST: per client address, with its output buffer against its class's limit.
	if s, err := c.String(ctx, "CLIENT", "LIST"); err == nil {
		out.clients = Clients(s, m.Name)
		// Opened since the last heavy scrape (every second light one): the churn.
		young := 2 * integrations.DefaultInterval.Seconds()
		fullest := 0.0
		for _, cr := range ClientsDetail(s, young) {
			if l := limits[cr.Class]; l > 0 {
				fullest = max(fullest, cr.OutputMax/l)
			}
		}
		lbl("watchlog_redis_client_output_buffer_ratio", fullest)
		for i, cr := range ClientsDetail(s, young) {
			if i >= TopClients {
				break
			}
			out.lists["client_detail"] = append(out.lists["client_detail"], map[string]any{"addr": cr.Addr,
				"connections": cr.Connections, "blocked": cr.Blocked, "subscribed": cr.Subscribed, "young": cr.Young,
				"idle": max(cr.IdleMin, 0), "omem": cr.OutputMax, "limit": limits[cr.Class], "class": cr.Class,
				"cmd": cr.Command, "name": cr.Name, "member": m.Name})
		}
	} else if resp.IsCode(err, "NOPERM") {
		out.perms["clients/by-workload"] = "+client|list"
	}
	// LATENCY LATEST: the latency monitor's events, when it is on.
	if v, err := c.Do(ctx, "LATENCY", "LATEST"); err == nil {
		list, _ := v.([]any)
		for _, e := range list {
			ev, _ := e.([]any)
			if len(ev) < 4 {
				continue
			}
			name, _ := ev[0].(string)
			at, _ := ev[1].(int64)
			name = trimTo(name, 48)
			lbl("watchlog_redis_latency_event_timestamp_seconds", float64(at), "event", name)
			lbl("watchlog_redis_latency_event_ms", toFloat(ev[2]), "event", name)
			out.lists["latency_events"] = append(out.lists["latency_events"], map[string]any{"event": name, "at": at,
				"latest_ms": toFloat(ev[2]), "max_ms": toFloat(ev[3]), "member": m.Name})
		}
	}
	// A cluster: its state and slots; each shard's nodes on 7.0+.
	if info["redis_mode"] == "cluster" {
		if s, err := c.String(ctx, "CLUSTER", "INFO"); err == nil {
			ci := ParseInfo(s)
			okState := 0.0
			if ci["cluster_state"] == "ok" {
				okState = 1
			}
			lbl("watchlog_redis_cluster_ok", okState)
			for _, k := range []string{"slots_assigned", "slots_ok", "slots_pfail", "slots_fail", "known_nodes", "size"} {
				lbl("watchlog_redis_cluster_"+k, num(ci["cluster_"+k]))
			}
		} else if resp.IsCode(err, "NOPERM") {
			out.perms["replication/cluster"] = "+cluster|info"
		}
		if v, err := c.Do(ctx, "CLUSTER", "SHARDS"); err == nil {
			for _, row := range Shards(v) {
				row["member"] = m.Name
				out.lists["cluster_nodes"] = append(out.lists["cluster_nodes"], row)
			}
		}
	}
	if HostChecks {
		if thp, oc, ok := hostSettings(readFile); ok {
			always := 0.0
			if thp == "always" {
				always = 1
			}
			lbl("watchlog_redis_host_thp_always", always)
			if oc >= 0 {
				lbl("watchlog_redis_host_overcommit_memory", oc)
			}
		}
	}
	// The key sampler (db0, the one SCAN reads; its size from INFO keyspace).
	r.sample(ctx, c, t, m.Name, num(fields(info["db0"])["keys"]), &out, lbl)
	return ms, out
}

// sample advances the member's sampling pass and sends the last finished one: per prefix its
// memory, keys and share with a TTL as series (top 30), its type as a row; the largest keys
// (names only with the names switch on); and the streams' groups and consumers.
func (r *Redis) sample(ctx context.Context, c *resp.Conn, t integrations.Target, member string, total float64, out *memberOut, lbl func(string, float64, ...string)) {
	key := t.ID + "/" + member
	r.mu.Lock()
	sm := r.samplers[key]
	if sm == nil {
		sm = &sampler{}
		r.samplers[key] = sm
	}
	r.mu.Unlock()
	if err := sm.step(ctx, c, r.Now(), total); err != nil {
		if resp.IsCode(err, "NOPERM") {
			out.perms["memory/prefixes"] = "+scan +memory|usage +type +pttl ~*"
		}
	}
	p := sm.last
	if p == nil {
		return
	}
	for _, row := range p.Rows(TopPrefixes) {
		lbl("watchlog_redis_prefix_memory_bytes", row.Bytes, "prefix", row.Prefix)
		lbl("watchlog_redis_prefix_keys", row.Keys, "prefix", row.Prefix)
		lbl("watchlog_redis_prefix_ttl_keys", row.Keys*row.TTLShare, "prefix", row.Prefix)
		out.lists["prefixes"] = append(out.lists["prefixes"], map[string]any{"prefix": row.Prefix, "type": row.Type,
			"ttl_share": row.TTLShare, "member": member})
	}
	stopped := 0.0
	if p.stopped {
		stopped = 1
	}
	lbl("watchlog_redis_sampler_keys", p.sampled)
	lbl("watchlog_redis_sampler_stopped", stopped)
	lbl("watchlog_redis_sampler_timestamp_seconds", float64(p.at.Unix()))
	for _, k := range p.Largest(t.Settings.KeyNames) {
		name := k.prefix + "…"
		if t.Settings.KeyNames {
			name = trimTo(k.name, 128)
		}
		out.lists["largest_keys"] = append(out.lists["largest_keys"], map[string]any{"key": name, "prefix": k.prefix,
			"type": k.typ, "bytes": k.bytes, "elements": k.elements, "member": member})
	}
	names := make([]string, 0, len(sm.streams))
	for s := range sm.streams {
		names = append(names, s)
	}
	sort.Strings(names)
	lengths, groups, consumers, err := streams(ctx, c, names, r.Now())
	for _, s := range names {
		if n, ok := lengths[s]; ok && n == 0 && !hasGroups(groups, s) {
			r.mu.Lock()
			delete(sm.streams, s) // gone (XLEN of a missing key is 0)
			r.mu.Unlock()
		}
	}
	if err != nil && resp.IsCode(err, "NOPERM") {
		out.perms["streams/groups"] = "+xlen +xinfo|groups +xinfo|consumers +xpending"
	}
	for s, n := range lengths {
		lbl("watchlog_redis_stream_length", n, "stream", trimTo(s, 128))
	}
	for _, g := range groups {
		ls := []string{"stream", trimTo(g.Stream, 128), "group", g.Group}
		lbl("watchlog_redis_stream_group_pending", g.Pending, ls...)
		lbl("watchlog_redis_stream_group_consumers", g.Consumers, ls...)
		lbl("watchlog_redis_stream_group_oldest_pending_seconds", g.OldestPending, ls...)
		if g.Lag >= 0 {
			lbl("watchlog_redis_stream_group_lag", g.Lag, ls...)
		}
	}
	// A group's consumers seen reading in the last 5 minutes: none, with entries waiting,
	// is a group nobody serves.
	active := map[[2]string]float64{}
	for _, cr := range consumers {
		seen := cr.Inactive
		if seen < 0 {
			seen = cr.Idle
		}
		if seen < 300 {
			active[[2]string{cr.Stream, cr.Group}]++
		}
	}
	for _, g := range groups {
		lbl("watchlog_redis_stream_group_active_consumers", active[[2]string{g.Stream, g.Group}],
			"stream", trimTo(g.Stream, 128), "group", g.Group)
	}
	for _, cr := range consumers {
		out.lists["stream_consumers"] = append(out.lists["stream_consumers"], map[string]any{"stream": trimTo(cr.Stream, 128),
			"group": cr.Group, "consumer": cr.Name, "pending": cr.Pending, "idle": cr.Idle, "inactive": cr.Inactive, "member": member})
	}
}

func hasGroups(gs []GroupRow, stream string) bool {
	for _, g := range gs {
		if g.Stream == stream {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- probe

// Probe implements integrations.Prober: log in, then check each read-only command the
// pages need. A refused password is auth_failed; missing commands are listed.
func (r *Redis) Probe(ctx context.Context, t integrations.Target) integrations.ProbeResult {
	out := integrations.ProbeResult{Code: integrations.ProbeUnreachable}
	var lastErr error
	for _, m := range t.Members {
		c, _, err := login(ctx, m, t.Auth)
		if err != nil {
			lastErr = err
			if isAuth(err) {
				out.Code, out.Error = integrations.ProbeAuthFailed, short(err)
				return out
			}
			continue
		}
		defer func() { _ = c.Close() }()
		text, err := c.String(ctx, "INFO", "server")
		switch {
		case isAuth(err):
			// NOAUTH: the server wants a password and none was given.
			return integrations.ProbeResult{Code: integrations.ProbeAuthFailed, Error: "the server needs a password"}
		case resp.IsCode(err, "NOPERM"):
			return integrations.ProbeResult{Code: integrations.ProbePermission, Missing: []string{"+info"}}
		case err != nil:
			return integrations.ProbeResult{Code: integrations.ProbeError, Error: short(err)}
		}
		info := ParseInfo(text)
		out = integrations.ProbeResult{Code: integrations.ProbeOK, Version: info.Version()}
		checks := []struct {
			need string
			args []string
		}{
			{"+config|get", []string{"CONFIG", "GET", "maxmemory"}},
			{"+slowlog", []string{"SLOWLOG", "LEN"}},
			{"+latency", []string{"LATENCY", "LATEST"}},
			{"+client|list", []string{"CLIENT", "LIST", "ID", "0"}},
			{"+memory|stats", []string{"MEMORY", "STATS"}},
			{"+scan", []string{"SCAN", "0", "COUNT", "1"}},
			// 1.4: the key sampler's metadata and the streams (never a value).
			{"+memory|usage", []string{"MEMORY", "USAGE", "watchlog:probe"}},
			{"+type", []string{"TYPE", "watchlog:probe"}},
			{"+pttl", []string{"PTTL", "watchlog:probe"}},
			{"+xinfo|groups", []string{"XINFO", "GROUPS", "watchlog:probe"}},
			{"+xinfo|consumers", []string{"XINFO", "CONSUMERS", "watchlog:probe", "g"}},
			{"+xpending", []string{"XPENDING", "watchlog:probe", "g"}},
			{"+xlen", []string{"XLEN", "watchlog:probe"}},
		}
		for _, ch := range checks {
			if _, err := c.Do(ctx, ch.args...); resp.IsCode(err, "NOPERM") {
				out.Missing = append(out.Missing, ch.need)
			}
		}
		if len(out.Missing) > 0 {
			out.Code = integrations.ProbePermission
		}
		// More than needed: the default user, or one that may change the server.
		if who, err := c.String(ctx, "ACL", "WHOAMI"); err == nil && who == "default" {
			out.Excess = append(out.Excess, "the default user (every command)")
		}
		if v, err := c.Do(ctx, "ACL", "DRYRUN", aclUser(t.Auth), "FLUSHALL"); err == nil && v == "OK" {
			out.Excess = append(out.Excess, "can run FLUSHALL")
		}
		used, _ := strconv.ParseFloat(info["used_memory"], 64)
		out.Facts = map[string]any{"role": info["role"]}
		if p := info.Product(); p != "" {
			out.Facts["product"] = p
		}
		if used > 0 {
			out.Facts["used_memory"] = humanBytes(used)
		}
		return out
	}
	if lastErr != nil {
		out.Error = short(lastErr)
	}
	return out
}

func aclUser(a *integrations.Auth) string {
	if a == nil || a.Username == "" {
		return "default"
	}
	return a.Username
}

func isAuth(err error) bool {
	return resp.IsCode(err, "WRONGPASS") || resp.IsCode(err, "NOAUTH") ||
		(err != nil && strings.Contains(err.Error(), "invalid password"))
}

func humanBytes(b float64) string {
	switch {
	case b >= 1<<30:
		return fmt.Sprintf("%.1f GB", b/(1<<30))
	case b >= 1<<20:
		return fmt.Sprintf("%.0f MB", b/(1<<20))
	default:
		return fmt.Sprintf("%.0f KB", b/(1<<10))
	}
}

// ---------------------------------------------------------------- parsing

// Info is INFO's key-value lines (sections dropped).
type Info map[string]string

// ParseInfo reads INFO's text.
func ParseInfo(s string) Info {
	out := Info{}
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" || line[0] == '#' {
			continue
		}
		if k, v, ok := strings.Cut(line, ":"); ok {
			out[k] = v
		}
	}
	return out
}

// Version is the server's version: Valkey's own when it is Valkey.
// Product is "valkey" when Valkey answers (the Redis integration reads it as Redis), else "".
func (i Info) Product() string {
	if i["server_name"] == "valkey" || i["valkey_version"] != "" {
		return "valkey"
	}
	return ""
}

func (i Info) Version() string {
	if v := i["valkey_version"]; v != "" {
		return v
	}
	return i["redis_version"]
}

// fields splits "a=1,b=2" (commandstats, keyspace, slaveN lines).
func fields(s string) map[string]string {
	out := map[string]string{}
	for _, p := range strings.Split(s, ",") {
		if k, v, ok := strings.Cut(p, "="); ok {
			out[k] = v
		}
	}
	return out
}

func num(s string) float64 {
	f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return f
}

// InfoSamples turns INFO into the series the pages use, labelled with the member.
func InfoSamples(info Info, member string) []metrics.Sample {
	var out []metrics.Sample
	add := func(name string, v float64, pairs ...string) {
		out = append(out, metrics.New(name, v, append([]string{"member", member}, pairs...)...))
	}
	gauges := map[string]string{
		"used_memory":                 "watchlog_redis_memory_used_bytes",
		"used_memory_rss":             "watchlog_redis_memory_rss_bytes",
		"mem_fragmentation_ratio":     "watchlog_redis_mem_fragmentation_ratio",
		"connected_clients":           "watchlog_redis_connected_clients",
		"blocked_clients":             "watchlog_redis_blocked_clients",
		"rdb_changes_since_last_save": "watchlog_redis_rdb_changes_since_last_save",
		"rdb_last_save_time":          "watchlog_redis_rdb_last_save_timestamp_seconds",
		"aof_enabled":                 "watchlog_redis_aof_enabled",
		"connected_slaves":            "watchlog_redis_connected_replicas",
		"master_repl_offset":          "watchlog_redis_replication_offset",
		"uptime_in_seconds":           "watchlog_redis_uptime_seconds",
		// 1.4 (ADR-247): limits from INFO, which managed services show when CONFIG is refused.
		"maxmemory":                      "watchlog_redis_memory_max_bytes",
		"rdb_last_bgsave_time_sec":       "watchlog_redis_rdb_last_save_duration_seconds",
		"rdb_last_cow_size":              "watchlog_redis_rdb_cow_bytes",
		"aof_last_cow_size":              "watchlog_redis_aof_cow_bytes",
		"aof_current_size":               "watchlog_redis_aof_bytes",
		"rdb_bgsave_in_progress":         "watchlog_redis_rdb_saving",
		"aof_rewrite_in_progress":        "watchlog_redis_aof_rewriting",
		"repl_backlog_size":              "watchlog_redis_repl_backlog_bytes",
		"master_link_down_since_seconds": "watchlog_redis_master_link_down_seconds",
		"io_threads_active":              "watchlog_redis_io_threads_active",
		"used_memory_peak":               "watchlog_redis_memory_peak_bytes",
	}
	counters := map[string]string{
		"keyspace_hits":              "watchlog_redis_keyspace_hits_total",
		"keyspace_misses":            "watchlog_redis_keyspace_misses_total",
		"expired_keys":               "watchlog_redis_expired_keys_total",
		"evicted_keys":               "watchlog_redis_evicted_keys_total",
		"total_commands_processed":   "watchlog_redis_commands_processed_total",
		"rejected_connections":       "watchlog_redis_rejected_connections_total",
		"total_connections_received": "watchlog_redis_connections_received_total",
		"aof_rewrites":               "watchlog_redis_aof_rewrites_total",
		"aof_delayed_fsync":          "watchlog_redis_aof_delayed_fsync_total",
		"rdb_saves":                  "watchlog_redis_rdb_saves_total",
		"total_error_replies":        "watchlog_redis_error_replies_total",
	}
	for k, name := range gauges {
		if v, ok := info[k]; ok {
			add(name, num(v))
		}
	}
	for k, name := range counters {
		if v, ok := info[k]; ok {
			add(name, num(v))
		}
	}
	// The main thread's CPU (6.2+, Valkey): Redis's own counter, so it works where the agent
	// can't see the process (a managed service). The whole process's beside it.
	if u, has := info["used_cpu_user_main_thread"]; has {
		add("watchlog_redis_main_thread_cpu_seconds_total", num(u)+num(info["used_cpu_sys_main_thread"]))
	}
	if u, has := info["used_cpu_user"]; has {
		add("watchlog_redis_cpu_seconds_total", num(u)+num(info["used_cpu_sys"]))
	}
	if f, has := info["latest_fork_usec"]; has {
		add("watchlog_redis_fork_seconds", num(f)/1e6)
	}
	if p := info["maxmemory_policy"]; p != "" {
		add("watchlog_redis_maxmemory_policy_info", 1, "policy", p)
	}
	if m := info["redis_mode"]; m != "" {
		add("watchlog_redis_mode_info", 1, "mode", m)
	}
	ok := func(k string) float64 {
		if info[k] == "ok" {
			return 1
		}
		return 0
	}
	if _, has := info["rdb_last_bgsave_status"]; has {
		add("watchlog_redis_rdb_last_save_ok", ok("rdb_last_bgsave_status"))
	}
	if info["aof_enabled"] == "1" {
		add("watchlog_redis_aof_last_write_ok", ok("aof_last_write_status"))
	}
	// Replication: a primary's replicas with their offset lag and ack age; a replica's link.
	if info["role"] == "master" {
		add("watchlog_redis_is_primary", 1)
		primary := num(info["master_repl_offset"])
		for k, v := range info {
			if !strings.HasPrefix(k, "slave") || strings.Contains(k, "_") {
				continue
			}
			f := fields(v)
			add("watchlog_redis_replica_offset_lag_bytes", max(0, primary-num(f["offset"])), "replica", k)
			add("watchlog_redis_replica_ack_age_seconds", num(f["lag"]), "replica", k)
			online := 0.0
			if f["state"] == "online" {
				online = 1
			}
			add("watchlog_redis_replica_online", online, "replica", k)
		}
	} else {
		add("watchlog_redis_is_primary", 0)
		up := 0.0
		if info["master_link_status"] == "up" {
			up = 1
		}
		add("watchlog_redis_master_link_up", up)
		add("watchlog_redis_master_last_io_seconds", num(info["master_last_io_seconds_ago"]))
	}
	// Keyspace per database: keys and the ones with a TTL.
	for k, v := range info {
		if !strings.HasPrefix(k, "db") {
			continue
		}
		if _, err := strconv.Atoi(k[2:]); err != nil {
			continue
		}
		f := fields(v)
		add("watchlog_redis_keys", num(f["keys"]), "db", k)
		add("watchlog_redis_keys_expiring", num(f["expires"]), "db", k)
	}
	// Commands: the top 20 by calls; the rest summed as "other" (ADR-136).
	type cmd struct {
		name                          string
		calls, usec, failed, rejected float64
	}
	var cmds []cmd
	for k, v := range info {
		name, isCmd := strings.CutPrefix(k, "cmdstat_")
		if !isCmd {
			continue
		}
		f := fields(v)
		cmds = append(cmds, cmd{strings.ToLower(name), num(f["calls"]), num(f["usec"]), num(f["failed_calls"]), num(f["rejected_calls"])})
	}
	sort.Slice(cmds, func(i, j int) bool {
		if cmds[i].calls != cmds[j].calls {
			return cmds[i].calls > cmds[j].calls
		}
		return cmds[i].name < cmds[j].name
	})
	var other cmd
	for i, c := range cmds {
		if i >= TopCommands {
			other.calls += c.calls
			other.usec += c.usec
			continue
		}
		add("watchlog_redis_command_calls_total", c.calls, "command", c.name)
		add("watchlog_redis_command_usec_total", c.usec, "command", c.name)
		add("watchlog_redis_command_failed_total", c.failed+c.rejected, "command", c.name)
		// Latency percentiles (7.0+): INFO latencystats, per command.
		if lp, has := info["latency_percentiles_usec_"+strings.ReplaceAll(c.name, "|", "|")]; has {
			for q, v := range fields(lp) {
				if quantile, known := map[string]string{"p50": "0.5", "p99": "0.99", "p99.9": "0.999"}[q]; known {
					add("watchlog_redis_command_latency_seconds", num(v)/1e6, "command", c.name, "quantile", quantile)
				}
			}
		}
	}
	if other.calls > 0 {
		add("watchlog_redis_command_calls_total", other.calls, "command", "other")
		add("watchlog_redis_command_usec_total", other.usec, "command", "other")
	}
	return out
}

func pairs(v any) map[string]string {
	out := map[string]string{}
	arr, _ := v.([]any)
	for i := 0; i+1 < len(arr); i += 2 {
		k, _ := arr[i].(string)
		val, _ := arr[i+1].(string)
		out[k] = val
	}
	return out
}

func pairsAny(v any) map[string]any {
	out := map[string]any{}
	arr, _ := v.([]any)
	for i := 0; i+1 < len(arr); i += 2 {
		k, _ := arr[i].(string)
		out[k] = arr[i+1]
	}
	return out
}

func toFloat(v any) float64 {
	switch x := v.(type) {
	case int64:
		return float64(x)
	case string:
		return num(x)
	}
	return 0
}

// Slowlog turns SLOWLOG GET's entries into the table's rows. The command is normalised
// (ADR-138): its name, the first key's prefix, and "?" for every value; with query text
// off, only the name.
func Slowlog(v any, member string, queryText bool) []map[string]any {
	arr, _ := v.([]any)
	var out []map[string]any
	for _, e := range arr {
		entry, _ := e.([]any)
		if len(entry) < 4 {
			continue
		}
		at, _ := entry[1].(int64)
		usec, _ := entry[2].(int64)
		args, _ := entry[3].([]any)
		row := map[string]any{"at": at, "usec": usec, "member": member, "command": normalise(args, queryText)}
		if len(entry) >= 5 {
			if addr, ok := entry[4].(string); ok {
				host, _, _ := strings.Cut(addr, ":")
				row["client"] = host
			}
		}
		if len(entry) >= 6 {
			if name, ok := entry[5].(string); ok && name != "" {
				row["name"] = trimTo(name, 64)
			}
		}
		out = append(out, row)
	}
	return out
}

func normalise(args []any, queryText bool) string {
	if len(args) == 0 {
		return "?"
	}
	name, _ := args[0].(string)
	name = strings.ToUpper(name)
	if !queryText || len(args) == 1 {
		return name
	}
	// Commands whose arguments can be credentials: only the command (and its subcommand),
	// whatever the server's own slow-log redaction does.
	switch name {
	case "AUTH", "HELLO", "MIGRATE":
		return name
	case "ACL", "CONFIG":
		sub, _ := args[1].(string)
		return name + " " + strings.ToUpper(trimTo(sub, 16))
	}
	key, _ := args[1].(string)
	out := name + " " + Prefix(key) + "*"
	if len(args) > 2 {
		out += strings.Repeat(" ?", min(len(args)-2, 3))
		if len(args) > 5 {
			out += " …"
		}
	}
	if len(out) > maxSlowField {
		out = out[:maxSlowField]
	}
	return out
}

// Prefix is a key's prefix: up to and including the first ':' or '{', else "".
func Prefix(key string) string {
	if i := strings.IndexAny(key, ":{"); i >= 0 {
		p := key[:i+1]
		if len(p) > 64 {
			p = p[:64]
		}
		return p
	}
	return ""
}

// Histogram merges LATENCY HISTOGRAM's per-command buckets into one cumulative histogram
// in seconds ("le" labels).
func Histogram(v any) map[string]float64 {
	arr, _ := v.([]any)
	buckets := map[int64]float64{}
	for i := 0; i+1 < len(arr); i += 2 {
		detail := pairsAny(arr[i+1])
		hist, _ := detail["histogram_usec"].([]any)
		for j := 0; j+1 < len(hist); j += 2 {
			le, _ := hist[j].(int64)
			n, _ := hist[j+1].(int64)
			buckets[le] += float64(n)
		}
	}
	// Redis already reports the buckets cumulative per command; the sum stays cumulative.
	out := map[string]float64{}
	for le, n := range buckets {
		out[strconv.FormatFloat(float64(le)/1e6, 'g', -1, 64)] = n
	}
	return out
}

// Clients counts CLIENT LIST's connections per client address (normal clients only).
func Clients(list, member string) []map[string]any {
	n := map[string]int{}
	for _, line := range strings.Split(strings.TrimSpace(list), "\n") {
		f := map[string]string{}
		for _, p := range strings.Fields(line) {
			if k, v, ok := strings.Cut(p, "="); ok {
				f[k] = v
			}
		}
		if f["flags"] != "" && strings.ContainsAny(f["flags"], "SMr") {
			continue // replicas, the primary link
		}
		addr := f["addr"]
		if i := strings.LastIndex(addr, ":"); i > 0 {
			addr = strings.Trim(addr[:i], "[]")
		}
		if addr != "" {
			n[addr]++
		}
	}
	out := make([]map[string]any, 0, len(n))
	for a, c := range n {
		out = append(out, map[string]any{"addr": a, "connections": c, "member": member})
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["connections"].(int) > out[j]["connections"].(int) })
	return out
}

func trimTo(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
