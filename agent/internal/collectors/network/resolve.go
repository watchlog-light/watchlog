// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"net/netip"
	"strconv"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/podmap"
)

// Destination kinds (the dst_kind label).
const (
	DstWorkload  = "workload"
	DstService   = "service"
	DstNode      = "node"
	DstContainer = "container"
	DstExternal  = "external"
	DstInternet  = "internet"
)

// MaxExternals per source: beyond this many distinct external destinations, the rest
// collapse into "Internet" (ADR-101).
const MaxExternals = 50

// externalTTL forgets an external destination not seen for this long.
const externalTTL = time.Hour

// Dest is where a flow goes, as labels: never an IP except an aggregated external
// network (SPEC §6.3 cardinality rules).
type Dest struct {
	Kind         string
	Namespace    string
	WorkloadKind string
	Workload     string
	Service      string // the Service the client connected through
	Name         string // node, Docker container, external network or "Internet"
	Port         uint16
}

// Resolver maps destination addresses to what they are.
type Resolver struct {
	pods       map[netip.Addr]podmap.IPPod
	services   map[netip.Addr]podmap.IPService
	nodes      map[netip.Addr]string
	containers map[netip.Addr]string
}

// NewResolver indexes a cluster's IP map (Kubernetes) and container addresses (Docker,
// container name by IP); either may be nil.
func NewResolver(m *podmap.IPMap, containers map[string]string) *Resolver {
	r := &Resolver{pods: map[netip.Addr]podmap.IPPod{}, services: map[netip.Addr]podmap.IPService{},
		nodes: map[netip.Addr]string{}, containers: map[netip.Addr]string{}}
	parse := func(s string) (netip.Addr, bool) {
		a, err := netip.ParseAddr(s)
		return a.Unmap(), err == nil
	}
	if m != nil {
		for _, p := range m.Pods {
			if a, ok := parse(p.IP); ok {
				r.pods[a] = p
			}
		}
		for _, s := range m.Services {
			for _, ip := range s.IPs {
				if a, ok := parse(ip); ok {
					r.services[a] = s
				}
			}
		}
		for _, n := range m.Nodes {
			if a, ok := parse(n.IP); ok {
				r.nodes[a] = n.Name
			}
		}
	}
	for ip, name := range containers {
		if a, ok := parse(ip); ok {
			r.containers[a] = name
		}
	}
	return r
}

// Resolve names a destination. It returns false for loopback and unspecified
// addresses: a pod talking to its own sidecar is not an edge.
func (r *Resolver) Resolve(a netip.Addr, port uint16) (Dest, bool) {
	a = a.Unmap()
	if !a.IsValid() || a.IsLoopback() || a.IsUnspecified() {
		return Dest{}, false
	}
	if p, ok := r.pods[a]; ok {
		return Dest{Kind: DstWorkload, Namespace: p.Namespace, WorkloadKind: p.WorkloadKind, Workload: p.Workload, Port: port}, true
	}
	if s, ok := r.services[a]; ok {
		// Behind one workload, the edge points at it; otherwise at the Service.
		if len(s.Workloads) == 1 {
			return Dest{Kind: DstWorkload, Namespace: s.Namespace, WorkloadKind: s.Workloads[0].Kind,
				Workload: s.Workloads[0].Name, Service: s.Name, Port: port}, true
		}
		return Dest{Kind: DstService, Namespace: s.Namespace, Service: s.Name, Port: port}, true
	}
	if n, ok := r.nodes[a]; ok {
		return Dest{Kind: DstNode, Name: n, Port: port}, true
	}
	if c, ok := r.containers[a]; ok {
		return Dest{Kind: DstContainer, Name: c, Port: port}, true
	}
	return Dest{Kind: DstExternal, Name: network(a), Port: port}, true
}

// network is the aggregated external destination: /24 for IPv4, /48 for IPv6.
func network(a netip.Addr) string {
	bits := 24
	if a.Is6() {
		bits = 48
	}
	p, _ := a.Prefix(bits)
	return p.String()
}

// externals remembers each source's distinct external destinations, to collapse the
// rest into "Internet".
type externals struct {
	seen map[string]map[string]time.Time // source key → "network:port" → last seen
}

func (e *externals) admit(source string, d Dest, now time.Time) Dest {
	if d.Kind != DstExternal {
		return d
	}
	if e.seen == nil {
		e.seen = map[string]map[string]time.Time{}
	}
	set := e.seen[source]
	if set == nil {
		set = map[string]time.Time{}
		e.seen[source] = set
	}
	key := d.Name + ":" + strconv.Itoa(int(d.Port))
	if _, ok := set[key]; !ok {
		for k, t := range set {
			if now.Sub(t) > externalTTL {
				delete(set, k)
			}
		}
		if len(set) >= MaxExternals {
			return Dest{Kind: DstInternet, Name: "Internet"}
		}
	}
	set[key] = now
	return d
}
