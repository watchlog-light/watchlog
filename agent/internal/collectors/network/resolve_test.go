// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"fmt"
	"io"
	"log/slog"
	"net/netip"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/ebpf"
	"github.com/watchlog-light/watchlog/agent/internal/podmap"
)

var ipmap = &podmap.IPMap{
	Pods: []podmap.IPPod{{IP: "10.244.1.5", Namespace: "shop", Pod: "api-1", WorkloadKind: "Deployment", Workload: "api"}},
	Services: []podmap.IPService{
		{IPs: []string{"10.96.0.20"}, Namespace: "shop", Name: "api", Workloads: []podmap.Workload{{Kind: "Deployment", Name: "api"}}},
		{IPs: []string{"10.96.0.30"}, Namespace: "shop", Name: "mixed", Workloads: []podmap.Workload{{Kind: "Deployment", Name: "a"}, {Kind: "Deployment", Name: "b"}}},
	},
	Nodes: []podmap.IPNode{{IP: "172.19.0.2", Name: "control-plane"}},
}

func TestResolveDestinations(t *testing.T) {
	r := NewResolver(ipmap, map[string]string{"172.18.0.4": "demo-cache-1"})
	for addr, want := range map[string]Dest{
		"10.244.1.5": {Kind: DstWorkload, Namespace: "shop", WorkloadKind: "Deployment", Workload: "api", Port: 80},
		// Seen before DNAT: the Service's single workload, through the Service.
		"10.96.0.20":        {Kind: DstWorkload, Namespace: "shop", WorkloadKind: "Deployment", Workload: "api", Service: "api", Port: 80},
		"10.96.0.30":        {Kind: DstService, Namespace: "shop", Service: "mixed", Port: 80},
		"172.19.0.2":        {Kind: DstNode, Name: "control-plane", Port: 80},
		"172.18.0.4":        {Kind: DstContainer, Name: "demo-cache-1", Port: 80},
		"203.0.113.77":      {Kind: DstExternal, Name: "203.0.113.0/24", Port: 80},
		"2001:db8:aa:bb::1": {Kind: DstExternal, Name: "2001:db8:aa::/48", Port: 80},
		"::ffff:10.244.1.5": {Kind: DstWorkload, Namespace: "shop", WorkloadKind: "Deployment", Workload: "api", Port: 80},
	} {
		got, ok := r.Resolve(netip.MustParseAddr(addr), 80)
		if !ok || got != want {
			t.Errorf("%s: %+v %v, want %+v", addr, got, ok, want)
		}
	}
	for _, addr := range []string{"127.0.0.1", "::1", "0.0.0.0"} {
		if _, ok := r.Resolve(netip.MustParseAddr(addr), 80); ok {
			t.Errorf("%s resolved; loopback is not an edge", addr)
		}
	}
}

func TestExternalsCollapseIntoInternetBeyond50(t *testing.T) {
	var e externals
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	for i := range MaxExternals {
		d := e.admit("web", Dest{Kind: DstExternal, Name: fmt.Sprintf("203.0.%d.0/24", i), Port: 443}, now)
		if d.Kind != DstExternal {
			t.Fatalf("external %d collapsed early", i)
		}
	}
	if d := e.admit("web", Dest{Kind: DstExternal, Name: "198.51.100.0/24", Port: 443}, now); d.Kind != DstInternet || d.Name != "Internet" {
		t.Errorf("51st = %+v", d)
	}
	// Known ones stay, another source has its own budget, and an hour later old ones expire.
	if d := e.admit("web", Dest{Kind: DstExternal, Name: "203.0.0.0/24", Port: 443}, now); d.Kind != DstExternal {
		t.Errorf("known external collapsed: %+v", d)
	}
	if d := e.admit("api", Dest{Kind: DstExternal, Name: "198.51.100.0/24", Port: 443}, now); d.Kind != DstExternal {
		t.Errorf("other source: %+v", d)
	}
	if d := e.admit("web", Dest{Kind: DstExternal, Name: "198.51.100.0/24", Port: 443}, now.Add(2*time.Hour)); d.Kind != DstExternal {
		t.Errorf("after expiry: %+v", d)
	}
}

