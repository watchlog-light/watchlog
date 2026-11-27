// SPDX-License-Identifier: AGPL-3.0-only

package rabbitmq

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/integrations/promtext"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

func value(out []metrics.Sample, name string, kv ...string) (float64, bool) {
	for _, s := range out {
		if s.Name != name {
			continue
		}
		ok := true
		for i := 0; i < len(kv); i += 2 {
			found := false
			for _, l := range s.Labels {
				if l.Name == kv[i] && l.Value == kv[i+1] {
					found = true
				}
			}
			ok = ok && found
		}
		if ok {
			return s.Value, true
		}
	}
	return 0, false
}

func count(out []metrics.Sample, name string) int {
	n := 0
	for _, s := range out {
		if s.Name == name {
			n++
		}
	}
	return n
}

// A node: the real 4.1.8 output (perf-test publishing to "orders"), plus queues made
// up for the cap: 250 deep ones and one idle with messages.
func server(t *testing.T) (*httptest.Server, string) {
	metricsBody, err := os.ReadFile("testdata/rabbitmq-4.1-metrics.txt")
	if err != nil {
		t.Fatal(err)
	}
	detailedBody, err := os.ReadFile("testdata/rabbitmq-4.1-detailed.txt")
	if err != nil {
		t.Fatal(err)
	}
	var extra strings.Builder
	for i := range 250 {
		fmt.Fprintf(&extra, "rabbitmq_detailed_queue_messages_ready{vhost=\"/\",queue=\"q%03d\"} %d\n", i, 1000+i)
		fmt.Fprintf(&extra, "rabbitmq_detailed_queue_consumers{vhost=\"/\",queue=\"q%03d\"} 1\n", i)
	}
	extra.WriteString("rabbitmq_detailed_queue_messages_ready{vhost=\"/\",queue=\"invoices\"} 7\n")
	extra.WriteString("rabbitmq_detailed_queue_consumers{vhost=\"/\",queue=\"invoices\"} 0\n")
	extra.WriteString("rabbitmq_detailed_queue_exchange_messages_published_total{vhost=\"/\",exchange=\"a\",queue=\"invoices\"} 5\n")
	extra.WriteString("rabbitmq_detailed_queue_exchange_messages_published_total{vhost=\"/\",exchange=\"b\",queue=\"invoices\"} 6\n")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/metrics":
			_, _ = w.Write(metricsBody)
		case "/metrics/detailed":
			// queue_metrics and 3.13's channel families: not in this old fixture.
			if !strings.Contains(r.URL.RawQuery, "family=queue_coarse_metrics") {
				return
			}
			_, _ = w.Write(detailedBody)
			_, _ = w.Write([]byte(extra.String()))
		default:
			http.NotFound(w, r)
		}
	}))
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	return srv, port
}

func amqp(t *testing.T) (net.Listener, string) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	return ln, ln.Addr().String()
}

func TestNodeAndQueues(t *testing.T) {
	srv, port := server(t)
	defer srv.Close()
	ln, addr := amqp(t)
	defer func() { _ = ln.Close() }()
	r := New()
	r.Port = port
	target := integrations.Target{ID: "s", Members: []integrations.Member{{Name: "rabbit-0", Address: addr}}}

	// A light scrape: the node's totals, no queues yet.
	res := r.Scrape(context.Background(), target, false)
	if res.State != integrations.StateOK || res.ServiceVersion != "4.1.8" {
		t.Fatalf("%s %q %s", res.State, res.ServiceVersion, res.Error)
	}
	if v, ok := value(res.Samples, "rabbitmq_queue_messages_unacked", "member", "rabbit-0"); !ok || v <= 0 {
		t.Errorf("unacked = %v %v", v, ok)
	}
	if _, ok := value(res.Samples, "rabbitmq_resident_memory_limit_bytes"); !ok {
		t.Error("no memory watermark")
	}
	// Each node series once: the global counters come split by protocol and queue type
	// (6 lines each in 4.1) and are summed, never sent as several values of one series.
	seen := map[string]int{}
	for _, s := range res.Samples {
		seen[s.SeriesKey()]++
	}
	for k, n := range seen {
		if n > 1 {
			t.Errorf("%d samples of one series %q", n, k)
		}
	}
	if v, _ := value(res.Samples, "rabbitmq_global_messages_delivered_total"); v != 5962 {
		t.Errorf("delivered = %v, want 5962 (the sum over protocols and queue types)", v)
	}
	if count(res.Samples, "rabbitmq_detailed_queue_messages_ready") != 0 {
		t.Error("queues before a heavy scrape")
	}
	nodes := res.Extra["rabbitmq"].([]map[string]any)
	if nodes[0]["node"] != "rabbit@m-rabbit" || nodes[0]["plugin"] != true {
		t.Errorf("node %v", nodes[0])
	}

	// The heavy scrape: the 200 deepest queues, and the idle one with messages; the
	// exchange summed away.
	res = r.Scrape(context.Background(), target, true)
	if n := count(res.Samples, "rabbitmq_detailed_queue_messages_ready"); n != TopQueues+1 {
		t.Errorf("%d queues kept, want %d", n, TopQueues+1)
	}
	if v, _ := value(res.Samples, "rabbitmq_detailed_queue_messages_ready", "queue", "q249"); v != 1249 {
		t.Errorf("deepest = %v", v)
	}
	if _, ok := value(res.Samples, "rabbitmq_detailed_queue_messages_ready", "queue", "q000"); ok {
		t.Error("the 201st deepest was kept")
	}
	if v, _ := value(res.Samples, "rabbitmq_detailed_queue_exchange_messages_published_total", "queue", "invoices"); v != 11 {
		t.Errorf("invoices published = %v (summed over exchanges)", v)
	}
	if _, ok := value(res.Samples, "rabbitmq_detailed_queue_consumers", "queue", "orders", "vhost", "/", "member", "rabbit-0"); !ok {
		t.Error("orders' consumers")
	}
	for _, s := range res.Samples {
		if strings.Contains(s.Name, "exchange_messages") && !strings.Contains(s.Name, "queue_exchange") ||
			s.Name == "rabbitmq_cluster_exchange_name" {
			continue // the exchange's own series
		}
		for _, l := range s.Labels {
			if l.Name == "exchange" || l.Name == "channel" {
				t.Fatalf("%s kept %s", s.Name, l.Name)
			}
		}
	}
	// The light scrapes between repeat the last queues.
	res = r.Scrape(context.Background(), target, false)
	if count(res.Samples, "rabbitmq_detailed_queue_messages_ready") != TopQueues+1 {
		t.Error("a light scrape dropped the queues")
	}
}

