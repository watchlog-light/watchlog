// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"time"
)

// TestBudget50Switches polls 50 simulated 52-port switches (48 copper, 4 SFP+, 70% of the
// copper ports up, 30 MAC addresses each) for a replayed hour at full speed: 60 rounds,
// 12 with the inventory. The simulator runs in its own process, so the CPU and memory
// measured are the poller's. The collector's budget (ADR-131): ≤ 5% of a core and ≤ 128 MB
// RSS. Run with WATCHLOG_NET_BUDGET=1 (the release slice; about a minute).
func TestBudget50Switches(t *testing.T) {
	if os.Getenv("WATCHLOG_NET_BUDGET") == "" {
		t.Skip("WATCHLOG_NET_BUDGET=1 runs the budget")
	}
	bin := filepath.Join(t.TempDir(), "netsim")
	build := exec.Command("go", "build", "-o", bin, "../cmd/netsim")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sim := exec.CommandContext(ctx, bin, "-fleet", "50", "-control", "127.0.0.1:0")
	stdout, _ := sim.StdoutPipe()
	sim.Stderr = os.Stderr
	if err := sim.Start(); err != nil {
		t.Fatal(err)
	}
	sc := bufio.NewScanner(stdout)
	var control string
	var start int64
	var devs []Device
	for len(devs) < 50 && sc.Scan() {
		var l struct {
			Control string `json:"control"`
			Start   int64  `json:"start"`
			Name    string `json:"name"`
			Address string `json:"address"`
			Port    int    `json:"port"`
		}
		if err := json.Unmarshal(sc.Bytes(), &l); err != nil {
			t.Fatal(err)
		}
		if l.Control != "" {
			control, start = l.Control, l.Start
			continue
		}
		devs = append(devs, Device{ID: "dev-" + l.Name, Name: l.Name, Address: l.Address, Protocol: "snmp", SNMP: &SNMPCred{Version: "2c", Community: "public", Port: l.Port}})
	}
	p, err := NewPoller(nil, Dial, DialROS)
	if err != nil {
		t.Fatal(err)
	}
	cfg, _ := json.Marshal(Config{Devices: devs})
	p.Configure(cfg)

	setTime := func(t0 time.Time) {
		res, err := http.Post(fmt.Sprintf("http://%s/time?ms=%d", control, t0.UnixMilli()), "", nil)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
	}
	runtime.GC()
	var before syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &before)
	t0 := time.UnixMilli(start).Add(time.Hour)
	wall := time.Now()
	var maxSeries, reportBytes, maxHeap int
	var ms runtime.MemStats
	for round := 0; round < 60; round++ {
		now := t0.Add(time.Duration(round) * Round)
		setTime(now)
		rep, samples := p.Round(ctx, now)
		for _, d := range rep.Devices {
			if d.State != StateOK {
				t.Fatalf("round %d %s: %s %s", round, d.ID, d.State, d.Error)
			}
		}
		// What the collector does with them: the report as JSON, the series as remote write
		// (encoded here as JSON of the same size order; see the ADR for the encoder's cost).
		b, _ := json.Marshal(rep)
		s, _ := json.Marshal(samples)
		reportBytes = max(reportBytes, len(b))
		maxSeries = max(maxSeries, len(samples))
		_ = s
		runtime.ReadMemStats(&ms)
		maxHeap = max(maxHeap, int(ms.HeapInuse))
	}
	var after syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &after)
	cpu := tv(after.Utime) + tv(after.Stime) - tv(before.Utime) - tv(before.Stime)
	rss := after.Maxrss
	if runtime.GOOS == "linux" {
		rss *= 1024
	}
	share := cpu.Seconds() / 3600
	t.Logf("50 × 52-port switches, a replayed hour in %v: CPU %v (%.3f%% of a core over the hour), max RSS %.1f MB, max heap %.1f MB, %d series a round, largest report %.1f KB",
		time.Since(wall).Round(time.Millisecond), cpu.Round(time.Millisecond), share*100, float64(rss)/1e6, float64(maxHeap)/1e6, maxSeries, float64(reportBytes)/1e3)
	if share > 0.05 {
		t.Errorf("CPU %.2f%% of a core is over the collector's 5%%", share*100)
	}
	if rss > 128e6 {
		t.Errorf("RSS %.0f MB is over the collector's 128 MB", float64(rss)/1e6)
	}
	if maxSeries > 20_000 {
		t.Errorf("%d series is over the 20,000 cap", maxSeries)
	}
}

func tv(t syscall.Timeval) time.Duration {
	return time.Duration(t.Sec)*time.Second + time.Duration(t.Usec)*time.Microsecond
}
