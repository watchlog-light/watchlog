// SPDX-License-Identifier: AGPL-3.0-only

package mongodb

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// "Slow query" lines as MongoDB 7.0.48 and 8.0.38 log them (measured on the e2e VM; the
// session ids and cluster-time signatures cut out).
var slowLines = []string{
	// 8.0: a find, with its queryShapeHash.
	`{"t":{"$date":"2026-11-13T00:30:57.600+00:00"},"s":"I","c":"COMMAND","id":51803,"ctx":"conn43","msg":"Slow query","attr":{"type":"command","isFromUserConnection":true,"ns":"shop.events","collectionType":"normal","appName":"mongosh 2.14.2","queryShapeHash":"C117D0022998A24F","command":{"find":"events","filter":{"kind":"refund","amount":{"$gt":90}},"sort":{"at":-1},"$db":"shop"},"planSummary":"COLLSCAN","keysExamined":0,"docsExamined":200000,"remote":"10.244.2.38:58016","durationMillis":37}}`,
	// 7.0: an aggregate.
	`{"t":{"$date":"2026-11-13T00:30:57.093+00:00"},"s":"I","c":"COMMAND","id":51803,"ctx":"conn37","msg":"Slow query","attr":{"type":"command","ns":"shop.events","appName":"mongosh 2.14.2","command":{"aggregate":"events","pipeline":[{"$match":{"kind":"view"}},{"$group":{"_id":"$amount","n":{"$sum":1}}}],"cursor":{},"$db":"shop"},"planSummary":"COLLSCAN","docsExamined":200000,"remote":"127.0.0.1:57972","protocol":"op_msg","durationMillis":48}}`,
	// 7.0: an update logs twice, its own line and the command's on shop.$cmd.
	`{"t":{"$date":"2026-11-13T00:30:57.136+00:00"},"s":"I","c":"WRITE","id":51803,"ctx":"conn37","msg":"Slow query","attr":{"type":"update","ns":"shop.events","appName":"mongosh 2.14.2","command":{"q":{"kind":"cart","amount":{"$lt":3}},"u":{"$set":{"note":"y"}},"multi":true,"upsert":false},"planSummary":"COLLSCAN","remote":"127.0.0.1:57972","durationMillis":41}}`,
	`{"t":{"$date":"2026-11-13T00:30:57.136+00:00"},"s":"I","c":"COMMAND","id":51803,"ctx":"conn37","msg":"Slow query","attr":{"type":"command","ns":"shop.$cmd","appName":"mongosh 2.14.2","command":{"update":"events","updates":[{"q":{"kind":"cart","amount":{"$lt":3}},"u":{"$set":{"note":"y"}},"multi":true}],"ordered":true,"$db":"shop"},"remote":"127.0.0.1:57972","durationMillis":41}}`,
	// A getMore: the shape is its originating find's.
	`{"t":{"$date":"2026-11-13T00:31:35.000+00:00"},"s":"I","c":"COMMAND","id":51803,"ctx":"conn40","msg":"Slow query","attr":{"type":"command","ns":"shop.events","command":{"getMore":1234,"collection":"events","$db":"shop"},"originatingCommand":{"find":"events","filter":{"_id":{"$oid":"6553a7c2e4b0c8a1d2f3e4a5"},"tags":{"$in":["a","b"]}},"$db":"shop"},"planSummary":"COLLSCAN","remote":"10.244.1.9:40000","durationMillis":34}}`,
	// The server's own work on a secondary (no client), and WatchLog's own reads.
	`{"t":{"$date":"2026-11-13T00:32:13.000+00:00"},"s":"I","c":"COMMAND","id":51803,"ctx":"ReplWriterWorker-0","msg":"Slow query","attr":{"ns":"shop.events","durationMillis":157}}`,
	`{"t":{"$date":"2026-11-13T00:32:14.000+00:00"},"s":"I","c":"COMMAND","id":51803,"ctx":"conn9","msg":"Slow query","attr":{"type":"command","ns":"shop.events","appName":"watchlog","command":{"aggregate":"events","pipeline":[{"$collStats":{"storageStats":{}}}]},"remote":"10.244.0.5:1234","durationMillis":30}}`,
	`{"t":{"$date":"2026-11-13T00:32:15.000+00:00"},"s":"I","c":"NETWORK","id":22943,"ctx":"listener","msg":"Connection accepted","attr":{"remote":"10.244.0.5:1234"}}`,
}

func TestParseSlow(t *testing.T) {
	got := ParseSlow(slowLines, true)
	type row struct{ op, ns, shape, remote string }
	var rows []row
	for _, e := range got {
		rows = append(rows, row{e.Op, e.NS, e.Shape, e.Remote})
		if !e.Collscan {
			t.Errorf("%s: COLLSCAN not marked", e.Op)
		}
	}
	want := []row{
		{"find", "shop.events", "{amount: {$gt: ?}, kind: ?} sort {at}", "10.244.2.38"},
		{"aggregate", "shop.events", "[{$match: {kind: ?}}, {$group: {_id: ?, n: {$sum: ?}}}]", "127.0.0.1"},
		{"update", "shop.events", "{amount: {$lt: ?}, kind: ?}", "127.0.0.1"},
		{"find", "shop.events", "{_id: ?, tags: {$in: ?}}", "10.244.1.9"},
	}
	if !reflect.DeepEqual(rows, want) {
		t.Errorf("ParseSlow:\n got %+v\nwant %+v", rows, want)
	}
	if got[0].Hash != "C117D0022998A24F" || got[0].Millis != 37 || !got[0].At.Equal(time.Date(2026, 11, 13, 0, 30, 57, 600e6, time.UTC)) {
		t.Errorf("first entry: %+v", got[0])
	}
	// Without the query-text switch, no shape at all.
	for _, e := range ParseSlow(slowLines, false) {
		if e.Shape != "" {
			t.Errorf("shape kept with the switch off: %q", e.Shape)
		}
	}
}

