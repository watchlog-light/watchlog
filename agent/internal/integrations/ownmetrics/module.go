// SPDX-License-Identifier: AGPL-3.0-only

package ownmetrics

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/ext"
)

// Name is the module's name: its section of the collector's configuration (`modules.own_metrics`).
const Name = "own_metrics"

// Defaults and bounds of the loop.
const (
	// Interval is how often every endpoint is scraped (the brief's 30 seconds).
	Interval = 30 * time.Second
	// Parallel endpoints scraped at once.
	Parallel = 8
	// postSeries bounds the series of one report: larger scrapes go in several.
	postSeries = 5000
	// probeTimeout bounds one try of "Find endpoints for me".
	probeTimeout = 3 * time.Second
	maxProbes    = 300
)

// Config is the module's section: the endpoints to scrape, and one probe when asked.
type Config struct {
	IntervalS int      `json:"interval_s"`
	Targets   []Target `json:"targets"`
	Probe     *Probe   `json:"probe,omitempty"`
}

// Target is one endpoint, named by the backend.
type Target struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

// Probe asks which of the candidates answer with metrics ("Find endpoints for me").
type Probe struct {
	ID         string   `json:"id"`
	Candidates []Target `json:"candidates"`
}

// Report is posted to /ingest/v1/own-metrics/scrape.
type Report struct {
	// At is when the scrapes were made, unix milliseconds.
	At      int64          `json:"at"`
	Host    string         `json:"host"`
	Targets []TargetReport `json:"targets"`
}

// TargetReport is one endpoint's scrape, or why it failed.
type TargetReport struct {
	ID        string            `json:"id"`
	Error     string            `json:"error,omitempty"`
	Series    []Series          `json:"series"`
	Types     map[string]string `json:"types,omitempty"`
	Help      map[string]string `json:"help,omitempty"`
	Truncated bool              `json:"truncated,omitempty"`
	// More says the endpoint's series continue in the next report.
	More bool `json:"more,omitempty"`
}

// ProbeReport is posted to /ingest/v1/own-metrics/probe.
type ProbeReport struct {
	ID      string        `json:"id"`
	Host    string        `json:"host"`
	Results []ProbeResult `json:"results"`
}

// ProbeResult says whether one candidate answered with metrics, and a few of their names.
type ProbeResult struct {
	ID     string   `json:"id"`
	OK     bool     `json:"ok"`
	Series int      `json:"series"`
	Names  []string `json:"names,omitempty"`
}

func init() { ext.Register(ext.Module{Name: Name, Run: Run}) }

// Run scrapes until ctx is cancelled.
func Run(ctx context.Context, h ext.Host) {
	(&runner{h: h, client: NewClient(), now: time.Now}).run(ctx)
}

type runner struct {
	h      ext.Host
	client *http.Client
	now    func() time.Time
	probed string
}

func (r *runner) config() Config {
	var c Config
	if raw := r.h.Config(); len(raw) > 0 {
		if err := json.Unmarshal(raw, &c); err != nil {
			r.h.Log().Warn("own metrics: the configuration didn't parse", "err", err)
		}
	}
	return c
}

func (r *runner) run(ctx context.Context) {
	next := time.NewTimer(0)
	defer next.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.h.Changed():
			// A probe is answered at once; the scrape keeps its own pace.
			r.probe(ctx, r.config())
			continue
		case <-next.C:
		}
		cfg := r.config()
		r.probe(ctx, cfg)
		r.Tick(ctx, cfg)
		interval := Interval
		if cfg.IntervalS >= 10 {
			interval = time.Duration(cfg.IntervalS) * time.Second
		}
		next.Reset(interval)
	}
}

// Tick scrapes every target once and posts what it read.
func (r *runner) Tick(ctx context.Context, cfg Config) {
	if len(cfg.Targets) == 0 {
		return
	}
	at := r.now()
	reports := make([]TargetReport, len(cfg.Targets))
	sem := make(chan struct{}, Parallel)
	var wg sync.WaitGroup
	for i, t := range cfg.Targets {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			reports[i] = scrapeOne(ctx, r.client, t)
		}()
	}
	wg.Wait()
	if ctx.Err() != nil {
		return
	}
	for _, batch := range batches(reports, postSeries) {
		rep := Report{At: at.UnixMilli(), Host: r.h.HostName(), Targets: batch}
		if err := r.h.PostGzip(ctx, "own-metrics/scrape", rep); err != nil {
			r.h.Log().Warn("own metrics: posting a scrape failed", "err", err)
		}
	}
}

func scrapeOne(ctx context.Context, client *http.Client, t Target) TargetReport {
	s, err := Fetch(ctx, client, t.URL)
	if err != nil {
		msg := err.Error()
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return TargetReport{ID: t.ID, Error: msg, Series: []Series{}}
	}
	if s.Series == nil {
		s.Series = []Series{}
	}
	return TargetReport{ID: t.ID, Series: s.Series, Types: s.Types, Help: s.Help, Truncated: s.Truncated}
}

// batches splits the reports so no post carries more than max series; an endpoint larger
// than that continues in the next one (More).
func batches(reports []TargetReport, max int) [][]TargetReport {
	var out [][]TargetReport
	var cur []TargetReport
	n := 0
	flush := func() {
		if len(cur) > 0 {
			out = append(out, cur)
			cur, n = nil, 0
		}
	}
	for _, rep := range reports {
		for len(rep.Series) > max-n {
			room := max - n
			if room <= 0 {
				flush()
				continue
			}
			head := rep
			head.Series, head.More = rep.Series[:room], true
			cur = append(cur, head)
			rep.Series = rep.Series[room:]
			flush()
		}
		cur = append(cur, rep)
		n += len(rep.Series)
		if n >= max {
			flush()
		}
	}
	flush()
	return out
}

// probe tries each candidate once per probe id and says which ones expose metrics.
func (r *runner) probe(ctx context.Context, cfg Config) {
	p := cfg.Probe
	if p == nil || p.ID == "" || p.ID == r.probed {
		return
	}
	r.probed = p.ID
	cands := p.Candidates
	if len(cands) > maxProbes {
		cands = cands[:maxProbes]
	}
	results := make([]ProbeResult, len(cands))
	sem := make(chan struct{}, Parallel)
	var wg sync.WaitGroup
	for i, c := range cands {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			pctx, cancel := context.WithTimeout(ctx, probeTimeout)
			defer cancel()
			res := ProbeResult{ID: c.ID}
			if s, err := Fetch(pctx, r.client, c.URL); err == nil && len(s.Series) > 0 {
				res.OK, res.Series = true, len(s.Series)
				seen := map[string]bool{}
				for _, x := range s.Series {
					if !seen[x.Name] && len(res.Names) < 5 {
						seen[x.Name] = true
						res.Names = append(res.Names, x.Name)
					}
				}
			}
			results[i] = res
		}()
	}
	wg.Wait()
	if ctx.Err() != nil {
		return
	}
	if err := r.h.Post(ctx, "own-metrics/probe", ProbeReport{ID: p.ID, Host: r.h.HostName(), Results: results}); err != nil {
		r.h.Log().Warn("own metrics: posting the probe's results failed", "err", err)
	}
}
