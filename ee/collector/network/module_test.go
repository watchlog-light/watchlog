// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"net"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/ee/collector/netsim"
)

// No SET can be built: the Reader has no method that writes, the session never exposes its
// gosnmp connection, and no file of the package names gosnmp's Set or SetRequest.
func TestNoSNMPSet(t *testing.T) {
	rt := reflect.TypeOf((*Reader)(nil)).Elem()
	for i := 0; i < rt.NumMethod(); i++ {
		if n := rt.Method(i).Name; n != "Get" && n != "Walk" && n != "Close" {
			t.Fatalf("Reader has %s", n)
		}
	}
	st := reflect.TypeOf(session{})
	for i := 0; i < st.NumField(); i++ {
		if st.Field(i).IsExported() {
			t.Fatalf("session exposes %s", st.Field(i).Name)
		}
	}
	files, _ := os.ReadDir(".")
	fset := token.NewFileSet()
	for _, f := range files {
		if !strings.HasSuffix(f.Name(), ".go") || strings.HasSuffix(f.Name(), "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, f.Name(), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			if sel, ok := n.(*ast.SelectorExpr); ok {
				if id, ok := sel.X.(*ast.Ident); ok && id.Name == "gosnmp" && (sel.Sel.Name == "SetRequest" || sel.Sel.Name == "Set") {
					t.Errorf("%s names gosnmp.%s", fset.Position(sel.Pos()), sel.Sel.Name)
				}
				if sel.Sel.Name == "Set" {
					if x, ok := sel.X.(*ast.SelectorExpr); ok && x.Sel.Name == "g" {
						t.Errorf("%s calls the gosnmp session's Set", fset.Position(sel.Pos()))
					}
				}
			}
			return true
		})
	}
}

func configOf(t *testing.T, c Config) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestPollerRoundsBackoffAndInventory(t *testing.T) {
	start := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	now := start.Add(time.Hour)
	clock := func() time.Time { return now }
	devs, agents := lab(t, clock, netsim.Office(nil)[1:2], start)
	// A device nothing answers on.
	closed, _ := net.ListenPacket("udp", "127.0.0.1:0")
	_, port, _ := net.SplitHostPort(closed.LocalAddr().String())
	_ = closed.Close()
	pn, _ := strconv.Atoi(port)
	devs = append(devs, Device{ID: "dev-gone", Name: "gone", Address: "127.0.0.1", Protocol: "snmp", SNMP: &SNMPCred{Version: "2c", Community: "public", Port: pn}})
	p, err := NewPoller(nil, fastDial, DialROS)
	if err != nil {
		t.Fatal(err)
	}
	p.Configure(configOf(t, Config{Devices: devs}))
	ctx := context.Background()

	byID := func(r *Report, id string) *DeviceReport {
		for i := range r.Devices {
			if r.Devices[i].ID == id {
				return &r.Devices[i]
			}
		}
		return nil
	}
	var traffic []float64
	for round := 0; round < 12; round++ {
		rep, samples := p.Round(ctx, now)
		sw := byID(rep, "dev-sw-access-1")
		if sw == nil || sw.State != StateOK {
			t.Fatalf("round %d: %+v", round, sw)
		}
		// Inventory on the first round and every 5 minutes.
		if wantInv := round%5 == 0; (sw.Inventory != nil) != wantInv {
			t.Fatalf("round %d inventory %v", round, sw.Inventory != nil)
		}
		gone := byID(rep, "dev-gone")
		switch {
		case round < 3:
			if gone == nil || gone.State != StateUnreachable || gone.Failures != round+1 {
				t.Fatalf("round %d gone %+v", round, gone)
			}
		case round == 4 || round == 8:
			// After the third failure (round 2): the next try 2 minutes on, then 4.
			if gone == nil || gone.Failures != round/4+3 {
				t.Fatalf("round %d: not tried after the backoff: %+v", round, gone)
			}
		default:
			if gone != nil {
				t.Fatalf("round %d: tried during backoff", round)
			}
		}
		for _, s := range samples {
			if s.Name == "watchlog_net_if_in_bytes_total" && s.Labels[1].Value == "Te1/1/1" {
				traffic = append(traffic, s.Value)
			}
		}
		now = now.Add(Round)
	}
	if backoff(3) != 2*time.Minute || backoff(4) != 4*time.Minute || backoff(20) != time.Hour {
		t.Fatal("backoff doubles from 2 minutes to an hour")
	}
	// Counters only grow: 4 MB/s on the uplink.
	for i := 1; i < len(traffic); i++ {
		if d := traffic[i] - traffic[i-1]; d < 4_000_000*59 || d > 4_000_000*61 {
			t.Fatalf("uplink delta %v", d)
		}
	}
	// A reboot: counters start over on the device, the totals keep growing.
	agents["sw-access-1"].Reboot(now.Add(-30 * time.Second))
	_, samples := p.Round(ctx, now)
	for _, s := range samples {
		if s.Name == "watchlog_net_if_in_bytes_total" && s.Labels[1].Value == "Te1/1/1" && s.Value <= traffic[len(traffic)-1] {
			t.Fatalf("total went back after a reboot: %v → %v", traffic[len(traffic)-1], s.Value)
		}
	}
}

