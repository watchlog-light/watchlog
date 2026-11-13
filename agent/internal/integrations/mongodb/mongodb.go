// SPDX-License-Identifier: AGPL-3.0-only

// Package mongodb is the MongoDB integration (SPEC §4.12, ADR-164): serverStatus (the
// operation counters, latencies and their histograms, connections, the WiredTiger cache
// and tickets, the queues), replSetGetStatus (members, states, lag), the server's "Slow
// query" log lines from getLog (kept as shapes: field names and operators, every literal
// replaced by "?", ADR-138), top, dbStats, $collStats and $indexStats, $currentOp's client
// addresses, and the oplog window (clusterMonitor reads local). Each member on its own direct
// connection with a 5 s limit per command. It never reads documents, except the oplog's
// first and last entries' timestamps.
package mongodb

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Caps (ADR-136, ADR-164).
const (
	MaxDatabases   = 50
	MaxCollections = 100
	// maxListed bounds the collections whose stats are read before the largest are kept.
	maxListed   = 300
	TopSlow     = 30
	MaxClients  = 50
	MaxUnused   = 30
	TopBusiest  = 30
	commandTime = 5 * time.Second
	// textLen is the backend's limit for a value in a status's extra (ingest.ts).
	textLen = 256
)

// MongoDB is the integration.
type MongoDB struct {
	mu sync.Mutex
	// heavyPerms are the heavy scrape's permission notes per target, repeated by the
	// light scrapes in between so a panel's note doesn't come and go.
	heavyPerms map[string]map[string]string
	// slow is, per target and member, the last slow log line counted and the running
	// counts (the server keeps only its last 1,024 lines; WatchLog counts what it sees).
	slow map[string]*slowState
}

type slowState struct {
	last           time.Time
	collscan, rest float64
	recent         []slowEntry
}

// New returns the integration.
func New() *MongoDB {
	return &MongoDB{heavyPerms: map[string]map[string]string{}, slow: map[string]*slowState{}}
}

// connect opens a direct connection to one member: no discovery of the others, reads
// allowed on a secondary, and a 5 s limit per command. Without a user, no credential
// is sent (authentication off).
func connect(ctx context.Context, m integrations.Member, auth *integrations.Auth) (*mongo.Client, time.Duration, error) {
	if _, _, err := net.SplitHostPort(m.Address); err != nil {
		return nil, 0, err
	}
	o := options.Client().SetHosts([]string{m.Address}).SetDirect(true).
		SetAppName("watchlog").SetConnectTimeout(integrations.DialTimeout).
		SetServerSelectionTimeout(integrations.DialTimeout).SetTimeout(commandTime).
		SetMaxPoolSize(1).SetReadPreference(readpref.Nearest()).
		SetServerMonitoringMode(options.ServerMonitoringModePoll).
		// Nested documents decode as maps, as the reads below expect.
		SetBSONOptions(&options.BSONOptions{DefaultDocumentM: true})
	if auth != nil && auth.Password != "" {
		user := auth.Username
		if user == "" {
			user = "watchlog"
		}
		o.SetAuth(options.Credential{Username: user, Password: auth.Password, AuthSource: "admin"})
	}
	c, err := mongo.Connect(o)
	if err != nil {
		return nil, 0, err
	}
	start := time.Now()
	err = c.Ping(ctx, readpref.Nearest())
	took := time.Since(start)
	if err != nil && isTLSRequired(err) {
		// The server wants TLS: the same as PostgreSQL's sslmode=prefer, unverified.
		_ = c.Disconnect(context.Background())
		o.SetTLSConfig(&tls.Config{InsecureSkipVerify: true}) //nolint:gosec // G402: opportunistic TLS, as sslmode=prefer
		if c, err = mongo.Connect(o); err != nil {
			return nil, 0, err
		}
		start = time.Now()
		err = c.Ping(ctx, readpref.Nearest())
		took = time.Since(start)
	}
	if err != nil {
		_ = c.Disconnect(context.Background())
		return nil, took, err
	}
	return c, took, nil
}

func isTLSRequired(err error) bool {
	s := err.Error()
	return strings.Contains(s, "connection reset") || strings.Contains(s, "EOF")
}

func code(err error) int32 {
	var ce mongo.CommandError
	if errors.As(err, &ce) {
		return ce.Code
	}
	return 0
}

// isAuth: the user or password was refused (AuthenticationFailed, 18).
func isAuth(err error) bool {
	return code(err) == 18 || strings.Contains(err.Error(), "AuthenticationFailed") || strings.Contains(err.Error(), "auth error")
}

// denied: the user lacks the action (Unauthorized, 13).
func denied(err error) bool { return code(err) == 13 }

