// SPDX-License-Identifier: AGPL-3.0-only

// What 1.4 adds to the MongoDB integration (ADR-247): what the server waits on, sampled from
// $currentOp every light scrape; operation shapes over time (the slow log's operations, or
// $queryStats where the server keeps it); transactions, idle cursors and index builds; the
// replica set's elections, heartbeats, votes and rollbacks; WiredTiger's eviction by
// application threads and checkpoints; and the catalog (collections, indexes) every ten
// minutes, cached in between. Every operation is reduced to its shape here, in the agent: a
// command's literal values never leave it (ADR-138).
package mongodb

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Caps (ADR-136, ADR-247).
const (
	// TopShapes is how many shapes get their own series; the rest are "other".
	TopShapes = 50
	// maxShapes bounds the shapes remembered per member (least recently seen dropped).
	maxShapes = 500
	// CatalogEvery is how often collections and indexes are read again; in between, the
	// last reading is sent.
	CatalogEvery = 10 * time.Minute
	// TxnLong is when an open transaction is worth naming (the server aborts it at its
	// lifetime limit, 60 s by default).
	TxnLong     = 30
	maxListed10 = 10
)

// WaitClasses are the classes of active operations, the first one always emitted.
var WaitClasses = []string{"running", "lock", "ticket", "flow_control", "other"}

// ShapeID names a shape the same way whichever source saw it: the collection, the operation
// and the shape (literals already gone), hashed.
func ShapeID(ns, op, shape string) string {
	h := sha256.Sum256([]byte(ns + "\x00" + op + "\x00" + shape))
	return hex.EncodeToString(h[:8])
}

// shapeAgg is one shape's running counts, from the slow log.
type shapeAgg struct {
	ns, op, shape, plan      string
	calls, ms                float64
	examined, keys, returned float64
	collscan                 bool
	seen                     time.Time
}

// opShape reduces one operation from $currentOp to its namespace, operation and shape. A
// getMore is the find or aggregate that opened its cursor.
func opShape(d bson.M) (ns, op, shape string) {
	ns = str(d, "ns")
	op = str(d, "op")
	cmd := sub(d, "command")
	if op == "getmore" {
		if o := sub(d, "originatingCommand"); o != nil {
			cmd = o
		}
	}
	if cmd == nil {
		return ns, op, ""
	}
	raw, err := bson.MarshalExtJSON(cmd, false, false)
	if err != nil {
		return ns, op, ""
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return ns, op, ""
	}
	if o, s := Shape(m); o != "" {
		return ns, o, s
	}
	for _, w := range []string{"insert", "update", "delete"} {
		if _, ok := m[w]; ok {
			return ns, w, ""
		}
	}
	return ns, op, ""
}

// awaitable: a driver's monitoring hello, "active" while it waits for a topology change.
func awaitable(d bson.M) bool {
	cmd := sub(d, "command")
	for _, k := range []string{"hello", "isMaster", "ismaster"} {
		if _, ok := cmd[k]; ok {
			return true
		}
	}
	return false
}

// WaitClassOf is the class of one active operation: flow control, a ticket queue (8.0's
// currentQueue), a lock, a latch (other), or running.
func WaitClassOf(d bson.M) string {
	if b, _ := d["waitingForFlowControl"].(bool); b {
		return "flow_control"
	}
	if q, ok := d["currentQueue"]; ok && q != nil {
		if s, isStr := q.(string); !isStr || s != "" {
			return "ticket"
		}
	}
	if b, _ := d["waitingForLock"].(bool); b {
		return "lock"
	}
	if l, ok := d["waitingForLatch"]; ok && l != nil {
		return "other"
	}
	return "running"
}

