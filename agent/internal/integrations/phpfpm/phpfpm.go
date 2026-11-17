// SPDX-License-Identifier: AGPL-3.0-only

// Package phpfpm is the PHP-FPM integration (ADR-212): a pool's status page, read over
// FastCGI from the pool's own listener or its status listener (pm.status_listen), as
// JSON. One request a scrape, `GET <status path>?json&full`; nothing else is executed.
// From the full view only numbers leave: request durations and memory per process,
// summarised per pool. A request's URI, query string, script path and user stay here.
package phpfpm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// StatusPaths are tried in order until one answers; the documented one first.
var StatusPaths = []string{"/status", "/fpm-status", "/php-fpm-status"}

// Recheck is how long a member's missing status page is remembered.
const Recheck = 2 * time.Minute

// MaxBody bounds one status page (a pool of a few hundred processes is about 100 KB).
const MaxBody = 4 << 20

// Status is the pool's status page as JSON (`?json&full`).
type Status struct {
	Pool               string    `json:"pool"`
	ProcessManager     string    `json:"process manager"`
	StartTime          float64   `json:"start time"`
	AcceptedConn       float64   `json:"accepted conn"`
	ListenQueue        float64   `json:"listen queue"`
	MaxListenQueue     float64   `json:"max listen queue"`
	ListenQueueLen     float64   `json:"listen queue len"`
	IdleProcesses      float64   `json:"idle processes"`
	ActiveProcesses    float64   `json:"active processes"`
	TotalProcesses     float64   `json:"total processes"`
	MaxActiveProcesses float64   `json:"max active processes"`
	MaxChildrenReached float64   `json:"max children reached"`
	SlowRequests       float64   `json:"slow requests"`
	Processes          []Process `json:"processes"`
}

// Process is one worker in the full view; only its numbers are read.
type Process struct {
	State string `json:"state"`
	// RequestDuration is the current request's (Running) or the last one's, in µs.
	RequestDuration   float64 `json:"request duration"`
	LastRequestMemory float64 `json:"last request memory"`
	Requests          float64 `json:"requests"`
}

// PHPFPM is the integration; it remembers which status path each member answers on.
type PHPFPM struct {
	mu    sync.Mutex
	paths map[string]memberPath
	// Now and Dial are replaced in tests.
	Now  func() time.Time
	Dial func(ctx context.Context, network, address string) (net.Conn, error)
}

type memberPath struct {
	path    string
	missing time.Time
}

// New returns the integration.
func New() *PHPFPM {
	return &PHPFPM{paths: map[string]memberPath{}, Now: time.Now}
}

// Scrape implements integrations.Integration.
func (p *PHPFPM) Scrape(ctx context.Context, t integrations.Target, _ bool) integrations.Result {
	res := integrations.Result{State: integrations.StateOK}
	up := 0
	var pools []map[string]any
	for _, m := range t.Members {
		st, samples, ms := p.member(ctx, m)
		res.Members = append(res.Members, ms)
		// Up but without its status page is still an error for the service: nothing to read.
		if !ms.Up || st == nil {
			continue
		}
		up++
		res.Samples = append(res.Samples, samples...)
		if st != nil {
			pools = append(pools, map[string]any{
				"pool": st.Pool, "pm": st.ProcessManager, "processes": st.TotalProcesses,
			})
		}
	}
	res.Extra = map[string]any{"pools": pools}
	if len(pools) > 0 {
		res.Facts = map[string]any{"pool": pools[0]["pool"], "pm": pools[0]["pm"], "processes": pools[0]["processes"]}
	}
	switch {
	case len(t.Members) == 0:
		res.State, res.Error = integrations.StateError, "no member to connect to"
	case up == 0:
		res.State, res.Error = integrations.StateError, res.Members[0].Error
	}
	return res
}

// Probe implements integrations.Prober: PHP-FPM needs no user; the test reads the status page.
func (p *PHPFPM) Probe(ctx context.Context, t integrations.Target) integrations.ProbeResult {
	r := p.Scrape(ctx, t, false)
	out := integrations.ProbeResult{Code: integrations.ProbeOK, Facts: r.Facts}
	if r.State != integrations.StateOK {
		out.Code, out.Error = integrations.ProbeUnreachable, r.Error
	}
	return out
}

// ErrNoStatus is a pool that answers FastCGI but has no status page.
var ErrNoStatus = errors.New("the pool's status page is off: set pm.status_path = /status in the pool's configuration (and pm.status_listen = 127.0.0.1:9001 when the pool listens on a socket), then reload PHP-FPM")