func short(err error) string {
	s := err.Error()
	var ce mongo.CommandError
	if errors.As(err, &ce) && ce.Message != "" {
		s = ce.Message
	}
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// Scrape implements integrations.Integration.
func (p *MongoDB) Scrape(ctx context.Context, t integrations.Target, heavy bool) integrations.Result {
	res := integrations.Result{State: integrations.StateOK}
	extra := map[string]any{}
	perms := map[string]string{}
	up, authFailed := 0, 0
	for _, m := range t.Members {
		ms := integrations.MemberStatus{Name: m.Name}
		c, connectTime, err := connect(ctx, m, t.Auth)
		if err != nil {
			ms.Error = short(err)
			if isAuth(err) {
				authFailed++
			}
			res.Members = append(res.Members, ms)
			continue
		}
		ms.Up = true
		up++
		res.Members = append(res.Members, ms)
		p.mu.Lock()
		st := p.slow[t.ID+"/"+m.Name]
		if st == nil {
			st = &slowState{}
			p.slow[t.ID+"/"+m.Name] = st
		}
		p.mu.Unlock()
		s := &scrape{c: c, admin: c.Database("admin"), member: m.Name, queryText: t.Settings.QueryText, perms: perms, extra: extra, slow: st}
		s.add("watchlog_integration_connect_seconds", connectTime.Seconds())
		s.light(ctx)
		if res.ServiceVersion == "" {
			res.ServiceVersion = s.version
		}
		if heavy {
			s.heavy(ctx)
		}
		res.Samples = append(res.Samples, s.out...)
		_ = c.Disconnect(context.Background())
	}
	p.mu.Lock()
	if heavy {
		p.heavyPerms[t.ID] = perms
	} else {
		for k, v := range p.heavyPerms[t.ID] {
			if _, ok := perms[k]; !ok {
				perms[k] = v
			}
		}
	}
	p.mu.Unlock()
	for tab, missing := range perms {
		res.Permissions = append(res.Permissions, integrations.Permission{Tab: tab, Missing: missing})
	}
	sort.Slice(res.Permissions, func(i, j int) bool { return res.Permissions[i].Tab < res.Permissions[j].Tab })
	if heavy {
		res.Extra = extra
	}
	switch {
	case len(t.Members) == 0:
		res.State, res.Error = integrations.StateError, "no member to connect to: no pod or container of this service has an address yet"
	case up == 0:
		res.State, res.Error = integrations.StateError, res.Members[0].Error
		if authFailed > 0 {
			res.ErrorCode = integrations.ProbeAuthFailed
		}
	}
	return res
}

type scrape struct {
	c         *mongo.Client
	admin     *mongo.Database
	member    string
	queryText bool
	out       []metrics.Sample
	perms     map[string]string
	extra     map[string]any
	version   string
	slow      *slowState
	replSet   bool
}

func (s *scrape) add(name string, v float64, pairs ...string) {
	s.out = append(s.out, metrics.New(name, v, append([]string{"member", s.member}, pairs...)...))
}

func (s *scrape) run(ctx context.Context, db *mongo.Database, cmd bson.D) (bson.M, error) {
	var out bson.M
	err := db.RunCommand(ctx, cmd).Decode(&out)
	return out, err
}

// num reads a number from a decoded document by its path ("connections.current").
func num(d bson.M, path string) (float64, bool) {
	var cur any = d
	for _, k := range strings.Split(path, ".") {
		m, ok := cur.(bson.M)
		if !ok {
			if dd, ok2 := cur.(bson.D); ok2 {
				m = bson.M{}
				for _, e := range dd {
					m[e.Key] = e.Value
				}
			} else {
				return 0, false
			}
		}
		cur, ok = m[k]
		if !ok {
			return 0, false
		}
	}
	return toFloat(cur)
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case int32:
		return float64(x), true
	case int64:
		return float64(x), true
	case float64:
		return x, true
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	case bson.Decimal128:
		f, err := strconv.ParseFloat(x.String(), 64)
		return f, err == nil
	}
	return 0, false
}

func str(d bson.M, k string) string {
	v, _ := d[k].(string)
	return v
}

func sub(d bson.M, k string) bson.M {
	v, _ := d[k].(bson.M)
	return v
}

var opTypes = []string{"insert", "query", "update", "delete", "getmore", "command"}

// latencyEdges are the histogram's upper bounds in seconds (the other databases' buckets).
var latencyEdges = []float64{0.001, 0.01, 0.1, 1, 10}