// waits samples $currentOp once: active operations by class, shape and client; open
// transactions; idle cursors that never time out; index builds. Light scrape, every 15 s.
func (s *scrape) waits(ctx context.Context) {
	cur, err := s.admin.Aggregate(ctx, mongo.Pipeline{
		{{Key: "$currentOp", Value: bson.D{{Key: "allUsers", Value: true}, {Key: "idleConnections", Value: false},
			{Key: "idleSessions", Value: true}, {Key: "idleCursors", Value: true}}}},
		{{Key: "$project", Value: bson.D{{Key: "type", Value: 1}, {Key: "active", Value: 1}, {Key: "op", Value: 1},
			{Key: "ns", Value: 1}, {Key: "command", Value: 1}, {Key: "originatingCommand", Value: 1},
			{Key: "planSummary", Value: 1}, {Key: "waitingForLock", Value: 1}, {Key: "waitingForFlowControl", Value: 1},
			{Key: "waitingForLatch", Value: 1}, {Key: "currentQueue", Value: 1}, {Key: "client", Value: 1},
			{Key: "appName", Value: 1}, {Key: "secs_running", Value: 1}, {Key: "desc", Value: 1}, {Key: "msg", Value: 1},
			{Key: "transaction.timeOpenMicros", Value: 1}, {Key: "transaction.timeInactiveMicros", Value: 1},
			{Key: "cursor.lastAccessDate", Value: 1}, {Key: "cursor.createdDate", Value: 1},
			{Key: "cursor.noCursorTimeout", Value: 1}}}},
	})
	if err != nil {
		if denied(err) {
			s.perms["waits/waits"] = "clusterMonitor"
		} else if unsupported(err) {
			s.perms["waits/waits"] = "unsupported"
		}
		return
	}
	defer func() { _ = cur.Close(ctx) }()
	byClass := map[string]float64{}
	type sk struct{ id, class string }
	type ck struct{ addr, class string }
	type sc struct{ id, addr string }
	byShape := map[sk]float64{}
	byClient := map[ck]float64{}
	sightings := map[sc]float64{}
	var txns, cursors, builds []map[string]any
	oldestTxn, idleNoTimeout, longest := 0.0, 0.0, 0.0
	now := time.Now()
	for cur.Next(ctx) {
		var d bson.M
		if cur.Decode(&d) != nil {
			continue
		}
		app := str(d, "appName")
		if app == "watchlog" {
			continue
		}
		addr := hostOf(str(d, "client"))
		if t := sub(d, "transaction"); t != nil {
			open, _ := toFloat(t["timeOpenMicros"])
			idle, _ := toFloat(t["timeInactiveMicros"])
			oldestTxn = max(oldestTxn, open/1e6)
			txns = append(txns, map[string]any{"addr": trimText(addr, 64), "app": trimText(app, 64),
				"age": open / 1e6, "idle": idle / 1e6, "state": str(d, "type"), "member": s.member})
		}
		switch str(d, "type") {
		case "idleCursor":
			c := sub(d, "cursor")
			if nt, _ := c["noCursorTimeout"].(bool); nt {
				idleNoTimeout++
				last, _ := c["lastAccessDate"].(bson.DateTime)
				created, _ := c["createdDate"].(bson.DateTime)
				cursors = append(cursors, map[string]any{"ns": trimText(str(d, "ns"), 128),
					"idle": now.Sub(last.Time()).Seconds(), "age": now.Sub(created.Time()).Seconds(), "member": s.member})
			}
			continue
		case "op":
		default:
			continue
		}
		active, _ := d["active"].(bool)
		if !active || str(d, "op") == "none" || awaitable(d) {
			continue
		}
		msg := str(d, "msg")
		if _, ok := sub(d, "command")["createIndexes"]; ok || strings.HasPrefix(msg, "Index Build") {
			builds = append(builds, map[string]any{"ns": trimText(str(d, "ns"), 128), "progress": trimText(msg, 120),
				"seconds": num0(d, "secs_running"), "member": s.member})
		}
		// The server's own work (replication, TTL, monitors) has no client; a secondary
		// reading the oplog, or anything on local, admin or config, is no workload's.
		if addr == "" || strings.HasPrefix(str(d, "desc"), "OplogFetcher") || systemNS(str(d, "ns")) {
			continue
		}
		class := WaitClassOf(d)
		byClass[class]++
		ns, op, shape := opShape(d)
		id := ShapeID(ns, op, shape)
		s.slow.seenShape(id, ns, op, shape)
		if !s.slow.top[id] {
			id = "other"
		} else {
			sightings[sc{id, addr}]++
		}
		byShape[sk{id, class}]++
		byClient[ck{addr, class}]++
		longest = max(longest, num0(d, "secs_running"))
	}
	for _, c := range WaitClasses {
		s.add("watchlog_mongodb_active_sessions", byClass[c], "wait", c)
	}
	for k, n := range byShape {
		s.add("watchlog_mongodb_statement_active_sessions", n, "shape", k.id, "wait", k.class)
	}
	n := 0
	for k, v := range byClient {
		if n++; n > MaxClients {
			break
		}
		s.add("watchlog_mongodb_client_active_sessions", v, "addr", trimText(k.addr, 64), "wait", k.class)
	}
	// Who sends each shape: what runs now, and the slow log's new entries since the last scrape.
	for _, e := range s.newSlow {
		if s.slow.top[e.ID] && e.Remote != "" {
			sightings[sc{e.ID, e.Remote}]++
		}
	}
	for k, v := range sightings {
		s.add("watchlog_mongodb_statement_client_sessions", v, "shape", k.id, "addr", trimText(k.addr, 64))
	}
	s.add("watchlog_mongodb_longest_op_seconds", longest)
	s.add("watchlog_mongodb_transactions_open", float64(len(txns)))
	s.add("watchlog_mongodb_transaction_oldest_seconds", oldestTxn)
	s.add("watchlog_mongodb_cursors_idle_no_timeout", idleNoTimeout)
	s.add("watchlog_mongodb_index_builds", float64(len(builds)))
	sort.Slice(txns, func(i, j int) bool { return txns[i]["age"].(float64) > txns[j]["age"].(float64) })
	sort.Slice(cursors, func(i, j int) bool { return cursors[i]["idle"].(float64) > cursors[j]["idle"].(float64) })
	s.extra["transactions"] = append(asRows(s.extra["transactions"]), first(txns, maxListed10)...)
	s.extra["cursors"] = append(asRows(s.extra["cursors"]), first(cursors, maxListed10)...)
	s.extra["index_builds"] = append(asRows(s.extra["index_builds"]), first(builds, maxListed10)...)
}

