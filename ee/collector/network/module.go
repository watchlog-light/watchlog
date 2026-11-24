// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

// Package network polls switches and routers from the integrations collector (ADR-233): SNMP
// (v3 by default, v2c allowed) with vendor profiles that are data, and MikroTik's RouterOS
// over REST or API-SSL with a pinned certificate. It only reads. It sends counters as
// watchlog_net_* series and posts each round's state and inventory to the backend.
package network

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/ext"
)

// Timing (ADR-233).
const (
	// Round is how often health and counters are read.
	Round = 60 * time.Second
	// InventoryEvery is how often ports, neighbours, MAC and ARP tables are read.
	InventoryEvery = 5 * time.Minute
	// Workers bounds the devices polled at once; each device has at most 2 requests in
	// flight (SNMP: one session, one at a time; REST: 2 connections).
	Workers = 16
	// FailuresBeforeBackoff: an unreachable device is still tried every round this many
	// times (the "unreachable after 3 polls" alert), then less often.
	FailuresBeforeBackoff = 3
	// BackoffFirst and BackoffMax: the wait after that doubles from 2 minutes to an hour,
	// as the Kafka probes' does (0.13).
	BackoffFirst = 2 * time.Minute
	BackoffMax   = time.Hour
	// ReportPath is the backend's ingest path for the rounds.
	ReportPath = "network/report"
)

func init() {
	ext.Register(ext.Module{Name: "network", Feature: "network", Run: Run})
}

// Run is the module's loop in the collector.
func Run(ctx context.Context, h ext.Host) {
	p, err := NewPoller(h.Log(), Dial, DialROS)
	if err != nil {
		h.Log().Error("network profiles", "err", err)
		return
	}
	p.Configure(h.Config())
	t := time.NewTicker(time.Second)
	defer t.Stop()
	next := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.Changed():
			p.Configure(h.Config())
			next = time.Now() // new devices or discoveries: start now
		case now := <-t.C:
			if now.Before(next) {
				continue
			}
			next = now.Add(Round)
			rep, samples := p.Round(ctx, now)
			if rep == nil {
				continue
			}
			if len(samples) > 0 {
				h.Send(samples, now)
			}
			rep.Host = h.HostName()
			pctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			if err := h.Post(pctx, ReportPath, rep); err != nil {
				h.Log().Warn("posting the network report", "err", err)
			}
			cancel()
		}
	}
}

// devState is a device's memory between rounds.
type devState struct {
	snmp     *snmpState
	ros      *rosState
	lastInv  time.Time
	failures int
	nextTry  time.Time
	key      string // the device's config, to start over when it changes
}

// Poller polls the configured devices, one round at a time.
type Poller struct {
	log      *slog.Logger
	dial     DialFunc
	dialROS  ROSDialFunc
	profiles Profiles

	mu      sync.Mutex
	cfg     Config
	states  map[string]*devState
	ran     map[string]bool // discoveries already run
	pending []DiscoveryReport
	disc    sync.WaitGroup
}

