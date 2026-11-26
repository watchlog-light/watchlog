// SPDX-License-Identifier: AGPL-3.0-only

package ownmetrics

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/ext"
)

const text = `# HELP orders_created_total Orders created.
# TYPE orders_created_total counter
orders_created_total{method="card",status="ok"} 1027
orders_created_total{method="paypal",status="ok"} 12 1795000000000
# TYPE checkout_duration_seconds histogram
checkout_duration_seconds_bucket{step="cart",le="0.5"} 90
checkout_duration_seconds_bucket{step="cart",le="+Inf"} 100
checkout_duration_seconds_sum{step="cart"} 31.5
checkout_duration_seconds_count{step="cart"} 100
# TYPE queue_jobs_waiting gauge
queue_jobs_waiting{queue="emails"} 12
broken line without a value
nan_value NaN
escaped{path="a\"b\\c\nd"} 1
`

func TestParseText(t *testing.T) {
	s, err := Parse(strings.NewReader(text))
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Series) != 8 {
		t.Fatalf("series %d, want 8: %+v", len(s.Series), s.Series)
	}
	if s.Types["orders_created_total"] != "counter" || s.Types["checkout_duration_seconds"] != "histogram" || s.Types["queue_jobs_waiting"] != "gauge" {
		t.Fatalf("types %v", s.Types)
	}
	if s.Help["orders_created_total"] != "Orders created." {
		t.Fatalf("help %v", s.Help)
	}
	if s.Series[1].Value != 12 || s.Series[1].Labels["method"] != "paypal" {
		t.Fatalf("a sample with a timestamp: %+v", s.Series[1])
	}
	if s.Series[3].Labels["le"] != "+Inf" || s.Series[3].Value != 100 {
		t.Fatalf("the +Inf bucket: %+v", s.Series[3])
	}
	if got := s.Series[7].Labels["path"]; got != "a\"b\\c\nd" {
		t.Fatalf("escapes: %q", got)
	}
}

func TestParseOpenMetrics(t *testing.T) {
	om := `# TYPE orders_created counter
# HELP orders_created Orders created.
orders_created_total{method="card"} 1027 # {trace_id="abc"} 1 1795000000.1
orders_created_created{method="card"} 1795000000.0
# TYPE build info
build_info{version="2.15.0"} 1
# EOF
`
	s, err := Parse(strings.NewReader(om))
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Series) != 2 || s.Series[0].Name != "orders_created_total" || s.Series[0].Value != 1027 {
		t.Fatalf("series %+v", s.Series)
	}
	// The counter's family carries no _total in OpenMetrics; the series' name gets the type.
	if s.Types["orders_created_total"] != "counter" || s.Help["orders_created_total"] == "" {
		t.Fatalf("types %v help %v", s.Types, s.Help)
	}
	if _, ok := s.Types["build"]; ok {
		t.Fatal("an info family is sent without a type")
	}
}

func TestParseBounds(t *testing.T) {
	var b strings.Builder
	for i := 0; i < MaxSeries+25; i++ {
		fmt.Fprintf(&b, "m{i=\"%d\"} 1\n", i)
	}
	s, _ := Parse(strings.NewReader(b.String()))
	if len(s.Series) != MaxSeries || !s.Truncated {
		t.Fatalf("series %d truncated %v", len(s.Series), s.Truncated)
	}
	if s, _ := Parse(strings.NewReader("\x00\x01 not metrics at all <html>")); len(s.Series) != 0 {
		t.Fatalf("garbage parsed as %+v", s.Series)
	}
}