func (s *scrape) light(ctx context.Context) {
	ss, err := s.run(ctx, s.admin, bson.D{{Key: "serverStatus", Value: 1}, {Key: "opLatencies", Value: bson.D{{Key: "histograms", Value: true}}}})
	if err != nil {
		if denied(err) {
			s.perms["overview/summary"] = "clusterMonitor"
		}
		return
	}
	s.version = str(ss, "version")
	if v, ok := num(ss, "uptime"); ok {
		s.add("watchlog_mongodb_uptime_seconds", v)
	}
	for _, op := range opTypes {
		if v, ok := num(ss, "opcounters."+op); ok {
			s.add("watchlog_mongodb_ops_total", v, "op", op)
		}
	}
	for _, st := range []string{"current", "available", "active"} {
		if v, ok := num(ss, "connections."+st); ok {
			s.add("watchlog_mongodb_connections", v, "state", st)
		}
	}
	if v, ok := num(ss, "connections.totalCreated"); ok {
		s.add("watchlog_mongodb_connections_created_total", v)
	}
	// Latencies: totals (microseconds) and the histogram, summed into WatchLog's buckets.
	for _, kind := range []string{"reads", "writes", "commands"} {
		l := sub(sub(ss, "opLatencies"), kind)
		if l == nil {
			continue
		}
		if v, ok := num(l, "latency"); ok {
			s.add("watchlog_mongodb_op_latency_seconds_total", v/1e6, "type", kind)
		}
		if v, ok := num(l, "ops"); ok {
			s.add("watchlog_mongodb_op_latency_ops_total", v, "type", kind)
		}
		if h, ok := l["histogram"].(bson.A); ok {
			counts := Buckets(h)
			cum := 0.0
			for i, n := range counts {
				cum += n
				le := "+Inf"
				if i < len(latencyEdges) {
					le = strconv.FormatFloat(latencyEdges[i], 'g', -1, 64)
				}
				s.add("watchlog_mongodb_op_latency_bucket", cum, "type", kind, "le", le)
			}
		}
	}
	// WiredTiger's cache.
	if wt := sub(ss, "wiredTiger"); wt != nil {
		cache := sub(wt, "cache")
		for name, key := range map[string]string{
			"used":  "bytes currently in the cache",
			"dirty": "tracked dirty bytes in the cache",
			"max":   "maximum bytes configured",
		} {
			if v, ok := toFloat(cache[key]); ok {
				s.add("watchlog_mongodb_cache_bytes", v, "state", name)
			}
		}
		if v, ok := toFloat(cache["pages read into cache"]); ok {
			s.add("watchlog_mongodb_cache_pages_read_total", v)
		}
	}
	// Read and write tickets: queues.execution on 7.0+, wiredTiger.concurrentTransactions
	// before.
	tickets := sub(sub(ss, "queues"), "execution")
	if tickets == nil {
		tickets = sub(sub(ss, "wiredTiger"), "concurrentTransactions")
	}
	for _, op := range []string{"read", "write"} {
		t := sub(tickets, op)
		if t == nil {
			continue
		}
		for _, st := range []string{"available", "out", "totalTickets"} {
			if v, ok := toFloat(t[st]); ok {
				s.add("watchlog_mongodb_tickets", v, "op", op, "state", strings.TrimSuffix(strings.ToLower(st), "tickets"))
			}
		}
	}
	for _, op := range []string{"readers", "writers"} {
		if v, ok := num(ss, "globalLock.currentQueue."+op); ok {
			s.add("watchlog_mongodb_queued", v, "op", op)
		}
	}
	if v, ok := num(ss, "metrics.queryExecutor.collectionScans.total"); ok {
		s.add("watchlog_mongodb_collection_scans_total", v)
	}
	if v, ok := num(ss, "metrics.operation.scanAndOrder"); ok {
		s.add("watchlog_mongodb_scan_and_order_total", v)
	}
	if v, ok := num(ss, "mem.resident"); ok {
		s.add("watchlog_mongodb_resident_bytes", v*1024*1024)
	}
	// The member's own role, from its hello section.
	repl := sub(ss, "repl")
	if repl != nil && str(repl, "setName") != "" {
		s.replSet = true
		primary, _ := num(repl, "isWritablePrimary")
		if _, ok := repl["isWritablePrimary"]; !ok {
			primary, _ = num(repl, "ismaster")
		}
		s.add("watchlog_mongodb_is_primary", primary)
	}
	if str(ss, "process") == "mongos" {
		s.add("watchlog_mongodb_mongos", 1)
	}
	s.replication(ctx)
	s.oplog(ctx)
	s.slowLog(ctx)
}

// Buckets sums serverStatus's latency histogram (lower bounds in microseconds, counts)
// into WatchLog's six buckets.
func Buckets(h bson.A) []float64 {
	counts := make([]float64, len(latencyEdges)+1)
	for _, b := range h {
		d, ok := b.(bson.M)
		if !ok {
			continue
		}
		lo, _ := toFloat(d["micros"])
		n, _ := toFloat(d["count"])
		// A bucket starting at lo holds values up to the next power; it falls in the
		// first edge above its lower bound.
		i := sort.Search(len(latencyEdges), func(i int) bool { return lo/1e6 < latencyEdges[i] })
		counts[i] += n
	}
	return counts
}

// Member is one replica set member as replSetGetStatus reports it.
type Member struct {
	Name   string  `json:"name"`
	State  string  `json:"state"`
	Health float64 `json:"health"`
	Lag    float64 `json:"lag"`
	Self   bool    `json:"self"`
	// Votes is 0 for a member that doesn't vote (and so never becomes primary alone).
	Uptime float64 `json:"uptime"`
}

// ShortHost is a member's host without its port, and a cluster DNS name cut to its first
// label ("mongo-0.mongo.shop.svc.cluster.local:27017" → "mongo-0"); an address stays.
func ShortHost(h string) string {
	if host, _, err := net.SplitHostPort(h); err == nil {
		h = host
	}
	if net.ParseIP(h) != nil {
		return h
	}
	if i := strings.IndexByte(h, '.'); i > 0 {
		return h[:i]
	}
	return h
}

// replication: the members as this member sees them. Every member reports its view; the
// backend takes the worst (max) per member name. A standalone server has none.
func (s *scrape) replication(ctx context.Context) {
	if !s.replSet {
		s.add("watchlog_mongodb_replica_set", 0)
		return
	}
	st, err := s.run(ctx, s.admin, bson.D{{Key: "replSetGetStatus", Value: 1}})
	if err != nil {
		if denied(err) {
			s.perms["overview/members"] = "clusterMonitor"
		}
		return
	}
	s.add("watchlog_mongodb_replica_set", 1)
	members := Members(st)
	primary := 0.0
	for _, m := range members {
		name := ShortHost(m.Name)
		if m.State == "PRIMARY" {
			primary = 1
		}
		s.add("watchlog_mongodb_member_health", m.Health, "rs_member", name)
		if m.State == "SECONDARY" {
			s.add("watchlog_mongodb_replication_lag_seconds", m.Lag, "rs_member", name)
		}
	}
	s.add("watchlog_mongodb_primary_seen", primary)
	// The extra holds only lists of rows (ingest.ts): the set's name rides on each.
	set := trimText(str(st, "set"), 64)
	rows := make([]map[string]any, 0, len(members))
	for _, m := range members {
		rows = append(rows, map[string]any{"name": trimText(ShortHost(m.Name), 64), "state": m.State, "health": m.Health,
			"lag": m.Lag, "uptime": m.Uptime, "seen_by": s.member, "set": set})
	}
	if len(asRows(s.extra["members"])) == 0 || primary == 1 {
		// The primary's view wins, as it knows every member's optime.
		s.extra["members"] = rows
	}
}

