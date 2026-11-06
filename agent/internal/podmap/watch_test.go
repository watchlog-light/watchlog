// SPDX-License-Identifier: AGPL-3.0-only

package podmap

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func testClient(t *testing.T, srv *httptest.Server) *Client {
	t.Helper()
	dir := t.TempDir()
	ca, token := filepath.Join(dir, "ca.crt"), filepath.Join(dir, "token")
	_ = os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0o600)
	_ = os.WriteFile(token, []byte("projected\n"), 0o600)
	c, err := NewClient(srv.URL, ca, token, "")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// A pushing cluster-agent: the first watch answers at once with v1; the next is held
// until the test publishes v2. FetchIPMap then answers from memory, with no request.
func TestWatchKeepsTheIPMapCurrent(t *testing.T) {
	var version atomic.Int32
	version.Store(1)
	changed := make(chan struct{})
	var fetches atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("watch") == "" {
			fetches.Add(1)
		}
		w.Header().Set(WatchHeader, "1")
		etag := func() string { return `"v` + string(rune('0'+version.Load())) + `"` }
		if r.URL.Query().Get("watch") != "" && r.Header.Get("If-None-Match") == etag() {
			select {
			case <-changed:
			case <-r.Context().Done():
				return
			}
		}
		w.Header().Set("ETag", etag())
		if r.Header.Get("If-None-Match") == etag() {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		svc := []IPService{{IPs: []string{"10.96.0.1"}, Namespace: "shop", Name: "v" + string(rune('0'+version.Load()))}}
		_ = json.NewEncoder(w).Encode(IPMap{Services: svc})
	}))
	defer srv.Close()
	c := testClient(t, srv)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- c.WatchIPMap(ctx, slog.New(slog.NewTextHandler(io.Discard, nil))) }()

	waitFor := func(name string) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if m, _ := c.FetchIPMap(context.Background()); m != nil && len(m.Services) == 1 && m.Services[0].Name == name {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		m, _ := c.FetchIPMap(context.Background())
		t.Fatalf("map = %+v, want service %s", m, name)
	}
	waitFor("v1")
	time.Sleep(50 * time.Millisecond) // the first watch answer has arrived; it is live now
	fetches.Store(0)
	version.Store(2)
	close(changed)
	waitFor("v2")
	if n := fetches.Load(); n != 0 {
		t.Errorf("FetchIPMap made %d requests while the watch was live", n)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Errorf("watch ended with %v", err)
	}
}

// An older cluster-agent answers watch requests at once and without the header: the
// client stops watching (no busy loop) and FetchIPMap keeps polling.
func TestWatchStopsAgainstAnOlderClusterAgent(t *testing.T) {
	var requests atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("ETag", `"v1"`)
		_ = json.NewEncoder(w).Encode(IPMap{Services: []IPService{{Name: "old"}}})
	}))
	defer srv.Close()
	c := testClient(t, srv)
	err := c.WatchIPMap(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if !errors.Is(err, errNoWatch) || requests.Load() != 1 {
		t.Fatalf("watch: %v after %d requests", err, requests.Load())
	}
	if m, err := c.FetchIPMap(context.Background()); err != nil || m == nil || m.Services[0].Name != "old" || requests.Load() != 2 {
		t.Errorf("poll after a refused watch: %+v %v (%d requests)", m, err, requests.Load())
	}
}
