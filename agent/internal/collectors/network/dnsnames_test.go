// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"encoding/binary"
	"io"
	"log/slog"
	"net/netip"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/ebpf"
)

// Real responses as the kernel hands them to user space (ebpf test, WATCHLOG_DNS_CAPTURE):
// Lima's DNS proxy answers with TTL 0, CoreDNS on kind with TTL 5.
func TestParseAnswersFromCaptures(t *testing.T) {
	for file, want := range map[string]struct {
		name  string
		addrs []string
		ttl   uint32
	}{
		"lima-example.com.bin":    {"example.com", []string{"172.66.147.243", "104.20.23.154"}, 0},
		"lima-api.github.com.bin": {"api.github.com", []string{"4.225.11.201"}, 0},
		"kind-example.com.bin":    {"example.com", []string{"172.66.147.243", "104.20.23.154"}, 5},
		"kind-www.github.com.bin": {"www.github.com", []string{"4.225.11.194"}, 5},
	} {
		msg, err := os.ReadFile("testdata/dns/" + file)
		if err != nil {
			t.Fatal(err)
		}
		name, answers := parseAnswers(msg)
		var addrs []string
		for _, a := range answers {
			addrs = append(addrs, a.addr.String())
			if a.ttl != want.ttl {
				t.Errorf("%s: ttl %d, want %d", file, a.ttl, want.ttl)
			}
		}
		if name != want.name || strings.Join(addrs, ",") != strings.Join(want.addrs, ",") {
			t.Errorf("%s: %q %v, want %q %v", file, name, addrs, want.name, want.addrs)
		}
	}
}

// response builds a DNS response for name with the given answer records.
func response(name string, records ...[]byte) []byte {
	msg := []byte{0x12, 0x34, 0x81, 0x80, 0, 1, 0, byte(len(records)), 0, 0, 0, 0}
	msg = append(msg, wire(name)...)
	msg = append(msg, 0, 1, 0, 1)
	for _, r := range records {
		msg = append(msg, r...)
	}
	return msg
}

func wire(name string) []byte {
	var b []byte
	for _, l := range strings.Split(name, ".") {
		b = append(b, byte(len(l)))
		b = append(b, l...)
	}
	return append(b, 0)
}

// record has the owner as a pointer to the question name (offset 12).
func record(typ uint16, ttl uint32, rdata []byte) []byte {
	r := []byte{0xc0, 12}
	r = binary.BigEndian.AppendUint16(r, typ)
	r = binary.BigEndian.AppendUint16(r, classIN)
	r = binary.BigEndian.AppendUint32(r, ttl)
	r = binary.BigEndian.AppendUint16(r, uint16(len(rdata)))
	return append(r, rdata...)
}

func TestParseAnswersCNAMEChainAndAAAA(t *testing.T) {
	v6 := netip.MustParseAddr("2001:db8::7").As16()
	msg := response("WWW.Example.COM",
		record(5, 300, wire("edge.cdn.example.net")),
		record(typeA, 60, []byte{203, 0, 113, 7}),
		record(typeAAAA, 60, v6[:]),
		record(16, 60, []byte("\x04text")), // TXT: skipped
	)
	name, answers := parseAnswers(msg)
	if name != "www.example.com" || len(answers) != 2 ||
		answers[0].addr.String() != "203.0.113.7" || answers[1].addr.String() != "2001:db8::7" {
		t.Fatalf("got %q %+v", name, answers)
	}
}

func TestParseAnswersRejectsMalformed(t *testing.T) {
	good := response("example.com", record(typeA, 60, []byte{203, 0, 113, 7}))
	loop := append([]byte{0x12, 0x34, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0}, 0xc0, 12)
	for name, msg := range map[string][]byte{
		"empty":           nil,
		"header only":     good[:12],
		"cut in question": good[:16],
		"pointer loop":    loop,
		"two questions":   append(append([]byte{}, good[:5]...), append([]byte{2}, good[6:]...)...),
		"odd characters":  response("ex ample.com", record(typeA, 60, []byte{1, 2, 3, 4})),
	} {
		if n, a := parseAnswers(msg); len(a) != 0 {
			t.Errorf("%s: parsed %q %+v", name, n, a)
		}
	}
	// Cut inside the answers: the complete ones are kept.
	two := response("example.com", record(typeA, 60, []byte{203, 0, 113, 7}), record(typeA, 60, []byte{203, 0, 113, 8}))
	if _, a := parseAnswers(two[:len(two)-2]); len(a) != 1 {
		t.Errorf("truncated: %+v", a)
	}
}

