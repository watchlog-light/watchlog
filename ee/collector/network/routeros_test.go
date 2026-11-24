// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"context"
	"errors"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/ee/collector/netsim"
)

func rosDevice(t *testing.T, addr string, c ROSCred) Device {
	t.Helper()
	host, port, _ := net.SplitHostPort(addr)
	c.Port, _ = strconv.Atoi(port)
	c.User, c.Password = "watchlog", "read-only-sample"
	return Device{ID: "dev-edge-1", Name: "edge-1", Address: host, Protocol: "routeros", RouterOS: &c}
}

func TestRouterOS(t *testing.T) {
	start := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	now := start.Add(15*24*time.Hour + 3*time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fake := netsim.Edge(start)
	fake.Clock = func() time.Time { return now }
	pin, err := fake.NewCert()
	if err != nil {
		t.Fatal(err)
	}
	rest, err := fake.ServeREST(ctx, "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	apiSSL, _ := fake.ServeAPI(ctx, "127.0.0.1:0", true)
	plain, _ := fake.ServeAPI(ctx, "127.0.0.1:0", false)
	ps, _ := LoadProfiles()
	p := ps["mikrotik"]

	// First contact over REST: no pin yet, the fingerprint comes back to be pinned.
	dev := rosDevice(t, rest, ROSCred{})
	st := newROSState()
	rep, samples := pollROS(ctx, DialROS, p, dev, st, now, true)
	if rep.State != StateOK {
		t.Fatalf("REST: %s %s", rep.State, rep.Error)
	}
	if rep.Fingerprint != pin {
		t.Fatalf("fingerprint %q, want the pin %q", rep.Fingerprint, pin)
	}
	s := rep.System
	if s.Name != "edge-1" || s.Model != "CCR2004-16G-2S+" || s.Firmware != "7.16.2" || s.Serial == "" || s.UptimeS != int64((15*24+3)*3600) {
		t.Fatalf("system %+v", s)
	}
	if s.Update == nil || s.Update.Channel != "stable" || s.Update.Latest != "7.16.2" {
		t.Fatalf("update %+v", s.Update)
	}
	h := rep.Health
	if *h.CPU != 0.04 || *h.MemTotal != 4294967296 || *h.Temperature != 51 || len(h.Fans) != 2 || len(h.PSUs) != 2 {
		t.Fatalf("health %+v", h)
	}
	if len(h.Optics) != 2 || *h.Optics[0].RxDBm != -3.112 {
		t.Fatalf("optics %+v", h.Optics)
	}
	inv := rep.Inventory
	if len(inv.Neighbours) != 1 || inv.Neighbours[0].RemoteName != "core-1" || inv.Neighbours[0].Protocol != "cdp" || inv.Neighbours[0].LocalPort != "sfp-sfpplus1" {
		t.Fatalf("neighbours %+v", inv.Neighbours)
	}
	if len(inv.MACs) != 1 || len(inv.ARP) != 2 || *inv.Routes != 25 || inv.Gateway != "203.0.113.1" {
		t.Fatalf("macs %d arp %d routes %v gw %q", len(inv.MACs), len(inv.ARP), inv.Routes, inv.Gateway)
	}
	var sfp *PortState
	for i := range h.Ports {
		if h.Ports[i].Name == "sfp-sfpplus1" {
			sfp = &h.Ports[i]
		}
	}
	if sfp == nil || sfp.SpeedMbps != 10000 || !sfp.OperUp {
		t.Fatalf("sfp-sfpplus1 %+v", sfp)
	}
	if len(samples) == 0 {
		t.Fatal("no series")
	}

	// Pinned and unchanged: fine. A new certificate: cert_changed, and no data read.
	dev.RouterOS.Pin = pin
	if rep, _ = pollROS(ctx, DialROS, p, dev, st, now.Add(time.Minute), false); rep.State != StateOK {
		t.Fatalf("pinned: %s %s", rep.State, rep.Error)
	}
	if _, err := fake.NewCert(); err != nil {
		t.Fatal(err)
	}
	rep, samples = pollROS(ctx, DialROS, p, dev, st, now.Add(2*time.Minute), false)
	if rep.State != StateCertChanged || rep.System != nil || len(samples) != 0 || rep.Fingerprint == "" || rep.Fingerprint == pin {
		t.Fatalf("changed certificate: %s %+v %q", rep.State, rep.System, rep.Fingerprint)
	}
	newPin := ""
	{
		d := rosDevice(t, rest, ROSCred{})
		r, err := DialROS(ctx, d.Address, d.RouterOS)
		if err != nil {
			t.Fatal(err)
		}
		newPin = r.Fingerprint()
		_ = r.Close()
	}

	// API-SSL, with the new pin accepted.
	d2 := rosDevice(t, apiSSL, ROSCred{Transport: "api-ssl", Pin: newPin})
	if rep, _ = pollROS(ctx, DialROS, p, d2, newROSState(), now, true); rep.State != StateOK || rep.System.Name != "edge-1" || len(rep.Inventory.Neighbours) != 1 {
		t.Fatalf("api-ssl: %s %s", rep.State, rep.Error)
	}
	d2.RouterOS.Pin = pin // the old one
	if rep, _ = pollROS(ctx, DialROS, p, d2, newROSState(), now, false); rep.State != StateCertChanged {
		t.Fatalf("api-ssl old pin: %s", rep.State)
	}

	// REST missing: the fallback finds API-SSL.
	_, ap, _ := net.SplitHostPort(apiSSL)
	old := apiSSLPort
	apiSSLPort, _ = strconv.Atoi(ap)
	defer func() { apiSSLPort = old }()
	closed, _ := net.Listen("tcp", "127.0.0.1:0")
	gone := closed.Addr().String()
	_ = closed.Close()
	d3 := rosDevice(t, gone, ROSCred{})
	r, err := DialROS(ctx, d3.Address, d3.RouterOS)
	if err != nil || r.Transport() != "api-ssl" {
		t.Fatalf("fallback: %v", err)
	}
	_ = r.Close()

	// The plain API: refused unless allowed.
	d4 := rosDevice(t, plain, ROSCred{Transport: "api"})
	if _, err := DialROS(ctx, d4.Address, d4.RouterOS); !errors.Is(err, ErrPlainRefused) {
		t.Fatalf("plain without allow: %v", err)
	}
	d4.RouterOS.AllowPlain = true
	if rep, _ = pollROS(ctx, DialROS, p, d4, newROSState(), now, false); rep.State != StateOK {
		t.Fatalf("plain allowed: %s %s", rep.State, rep.Error)
	}

	// A wrong password: auth_failed.
	d5 := rosDevice(t, rest, ROSCred{Pin: newPin})
	d5.RouterOS.Password = "wrong"
	if rep, _ = pollROS(ctx, DialROS, p, d5, newROSState(), now, false); rep.State != StateAuthFailed {
		t.Fatalf("wrong password: %s %s", rep.State, rep.Error)
	}

	// Only reads: the client refuses other paths, and the router saw no write.
	rc, _ := DialROS(ctx, d2.Address, &ROSCred{Transport: "api-ssl", User: "watchlog", Password: "read-only-sample", Port: d2.RouterOS.Port})
	if _, err := rc.Print(ctx, "system/reboot"); !errors.Is(err, errNotRead) {
		t.Fatalf("system/reboot: %v", err)
	}
	_ = rc.Close()
	if n := fake.Writes.Load(); n != 0 {
		t.Fatalf("%d writes reached the router", n)
	}
}

func TestRosDuration(t *testing.T) {
	for in, want := range map[string]time.Duration{
		"4w2d10:11:12": (4*7+2)*24*time.Hour + 10*time.Hour + 11*time.Minute + 12*time.Second,
		"1d02:03:04":   26*time.Hour + 3*time.Minute + 4*time.Second,
		"00:00:59":     59 * time.Second,
		"5h3m2s":       5*time.Hour + 3*time.Minute + 2*time.Second,
		"2w":           14 * 24 * time.Hour,
	} {
		if got := rosDuration(in); got != want {
			t.Errorf("%s → %v, want %v", in, got, want)
		}
	}
}
