// SPDX-License-Identifier: AGPL-3.0-only

package integrations

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/ext"
)

// A module gets its own section of the configuration, is woken when it changes, sends under
// the collector's one series cap and posts to its ingest path with the collector's token.
func TestModuleHost(t *testing.T) {
	var mu sync.Mutex
	var posted []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ingest/v1/test-mod/report" {
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			posted = append(posted, r.Header.Get("Authorization")+" "+string(b))
			mu.Unlock()
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	got := make(chan json.RawMessage, 4)
	var host ext.Host
	ext.Register(ext.Module{Name: "test-mod", Feature: "network", Run: func(ctx context.Context, h ext.Host) {
		host = h
		for {
			select {
			case <-ctx.Done():
				return
			case <-h.Changed():
				got <- h.Config()
			}
		}
	}})
	defer ext.Unregister("test-mod")

	c := newCollector(t, srv.URL, nil)
	c.SetConfig(&Config{Version: "v1", Modules: map[string]json.RawMessage{"test-mod": json.RawMessage(`{"devices":1}`)}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.startModules(ctx)
	select {
	case raw := <-got:
		if string(raw) != `{"devices":1}` {
			t.Fatalf("section = %s", raw)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the module never got its section")
	}
	c.SetConfig(&Config{Version: "v2", Modules: map[string]json.RawMessage{"test-mod": json.RawMessage(`{"devices":2}`)}})
	if raw := <-got; string(raw) != `{"devices":2}` {
		t.Fatalf("changed section = %s", raw)
	}
	// The same section again: no wake-up.
	c.SetConfig(&Config{Version: "v3", Modules: map[string]json.RawMessage{"test-mod": json.RawMessage(`{"devices":2}`)}})
	select {
	case raw := <-got:
		t.Fatalf("woken for an unchanged section: %s", raw)
	case <-time.After(100 * time.Millisecond):
	}

	// The cap: what the integrations scraped counts first.
	c.lastSeries.Store(SeriesCap - 3)
	samples := make([]ext.Sample, 10)
	for i := range samples {
		samples[i] = ext.Sample{Name: "watchlog_net_test", Value: float64(i)}
	}
	if kept := host.Send(samples, time.Now()); kept != 3 {
		t.Fatalf("kept %d, want 3 under the cap", kept)
	}
	if c.moduleSeries() != 3 {
		t.Fatalf("module series = %d", c.moduleSeries())
	}

	if err := host.Post(ctx, "test-mod/report", map[string]int{"n": 1}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(posted) != 1 || posted[0] != "Bearer "+testToken+` {"n":1}` {
		t.Fatalf("posted = %v", posted)
	}
}