// NewPoller loads the profiles.
func NewPoller(log *slog.Logger, dial DialFunc, dialROS ROSDialFunc) (*Poller, error) {
	ps, err := LoadProfiles()
	if err != nil {
		return nil, err
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Poller{log: log, dial: dial, dialROS: dialROS, profiles: ps, states: map[string]*devState{}, ran: map[string]bool{}}, nil
}

// Configure takes the module's section of the configuration.
func (p *Poller) Configure(raw json.RawMessage) {
	var c Config
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &c); err != nil {
			p.log.Error("network configuration", "err", err)
			return
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cfg = c
	keep := map[string]bool{}
	for _, d := range c.Devices {
		keep[d.ID] = true
		key := d.Address + "|" + d.Protocol + "|" + d.Profile
		if st, ok := p.states[d.ID]; !ok || st.key != key {
			p.states[d.ID] = &devState{snmp: newSNMPState(), ros: newROSState(), key: key}
		}
	}
	for id := range p.states {
		if !keep[id] {
			delete(p.states, id)
		}
	}
}

// Round polls every device that is due, at most Workers at once, and returns the report
// and the series. Discoveries asked for run in the background and join a later report.
func (p *Poller) Round(ctx context.Context, now time.Time) (*Report, []Sample) {
	p.mu.Lock()
	devs := append([]Device(nil), p.cfg.Devices...)
	for _, d := range p.cfg.Discover {
		if !p.ran[d.ID] {
			p.ran[d.ID] = true
			p.disc.Add(1)
			go func(d Discovery) {
				defer p.disc.Done()
				p.discover(ctx, d)
			}(d)
		}
	}
	p.mu.Unlock()

	type result struct {
		rep     DeviceReport
		samples []Sample
	}
	results := make([]*result, len(devs))
	sem := make(chan struct{}, Workers)
	var wg sync.WaitGroup
	for i, d := range devs {
		p.mu.Lock()
		st := p.states[d.ID]
		p.mu.Unlock()
		if st == nil || d.Paused || now.Before(st.nextTry) {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, d Device, st *devState) {
			defer wg.Done()
			defer func() { <-sem }()
			defer func() {
				if r := recover(); r != nil {
					results[i] = &result{rep: DeviceReport{ID: d.ID, State: StateError, Error: "poller panic", PolledAt: now.UnixMilli()}}
				}
			}()
			inv := now.Sub(st.lastInv) >= InventoryEvery
			pctx, cancel := context.WithTimeout(ctx, Round)
			defer cancel()
			var rep DeviceReport
			var samples []Sample
			if d.Protocol == "routeros" {
				prof := p.profiles["mikrotik"]
				if d.Profile != "" && p.profiles[d.Profile] != nil {
					prof = p.profiles[d.Profile]
				}
				rep, samples = pollROS(pctx, p.dialROS, prof, d, st.ros, now, inv)
			} else {
				rep, samples = pollSNMP(pctx, p.dial, p.profiles, d, st.snmp, now, inv)
			}
			if rep.State == StateOK {
				st.failures, st.nextTry = 0, time.Time{}
				if rep.Inventory != nil {
					st.lastInv = now
				}
			} else {
				st.failures++
				rep.Failures = st.failures
				if st.failures >= FailuresBeforeBackoff {
					st.nextTry = now.Add(backoff(st.failures))
				}
				samples = []Sample{{Name: "watchlog_net_up", Labels: []Label{{Name: "device", Value: d.ID}}, Value: 0}}
			}
			results[i] = &result{rep: rep, samples: samples}
		}(i, d, st)
	}
	wg.Wait()

	rep := &Report{Devices: []DeviceReport{}}
	var samples []Sample
	for _, r := range results {
		if r == nil {
			continue
		}
		rep.Devices = append(rep.Devices, r.rep)
		samples = append(samples, r.samples...)
	}
	p.mu.Lock()
	rep.Discovery, p.pending = p.pending, nil
	p.mu.Unlock()
	if len(rep.Devices) == 0 && len(rep.Discovery) == 0 {
		return nil, samples
	}
	return rep, samples
}

// backoff is the wait after the n-th failure in a row (n ≥ 3).
func backoff(n int) time.Duration {
	d := BackoffFirst
	for i := FailuresBeforeBackoff; i < n && d < BackoffMax; i++ {
		d *= 2
	}
	return min(d, BackoffMax)
}

// WaitDiscoveries waits for the running discoveries (tests, the budget run).
func (p *Poller) WaitDiscoveries() { p.disc.Wait() }

func (p *Poller) addDiscovery(r DiscoveryReport) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := range p.pending {
		if p.pending[i].ID == r.ID {
			p.pending[i] = r
			return
		}
	}
	p.pending = append(p.pending, r)
}

var errNoCredential = errors.New("no credential answered")
