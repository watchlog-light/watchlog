// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"strconv"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/ebpf"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// edgeTTL ends an edge's series after this long without connections.
const edgeTTL = 10 * time.Minute

// Source is the workload (Kubernetes) or container (Docker) that opened connections.
type Source struct {
	Namespace      string
	WorkloadKind   string
	Workload       string
	Container      string
	ComposeProject string
	ComposeService string
}

func (s Source) key() string {
	return s.Namespace + "/" + s.WorkloadKind + "/" + s.Workload + "/" + s.Container
}

func (s Source) labels() []string {
	var l []string
	for _, kv := range [][2]string{{"namespace", s.Namespace}, {"workload_kind", s.WorkloadKind}, {"workload", s.Workload},
		{"container", s.Container}, {"compose_project", s.ComposeProject}, {"compose_service", s.ComposeService}} {
		if kv[1] != "" {
			l = append(l, kv[0], kv[1])
		}
	}
	return l
}

func (d Dest) labels() []string {
	l := []string{"dst_kind", d.Kind}
	for _, kv := range [][2]string{{"dst_namespace", d.Namespace}, {"dst_workload_kind", d.WorkloadKind},
		{"dst_workload", d.Workload}, {"dst_service", d.Service}, {"dst", d.Name}} {
		if kv[1] != "" {
			l = append(l, kv[0], kv[1])
		}
	}
	if d.Port != 0 {
		l = append(l, "dst_port", strconv.Itoa(int(d.Port)))
	}
	return l
}

type edgeKey struct {
	src Source
	dst Dest
}

// edge holds cumulative counters: series are counters, the kernel gives deltas.
type edge struct {
	connects, failed, established, latSumNs float64
	lat                                     [12]float64
	sent, recv, retrans                     float64
	seen                                    time.Time
}

func (e *edge) add(f ebpf.Flow, now time.Time) {
	e.connects += float64(f.Connects)
	e.failed += float64(f.Failures)
	e.established += float64(f.Established)
	e.latSumNs += float64(f.LatSumNs)
	for i, n := range f.Latency {
		e.lat[i] += float64(n)
	}
	e.sent += float64(f.BytesSent)
	e.recv += float64(f.BytesRecv)
	e.retrans += float64(f.Retransmits)
	e.seen = now
}

var leLabels = func() []string {
	out := make([]string, 0, len(ebpf.LatencyBuckets)+1)
	for _, b := range ebpf.LatencyBuckets {
		out = append(out, strconv.FormatFloat(b, 'g', -1, 64))
	}
	return append(out, "+Inf")
}()

// samples are the SPEC §6.3 flow series of one edge.
func (e *edge) samples(k edgeKey, bytes bool) []metrics.Sample {
	l := append(k.src.labels(), k.dst.labels()...)
	with := func(extra ...string) []string { return append(append([]string{}, l...), extra...) }
	out := []metrics.Sample{
		metrics.New("watchlog_flow_connections_total", e.connects, l...),
		metrics.New("watchlog_flow_connect_failed_total", e.failed, l...),
		metrics.New("watchlog_flow_retransmits_total", e.retrans, l...),
		metrics.New("watchlog_flow_connect_latency_seconds_sum", e.latSumNs/1e9, l...),
		metrics.New("watchlog_flow_connect_latency_seconds_count", e.established, l...),
	}
	cum := 0.0
	for i, le := range leLabels {
		cum += e.lat[i]
		out = append(out, metrics.New("watchlog_flow_connect_latency_seconds_bucket", cum, with("le", le)...))
	}
	if bytes {
		out = append(out,
			metrics.New("watchlog_flow_bytes_total", e.sent, with("dir", "sent")...),
			metrics.New("watchlog_flow_bytes_total", e.recv, with("dir", "received")...))
	}
	return out
}
