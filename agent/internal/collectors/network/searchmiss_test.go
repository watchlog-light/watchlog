// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/watchlog-light/watchlog/agent/internal/ebpf"
)

// nxdomain builds an NXDOMAIN response for name, cut after its question as the
// kernel copies it.
func nxdomain(name string) []byte {
	msg := response(name)
	msg[3] = 0x83 // RA, rcode 3
	return msg
}

// kindSearch is the agent pod's search list on kind in a Lima VM (ADR-113); the node's
// own domain is replaced with "lan".
var kindSearch = []string{"watchlog.svc.cluster.local", "svc.cluster.local", "cluster.local", "lan"}

func TestSearchDomainsFromResolvConf(t *testing.T) {
	got := SearchDomains("testdata/dns/kind-resolv.conf")
	if !slices.Equal(got, kindSearch) {
		t.Errorf("kind: %v, want %v", got, kindSearch)
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "resolv.conf")
	// The last search or domain line wins; case and trailing dots do not matter.
	conf := "domain old.example\nsearch Corp.Example. lan\nnameserver 10.0.0.2\noptions ndots:5\n"
	if err := os.WriteFile(p, []byte(conf), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := SearchDomains(p); !slices.Equal(got, []string{"corp.example", "lan"}) {
		t.Errorf("host: %v", got)
	}
	if got := SearchDomains(filepath.Join(dir, "missing")); got != nil {
		t.Errorf("missing file: %v", got)
	}
	if NewSearchMisses(nil) != nil {
		t.Error("a counter without search domains")
	}
}

// With ndots:5, example.com is tried under each search domain before itself: those
// NXDOMAINs are misses. A name that does not exist, tried last, is not; nor are
// responses other than NXDOMAIN.
func TestSearchMissesClassify(t *testing.T) {
	s := NewSearchMisses(kindSearch)
	for _, name := range []string{
		"example.com.watchlog.svc.cluster.local",
		"example.com.svc.cluster.local",
		"example.com.cluster.local",
		"example.com.lan",
	} {
		s.Add(7, nxdomain(name))
	}
	s.Add(7, nxdomain("no-such-name.example")) // the name itself: an error
	s.Add(7, nxdomain("cluster.local"))        // the domain itself, not under it
	s.Add(7, nxdomain("evilcluster.local"))    // not under ".cluster.local"
	s.Add(7, response("example.com.svc.cluster.local"))
	s.Add(7, nxdomain("x")[:11]) // shorter than a header
	if got := s.take(7, 100); got != 4 {
		t.Errorf("misses = %d, want 4", got)
	}
}

// A drain takes at most the NXDOMAIN responses the kernel counted; misses read just
// after a drain go to the next one, and are dropped after two.
func TestSearchMissesTakeAndRotate(t *testing.T) {
	s := NewSearchMisses(kindSearch)
	for range 3 {
		s.Add(1, nxdomain("a.b.svc.cluster.local"))
	}
	if got := s.take(1, 2); got != 2 {
		t.Errorf("first take = %d, want 2 (capped)", got)
	}
	s.rotate()
	if got := s.take(1, 5); got != 1 {
		t.Errorf("after one drain = %d, want 1", got)
	}
	s.Add(2, nxdomain("a.cluster.local"))
	s.rotate()
	s.rotate()
	if got := s.take(2, 5); got != 0 {
		t.Errorf("after two drains = %d, want 0", got)
	}
}

// Misses leave NXDOMAIN for rcode search_miss in the collector's series.
func TestCollectSeparatesSearchMisses(t *testing.T) {
	d := &dnsDrainer{dns: [][]ebpf.DNSStat{
		{{Cgroup: 1, Queries: 10, NoError: 2, NXDomain: 8}},
	}}
	c := New(d, func() (map[uint64]Owner, error) { return map[uint64]Owner{1: {PodID: "p-web"}}, nil },
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.Names = func(o Owner) (Source, bool) {
		return Source{Namespace: "shop", WorkloadKind: "Deployment", Workload: "web"}, true
	}
	c.SearchMisses = NewSearchMisses(kindSearch)
	for range 6 {
		c.SearchMisses.Add(1, nxdomain("example.com.shop.svc.cluster.local"))
	}
	out, _ := c.Collect()
	for rcode, want := range map[string]float64{"NOERROR": 2, "NXDOMAIN": 2, "search_miss": 6} {
		if v := value(out, "watchlog_dns_requests_total", "workload", "web", "rcode", rcode); v != want {
			t.Errorf("%s = %v, want %v", rcode, v, want)
		}
	}
}

// One NXDOMAIN response per call, half under a search domain, a drain every 50.
func BenchmarkSearchMisses(b *testing.B) {
	s := NewSearchMisses(kindSearch)
	msgs := [][]byte{nxdomain("api.example.com.watchlog.svc.cluster.local"), nxdomain("api.example.com")}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		s.Add(uint64(i%50), msgs[i%2])
		if i%50 == 49 {
			for cg := range uint64(50) {
				s.take(cg, 100)
			}
			s.rotate()
		}
	}
}
