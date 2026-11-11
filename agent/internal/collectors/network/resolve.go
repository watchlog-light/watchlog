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

// departedTTL is how long an address that left the map (a pod deleted, a container
// stopped) still resolves to what it belonged to, unless something else takes it.
const departedTTL = time.Hour

// dstUnresolved is a destination inside the cluster that the agent cannot name yet:
// counted, never drawn as an external.
const dstUnresolved = "unresolved"

// Resolver maps destination addresses to what they are.
type Resolver struct {
	pods       map[netip.Addr]podmap.IPPod
	services   map[netip.Addr]podmap.IPService
	nodes      map[netip.Addr]string
	containers map[netip.Addr]string
	// departed are addresses an earlier map had and this one doesn't: a client still
	// dialling a stopped container or a deleted pod is failing to reach it, not an
	// external.
	departed map[netip.Addr]departure
	// pending: no IP map yet (Kubernetes, the cluster-agent not answering since the
	// agent started). Private addresses are then pods, Services and nodes the agent
	// cannot name, not externals.
	pending bool
}

type departure struct {
	dest  Dest
	until time.Time
}

// NewResolver indexes a cluster's IP map (Kubernetes) and container addresses (Docker,
// container name by IP); either may be nil.
func NewResolver(m *podmap.IPMap, containers map[string]string) *Resolver {
	r := &Resolver{pods: map[netip.Addr]podmap.IPPod{}, services: map[netip.Addr]podmap.IPService{},
		nodes: map[netip.Addr]string{}, containers: map[netip.Addr]string{}, departed: map[netip.Addr]departure{}}
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
	if d, ok := r.known(a); ok {
		d.Port = port
		return d, true
	}
	if g, ok := r.departed[a]; ok {
		d := g.dest
		d.Port = port
		return d, true
	}
	if r.pending && private(a) {
		return Dest{Kind: dstUnresolved, Port: port}, true
	}
	return Dest{Kind: DstExternal, Name: network(a), Port: port}, true
}

// known is what the current map says the address is, without a port.
func (r *Resolver) known(a netip.Addr) (Dest, bool) {
	if p, ok := r.pods[a]; ok {
		return Dest{Kind: DstWorkload, Namespace: p.Namespace, WorkloadKind: p.WorkloadKind, Workload: p.Workload}, true
	}
	if s, ok := r.services[a]; ok {
		// Behind one workload, the edge points at it; otherwise at the Service.
		if len(s.Workloads) == 1 {
			return Dest{Kind: DstWorkload, Namespace: s.Namespace, WorkloadKind: s.Workloads[0].Kind,
				Workload: s.Workloads[0].Name, Service: s.Name}, true
		}
		return Dest{Kind: DstService, Namespace: s.Namespace, Service: s.Name}, true
	}
	if n, ok := r.nodes[a]; ok {
		return Dest{Kind: DstNode, Name: n}, true
	}
	if c, ok := r.containers[a]; ok {
		return Dest{Kind: DstContainer, Name: c}, true
	}
	return Dest{}, false
}

// inherit carries over what prev knew and r doesn't: addresses that just left the map
// are remembered for departedTTL, earlier departures until they expire. An address the
// current map has is never a departure.
func (r *Resolver) inherit(prev *Resolver, now time.Time) {
	if prev == nil {
		return
	}
	add := func(a netip.Addr) {
		if _, ok := r.known(a); ok {
			return
		}
		if d, ok := prev.known(a); ok {
			r.departed[a] = departure{dest: d, until: now.Add(departedTTL)}
		}
	}
	for a := range prev.pods {
		add(a)
	}
	for a := range prev.services {
		add(a)
	}
	for a := range prev.nodes {
		add(a)
	}
	for a := range prev.containers {
		add(a)
	}
	for a, g := range prev.departed {
		if _, ok := r.departed[a]; ok || now.After(g.until) {
			continue
		}
		if _, ok := r.known(a); !ok {
			r.departed[a] = g
		}
	}
}

// cgnat is the shared address space some CNIs give pods (RFC 6598).
var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// private is an address a cluster's pods, Services and nodes may have.
func private(a netip.Addr) bool {
	return a.IsPrivate() || cgnat.Contains(a)
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
