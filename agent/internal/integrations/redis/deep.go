// SPDX-License-Identifier: AGPL-3.0-only

// What 1.4 adds to the Redis and Valkey integration (ADR-247): the key sampler, bounded (at
// most 20,000 names per 10 minutes, SCAN COUNT 100 with a pause, MEMORY USAGE with its
// default samples, stopped when a call's round trip rises fourfold) and spread over the heavy
// scrapes; clients per address with their output buffers against their class's limit;
// streams and their groups; Sentinel's masters; a cluster's slots; latency events; and the
// settings that hurt. Values are never read: no GET, no KEYS, no MONITOR, no XINFO STREAM.
// Only prefixes and sizes leave the agent; a key's name only with the service's names switch
// on, and a stream's name, as a queue's is.
package redis

import (
	"context"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/integrations/resp"
)

// The sampler's bounds (ADR-247).
const (
	SampleBudget  = 20000
	SampleWindow  = 10 * time.Minute
	PerScrape     = 1000
	ScanCount     = "100"
	scanPause     = 10 * time.Millisecond
	TopKeys       = 10
	MaxStreams    = 20
	MaxGroups     = 10
	MaxConsumers  = 20
	latencyFactor = 4
)

// HostChecks is set by the collector in server mode: it may read this host's transparent
// huge pages and overcommit settings, which apply to the Redis it monitors there.
var HostChecks bool

// prefixAgg is one prefix's sampled keys.
type prefixAgg struct {
	bytes, keys, ttl float64
	types            map[string]float64
}

// bigKey is one of the largest sampled keys.
type bigKey struct {
	name, prefix, typ string
	bytes, elements   float64
}

// pass is a sampling pass in progress or the last one finished.
type pass struct {
	start    time.Time
	cursor   string
	sampled  float64
	prefixes map[string]*prefixAgg
	big      []bigKey
	streams  map[string]bool
	stopped  bool
	baseline time.Duration
	first    []time.Duration
	slowRun  int
	done     bool
	at       time.Time
	total    float64
	wrapped  bool
}

// sampler is one member's sampling state.
type sampler struct {
	cur  *pass
	last *pass
	// spent is the names read in the current window.
	spent       int
	windowStart time.Time
	// next is where the next pass starts: a pass that ran out of budget leaves the rest of
	// the keyspace to the next, so window by window every key is seen.
	next string
	// streams are the stream keys found so far, kept until XLEN says they are gone.
	streams map[string]bool
}

func newPass(now time.Time) *pass {
	return &pass{start: now, cursor: "0", prefixes: map[string]*prefixAgg{}, streams: map[string]bool{}}
}

// step samples up to PerScrape names (the window's budget allowing) and finishes the pass
// when SCAN returns to cursor 0, the budget is spent, or the round trip rose.
func (sm *sampler) step(ctx context.Context, c *resp.Conn, now time.Time, total float64) error {
	if sm.windowStart.IsZero() || now.Sub(sm.windowStart) >= SampleWindow {
		sm.windowStart, sm.spent = now, 0
		if sm.cur == nil {
			sm.cur = newPass(now)
			if sm.next != "" {
				sm.cur.cursor = sm.next
			}
		}
	}
	p := sm.cur
	if p == nil {
		return nil
	}
	read := 0
	for read < PerScrape && sm.spent < SampleBudget {
		t0 := time.Now()
		v, err := c.Do(ctx, "SCAN", p.cursor, "COUNT", ScanCount)
		rtt := time.Since(t0)
		if err != nil {
			return err
		}
		if !p.slower(rtt) {
			// fine
		} else {
			// The instance answers slower than when the pass began, three calls in a row:
			// stop, and finish with what we have.
			p.stopped = true
			break
		}
		arr, _ := v.([]any)
		if len(arr) != 2 {
			break
		}
		p.cursor, _ = arr[0].(string)
		names, _ := arr[1].([]any)
		var keys []string
		for _, k := range names {
			if s, ok := k.(string); ok {
				keys = append(keys, s)
			}
		}
		if err := p.size(ctx, c, keys); err != nil {
			return err
		}
		read += len(keys)
		sm.spent += len(keys)
		if p.cursor == "0" {
			p.wrapped = true
			break
		}
		time.Sleep(scanPause)
	}
	if p.wrapped || p.stopped || sm.spent >= SampleBudget {
		p.done, p.at, p.total = true, now, total
		sm.next = p.cursor
		if sm.streams == nil {
			sm.streams = map[string]bool{}
		}
		for k := range p.streams {
			if len(sm.streams) < MaxStreams {
				sm.streams[k] = true
			}
		}
		sm.last, sm.cur = p, nil
	}
	return nil
}

