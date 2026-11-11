// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"io"
	"log/slog"
	"net/netip"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/ebpf"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

type fakeDrainer struct{ flows [][]ebpf.Flow }

func (f *fakeDrainer) Drain() ([]ebpf.Flow, error) {
	if len(f.flows) == 0 {
		return nil, nil
	}
	out := f.flows[0]
	f.flows = f.flows[1:]
	return out, nil
}

func TestAttributesFlowsAndCountsTheRest(t *testing.T) {
	addr := netip.MustParseAddr("10.96.0.10")
	web := Owner{PodID: "pod-web", ContainerID: "c-web"}
	d := &fakeDrainer{flows: [][]ebpf.Flow{
		{{Cgroup: 11, Addr: addr, Port: 53, Connects: 4}, {Cgroup: 99, Addr: addr, Port: 80, Connects: 3}},
		{{Cgroup: 12, Addr: addr, Port: 80, Connects: 2}},
		{{Cgroup: 12, Addr: addr, Port: 80, Connects: 1}},
	}}
	builds := 0
	idx := map[uint64]Owner{11: web}
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	c := New(d, func() (map[uint64]Owner, error) {
		builds++
		return idx, nil
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.now = func() time.Time { return now }

	got, _ := c.Drain()
	if len(got) != 1 || got[0].Owner != web || got[0].Connects != 4 {
		t.Fatalf("first drain = %+v", got)
	}
	if builds != 1 {
		t.Errorf("index built %d times, want once for the first unknown cgroup", builds)
	}
	// A new container appears 5 s later: no rebuild yet (at most every 10 s).
	idx = map[uint64]Owner{11: web, 12: {PodID: "pod-api", ContainerID: "c-api"}}
	now = now.Add(5 * time.Second)
	if got, _ := c.Drain(); len(got) != 0 || builds != 1 {
		t.Fatalf("second drain = %+v, builds %d", got, builds)
	}
	now = now.Add(10 * time.Second)
	if got, _ := c.Drain(); len(got) != 1 || got[0].Owner.PodID != "pod-api" || builds != 2 {
		t.Fatalf("third drain = %+v, builds %d", got, builds)
	}
	if v := value(c.SelfMetrics(), "watchlog_agent_flow_unattributed_connections_total"); v != 3+2 {
		t.Errorf("unattributed = %v, want 5 (host process + the not yet indexed container)", v)
	}
}

// 500 flow keys per 15 s interval, all attributed: the user-space cost of a drain.
func BenchmarkDrain(b *testing.B) {
	flows := make([]ebpf.Flow, 500)
	idx := map[uint64]Owner{}
	for i := range flows {
		flows[i] = ebpf.Flow{Cgroup: uint64(i % 50), Addr: netip.AddrFrom4([4]byte{10, 0, byte(i / 256), byte(i)}), Port: 80, Connects: 10}
		idx[uint64(i%50)] = Owner{PodID: "p", ContainerID: "c"}
	}
	c := New(&loopDrainer{flows}, func() (map[uint64]Owner, error) { return idx, nil }, slog.New(slog.NewTextHandler(io.Discard, nil)))
	b.ReportAllocs()
	for b.Loop() {
		if _, err := c.Drain(); err != nil {
			b.Fatal(err)
		}
	}
}

type loopDrainer struct{ flows []ebpf.Flow }

func (l *loopDrainer) Drain() ([]ebpf.Flow, error) { return l.flows, nil }

func value(samples []metrics.Sample, name string, labels ...string) float64 {
	for _, s := range samples {
		if s.Name != name {
			continue
		}
		ok := true
		for i := 0; i+1 < len(labels); i += 2 {
			found := false
			for _, l := range s.Labels {
				if l.Name == labels[i] && l.Value == labels[i+1] {
					found = true
				}
			}
			ok = ok && found
		}
		if ok {
			return s.Value
		}
	}
	return -1
}

// Before the first IP map, a flow to a private address is counted as unresolved and
// drawn as nothing; a public one is still an external.
func TestCollectDropsPrivateDestinationsBeforeTheFirstMap(t *testing.T) {
	d := &fakeDrainer{flows: [][]ebpf.Flow{{
		{Cgroup: 1, Addr: netip.MustParseAddr("10.244.2.16"), Port: 5432, Connects: 3, Failures: 3},
		{Cgroup: 1, Addr: netip.MustParseAddr("203.0.113.7"), Port: 443, Connects: 2, Established: 2},
	}}}
	c := New(d, func() (map[uint64]Owner, error) { return map[uint64]Owner{1: {PodID: "p"}}, nil },
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.Names = func(Owner) (Source, bool) {
		return Source{Namespace: "watchlog", WorkloadKind: "Deployment", Workload: "integrations"}, true
	}
	res := NewResolver(nil, nil)
	res.pending = true
	c.Resolver = func() *Resolver { return res }
	out, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if v := value(out, "watchlog_flow_connections_total", "dst", "10.244.2.0/24"); v != -1 {
		t.Errorf("pod address drawn as an external: %v", v)
	}
	if v := value(out, "watchlog_flow_connections_total", "dst_kind", "external", "dst", "203.0.113.0/24"); v != 2 {
		t.Errorf("public external = %v, want 2", v)
	}
	if v := value(out, "watchlog_agent_flow_cluster_unresolved_connections_total"); v != 3 {
		t.Errorf("unresolved = %v, want 3", v)
	}
}
