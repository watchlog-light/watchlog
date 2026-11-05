// SPDX-License-Identifier: AGPL-3.0-only

package runner

import (
	"compress/gzip"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/buffer"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

func samples(prefix string, n int) []metrics.Sample {
	out := make([]metrics.Sample, n)
	for i := range out {
		out[i] = metrics.New(prefix, float64(i))
	}
	return out
}

func TestLimitSeriesDropsLowestPriorityFirst(t *testing.T) {
	kept, dropped := LimitSeries([][]metrics.Sample{samples("host", 3), samples("containers", 5), samples("network", 4)}, 6)
	if len(kept) != 6 || dropped != 6 {
		t.Fatalf("kept %d, dropped %d", len(kept), dropped)
	}
	for i, s := range kept {
		want := "host"
		if i >= 3 {
			want = "containers"
		}
		if s.Name != want {
			t.Errorf("kept[%d] = %s, want %s", i, s.Name, want)
		}
	}
	if k, d := LimitSeries([][]metrics.Sample{samples("a", 2)}, 0); len(k) != 0 || d != 2 {
		t.Errorf("zero limit: kept %d, dropped %d", len(k), d)
	}
}

func newRunner(t *testing.T, srvURL string, sources ...Source) *Runner {
	t.Helper()
	buf, err := buffer.Open(t.TempDir(), 1<<20, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := sender.New(sender.Config{WriteURL: srvURL + "/ingest/v1/write", HeartbeatURL: srvURL + "/ingest/v1/heartbeat", Token: "t"}, buf, log)
	return &Runner{Mode: "docker", Version: "1.0.0", Host: "web-01", HostLabel: "host", Interval: time.Hour, SeriesCap: 20,
		Sources: sources, Buffer: buf, Sender: s, Log: log,
		Capabilities: sender.Capabilities{EBPF: "disabled", Cgroup: "v2"}}
}

func TestScrapeAddsHostLabelSelfMetricsAndCountsDrops(t *testing.T) {
	r := newRunner(t, "http://unused",
		Source{Name: "host", Collect: func() ([]metrics.Sample, error) { return samples("host", 5), nil }},
		Source{Name: "noisy", Collect: func() ([]metrics.Sample, error) { return samples("noisy", 50), errors.New("partial") }},
	)
	got := r.Scrape()
	if len(got) != 20 {
		t.Fatalf("scrape returned %d series, want the cap of 20", len(got))
	}
	names := map[string]int{}
	for _, s := range got {
		names[s.Name]++
		if s.Labels[len(s.Labels)-1] != (metrics.Label{Name: "host", Value: "web-01"}) {
			t.Fatalf("%s lacks the host label", s.Name)
		}
	}
	if names["host"] != 5 || names["watchlog_agent_info"] != 1 {
		t.Errorf("names = %v", names)
	}
	// The next scrape reports the drop in the self-metric.
	for _, s := range r.Scrape() {
		if s.Name == "watchlog_agent_series_dropped_total" && s.Value == 0 {
			t.Error("series_dropped_total not incremented")
		}
	}
}

func TestTickBuffersABatchAndSendsAHeartbeat(t *testing.T) {
	heartbeats := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if strings.HasSuffix(r.URL.Path, "/heartbeat") {
			heartbeats <- string(b)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	r := newRunner(t, srv.URL, Source{Name: "host", Collect: func() ([]metrics.Sample, error) { return samples("host", 2), nil }})
	r.tick(context.Background(), time.Now())
	if files, _, _ := r.Buffer.Stats(); files != 1 {
		t.Errorf("buffered files = %d", files)
	}
	select {
	case hb := <-heartbeats:
		for _, want := range []string{`"agent_version":"1.0.0"`, `"mode":"docker"`, `"node":"web-01"`, `"ebpf":"disabled"`, `"cgroup":"v2"`} {
			if !strings.Contains(hb, want) {
				t.Errorf("heartbeat %s lacks %s", hb, want)
			}
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no heartbeat")
	}
}

func TestProcSelfParsers(t *testing.T) {
	dir := t.TempDir()
	status := filepath.Join(dir, "status")
	stat := filepath.Join(dir, "stat")
	if err := os.WriteFile(status, []byte("Name:\twatchlog-agent\nVmRSS:\t   12345 kB\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// comm with a space and parentheses; utime=250, stime=50 ticks.
	if err := os.WriteFile(stat, []byte("42 (watch (log)) S 1 1 1 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 8 0 1000 0 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if rss, ok := readRSS(status); !ok || rss != 12345*1024 {
		t.Errorf("rss = %v %v", rss, ok)
	}
	if cpu, ok := readCPUSeconds(stat); !ok || cpu != 3 {
		t.Errorf("cpu = %v %v", cpu, ok)
	}
}

func TestEventChangesSendADeltaRightAway(t *testing.T) {
	bodies := make(chan string, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/objects") {
			zr, err := gzip.NewReader(r.Body)
			if err == nil {
				b, _ := io.ReadAll(zr)
				bodies <- string(b)
			}
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	r := newRunner(t, srv.URL)
	r.Sender = sender.New(sender.Config{WriteURL: srv.URL + "/ingest/v1/write", HeartbeatURL: srv.URL + "/ingest/v1/heartbeat",
		ObjectsURL: srv.URL + "/ingest/v1/objects", Token: "t"}, r.Buffer, r.Log)
	changes := make(chan struct{}, 1)
	calls := 0
	r.Changes = changes
	r.Delta = func(context.Context) (any, error) {
		calls++
		return map[string]any{"containers": []map[string]string{{"name": "fx-unhealthy"}}}, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.watchDeltas(ctx)
	changes <- struct{}{}
	select {
	case b := <-bodies:
		if !strings.Contains(b, `"kind":"delta"`) || !strings.Contains(b, `"node":"web-01"`) || !strings.Contains(b, "fx-unhealthy") {
			t.Errorf("delta body = %s", b)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no delta sent")
	}
	if calls != 1 {
		t.Errorf("Delta called %d times", calls)
	}
}

func TestLargeScrapesAreSplitIntoBatches(t *testing.T) {
	r := newRunner(t, "http://127.0.0.1:1", Source{Name: "kube", Collect: func() ([]metrics.Sample, error) {
		return samples("kube", 45_000), nil
	}})
	r.SeriesCap = 150_000
	r.tick(context.Background(), time.Now())
	if files, _, _ := r.Buffer.Stats(); files != 3 { // 45,000 + self-metrics → 20k, 20k, 5k+
		t.Errorf("buffered batches = %d, want 3", files)
	}
}