// slower: the baseline is the median of the pass's first three SCAN round trips; three calls
// in a row over four times it (and over 2 ms) mean the instance is busier than it was.
func (p *pass) slower(rtt time.Duration) bool {
	if p.baseline == 0 {
		p.first = append(p.first, rtt)
		if len(p.first) == 3 {
			f := append([]time.Duration(nil), p.first...)
			sort.Slice(f, func(i, j int) bool { return f[i] < f[j] })
			p.baseline = max(f[1], 100*time.Microsecond)
		}
		return false
	}
	if rtt > latencyFactor*p.baseline && rtt > 2*time.Millisecond {
		p.slowRun++
	} else {
		p.slowRun = 0
	}
	return p.slowRun >= 3
}

// size reads each name's memory, type and TTL in one round trip, then the element count of
// the collections. Never a value.
func (p *pass) size(ctx context.Context, c *resp.Conn, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	cmds := make([][]string, 0, 3*len(keys))
	for _, k := range keys {
		cmds = append(cmds, []string{"MEMORY", "USAGE", k}, []string{"TYPE", k}, []string{"PTTL", k})
	}
	out, errs, err := c.Pipeline(ctx, cmds)
	if err != nil {
		return err
	}
	for i := range errs {
		if errs[i] != nil && resp.IsCode(errs[i], "NOPERM") {
			return errs[i]
		}
	}
	type coll struct {
		key, typ string
		i        int
	}
	var colls []coll
	var lens [][]string
	for i, k := range keys {
		size, _ := out[3*i].(int64)
		typ, _ := out[3*i+1].(string)
		ttl, _ := out[3*i+2].(int64)
		if typ == "none" || typ == "" {
			continue // expired between SCAN and now
		}
		pre := Prefix(k)
		if pre == "" {
			pre = "(no prefix)"
		}
		a := p.prefixes[pre]
		if a == nil {
			a = &prefixAgg{types: map[string]float64{}}
			p.prefixes[pre] = a
		}
		a.bytes += float64(size)
		a.keys++
		a.types[typ]++
		if ttl >= 0 {
			a.ttl++
		}
		p.sampled++
		if typ == "stream" && len(p.streams) < MaxStreams {
			p.streams[k] = true
		}
		if cmd := lenCommand(typ); cmd != "" {
			colls = append(colls, coll{k, typ, len(p.big)})
			lens = append(lens, []string{cmd, k})
		}
		p.offerBig(bigKey{name: k, prefix: pre, typ: typ, bytes: float64(size)})
	}
	if len(lens) > 0 {
		out, _, err := c.Pipeline(ctx, lens)
		if err != nil {
			return err
		}
		for i, cl := range colls {
			n, _ := out[i].(int64)
			for j := range p.big {
				if p.big[j].name == cl.key {
					p.big[j].elements = float64(n)
				}
			}
		}
	}
	return nil
}

func lenCommand(typ string) string {
	return map[string]string{"hash": "HLEN", "list": "LLEN", "set": "SCARD", "zset": "ZCARD", "stream": "XLEN"}[typ]
}

// Largest returns the largest sampled keys; without names, only the largest of each prefix
// (ten rows of "session:…" would say nothing more).
func (p *pass) Largest(names bool) []bigKey {
	if names {
		return p.big
	}
	seen := map[string]bool{}
	var out []bigKey
	for _, k := range p.big {
		if !seen[k.prefix] {
			seen[k.prefix] = true
			out = append(out, k)
		}
	}
	return out
}