func num0(d bson.M, k string) float64 {
	v, _ := toFloat(d[k])
	return v
}

func first(rows []map[string]any, n int) []map[string]any {
	if len(rows) > n {
		return rows[:n]
	}
	return rows
}

// countShapes adds the slow log's new entries to the member's running counts per shape and
// returns the top shapes by time. Entries the first scrape saw are history and not counted.
func (st *slowState) countShapes(entries []slowEntry, counted bool) {
	if st.shapes == nil {
		st.shapes = map[string]*shapeAgg{}
	}
	for _, e := range entries {
		// Not a query (createIndexes, a command without a filter): no shape to count.
		if e.Op == "" {
			continue
		}
		a := st.shapes[e.ID]
		if a == nil {
			a = &shapeAgg{ns: e.NS, op: e.Op, shape: e.FullShape}
			st.shapes[e.ID] = a
		}
		a.plan, a.seen = e.Plan, e.At
		a.collscan = a.collscan || e.Collscan
		if counted {
			a.calls++
			a.ms += e.Millis
			a.examined += e.DocsExamined
			a.keys += e.KeysExamined
			a.returned += e.Returned
		}
	}
	if len(st.shapes) > maxShapes {
		ids := make([]string, 0, len(st.shapes))
		for id := range st.shapes {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return st.shapes[ids[i]].seen.After(st.shapes[ids[j]].seen) })
		for _, id := range ids[maxShapes:] {
			delete(st.shapes, id)
		}
	}
	ids := make([]string, 0, len(st.shapes))
	for id := range st.shapes {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		a, b := st.shapes[ids[i]], st.shapes[ids[j]]
		if a.ms != b.ms {
			return a.ms > b.ms
		}
		return ids[i] < ids[j]
	})
	st.top = map[string]bool{}
	for i, id := range ids {
		if i >= TopShapes {
			break
		}
		st.top[id] = true
	}
}

