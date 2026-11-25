// SPDX-License-Identifier: AGPL-3.0-only

package ownmetrics

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// exposition is an endpoint's page: counters, a gauge and histograms, `series` lines in all.
func exposition(series int) string {
	var b strings.Builder
	b.WriteString("# HELP orders_created_total Orders created.\n# TYPE orders_created_total counter\n")
	n := 0
	for i := 0; n < series/4; i++ {
		fmt.Fprintf(&b, "orders_created_total{method=\"m%d\",region=\"eu-%d\"} %d\n", i%12, i/12, 1000+i)
		n++
	}
	b.WriteString("# TYPE jobs_waiting gauge\n")
	for i := 0; n < series/2; i++ {
		fmt.Fprintf(&b, "jobs_waiting{queue=\"q%d\"} %d\n", i, i)
		n++
	}
	b.WriteString("# TYPE checkout_duration_seconds histogram\n")
	for i := 0; n < series; i++ {
		fmt.Fprintf(&b, "checkout_duration_seconds_bucket{route=\"r%d\",le=\"%g\"} %d\n", i/12, float64(i%12)/10, i)
		n++
	}
	return b.String()
}

// gzipHost does what the collector's host does with a report: JSON, gzip, and away.
type gzipHost struct {
	fakeHost
	bytes int
}

func (g *gzipHost) PostGzip(_ context.Context, _ string, body any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	_, _ = w.Write(data)
	_ = w.Close()
	g.bytes += buf.Len()
	_, _ = io.Copy(io.Discard, &buf)
	return nil
}

// BenchmarkParse500 is one endpoint's page of 500 series read into a report.
func BenchmarkParse500(b *testing.B) {
	page := exposition(500)
	b.SetBytes(int64(len(page)))
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		s, err := Parse(strings.NewReader(page))
		if err != nil || len(s.Series) != 500 {
			b.Fatalf("series %d, err %v", len(s.Series), err)
		}
	}
}

// BenchmarkTick20x500 is one round of the release's capacity shape: 20 endpoints of 500 series
// each, fetched over HTTP, parsed and posted gzipped. One round runs every 30 s, so the
// collector's CPU for own metrics is this time divided by 30 s (the budget is in SPEC §6.1).
func BenchmarkTick20x500(b *testing.B) {
	page := []byte(exposition(500))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(page)
	}))
	defer srv.Close()
	cfg := Config{}
	for i := 0; i < 20; i++ {
		cfg.Targets = append(cfg.Targets, Target{ID: fmt.Sprintf("t%d", i), URL: fmt.Sprintf("%s/metrics?i=%d", srv.URL, i)})
	}
	h := &gzipHost{fakeHost: fakeHost{posts: map[string][]json.RawMessage{}, ch: make(chan struct{}, 1)}}
	r := &runner{h: h, client: NewClient(), now: time.Now}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		r.Tick(context.Background(), cfg)
	}
	b.ReportMetric(float64(h.bytes)/float64(b.N), "gz-bytes/round")
}