// The plugin off: the node answers on AMQP, :15692 doesn't. Up, and said so.
func TestPluginOff(t *testing.T) {
	ln, addr := amqp(t)
	defer func() { _ = ln.Close() }()
	r := New()
	r.Port = "1"
	res := r.Scrape(context.Background(), integrations.Target{ID: "s", Members: []integrations.Member{{Name: "rabbit-0", Address: addr}}}, true)
	if res.State != integrations.StateOK || !res.Members[0].Up {
		t.Fatalf("%+v", res)
	}
	if res.Extra["rabbitmq"].([]map[string]any)[0]["plugin"] != false || res.Facts["plugin_off"] != 1 {
		t.Errorf("extra %v facts %v", res.Extra, res.Facts)
	}
	p := r.Probe(context.Background(), integrations.Target{Members: []integrations.Member{{Name: "x", Address: "127.0.0.1:1"}}})
	if p.Code != integrations.ProbeUnreachable {
		t.Errorf("probe %+v", p)
	}
}

// A real node of each version (Step 0 of 1.1.0): a classic, a quorum and a stream queue, a
// dead-letter queue, a topic and a fanout exchange, a publisher with unroutable messages,
// a consumer that rejects and nacks some. Captured from rabbitmq:3.13.7 and 4.1.8.
func fixture(t *testing.T, v string) (*httptest.Server, string) {
	read := func(f string) []byte {
		b, err := os.ReadFile("testdata/rabbitmq-" + v + "-" + f + ".txt")
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	m, d, q, c := read("metrics"), read("detailed"), read("queue-metrics"), read("channels")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/metrics":
			_, _ = w.Write(m)
		case strings.Contains(r.URL.RawQuery, "family=queue_coarse_metrics"):
			_, _ = w.Write(d)
		case strings.Contains(r.URL.RawQuery, "family=channel_queue_metrics"):
			_, _ = w.Write(c)
		case strings.Contains(r.URL.RawQuery, "family=queue_metrics"):
			_, _ = w.Write(q)
		default:
			http.NotFound(w, r)
		}
	}))
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	return srv, port
}

