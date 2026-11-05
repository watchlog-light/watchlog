// SPDX-License-Identifier: AGPL-3.0-only

// Package kubepods collects per-container and per-pod metrics on a Kubernetes node
// (SPEC §6.3): usage from cgroups (ADR-050), storage and network from the kubelet's
// /stats/summary (ADR-051), names from the cluster-agent's pod map (ADR-049).
package kubepods

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/collectors/containers"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
	"github.com/watchlog-light/watchlog/agent/internal/podmap"
)

// Hold and refresh timing (ADR-049).
const (
	// Hold is how long series of a container or pod without a mapping are kept
	// back; then they are dropped and counted as unmapped.
	Hold = 60 * time.Second
	// MapRefresh is the regular pod map refresh; unknown pods trigger one sooner,
	// at most every MapRetry.
	MapRefresh = 15 * time.Second
	MapRetry   = 5 * time.Second
	maxHeld    = 8 // scrapes kept per held key
	// SandboxProof: a container of a known pod that is still missing from a map
	// fetched this long after the cgroup appeared is the pod's sandbox (or an old
	// instance), not a container waiting for its name.
	SandboxProof = 10 * time.Second
)

// Maps is the pod map source (*podmap.Client).
type Maps interface {
	Last() *podmap.Map
	Fetch(ctx context.Context) (*podmap.Map, error)
}

// Cgroups is the container cgroup reader (*containers.Reader).
type Cgroups interface {
	PodContainers() ([]containers.PodContainer, []string, error)
	PodContainerStats(containers.PodContainer) (containers.Stats, error)
}

// Summary fetches the kubelet's /stats/summary (*Kubelet); nil disables it.
type Summary interface {
	Fetch(ctx context.Context) (*StatsSummary, error)
}

type held struct {
	since   time.Time
	samples [][]metrics.Sample // one slice per scrape, labels added on release
	// What the pod map must name to release the samples: a pod UID (or config hash)
	// and, for container keys, the container ID.
	podID, containerID string
}

// Collector implements the pod metrics source of the node agent.
type Collector struct {
	cgroups Cgroups
	maps    Maps
	summary Summary
	log     *slog.Logger
	now     func() time.Time

	mu        sync.Mutex
	lastFetch time.Time
	mapOK     time.Time // last successful fetch (200 or 304)
	wantMap   bool
	lastErr   string
	idx       podmap.Index
	idxOf     *podmap.Map
	held      map[string]*held
	given     map[string]bool // keys given up on (counted once)
	sandboxes map[string]bool // container keys recognised as sandboxes (not counted)
	unmapped  int64
}

// New returns a collector; summary may be nil.
func New(cg Cgroups, maps Maps, summary Summary, log *slog.Logger) *Collector {
	return &Collector{cgroups: cg, maps: maps, summary: summary, log: log, now: time.Now,
		held: map[string]*held{}, given: map[string]bool{}, sandboxes: map[string]bool{}}
}

func (c *Collector) index(ctx context.Context, now time.Time) podmap.Index {
	m := c.maps.Last()
	if now.Sub(c.lastFetch) >= MapRefresh || (c.wantMap && now.Sub(c.lastFetch) >= MapRetry) {
		c.lastFetch, c.wantMap = now, false
		fetched, err := c.maps.Fetch(ctx)
		if fetched != nil {
			m = fetched
		}
		if err == nil {
			c.mapOK = now
		}
		msg := ""
		if err != nil {
			msg = err.Error()
		}
		if msg != c.lastErr {
			c.lastErr = msg
			if err != nil {
				c.log.Warn("pod map unavailable; using the last known map", "err", err)
			} else {
				c.log.Info("pod map available", "pods", len(m.Pods))
			}
		}
	}
	if m != c.idxOf {
		c.idxOf, c.idx = m, nil
		if m != nil {
			c.idx = m.Index()
		}
	}
	return c.idx
}

// release labels samples of a mapped key, including those held back earlier.
func (c *Collector) release(key string, labels []metrics.Label, now []metrics.Sample) []metrics.Sample {
	var out []metrics.Sample
	if h := c.held[key]; h != nil {
		for _, scrape := range h.samples {
			for _, s := range scrape {
				out = append(out, s.WithLabels(labels...))
			}
		}
		delete(c.held, key)
	}
	for _, s := range now {
		out = append(out, s.WithLabels(labels...))
	}
	return out
}

// hold keeps samples of an unmapped key with their own timestamps; after Hold they
// are dropped and the key is counted once.
func (c *Collector) hold(key, podID, containerID string, samples []metrics.Sample, now time.Time) {
	c.wantMap = true
	h := c.held[key]
	if h == nil {
		h = &held{since: now, podID: podID, containerID: containerID}
		c.held[key] = h
	}
	if now.Sub(h.since) > Hold {
		delete(c.held, key)
		c.given[key] = true
		c.unmapped++
		c.log.Info("no pod map entry after the hold; series dropped", "key", key, "held_since", h.since.Format(time.TimeOnly))
		return
	}
	ts := now.UnixMilli()
	stamped := make([]metrics.Sample, len(samples))
	for i, s := range samples {
		s.TimestampMs = ts
		stamped[i] = s
	}
	h.samples = append(h.samples, stamped)
	if len(h.samples) > maxHeld {
		h.samples = h.samples[1:]
	}
}

