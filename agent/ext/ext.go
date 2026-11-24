// SPDX-License-Identifier: AGPL-3.0-only

// Package ext is how Enterprise packages (ee/collector, ADR-232, ADR-233) join the
// integrations collector: each registers itself from an init function, and the collector,
// built with the `ee` build tag, imports them. Without the tag, or with ee/ deleted, nothing
// registers and the collector is the core's alone.
//
// A module with a Run function is started by the collector. It gets its own section of the
// collector's configuration (the backend's `modules.<name>`, sent only when the org has the
// module's feature), sends samples through the collector's buffer under the collector's one
// series cap, and posts what it found to its own ingest path. The collector holds no licence
// logic: what a module works on is what the backend sends it.
package ext

import (
	"context"
	"encoding/json"
	"log/slog"
	"sort"
	"sync"
	"time"
)

// Module is one Enterprise package in the collector.
type Module struct {
	// Name, for logs and the configuration section: "network".
	Name string
	// Feature is the licence feature the backend checks before sending its section.
	Feature string
	// Run works until ctx is cancelled; nil for a module that only registers.
	Run func(ctx context.Context, h Host)
}

// Sample is one series value, as a module builds it.
type Sample struct {
	Name   string
	Labels []Label
	Value  float64
}

// Label is one series label.
type Label struct{ Name, Value string }

// Host is what the collector gives a running module.
type Host interface {
	// Config is the module's section of the latest configuration, nil when there is none.
	Config() json.RawMessage
	// Changed receives a value each time the section changes.
	Changed() <-chan struct{}
	// Send buffers samples for remote write at a time; beyond the collector's series cap
	// the rest are dropped (and logged). It returns how many were kept.
	Send(samples []Sample, at time.Time) int
	// Post sends a JSON body to the backend's ingest API, path relative to /ingest/v1
	// ("network/report"), with the collector's token.
	Post(ctx context.Context, path string, body any) error
	// Mode is "kubernetes" or "docker" (a server); HostName the server's name ('' on
	// Kubernetes).
	Mode() string
	HostName() string
	Log() *slog.Logger
}

var (
	mu      sync.Mutex
	modules = map[string]Module{}
)

// Register adds a module; registering a name twice keeps the last.
func Register(m Module) {
	mu.Lock()
	defer mu.Unlock()
	modules[m.Name] = m
}

// Modules returns the registered modules, by name.
func Modules() []Module {
	mu.Lock()
	defer mu.Unlock()
	out := make([]Module, 0, len(modules))
	for _, m := range modules {
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Names returns the registered modules' names, by name.
func Names() []string {
	ms := Modules()
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = m.Name
	}
	return out
}

// Unregister removes a module (tests).
func Unregister(name string) {
	mu.Lock()
	defer mu.Unlock()
	delete(modules, name)
}
