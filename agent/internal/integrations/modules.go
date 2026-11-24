// SPDX-License-Identifier: AGPL-3.0-only

package integrations

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/watchlog-light/watchlog/agent/ext"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
	"github.com/watchlog-light/watchlog/agent/internal/remotewrite"
	"github.com/watchlog-light/watchlog/agent/internal/runner"
)

// moduleHost is what one Enterprise module (agent/ext, ADR-233) gets from the collector: its
// configuration section, the collector's buffer under the one series cap, and posts to its
// ingest path with the collector's token.
type moduleHost struct {
	c       *Collector
	name    string
	section atomic.Pointer[json.RawMessage]
	changed chan struct{}
	series  atomic.Int64
}

var _ ext.Host = (*moduleHost)(nil)

func (h *moduleHost) Config() json.RawMessage {
	if p := h.section.Load(); p != nil {
		return *p
	}
	return nil
}

func (h *moduleHost) Changed() <-chan struct{} { return h.changed }
func (h *moduleHost) Mode() string             { return h.c.Mode }
func (h *moduleHost) HostName() string         { return h.c.Host }
func (h *moduleHost) Log() *slog.Logger        { return h.c.Log.With("module", h.name) }

// set stores a new section; a change wakes the module.
func (h *moduleHost) set(raw json.RawMessage) {
	old := h.Config()
	if bytes.Equal(old, raw) {
		return
	}
	cp := append(json.RawMessage(nil), raw...)
	h.section.Store(&cp)
	select {
	case h.changed <- struct{}{}:
	default:
	}
}

// Send buffers the samples within what the collector's series cap leaves: the integrations'
// last scrape and the other modules count first.
func (h *moduleHost) Send(samples []ext.Sample, at time.Time) int {
	room := SeriesCap - int(h.c.lastSeries.Load()) - h.c.otherModuleSeries(h)
	if room < 0 {
		room = 0
	}
	if len(samples) > room {
		h.Log().Warn("series cap reached; the rest of this poll is dropped", "series", len(samples), "kept", room, "cap", SeriesCap)
		samples = samples[:room]
	}
	h.series.Store(int64(len(samples)))
	out := make([]metrics.Sample, len(samples))
	for i, s := range samples {
		labels := make([]metrics.Label, len(s.Labels))
		for j, l := range s.Labels {
			labels[j] = metrics.Label{Name: l.Name, Value: l.Value}
		}
		out[i] = metrics.Sample{Name: s.Name, Labels: labels, Value: s.Value}
	}
	for start := 0; start < len(out); start += runner.BatchSeries {
		body := remotewrite.Encode(out[start:min(start+runner.BatchSeries, len(out))], at.UnixMilli())
		if _, err := h.c.Buffer.Put(body); err != nil {
			h.Log().Error("buffering batch", "err", err)
		}
	}
	return len(out)
}

// maxModuleReply bounds what the collector reads of a module post's answer.
const maxModuleReply = 1 << 20

// Post sends body to /ingest/v1/<path> with the collector's token; the answer's body, when
// JSON, is decoded into nothing (a module that needs it posts through its own client).
func (h *moduleHost) Post(ctx context.Context, path string, body any) error {
	if h.c.Config == nil {
		return fmt.Errorf("no backend configured")
	}
	base := strings.TrimSuffix(h.c.Config.URL, "integrations/config")
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+strings.TrimPrefix(path, "/"), bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.c.Config.Token)
	req.Header.Set("User-Agent", h.c.Config.UserAgent)
	req.Header.Set("X-WatchLog-Agent", h.c.Config.AgentID)
	client := h.c.Config.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return redact(err, h.c.Config.Token)
	}
	defer func() { _ = res.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxModuleReply))
	if res.StatusCode >= 300 {
		return fmt.Errorf("%s answered %d", path, res.StatusCode)
	}
	return nil
}

type moduleSet struct {
	mu    sync.Mutex
	hosts map[string]*moduleHost
}

// startModules starts every registered module that runs, once.
func (c *Collector) startModules(ctx context.Context) {
	c.mods.mu.Lock()
	defer c.mods.mu.Unlock()
	if c.mods.hosts != nil {
		return
	}
	c.mods.hosts = map[string]*moduleHost{}
	for _, m := range ext.Modules() {
		if m.Run == nil {
			continue
		}
		h := &moduleHost{c: c, name: m.Name, changed: make(chan struct{}, 1)}
		c.mods.hosts[m.Name] = h
		if cfg := c.cfg.Load(); cfg != nil {
			h.set(cfg.Modules[m.Name])
		}
		go func() {
			defer func() {
				if r := recover(); r != nil {
					c.Log.Error("module stopped", "module", m.Name, "panic", r)
				}
			}()
			m.Run(ctx, h)
		}()
		c.Log.Info("enterprise module started", "module", m.Name)
	}
}

// configureModules hands each running module its section of a new configuration.
func (c *Collector) configureModules(cfg *Config) {
	c.mods.mu.Lock()
	defer c.mods.mu.Unlock()
	for name, h := range c.mods.hosts {
		h.set(cfg.Modules[name])
	}
}

// moduleSeries is what the modules sent last, for the status and the cap.
func (c *Collector) moduleSeries() int {
	return c.otherModuleSeries(nil)
}

func (c *Collector) otherModuleSeries(except *moduleHost) int {
	c.mods.mu.Lock()
	defer c.mods.mu.Unlock()
	n := 0
	for _, h := range c.mods.hosts {
		if h != except {
			n += int(h.series.Load())
		}
	}
	return n
}