// Members reads replSetGetStatus's members, with each secondary's lag behind the primary
// (its optimeDate's distance from the primary's; none without a primary).
func Members(st bson.M) []Member {
	arr, _ := st["members"].(bson.A)
	var out []Member
	var primaryOp time.Time
	ops := map[int]time.Time{}
	for i, x := range arr {
		d, ok := x.(bson.M)
		if !ok {
			continue
		}
		m := Member{Name: str(d, "name"), State: str(d, "stateStr")}
		m.Health, _ = toFloat(d["health"])
		m.Uptime, _ = toFloat(d["uptime"])
		m.Self, _ = d["self"].(bool)
		if t, ok := d["optimeDate"].(bson.DateTime); ok {
			ops[i] = t.Time()
			if m.State == "PRIMARY" {
				primaryOp = t.Time()
			}
		}
		out = append(out, m)
	}
	for i := range out {
		if out[i].State == "SECONDARY" && !primaryOp.IsZero() {
			if t, ok := ops[i]; ok && primaryOp.After(t) {
				out[i].Lag = primaryOp.Sub(t).Seconds()
			}
		}
	}
	return out
}

// oplog: the window between the oplog's first and last entries (clusterMonitor reads local). Only on
// a replica set member.
func (s *scrape) oplog(ctx context.Context) {
	if !s.replSet {
		return
	}
	coll := s.c.Database("local").Collection("oplog.rs")
	ts := func(dir int) (time.Time, error) {
		var doc struct {
			Ts bson.Timestamp `bson:"ts"`
		}
		err := coll.FindOne(ctx, bson.D{}, options.FindOne().SetSort(bson.D{{Key: "$natural", Value: dir}}).
			SetProjection(bson.D{{Key: "ts", Value: 1}, {Key: "_id", Value: 0}})).Decode(&doc)
		return time.Unix(int64(doc.Ts.T), 0), err
	}
	first, err := ts(1)
	if err != nil {
		if denied(err) {
			s.perms["overview/oplog"] = "clusterMonitor"
		}
		return
	}
	last, err := ts(-1)
	if err != nil {
		return
	}
	s.add("watchlog_mongodb_oplog_window_seconds", last.Sub(first).Seconds())
	// How full the oplog is: until it is, the window is only the set's age.
	cur, err := coll.Aggregate(ctx, mongo.Pipeline{{{Key: "$collStats", Value: bson.D{{Key: "storageStats", Value: bson.D{}}}}},
		{{Key: "$project", Value: bson.D{{Key: "storageStats.size", Value: 1}, {Key: "storageStats.maxSize", Value: 1}}}}})
	if err != nil {
		return
	}
	defer func() { _ = cur.Close(ctx) }()
	var d bson.M
	if cur.Next(ctx) && cur.Decode(&d) == nil {
		st := sub(d, "storageStats")
		if used, ok := toFloat(st["size"]); ok {
			s.add("watchlog_mongodb_oplog_bytes", used, "state", "used")
		}
		if m, ok := toFloat(st["maxSize"]); ok {
			s.add("watchlog_mongodb_oplog_bytes", m, "state", "max")
		}
	}
}

// slowEntry is one "Slow query" log line as kept: its shape (only with the query-text
// switch on), namespace, duration, plan and client address.
type slowEntry struct {
	At       time.Time
	NS       string
	Op       string
	Shape    string
	Hash     string
	Plan     string
	Millis   float64
	Remote   string
	Collscan bool
}

// logLine is the part of a structured log line WatchLog reads.
type logLine struct {
	T struct {
		Date time.Time `json:"$date"`
	} `json:"t"`
	Msg  string `json:"msg"`
	Attr struct {
		Type           string          `json:"type"`
		NS             string          `json:"ns"`
		Command        json.RawMessage `json:"command"`
		Originating    json.RawMessage `json:"originatingCommand"`
		PlanSummary    string          `json:"planSummary"`
		DurationMillis float64         `json:"durationMillis"`
		Remote         string          `json:"remote"`
		QueryShapeHash string          `json:"queryShapeHash"`
		AppName        string          `json:"appName"`
	} `json:"attr"`
}

// ParseSlow reads getLog's lines and returns the "Slow query" entries, WatchLog's own
// left out.
func ParseSlow(lines []string, withShape bool) []slowEntry {
	var out []slowEntry
	for _, l := range lines {
		if !strings.Contains(l, `"Slow query"`) {
			continue
		}
		var x logLine
		if err := json.Unmarshal([]byte(l), &x); err != nil || x.Msg != "Slow query" {
			continue
		}
		// A write logs twice: its own line on the collection, and the command's on the
		// database's $cmd (measured on 7.0 and 8.0); the second is left out.
		if strings.HasSuffix(x.Attr.NS, ".$cmd") {
			continue
		}
		// No client address: the server's own work (a secondary applying the oplog, an
		// index build), not a client's operation.
		if x.Attr.Remote == "" || x.Attr.AppName == "watchlog" || strings.HasPrefix(x.Attr.NS, "local.") || strings.HasPrefix(x.Attr.NS, "admin.") || strings.HasPrefix(x.Attr.NS, "config.") {
			continue
		}
		e := slowEntry{At: x.T.Date, NS: x.Attr.NS, Plan: trimText(x.Attr.PlanSummary, 128), Millis: x.Attr.DurationMillis,
			Remote: hostOf(x.Attr.Remote), Hash: trimText(x.Attr.QueryShapeHash, 64)}
		e.Collscan = strings.Contains(e.Plan, "COLLSCAN")
		var cmd map[string]json.RawMessage
		_ = json.Unmarshal(x.Attr.Command, &cmd)
		e.Op, e.Shape = Shape(cmd)
		if e.Op == "getMore" && len(x.Attr.Originating) > 0 {
			// A cursor's next batch: the shape is the find or aggregate that opened it.
			var orig map[string]json.RawMessage
			if json.Unmarshal(x.Attr.Originating, &orig) == nil {
				if op, shape := Shape(orig); op != "" {
					e.Op, e.Shape = op, shape
				}
			}
		}
		if e.Op == "" && (x.Attr.Type == "update" || x.Attr.Type == "remove") {
			// A write's own line (type update or remove) holds one statement: {q, u, multi}.
			var q any
			_ = json.Unmarshal(cmd["q"], &q)
			e.Op, e.Shape = map[string]string{"update": "update", "remove": "delete"}[x.Attr.Type], trimText(shapeOf(q), textLen)
		}
		if !withShape {
			e.Shape = ""
		}
		out = append(out, e)
	}
	return out
}