// Kernel deltas become cumulative counter series per edge, with a cumulative latency
// histogram; an edge without connections for 10 min ends.
func TestCollectBuildsCumulativeEdgeSeries(t *testing.T) {
	api := netip.MustParseAddr("10.96.0.20")
	flow := func(connects, failed uint64) ebpf.Flow {
		f := ebpf.Flow{Cgroup: 1, Addr: api, Port: 80, Connects: connects, Failures: failed,
			Established: connects - failed, LatSumNs: (connects - failed) * 2_000_000, BytesSent: 100, BytesRecv: 50}
		f.Latency[2] = connects - failed // 1–2.5 ms
		return f
	}
	d := &fakeDrainer{flows: [][]ebpf.Flow{
		{flow(10, 1), {Cgroup: 99, Addr: api, Port: 80, Connects: 4}},
		{flow(5, 0)},
		{},
	}}
	c := New(d, func() (map[uint64]Owner, error) {
		return map[uint64]Owner{1: {PodID: "p-web", ContainerID: "c"}, 99: {PodID: "p-unknown"}}, nil
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return now }
	c.Names = func(o Owner) (Source, bool) {
		if o.PodID == "p-web" {
			return Source{Namespace: "shop", WorkloadKind: "Deployment", Workload: "web"}, true
		}
		return Source{}, false
	}
	res := NewResolver(ipmap, nil)
	c.Resolver = func() *Resolver { return res }
	c.Bytes = true

	_, _ = c.Collect()
	now = now.Add(15 * time.Second)
	out, _ := c.Collect()
	edge := []string{"workload", "web", "dst_workload", "api", "dst_service", "api", "dst_port", "80", "dst_kind", "workload"}
	if v := value(out, "watchlog_flow_connections_total", edge...); v != 15 {
		t.Errorf("connections = %v, want 15 (cumulative)", v)
	}
	if v := value(out, "watchlog_flow_connect_failed_total", edge...); v != 1 {
		t.Errorf("failed = %v", v)
	}
	if v := value(out, "watchlog_flow_connect_latency_seconds_bucket", append(edge, "le", "0.001")...); v != 0 {
		t.Errorf("le=0.001 = %v", v)
	}
	if v := value(out, "watchlog_flow_connect_latency_seconds_bucket", append(edge, "le", "+Inf")...); v != 14 {
		t.Errorf("le=+Inf = %v, want 14", v)
	}
	if v := value(out, "watchlog_flow_bytes_total", append(edge, "dir", "received")...); v != 100 {
		t.Errorf("bytes received = %v", v)
	}
	if v := value(out, "watchlog_agent_flow_unnamed_connections_total"); v != 4 {
		t.Errorf("unnamed = %v", v)
	}
	for _, s := range out {
		for _, l := range s.Labels {
			if l.Value == "10.96.0.20" || l.Name == "pod" {
				t.Fatalf("%s carries %s=%s", s.Name, l.Name, l.Value)
			}
		}
	}
	now = now.Add(11 * time.Minute)
	if out, _ := c.Collect(); value(out, "watchlog_flow_connections_total", edge...) != -1 {
		t.Error("idle edge still reported after 10 min")
	}
}

type dnsDrainer struct {
	fakeDrainer
	dns [][]ebpf.DNSStat
}

func (d *dnsDrainer) DrainDNS() ([]ebpf.DNSStat, error) {
	if len(d.dns) == 0 {
		return nil, nil
	}
	out := d.dns[0]
	d.dns = d.dns[1:]
	return out, nil
}

// DNS outcomes become cumulative watchlog_dns_requests_total{rcode} per workload.
func TestCollectCountsDNSPerWorkload(t *testing.T) {
	d := &dnsDrainer{dns: [][]ebpf.DNSStat{
		{{Cgroup: 1, Queries: 10, NoError: 6, NXDomain: 3, Timeouts: 1}},
		{{Cgroup: 1, Queries: 2, ServFail: 2}},
	}}
	c := New(d, func() (map[uint64]Owner, error) { return map[uint64]Owner{1: {PodID: "p-web"}}, nil },
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.Names = func(o Owner) (Source, bool) {
		return Source{Namespace: "shop", WorkloadKind: "Deployment", Workload: "web"}, o.PodID == "p-web"
	}
	_, _ = c.Collect()
	out, _ := c.Collect()
	for rcode, want := range map[string]float64{"NOERROR": 6, "NXDOMAIN": 3, "SERVFAIL": 2, "timeout": 1, "other": 0} {
		if v := value(out, "watchlog_dns_requests_total", "workload", "web", "rcode", rcode); v != want {
			t.Errorf("%s = %v, want %v", rcode, v, want)
		}
	}
}