// offerBig keeps the TopKeys largest sampled keys, at most TopKeys per prefix.
func (p *pass) offerBig(k bigKey) {
	p.big = append(p.big, k)
	sort.Slice(p.big, func(i, j int) bool { return p.big[i].bytes > p.big[j].bytes })
	if len(p.big) > TopKeys {
		p.big = p.big[:TopKeys]
	}
}

// PrefixRow is one prefix as the page shows it, extrapolated to the whole database.
type PrefixRow struct {
	Prefix      string
	Bytes, Keys float64
	TTLShare    float64
	Type        string
}

// Rows extrapolates a finished pass by the database's size: the largest prefixes first, the
// rest summed as "other" beyond top.
func (p *pass) Rows(top int) []PrefixRow {
	scale := 1.0
	if p.sampled > 0 && p.total > p.sampled {
		scale = p.total / p.sampled
	}
	out := make([]PrefixRow, 0, len(p.prefixes))
	for pre, a := range p.prefixes {
		dom, n := "", 0.0
		for t, c := range a.types {
			if c > n || (c == n && t < dom) {
				dom, n = t, c
			}
		}
		share := 0.0
		if a.keys > 0 {
			share = a.ttl / a.keys
		}
		out = append(out, PrefixRow{Prefix: pre, Bytes: a.bytes * scale, Keys: a.keys * scale, TTLShare: share, Type: dom})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Bytes != out[j].Bytes {
			return out[i].Bytes > out[j].Bytes
		}
		return out[i].Prefix < out[j].Prefix
	})
	if len(out) > top {
		rest := PrefixRow{Prefix: "other"}
		ttl := 0.0
		for _, r := range out[top:] {
			rest.Bytes += r.Bytes
			rest.Keys += r.Keys
			ttl += r.TTLShare * r.Keys
		}
		if rest.Keys > 0 {
			rest.TTLShare = ttl / rest.Keys
		}
		out = append(out[:top], rest)
	}
	return out
}

// ---------------------------------------------------------------- clients

// ClientRow is CLIENT LIST summed per client address.
type ClientRow struct {
	Addr                 string
	Connections, Blocked int
	Subscribed, Young    int
	IdleMin              float64
	OutputMax, MemTotal  float64
	Class, Name, Command string
}

// ClientsDetail sums CLIENT LIST per address (replication links and the collector's own
// connection left out): connections, blocked ones (BLPOP, XREADGROUP BLOCK), subscribers, the
// fullest output buffer, connections younger than young seconds (churn), and the most frequent
// last command.
func ClientsDetail(list string, young float64) []ClientRow {
	by := map[string]*ClientRow{}
	cmds := map[string]map[string]int{}
	for _, line := range strings.Split(strings.TrimSpace(list), "\n") {
		f := map[string]string{}
		for _, p := range strings.Fields(line) {
			if k, v, ok := strings.Cut(p, "="); ok {
				f[k] = v
			}
		}
		flags := f["flags"]
		if flags != "" && strings.ContainsAny(flags, "SMr") {
			continue
		}
		cmd := f["cmd"]
		if cmd == "client|list" || cmd == "client" && f["user"] == "watchlog" {
			continue
		}
		addr := f["addr"]
		if i := strings.LastIndex(addr, ":"); i > 0 {
			addr = strings.Trim(addr[:i], "[]")
		}
		if addr == "" {
			continue
		}
		r := by[addr]
		if r == nil {
			r = &ClientRow{Addr: addr, IdleMin: -1, Class: "normal"}
			by[addr] = r
			cmds[addr] = map[string]int{}
		}
		r.Connections++
		if strings.Contains(flags, "b") {
			r.Blocked++
		}
		subs := num(f["sub"]) + num(f["psub"]) + num(f["ssub"])
		if subs > 0 || strings.Contains(flags, "P") {
			r.Subscribed++
			r.Class = "pubsub"
		}
		if num(f["age"]) < young {
			r.Young++
		}
		if idle := num(f["idle"]); r.IdleMin < 0 || idle < r.IdleMin {
			r.IdleMin = idle
		}
		r.OutputMax = max(r.OutputMax, num(f["omem"]))
		r.MemTotal += num(f["tot-mem"])
		if r.Name == "" && f["name"] != "" {
			r.Name = trimTo(f["name"], 64)
		}
		if cmd != "" {
			cmds[addr][trimTo(cmd, 32)]++
		}
	}
	out := make([]ClientRow, 0, len(by))
	for a, r := range by {
		best, n := "", 0
		for c, k := range cmds[a] {
			if k > n || (k == n && c < best) {
				best, n = c, k
			}
		}
		r.Command = best
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Connections != out[j].Connections {
			return out[i].Connections > out[j].Connections
		}
		return out[i].Addr < out[j].Addr
	})
	return out
}

