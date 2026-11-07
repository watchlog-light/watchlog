// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"errors"
	"io"
	"log/slog"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/ebpf"
)

// Defence in depth behind the kernel filter (ADR-121): a flow or DNS stat whose cgroup
// is no known container (a host process, a plain Docker container next to a kind node,
// another node's pod) gives no edge and no DNS series, only the counters, and none of
// its addresses appears in any label.
func TestUnknownCgroupsGiveOnlyCounters(t *testing.T) {
	hostDst := netip.MustParseAddr("192.168.5.2")
	d := &dnsDrainer{
		fakeDrainer: fakeDrainer{flows: [][]ebpf.Flow{
			{{Cgroup: 77, Addr: hostDst, Port: 443, Connects: 9, Established: 9, BytesSent: 100},
				{Cgroup: 1, Addr: netip.MustParseAddr("10.96.0.30"), Port: 80, Connects: 2}},
		}},
		dns: [][]ebpf.DNSStat{
			{{Cgroup: 77, Queries: 5, NoError: 4, NXDomain: 1}, {Cgroup: 1, Queries: 3, NoError: 3}},
		},
	}
	c := New(d, func() (map[uint64]Owner, error) { return map[uint64]Owner{1: {PodID: "p-web"}}, nil },
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.now = func() time.Time { return time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC) }
	c.Names = func(o Owner) (Source, bool) {
		if o.PodID == "p-web" {
			return Source{Namespace: "shop", WorkloadKind: "Deployment", Workload: "web"}, true
		}
		return Source{}, false
	}
	c.DNSNames = NewNames()
	out, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if v := value(out, "watchlog_agent_flow_unattributed_connections_total"); v != 9 {
		t.Errorf("unattributed connections = %v, want 9", v)
	}
	if v := value(out, "watchlog_agent_dns_unattributed_queries_total"); v != 5 {
		t.Errorf("unattributed DNS queries = %v, want 5", v)
	}
	if v := value(out, "watchlog_dns_requests_total", "workload", "web", "rcode", "NOERROR"); v != 3 {
		t.Errorf("the pod's DNS = %v, want 3", v)
	}
	edges := 0
	for _, s := range out {
		if s.Name == "watchlog_flow_connections_total" {
			edges++
			if s.Value != 2 {
				t.Errorf("edge %v = %v, want only the pod's 2 connections", s.Labels, s.Value)
			}
		}
		if s.Name == "watchlog_dns_requests_total" && s.Value != 0 && s.Value != 3 {
			t.Errorf("DNS series %v = %v carries the unknown cgroup's queries", s.Labels, s.Value)
		}
		for _, l := range s.Labels {
			if strings.HasPrefix(l.Value, "192.168.5.") {
				t.Errorf("%s carries %s=%s", s.Name, l.Name, l.Value)
			}
		}
	}
	if edges != 1 {
		t.Errorf("%d edges, want 1 (the pod's)", edges)
	}
}

type fakeKernel struct {
	roots    []uint64
	on       bool
	connects uint64
	failSet  bool
}

func (k *fakeKernel) SetRoots(ids []uint64) error {
	if k.failSet {
		return errors.New("map full")
	}
	k.roots = append([]uint64(nil), ids...)
	return nil
}
func (k *fakeKernel) SetFilter(on bool) error           { k.on = on; return nil }
func (k *fakeKernel) Filtered() (uint64, uint64, error) { return k.connects, 2, nil }

// The filter turns on only once a kubepods cgroup is known, follows its changes and
// reports the kernel's counters.
func TestPodFilterTurnsOnWithItsRoots(t *testing.T) {
	k := &fakeKernel{}
	var roots []uint64
	p := NewPodFilter(k, func() []uint64 { return append([]uint64(nil), roots...) }, slog.New(slog.NewTextHandler(io.Discard, nil)))
	p.Refresh()
	if k.on || p.On() {
		t.Fatal("filter on without a root: it would record nothing")
	}
	roots = []uint64{42, 42}
	k.connects = 7
	p.Refresh()
	if !k.on || len(k.roots) != 1 || k.roots[0] != 42 {
		t.Fatalf("after the kubelet started: on=%v roots=%v", k.on, k.roots)
	}
	roots = []uint64{43, 42}
	p.Refresh()
	if len(k.roots) != 2 || k.roots[0] != 42 || k.roots[1] != 43 {
		t.Errorf("roots = %v, want [42 43]", k.roots)
	}
	// The kubepods cgroup vanishing for a moment (a kubelet restart) keeps the last roots.
	roots = nil
	p.Refresh()
	if !k.on || len(k.roots) != 2 {
		t.Errorf("after a scan without roots: on=%v roots=%v", k.on, k.roots)
	}
	s := p.samples()
	if v := value(s, "watchlog_agent_flow_filtered_connections_total"); v != 7 {
		t.Errorf("filtered connections = %v", v)
	}
	if v := value(s, "watchlog_agent_dns_filtered_queries_total"); v != 2 {
		t.Errorf("filtered DNS = %v", v)
	}
	if v := value(s, "watchlog_agent_flow_pod_filter"); v != 1 {
		t.Errorf("pod filter = %v", v)
	}
}

// A collector with a pod filter refreshes it every collection and reports its counters.
func TestCollectorRefreshesThePodFilter(t *testing.T) {
	k := &fakeKernel{connects: 3}
	c := New(&fakeDrainer{}, func() (map[uint64]Owner, error) { return nil, nil }, slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.PodFilter = NewPodFilter(k, func() []uint64 { return []uint64{5} }, slog.New(slog.NewTextHandler(io.Discard, nil)))
	out, _ := c.Collect()
	if !k.on {
		t.Error("filter not turned on by Collect")
	}
	if v := value(out, "watchlog_agent_flow_filtered_connections_total"); v != 3 {
		t.Errorf("filtered connections = %v", v)
	}
}
