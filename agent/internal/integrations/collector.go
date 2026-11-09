// SPDX-License-Identifier: AGPL-3.0-only

package integrations

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/buffer"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
	"github.com/watchlog-light/watchlog/agent/internal/remotewrite"
	"github.com/watchlog-light/watchlog/agent/internal/runner"
	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

// Defaults when the backend sends no scrape settings.
const (
	DefaultInterval = 15 * time.Second
	// ScrapeTimeout bounds one target's scrape, all members included.
	ScrapeTimeout = 10 * time.Second
	// Parallel targets scraped at once.
	Parallel = 8
	// SeriesCap bounds the series of one scrape (the agent's per-node cap, SPEC §6.3).
	SeriesCap = runner.DefaultSeriesCap
)

// Collector runs the config watch and the scrape loop.
type Collector struct {
	Mode     string // kubernetes or docker
	Host     string // '' on Kubernetes
	Version  string
	Config   *ConfigClient
	Registry Registry
	Buffer   *buffer.Buffer
	Sender   *sender.Sender // writes metrics; its heartbeat URL is the status URL
	Log      *slog.Logger
	// Self returns the process's RSS and CPU seconds; replaced in tests.
	Self func() (rss, cpu float64)

	cfg        atomic.Pointer[Config]
	scrapes    atomic.Int64
	lastSeries atomic.Int64
	ready      chan struct{}
	readyOnce  sync.Once
}