func TestNamesTTLFloorHoldAndCgroups(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	n := NewNames()
	n.now = func() time.Time { return now }
	addr := netip.MustParseAddr("203.0.113.7")
	n.Add(42, response("api.example.com", record(typeA, 0, addr.AsSlice())))

	if name, ok := n.Lookup(42, addr); !ok || name != "api.example.com" {
		t.Fatalf("lookup = %q %v", name, ok)
	}
	if _, ok := n.Lookup(7, addr); ok {
		t.Fatal("another container's lookup must not name this address")
	}
	// TTL 0 lasts the 60 s floor; a lookup holds it 10 minutes from then.
	now = now.Add(50 * time.Second)
	if _, ok := n.Lookup(42, netip.AddrFrom16(addr.As16())); !ok {
		t.Fatal("IPv4-mapped address not found within the floor")
	}
	now = now.Add(9 * time.Minute)
	if _, ok := n.Lookup(42, addr); !ok {
		t.Fatal("held name expired while in use")
	}
	now = now.Add(11 * time.Minute)
	if _, ok := n.Lookup(42, addr); ok {
		t.Fatal("unused name did not expire")
	}
	if n.Len() != 0 {
		t.Fatalf("expired entry kept: %d", n.Len())
	}
}

func TestNamesBounded(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	n := NewNames()
	n.now = func() time.Time { return now }
	for i := 0; i < MaxNames+500; i++ {
		a := netip.AddrFrom4([4]byte{10, byte(i >> 16), byte(i >> 8), byte(i)})
		n.Add(1, response("h.example.com", record(typeA, uint32(60+i), a.AsSlice())))
	}
	if n.Len() > MaxNames || n.Len() < MaxNames*9/10 {
		t.Fatalf("len %d, want at most %d", n.Len(), MaxNames)
	}
	// The ones closest to expiry (the first added) made room.
	if _, ok := n.Lookup(1, netip.AddrFrom4([4]byte{10, 0, 0, 0})); ok {
		t.Fatal("oldest entry kept")
	}
	last := MaxNames + 499
	if _, ok := n.Lookup(1, netip.AddrFrom4([4]byte{10, byte(last >> 16), byte(last >> 8), byte(last)})); !ok {
		t.Fatal("newest entry dropped")
	}
}

// A new name per response into a full map (eviction included), and one drain's 500
// lookups per 50 responses.
func BenchmarkNames(b *testing.B) {
	n := NewNames()
	for i := 0; i < MaxNames; i++ {
		a := netip.AddrFrom4([4]byte{10, byte(i >> 16), byte(i >> 8), byte(i)})
		n.Add(uint64(i%50), response("h.example.com", record(typeA, 300, a.AsSlice())))
	}
	msgs := make([][]byte, 4096)
	for i := range msgs {
		msgs[i] = response("h.example.com", record(typeA, 300, []byte{172, 16, byte(i >> 8), byte(i)}))
	}
	a := netip.AddrFrom4([4]byte{10, 0, 1, 2})
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		n.Add(uint64(i), msgs[i%len(msgs)])
		if i%50 == 0 {
			for j := 0; j < 500; j++ {
				n.Lookup(uint64(j%50), a)
			}
		}
	}
}

// An external edge is named by the container's own lookup; another address in the same
// /24 that it did not look up stays a network.
func TestExternalEdgesNamedByDNS(t *testing.T) {
	named, other := netip.MustParseAddr("203.0.113.7"), netip.MustParseAddr("203.0.113.9")
	d := &fakeDrainer{flows: [][]ebpf.Flow{{
		{Cgroup: 11, Addr: named, Port: 443, Connects: 2},
		{Cgroup: 11, Addr: other, Port: 443, Connects: 1},
	}}}
	c := New(d, func() (map[uint64]Owner, error) {
		return map[uint64]Owner{11: {PodID: "p-web"}}, nil
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.Names = func(o Owner) (Source, bool) {
		return Source{Namespace: "shop", WorkloadKind: "Deployment", Workload: "web"}, true
	}
	c.DNSNames = NewNames()
	c.DNSNames.Add(11, response("api.stripe.com", record(typeA, 300, named.AsSlice())))
	out, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if v := value(out, "watchlog_flow_connections_total", "dst_kind", "external", "dst", "api.stripe.com", "dst_port", "443"); v != 2 {
		t.Errorf("named edge = %v", v)
	}
	if v := value(out, "watchlog_flow_connections_total", "dst_kind", "external", "dst", "203.0.113.0/24", "dst_port", "443"); v != 1 {
		t.Errorf("unnamed edge = %v", v)
	}
	if v := value(out, "watchlog_agent_dns_names"); v != 1 {
		t.Errorf("names held = %v", v)
	}
}
