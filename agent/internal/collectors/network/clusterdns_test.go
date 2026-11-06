// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"io"
	"log/slog"
	"net/netip"
	"testing"

	"github.com/watchlog-light/watchlog/agent/internal/ebpf"
)

func TestClusterDomainFromSearchList(t *testing.T) {
	for _, tc := range []struct {
		search []string
		want   string
	}{
		{[]string{"shop.svc.cluster.local", "svc.cluster.local", "cluster.local", "lan"}, "cluster.local"},
		{[]string{"default.svc.k8s.example", "svc.k8s.example", "k8s.example"}, "k8s.example"},
		{[]string{"lan"}, DefaultClusterDomain}, // Docker host or no cluster DNS
		{nil, DefaultClusterDomain},
	} {
		if got := ClusterDomain(tc.search); got != tc.want {
			t.Errorf("ClusterDomain(%v) = %q, want %q", tc.search, got, tc.want)
		}
	}
}

func TestClusterService(t *testing.T) {
	for _, tc := range []struct {
		name, domain, svc, ns string
		under                 bool
	}{
		{"cart.shop.svc.cluster.local", "cluster.local", "cart", "shop", true},
		{"Cart.Shop.SVC.cluster.local.", "cluster.local", "cart", "shop", true},
		{"postgres-0.postgres.shop.svc.cluster.local", "cluster.local", "postgres", "shop", true}, // headless pod
		{"shop.svc.cluster.local", "cluster.local", "", "", true},                                 // under, but no Service
		{"cart.shop.svc.k8s.example", "k8s.example", "cart", "shop", true},
		{"cart.shop.svc.cluster.local", "k8s.example", "", "", false}, // another cluster's domain
		{"api.stripe.com", "cluster.local", "", "", false},
		{"svc.cluster.local.evil.com", "cluster.local", "", "", false},
	} {
		svc, ns, under := ClusterService(tc.name, tc.domain)
		if svc != tc.svc || ns != tc.ns || under != tc.under {
			t.Errorf("ClusterService(%q, %q) = %q %q %v, want %q %q %v", tc.name, tc.domain, svc, ns, under, tc.svc, tc.ns, tc.under)
		}
	}
}

// A Service created moments ago: its ClusterIP is not in the IP map yet, but the client
// looked it up by name. The flow goes to the Service, never to an external (ADR-116).
func TestServiceNotYetInTheMapIsNeverExternal(t *testing.T) {
	clusterIP, other := netip.MustParseAddr("10.96.33.7"), netip.MustParseAddr("10.96.33.8")
	d := &fakeDrainer{flows: [][]ebpf.Flow{{
		{Cgroup: 11, Addr: clusterIP, Port: 9898, Connects: 3},
		{Cgroup: 11, Addr: other, Port: 80, Connects: 1},
	}}}
	c := New(d, func() (map[uint64]Owner, error) {
		return map[uint64]Owner{11: {PodID: "p-front"}}, nil
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.Names = func(o Owner) (Source, bool) {
		return Source{Namespace: "shop", WorkloadKind: "Deployment", Workload: "frontend"}, true
	}
	c.ClusterDomain = "cluster.local"
	c.DNSNames = NewNames()
	c.DNSNames.Add(11, response("cart.shop.svc.cluster.local", record(typeA, 5, clusterIP.AsSlice())))
	c.DNSNames.Add(11, response("shop.svc.cluster.local", record(typeA, 5, other.AsSlice())))
	out, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if v := value(out, "watchlog_flow_connections_total", "dst_kind", "service", "dst_namespace", "shop", "dst_service", "cart", "dst_port", "9898"); v != 3 {
		t.Errorf("service edge = %v, want 3", v)
	}
	for _, s := range out {
		for _, l := range s.Labels {
			if l.Name == "dst_kind" && l.Value == "external" {
				t.Errorf("external edge for a cluster name: %+v", s.Labels)
			}
		}
	}
	if v := value(c.SelfMetrics(), "watchlog_agent_flow_cluster_unresolved_connections_total"); v != 1 {
		t.Errorf("unresolved cluster names = %v, want 1", v)
	}
}