// Run watches the configuration and scrapes until ctx is cancelled.
func (c *Collector) Run(ctx context.Context) {
	c.ready = make(chan struct{})
	go c.watchConfig(ctx)
	go c.Sender.Run(ctx)
	// The first scrape waits for the first configuration, at most one interval.
	select {
	case <-ctx.Done():
		return
	case <-c.ready:
	case <-time.After(DefaultInterval):
	}
	for {
		interval := c.Tick(ctx, time.Now())
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

// Current returns the configuration in use, or nil before the first.
func (c *Collector) Current() *Config { return c.cfg.Load() }

// SetConfig replaces the configuration (the watcher, and tests).
func (c *Collector) SetConfig(cfg *Config) {
	c.cfg.Store(cfg)
	c.readyOnce.Do(func() {
		if c.ready != nil {
			close(c.ready)
		}
	})
}

func (c *Collector) watchConfig(ctx context.Context) {
	backoff := time.Second
	etag := ""
	for ctx.Err() == nil {
		wait := LongPollWait
		if etag == "" {
			wait = 0
		}
		cfg, err := c.Config.Fetch(ctx, etag, wait)
		switch {
		case err == nil:
			backoff = time.Second
			if cfg != nil {
				if cfg.Version != etag {
					c.Log.Info("configuration received", "version", cfg.Version, "targets", len(cfg.Targets))
				}
				etag = cfg.Version
				c.SetConfig(cfg)
			}
			continue
		case errors.Is(err, ErrUnauthorized):
			c.Log.Error(err.Error() + ". Retrying in 5 minutes")
			sleep(ctx, sender.UnauthorizedPause)
		default:
			if ctx.Err() != nil {
				return
			}
			c.Log.Warn("configuration unavailable; keeping the last one", "err", err, "retry_in", backoff)
			sleep(ctx, backoff)
			backoff = min(backoff*2, time.Minute)
		}
	}
}

func sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// Tick scrapes every target once, buffers the samples, posts the status, and returns
// the interval until the next scrape.
func (c *Collector) Tick(ctx context.Context, now time.Time) time.Duration {
	cfg := c.cfg.Load()
	interval, heavyEvery := DefaultInterval, 2
	var targets []Target
	version := ""
	if cfg != nil {
		if cfg.Scrape.IntervalS > 0 {
			interval = time.Duration(cfg.Scrape.IntervalS) * time.Second
		}
		if cfg.Scrape.HeavyEvery > 0 {
			heavyEvery = cfg.Scrape.HeavyEvery
		}
		targets, version = cfg.Targets, cfg.Version
	}
	n := c.scrapes.Add(1)
	heavy := (n-1)%int64(heavyEvery) == 0

	samples, statuses := c.scrapeAll(ctx, targets, heavy)
	samples = append(samples, c.selfMetrics(len(targets))...)
	if len(samples) > SeriesCap {
		c.Log.Warn("series cap reached; the rest of this scrape is dropped", "series", len(samples), "cap", SeriesCap)
		samples = samples[:SeriesCap]
	}
	c.lastSeries.Store(int64(len(samples)))
	for start := 0; start < len(samples); start += runner.BatchSeries {
		body := remotewrite.Encode(samples[start:min(start+runner.BatchSeries, len(samples))], now.UnixMilli())
		if _, err := c.Buffer.Put(body); err != nil {
			c.Log.Error("buffering batch", "err", err)
		}
	}
	c.postStatus(ctx, version, statuses)
	return interval
}

func (c *Collector) scrapeAll(ctx context.Context, targets []Target, heavy bool) ([]metrics.Sample, []TargetStatus) {
	type out struct {
		samples []metrics.Sample
		status  TargetStatus
	}
	results := make([]out, len(targets))
	sem := make(chan struct{}, Parallel)
	var wg sync.WaitGroup
	for i, t := range targets {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			results[i].samples, results[i].status = c.scrapeOne(ctx, t, heavy)
		}()
	}
	wg.Wait()
	var samples []metrics.Sample
	statuses := make([]TargetStatus, 0, len(targets))
	for _, r := range results {
		samples = append(samples, r.samples...)
		statuses = append(statuses, r.status)
	}
	return samples, statuses
}

func (c *Collector) scrapeOne(ctx context.Context, t Target, heavy bool) ([]metrics.Sample, TargetStatus) {
	ctx, cancel := context.WithTimeout(ctx, ScrapeTimeout)
	defer cancel()
	start := time.Now()
	res := c.safeScrape(ctx, t, heavy)
	elapsed := time.Since(start).Seconds()

	labels := []metrics.Label{{Name: "service", Value: t.ID}, {Name: "service_type", Value: t.Type}}
	out := make([]metrics.Sample, 0, len(res.Samples)+len(res.Members)+1)
	for _, s := range res.Samples {
		out = append(out, s.WithLabels(labels...))
	}
	for _, m := range res.Members {
		v := 0.0
		if m.Up {
			v = 1
		}
		out = append(out, metrics.New("watchlog_integration_up", v, "member", m.Name).WithLabels(labels...))
	}
	out = append(out, metrics.New("watchlog_integration_scrape_seconds", elapsed).WithLabels(labels...))

	st := TargetStatus{ID: t.ID, State: res.State, Error: res.Error, ServiceVersion: res.ServiceVersion,
		Members: res.Members, Permissions: res.Permissions}
	if st.State == "" {
		st.State = StateOK
	}
	if len(st.Error) > maxErrorLen {
		st.Error = st.Error[:maxErrorLen]
	}
	if len(st.Members) > maxMembers {
		st.Members = st.Members[:maxMembers]
	}
	if len(st.Permissions) > maxPermission {
		st.Permissions = st.Permissions[:maxPermission]
	}
	return out, st
}

// safeScrape turns a panicking integration into an error for that target only.
func (c *Collector) safeScrape(ctx context.Context, t Target, heavy bool) (res Result) {
	defer func() {
		if r := recover(); r != nil {
			c.Log.Error("integration failed", "type", t.Type, "service", t.ID, "panic", r)
			res = Result{State: StateError, Error: "the collector failed reading this service; see its log"}
		}
	}()
	return c.Registry.For(t.Type).Scrape(ctx, t, heavy)
}

func (c *Collector) selfMetrics(targets int) []metrics.Sample {
	out := []metrics.Sample{
		metrics.New("watchlog_integrations_info", 1, "version", c.Version, "mode", c.Mode),
		metrics.New("watchlog_integrations_targets", float64(targets)),
		metrics.New("watchlog_integrations_series", float64(c.lastSeries.Load())),
	}
	if c.Self != nil {
		rss, cpu := c.Self()
		if rss > 0 {
			out = append(out, metrics.New("watchlog_integrations_memory_rss_bytes", rss))
		}
		out = append(out, metrics.New("watchlog_integrations_cpu_seconds_total", cpu))
	}
	if c.Host != "" {
		for i := range out {
			out[i] = out[i].WithLabels(metrics.Label{Name: "host", Value: c.Host})
		}
	}
	return out
}

func (c *Collector) postStatus(ctx context.Context, version string, targets []TargetStatus) {
	if len(targets) > maxTargets {
		targets = targets[:maxTargets]
	}
	st := Status{Host: c.Host, Mode: c.Mode, Version: c.Version, ConfigVersion: version,
		Targets: targets, Self: SelfStatus{Series: int(c.lastSeries.Load())}}
	if c.Self != nil {
		st.Self.RSSBytes, st.Self.CPUSeconds = c.Self()
	}
	body, err := json.Marshal(st)
	if err != nil {
		c.Log.Error("encoding status", "err", err)
		return
	}
	if outcome := c.Sender.SendHeartbeat(ctx, body); outcome != sender.Delivered {
		c.Log.Debug("status not delivered", "outcome", outcome.String())
	}
}
