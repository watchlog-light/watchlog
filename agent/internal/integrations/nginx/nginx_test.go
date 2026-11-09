// SPDX-License-Identifier: AGPL-3.0-only

package nginx

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

const stubPage = "Active connections: 3 \nserver accepts handled requests\n 120 118 455 \nReading: 0 Writing: 1 Waiting: 2 \n"

func portOf(t *testing.T, srv *httptest.Server) string {
	_, p, err := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

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

// ingress-nginx: the real :10254 output of controller 1.12.1 (with --enable-metrics),
// summed to the kept labels; the default certificate dropped; the version from
// build_info.
func TestIngressNginx(t *testing.T) {
	body, err := os.ReadFile("testdata/ingress-nginx-1.12.txt")
	if err != nil {
		t.Fatal(err)
	}
	ctrl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz":
			_, _ = w.Write([]byte("ok"))
		case "/metrics":
			_, _ = w.Write(body)
		default:
			http.NotFound(w, r)
		}
	}))
	defer ctrl.Close()
	traffic := httptest.NewServer(http.NotFoundHandler()) // the controller's :80
	defer traffic.Close()
	n := New()
	n.MetricsPort = portOf(t, ctrl)
	res := n.Scrape(context.Background(), integrations.Target{ID: "s", Members: []integrations.Member{
		{Name: "ingress-nginx-controller-1", Address: "127.0.0.1:" + portOf(t, traffic)},
	}}, false)
	if res.State != integrations.StateOK || res.Product != "ingress-nginx" || res.ServiceVersion != "1.12.1" {
		t.Fatalf("state %s product %q version %q: %s", res.State, res.Product, res.ServiceVersion, res.Error)
	}
	if info(res)["flavour"] != "ingress" || info(res)["metrics"] != true {
		t.Errorf("extra %v", info(res))
	}
	edge := []string{"ingress_namespace", "nginx-e2e", "ingress", "shop", "backend", "api"}
	if v, ok := value(res.Samples, "nginx_ingress_controller_requests", append(edge, "status", "503")...); !ok || v != 1 {
		t.Errorf("503s = %v %v", v, ok)
	}
	if v, ok := value(res.Samples, "nginx_ingress_controller_requests", append(edge, "status", "200")...); !ok || v < 5 {
		t.Errorf("200s = %v %v", v, ok)
	}
	// Buckets summed over statuses: +Inf is every request of that backend.
	if v, ok := value(res.Samples, "nginx_ingress_controller_request_duration_seconds_bucket", append(edge, "le", "+Inf")...); !ok || v < 6 {
		t.Errorf("+Inf = %v %v", v, ok)
	}
	for _, s := range res.Samples {
		for _, l := range s.Labels {
			if l.Name == "path" || l.Name == "method" || l.Name == "controller_pod" || l.Name == "canary" ||
				l.Name == "service" || l.Name == "namespace" || l.Name == "host" {
				t.Fatalf("%s kept %s", s.Name, l.Name)
			}
		}
		if s.Name == "nginx_ingress_controller_ssl_expire_time_seconds" {
			t.Errorf("the default certificate was kept: %v", s.Labels)
		}
	}
	if _, ok := value(res.Samples, "nginx_ingress_controller_nginx_process_connections", "state", "waiting"); !ok {
		t.Error("connections by state")
	}
}

// A controller without --enable-metrics still answers /healthz and /metrics (Go's
// own): it is ingress-nginx, with its metrics off.
func TestIngressNginxMetricsOff(t *testing.T) {
	ctrl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			_, _ = w.Write([]byte("ok"))
			return
		}
		_, _ = w.Write([]byte("# TYPE go_goroutines gauge\ngo_goroutines 81\n"))
	}))
	defer ctrl.Close()
	traffic := httptest.NewServer(http.NotFoundHandler())
	defer traffic.Close()
	n := New()
	n.MetricsPort = portOf(t, ctrl)
	res := n.Scrape(context.Background(), integrations.Target{Members: []integrations.Member{{Name: "c", Address: "127.0.0.1:" + portOf(t, traffic)}}}, false)
	if info(res)["flavour"] != "ingress" || info(res)["metrics"] != false {
		t.Errorf("extra %v", info(res))
	}
}

