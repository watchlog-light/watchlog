// SPDX-License-Identifier: AGPL-3.0-only

package integrations

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/buffer"
	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

const testToken = "wl_test_token_value"

// backend fakes the two collector routes.
type backend struct {
	mu       sync.Mutex
	cfg      Config
	statuses []Status
	gotWait  []string
	gotHosts []string
	refuse   bool
}

func (b *backend) handler(t *testing.T) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ingest/v1/integrations/config", func(w http.ResponseWriter, r *http.Request) {
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.refuse || r.Header.Get("Authorization") != "Bearer "+testToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		b.gotWait = append(b.gotWait, r.URL.Query().Get("wait"))
		b.gotHosts = append(b.gotHosts, r.URL.Query().Get("host"))
		w.Header().Set("ETag", `"`+b.cfg.Version+`"`)
		if r.Header.Get("If-None-Match") == `"`+b.cfg.Version+`"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_ = json.NewEncoder(w).Encode(b.cfg)
	})
	mux.HandleFunc("POST /ingest/v1/integrations/status", func(w http.ResponseWriter, r *http.Request) {
		var st Status
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &st); err != nil {
			t.Errorf("status body: %v", err)
		}
		b.mu.Lock()
		b.statuses = append(b.statuses, st)
		b.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /ingest/v1/write", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	return mux
}

func newCollector(t *testing.T, url string, reg Registry) *Collector {
	t.Helper()
	buf, err := buffer.Open(t.TempDir(), 1<<20, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return &Collector{
		Mode: "docker", Host: "docker-01", Version: "test",
		Config: &ConfigClient{URL: url + "/ingest/v1/integrations/config", Token: testToken, Host: "docker-01",
			AgentID: "integrations:docker-01", UserAgent: "test"},
		Registry: reg,
		Buffer:   buf,
		Sender: sender.New(sender.Config{WriteURL: url + "/ingest/v1/write",
			HeartbeatURL: url + "/ingest/v1/integrations/status", Token: testToken, AgentID: "integrations:docker-01"}, buf, log),
		Log:  log,
		Self: func() (float64, float64) { return 20e6, 1.25 },
	}
}

func TestFetchConfigEtagAndAuth(t *testing.T) {
	b := &backend{cfg: Config{Version: "v1", Targets: []Target{{ID: "a", Type: "redis"}}}}
	srv := httptest.NewServer(b.handler(t))
	defer srv.Close()
	c := newCollector(t, srv.URL, nil).Config

	cfg, err := c.Fetch(context.Background(), "", 0)
	if err != nil || cfg == nil || cfg.Version != "v1" || len(cfg.Targets) != 1 {
		t.Fatalf("first fetch = %+v, %v", cfg, err)
	}
	cfg, err = c.Fetch(context.Background(), "v1", 25*time.Second)
	if err != nil || cfg != nil {
		t.Fatalf("unchanged fetch = %+v, %v; want nil, nil", cfg, err)
	}
	if b.gotWait[1] != "25" || b.gotHosts[0] != "docker-01" {
		t.Errorf("wait=%v hosts=%v", b.gotWait, b.gotHosts)
	}
	b.refuse = true
	if _, err := c.Fetch(context.Background(), "", 0); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("refused fetch err = %v", err)
	}
}

func TestFetchErrorsNeverCarryTheToken(t *testing.T) {
	c := &ConfigClient{URL: "http://127.0.0.1:1/x?t=" + testToken, Token: testToken}
	_, err := c.Fetch(context.Background(), "", 0)
	if err == nil || strings.Contains(err.Error(), testToken) {
		t.Fatalf("err = %v", err)
	}
}

func TestTCPCheck(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	closed, _ := net.Listen("tcp", "127.0.0.1:0")
	closedAddr := closed.Addr().String()
	_ = closed.Close()

	res := TCPCheck{}.Scrape(context.Background(), Target{Members: []Member{
		{Name: "up-0", Address: ln.Addr().String()}, {Name: "down-1", Address: closedAddr},
	}}, false)
	if res.State != StateOK || len(res.Members) != 2 || !res.Members[0].Up || res.Members[1].Up {
		t.Fatalf("result = %+v", res)
	}
	if res.Members[1].Error == "" || strings.Contains(res.Members[1].Error, "dial tcp") {
		t.Errorf("down member error = %q; want the cause only", res.Members[1].Error)
	}
	if len(res.Samples) != 1 || res.Samples[0].Name != "watchlog_integration_connect_seconds" {
		t.Errorf("samples = %+v", res.Samples)
	}

	all := TCPCheck{}.Scrape(context.Background(), Target{Members: []Member{{Name: "d", Address: closedAddr}}}, false)
	if all.State != StateError || all.Error == "" {
		t.Errorf("all down = %+v", all)
	}
	none := TCPCheck{}.Scrape(context.Background(), Target{}, false)
	if none.State != StateError || !strings.Contains(none.Error, "no member") {
		t.Errorf("no members = %+v", none)
	}
}

type fixed struct{ res Result }

func (f fixed) Scrape(context.Context, Target, bool) Result { return f.res }

type panics struct{}

func (panics) Scrape(context.Context, Target, bool) Result { panic("boom") }

type heavyRecorder struct {
	mu    sync.Mutex
	heavy []bool
}

func (h *heavyRecorder) Scrape(_ context.Context, _ Target, heavy bool) Result {
	h.mu.Lock()
	h.heavy = append(h.heavy, heavy)
	h.mu.Unlock()
	return Result{State: StateOK}
}

func TestTickBuffersMetricsAndPostsStatus(t *testing.T) {
	b := &backend{}
	srv := httptest.NewServer(b.handler(t))
	defer srv.Close()
	rec := &heavyRecorder{}
	c := newCollector(t, srv.URL, Registry{
		"redis": fixed{Result{State: StateOK, ServiceVersion: "7.2.4",
			Members:     []MemberStatus{{Name: "redis-0", Up: true}},
			Permissions: []Permission{{Tab: "memory", Missing: "+memory|stats"}}}},
		"postgres": panics{},
		"nginx":    rec,
	})
	c.SetConfig(&Config{Version: "v7", Scrape: Scrape{IntervalS: 30, HeavyEvery: 2}, Targets: []Target{
		{ID: "r1", Type: "redis", Name: "shop/redis"},
		{ID: "p1", Type: "postgres", Name: "db"},
		{ID: "n1", Type: "nginx", Name: "edge"},
	}})

	if got := c.Tick(context.Background(), time.Now()); got != 30*time.Second {
		t.Errorf("interval = %v", got)
	}
	c.Tick(context.Background(), time.Now())
	c.Tick(context.Background(), time.Now())
	if files, _, _ := c.Buffer.Stats(); files != 3 {
		t.Errorf("buffered batches = %d, want one per tick", files)
	}
	if len(rec.heavy) != 3 || !rec.heavy[0] || rec.heavy[1] || !rec.heavy[2] {
		t.Errorf("heavy tiers = %v, want every other scrape from the first", rec.heavy)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.statuses) != 3 {
		t.Fatalf("statuses = %d", len(b.statuses))
	}
	st := b.statuses[0]
	if st.Host != "docker-01" || st.Mode != "docker" || st.ConfigVersion != "v7" || st.Self.RSSBytes != 20e6 {
		t.Errorf("status header = %+v", st)
	}
	byID := map[string]TargetStatus{}
	for _, ts := range st.Targets {
		byID[ts.ID] = ts
	}
	if r := byID["r1"]; r.State != StateOK || r.ServiceVersion != "7.2.4" || len(r.Permissions) != 1 {
		t.Errorf("redis status = %+v", r)
	}
	if p := byID["p1"]; p.State != StateError || !strings.Contains(p.Error, "failed") {
		t.Errorf("a panicking integration must only fail its own target: %+v", p)
	}
}

func TestRunWaitsForTheFirstConfiguration(t *testing.T) {
	b := &backend{cfg: Config{Version: "v1", Scrape: Scrape{IntervalS: 1}, Targets: []Target{{ID: "x", Type: "redis"}}}}
	srv := httptest.NewServer(b.handler(t))
	defer srv.Close()
	c := newCollector(t, srv.URL, Registry{"redis": fixed{Result{State: StateOK}}})
	ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
	defer cancel()
	c.Run(ctx)
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.statuses) < 2 {
		t.Fatalf("statuses = %d, want a report every interval", len(b.statuses))
	}
	if b.statuses[0].ConfigVersion != "v1" || len(b.statuses[0].Targets) != 1 {
		t.Errorf("the first scrape ran without the configuration: %+v", b.statuses[0])
	}
}
