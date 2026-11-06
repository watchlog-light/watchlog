// SPDX-License-Identifier: AGPL-3.0-only

// Package runner schedules scrapes, buffers batches and runs the sender and heartbeat.
package runner

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/buffer"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
	"github.com/watchlog-light/watchlog/agent/internal/remotewrite"
	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

// DefaultSeriesCap is the hard cap of active series per node (SPEC §6.3).
const DefaultSeriesCap = 20_000

// BatchSeries is the most series per remote_write request (the backend's limit).
const BatchSeries = 20_000

// Source is one collector; Sources are listed from highest to lowest priority.
type Source struct {
	Name    string
	Collect func() ([]metrics.Sample, error)
}

// InventoryFunc returns the current inventory and a hash used to detect changes.
type InventoryFunc func() (any, string)

// InventoryResend is how often an unchanged inventory is re-sent (SPEC §6.5).
const InventoryResend = 10 * time.Minute

// DeltaFunc returns the containers changed by events since the last call, or nil.
type DeltaFunc func(ctx context.Context) (any, error)

// DeltaCoalesce waits for related events (die, then restart) to arrive before sending.
const DeltaCoalesce = time.Second

// Runner owns the scrape loop.
type Runner struct {
	Mode    string
	Version string
	Host    string
	// HostLabel names the label carrying Host on every series: "host" (Docker),
	// "node" (Kubernetes nodes, ADR-062) or empty for none (cluster-agent).
	HostLabel    string
	Interval     time.Duration
	SeriesCap    int
	Sources      []Source
	Buffer       *buffer.Buffer
	Sender       *sender.Sender
	Capabilities sender.Capabilities
	// CapabilitiesFunc, when set, replaces Capabilities (values known only at runtime).
	CapabilitiesFunc func() sender.Capabilities
	Log              *slog.Logger
	// Inventory, when set, is posted to the objects endpoint when it changes.
	Inventory InventoryFunc
	// Changes and Delta, when set, post the containers changed by events right away
	// instead of waiting for the next snapshot.
	Changes <-chan struct{}
	Delta   DeltaFunc

	invHash   string
	invSentAt time.Time
	lastErrs  map[string]string

	lastSeries     atomic.Int64
	seriesDropped  atomic.Int64
	expiredDropped atomic.Int64
	fullDropped    atomic.Int64
}

// Run scrapes every Interval until ctx is cancelled; sending runs concurrently.
func (r *Runner) Run(ctx context.Context) {
	go r.Sender.Run(ctx)
	if r.Changes != nil && r.Delta != nil {
		go r.watchDeltas(ctx)
	}
	ticker := time.NewTicker(r.Interval)
	defer ticker.Stop()
	for {
		r.tick(ctx, time.Now())
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (r *Runner) tick(ctx context.Context, now time.Time) {
	samples := r.Scrape()
	// One buffered batch per BatchSeries series: the backend rejects larger requests.
	for start := 0; start < len(samples) || start == 0; start += BatchSeries {
		body := remotewrite.Encode(samples[start:min(start+BatchSeries, len(samples))], now.UnixMilli())
		dropped, err := r.Buffer.Put(body)
		if err != nil {
			r.Log.Error("buffering batch", "err", err)
		}
		r.expiredDropped.Add(int64(dropped.Expired))
		r.fullDropped.Add(int64(dropped.BufferFull))
		if dropped.Expired+dropped.BufferFull > 0 {
			r.Log.Warn("buffer limit reached; oldest batches dropped", "expired", dropped.Expired, "buffer_full", dropped.BufferFull)
		}
		if len(samples) == 0 {
			break
		}
	}
	hb, _ := json.Marshal(sender.Heartbeat{
		AgentVersion: r.Version, Mode: r.Mode, Node: r.Host,
		Capabilities: r.capabilities(), Series: int(r.lastSeries.Load()),
	})
	go r.Sender.SendHeartbeat(ctx, hb)
	r.sendInventory(ctx, now)
}

func (r *Runner) capabilities() sender.Capabilities {
	if r.CapabilitiesFunc != nil {
		return r.CapabilitiesFunc()
	}
	return r.Capabilities
}

func (r *Runner) sendInventory(ctx context.Context, now time.Time) {
	if r.Inventory == nil {
		return
	}
	inv, hash := r.Inventory()
	if hash == r.invHash && now.Sub(r.invSentAt) < InventoryResend {
		return
	}
	body, err := json.Marshal(map[string]any{"kind": "snapshot", "source": "docker", "node": r.Host, "inventory": inv})
	if err != nil {
		r.Log.Error("encoding inventory", "err", err)
		return
	}
	outcome, status := r.Sender.SendObjects(ctx, body)
	switch outcome {
	case sender.Delivered:
		r.invHash, r.invSentAt = hash, now
	case sender.Rejected:
		r.invHash, r.invSentAt = hash, now // do not resend a rejected snapshot until it changes
		r.Log.Warn("inventory snapshot rejected", "status", status)
	default:
		r.Log.Debug("inventory not delivered; retrying next interval", "outcome", outcome.String(), "status", status)
	}
}

func (r *Runner) watchDeltas(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.Changes:
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(DeltaCoalesce):
		}
		r.sendDelta(ctx)
	}
}