// The command names whose filter is shaped, and where the filter is.
var filters = map[string][]string{
	"find": {"filter"}, "count": {"query"}, "distinct": {"query"}, "aggregate": {"pipeline"},
	"update": {"updates"}, "delete": {"deletes"}, "findAndModify": {"query"}, "getMore": nil,
}

// Shape is a command's name and its filter's shape: field names and operators kept,
// every literal replaced by "?" (ADR-138), one line, short.
func Shape(cmd map[string]json.RawMessage) (string, string) {
	op := ""
	for name := range filters {
		if _, ok := cmd[name]; ok {
			op = name
			break
		}
	}
	if op == "" {
		return "", ""
	}
	var parts []string
	for _, field := range filters[op] {
		raw, ok := cmd[field]
		if !ok {
			continue
		}
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			continue
		}
		switch op {
		case "update", "delete":
			// The first statement's q.
			if a, ok := v.([]any); ok && len(a) > 0 {
				if d, ok := a[0].(map[string]any); ok {
					v = d["q"]
				}
			}
		}
		parts = append(parts, shapeOf(v))
	}
	if sort, ok := cmd["sort"]; ok && op == "find" {
		var v any
		if json.Unmarshal(sort, &v) == nil {
			parts = append(parts, "sort "+keysOnly(v))
		}
	}
	return op, trimText(strings.Join(parts, " "), textLen)
}

// shapeOf writes a value with its keys and every literal as "?". Keys starting with "$"
// are operators and kept; so are field names.
func shapeOf(v any) string {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		// Extended JSON's typed literals ({"$oid": …}, {"$date": …}) are one literal.
		if len(keys) == 1 && extJSON[keys[0]] {
			return "?"
		}
		var b strings.Builder
		b.WriteString("{")
		for i, k := range keys {
			if i > 0 {
				b.WriteString(", ")
			}
			b.WriteString(k)
			b.WriteString(": ")
			b.WriteString(shapeOf(x[k]))
		}
		b.WriteString("}")
		return b.String()
	case []any:
		// An array of documents keeps their shapes (a pipeline, $and); an array of
		// literals is one "?".
		var parts []string
		for _, e := range x {
			if _, ok := e.(map[string]any); ok {
				parts = append(parts, shapeOf(e))
			}
		}
		if len(parts) == 0 {
			return "?"
		}
		return "[" + strings.Join(parts, ", ") + "]"
	default:
		return "?"
	}
}

var extJSON = map[string]bool{"$oid": true, "$date": true, "$numberLong": true, "$numberInt": true,
	"$numberDouble": true, "$numberDecimal": true, "$binary": true, "$regularExpression": true, "$timestamp": true, "$uuid": true}