// Plain Nginx: no request on its main port beyond the stub_status search, which
// finds /nginx_status on the stub port and is remembered; a member without it is
// counted, and looked for again only after Recheck.
func TestPlainNginxStubStatus(t *testing.T) {
	var mainHits atomic.Int32
	main := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mainHits.Add(1)
		http.NotFound(w, r)
	}))
	defer main.Close()
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/nginx_status" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Server", "nginx/1.27.3")
		_, _ = w.Write([]byte(stubPage))
	}))
	defer stub.Close()
	n := New()
	n.MetricsPort = "1" // nothing listens: not ingress-nginx
	n.StubPort = portOf(t, stub)
	now := time.Unix(1_800_000_000, 0)
	n.Now = func() time.Time { return now }
	target := integrations.Target{Members: []integrations.Member{{Name: "web-1", Address: "127.0.0.1:" + portOf(t, main)}}}
	res := n.Scrape(context.Background(), target, false)
	if info(res)["flavour"] != "plain" || info(res)["stub_status"] != ":"+n.StubPort+"/nginx_status" || res.ServiceVersion != "1.27.3" {
		t.Fatalf("extra %v version %q", info(res), res.ServiceVersion)
	}
	if v, _ := value(res.Samples, "watchlog_nginx_connections", "state", "waiting", "member", "web-1"); v != 2 {
		t.Errorf("waiting = %v", v)
	}
	if v, _ := value(res.Samples, "watchlog_nginx_connections_accepted_total"); v != 120 {
		t.Errorf("accepted = %v", v)
	}
	searched := mainHits.Load() // /stub_status and /nginx_status on the main port
	n.Scrape(context.Background(), target, false)
	if mainHits.Load() != searched {
		t.Errorf("the main port was asked again once stub_status was found")
	}

	// Without stub_status anywhere: reported, and not searched again until Recheck.
	stub.Close()
	n2 := New()
	n2.MetricsPort, n2.StubPort, n2.Now = "1", "1", n.Now
	mainHits.Store(0)
	res = n2.Scrape(context.Background(), target, false)
	if info(res)["stub_status"] != "" || info(res)["stub_missing"] != 1 || res.State != integrations.StateOK ||
		!strings.Contains(info(res)["stub_tried"].(string), "/stub_status: 404") {
		t.Fatalf("extra %v state %s", info(res), res.State)
	}
	first := mainHits.Load()
	n2.Scrape(context.Background(), target, false)
	if mainHits.Load() != first {
		t.Errorf("searched again at once")
	}
	// New: again after a minute; after its first 10 minutes, every 10 minutes.
	now = now.Add(EarlyRecheck + time.Second)
	n2.Scrape(context.Background(), target, false)
	if mainHits.Load() == first {
		t.Errorf("not searched again after EarlyRecheck")
	}
	now = now.Add(Recheck + time.Second) // past its first 10 minutes, and due
	n2.Scrape(context.Background(), target, false)
	settled := mainHits.Load()
	now = now.Add(2 * EarlyRecheck)
	n2.Scrape(context.Background(), target, false)
	if mainHits.Load() != settled {
		t.Errorf("searched every minute after its first 10 minutes")
	}
	now = now.Add(Recheck)
	n2.Scrape(context.Background(), target, false)
	if mainHits.Load() == settled {
		t.Errorf("not searched again after Recheck")
	}
}

// info is the one row the status's extra carries.
func info(res integrations.Result) map[string]any {
	return res.Extra["nginx"].([]map[string]any)[0]
}

func TestParseStubRejectsOtherPages(t *testing.T) {
	for _, page := range []string{"<html>404</html>", "Active connections: x\na\nb\nc", ""} {
		if _, err := ParseStub(strings.NewReader(page)); err == nil {
			t.Errorf("accepted %q", page)
		}
	}
}

func TestUnreachable(t *testing.T) {
	n := New()
	res := n.Scrape(context.Background(), integrations.Target{Members: []integrations.Member{{Name: "x", Address: "127.0.0.1:1"}}}, false)
	if res.State != integrations.StateError || res.Members[0].Up {
		t.Errorf("%+v", res)
	}
	p := n.Probe(context.Background(), integrations.Target{Members: []integrations.Member{{Name: "x", Address: "127.0.0.1:1"}}})
	if p.Code != integrations.ProbeUnreachable {
		t.Errorf("probe %+v", p)
	}
}
