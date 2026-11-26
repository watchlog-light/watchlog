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
	// PartialEvery is how often a running discovery's progress is reported between rounds;
	// RetryFound is the wait before offering again what couldn't be posted.
	PartialEvery = 5 * time.Second
	RetryFound   = 5 * time.Second
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
	defer p.Close()
	p.Configure(h.Config())
	t := time.NewTicker(time.Second)
	defer t.Stop()
	next := time.Now()
	var retry time.Time // when to offer again what couldn't be posted
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.Changed():
			p.Configure(h.Config())
			next = time.Now() // new devices or discoveries: start now
		case <-p.Ready():
			// A discovery or a profile's test has something to say (1.0.2): it is reported
			// at once, not with the next round, so "Test against an address" answers in
			// seconds.
			found := p.TakeDiscoveries()
			if len(found) == 0 {
				continue
			}
			rep := &Report{Host: h.HostName(), Devices: []DeviceReport{}, Discovery: found}
			pctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			if err := h.Post(pctx, ReportPath, rep); err != nil {
				// Refused for now (the ingest's rate limit) or unreachable: tried again
				// shortly, and with the next round at the latest.
				h.Log().Warn("posting what a discovery found", "err", err)
				p.requeue(found)
				retry = time.Now().Add(RetryFound)
			}
			cancel()
		case now := <-t.C:
			if !retry.IsZero() && !now.Before(retry) {
				retry = time.Time{}
				p.signal()
			}
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
	dahua    *dahuaState
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
	// dialDahua and now are the recorders' client and their event streams' clock (tests
	// set them with SetDahua).
	dialDahua DahuaDialFunc
	now       func() time.Time

	mu      sync.Mutex
	cfg     Config
	states  map[string]*devState
	ran     map[string]bool // discoveries already run
	pending []DiscoveryReport
	ready   chan struct{} // a discovery has something to report
	// lastPartial is when a running discovery's progress was last offered.
	lastPartial time.Time
	disc        sync.WaitGroup
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
	return &Poller{
		log: log, dial: dial, dialROS: dialROS, dialDahua: DialDahua, now: time.Now, profiles: ps,
		states: map[string]*devState{}, ran: map[string]bool{}, ready: make(chan struct{}, 1),
	}, nil
}

// SetDahua sets how recorders are reached and their event streams' clock (tests, before
// Configure).
func (p *Poller) SetDahua(dial DahuaDialFunc, now func() time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if dial != nil {
		p.dialDahua = dial
	}
	if now != nil {
		p.now = now
	}
}

// Close stops the recorders' event streams.
func (p *Poller) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for id, st := range p.states {
		st.dahua.close()
		delete(p.states, id)
	}
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
		if d.Protocol == "dahua" {
			key += "|" + dahuaKey(d)
		}
		if st, ok := p.states[d.ID]; !ok || st.key != key {
			if ok {
				st.dahua.close()
			}
			ns := &devState{snmp: newSNMPState(), ros: newROSState(), key: key}
			if d.Protocol == "dahua" {
				ns.dahua = newDahuaState()
				if !d.Paused {
					// One event stream per recorder, for as long as it is configured so.
					ns.dahua.stream = newDahuaStream(p.now)
					ns.dahua.stream.start(p.dialDahua, d)
				}
			}
			p.states[d.ID] = ns
		}
	}
	for id, st := range p.states {
		if !keep[id] {
			st.dahua.close()
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
			switch d.Protocol {
			case "routeros":
				prof := p.profiles["mikrotik"]
				if d.Profile != "" && p.profiles[d.Profile] != nil {
					prof = p.profiles[d.Profile]
				}
				rep, samples = pollROS(pctx, p.dialROS, prof, d, st.ros, now, inv)
			case "dahua":
				rep, samples = pollDahua(pctx, p.dialDahua, p.profiles["dahua"], d, st.dahua, now, inv)
			default:
				rep, samples = pollSNMP(pctx, p.dial, p.profiles, d, st.snmp, now, inv)
			}
			if rep.State == StateOK {
				st.failures, st.nextTry = 0, time.Time{}
				if rep.Inventory != nil || (inv && d.Protocol == "dahua") {
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

// Ready fires when a discovery has something to report.
func (p *Poller) Ready() <-chan struct{} { return p.ready }

// TakeDiscoveries hands over what the discoveries found since the last report.
func (p *Poller) TakeDiscoveries() []DiscoveryReport {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := p.pending
	p.pending = nil
	return out
}

// addDiscovery queues what a discovery found (its latest state replaces an earlier one that
// wasn't sent yet). A finished one is offered at once; one still running at most every
// PartialEvery, so a discovery doesn't spend the collector's ingest budget on its progress.
func (p *Poller) addDiscovery(r DiscoveryReport) {
	p.mu.Lock()
	replaced := false
	for i := range p.pending {
		if p.pending[i].ID == r.ID {
			p.pending[i] = r
			replaced = true
		}
	}
	if !replaced {
		p.pending = append(p.pending, r)
	}
	now := time.Now()
	offer := r.Done || now.Sub(p.lastPartial) >= PartialEvery
	if offer && !r.Done {
		p.lastPartial = now
	}
	p.mu.Unlock()
	if offer {
		p.signal()
	}
}

// signal says there is something to report, without waiting for anyone to listen.
func (p *Poller) signal() {
	select {
	case p.ready <- struct{}{}:
	default:
	}
}

// requeue puts back what couldn't be sent, for the next round; a newer state of the same
// discovery queued meanwhile wins.
func (p *Poller) requeue(rs []DiscoveryReport) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, r := range rs {
		newer := false
		for i := range p.pending {
			newer = newer || p.pending[i].ID == r.ID
		}
		if !newer {
			p.pending = append(p.pending, r)
		}
	}
}

var errNoCredential = errors.New("no credential answered")
