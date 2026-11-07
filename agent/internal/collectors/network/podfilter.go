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
// dropped in user space as before.
type PodFilter struct {
	kernel KernelFilter
	roots  func() []uint64
	log    *slog.Logger

	mu       sync.Mutex
	current  []uint64
	on       bool
	connects float64
	dns      float64
}

// NewPodFilter returns a filter whose roots come from roots (the kubepods cgroup ids).
func NewPodFilter(kernel KernelFilter, roots func() []uint64, log *slog.Logger) *PodFilter {
	return &PodFilter{kernel: kernel, roots: roots, log: log}
}

// Refresh looks for the kubepods cgroups again (they appear when the kubelet starts),
// updates the kernel's roots when they changed and reads the filtered counters.
func (p *PodFilter) Refresh() {
	ids := p.roots()
	slices.Sort(ids)
	ids = slices.Compact(ids)
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(ids) > 0 && !slices.Equal(ids, p.current) {
		if err := p.kernel.SetRoots(ids); err != nil {
			p.log.Warn("pod filter roots", "err", err)
		} else {
			p.current = ids
		}
	}
	if !p.on && len(p.current) > 0 {
		if err := p.kernel.SetFilter(true); err != nil {
			p.log.Warn("pod filter", "err", err)
		} else {
			p.on = true
			p.log.Info("eBPF pod filter on: only this node's pods are recorded", "roots", len(p.current))
		}
	}
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