func keysOnly(v any) string {
	m, ok := v.(map[string]any)
	if !ok {
		return "?"
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return "{" + strings.Join(keys, ", ") + "}"
}

func hostOf(h string) string {
	if host, _, err := net.SplitHostPort(h); err == nil {
		return host
	}
	return h
}

// slowLog: getLog global, the server's ring of its last 1,024 lines. New "Slow query"
// entries since the last scrape are counted (COLLSCAN apart), and the last hour's are
// kept for the table.
func (s *scrape) slowLog(ctx context.Context) {
	res, err := s.run(ctx, s.admin, bson.D{{Key: "getLog", Value: "global"}})
	if err != nil {
		if denied(err) {
			s.perms["operations/slow"] = "clusterMonitor"
		}
		return
	}
	arr, _ := res["log"].(bson.A)
	lines := make([]string, 0, len(arr))
	for _, x := range arr {
		if l, ok := x.(string); ok {
			lines = append(lines, l)
		}
	}
	entries := ParseSlow(lines, s.queryText)
	st := s.slow
	first := st.last.IsZero()
	newest := st.last
	for _, e := range entries {
		if !e.At.After(st.last) {
			continue
		}
		if e.At.After(newest) {
			newest = e.At
		}
		st.recent = append(st.recent, e)
		// The first scrape sees the ring's history: counted from the next one on, so a
		// restart of the collector doesn't count old entries as a burst.
		if first {
			continue
		}
		if e.Collscan {
			st.collscan++
		} else {
			st.rest++
		}
	}
	st.last = newest
	cut := time.Now().Add(-time.Hour)
	kept := st.recent[:0]
	for _, e := range st.recent {
		if e.At.After(cut) {
			kept = append(kept, e)
		}
	}
	// At most 2,000 entries are remembered per member.
	if len(kept) > 2000 {
		kept = kept[len(kept)-2000:]
	}
	st.recent = kept
	s.add("watchlog_mongodb_slow_ops_total", st.collscan, "plan", "collscan")
	s.add("watchlog_mongodb_slow_ops_total", st.rest, "plan", "other")
}

func (s *scrape) heavy(ctx context.Context) {
	s.slowTable()
	s.clients(ctx)
	s.top(ctx)
	colls := s.databases(ctx)
	s.collections(ctx, colls)
}

// ClientWindow: how far back from a shape's newest slow entry its clients are counted.
const ClientWindow = 10 * time.Minute

// slowTable groups the last hour's slow entries by namespace, operation and shape (or
// hash): count, mean and max duration, plan, and the client that sent most of them in
// the shape's last ClientWindow (a job that ran the same query an hour ago, from a pod
// that is gone now, must not outrank the one sending it now).
func (s *scrape) slowTable() {
	type key struct{ ns, op, shape, plan string }
	type agg struct {
		n, sum, max float64
		remote      string
		hash        string
		last        time.Time
		collscan    bool
		remotes     map[string]int
	}
	by := map[key]*agg{}
	for _, e := range s.slow.recent {
		k := key{e.NS, e.Op, e.Shape, e.Plan}
		if k.shape == "" {
			k.shape = e.Hash
		}
		a := by[k]
		if a == nil {
			a = &agg{remotes: map[string]int{}}
			by[k] = a
		}
		a.n++
		a.sum += e.Millis
		a.max = max(a.max, e.Millis)
		a.collscan = a.collscan || e.Collscan
		a.hash = e.Hash
		if e.At.After(a.last) {
			a.last, a.remote = e.At, e.Remote
		}
	}
	for _, e := range s.slow.recent {
		k := key{e.NS, e.Op, e.Shape, e.Plan}
		if k.shape == "" {
			k.shape = e.Hash
		}
		if a := by[k]; !e.At.Before(a.last.Add(-ClientWindow)) {
			a.remotes[e.Remote]++
		}
	}
	rows := make([]map[string]any, 0, len(by))
	for k, a := range by {
		// The client that sent most of them.
		top, topN := a.remote, 0
		for r, n := range a.remotes {
			if n > topN || (n == topN && r < top) {
				top, topN = r, n
			}
		}
		row := map[string]any{"ns": trimText(k.ns, 128), "op": k.op, "plan": k.plan, "count": int(a.n),
			"mean_ms": a.sum / a.n, "max_ms": a.max, "collscan": a.collscan, "remote": trimText(top, 64),
			"last": a.last.Unix(), "member": s.member}
		if s.queryText && k.shape != "" && k.shape != a.hash {
			row["shape"] = k.shape
		}
		if a.hash != "" {
			row["hash"] = a.hash
		}
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i]["count"].(int) > rows[j]["count"].(int) })
	if len(rows) > TopSlow {
		rows = rows[:TopSlow]
	}
	s.extra["slow"] = append(asRows(s.extra["slow"]), rows...)
}

// clients: $currentOp with idle connections, grouped by client address (mapped to a
// workload or container by the backend) and application name. WatchLog's own left out.
func (s *scrape) clients(ctx context.Context) {
	cur, err := s.admin.Aggregate(ctx, mongo.Pipeline{
		{{Key: "$currentOp", Value: bson.D{{Key: "allUsers", Value: true}, {Key: "idleConnections", Value: true}}}},
		{{Key: "$match", Value: bson.D{{Key: "client", Value: bson.D{{Key: "$exists", Value: true}}}}}},
		{{Key: "$project", Value: bson.D{{Key: "client", Value: 1}, {Key: "appName", Value: 1}, {Key: "active", Value: 1}, {Key: "secs_running", Value: 1}}}},
	})
	if err != nil {
		if denied(err) {
			s.perms["operations/clients"] = "clusterMonitor"
		}
		return
	}
	defer func() { _ = cur.Close(ctx) }()
	type key struct{ addr, app string }
	by := map[key]int{}
	longest := 0.0
	for cur.Next(ctx) {
		var d bson.M
		if cur.Decode(&d) != nil {
			continue
		}
		app := str(d, "appName")
		if app == "watchlog" {
			continue
		}
		by[key{hostOf(str(d, "client")), trimText(app, 64)}]++
		if a, _ := d["active"].(bool); a {
			if v, ok := toFloat(d["secs_running"]); ok {
				longest = max(longest, v)
			}
		}
	}
	s.add("watchlog_mongodb_longest_op_seconds", longest)
	rows := make([]map[string]any, 0, len(by))
	for k, n := range by {
		rows = append(rows, map[string]any{"addr": trimText(k.addr, 64), "app": k.app, "connections": n, "member": s.member})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i]["connections"].(int) > rows[j]["connections"].(int) })
	if len(rows) > MaxClients {
		rows = rows[:MaxClients]
	}
	s.extra["clients"] = append(asRows(s.extra["clients"]), rows...)
}

// top: time and operations per collection since the server started (counters), the
// busiest 30 by time.
func (s *scrape) top(ctx context.Context) {
	res, err := s.run(ctx, s.admin, bson.D{{Key: "top", Value: 1}})
	if err != nil {
		if denied(err) {
			s.perms["operations/busiest"] = "clusterMonitor"
		}
		return
	}
	totals, _ := res["totals"].(bson.M)
	type row struct {
		ns          string
		time, count float64
	}
	var rows []row
	for ns, v := range totals {
		d, ok := v.(bson.M)
		if !ok || systemNS(ns) {
			continue
		}
		t, _ := num(d, "total.time")
		n, _ := num(d, "total.count")
		rows = append(rows, row{ns, t, n})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].time > rows[j].time })
	if len(rows) > TopBusiest {
		rows = rows[:TopBusiest]
	}
	for _, r := range rows {
		ns := trimText(r.ns, 128)
		s.add("watchlog_mongodb_collection_time_seconds_total", r.time/1e6, "ns", ns)
		s.add("watchlog_mongodb_collection_ops_total", r.count, "ns", ns)
	}
}