func TestBothVersions(t *testing.T) {
	for _, v := range []string{"3.13", "4.1.8"} {
		t.Run(v, func(t *testing.T) {
			srv, port := fixture(t, v)
			defer srv.Close()
			ln, addr := amqp(t)
			defer func() { _ = ln.Close() }()
			r := New()
			r.Port = port
			res := r.Scrape(context.Background(), integrations.Target{ID: "s", Members: []integrations.Member{{Name: "rabbit-0", Address: addr}}}, true)
			if res.State != integrations.StateOK {
				t.Fatal(res.Error)
			}
			// Each queue's type, from the label (4.x) or from its Raft and stream series (3.13).
			for q, want := range map[string]string{"emails.send": "classic", "orders.payments": "quorum", "orders.payments.dlq": "quorum", "audit.events": "stream"} {
				if _, ok := value(res.Samples, "rabbitmq_detailed_queue_info", "queue", q, "type", want); !ok {
					t.Errorf("%s isn't %s", q, want)
				}
			}
			// The leader is told by 4.x only.
			_, leader := value(res.Samples, "rabbitmq_detailed_queue_info", "queue", "orders.payments", "membership", "leader")
			if leader != (v == "4.1.8") {
				t.Errorf("leader known = %v", leader)
			}
			// In, acked and redelivered per queue: 4.x's own, 3.13's summed over channels.
			if v, _ := value(res.Samples, "rabbitmq_detailed_queue_messages_acked_total", "queue", "emails.send"); v <= 0 {
				t.Errorf("emails.send acked = %v", v)
			}
			if v, _ := value(res.Samples, "rabbitmq_detailed_queue_messages_redelivered_total", "queue", "orders.payments"); v <= 0 {
				t.Errorf("orders.payments redelivered = %v", v)
			}
			if v, _ := value(res.Samples, "rabbitmq_detailed_queue_exchange_messages_published_total", "queue", "audit.events"); v <= 0 {
				t.Errorf("published into the stream = %v", v)
			}
			if v, _ := value(res.Samples, "rabbitmq_detailed_queue_consumer_utilisation", "queue", "emails.send"); v <= 0 {
				t.Errorf("utilisation = %v", v)
			}
			if _, ok := value(res.Samples, "rabbitmq_detailed_raft_term_total", "queue", "orders.payments"); !ok {
				t.Error("no Raft term")
			}
			// Exchanges: names with types, and per-exchange publish and unroutable counts.
			if _, ok := value(res.Samples, "rabbitmq_cluster_exchange_name", "exchange", "orders", "type", "topic"); !ok {
				t.Error("no orders (topic)")
			}
			if v, _ := value(res.Samples, "rabbitmq_detailed_exchange_messages_published_total", "exchange", "orders"); v <= 0 {
				t.Errorf("orders published = %v", v)
			}
			if v, _ := value(res.Samples, "rabbitmq_detailed_exchange_messages_unroutable_dropped_total", "exchange", "orders"); v <= 0 {
				t.Errorf("orders dropped = %v", v)
			}
			// The node: its version, uptime; sockets on 3.13 only (4.x dropped the metric).
			if _, ok := value(res.Samples, "watchlog_rabbitmq_node_info", "version", map[string]string{"3.13": "3.13.7", "4.1.8": "4.1.8"}[v]); !ok {
				t.Error("no node info")
			}
			if _, ok := value(res.Samples, "rabbitmq_erlang_uptime_seconds"); !ok {
				t.Error("no uptime")
			}
			_, sockets := value(res.Samples, "rabbitmq_process_max_tcp_sockets")
			if sockets != (v == "3.13") {
				t.Errorf("sockets = %v", sockets)
			}
			for _, s := range res.Samples {
				for _, l := range s.Labels {
					if l.Name == "channel" {
						t.Fatalf("%s kept a channel", s.Name)
					}
				}
			}
		})
	}
}

// 3.13's per-channel sums stay monotonic: a channel that closes keeps its count in the total.
func TestFoldKeepsClosedChannels(t *testing.T) {
	f := &fold{last: map[string]float64{}, carried: map[string]float64{}}
	s := func(ch string, v float64) promtext.Sample {
		return promtext.Sample{Name: "rabbitmq_detailed_channel_messages_acked_total", Labels: map[string]string{"channel": ch, "vhost": "/", "queue": "q"}, Value: v}
	}
	total := func(in []promtext.Sample) float64 {
		for _, x := range in {
			if x.Name == "rabbitmq_detailed_queue_messages_acked_total" && x.Labels["queue"] == "q" {
				return x.Value
			}
		}
		return -1
	}
	if v := total(f.add([]promtext.Sample{s("<0.1.0>", 10), s("<0.2.0>", 5)})); v != 15 {
		t.Fatalf("first = %v", v)
	}
	// <0.1.0> closed; <0.3.0> opened.
	if v := total(f.add([]promtext.Sample{s("<0.2.0>", 7), s("<0.3.0>", 1)})); v != 18 {
		t.Fatalf("after a close = %v, want 18 (10 carried + 7 + 1)", v)
	}
	// Every channel gone: the total stays.
	if v := total(f.add(nil)); v != 18 {
		t.Fatalf("all closed = %v", v)
	}
}

// The heavy scrape of a 3.13 node: four requests, the per-channel sums and the caps.
func BenchmarkHeavy313(b *testing.B) {
	t := &testing.T{}
	srv, port := fixture(t, "3.13")
	defer srv.Close()
	ln, addr := amqp(t)
	defer func() { _ = ln.Close() }()
	r := New()
	r.Port = port
	target := integrations.Target{ID: "s", Members: []integrations.Member{{Name: "rabbit-0", Address: addr}}}
	b.ReportAllocs()
	for b.Loop() {
		r.Scrape(context.Background(), target, true)
	}
}
