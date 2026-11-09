// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"io"
	"log/slog"
	"net/netip"
	"testing"

	"github.com/watchlog-light/watchlog/agent/internal/ebpf"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

type fakeHTTPDrainer struct {
	fakeDrainer
	http [][]ebpf.HTTPStat
}

func (f *fakeHTTPDrainer) DrainHTTP() ([]ebpf.HTTPStat, error) {
	if len(f.http) == 0 {
		return nil, nil
	}
	out := f.http[0]
	f.http = f.http[1:]
	return out, nil
}

func count(out []metrics.Sample, name string) int {
	n := 0
	for _, s := range out {
		if s.Name == name {
			n++
		}
	}
	return n
}

// A client's requests land on its edge, with the flow series' labels; a server's on its
// own workload and port. Counters accumulate, status codes appear once seen, and the
// latency histogram is cumulative.
func TestHTTPEdgesAndServers(t *testing.T) {
	ingress, client := netip.MustParseAddr("10.244.1.7"), netip.MustParseAddr("192.0.2.10")
	slot := func(code string) int {
		for i, c := range ebpf.HTTPStatusCodes {
			if c == code {
				return i
			}
		}
		t.Fatalf("no slot %s", code)
		return 0
	}
	var st [21]uint64
	st[slot("200")], st[slot("503")] = 90, 10
	var lat [15]uint64
	lat[2], lat[10], lat[13] = 80, 15, 5 // ≤2.5 ms, ≤1 s, ≤10 s
	d := &fakeHTTPDrainer{http: [][]ebpf.HTTPStat{
		{
			{Cgroup: 11, Addr: ingress, Port: 80, Reads: 70, Writes: 30, Status: st, Latency: lat, LatSumNs: 9e9},
			{Cgroup: 12, Addr: client, Port: 80, Server: true, Reads: 100, Status: st, Latency: lat},
			{Cgroup: 99, Addr: ingress, Port: 80, Reads: 5}, // no known container: dropped
		},
		{{Cgroup: 11, Addr: ingress, Port: 80, Reads: 1, Status: [21]uint64{0}, Latency: [15]uint64{1}}},
	}}
	c := New(d, func() (map[uint64]Owner, error) {
		return map[uint64]Owner{11: {PodID: "p-front"}, 12: {PodID: "p-ingress"}}, nil
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.Names = func(o Owner) (Source, bool) {
		if o.PodID == "p-ingress" {
			return Source{Namespace: "ingress-nginx", WorkloadKind: "Deployment", Workload: "controller"}, true
		}
		return Source{Namespace: "shop", WorkloadKind: "Deployment", Workload: "frontend"}, true
	}
	out, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	edge := []string{"workload", "frontend", "dst_port", "80"}
	if v := value(out, "watchlog_http_requests_total", append(edge, "code", "503", "class", "5xx")...); v != 10 {
		t.Errorf("503s on the edge = %v", v)
	}
	if v := value(out, "watchlog_http_requests_by_method_total", append(edge, "method", "write")...); v != 30 {
		t.Errorf("writes = %v", v)
	}
	if v := value(out, "watchlog_http_request_duration_seconds_bucket", append(edge, "le", "1")...); v != 95 {
		t.Errorf("≤1 s cumulative = %v", v)
	}
	if v := value(out, "watchlog_http_request_duration_seconds_bucket", append(edge, "le", "+Inf")...); v != 100 {
		t.Errorf("+Inf = %v", v)
	}
	// Only the codes seen: 200 and 503, on the edge and on the server.
	if n, m := count(out, "watchlog_http_requests_total"), count(out, "watchlog_http_server_requests_total"); n != 2 || m != 2 {
		t.Errorf("requests series = %d edge, %d server; want 2 and 2", n, m)
	}
	if v := value(out, "watchlog_http_server_requests_total", "workload", "controller", "port", "80", "code", "200"); v != 90 {
		t.Errorf("server 200s = %v", v)
	}
	// The next interval adds to the counters.
	out, _ = c.Collect()
	if v := value(out, "watchlog_http_request_duration_seconds_count", edge...); v != 101 {
		t.Errorf("count after two intervals = %v", v)
	}
}