func (p *PHPFPM) member(ctx context.Context, m integrations.Member) (*Status, []metrics.Sample, integrations.MemberStatus) {
	ms := integrations.MemberStatus{Name: m.Name}
	key := m.Name + "\x00" + m.Address
	p.mu.Lock()
	known := p.paths[key]
	p.mu.Unlock()
	now := p.Now()
	paths := StatusPaths
	if known.path != "" {
		paths = []string{known.path}
	} else if !known.missing.IsZero() && now.Sub(known.missing) < Recheck {
		ms.Error = ErrNoStatus.Error()
		// Still say whether the pool answers at all.
		if conn, err := p.dial(ctx, m.Address); err == nil {
			_ = conn.Close()
			ms.Up = true
		}
		return nil, nil, ms
	}
	start := time.Now()
	var lastErr error
	for _, path := range paths {
		st, err := p.status(ctx, m.Address, path)
		if err == nil {
			p.mu.Lock()
			p.paths[key] = memberPath{path: path}
			p.mu.Unlock()
			ms.Up = true
			samples := Samples(st)
			samples = append(samples, metrics.New("watchlog_integration_connect_seconds", time.Since(start).Seconds()))
			for i := range samples {
				samples[i] = samples[i].WithLabels(metrics.Label{Name: "member", Value: m.Name})
			}
			return st, samples, ms
		}
		lastErr = err
		var ne *net.OpError
		if errors.As(err, &ne) {
			break // unreachable: no other path will answer
		}
	}
	if errors.Is(lastErr, ErrNoStatus) {
		p.mu.Lock()
		p.paths[key] = memberPath{missing: now}
		p.mu.Unlock()
		ms.Up = true
	} else {
		p.mu.Lock()
		delete(p.paths, key)
		p.mu.Unlock()
	}
	ms.Error = shortError(lastErr)
	return nil, nil, ms
}

func (p *PHPFPM) dial(ctx context.Context, address string) (net.Conn, error) {
	network, addr := "tcp", address
	if strings.HasPrefix(address, "unix:") {
		network, addr = "unix", strings.TrimPrefix(address, "unix:")
	}
	if p.Dial != nil {
		return p.Dial(ctx, network, addr)
	}
	d := net.Dialer{Timeout: integrations.DialTimeout}
	return d.DialContext(ctx, network, addr)
}

func (p *PHPFPM) status(ctx context.Context, address, path string) (*Status, error) {
	conn, err := p.dial(ctx, address)
	if err != nil {
		return nil, err
	}
	defer func() { _ = conn.Close() }()
	deadline := time.Now().Add(integrations.DialTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)
	code, body, err := Get(conn, path, "json&full")
	if err != nil {
		return nil, err
	}
	// "File not found." or "Access denied." with 404/403: no status page at that path.
	if code == 404 || code == 403 {
		return nil, ErrNoStatus
	}
	if code != 200 {
		return nil, fmt.Errorf("the status page answered HTTP %d", code)
	}
	var st Status
	if err := json.Unmarshal(body, &st); err != nil {
		return nil, ErrNoStatus // a PHP script at that path, not the status page
	}
	if st.Pool == "" {
		return nil, ErrNoStatus
	}
	return &st, nil
}

// Samples turns a status page into watchlog_phpfpm_* series, labelled by pool.
func Samples(st *Status) []metrics.Sample {
	pool := []string{"pool", st.Pool}
	l := func(extra ...string) []string { return append(append([]string{}, pool...), extra...) }
	out := []metrics.Sample{
		metrics.New("watchlog_phpfpm_accepted_connections_total", st.AcceptedConn, l()...),
		metrics.New("watchlog_phpfpm_listen_queue", st.ListenQueue, l()...),
		metrics.New("watchlog_phpfpm_listen_queue_max", st.MaxListenQueue, l()...),
		metrics.New("watchlog_phpfpm_listen_queue_length", st.ListenQueueLen, l()...),
		metrics.New("watchlog_phpfpm_processes", st.IdleProcesses, l("state", "idle")...),
		metrics.New("watchlog_phpfpm_processes", st.ActiveProcesses, l("state", "active")...),
		metrics.New("watchlog_phpfpm_processes_max_active", st.MaxActiveProcesses, l()...),
		metrics.New("watchlog_phpfpm_max_children_reached_total", st.MaxChildrenReached, l()...),
		metrics.New("watchlog_phpfpm_slow_requests_total", st.SlowRequests, l()...),
		metrics.New("watchlog_phpfpm_start_time_seconds", st.StartTime, l()...),
		metrics.New("watchlog_phpfpm_info", 1, l("pm", st.ProcessManager)...),
	}
	if len(st.Processes) == 0 {
		return out
	}
	durations := make([]float64, 0, len(st.Processes))
	var memMax float64
	for _, pr := range st.Processes {
		if pr.Requests > 0 || strings.EqualFold(pr.State, "Running") {
			durations = append(durations, pr.RequestDuration/1e6)
		}
		if pr.LastRequestMemory > memMax {
			memMax = pr.LastRequestMemory
		}
	}
	if len(durations) > 0 {
		sort.Float64s(durations)
		q := func(f float64) float64 { return durations[int(f*float64(len(durations)-1)+0.5)] }
		out = append(out,
			metrics.New("watchlog_phpfpm_request_duration_seconds", q(0.5), l("quantile", "0.5")...),
			metrics.New("watchlog_phpfpm_request_duration_seconds", q(0.95), l("quantile", "0.95")...),
			metrics.New("watchlog_phpfpm_request_duration_seconds", durations[len(durations)-1], l("quantile", "1")...),
		)
	}
	out = append(out, metrics.New("watchlog_phpfpm_request_memory_bytes_max", memMax, l()...))
	return out
}

func shortError(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, ErrNoStatus) {
		return err.Error()
	}
	var ne *net.OpError
	if errors.As(err, &ne) && ne.Err != nil {
		return "can't connect: " + ne.Err.Error()
	}
	s := err.Error()
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}
