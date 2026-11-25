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

func serveAgent(t *testing.T, a *netsim.Agent, clock func() time.Time) Device {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	srv := &netsim.Server{Community: "public", Clock: clock}
	addr, err := srv.Listen(ctx, "127.0.0.1:0", a)
	if err != nil {
		t.Fatal(err)
	}
	host, port, _ := net.SplitHostPort(addr)
	p, _ := strconv.Atoi(port)
	return Device{ID: "dev-" + a.Name, Name: a.Name, Address: host, Protocol: "snmp", SNMP: &SNMPCred{Version: "2c", Community: "public", Port: p}}
}

// The QNAP profile against the simulated NAS-MIB walk: picked by its probe (a Linux
// sysObjectID), disks with SMART and temperatures, the pool's RAID level, LUNs and targets.
func TestQNAP(t *testing.T) {
	start := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	now := start.Add(48 * time.Hour)
	q := netsim.QNAP("nas-1", start)
	dev := serveAgent(t, q, func() time.Time { return now })
	ps, _ := LoadProfiles()
	rep, samples := pollSNMP(context.Background(), Dial, ps, dev, newSNMPState(), now, true)
	if rep.State != StateOK || rep.Profile != "qnap" || rep.System.Model != "TS-464" || rep.System.Kind != "nas" {
		t.Fatalf("%s %s %+v", rep.State, rep.Profile, rep.System)
	}
	n := rep.NAS
	if n == nil || len(n.Disks) != 4 || n.Disks[0].SMART != "good" || n.Disks[0].Celsius == nil || *n.Disks[0].Celsius != 34 {
		t.Fatalf("disks %+v", n)
	}
	if len(n.Volumes) != 1 || n.Volumes[0].Name != "DataVol1" || n.Volumes[0].Status != "ready" || n.Volumes[0].Total <= n.Volumes[0].Free {
		t.Fatalf("volumes %+v", n.Volumes)
	}
	if len(n.Pools) != 1 || n.Pools[0].RAID != "RAID 5" || n.Pools[0].Status != "ready" {
		t.Fatalf("pools %+v", n.Pools)
	}
	if len(n.LUNs) != 2 || n.LUNs[0].Name != "nvr-1-rec" || *n.LUNs[0].UsedPercent != 71 || !n.LUNs[0].Mapped {
		t.Fatalf("luns %+v", n.LUNs)
	}
	if len(n.Targets) != 2 || !n.Targets[1].Connected {
		t.Fatalf("targets %+v", n.Targets)
	}
	if rep.Health.Temperature == nil || *rep.Health.Temperature != 48 || len(rep.Health.Fans) != 2 || len(rep.Health.PSUs) != 1 {
		t.Fatalf("health %+v", rep.Health)
	}
	names := map[string]bool{}
	for _, s := range samples {
		names[s.Name] = true
	}
	for _, n := range []string{"watchlog_net_volume_used_ratio", "watchlog_net_lun_used_ratio", "watchlog_net_disk_celsius"} {
		if !names[n] {
			t.Fatalf("no %s", n)
		}
	}
	// A target drops, a disk's SMART turns: read as such.
	q.SetTarget(2, false)
	q.SetDiskSMART(3, 2)
	rep, _ = pollSNMP(context.Background(), Dial, ps, dev, newSNMPState(), now, true)
	if rep.NAS.Targets[1].Connected || rep.NAS.Disks[2].SMART != "abnormal" {
		t.Fatalf("after: %+v %+v", rep.NAS.Targets, rep.NAS.Disks[2])
	}
}

func TestUPS(t *testing.T) {
	start := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	now := start.Add(time.Hour)
	ps, _ := LoadProfiles()
	for _, apc := range []bool{false, true} {
		a := netsim.UPS("ups-1", start, apc)
		dev := serveAgent(t, a, func() time.Time { return now })
		rep, samples := pollSNMP(context.Background(), Dial, ps, dev, newSNMPState(), now, false)
		want := map[bool]string{false: "ups-mib", true: "apc-ups"}[apc]
		u := rep.UPS
		if rep.State != StateOK || rep.Profile != want || u == nil || u.Status != "online" || *u.ChargePercent != 100 || u.RuntimeS == nil || u.LoadPercent == nil || u.InputVolts == nil || u.Celsius == nil {
			t.Fatalf("%s: %s %+v", want, rep.Profile, u)
		}
		if apc && *u.RuntimeS != 39600 {
			t.Fatalf("APC runtime %v s, want 39600 (TimeTicks)", *u.RuntimeS)
		}
		if !apc && *u.RuntimeS != 52*60 {
			t.Fatalf("UPS-MIB runtime %v s", *u.RuntimeS)
		}
		if len(samples) == 0 {
			t.Fatal("no series")
		}
		if !apc {
			a.SetOnBattery(true, 8)
			a.SetReplaceBattery()
			rep, _ = pollSNMP(context.Background(), Dial, ps, dev, newSNMPState(), now, false)
			if rep.UPS.Status != "on-battery" || *rep.UPS.RuntimeS != 480 || !rep.UPS.ReplaceBattery {
				t.Fatalf("on battery: %+v", rep.UPS)
			}
		}
	}
}