// No literal survives a shape: strings, numbers, typed values, arrays of values.
func TestShapeHasNoLiterals(t *testing.T) {
	var cmd map[string]json.RawMessage
	_ = json.Unmarshal([]byte(`{"find":"users","filter":{"email":"a@example.com","age":{"$gte":30},"$or":[{"name":"bob"},{"token":{"$regex":"^sk_live"}}],"at":{"$date":"2026-01-01T00:00:00Z"}}}`), &cmd)
	op, shape := Shape(cmd)
	if op != "find" || shape != "{$or: [{name: ?}, {token: {$regex: ?}}], age: {$gte: ?}, at: ?, email: ?}" {
		t.Errorf("Shape = %q, %q", op, shape)
	}
}

// serverStatus's histogram: lower bounds in microseconds (measured: 0, 8, 16, 32 … with
// counts), summed into ≤1 ms, ≤10 ms, ≤100 ms, ≤1 s, ≤10 s, >10 s.
func TestBuckets(t *testing.T) {
	h := bson.A{
		bson.M{"micros": int64(0), "count": int64(5)}, bson.M{"micros": int64(16), "count": int64(120)},
		bson.M{"micros": int64(512), "count": int64(10)}, bson.M{"micros": int64(2048), "count": int64(4)},
		bson.M{"micros": int64(65536), "count": int64(3)}, bson.M{"micros": int64(1048576), "count": int64(2)},
		bson.M{"micros": int64(33554432), "count": int64(1)},
	}
	want := []float64{135, 4, 3, 0, 2, 1}
	if got := Buckets(h); !reflect.DeepEqual(got, want) {
		t.Errorf("Buckets = %v, want %v", got, want)
	}
}

// replSetGetStatus as 8.0 reports a primary, a secondary 4 s behind, and a member down.
func TestMembers(t *testing.T) {
	at := time.Date(2026, 11, 13, 0, 30, 57, 0, time.UTC)
	st := bson.M{"set": "rs0", "members": bson.A{
		bson.M{"name": "mongo-0.mongo.mongodb-e2e.svc.cluster.local:27017", "stateStr": "PRIMARY", "health": 1.0, "optimeDate": bson.NewDateTimeFromTime(at), "self": true, "uptime": int64(225)},
		bson.M{"name": "mongo-1.mongo.mongodb-e2e.svc.cluster.local:27017", "stateStr": "SECONDARY", "health": 1.0, "optimeDate": bson.NewDateTimeFromTime(at.Add(-4 * time.Second)), "uptime": int64(222)},
		bson.M{"name": "mongodb-e2e-mongo-b-1:27017", "stateStr": "(not reachable/healthy)", "health": 0.0, "optimeDate": bson.NewDateTimeFromTime(time.Unix(0, 0))},
	}}
	m := Members(st)
	if len(m) != 3 || m[0].State != "PRIMARY" || m[1].Lag != 4 || m[2].Health != 0 || m[2].Lag != 0 {
		t.Errorf("Members = %+v", m)
	}
	for in, want := range map[string]string{
		"mongo-0.mongo.mongodb-e2e.svc.cluster.local:27017": "mongo-0",
		"mongodb-e2e-mongo-1:27017":                         "mongodb-e2e-mongo-1",
		"10.0.0.7:27017":                                    "10.0.0.7",
	} {
		if got := ShortHost(in); got != want {
			t.Errorf("ShortHost(%q) = %q, want %q", in, got, want)
		}
	}
}

// connectionStatus's roles: the generated user (clusterMonitor), root, and an app user.
func TestParseRoles(t *testing.T) {
	gen := ParseRoles([]bson.M{{"role": "clusterMonitor", "db": "admin"}}, true)
	if !gen.Monitor || len(gen.Excess) != 0 {
		t.Errorf("generated user: %+v", gen)
	}
	root := ParseRoles([]bson.M{{"role": "root", "db": "admin"}}, true)
	if !root.Monitor || !reflect.DeepEqual(root.Excess, []string{"root"}) {
		t.Errorf("root: %+v", root)
	}
	app := ParseRoles([]bson.M{{"role": "readWrite", "db": "shop"}}, true)
	if app.Monitor || !reflect.DeepEqual(app.Excess, []string{"readWrite@shop"}) {
		t.Errorf("app: %+v", app)
	}
	if off := ParseRoles(nil, false); !off.Monitor {
		t.Errorf("authentication off: %+v", off)
	}
}

// getLog returns up to 1,024 lines each scrape: parsing them must stay cheap (ADR-131's
// 5 % of a core).
func BenchmarkParseSlow(b *testing.B) {
	lines := make([]string, 0, 1024)
	for len(lines) < 1024 {
		lines = append(lines, slowLines...)
	}
	lines = lines[:1024]
	b.ReportAllocs()
	for b.Loop() {
		ParseSlow(lines, true)
	}
}