// BufferLimits reads client-output-buffer-limit ("normal 0 0 0 replica 268435456 67108864 60
// pubsub 33554432 8388608 60"): each class's hard limit, else its soft one, in bytes (0: none).
func BufferLimits(v string) map[string]float64 {
	out := map[string]float64{}
	f := strings.Fields(v)
	for i := 0; i+3 < len(f); i += 4 {
		class := f[i]
		if class == "slave" {
			class = "replica"
		}
		hard, soft := sizeOf(f[i+1]), sizeOf(f[i+2])
		if hard == 0 {
			hard = soft
		}
		out[class] = hard
	}
	return out
}

// sizeOf reads "33554432", "32mb", "8gb".
func sizeOf(s string) float64 {
	s = strings.ToLower(s)
	mult := 1.0
	for _, u := range []struct {
		suf string
		m   float64
	}{{"gb", 1 << 30}, {"mb", 1 << 20}, {"kb", 1 << 10}, {"g", 1e9}, {"m", 1e6}, {"k", 1e3}} {
		if strings.HasSuffix(s, u.suf) {
			mult, s = u.m, strings.TrimSuffix(s, u.suf)
			break
		}
	}
	return num(s) * mult
}

// ---------------------------------------------------------------- streams

// GroupRow is one consumer group of a stream.
type GroupRow struct {
	Stream, Group      string
	Consumers, Pending float64
	Lag                float64 // -1 when the server doesn't say (6.2)
	OldestPending      float64 // seconds; 0 when nothing is pending
	LastDelivered      string
}

// ConsumerRow is one consumer of a group.
type ConsumerRow struct {
	Stream, Group, Name string
	Pending, Idle       float64
	Inactive            float64 // seconds since its last successful read (7.2+), else -1
}