func podLabels(p *podmap.Pod, container string) []metrics.Label {
	l := []metrics.Label{{Name: "namespace", Value: p.Namespace}, {Name: "pod", Value: p.Name}}
	if container != "" {
		l = append(l, metrics.Label{Name: "container", Value: container})
	}
	return append(l, metrics.Label{Name: "workload_kind", Value: p.WorkloadKind}, metrics.Label{Name: "workload", Value: p.Workload})
}

func containerSamples(st containers.Stats) []metrics.Sample {
	out := []metrics.Sample{
		metrics.New("watchlog_container_cpu_seconds_total", st.CPUSeconds),
		metrics.New("watchlog_container_cpu_throttled_seconds_total", st.CPUThrottledSeconds),
		metrics.New("watchlog_container_memory_working_set_bytes", st.MemoryWorkingSet),
		metrics.New("watchlog_container_fs_io_bytes_total", st.IOReadBytes, "dir", "read"),
		metrics.New("watchlog_container_fs_io_bytes_total", st.IOWriteBytes, "dir", "write"),
	}
	if st.CPULimitCores != nil {
		out = append(out, metrics.New("watchlog_container_cpu_limit_cores", *st.CPULimitCores))
	}
	if st.MemoryLimit != nil {
		out = append(out, metrics.New("watchlog_container_memory_limit_bytes", *st.MemoryLimit))
	}
	return out
}

// Collect returns container and pod series of this node. Pod UIDs and container
// IDs are never labels; series without a mapping are held, then dropped (ADR-049).
func (c *Collector) Collect() ([]metrics.Sample, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	idx := c.index(ctx, now)
	var out []metrics.Sample
	var errs []error
	seen := map[string]bool{}

	found, unrecognized, err := c.cgroups.PodContainers()
	if err != nil {
		errs = append(errs, fmt.Errorf("pod cgroups: %w", err))
	}
	for _, pc := range found {
		if pc.Sandbox {
			continue
		}
		key := "c:" + pc.ContainerID
		seen[key] = true
		if c.sandboxes[key] {
			continue
		}
		// A key given up on while the pod map was unavailable (measured on kind: an
		// outage longer than Hold) comes back as soon as the map names it.
		if c.given[key] {
			if p := idx[pc.PodID]; p == nil || p.Containers[pc.ContainerID] == "" {
				continue
			}
			delete(c.given, key)
		}
		// Measured on kind: without hostPID, cgroup.procs shows no PIDs of other
		// pods (PID namespace translation), so "pause" cannot be read and sandboxes
		// are recognised here instead: their pod is in the map, their ID never is.
		if p := idx[pc.PodID]; p != nil && p.Containers[pc.ContainerID] == "" {
			if h := c.held[key]; h != nil && c.mapOK.Sub(h.since) >= SandboxProof {
				delete(c.held, key)
				c.sandboxes[key] = true
				continue
			}
		}
		st, err := c.cgroups.PodContainerStats(pc)
		if errors.Is(err, containers.ErrNotFound) {
			continue
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("cgroup of %s: %w", pc.ContainerID[:12], err))
			continue
		}
		samples := containerSamples(st)
		if p := idx[pc.PodID]; p != nil && p.Containers[pc.ContainerID] != "" {
			out = append(out, c.release(key, podLabels(p, p.Containers[pc.ContainerID]), samples)...)
		} else {
			c.hold(key, pc.PodID, pc.ContainerID, samples, now)
		}
	}
	for _, id := range unrecognized {
		key := "c:" + id
		seen[key] = true
		if !c.given[key] {
			c.given[key] = true
			c.unmapped++
		}
	}

	if c.summary != nil {
		s, err := c.summary.Fetch(ctx)
		if err != nil {
			errs = append(errs, fmt.Errorf("kubelet summary: %w", err))
		} else {
			for _, p := range s.Pods {
				key := "p:" + p.PodRef.UID
				seen[key] = true
				if c.given[key] {
					if idx[p.PodRef.UID] == nil {
						continue
					}
					delete(c.given, key)
				}
				samples := p.samples()
				if m := idx[p.PodRef.UID]; m != nil {
					out = append(out, c.release(key, podLabels(m, ""), samples)...)
				} else {
					c.hold(key, p.PodRef.UID, "", samples, now)
				}
			}
		}
	}

	// A held key whose cgroup or pod is gone keeps its samples for the rest of the
	// hold: a container that lived a few seconds (an OOM kill in a crash loop,
	// measured on kind) is named by the map's last-terminated IDs a moment later.
	for key, h := range c.held {
		if seen[key] {
			continue
		}
		if p := idx[h.podID]; p != nil {
			if h.containerID == "" {
				out = append(out, c.release(key, podLabels(p, ""), nil)...)
				continue
			}
			if name := p.Containers[h.containerID]; name != "" {
				out = append(out, c.release(key, podLabels(p, name), nil)...)
				continue
			}
		}
		if now.Sub(h.since) > Hold {
			delete(c.held, key)
			c.unmapped++
			continue
		}
		c.wantMap = true
	}
	for key := range c.given {
		if !seen[key] {
			delete(c.given, key)
		}
	}
	for key := range c.sandboxes {
		if !seen[key] {
			delete(c.sandboxes, key)
		}
	}
	out = append(out, metrics.New("watchlog_agent_unmapped_containers_total", float64(c.unmapped)))
	return out, errors.Join(errs...)
}