func TestFetchLimits(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept"), "openmetrics") || r.Header.Get("Authorization") != "" {
			t.Errorf("headers %v", r.Header)
		}
		_, _ = w.Write([]byte(text))
	})
	mux.HandleFunc("/big", func(w http.ResponseWriter, _ *http.Request) {
		line := []byte("big_metric{x=\"" + strings.Repeat("y", 1000) + "\"} 1\n")
		for n := 0; n < MaxBody+len(line); n += len(line) {
			_, _ = w.Write(line)
		}
	})
	mux.HandleFunc("/slow", func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	})
	mux.HandleFunc("/same", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/metrics", http.StatusFound) })
	mux.HandleFunc("/gone", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	other := httptest.NewServer(mux)
	defer other.Close()
	mux.HandleFunc("/away", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/metrics", http.StatusFound)
	})
	c := NewClient()
	ctx := context.Background()

	if s, err := Fetch(ctx, c, srv.URL+"/metrics"); err != nil || len(s.Series) != 8 {
		t.Fatalf("a scrape: %v, %d series", err, len(s.Series))
	}
	if s, err := Fetch(ctx, c, srv.URL+"/same"); err != nil || len(s.Series) != 8 {
		t.Fatalf("a redirect on the same host: %v", err)
	}
	for name, tc := range map[string]struct{ url, want string }{
		"too big":      {srv.URL + "/big", "larger than 5 MB"},
		"another host": {srv.URL + "/away", "another host"},
		"not found":    {srv.URL + "/gone", "answered 404"},
		"ftp":          {"ftp://127.0.0.1/metrics", "only http and https"},
		"file":         {"file:///etc/passwd", "only http and https"},
		"credentials":  {"http://user:pass@127.0.0.1:1/metrics", "user or password"},
		"refused":      {"http://127.0.0.1:1/metrics", "refused"},
	} {
		_, err := Fetch(ctx, c, tc.url)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want an error with %q", name, err, tc.want)
		}
	}
	// The 10 seconds, with a client that waits less for the test.
	quick := NewClient()
	quick.Timeout = 200 * time.Millisecond
	if _, err := Fetch(ctx, quick, srv.URL+"/slow"); err == nil || !strings.Contains(err.Error(), "no answer within") {
		t.Errorf("a slow endpoint: %v", err)
	}
}

type fakeHost struct {
	mu    sync.Mutex
	cfg   json.RawMessage
	posts map[string][]json.RawMessage
	ch    chan struct{}
}

func (f *fakeHost) Config() json.RawMessage          { return f.cfg }
func (f *fakeHost) Changed() <-chan struct{}         { return f.ch }
func (f *fakeHost) Send([]ext.Sample, time.Time) int { return 0 }
func (f *fakeHost) Mode() string                     { return "docker" }
func (f *fakeHost) HostName() string                 { return "gpu-1" }
func (f *fakeHost) Log() *slog.Logger                { return slog.Default() }
func (f *fakeHost) Post(_ context.Context, path string, body any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, _ := json.Marshal(body)
	f.posts[path] = append(f.posts[path], b)
	return nil
}
func (f *fakeHost) PostGzip(ctx context.Context, path string, body any) error {
	return f.Post(ctx, path, body)
}

func TestTickAndProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/metrics" {
			_, _ = w.Write([]byte(text))
			return
		}
		_, _ = w.Write([]byte("<html>hello</html>"))
	}))
	defer srv.Close()
	h := &fakeHost{posts: map[string][]json.RawMessage{}, ch: make(chan struct{}, 1)}
	r := &runner{h: h, client: NewClient(), now: func() time.Time { return time.UnixMilli(1795000000000) }}
	cfg := Config{
		Targets: []Target{{ID: "addr:gpu-1:ok", URL: srv.URL + "/metrics"}, {ID: "addr:gpu-1:down", URL: "http://127.0.0.1:1/metrics"}},
		Probe:   &Probe{ID: "p1", Candidates: []Target{{ID: "a", URL: srv.URL + "/metrics"}, {ID: "b", URL: srv.URL + "/"}, {ID: "c", URL: "http://127.0.0.1:1/metrics"}}},
	}
	r.Tick(context.Background(), cfg)
	var rep Report
	if len(h.posts["own-metrics/scrape"]) != 1 || json.Unmarshal(h.posts["own-metrics/scrape"][0], &rep) != nil {
		t.Fatalf("posts %v", h.posts)
	}
	if rep.At != 1795000000000 || rep.Host != "gpu-1" || len(rep.Targets) != 2 {
		t.Fatalf("report %+v", rep)
	}
	if len(rep.Targets[0].Series) != 8 || rep.Targets[0].Types["queue_jobs_waiting"] != "gauge" || rep.Targets[0].Error != "" {
		t.Fatalf("the endpoint that answers: %+v", rep.Targets[0])
	}
	if rep.Targets[1].Error == "" || len(rep.Targets[1].Series) != 0 {
		t.Fatalf("the endpoint that is down: %+v", rep.Targets[1])
	}
	// A probe is answered once per id.
	r.probe(context.Background(), cfg)
	r.probe(context.Background(), cfg)
	var pr ProbeReport
	if len(h.posts["own-metrics/probe"]) != 1 || json.Unmarshal(h.posts["own-metrics/probe"][0], &pr) != nil {
		t.Fatalf("probe posts %v", h.posts["own-metrics/probe"])
	}
	if !pr.Results[0].OK || pr.Results[0].Series != 8 || len(pr.Results[0].Names) == 0 || pr.Results[1].OK || pr.Results[2].OK {
		t.Fatalf("probe %+v", pr.Results)
	}
}

