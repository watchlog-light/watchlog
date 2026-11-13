// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"log/slog"
	"slices"
	"sync"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// KernelFilter is the kernel side of the pod filter (*ebpf.Flows).
type KernelFilter interface {
	SetRoots(ids []uint64) error
	SetFilter(on bool) error
	Filtered() (connects, dns uint64, err error)
}

// PodFilter keeps the kernel's pod filter current (Kubernetes mode, ADR-121): the
// programs record only tasks below the node's kubepods cgroups, so connections and DNS
// queries of anything else on the kernel (host daemons, plain Docker containers, the
// pods of other nodes that share it) are never recorded, only counted. The filter is
// turned on once a kubepods cgroup is known; until then flows from outside pods are
// dropped in user space as before. In Docker mode the same filter takes the cgroups of
// the daemon's own containers (NewContainerFilter, ADR-170).
type PodFilter struct {
	kernel KernelFilter
	roots  func() []uint64
	log    *slog.Logger
	// max is how many roots the kernel holds (0: no limit checked). With more, the
	// filter turns off rather than leave the extra cgroups unrecorded: the agent still
	// drops their flows in user space.
	max int
	// what names the recorded tasks in the log.
	what string

	mu       sync.Mutex
	current  []uint64
	on       bool
	connects float64
	dns      float64
}

// NewPodFilter returns a filter whose roots come from roots (the kubepods cgroup ids).
func NewPodFilter(kernel KernelFilter, roots func() []uint64, log *slog.Logger) *PodFilter {
	return &PodFilter{kernel: kernel, roots: roots, log: log, what: "this node's pods"}
}

// NewContainerFilter is the Docker-mode filter (WATCHLOG_EBPF_CONTAINER_FILTER, ADR-170):
// roots are the cgroups of the containers this Docker daemon runs (DockerRoots), so a
// Docker host inside a container (Docker in Docker) records none of the machine it runs
// on. With more roots than the kernel holds it stays off.
func NewContainerFilter(kernel KernelFilter, roots func() []uint64, max int, log *slog.Logger) *PodFilter {
	return &PodFilter{kernel: kernel, roots: roots, log: log, max: max, what: "this Docker daemon's containers"}
}

// Refresh looks for the kubepods cgroups again (they appear when the kubelet starts),
// updates the kernel's roots when they changed and reads the filtered counters.
func (p *PodFilter) Refresh() {
	ids := p.roots()
	slices.Sort(ids)
	ids = slices.Compact(ids)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.max > 0 && len(ids) > p.max {
		if p.on || p.current != nil {
			if err := p.kernel.SetFilter(false); err != nil {
				p.log.Warn("eBPF filter", "err", err)
				return
			}
			p.on, p.current = false, nil
			p.log.Warn("eBPF filter off: more cgroups than the kernel map holds; flows of other tasks are dropped in the agent instead",
				"roots", len(ids), "max", p.max)
		}
		p.readCounters()
		return
	}
	if len(ids) > 0 && !slices.Equal(ids, p.current) {
		if err := p.kernel.SetRoots(ids); err != nil {
			p.log.Warn("eBPF filter roots", "err", err)
		} else {
			p.current = ids
		}
	}
	if !p.on && len(p.current) > 0 {
		if err := p.kernel.SetFilter(true); err != nil {
			p.log.Warn("eBPF filter", "err", err)
		} else {
			p.on = true
			p.log.Info("eBPF filter on: only "+p.what+" are recorded", "roots", len(p.current))
		}
	}
	p.readCounters()
}

func (p *PodFilter) readCounters() {
	if c, d, err := p.kernel.Filtered(); err == nil {
		p.connects, p.dns = float64(c), float64(d)
	}
}

// On says whether the kernel filter is on.
func (p *PodFilter) On() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.on
}

func (p *PodFilter) samples() []metrics.Sample {
	p.mu.Lock()
	defer p.mu.Unlock()
	on := 0.0
	if p.on {
		on = 1
	}
	return []metrics.Sample{
		metrics.New("watchlog_agent_flow_pod_filter", on),
		metrics.New("watchlog_agent_flow_filtered_connections_total", p.connects),
		metrics.New("watchlog_agent_dns_filtered_queries_total", p.dns),
	}
}
