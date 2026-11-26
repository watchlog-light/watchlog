// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"context"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/ee/collector/netsim"
)

// "Test against an address" (1.0.2) is a discovery of one address with one credential and no
// neighbours. These are its outcomes against the simulators: a switch, a router and a
// recorder. The sentences asserted here are the ones the backend reads to word the result
// (ee/backend/src/network/routes-manage.ts, outcomeOf): changing one here changes it there.
func TestProbeOutcomes(t *testing.T) {
	old := probeEvery
	probeEvery = time.Millisecond
	defer func() { probeEvery = old }()
	start := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	clock := func() time.Time { return start.Add(time.Hour) }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// A switch over SNMP (the lab answers the community "public").
	devs, _ := lab(t, clock, netsim.Office(nil)[:1], start)
	snmpPort := devs[0].SNMP.Port
	// A router over REST and API-SSL.
	edge := netsim.Edge(start)
	rest, err := edge.ServeREST(ctx, "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, rp, _ := net.SplitHostPort(rest)
	restPort, _ := strconv.Atoi(rp)
	// A recorder.
	nvr := netsim.NVR()
	rec := serveNVR(t, ctx, nvr, false)
	// A port nothing listens on.
	closed, _ := net.Listen("tcp", "127.0.0.1:0")
	_, gp, _ := net.SplitHostPort(closed.Addr().String())
	_ = closed.Close()
	gonePort, _ := strconv.Atoi(gp)

	// The router's certificate as it is now, read as a first contact would pin it.
	first, err := DialROS(ctx, "127.0.0.1", &ROSCred{User: "watchlog", Password: "read-only-sample", Port: restPort})
	if err != nil {
		t.Fatal(err)
	}
	pin := first.Fingerprint()
	_ = first.Close()

	n := 0
	try := func(c Candidate) Found {
		t.Helper()
		n++
		id := "test-" + strconv.Itoa(n)
		c.ID = id
		p, _ := NewPoller(nil, fastDial, DialROS)
		p.Configure(configOf(t, Config{Discover: []Discovery{{ID: id, Seeds: []string{"127.0.0.1"}, Credentials: []Candidate{c}}}}))
		p.Round(ctx, start)
		p.WaitDiscoveries()
		rep, _ := p.Round(ctx, start.Add(time.Minute))
		if rep == nil || len(rep.Discovery) != 1 || !rep.Discovery[0].Done || len(rep.Discovery[0].Found) != 1 {
			t.Fatalf("%s: report %+v", id, rep)
		}
		f := rep.Discovery[0].Found[0]
		if f.Address != "127.0.0.1" {
			t.Fatalf("%s: found %+v", id, f)
		}
		return f
	}
	answered := func(what string, f Found, name string) {
		t.Helper()
		if !f.Answered || f.Error != "" || f.Name != name || f.Model == "" {
			t.Errorf("%s: want an answer from %s with its model, got %+v", what, name, f)
		}
	}
	failed := func(what string, f Found, sentence string) {
		t.Helper()
		if f.Answered || !strings.Contains(f.Error, sentence) {
			t.Errorf("%s: want %q, got %+v", what, sentence, f)
		}
	}

	// 1. Answered: the device's name and model.
	answered("snmp", try(Candidate{Protocol: "snmp", SNMP: &SNMPCred{Version: "2c", Community: "public", Port: snmpPort}}), devs[0].Name)
	answered("routeros", try(Candidate{Protocol: "routeros", RouterOS: &ROSCred{User: "watchlog", Password: "read-only-sample", Port: restPort}}), "edge-1")
	answered("routeros, pinned", try(Candidate{Protocol: "routeros", RouterOS: &ROSCred{User: "watchlog", Password: "read-only-sample", Port: restPort, Pin: pin}}), "edge-1")
	rc := *rec.Dahua
	answered("dahua", try(Candidate{Protocol: "dahua", Dahua: &rc}), "nvr-1")

	// 2. Wrong user or key.
	failed("routeros, wrong password", try(Candidate{Protocol: "routeros", RouterOS: &ROSCred{User: "watchlog", Password: "not-it", Port: restPort}}), "refused the RouterOS user")
	wrong := rc
	wrong.Password = "not-it"
	failed("dahua, wrong password", try(Candidate{Protocol: "dahua", Dahua: &wrong}), "the recorder refused the user")

	// 3. No answer. (SNMP v2c with a wrong community is silence too: the device says nothing.)
	failed("snmp, nothing there", try(Candidate{Protocol: "snmp", SNMP: &SNMPCred{Version: "2c", Community: "public", Port: 9}}), "didn't answer SNMP")
	failed("snmp, wrong community", try(Candidate{Protocol: "snmp", SNMP: &SNMPCred{Version: "2c", Community: "not-it", Port: snmpPort}}), "didn't answer SNMP")
	if f := try(Candidate{Protocol: "routeros", RouterOS: &ROSCred{User: "watchlog", Password: "read-only-sample", Port: gonePort}}); f.Answered || !strings.Contains(f.Error, "refused") && !strings.Contains(f.Error, "timeout") && !strings.Contains(f.Error, "deadline") {
		t.Errorf("routeros, nothing there: %+v", f)
	}

	// 4. The certificate isn't the pinned one.
	failed("routeros, another certificate", try(Candidate{Protocol: "routeros", RouterOS: &ROSCred{User: "watchlog", Password: "read-only-sample", Port: restPort, Pin: strings.Repeat("ab", 32)}}), "certificate changed since it was first seen")

	// A collector before 1.0.2 had no recorder case: the sentence the backend reads then.
	failed("a credential the probe can't use", try(Candidate{Protocol: "snmp"}), "no SNMP credential")
}
