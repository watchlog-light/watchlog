// SPDX-License-Identifier: AGPL-3.0-only

// Package redis is the Redis (and Valkey) integration (SPEC §4.12, ADR-131): INFO,
// CONFIG GET, MEMORY STATS, SLOWLOG, LATENCY HISTOGRAM and CLIENT LIST, each member on
// its own connection, read-only. Key values are never read: the biggest key prefixes
// come from SCAN and MEMORY USAGE on a sample of key names.
package redis

import (
	"context"
	"errors"
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
	TopPrefixes  = 20
	SampleKeys   = 2000
	SampleEvery  = 10 * time.Minute
	CallTimeout  = integrations.DialTimeout
	maxSlowField = 120
)

// Redis is the integration; it keeps the last key-prefix sample per member.
type Redis struct {
	mu      sync.Mutex
	samples map[string]sample // by target id and member
	// heavyPerms are the heavy scrape's permission notes per target, repeated by the
	// light scrapes in between so a panel's note doesn't come and go.
	heavyPerms map[string]map[string]string
	// Now is replaced in tests.
	Now func() time.Time
}

type sample struct {
	at       time.Time
	prefixes []prefixSize
}

type prefixSize struct {
	prefix string
	bytes  float64
	keys   float64
}

// New returns the integration.
func New() *Redis {
	return &Redis{samples: map[string]sample{}, heavyPerms: map[string]map[string]string{}, Now: time.Now}
}

// Scrape implements integrations.Integration.
func (r *Redis) Scrape(ctx context.Context, t integrations.Target, heavy bool) integrations.Result {
	res := integrations.Result{State: integrations.StateOK}
	var slow []map[string]any
	var clients []map[string]any
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
	out := memberOut{perms: map[string]string{}}
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

	// CONFIG GET: the limits (memory, clients).
	if cfg, err := c.Do(ctx, "CONFIG", "GET", "max*"); err == nil {
		kv := pairs(cfg)
		lbl("watchlog_redis_memory_max_bytes", num(kv["maxmemory"]))
		lbl("watchlog_redis_maxclients", num(kv["maxclients"]))
		if p := kv["maxmemory-policy"]; p != "" {
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
		out.perms["overview/slowlog"] = "+slowlog"
	}
	// LATENCY HISTOGRAM (Redis 7+): every command's latency, merged.
	if v, err := c.Do(ctx, "LATENCY", "HISTOGRAM"); err == nil {
		for le, n := range Histogram(v) {
			lbl("watchlog_redis_command_latency_bucket", n, "le", le)
		}
	} else if resp.IsCode(err, "NOPERM") {
		out.perms["commands/latency"] = "+latency"
	}
	// CLIENT LIST: connections per client address; the backend maps them to workloads.
	if s, err := c.String(ctx, "CLIENT", "LIST"); err == nil {
		out.clients = Clients(s, m.Name)
	} else if resp.IsCode(err, "NOPERM") {
		out.perms["clients/by-workload"] = "+client|list"
	}
	// The biggest key prefixes, every 10 minutes from a sample of key names (db0, the
	// one SCAN reads; its size from INFO keyspace, so no DBSIZE privilege is needed).
	r.prefixes(ctx, c, t.ID+"/"+m.Name, num(fields(info["db0"])["keys"]), out.perms, lbl)
	return ms, out
}

func (r *Redis) prefixes(ctx context.Context, c *resp.Conn, key string, total float64, perms map[string]string, lbl func(string, float64, ...string)) {
	r.mu.Lock()
	s, ok := r.samples[key]
	r.mu.Unlock()
	now := r.Now()
	if !ok || now.Sub(s.at) >= SampleEvery {
		p, err := SamplePrefixes(ctx, c, SampleKeys, total)
		if err != nil {
			if resp.IsCode(err, "NOPERM") {
				perms["memory/prefixes"] = "+scan +memory|usage ~*"
			}
			return
		}
		s = sample{at: now, prefixes: p}
		r.mu.Lock()
		r.samples[key] = s
		r.mu.Unlock()
	}
	for _, p := range s.prefixes {
		lbl("watchlog_redis_prefix_memory_bytes", p.bytes, "prefix", p.prefix)
		lbl("watchlog_redis_prefix_keys", p.keys, "prefix", p.prefix)
	}
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
	}
	counters := map[string]string{
		"keyspace_hits":              "watchlog_redis_keyspace_hits_total",
		"keyspace_misses":            "watchlog_redis_keyspace_misses_total",
		"expired_keys":               "watchlog_redis_expired_keys_total",
		"evicted_keys":               "watchlog_redis_evicted_keys_total",
		"total_commands_processed":   "watchlog_redis_commands_processed_total",
		"rejected_connections":       "watchlog_redis_rejected_connections_total",
		"total_connections_received": "watchlog_redis_connections_received_total",
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
		name        string
		calls, usec float64
	}
	var cmds []cmd
	for k, v := range info {
		name, isCmd := strings.CutPrefix(k, "cmdstat_")
		if !isCmd {
			continue
		}
		f := fields(v)
		cmds = append(cmds, cmd{strings.ToLower(name), num(f["calls"]), num(f["usec"])})
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

// SamplePrefixes scans up to limit key names and sizes them with MEMORY USAGE, grouped
// by prefix and extrapolated to the database size. Values are never read.
func SamplePrefixes(ctx context.Context, c *resp.Conn, limit int, total float64) ([]prefixSize, error) {
	cursor := "0"
	var keys []string
	for range 200 {
		v, err := c.Do(ctx, "SCAN", cursor, "COUNT", "500")
		if err != nil {
			return nil, err
		}
		arr, _ := v.([]any)
		if len(arr) != 2 {
			return nil, errors.New("SCAN: unexpected reply")
		}
		cursor, _ = arr[0].(string)
		names, _ := arr[1].([]any)
		for _, k := range names {
			if s, ok := k.(string); ok && len(keys) < limit {
				keys = append(keys, s)
			}
		}
		if cursor == "0" || len(keys) >= limit {
			break
		}
	}
	if len(keys) == 0 {
		return nil, nil
	}
	by := map[string]*prefixSize{}
	for _, k := range keys {
		v, err := c.Do(ctx, "MEMORY", "USAGE", k, "SAMPLES", "0")
		if err != nil {
			if resp.IsCode(err, "NOPERM") {
				return nil, err
			}
			continue
		}
		size, _ := v.(int64)
		p := Prefix(k)
		if p == "" {
			p = "(no prefix)"
		}
		if by[p] == nil {
			by[p] = &prefixSize{prefix: p}
		}
		by[p].bytes += float64(size)
		by[p].keys++
	}
	scale := 1.0
	if total > float64(len(keys)) {
		scale = total / float64(len(keys))
	}
	out := make([]prefixSize, 0, len(by))
	for _, p := range by {
		out = append(out, prefixSize{prefix: p.prefix, bytes: p.bytes * scale, keys: p.keys * scale})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].bytes > out[j].bytes })
	if len(out) > TopPrefixes {
		rest := prefixSize{prefix: "other"}
		for _, p := range out[TopPrefixes:] {
			rest.bytes += p.bytes
			rest.keys += p.keys
		}
		out = append(out[:TopPrefixes], rest)
	}
	return out, nil
}

func trimTo(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