func systemNS(ns string) bool {
	db, coll, _ := strings.Cut(ns, ".")
	return db == "admin" || db == "local" || db == "config" || strings.HasPrefix(coll, "system.") || ns == ""
}

// databases: listDatabases, then dbStats for up to 50 (by size): data and storage size,
// and the file system's use. It returns the collections to read stats for.
func (s *scrape) databases(ctx context.Context) []string {
	res, err := s.run(ctx, s.admin, bson.D{{Key: "listDatabases", Value: 1}, {Key: "nameOnly", Value: false}})
	if err != nil {
		if denied(err) {
			s.perms["storage/collections"] = "clusterMonitor"
		}
		return nil
	}
	arr, _ := res["databases"].(bson.A)
	type db struct {
		name string
		size float64
	}
	var dbs []db
	for _, x := range arr {
		d, ok := x.(bson.M)
		if !ok {
			continue
		}
		name := str(d, "name")
		if name == "local" || name == "config" {
			continue
		}
		size, _ := toFloat(d["sizeOnDisk"])
		dbs = append(dbs, db{name, size})
	}
	sort.Slice(dbs, func(i, j int) bool { return dbs[i].size > dbs[j].size })
	if len(dbs) > MaxDatabases {
		dbs = dbs[:MaxDatabases]
	}
	var colls []string
	fsDone := false
	for _, d := range dbs {
		st, err := s.run(ctx, s.c.Database(d.name), bson.D{{Key: "dbStats", Value: 1}})
		if err != nil {
			continue
		}
		name := trimText(d.name, 64)
		if v, ok := toFloat(st["dataSize"]); ok {
			s.add("watchlog_mongodb_db_data_bytes", v, "db", name)
		}
		if v, ok := toFloat(st["storageSize"]); ok {
			idx, _ := toFloat(st["indexSize"])
			s.add("watchlog_mongodb_db_storage_bytes", v+idx, "db", name)
		}
		if !fsDone {
			used, ok1 := toFloat(st["fsUsedSize"])
			total, ok2 := toFloat(st["fsTotalSize"])
			if ok1 && ok2 && total > 0 {
				s.add("watchlog_mongodb_fs_bytes", used, "state", "used")
				s.add("watchlog_mongodb_fs_bytes", total, "state", "total")
				fsDone = true
			}
		}
		if d.name == "admin" || len(colls) >= maxListed {
			continue
		}
		names, err := s.c.Database(d.name).ListCollectionNames(ctx, bson.D{{Key: "type", Value: "collection"}},
			options.ListCollections().SetAuthorizedCollections(true))
		if err != nil {
			if denied(err) {
				s.perms["storage/collections"] = "clusterMonitor"
			}
			continue
		}
		for _, n := range names {
			if strings.HasPrefix(n, "system.") || len(colls) >= maxListed {
				continue
			}
			colls = append(colls, d.name+"."+n)
		}
	}
	return colls
}

// collections: $collStats storage stats for the listed collections, the largest 100 kept,
// and $indexStats for those: the indexes with no use since the server started.
func (s *scrape) collections(ctx context.Context, colls []string) {
	type size struct {
		ns          string
		bytes, docs float64
	}
	var sizes []size
	for _, ns := range colls {
		db, coll, _ := strings.Cut(ns, ".")
		cur, err := s.c.Database(db).Collection(coll).Aggregate(ctx, mongo.Pipeline{
			{{Key: "$collStats", Value: bson.D{{Key: "storageStats", Value: bson.D{}}}}},
			{{Key: "$project", Value: bson.D{{Key: "storageStats.size", Value: 1}, {Key: "storageStats.storageSize", Value: 1},
				{Key: "storageStats.totalIndexSize", Value: 1}, {Key: "storageStats.count", Value: 1}}}},
		})
		if err != nil {
			if denied(err) {
				s.perms["storage/collections"] = "clusterMonitor"
				return
			}
			continue
		}
		var d bson.M
		if cur.Next(ctx) && cur.Decode(&d) == nil {
			st := sub(d, "storageStats")
			stor, _ := toFloat(st["storageSize"])
			idx, _ := toFloat(st["totalIndexSize"])
			docs, _ := toFloat(st["count"])
			sizes = append(sizes, size{ns, stor + idx, docs})
		}
		_ = cur.Close(ctx)
	}
	sort.Slice(sizes, func(i, j int) bool { return sizes[i].bytes > sizes[j].bytes })
	if len(sizes) > MaxCollections {
		sizes = sizes[:MaxCollections]
	}
	var unused []map[string]any
	for _, x := range sizes {
		ns := trimText(x.ns, 128)
		s.add("watchlog_mongodb_collection_size_bytes", x.bytes, "ns", ns)
		s.add("watchlog_mongodb_collection_documents", x.docs, "ns", ns)
		if len(unused) >= MaxUnused {
			continue
		}
		db, coll, _ := strings.Cut(x.ns, ".")
		cur, err := s.c.Database(db).Collection(coll).Aggregate(ctx, mongo.Pipeline{{{Key: "$indexStats", Value: bson.D{}}}})
		if err != nil {
			if denied(err) {
				s.perms["storage/indexes"] = "clusterMonitor"
			}
			continue
		}
		for cur.Next(ctx) {
			var d bson.M
			if cur.Decode(&d) != nil {
				continue
			}
			name := str(d, "name")
			ops, _ := num(d, "accesses.ops")
			if name == "_id_" || ops > 0 {
				continue
			}
			since, _ := sub(d, "accesses")["since"].(bson.DateTime)
			unused = append(unused, map[string]any{"ns": ns, "index": trimText(name, 128), "since": since.Time().Unix(), "member": s.member})
		}
		_ = cur.Close(ctx)
	}
	s.extra["unused_indexes"] = append(asRows(s.extra["unused_indexes"]), unused...)
}