// streams reads each known stream's length, groups, consumers and oldest pending entry.
// XINFO STREAM is never used: it returns entries' values.
func streams(ctx context.Context, c *resp.Conn, names []string, now time.Time) (lengths map[string]float64, groups []GroupRow, consumers []ConsumerRow, err error) {
	lengths = map[string]float64{}
	for _, s := range names {
		n, e := c.Do(ctx, "XLEN", s)
		if e != nil {
			if resp.IsCode(e, "NOPERM") {
				return nil, nil, nil, e
			}
			continue
		}
		l, _ := n.(int64)
		lengths[s] = float64(l)
		v, e := c.Do(ctx, "XINFO", "GROUPS", s)
		if e != nil {
			if resp.IsCode(e, "NOPERM") {
				return lengths, groups, consumers, e
			}
			continue
		}
		list, _ := v.([]any)
		for gi, g := range list {
			if gi >= MaxGroups {
				break
			}
			kv := pairsAny(g)
			name, _ := kv["name"].(string)
			gr := GroupRow{Stream: s, Group: trimTo(name, 128), Consumers: toFloat(kv["consumers"]),
				Pending: toFloat(kv["pending"]), Lag: -1, LastDelivered: str(kv["last-delivered-id"])}
			if l, ok := kv["lag"]; ok && l != nil {
				gr.Lag = toFloat(l)
			}
			if gr.Pending > 0 {
				if p, e := c.Do(ctx, "XPENDING", s, name); e == nil {
					arr, _ := p.([]any)
					if len(arr) >= 2 {
						if id, ok := arr[1].(string); ok {
							gr.OldestPending = AgeOfID(id, now)
						}
					}
				}
			}
			groups = append(groups, gr)
			cv, e := c.Do(ctx, "XINFO", "CONSUMERS", s, name)
			if e != nil {
				continue
			}
			cl, _ := cv.([]any)
			for ci, x := range cl {
				if ci >= MaxConsumers {
					break
				}
				ckv := pairsAny(x)
				cn, _ := ckv["name"].(string)
				row := ConsumerRow{Stream: s, Group: gr.Group, Name: trimTo(cn, 128), Pending: toFloat(ckv["pending"]),
					Idle: toFloat(ckv["idle"]) / 1000, Inactive: -1}
				if in, ok := ckv["inactive"]; ok && in != nil {
					if v := toFloat(in); v >= 0 {
						row.Inactive = v / 1000
					}
				}
				consumers = append(consumers, row)
			}
		}
	}
	return lengths, groups, consumers, nil
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// AgeOfID is how old a stream entry id ("1795884217031-0") is: its first part is the time it
// was added, in milliseconds.
func AgeOfID(id string, now time.Time) float64 {
	ms, _, _ := strings.Cut(id, "-")
	t, err := strconv.ParseInt(ms, 10, 64)
	if err != nil || t <= 0 {
		return 0
	}
	return max(0, now.Sub(time.UnixMilli(t)).Seconds())
}

// ---------------------------------------------------------------- sentinel and cluster

// SentinelMasters reads INFO sentinel's masterN lines ("name=shop,status=ok,address=…,
// slaves=1,sentinels=1").
func SentinelMasters(info Info) []map[string]string {
	var out []map[string]string
	for k, v := range info {
		if !strings.HasPrefix(k, "master") {
			continue
		}
		if _, err := strconv.Atoi(k[6:]); err != nil {
			continue
		}
		out = append(out, fields(v))
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["name"] < out[j]["name"] })
	return out
}

// Shards reads CLUSTER SHARDS (7.0+): each node's address, role, health and slot count.
func Shards(v any) []map[string]any {
	var out []map[string]any
	list, _ := v.([]any)
	for _, s := range list {
		kv := pairsAny(s)
		slots := 0.0
		ranges, _ := kv["slots"].([]any)
		for i := 0; i+1 < len(ranges); i += 2 {
			a, b := toFloat(ranges[i]), toFloat(ranges[i+1])
			slots += b - a + 1
		}
		nodes, _ := kv["nodes"].([]any)
		for _, n := range nodes {
			nk := pairsAny(n)
			role := str(nk["role"])
			row := map[string]any{"node": trimTo(str(nk["ip"])+":"+strconv.Itoa(int(toFloat(nk["port"]))), 64),
				"role": role, "health": str(nk["health"])}
			if role == "master" {
				row["slots"] = slots
			}
			out = append(out, row)
		}
	}
	return out
}

// ---------------------------------------------------------------- host settings

// hostSettings reads this host's transparent huge pages and overcommit (server mode only).
func hostSettings(read func(string) ([]byte, error)) (thp string, overcommit float64, ok bool) {
	b, err := read("/sys/kernel/mm/transparent_hugepage/enabled")
	if err != nil {
		return "", 0, false
	}
	s := string(b)
	if i, j := strings.Index(s, "["), strings.Index(s, "]"); i >= 0 && j > i {
		thp = s[i+1 : j]
	}
	o, err := read("/proc/sys/vm/overcommit_memory")
	if err != nil {
		return thp, -1, true
	}
	return thp, num(string(o)), true
}

var readFile = os.ReadFile

// noPassword: the collector got in without one.
func noPassword(a *integrations.Auth) bool { return a == nil || a.Password == "" }
