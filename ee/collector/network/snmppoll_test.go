// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"context"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/ee/collector/netsim"
)

// lab serves specs over UDP and returns devices pointing at them.
func lab(t *testing.T, clock func() time.Time, specs []netsim.Spec, start time.Time) ([]Device, map[string]*netsim.Agent) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	srv := &netsim.Server{Community: "public", Clock: clock}
	var devs []Device
	agents := map[string]*netsim.Agent{}
	for _, s := range specs {
		a := netsim.Build(s, start)
		addr, err := srv.Listen(ctx, "127.0.0.1:0", a)
		if err != nil {
			t.Fatal(err)
		}
		host, port, _ := net.SplitHostPort(addr)
		p, _ := strconv.Atoi(port)
		devs = append(devs, Device{ID: "dev-" + s.Name, Name: s.Name, Address: host, Protocol: "snmp", SNMP: &SNMPCred{Version: "2c", Community: "public", Port: p}})
		agents[s.Name] = a
	}
	return devs, agents
}

func TestPollCatalystOverSNMP(t *testing.T) {
	start := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	now := start.Add(30 * 24 * time.Hour)
	clock := func() time.Time { return now }
	nodes := []netsim.Endpoint{{MAC: "52:54:00:aa:00:01", VLAN: 10, IP: "10.0.10.21"}, {MAC: "52:54:00:aa:00:02", VLAN: 10, IP: "10.0.10.22"}}
	devs, _ := lab(t, clock, netsim.Office(nodes), start)
	ps, err := LoadProfiles()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// sw-access-2: a stack of two 3850s, PoE, per-VLAN MAC tables.
	st := newSNMPState()
	rep, samples := pollSNMP(ctx, Dial, ps, devs[2], st, now, true)
	if rep.State != StateOK {
		t.Fatalf("state %s: %s", rep.State, rep.Error)
	}
	if rep.Profile != "cisco-ios" || rep.System.Model != "WS-C3850-48P" || rep.System.Firmware != "16.12.9" || rep.System.Serial == "" {
		t.Fatalf("system %+v profile %s", rep.System, rep.Profile)
	}
	if rep.System.UptimeS != 30*24*3600 {
		t.Fatalf("uptime %d", rep.System.UptimeS)
	}
	h := rep.Health
	if h.CPU == nil || *h.CPU <= 0 || *h.CPU > 1 || h.MemTotal == nil || *h.MemTotal != 510_000_000 || h.Temperature == nil || *h.Temperature != 38 {
		t.Fatalf("health cpu=%v mem=%v temp=%v", h.CPU, h.MemTotal, h.Temperature)
	}
	if len(h.Fans) != 1 || h.Fans[0].State != "ok" || len(h.PSUs) != 1 {
		t.Fatalf("fans %+v psus %+v", h.Fans, h.PSUs)
	}
	if len(h.Stack) != 2 || h.Stack[0].Role != "active" || h.Stack[1].Role != "standby" || h.Stack[1].State != "ready" {
		t.Fatalf("stack %+v", h.Stack)
	}
	if len(h.Optics) == 0 || h.Optics[0].Port != "Te1/1/1" || *h.Optics[0].RxDBm != -2.4 || *h.Optics[0].RxLow != -10 || *h.Optics[0].RxHigh != 0.5 {
		t.Fatalf("optics %+v", h.Optics)
	}
	if len(h.Ports) != 104 {
		t.Fatalf("ports %d, want 104 (2 × 48 + 2 × 4)", len(h.Ports))
	}
	inv := rep.Inventory
	var poe int
	for _, i := range inv.Interfaces {
		if i.PoEWatts != nil {
			poe++
		}
	}
	if poe == 0 {
		t.Fatal("no PoE draw on the 3850")
	}
	if len(inv.Neighbours) != 2 || inv.Neighbours[0].RemoteName != "core-1" || inv.Neighbours[0].LocalPort != "Te1/1/1" {
		t.Fatalf("neighbours %+v", inv.Neighbours)
	}
	vlans := map[int]int{}
	for _, m := range inv.MACs {
		vlans[m.VLAN]++
	}
	if vlans[10] != 2 || vlans[20] != 6 || vlans[150] != 2 {
		t.Fatalf("MACs by VLAN %v (%+v)", vlans, inv.MACs)
	}
	if len(inv.ARP) == 0 {
		t.Fatal("no ARP")
	}
	// Series: only ports up or busy, labels device and ifname only, never an address.
	names := map[string]bool{}
	for _, s := range samples {
		for _, l := range s.Labels {
			if l.Name != "device" && l.Name != "ifname" {
				t.Fatalf("label %s", l.Name)
			}
			if net.ParseIP(l.Value) != nil {
				t.Fatalf("an address as a label: %s", l.Value)
			}
		}
		names[s.Name] = true
	}
	for _, n := range []string{"watchlog_net_up", "watchlog_net_cpu_utilization", "watchlog_net_memory_utilization", "watchlog_net_temperature_celsius", "watchlog_net_if_in_bytes_total"} {
		if !names[n] {
			t.Fatalf("no %s", n)
		}
	}
	up := 0
	for _, p := range h.Ports {
		if p.OperUp {
			up++
		}
	}
	if len(samples) > (up+20)*6+10 {
		t.Fatalf("%d series for %d ports up", len(samples), up)
	}

	// core-1: the Nexus. Memory as a percentage, fans from FRU control, Q-BRIDGE MACs.
	st = newSNMPState()
	rep, _ = pollSNMP(ctx, Dial, ps, devs[0], st, now, true)
	if rep.State != StateOK || rep.Profile != "cisco-nxos" || rep.System.Model != "N3K-C3064PQ-10GX" {
		t.Fatalf("nexus %s %s %+v", rep.State, rep.Profile, rep.System)
	}
	if rep.Health.MemTotal == nil || *rep.Health.MemTotal != 100 || len(rep.Health.Fans) != 4 || len(rep.Health.PSUs) != 2 || rep.Health.Temperature == nil || *rep.Health.Temperature != 46 {
		t.Fatalf("nexus health %+v", rep.Health)
	}
	if len(rep.Inventory.Neighbours) != 6 { // CDP and LLDP for 3 neighbours
		t.Fatalf("nexus neighbours %d", len(rep.Inventory.Neighbours))
	}

	// A wrong community: no answer, unreachable.
	bad := devs[1]
	bad.SNMP = &SNMPCred{Version: "2c", Community: "nope", Port: devs[1].SNMP.Port}
	st = newSNMPState()
	ctx2, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	rep, _ = pollSNMP(ctx2, fastDial, ps, bad, st, now, false)
	if rep.State != StateUnreachable {
		t.Fatalf("wrong community → %s (%s)", rep.State, rep.Error)
	}
}

// fastDial is Dial with a short timeout, for tests of devices that don't answer.
func fastDial(address string, c *SNMPCred, v3Context, community string) (Reader, error) {
	r, err := Dial(address, c, v3Context, community)
	if err != nil {
		return nil, err
	}
	s := r.(*session)
	s.g.Timeout, s.g.Retries = 50*time.Millisecond, 0
	return r, nil
}