func TestDiscovery(t *testing.T) {
	old := probeEvery
	probeEvery = time.Millisecond
	defer func() { probeEvery = old }()
	start := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	clock := func() time.Time { return start.Add(time.Hour) }
	devs, _ := lab(t, clock, netsim.Office(nil), start)
	// The lab listens on 127.0.0.1 with one port per device, so discovery uses a dial that
	// maps the office's addresses to the lab's ports.
	ports := map[string]int{"10.0.0.2": devs[0].SNMP.Port, "10.0.0.11": devs[1].SNMP.Port, "10.0.0.12": devs[2].SNMP.Port}
	dial := func(address string, c *SNMPCred, v3, community string) (Reader, error) {
		port, ok := ports[address]
		if !ok {
			port = 9 // discard: nothing answers
		}
		cc := *c
		cc.Port = port
		return fastDial("127.0.0.1", &cc, v3, community)
	}
	p, _ := NewPoller(nil, dial, DialROS)
	cred := Candidate{ID: "cred-1", Protocol: "snmp", SNMP: &SNMPCred{Version: "2c", Community: "public"}}
	p.Configure(configOf(t, Config{Discover: []Discovery{{ID: "d1", Seeds: []string{"10.0.0.2"}, Neighbours: true, Credentials: []Candidate{cred}}}}))
	p.Round(context.Background(), start)
	p.WaitDiscoveries()
	rep, _ := p.Round(context.Background(), start.Add(time.Minute))
	if rep == nil || len(rep.Discovery) != 1 || !rep.Discovery[0].Done {
		t.Fatalf("discovery %+v", rep)
	}
	got := map[string]Found{}
	for _, f := range rep.Discovery[0].Found {
		got[f.Address] = f
	}
	if f := got["10.0.0.2"]; !f.Answered || f.Profile != "cisco-nxos" || f.Name != "core-1" {
		t.Fatalf("seed %+v", f)
	}
	for _, a := range []string{"10.0.0.11", "10.0.0.12"} {
		if f := got[a]; !f.Answered || f.ViaNeighbour != "core-1" || f.Profile != "cisco-ios" {
			t.Fatalf("%s %+v", a, f)
		}
	}
	// The router: proposed through CDP, no SNMP answer with this credential.
	if f := got["10.0.0.1"]; f.Answered || f.ViaNeighbour != "core-1" || f.Name != "edge-1" {
		t.Fatalf("router %+v", f)
	}
	if _, err := RangeAddrs("10.0.0.0/23"); err == nil {
		t.Fatal("a /23 is refused")
	}
	if a, _ := RangeAddrs("10.0.0.0/30"); len(a) != 2 || a[0] != "10.0.0.1" {
		t.Fatalf("/30 → %v", a)
	}
}