func asRows(v any) []map[string]any {
	r, _ := v.([]map[string]any)
	return r
}

func trimText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// ---------------------------------------------------------------- probe

// Roles is what connectionStatus says the user has, as WatchLog needs it. clusterMonitor
// also reads the local database (the oplog's first and last entries), measured on 7.0 and
// 8.0 (rolesInfo: find on every collection of local).
type Roles struct {
	Monitor bool
	// Excess are roles beyond what WatchLog needs (ADR-134).
	Excess []string
}

// excessRoles are roles that can write or administer.
var excessRoles = map[string]bool{"root": true, "readWriteAnyDatabase": true, "dbAdminAnyDatabase": true,
	"userAdminAnyDatabase": true, "clusterAdmin": true, "clusterManager": true, "hostManager": true,
	"restore": true, "__system": true, "dbOwner": true, "userAdmin": true, "readWrite": true, "dbAdmin": true}

// monitorRoles include clusterMonitor's actions.
var monitorRoles = map[string]bool{"clusterMonitor": true, "clusterAdmin": true, "root": true, "__system": true}

// ParseRoles reads connectionStatus's authenticatedUserRoles ({role, db} pairs). With
// authentication off there are none, and nothing is missing.
func ParseRoles(roles []bson.M, authOn bool) Roles {
	r := Roles{Monitor: !authOn}
	excess := map[string]bool{}
	for _, x := range roles {
		role, db := str(x, "role"), str(x, "db")
		if db == "admin" && monitorRoles[role] {
			r.Monitor = true
		}
		if excessRoles[role] {
			name := role
			if db != "admin" {
				name = role + "@" + db
			}
			excess[name] = true
		}
	}
	for k := range excess {
		r.Excess = append(r.Excess, k)
	}
	sort.Strings(r.Excess)
	return r
}

// Probe implements integrations.Prober: log in, then check the user's roles.
// clusterMonitor is required, and is all WatchLog needs.
func (p *MongoDB) Probe(ctx context.Context, t integrations.Target) integrations.ProbeResult {
	out := integrations.ProbeResult{Code: integrations.ProbeUnreachable}
	for _, m := range t.Members {
		c, _, err := connect(ctx, m, t.Auth)
		if err != nil {
			switch {
			case isAuth(err):
				return integrations.ProbeResult{Code: integrations.ProbeAuthFailed, Error: short(err)}
			case code(err) != 0:
				return integrations.ProbeResult{Code: integrations.ProbeError, Error: short(err)}
			}
			out.Error = short(err)
			continue
		}
		defer func() { _ = c.Disconnect(context.Background()) }()
		admin := c.Database("admin")
		var info struct {
			Version string `bson:"version"`
		}
		if err := admin.RunCommand(ctx, bson.D{{Key: "buildInfo", Value: 1}}).Decode(&info); err != nil {
			return integrations.ProbeResult{Code: integrations.ProbeError, Error: short(err)}
		}
		var cs struct {
			AuthInfo struct {
				Users []bson.M `bson:"authenticatedUsers"`
				Roles []bson.M `bson:"authenticatedUserRoles"`
			} `bson:"authInfo"`
		}
		if err := admin.RunCommand(ctx, bson.D{{Key: "connectionStatus", Value: 1}}).Decode(&cs); err != nil {
			return integrations.ProbeResult{Code: integrations.ProbeError, Error: short(err)}
		}
		authOn := t.Auth != nil && t.Auth.Password != ""
		// serverStatus is the first thing a scrape reads: without a user on a server with
		// authentication on, it is refused.
		if err := admin.RunCommand(ctx, bson.D{{Key: "serverStatus", Value: 1}}).Err(); err != nil && denied(err) && !authOn {
			return integrations.ProbeResult{Code: integrations.ProbeAuthFailed, Error: "authentication is on: WatchLog needs a user"}
		}
		r := ParseRoles(cs.AuthInfo.Roles, authOn && len(cs.AuthInfo.Users) > 0)
		out = integrations.ProbeResult{Code: integrations.ProbeOK, Version: info.Version, Excess: r.Excess, Facts: map[string]any{}}
		var hello bson.M
		if err := admin.RunCommand(ctx, bson.D{{Key: "hello", Value: 1}}).Decode(&hello); err == nil {
			if set := str(hello, "setName"); set != "" {
				out.Facts["replica_set"] = set
				hosts, _ := hello["hosts"].(bson.A)
				passives, _ := hello["passives"].(bson.A)
				out.Facts["members"] = len(hosts) + len(passives)
			} else if str(hello, "msg") == "isdbgrid" {
				out.Facts["mongos"] = true
			}
		}
		if !authOn {
			// A server that lets anyone in: WatchLog says so (ADR-134's excess, inverted).
			out.Facts["auth"] = "off"
		}
		if !r.Monitor {
			out.Code, out.Missing = integrations.ProbePermission, []string{"clusterMonitor"}
		}
		return out
	}
	return out
}

// String keeps the type readable in logs.
func (p *MongoDB) String() string { return fmt.Sprintf("mongodb(%d targets)", len(p.heavyPerms)) }