// sendDelta posts the containers changed by events. A failed delta is not retried:
// the next snapshot carries the same state.
func (r *Runner) sendDelta(ctx context.Context) {
	inv, err := r.Delta(ctx)
	if err != nil {
		r.Log.Debug("inventory delta incomplete", "err", err)
	}
	if inv == nil {
		return
	}
	body, err := json.Marshal(map[string]any{"kind": "delta", "source": "docker", "node": r.Host, "inventory": inv})
	if err != nil {
		r.Log.Error("encoding inventory delta", "err", err)
		return
	}
	if outcome, status := r.Sender.SendObjects(ctx, body); outcome != sender.Delivered {
		r.Log.Debug("inventory delta not delivered; the next snapshot carries it", "outcome", outcome.String(), "status", status)
	}
}

// Scrape collects all sources, applies the series cap and adds self-metrics and the host label.
func (r *Runner) Scrape() []metrics.Sample {
	var groups [][]metrics.Sample
	for _, src := range r.Sources {
		s, err := src.Collect()
		r.logOnChange(src.Name, err)
		groups = append(groups, s)
	}
	selfMetrics := r.selfMetrics()
	limit := r.SeriesCap
	if limit <= 0 {
		limit = DefaultSeriesCap
	}
	kept, dropped := LimitSeries(groups, limit-len(selfMetrics))
	if dropped > 0 {
		r.seriesDropped.Add(int64(dropped))
		r.Log.Warn("series cap reached; lowest-priority series dropped", "dropped", dropped, "cap", limit)
	}
	all := append(selfMetrics, kept...)
	r.lastSeries.Store(int64(len(all)))
	if r.HostLabel != "" {
		hostLabel := metrics.Label{Name: r.HostLabel, Value: r.Host}
		for i := range all {
			all[i] = all[i].WithLabels(hostLabel)
		}
	}
	return all
}

// logOnChange logs collector errors only when they change, to keep logs quiet
// when the same container keeps failing every interval.
func (r *Runner) logOnChange(source string, err error) {
	if r.lastErrs == nil {
		r.lastErrs = map[string]string{}
	}
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	if msg == r.lastErrs[source] {
		return
	}
	r.lastErrs[source] = msg
	if err != nil {
		r.Log.Warn("collector reported errors", "collector", source, "err", err)
	} else {
		r.Log.Info("collector recovered", "collector", source)
	}
}