// seenShape remembers a shape the sample saw running, so it can be among the top shapes even
// when it is never slow enough for the log (its counts stay zero: the sample has no calls).
func (st *slowState) seenShape(id, ns, op, shape string) {
	if op == "" || op == "command" || ns == "" {
		return
	}
	if st.shapes == nil {
		st.shapes = map[string]*shapeAgg{}
	}
	if a := st.shapes[id]; a != nil {
		a.seen = time.Now()
		return
	}
	st.shapes[id] = &shapeAgg{ns: ns, op: op, shape: shape, seen: time.Now()}
}

// MergeShapes folds every member's shape rows into one per shape (counts summed, the
// collection scan kept if any member saw one), the most called first, at most 100 rows.
func MergeShapes(rows []map[string]any) []map[string]any {
	by := map[string]map[string]any{}
	var order []string
	for _, r := range rows {
		id, _ := r["shape"].(string)
		cur, ok := by[id]
		if !ok {
			c := map[string]any{}
			for k, v := range r {
				c[k] = v
			}
			by[id] = c
			order = append(order, id)
			continue
		}
		for _, k := range []string{"calls", "examined", "keys", "returned"} {
			a, _ := cur[k].(float64)
			b, _ := r[k].(float64)
			cur[k] = a + b
		}
		if b, _ := r["collscan"].(bool); b {
			cur["collscan"] = true
		}
		if p, _ := r["plan"].(string); p != "" {
			cur["plan"] = p
		}
	}
	out := make([]map[string]any, 0, len(order))
	for _, id := range order {
		out = append(out, by[id])
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, _ := out[i]["calls"].(float64)
		b, _ := out[j]["calls"].(float64)
		return a > b
	})
	if len(out) > 100 {
		out = out[:100]
	}
	return out
}

// shapeSeries: the top shapes' counters (light scrape) when the slow log is the source.
func (s *scrape) shapeSeries() {
	if s.querystats {
		return
	}
	for id := range s.slow.top {
		a := s.slow.shapes[id]
		s.add("watchlog_mongodb_statement_calls_total", a.calls, "shape", id)
		s.add("watchlog_mongodb_statement_seconds_total", a.ms/1000, "shape", id)
		s.add("watchlog_mongodb_statement_docs_returned_total", a.returned, "shape", id)
		s.add("watchlog_mongodb_statement_docs_examined_total", a.examined, "shape", id)
		s.add("watchlog_mongodb_statement_keys_examined_total", a.keys, "shape", id)
	}
	s.add("watchlog_mongodb_shape_source", 1, "source", "slowlog")
}

// shapeRows: the top shapes' facts for the page (heavy scrape): text only with query text on.
func (s *scrape) shapeRows() {
	rows := make([]map[string]any, 0, len(s.slow.top))
	for id := range s.slow.top {
		a := s.slow.shapes[id]
		r := map[string]any{"shape": id, "ns": trimText(a.ns, 128), "op": a.op, "plan": trimText(a.plan, 128),
			"collscan": a.collscan, "calls": a.calls, "examined": a.examined, "keys": a.keys, "returned": a.returned,
			"member": s.member}
		if s.queryText && a.shape != "" {
			r["query"] = a.shape
			r["fields"] = trimText(strings.Join(FieldsOf(a.shape), ","), textLen)
		}
		rows = append(rows, r)
	}
	s.extra["shapes"] = append(asRows(s.extra["shapes"]), rows...)
}

// FieldsOf lists the field names a shape filters or sorts on, in order: keys that aren't
// operators ("$gt") ({type: ?, createdAt: {$gt: ?}} sort {createdAt} → type, createdAt).
func FieldsOf(shape string) []string {
	var out []string
	seen := map[string]bool{}
	word := strings.Builder{}
	flush := func(next byte) {
		w := word.String()
		word.Reset()
		if w == "" || next != ':' && next != ',' && next != '}' {
			return
		}
		if strings.HasPrefix(w, "$") || w == "?" || w == "sort" || seen[w] {
			return
		}
		seen[w] = true
		out = append(out, w)
	}
	inSort := false
	for i := 0; i < len(shape); i++ {
		c := shape[i]
		switch {
		case c == '{' || c == '[' || c == ' ':
			if word.String() == "sort" {
				inSort = true
			}
			word.Reset()
		case c == ':' || (inSort && (c == ',' || c == '}')):
			flush(c)
		case c == ',' || c == '}' || c == ']':
			word.Reset()
		default:
			word.WriteByte(c)
		}
	}
	return out
}

