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
			if !strings.Contains(r.URL.RawQuery, "family=queue_coarse_metrics") {
				t.Errorf("detailed families: %s", r.URL.RawQuery)
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