func TestBatches(t *testing.T) {
	mk := func(id string, n int) TargetReport {
		return TargetReport{ID: id, Series: make([]Series, n)}
	}
	out := batches([]TargetReport{mk("a", 3), mk("b", 9), mk("c", 0), mk("d", 2)}, 5)
	var sizes []string
	total := 0
	for _, b := range out {
		n := 0
		for _, r := range b {
			n += len(r.Series)
		}
		if n > 5 {
			t.Fatalf("a batch of %d series", n)
		}
		total += n
		sizes = append(sizes, fmt.Sprint(n))
	}
	if total != 14 {
		t.Fatalf("series %d, want 14 (%v)", total, sizes)
	}
	// b continues over batches: every part but its last says More.
	more := 0
	for _, b := range out {
		for _, r := range b {
			if r.ID == "b" && r.More {
				more++
			}
		}
	}
	if more == 0 {
		t.Fatalf("a split endpoint says More: %v", sizes)
	}
}

func TestRegistered(t *testing.T) {
	for _, n := range ext.Names() {
		if n == Name {
			return
		}
	}
	t.Fatalf("the module isn't registered: %v", ext.Names())
}

// "Test" (1.0.3): an address a user typed is read once, and when it gives no metrics the
// answer says why in one word the page can put in a sentence.
func TestTestSaysWhy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/metrics":
			_, _ = w.Write([]byte(text))
		case "/page":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte("<!doctype html><html><body>hello</body></html>"))
		case "/json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		case "/empty":
			w.Header().Set("Content-Type", "text/plain")
		case "/secret":
			w.Header().Set("WWW-Authenticate", `Basic realm="metrics"`)
			w.WriteHeader(http.StatusUnauthorized)
		case "/forbidden":
			w.WriteHeader(http.StatusForbidden)
		case "/big":
			w.Header().Set("Content-Length", fmt.Sprint(MaxBody+1))
			w.WriteHeader(http.StatusOK)
		case "/away":
			http.Redirect(w, r, "http://elsewhere.invalid/metrics", http.StatusFound)
		case "/slow":
			select {
			case <-r.Context().Done():
			case <-time.After(3 * time.Second):
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	client := NewClient()
	why := func(path string, timeout time.Duration) (ProbeResult, Scrape) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		u := srv.URL + path
		if strings.HasPrefix(path, "http") {
			u = path
		}
		s, err := Fetch(ctx, client, u)
		var res ProbeResult
		res.Reason, res.Detail = Why(s, err)
		return res, s
	}
	for path, want := range map[string][2]string{
		"/metrics":                    {"", ""},
		"/page":                       {"html", ""},
		"/json":                       {"not_metrics", ""},
		"/empty":                      {"not_metrics", ""},
		"/secret":                     {"auth", "401"},
		"/forbidden":                  {"auth", "403"},
		"/missing":                    {"status", "404"},
		"/big":                        {"big", ""},
		"/away":                       {"redirect", ""},
		"http://127.0.0.1:1/metrics":  {"refused", ""},
		"ftp://127.0.0.1/metrics":     {"address", ""},
		"http://nowhere.invalid:9100": {"no_host", ""},
	} {
		got, _ := why(path, 5*time.Second)
		if got.Reason != want[0] || got.Detail != want[1] {
			t.Errorf("%s: got %q (%q), want %q (%q)", path, got.Reason, got.Detail, want[0], want[1])
		}
	}
	if got, _ := why("/slow", 100*time.Millisecond); got.Reason != "slow" {
		t.Errorf("a slow endpoint: %+v", got)
	}

	// Through the module: a test is answered once per id, beside a probe, with the reasons.
	h := &fakeHost{posts: map[string][]json.RawMessage{}, ch: make(chan struct{}, 1)}
	r := &runner{h: h, client: client, now: time.Now}
	cfg := Config{Test: &Probe{ID: "t1", Candidates: []Target{
		{ID: "ok", URL: srv.URL + "/metrics"}, {ID: "page", URL: srv.URL + "/page"}, {ID: "gone", URL: "http://127.0.0.1:1/metrics"},
	}}}
	r.probe(context.Background(), cfg)
	r.probe(context.Background(), cfg)
	var pr ProbeReport
	if len(h.posts["own-metrics/probe"]) != 1 || json.Unmarshal(h.posts["own-metrics/probe"][0], &pr) != nil {
		t.Fatalf("test posts %v", h.posts["own-metrics/probe"])
	}
	if pr.ID != "t1" || !pr.Results[0].OK || pr.Results[0].Series != 8 || pr.Results[0].Reason != "" ||
		pr.Results[1].OK || pr.Results[1].Reason != "html" || pr.Results[2].Reason != "refused" {
		t.Fatalf("test %+v", pr.Results)
	}
}