// queryStats reads $queryStats where the server keeps it (Atlas; self-hosted servers return no
// rows unless the owner turned it on): the 50 shapes with the most time, already without
// literals. Heavy scrape. It reports whether it had rows.
func (s *scrape) queryStats(ctx context.Context) bool {
	cur, err := s.admin.Aggregate(ctx, mongo.Pipeline{
		{{Key: "$queryStats", Value: bson.D{}}},
		{{Key: "$sort", Value: bson.D{{Key: "metrics.totalExecMicros.sum", Value: -1}}}},
		{{Key: "$limit", Value: TopShapes}},
	})
	if err != nil {
		return false
	}
	defer func() { _ = cur.Close(ctx) }()
	var rows []map[string]any
	for cur.Next(ctx) {
		var d bson.M
		if cur.Decode(&d) != nil {
			continue
		}
		r, ok := QueryStatsRow(d, s.queryText)
		if !ok {
			continue
		}
		id := r["shape"].(string)
		m := sub(d, "metrics")
		s.add("watchlog_mongodb_statement_calls_total", num0(m, "execCount"), "shape", id)
		s.add("watchlog_mongodb_statement_seconds_total", sumOf(m, "totalExecMicros")/1e6, "shape", id)
		s.add("watchlog_mongodb_statement_docs_returned_total", sumOf(m, "docsReturned"), "shape", id)
		s.add("watchlog_mongodb_statement_docs_examined_total", sumOf(m, "docsExamined"), "shape", id)
		s.add("watchlog_mongodb_statement_keys_examined_total", sumOf(m, "keysExamined"), "shape", id)
		r["member"] = s.member
		rows = append(rows, r)
	}
	if len(rows) == 0 {
		return false
	}
	s.add("watchlog_mongodb_shape_source", 1, "source", "querystats")
	s.extra["shapes"] = append(asRows(s.extra["shapes"]), rows...)
	return true
}

func sumOf(m bson.M, k string) float64 {
	v, _ := toFloat(sub(m, k)["sum"])
	return v
}

// QueryStatsRow turns one $queryStats entry into a shape row: its namespace, command and
// shape (the server already wrote "?string" for every literal), counts, and the server's
// hash as the id.
func QueryStatsRow(d bson.M, queryText bool) (map[string]any, bool) {
	key := sub(d, "key")
	qs := sub(key, "queryShape")
	if qs == nil {
		return nil, false
	}
	ns := sub(qs, "cmdNs")
	full := str(ns, "db") + "." + str(ns, "coll")
	op := str(qs, "command")
	id := str(d, "queryShapeHash")
	text := ""
	if f, ok := qs["filter"]; ok {
		text = shapeOfBSON(f)
	}
	if id == "" {
		id = ShapeID(full, op, text)
	}
	m := sub(d, "metrics")
	r := map[string]any{"shape": trimText(id, 64), "ns": trimText(full, 128), "op": op, "calls": num0(m, "execCount"),
		"examined": sumOf(m, "docsExamined"), "keys": sumOf(m, "keysExamined"), "returned": sumOf(m, "docsReturned"),
		"source": "querystats"}
	if queryText && text != "" {
		r["query"] = trimText(text, textLen)
		r["fields"] = trimText(strings.Join(FieldsOf(text), ","), textLen)
	}
	return r, true
}

// shapeOfBSON writes a $queryStats shape, whose values are already "?string"-style
// placeholders, the way Shape writes the others.
func shapeOfBSON(v any) string {
	raw, err := bson.MarshalExtJSON(bson.M{"v": v}, false, false)
	if err != nil {
		return ""
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return ""
	}
	return shapeOf(m["v"])
}

