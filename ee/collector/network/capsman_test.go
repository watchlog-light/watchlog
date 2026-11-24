// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"context"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/ee/collector/netsim"
)

// Both CAPsMAN generations from the fake router (field names from MikroTik's manual), the
// backhaul between two APs, a disconnected AP, and the counts as series (never a client).
func TestCAPsMAN(t *testing.T) {
	start := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	now := start.Add(10 * 24 * time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ps, _ := LoadProfiles()
	for _, legacy := range []bool{false, true} {
		fake := netsim.Edge(start)
		fake.Clock = func() time.Time { return now }
		fake.EnableCAPsMAN(legacy)
		addr, err := fake.ServeREST(ctx, "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		dev := rosDevice(t, addr, ROSCred{})
		rep, samples := pollROS(ctx, DialROS, ps["mikrotik"], dev, newROSState(), now, false)
		w := rep.Wireless
		if rep.State != StateOK || w == nil {
			t.Fatalf("legacy=%v: %s %+v", legacy, rep.State, w)
		}
		gen := map[bool]string{false: "wifi", true: "legacy"}[legacy]
		if len(w.Generations) != 1 || w.Generations[0] != gen || len(w.APs) != 3 {
			t.Fatalf("%s: generations %v, %d APs", gen, w.Generations, len(w.APs))
		}
		lobby := w.APs[0]
		if lobby.Name != "ap-lobby" || lobby.State != "running" || lobby.Model == "" || lobby.MAC != "48:a9:8a:10:00:01" || len(lobby.Radios) == 0 {
			t.Fatalf("%s: lobby %+v", gen, lobby)
		}
		if lobby.Radios[0].Channel != 1 || lobby.Radios[0].FrequencyM != 2412 || lobby.Radios[0].TxPowerDBm == nil {
			t.Fatalf("%s: radio %+v", gen, lobby.Radios[0])
		}
		if len(w.Clients) < 10 || w.Clients[0].AP == "" || w.Clients[0].SignalDBm == nil {
			t.Fatalf("%s: %d clients, first %+v", gen, len(w.Clients), w.Clients[0])
		}
		if !legacy {
			if len(w.Mesh) != 1 || w.Mesh[0].From != "ap-office" || w.Mesh[0].To != "ap-warehouse" || *w.Mesh[0].SignalDBm != -58 {
				t.Fatalf("mesh %+v", w.Mesh)
			}
		}
		var up, counts int
		for _, s := range samples {
			for _, l := range s.Labels {
				if l.Name == "mac" || l.Name == "client" {
					t.Fatalf("a client as a label: %+v", s)
				}
			}
			switch s.Name {
			case "watchlog_net_ap_up":
				up++
			case "watchlog_net_wifi_clients":
				counts += int(s.Value)
			}
		}
		// The backhaul isn't a client of the office SSIDs' counts... but it is a station; the
		// counts are what the registration table lists.
		if up != 3 || counts < len(w.Clients)-1 {
			t.Fatalf("%s: ap_up %d, client counts %d of %d", gen, up, counts, len(w.Clients))
		}
		// An AP that drops off CAPsMAN isn't listed (the backend marks it disconnected).
		fake.SetAP("ap-lobby", false)
		rep, _ = pollROS(ctx, DialROS, ps["mikrotik"], dev, newROSState(), now.Add(time.Minute), false)
		if len(rep.Wireless.APs) != 2 {
			t.Fatalf("%s: after a disconnect %d APs", gen, len(rep.Wireless.APs))
		}
	}
	// No CAPsMAN on the router: no wireless section.
	fake := netsim.Edge(start)
	fake.Clock = func() time.Time { return now }
	fake.DisableCAPsMAN()
	addr, _ := fake.ServeREST(ctx, "127.0.0.1:0")
	rep, _ := pollROS(ctx, DialROS, ps["mikrotik"], rosDevice(t, addr, ROSCred{}), newROSState(), now, false)
	if rep.Wireless != nil {
		t.Fatalf("no CAPsMAN: %+v", rep.Wireless)
	}
}

func TestChannelOf(t *testing.T) {
	for in, want := range map[string]int{"2412/20-Ce/gn(20dBm)": 1, "2437/ax": 6, "5180/ax/Ceee": 36, "5955": 1} {
		f, _ := channelOf(in)
		if got := channelNumber(f); got != want {
			t.Errorf("%s → %d, want %d", in, got, want)
		}
	}
	_, p := channelOf("2412/20-Ce/gn(20dBm)")
	if p == nil || *p != 20 {
		t.Fatal("tx power from the channel string")
	}
}
