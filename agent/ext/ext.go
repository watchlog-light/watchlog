// SPDX-License-Identifier: AGPL-3.0-only

// Package ext is how Enterprise packages (ee/collector, ADR-232) join the integrations
// collector: each registers itself from an init function, and the collector, built with the
// `ee` build tag, imports them. Without the tag, or with ee/ deleted, nothing registers and
// the collector is the core's alone. The collector holds no licence logic: what it polls is
// what the backend sends it, and the backend sends a licensed feature's targets only while
// the licence lists that feature.
package ext

import (
	"sort"
	"sync"
)

// Module is one Enterprise package in the collector.
type Module struct {
	// Name, for logs: "network".
	Name string
	// Feature is the licence feature the backend checks before sending its targets.
	Feature string
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