// LimitSeries keeps groups in priority order until limit; a group that does not
// fit is truncated and all later groups are dropped. It returns the kept samples
// and the number dropped.
func LimitSeries(groups [][]metrics.Sample, limit int) ([]metrics.Sample, int) {
	var kept []metrics.Sample
	dropped := 0
	for _, g := range groups {
		room := limit - len(kept)
		switch {
		case room <= 0:
			dropped += len(g)
		case len(g) <= room:
			kept = append(kept, g...)
		default:
			kept = append(kept, g[:room]...)
			dropped += len(g) - room
		}
	}
	return kept, dropped
}

func (r *Runner) selfMetrics() []metrics.Sample {
	out := []metrics.Sample{
		metrics.New("watchlog_agent_info", 1, "version", r.Version, "mode", r.Mode),
		metrics.New("watchlog_agent_series", float64(r.lastSeries.Load())),
		metrics.New("watchlog_agent_series_dropped_total", float64(r.seriesDropped.Load())),
		metrics.New("watchlog_agent_batches_dropped_total", float64(r.expiredDropped.Load()), "reason", "expired"),
		metrics.New("watchlog_agent_batches_dropped_total", float64(r.fullDropped.Load()), "reason", "buffer_full"),
		metrics.New("watchlog_agent_send_duration_seconds", float64(r.Sender.Stats.LastDurationMicros.Load())/1e6),
	}
	byOutcome, byCode := r.Sender.Stats.Snapshot()
	for _, o := range []sender.Outcome{sender.Delivered, sender.Retry, sender.Paused, sender.Rejected} {
		out = append(out, metrics.New("watchlog_agent_send_requests_total", float64(byOutcome[o]), "outcome", o.String()))
	}
	for code, n := range byCode {
		out = append(out, metrics.New("watchlog_agent_batches_dropped_total", float64(n), "reason", "rejected", "code", strconv.Itoa(code)))
	}
	// Failed ingest requests, every endpoint (ADR-117): a backend answering 500 to one
	// kind of request is visible here, not only in the agent's log.
	for f, n := range r.Sender.Stats.Failures() {
		status := strconv.Itoa(f.Status)
		if f.Status == 0 {
			status = "network"
		}
		out = append(out, metrics.New("watchlog_agent_ingest_failures_total", float64(n), "endpoint", f.Endpoint, "status", status))
	}
	if files, bytes, err := r.Buffer.Stats(); err == nil {
		out = append(out,
			metrics.New("watchlog_agent_buffer_files", float64(files)),
			metrics.New("watchlog_agent_buffer_bytes", float64(bytes)),
		)
	}
	if rss, ok := readRSS("/proc/self/status"); ok {
		out = append(out, metrics.New("watchlog_agent_memory_rss_bytes", rss))
	}
	if cpu, ok := readCPUSeconds("/proc/self/stat"); ok {
		out = append(out, metrics.New("watchlog_agent_cpu_seconds_total", cpu))
	}
	return out
}

// readRSS returns VmRSS in bytes from /proc/self/status.
func readRSS(path string) (float64, bool) {
	b, err := os.ReadFile(path) //nolint:gosec // fixed /proc/self path; a parameter only for tests
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if rest, ok := strings.CutPrefix(line, "VmRSS:"); ok {
			f := strings.Fields(rest)
			if len(f) >= 1 {
				kb, err := strconv.ParseFloat(f[0], 64)
				return kb * 1024, err == nil
			}
		}
	}
	return 0, false
}

// readCPUSeconds returns utime+stime from /proc/self/stat (fields 14 and 15, in USER_HZ).
func readCPUSeconds(path string) (float64, bool) {
	b, err := os.ReadFile(path) //nolint:gosec // fixed /proc/self path; a parameter only for tests
	if err != nil {
		return 0, false
	}
	// The command name (field 2) may contain spaces; fields after it start past the last ')'.
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return 0, false
	}
	f := strings.Fields(s[i+1:])
	if len(f) < 13 {
		return 0, false
	}
	utime, err1 := strconv.ParseFloat(f[11], 64)
	stime, err2 := strconv.ParseFloat(f[12], 64)
	return (utime + stime) / 100, err1 == nil && err2 == nil
}