// serverDeep: what 1.4 reads from serverStatus beyond the light scrape's first reads.
func (s *scrape) serverDeep(ss bson.M) {
	wt := sub(ss, "wiredTiger")
	cache := sub(wt, "cache")
	// Eviction by application threads: time on 8.0, pages before.
	if v, ok := toFloat(cache["application thread time evicting (usecs)"]); ok {
		s.add("watchlog_mongodb_app_eviction_seconds_total", v/1e6)
	} else if v, ok := toFloat(cache["pages evicted by application threads"]); ok {
		s.add("watchlog_mongodb_app_evicted_pages_total", v)
	}
	if v, ok := toFloat(sub(wt, "checkpoint")["most recent time (msecs)"]); ok {
		s.add("watchlog_mongodb_checkpoint_seconds", v/1000)
	} else if v, ok := toFloat(sub(wt, "transaction")["transaction checkpoint most recent time (msecs)"]); ok {
		s.add("watchlog_mongodb_checkpoint_seconds", v/1000)
	}
	if v, ok := num(ss, "extra_info.page_faults"); ok {
		s.add("watchlog_mongodb_page_faults_total", v)
	}
	for _, k := range []string{"total", "noTimeout"} {
		if v, ok := num(ss, "metrics.cursor.open."+k); ok {
			s.add("watchlog_mongodb_cursors_open", v, "kind", strings.ToLower(k))
		}
	}
	if fc := sub(ss, "flowControl"); fc != nil {
		if v, ok := toFloat(fc["isLagged"]); ok {
			s.add("watchlog_mongodb_flow_control_lagged", v)
		}
		if v, ok := toFloat(fc["timeAcquiringMicros"]); ok {
			s.add("watchlog_mongodb_flow_control_seconds_total", v/1e6)
		}
	}
	if v, ok := num(ss, "repl.rbid"); ok {
		s.add("watchlog_mongodb_rollback_id", v)
	}
	if v, ok := num(ss, "connections.rejected"); ok {
		s.add("watchlog_mongodb_connections_rejected_total", v)
	}
	if v, ok := num(ss, "metrics.queryExecutor.scannedObjects"); ok {
		s.add("watchlog_mongodb_docs_scanned_total", v)
	}
}

// replicaDeep: per member, heartbeat round trip, priority and votes; the last election (on the
// primary, which knows why it won).
func (s *scrape) replicaDeep(ctx context.Context, st bson.M, rows []map[string]any) {
	arr, _ := st["members"].(bson.A)
	ping := map[string]float64{}
	for _, x := range arr {
		d, ok := x.(bson.M)
		if !ok {
			continue
		}
		name := ShortHost(str(d, "name"))
		if v, ok := toFloat(d["pingMs"]); ok {
			ping[name] = v / 1000
			s.add("watchlog_mongodb_member_ping_seconds", v/1000, "rs_member", name)
		}
		if str(d, "stateStr") == "PRIMARY" {
			if t, ok := d["electionDate"].(bson.DateTime); ok {
				reason := str(sub(st, "electionCandidateMetrics"), "lastElectionReason")
				pairs := []string{"rs_member", name}
				if reason != "" {
					pairs = append(pairs, "reason", trimText(reason, 48))
				}
				s.add("watchlog_mongodb_election_timestamp_seconds", float64(t.Time().Unix()), pairs...)
			}
		}
	}
	cfg, err := s.run(ctx, s.admin, bson.D{{Key: "replSetGetConfig", Value: 1}})
	if err != nil {
		return
	}
	members, _ := sub(cfg, "config")["members"].(bson.A)
	votes, voters := map[string]float64{}, 0.0
	prio := map[string]float64{}
	for _, x := range members {
		d, ok := x.(bson.M)
		if !ok {
			continue
		}
		name := ShortHost(str(d, "host"))
		v, _ := toFloat(d["votes"])
		p, _ := toFloat(d["priority"])
		votes[name], prio[name] = v, p
		if v > 0 {
			voters++
		}
	}
	s.add("watchlog_mongodb_voting_members", voters)
	for _, r := range rows {
		n, _ := r["name"].(string)
		if v, ok := votes[n]; ok {
			r["votes"], r["priority"] = v, prio[n]
		}
		if p, ok := ping[n]; ok {
			r["ping"] = p
		}
	}
}

