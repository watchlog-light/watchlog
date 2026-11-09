// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"strconv"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/ebpf"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// HTTPDrainer also gives HTTP/1.x stats (ADR-139); read right after Drain (same flip).
type HTTPDrainer interface {
	DrainHTTP() ([]ebpf.HTTPStat, error)
}

// serverKey is a workload or container answering HTTP on one of its ports.
type serverKey struct {
	src  Source
	port uint16
}

// httpCounters are cumulative: series are counters, the kernel gives deltas.
type httpCounters struct {
	reads, writes float64
	status        [21]float64
	lat           [15]float64
	latSumNs      float64
	seen          time.Time
}

func (h *httpCounters) add(s ebpf.HTTPStat, now time.Time) {
	h.reads += float64(s.Reads)
	h.writes += float64(s.Writes)
	for i, n := range s.Status {
		h.status[i] += float64(n)
	}
	for i, n := range s.Latency {
		h.lat[i] += float64(n)
	}
	h.latSumNs += float64(s.LatSumNs)
	h.seen = now
}

var httpLe = func() []string {
	out := make([]string, 0, len(ebpf.HTTPBuckets)+1)
	for _, b := range ebpf.HTTPBuckets {
		out = append(out, strconv.FormatFloat(b, 'g', -1, 64))
	}
	return append(out, "+Inf")
}()

// samples are one edge's or one server's HTTP series under prefix
// (watchlog_http_ or watchlog_http_server_). Status codes appear once seen, so an edge
// that only ever answered 200 has one requests series, not 21.
func (h *httpCounters) samples(prefix string, l []string) []metrics.Sample {
	with := func(extra ...string) []string { return append(append([]string{}, l...), extra...) }
	total := h.reads + h.writes
	out := []metrics.Sample{
		metrics.New(prefix+"requests_by_method_total", h.reads, with("method", "read")...),
		metrics.New(prefix+"requests_by_method_total", h.writes, with("method", "write")...),
		metrics.New(prefix+"request_duration_seconds_sum", h.latSumNs/1e9, l...),
		metrics.New(prefix+"request_duration_seconds_count", total, l...),
	}
	for i, n := range h.status {
		if n > 0 {
			code := ebpf.HTTPStatusCodes[i]
			out = append(out, metrics.New(prefix+"requests_total", n, with("code", code, "class", code[:1]+"xx")...))
		}
	}
	cum := 0.0
	for i, le := range httpLe {
		cum += h.lat[i]
		out = append(out, metrics.New(prefix+"request_duration_seconds_bucket", cum, with("le", le)...))
	}
	return out
}

// addHTTP attributes this interval's HTTP stats: a client's to its edge (the same labels
// as its flow series), a server's to its own workload or container and port.
func (c *Collector) addHTTP(stats []ebpf.HTTPStat, res *Resolver, now time.Time) {
	if c.httpEdges == nil {
		c.httpEdges = map[edgeKey]*httpCounters{}
		c.httpServers = map[serverKey]*httpCounters{}
	}
	rebuilt := false
	for _, s := range stats {
		o, ok := c.idx[s.Cgroup]
		// A server that only receives may be in no flow: its cgroup can be new here.
		if !ok && !rebuilt && c.now().Sub(c.built) >= minRebuild {
			rebuilt = true
			c.rebuild()
			o, ok = c.idx[s.Cgroup]
		}
		if !ok {
			continue
		}
		src, named := Source{}, false
		if c.Names != nil {
			src, named = c.Names(o)
		}
		if !named {
			continue
		}
		if s.Server {
			k := serverKey{src: src, port: s.Port}
			h := c.httpServers[k]
			if h == nil {
				h = &httpCounters{}
				c.httpServers[k] = h
			}
			h.add(s, now)
			continue
		}
		dst, ok := c.destination(s.Cgroup, src, s.Addr, s.Port, res, now)
		if !ok {
			continue
		}
		k := edgeKey{src: src, dst: dst}
		h := c.httpEdges[k]
		if h == nil {
			h = &httpCounters{}
			c.httpEdges[k] = h
		}
		h.add(s, now)
	}
}

// httpSamples are every live HTTP edge's and server's series; stale ones are dropped.
func (c *Collector) httpSamples(now time.Time) []metrics.Sample {
	var out []metrics.Sample
	for k, h := range c.httpEdges {
		if now.Sub(h.seen) > edgeTTL {
			delete(c.httpEdges, k)
			continue
		}
		out = append(out, h.samples("watchlog_http_", append(k.src.labels(), k.dst.labels()...))...)
	}
	for k, h := range c.httpServers {
		if now.Sub(h.seen) > edgeTTL {
			delete(c.httpServers, k)
			continue
		}
		out = append(out, h.samples("watchlog_http_server_", append(k.src.labels(), "port", strconv.Itoa(int(k.port))))...)
	}
	return out
}
