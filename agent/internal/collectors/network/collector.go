// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"log/slog"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/ebpf"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Drainer is the loaded flow programs (*ebpf.Flows).
type Drainer interface {
	Drain() ([]ebpf.Flow, error)
}

// DNSDrainer also gives DNS outcomes; read right after Drain (same map flip).
type DNSDrainer interface {
	DrainDNS() ([]ebpf.DNSStat, error)
}

// Attributed is a drained flow with the container that opened it.
type Attributed struct {
	Owner Owner
	ebpf.Flow
}

// minRebuild limits cgroup index rebuilds triggered by unknown cgroup ids.
const minRebuild = 10 * time.Second

// Collector drains the kernel counters every interval and attributes them to
// containers by cgroup id. Connections from processes outside containers (the
// kubelet's probes, host daemons) are counted, not drawn as edges.
type Collector struct {
	flows  Drainer
	owners func() (map[uint64]Owner, error)
	log    *slog.Logger
	now    func() time.Time

	// Names turns an owner into a source; Resolve gives the current resolver. Both
	// are set by the agent for its mode (Kubernetes or Docker).
	Names    func(Owner) (Source, bool)
	Resolver func() *Resolver
	// Bytes is whether the byte counters are attached (ebpf.Flows.Bytes).
	Bytes bool
	// DNSNames names external destinations by what the container looked up (ADR-104);
	// nil without the DNS hooks, and externals are /24 or /48 networks.
	DNSNames *Names
	// SearchMisses takes NXDOMAIN responses under the search domains out of the
	// errors (ADR-113); nil without the DNS hooks or a search list.
	SearchMisses *SearchMisses
	// ClusterDomain: a destination whose DNS name is under svc.<ClusterDomain> is a
	// Service, never external (ADR-116). Empty means cluster.local.
	ClusterDomain string
	// insideUnnamed counts flows to names under svc.<domain> that name no Service; they
	// are dropped rather than drawn as externals.
	insideUnnamed float64

	mu           sync.Mutex
	idx          map[uint64]Owner
	built        time.Time
	unattributed float64
	unnamed      float64
	keys         int
	edges        map[edgeKey]*edge
	ext          externals
	dns          map[Source]*dnsCounters
	pendingDNS   []ebpf.DNSStat
}

// New returns a collector over loaded flow programs; owners rebuilds the cgroup index.
func New(flows Drainer, owners func() (map[uint64]Owner, error), log *slog.Logger) *Collector {
	return &Collector{flows: flows, owners: owners, log: log, now: time.Now}
}

// Drain returns this interval's flows attributed to containers.
func (c *Collector) Drain() ([]Attributed, error) {
	flows, err := c.flows.Drain()
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.keys = len(flows)
	out := make([]Attributed, 0, len(flows))
	rebuilt := false
	for _, f := range flows {
		o, ok := c.idx[f.Cgroup]
		if !ok && !rebuilt && c.now().Sub(c.built) >= minRebuild {
			rebuilt = true
			c.rebuild()
			o, ok = c.idx[f.Cgroup]
		}
		if !ok {
			c.unattributed += float64(f.Connects)
			continue
		}
		out = append(out, Attributed{Owner: o, Flow: f})
	}
	return out, nil
}

func (c *Collector) rebuild() {
	c.built = c.now()
	idx, err := c.owners()
	if err != nil {
		c.log.Warn("cgroup index for network flows", "err", err)
		return
	}
	c.idx = idx
}

