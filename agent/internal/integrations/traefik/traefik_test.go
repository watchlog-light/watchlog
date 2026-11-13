// SPDX-License-Identifier: AGPL-3.0-only

package traefik

import (
	"bytes"
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

func row(res integrations.Result) map[string]any {
	return res.Extra["traefik"].([]map[string]any)[0]
}

func read(t *testing.T, name string) []byte {
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// A Traefik whose metrics live at :<metrics>/metrics, and whose API answers
// /api/version on another port; traffic is the member's own address.
func serve(t *testing.T, body []byte) (tr *Traefik, member integrations.Member) {
	t.Helper()
	m := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/metrics" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(m.Close)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/version" {
			_, _ = w.Write([]byte(`{"Version":"3.6.25","Codename":"ramequin"}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(api.Close)
	traffic := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(traffic.Close)
	tr = New()
	tr.Ports = []string{"1", portOf(t, api), portOf(t, m)} // refused, a 404, then metrics
	tr.APIPort = portOf(t, api)
	return tr, integrations.Member{Name: "traefik-5cf77f8d77-w6qdr", Address: "127.0.0.1:" + portOf(t, traffic)}
}

// The real :9100/metrics of Traefik 3.6.25 on kind (an Ingress and an IngressRoute
// behind TLS), summed to the kept labels, Traefik's service renamed.
func TestKubernetes(t *testing.T) {
	tr, m := serve(t, read(t, "traefik-3.6-kubernetes.txt"))
	res := tr.Scrape(context.Background(), integrations.Target{ID: "s", Members: []integrations.Member{m}}, false)
	if res.State != integrations.StateOK || res.Product != "traefik" || res.ServiceVersion != "3.6.25" {
		t.Fatalf("state %s product %q version %q: %s", res.State, res.Product, res.ServiceVersion, res.Error)
	}
	r := row(res)
	if r["metrics"] != true || !strings.HasSuffix(r["metrics_at"].(string), "/metrics") || r["major"] != "3" ||
		r["routers"] != false || r["health_checks"] != false || r["tried"] != "" {
		t.Errorf("extra %v", r)
	}
	if v, ok := value(res.Samples, "traefik_service_requests_total", "traefik_service", "traefik-e2e-api-9898@kubernetes", "code", "200", "member", m.Name); !ok || v <= 0 {
		t.Errorf("api 200s = %v %v", v, ok)
	}
	if _, ok := value(res.Samples, "traefik_service_requests_total", "traefik_service", "traefik-e2e-shop-8c0bca002bcbea5f8d05@kubernetescrd", "code", "404"); !ok {
		t.Error("the IngressRoute's service")
	}
	if v, ok := value(res.Samples, "traefik_entrypoint_requests_tls_total", "entrypoint", "websecure"); !ok || v <= 0 {
		t.Errorf("TLS requests = %v %v", v, ok)
	}
	if _, ok := value(res.Samples, "traefik_open_connections", "entrypoint", "web"); !ok {
		t.Error("open connections")
	}
	for _, s := range res.Samples {
		for _, l := range s.Labels {
			switch l.Name {
			case "service", "method", "protocol", "tls_cipher", "tls_version":
				t.Fatalf("%s kept %s", s.Name, l.Name)
			}
			if strings.HasSuffix(l.Value, "@internal") {
				t.Fatalf("internal service kept: %v", s)
			}
		}
	}
}

// Buckets are summed over codes: +Inf is every request of the entrypoint.
func TestBucketsSummedOverCodes(t *testing.T) {
	p, found := Parse(bytes.NewReader(read(t, "traefik-3.6-kubernetes.txt")))
	if !found {
		t.Fatal("no traefik_ series")
	}
	var reqs float64
	for _, s := range p.samples {
		if s.Name == "traefik_entrypoint_requests_total" && hasLabel(s, "entrypoint", "web") {
			reqs += s.Value
		}
	}
	inf, ok := value(p.samples, "traefik_entrypoint_request_duration_seconds_bucket", "entrypoint", "web", "le", "+Inf")
	if !ok || inf != reqs {
		t.Errorf("+Inf %v, requests %v", inf, reqs)
	}
}

func hasLabel(s metrics.Sample, k, v string) bool {
	for _, l := range s.Labels {
		if l.Name == k && l.Value == v {
			return true
		}
	}
	return false
}

// Docker with a health check: server_up with the server's URL, a Compose service named
// <service>-<project>@docker, and the internal services dropped.
func TestDockerHealthChecks(t *testing.T) {
	body := append(read(t, "traefik-3.6-docker.txt"),
		[]byte("traefik_service_requests_total{code=\"200\",method=\"GET\",protocol=\"http\",service=\"api@internal\"} 3\n"+
			"traefik_router_requests_total{code=\"503\",method=\"GET\",protocol=\"http\",router=\"api@docker\",service=\"api@docker\"} 4\n"+
			"traefik_tls_certs_not_after{cn=\"shop.example.com\",serial=\"1\",sans=\"shop.example.com,www.example.com\"} 1.8e+09\n")...)
	tr, m := serve(t, body)
	res := tr.Scrape(context.Background(), integrations.Target{Members: []integrations.Member{m}}, false)
	r := row(res)
	if r["health_checks"] != true || r["routers"] != true {
		t.Errorf("extra %v", r)
	}
	if v, ok := value(res.Samples, "traefik_service_server_up", "traefik_service", "api@docker", "url", "http://172.24.0.3:9898"); !ok || v != 1 {
		t.Errorf("server_up = %v %v", v, ok)
	}
	if _, ok := value(res.Samples, "traefik_service_requests_total", "traefik_service", "web-traefik-e2e@docker"); !ok {
		t.Error("the Compose service's default name")
	}
	if _, ok := value(res.Samples, "traefik_router_requests_total", "router", "api@docker", "traefik_service", "api@docker", "code", "503"); !ok {
		t.Error("router requests")
	}
	if _, ok := value(res.Samples, "traefik_service_requests_total", "traefik_service", "api@internal"); ok {
		t.Error("api@internal kept")
	}
	for _, s := range res.Samples {
		if s.Name == "traefik_tls_certs_not_after" && (len(s.Labels) != 2 || !hasLabel(s, "cn", "shop.example.com")) {
			t.Errorf("certificate labels %v", s.Labels)
		}
	}
}

// Traefik 2.11: open connections by entrypoint under v2's name, written as v3's; the
// reload failure series kept.
func TestTraefik2(t *testing.T) {
	p, found := Parse(bytes.NewReader(read(t, "traefik-2.11.txt")))
	if !found || p.major != "2" {
		t.Fatalf("found %v major %q", found, p.major)
	}
	if _, ok := value(p.samples, "traefik_open_connections", "entrypoint", "web"); !ok {
		t.Error("v2 open connections not renamed")
	}
	if _, ok := value(p.samples, "traefik_entrypoint_open_connections"); ok {
		t.Error("v2 name kept")
	}
	if _, ok := value(p.samples, "traefik_config_last_reload_failure"); !ok {
		t.Error("last reload failure")
	}
}

// Metrics off: every place says what it answered, and the search is repeated only
// after EarlyRecheck while the member is new.
func TestMetricsOff(t *testing.T) {
	var hits atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte("# TYPE go_goroutines gauge\ngo_goroutines 81\n"))
	}))
	defer other.Close()
	traffic := httptest.NewServer(http.NotFoundHandler())
	defer traffic.Close()
	now := time.Unix(1_800_000_000, 0)
	tr := New()
	tr.Now = func() time.Time { return now }
	tr.Ports = []string{portOf(t, other)}
	tr.APIPort = "1"
	tg := integrations.Target{Members: []integrations.Member{{Name: "bare", Address: "127.0.0.1:" + portOf(t, traffic)}}}
	res := tr.Scrape(context.Background(), tg, false)
	r := row(res)
	if res.State != integrations.StateOK || r["metrics"] != false || !strings.Contains(r["tried"].(string), "/metrics: no traefik_ series") {
		t.Fatalf("state %s extra %v", res.State, r)
	}
	tr.Scrape(context.Background(), tg, false)
	if hits.Load() != 1 {
		t.Errorf("searched again too soon: %d", hits.Load())
	}
	now = now.Add(EarlyRecheck + time.Second)
	tr.Scrape(context.Background(), tg, false)
	if hits.Load() != 2 {
		t.Errorf("not searched again after EarlyRecheck: %d", hits.Load())
	}
}

func TestUnreachable(t *testing.T) {
	res := New().Scrape(context.Background(), integrations.Target{Members: []integrations.Member{{Name: "x", Address: "127.0.0.1:1"}}}, false)
	if res.State != integrations.StateError || res.Error == "" {
		t.Errorf("state %s error %q", res.State, res.Error)
	}
	res = New().Scrape(context.Background(), integrations.Target{}, false)
	if res.State != integrations.StateError {
		t.Errorf("no member: %s", res.State)
	}
}

func BenchmarkParse(b *testing.B) {
	body, err := os.ReadFile("testdata/traefik-3.6-docker.txt")
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		if _, ok := Parse(bytes.NewReader(body)); !ok {
			b.Fatal("no series")
		}
	}
}
