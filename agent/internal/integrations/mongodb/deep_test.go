// SPDX-License-Identifier: AGPL-3.0-only

package mongodb

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestWaitClassOf(t *testing.T) {
	cases := []struct {
		d    bson.M
		want string
	}{
		{bson.M{"waitingForLock": false, "waitingForFlowControl": false}, "running"},
		{bson.M{"waitingForLock": true}, "lock"},
		{bson.M{"waitingForFlowControl": true, "waitingForLock": true}, "flow_control"},
		// 8.0: currentQueue is null unless the operation waits in a ticket queue.
		{bson.M{"currentQueue": nil, "waitingForLock": false}, "running"},
		{bson.M{"currentQueue": "execution"}, "ticket"},
		{bson.M{"waitingForLatch": bson.M{"captureName": "x"}}, "other"},
	}
	for _, c := range cases {
		if got := WaitClassOf(c.d); got != c.want {
			t.Errorf("%v: %s, want %s", c.d, got, c.want)
		}
	}
}

// A getMore from $currentOp (8.0.38 in Step 0): the shape is the find that opened the cursor,
// every literal gone, and the id is the one the slow log's line gives the same find.
func TestOpShapeDropsLiterals(t *testing.T) {
	op := bson.M{"ns": "shop.events", "op": "getmore",
		"command": bson.M{"getMore": int64(123), "collection": "events"},
		"originatingCommand": bson.M{"find": "events", "filter": bson.M{"type": "buy",
			"createdAt": bson.M{"$gt": bson.DateTime(1795000000000)}}, "lsid": bson.M{"id": "x"}}}
	ns, o, shape := opShape(op)
	if ns != "shop.events" || o != "find" || shape != "{createdAt: {$gt: ?}, type: ?}" {
		t.Fatalf("%s %s %q", ns, o, shape)
	}
	if strings.Contains(shape, "buy") {
		t.Fatal("a literal survived")
	}
	line := `{"t":{"$date":"2026-11-28T16:45:00.000+00:00"},"msg":"Slow query","attr":{"type":"command","ns":"shop.events","appName":"analytics","command":{"find":"events","filter":{"type":"buy","createdAt":{"$gt":{"$date":"2026-11-25T16:45:00Z"}}},"$db":"shop"},"planSummary":"COLLSCAN","docsExamined":300000,"nreturned":51600,"remote":"172.26.0.17:40000","durationMillis":150}}`
	e := ParseSlow([]string{line}, false)
	if len(e) != 1 || e[0].ID != ShapeID(ns, o, shape) || e[0].Shape != "" || e[0].DocsExamined != 300000 || e[0].Returned != 51600 {
		t.Fatalf("%+v", e)
	}
	// Awaitable hellos are a driver's monitor, never an operation.
	if !awaitable(bson.M{"command": bson.M{"hello": 1, "maxAwaitTimeMS": 10000}}) {
		t.Fatal("hello not left out")
	}
}

func TestFieldsOf(t *testing.T) {
	got := FieldsOf("{createdAt: {$gt: ?}, type: ?} sort {createdAt, user}")
	if !reflect.DeepEqual(got, []string{"createdAt", "type", "user"}) {
		t.Fatalf("%v", got)
	}
	if got := FieldsOf("[{$match: {status: ?}}, {$group: {_id: ?, n: {$sum: ?}}}]"); !reflect.DeepEqual(got, []string{"status", "_id", "n"}) {
		t.Fatalf("%v", got)
	}
}

func TestRedundant(t *testing.T) {
	ixs := []Index{
		{Name: "_id_", Key: []string{"_id:1"}},
		{Name: "customer_1", Key: []string{"customer:1"}},
		{Name: "customer_1_createdAt_-1", Key: []string{"customer:1", "createdAt:-1"}},
		{Name: "sku_1", Key: []string{"sku:1"}, Unique: true},
		{Name: "sku_1_name_1", Key: []string{"sku:1", "name:1"}},
		{Name: "total_-1", Key: []string{"total:-1"}},
		{Name: "total_1_x_1", Key: []string{"total:1", "x:1"}},
		{Name: "kind_1", Key: []string{"kind:1"}, Special: true},
		{Name: "kind_1_at_1", Key: []string{"kind:1", "at:1"}},
	}
	got := Redundant(ixs)
	want := map[string]string{"customer_1": "customer_1_createdAt_-1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
}

func TestFCVBehind(t *testing.T) {
	for _, c := range []struct {
		fcv, v string
		want   bool
	}{{"8.0", "8.0.38", false}, {"7.0", "8.0.4", true}, {"6.0", "6.0.28", false}, {"7.0", "7.3.1", true}} {
		if FCVBehind(c.fcv, c.v) != c.want {
			t.Errorf("%s on %s", c.fcv, c.v)
		}
	}
}

func TestMergeShapes(t *testing.T) {
	rows := []map[string]any{
		{"shape": "a", "calls": 3.0, "examined": 10.0, "keys": 0.0, "returned": 1.0, "collscan": false, "plan": "IXSCAN"},
		{"shape": "b", "calls": 9.0, "examined": 1.0, "keys": 1.0, "returned": 1.0, "collscan": false, "plan": ""},
		{"shape": "a", "calls": 2.0, "examined": 5.0, "keys": 0.0, "returned": 1.0, "collscan": true, "plan": "COLLSCAN"},
	}
	got := MergeShapes(rows)
	if len(got) != 2 || got[0]["shape"] != "b" || got[1]["calls"] != 5.0 || got[1]["collscan"] != true || got[1]["plan"] != "COLLSCAN" {
		t.Fatalf("%v", got)
	}
}

func TestCountShapesTopAndHistory(t *testing.T) {
	st := &slowState{}
	at := time.Now()
	e := []slowEntry{{ID: "x", NS: "shop.events", Op: "find", Millis: 150, DocsExamined: 300000, Returned: 10, At: at},
		{ID: "c", NS: "shop.orders", Op: "", Millis: 900, At: at}}
	st.countShapes(e, false) // the first scrape: history, not counted
	if st.shapes["x"].calls != 0 || !st.top["x"] || st.shapes["c"] != nil {
		t.Fatalf("%+v %v", st.shapes, st.top)
	}
	st.countShapes(e[:1], true)
	if a := st.shapes["x"]; a.calls != 1 || a.ms != 150 || a.examined != 300000 {
		t.Fatalf("%+v", a)
	}
}

// A $queryStats entry as the documentation gives it (Step 0's servers returned none): the
// server's own placeholders, its hash as the id, no literal anywhere.
func TestQueryStatsRow(t *testing.T) {
	d := bson.M{"queryShapeHash": "8A3C", "key": bson.M{"queryShape": bson.M{"cmdNs": bson.M{"db": "shop", "coll": "events"},
		"command": "find", "filter": bson.M{"type": bson.M{"$eq": "?string"}}}},
		"metrics": bson.M{"execCount": int64(40), "totalExecMicros": bson.M{"sum": int64(4000000)},
			"docsExamined": bson.M{"sum": int64(12000000)}, "docsReturned": bson.M{"sum": int64(400)}}}
	r, ok := QueryStatsRow(d, true)
	if !ok || r["shape"] != "8A3C" || r["ns"] != "shop.events" || r["calls"] != 40.0 || r["examined"] != 12000000.0 || r["fields"] != "type" {
		t.Fatalf("%v", r)
	}
	r, _ = QueryStatsRow(d, false)
	if _, has := r["query"]; has {
		t.Fatal("text kept with query text off")
	}
}
