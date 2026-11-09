// SPDX-License-Identifier: AGPL-3.0-only

package integrations

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

// ProbeEvery is how often a pending probe is tried (ADR-134: every 5 s for 15 minutes;
// the backend drops it from the configuration when it works or expires).
const ProbeEvery = 5 * time.Second

// probeLoop tries every pending probe every ProbeEvery, and at once when one is new or
// "Check now" was pressed, and posts what it found.
func (c *Collector) probeLoop(ctx context.Context) {
	t := time.NewTicker(ProbeEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-c.probeWake:
		}
		cfg := c.cfg.Load()
		if cfg == nil || len(cfg.Probes) == 0 {
			continue
		}
		c.RunProbes(ctx, cfg.Probes)
	}
}

// RunProbes tries each probe once, in parallel, and posts the results.
func (c *Collector) RunProbes(ctx context.Context, probes []Probe) []ProbeResult {
	results := make([]ProbeResult, len(probes))
	sem := make(chan struct{}, Parallel)
	var wg sync.WaitGroup
	for i, p := range probes {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			results[i] = c.probe(ctx, p)
		}()
	}
	wg.Wait()
	body, err := json.Marshal(ProbeResults{Host: c.Host, Results: results})
	if err == nil && c.ProbesURL != "" {
		if outcome := c.Sender.PostJSON(ctx, "integrations-probes", c.ProbesURL, body); outcome != sender.Delivered {
			c.Log.Debug("probe results not delivered", "outcome", outcome.String())
		}
	}
	return results
}

func (c *Collector) probe(ctx context.Context, p Probe) ProbeResult {
	ctx, cancel := context.WithTimeout(ctx, ScrapeTimeout)
	defer cancel()
	out := ProbeResult{ID: p.ID}
	auth, err := c.resolve(ctx, p.Credential)
	if err != nil {
		out.Error = trim(err.Error())
		return out
	}
	res := c.safeScrape(ctx, Target{ID: p.ID, Type: p.Type, Name: p.ID, Members: p.Members, Auth: auth}, false)
	out.OK = res.State == StateOK || res.State == ""
	out.Error = trim(res.Error)
	out.Version = res.ServiceVersion
	out.Facts = res.Facts
	out.Excess = res.Excess
	return out
}

func trim(s string) string {
	if len(s) > maxErrorLen {
		return s[:maxErrorLen]
	}
	return s
}

func (c *Collector) resolve(ctx context.Context, cred *Credential) (*Auth, error) {
	if cred == nil {
		return nil, nil
	}
	return c.creds().Resolve(ctx, cred)
}

// creds returns the credential resolver, made once: probes and scrapes call it from
// several goroutines at a time.
func (c *Collector) creds() *Credentials {
	c.credsOnce.Do(func() {
		if c.Credentials == nil {
			c.Credentials = &Credentials{}
		}
	})
	return c.Credentials
}

// probesChanged tells whether cfg has a probe that is new or was asked again.
func (c *Collector) probesChanged(cfg *Config) bool {
	changed := false
	seen := make(map[string]string, len(cfg.Probes))
	for _, p := range cfg.Probes {
		seen[p.ID] = p.Requested
		if prev, ok := c.probeSeen[p.ID]; !ok || prev != p.Requested {
			changed = true
		}
	}
	c.probeSeen = seen
	return changed
}