// settings: the feature compatibility version against the binary, the transaction lifetime
// limit, and whether the server let the collector in without a user. Heavy scrape.
func (s *scrape) settings(ctx context.Context, authOff bool) {
	if authOff {
		s.add("watchlog_mongodb_access_control_off", 1)
	}
	p, err := s.run(ctx, s.admin, bson.D{{Key: "getParameter", Value: 1}, {Key: "featureCompatibilityVersion", Value: 1},
		{Key: "transactionLifetimeLimitSeconds", Value: 1}})
	if err != nil {
		return
	}
	if v, ok := toFloat(p["transactionLifetimeLimitSeconds"]); ok {
		s.add("watchlog_mongodb_setting", v, "name", "transactionLifetimeLimitSeconds")
	}
	fcv := str(sub(p, "featureCompatibilityVersion"), "version")
	if fcv == "" || s.version == "" {
		return
	}
	behind := 0.0
	if FCVBehind(fcv, s.version) {
		behind = 1
	}
	s.add("watchlog_mongodb_fcv_behind", behind)
	s.extra["settings"] = append(asRows(s.extra["settings"]), map[string]any{"name": "featureCompatibilityVersion",
		"value": trimText(fcv, 16), "version": trimText(s.version, 32), "member": s.member})
}

// FCVBehind: the feature compatibility version is older than the binary's major.minor.
func FCVBehind(fcv, version string) bool {
	mm := func(v string) (int, int) {
		p := strings.SplitN(v, ".", 3)
		a, _ := strconv.Atoi(p[0])
		b := 0
		if len(p) > 1 {
			b, _ = strconv.Atoi(p[1])
		}
		return a, b
	}
	fa, fb := mm(fcv)
	va, vb := mm(version)
	return fa < va || (fa == va && fb < vb)
}

// ---------------------------------------------------------------- the catalog

// catalog is the last reading of collections and indexes, re-sent between readings.
type catalog struct {
	at      time.Time
	samples []metrics.Sample
	rows    map[string][]map[string]any
}

// Index is one index as $indexStats describes it.
type Index struct {
	NS, Name string
	Key      []string // "field:1", in order
	Unique   bool
	Special  bool // partial, sparse, TTL, text, hashed, geo, wildcard: not a plain prefix
	Ops      float64
	Since    time.Time
	Building bool
	Bytes    float64
}

// IndexFrom reads one $indexStats entry; key is its key in order (orderedKey).
func IndexFrom(ns string, d bson.M, key bson.D, sizes bson.M) Index {
	ix := Index{NS: ns, Name: str(d, "name")}
	ix.Ops, _ = num(d, "accesses.ops")
	if t, ok := sub(d, "accesses")["since"].(bson.DateTime); ok {
		ix.Since = t.Time()
	}
	ix.Building, _ = d["building"].(bool)
	spec := sub(d, "spec")
	ix.Unique, _ = spec["unique"].(bool)
	_, partial := spec["partialFilterExpression"]
	_, ttl := spec["expireAfterSeconds"]
	sparse, _ := spec["sparse"].(bool)
	ix.Special = partial || ttl || sparse
	pairs := key
	for _, e := range pairs {
		dir := ""
		switch v := e.Value.(type) {
		case string:
			dir = v
			ix.Special = true
		default:
			f, _ := toFloat(v)
			dir = strconv.FormatFloat(f, 'g', -1, 64)
		}
		ix.Key = append(ix.Key, e.Key+":"+dir)
	}
	ix.Bytes, _ = toFloat(sizes[ix.Name])
	return ix
}

// Redundant returns, for each index whose keys are a leading prefix of another plain index's
// on the same collection, the name of the longer one. The _id index, unique indexes and
// special ones (partial, sparse, TTL, text, hashed) are never redundant.
func Redundant(ixs []Index) map[string]string {
	out := map[string]string{}
	for _, a := range ixs {
		if a.Name == "_id_" || a.Unique || a.Special || len(a.Key) == 0 {
			continue
		}
		for _, b := range ixs {
			if b.Name == a.Name || b.Special || len(b.Key) <= len(a.Key) {
				continue
			}
			prefix := true
			for i := range a.Key {
				if a.Key[i] != b.Key[i] {
					prefix = false
					break
				}
			}
			if prefix {
				out[a.Name] = b.Name
				break
			}
		}
	}
	return out
}
