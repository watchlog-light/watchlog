// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"net/netip"
	"testing"
)

// A server's own ports (ADR-210): orders calling PostgreSQL on 127.0.0.1:5432 is an edge to
// the postgresql unit, also through the server's own address; any other loopback port is no
// edge, as before.
func TestResolveLocalPorts(t *testing.T) {
	r := NewResolver(nil, nil)
	r.SetLocal(map[uint16]Dest{
		5432: {Kind: DstWorkload, WorkloadKind: "Service", Workload: "postgresql@16-main.service"},
		8092: {Kind: DstWorkload, WorkloadKind: "ProcessGroup", Workload: "api"},
	}, []netip.Addr{netip.MustParseAddr("192.168.5.15")})
	cases := []struct {
		addr     string
		port     uint16
		workload string
		ok       bool
	}{
		{"127.0.0.1", 5432, "postgresql@16-main.service", true},
		{"::1", 8092, "api", true},
		{"192.168.5.15", 5432, "postgresql@16-main.service", true},
		{"127.0.0.1", 6000, "", false},
	}
	for _, c := range cases {
		d, ok := r.Resolve(netip.MustParseAddr(c.addr), c.port)
		if ok != c.ok || d.Workload != c.workload || (ok && d.Port != c.port) {
			t.Errorf("%s:%d → %+v %v", c.addr, c.port, d, ok)
		}
	}
	// Another machine's address on a local port is still external.
	if d, _ := r.Resolve(netip.MustParseAddr("8.8.8.8"), 5432); d.Kind != DstExternal {
		t.Errorf("8.8.8.8:5432 → %+v", d)
	}
}