// Collect drains this interval's flows, adds them to their edges and returns every
// edge's series. Flows of containers not yet named (pod map not refreshed) are counted.
func (c *Collector) Collect() ([]metrics.Sample, error) {
	flows, err := c.Drain()
	if err != nil {
		return nil, err
	}
	if d, ok := c.flows.(DNSDrainer); ok {
		stats, err := d.DrainDNS()
		if err != nil {
			c.log.Warn("dns counters", "err", err)
		}
		c.mu.Lock()
		c.pendingDNS = stats
		c.mu.Unlock()
	}
	var res *Resolver
	if c.Resolver != nil {
		res = c.Resolver()
	}
	if res == nil {
		res = NewResolver(nil, nil)
	}
	now := c.now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.edges == nil {
		c.edges = map[edgeKey]*edge{}
	}
	for _, f := range flows {
		src, ok := Source{}, false
		if c.Names != nil {
			src, ok = c.Names(f.Owner)
		}
		if !ok {
			c.unnamed += float64(f.Connects)
			continue
		}
		dst, ok := res.Resolve(f.Addr, f.Port)
		if !ok {
			continue
		}
		if dst.Kind == DstExternal && c.DNSNames != nil {
			if name, ok := c.DNSNames.Lookup(f.Cgroup, f.Addr); ok {
				// A cluster Service's name: the IP map does not know this address yet
				// (a Service created moments ago). Attribute it to the Service by
				// name; never an external (ADR-116).
				if svc, ns, under := ClusterService(name, c.ClusterDomain); under {
					if svc == "" {
						c.insideUnnamed += float64(f.Connects)
						continue
					}
					dst = Dest{Kind: DstService, Namespace: ns, Service: svc, Port: dst.Port}
				} else {
					dst.Name = name
				}
			}
		}
		dst = c.ext.admit(src.key(), dst, now)
		k := edgeKey{src: src, dst: dst}
		e := c.edges[k]
		if e == nil {
			e = &edge{}
			c.edges[k] = e
		}
		e.add(f.Flow, now)
	}
	c.addDNS(now)
	var out []metrics.Sample
	for src, d := range c.dns {
		if now.Sub(d.seen) > edgeTTL {
			delete(c.dns, src)
			continue
		}
		out = append(out, d.samples(src)...)
	}
	for k, e := range c.edges {
		if now.Sub(e.seen) > edgeTTL {
			delete(c.edges, k)
			continue
		}
		out = append(out, e.samples(k, c.Bytes)...)
	}
	out = append(out, c.selfMetrics()...)
	return out, nil
}

// SelfMetrics describe the collector itself.
func (c *Collector) SelfMetrics() []metrics.Sample {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.selfMetrics()
}

func (c *Collector) selfMetrics() []metrics.Sample {
	out := []metrics.Sample{
		metrics.New("watchlog_agent_flow_keys", float64(c.keys)),
		metrics.New("watchlog_agent_flow_edges", float64(len(c.edges))),
		metrics.New("watchlog_agent_flow_unattributed_connections_total", c.unattributed),
		metrics.New("watchlog_agent_flow_unnamed_connections_total", c.unnamed),
		metrics.New("watchlog_agent_flow_cluster_unresolved_connections_total", c.insideUnnamed),
	}
	if c.DNSNames != nil {
		out = append(out, metrics.New("watchlog_agent_dns_names", float64(c.DNSNames.Len())))
	}
	return out
}

// dnsCounters are one source's cumulative DNS outcomes.
type dnsCounters struct {
	noerror, servfail, nxdomain, other, timeouts float64
	// searchMiss: NXDOMAIN for names under the search domains, not in nxdomain.
	searchMiss float64
	seen       time.Time
}

// addDNS attributes this interval's DNS counters to sources (lock held).
func (c *Collector) addDNS(now time.Time) {
	if c.dns == nil {
		c.dns = map[Source]*dnsCounters{}
	}
	if c.SearchMisses != nil {
		defer c.SearchMisses.rotate()
	}
	for _, d := range c.pendingDNS {
		var miss uint64
		if c.SearchMisses != nil {
			miss = c.SearchMisses.take(d.Cgroup, d.NXDomain)
		}
		o, ok := c.idx[d.Cgroup]
		if !ok && now.Sub(c.built) >= minRebuild {
			c.rebuild()
			o, ok = c.idx[d.Cgroup]
		}
		if !ok || c.Names == nil {
			continue
		}
		src, ok := c.Names(o)
		if !ok {
			continue
		}
		x := c.dns[src]
		if x == nil {
			x = &dnsCounters{}
			c.dns[src] = x
		}
		x.noerror += float64(d.NoError)
		x.servfail += float64(d.ServFail)
		x.nxdomain += float64(d.NXDomain - miss)
		x.searchMiss += float64(miss)
		x.other += float64(d.Other)
		x.timeouts += float64(d.Timeouts)
		x.seen = now
	}
	c.pendingDNS = nil
}

// samples: watchlog_dns_requests_total{rcode} per source (SPEC §6.3); rcode
// search_miss is NXDOMAIN under a search domain (ADR-113).
func (d *dnsCounters) samples(src Source) []metrics.Sample {
	l := src.labels()
	with := func(rcode string) []string { return append(append([]string{}, l...), "rcode", rcode) }
	return []metrics.Sample{
		metrics.New("watchlog_dns_requests_total", d.noerror, with("NOERROR")...),
		metrics.New("watchlog_dns_requests_total", d.nxdomain, with("NXDOMAIN")...),
		metrics.New("watchlog_dns_requests_total", d.servfail, with("SERVFAIL")...),
		metrics.New("watchlog_dns_requests_total", d.other, with("other")...),
		metrics.New("watchlog_dns_requests_total", d.timeouts, with("timeout")...),
		metrics.New("watchlog_dns_requests_total", d.searchMiss, with("search_miss")...),
	}
}
