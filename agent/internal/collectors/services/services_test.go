// SPDX-License-Identifier: AGPL-3.0-only

package services

import (
	"errors"
	"math"
	"sort"
	"strings"
	"testing"

	"github.com/watchlog-light/watchlog/agent/internal/collectors/containers"
	"github.com/watchlog-light/watchlog/agent/internal/collectors/exits"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

type fakeBus struct {
	units []UnitStatus
	props map[string]Props
}

func (f fakeBus) Units() ([]UnitStatus, error) { return f.units, nil }
func (f fakeBus) Props(u UnitStatus) (Props, error) {
	p, ok := f.props[u.Name]
	if !ok {
		return Props{}, errors.New("no such unit " + u.Name)
	}
	return p, nil
}

type fakeCgroups map[string]containers.UnitStats

func (f fakeCgroups) Unit(cg string) (containers.UnitStats, error) {
	s, ok := f[cg]
	if !ok {
		return containers.UnitStats{}, containers.ErrNotFound
	}
	return s, nil
}

func ptr(v float64) *float64 { return &v }

// As measured on Ubuntu 24.04 and Debian 12 (0.9 slice 1, phases/v0.9-measure).
func measured() (fakeBus, fakeCgroups) {
	units := []UnitStatus{
		{Name: "nginx.service", LoadState: "loaded", ActiveState: "active", SubState: "running", Path: "/n"},
		{Name: "orders.service", LoadState: "loaded", ActiveState: "active", SubState: "running", Path: "/o"},
		{Name: "postgresql@16-main.service", LoadState: "loaded", ActiveState: "active", SubState: "running", Path: "/p"},
		{Name: "billing.service", LoadState: "loaded", ActiveState: "failed", SubState: "failed", Path: "/b"},
		// Left out: a one-shot that ran, the oneshot's target, an unloaded unit, a socket.
		{Name: "cloud-init.service", LoadState: "loaded", ActiveState: "active", SubState: "exited", Path: "/c"},
		{Name: "multi-user.target", LoadState: "loaded", ActiveState: "active", SubState: "active", Path: "/t"},
		{Name: "gone.service", LoadState: "not-found", ActiveState: "inactive", SubState: "dead", Path: "/g"},
		{Name: "docker.socket", LoadState: "loaded", ActiveState: "active", SubState: "running", Path: "/s"},
	}
	props := map[string]Props{
		"nginx.service": {ControlGroup: "/system.slice/nginx.service", ActiveEnterUsec: 1_794_900_000_000_000},
		"orders.service": {
			NRestarts: 2, ExecMainCode: 1, ExecMainStatus: 3, ControlGroup: "/system.slice/orders.service",
			MemoryMax: ptr(209715200),
		},
		"postgresql@16-main.service": {ControlGroup: "/system.slice/system-postgresql.slice/postgresql@16-main.service", CPUQuotaCores: ptr(0.5)},
		"billing.service":            {ExecMainCode: 2, ExecMainStatus: 9},
	}
	cg := fakeCgroups{
		"/system.slice/nginx.service": {Stats: containers.Stats{CPUSeconds: 12, MemoryWorkingSet: 9 << 20}, Tasks: 5, OOMKills: 0},
		"/system.slice/orders.service": {
			Stats: containers.Stats{CPUSeconds: 40, MemoryWorkingSet: 120 << 20, IOReadBytes: 7, IOWriteBytes: 9},
			Tasks: 8, OOMKills: 1,
		},
		"/system.slice/system-postgresql.slice/postgresql@16-main.service": {Stats: containers.Stats{CPUSeconds: 3}, Tasks: 7, OOMKills: -1},
	}
	return fakeBus{units: units, props: props}, cg
}

func byName(ss []metrics.Sample) map[string][]metrics.Sample {
	out := map[string][]metrics.Sample{}
	for _, s := range ss {
		out[s.Name] = append(out[s.Name], s)
	}
	return out
}

func label(s metrics.Sample, name string) string {
	for _, l := range s.Labels {
		if l.Name == name {
			return l.Value
		}
	}
	return ""
}

func TestWanted(t *testing.T) {
	bus, _ := measured()
	var got []string
	for _, u := range bus.units {
		if Wanted(u) {
			got = append(got, u.Name)
		}
	}
	want := []string{"nginx.service", "orders.service", "postgresql@16-main.service", "billing.service"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("wanted %v, got %v", want, got)
	}
}

func TestCollect(t *testing.T) {
	bus, cg := measured()
	c := &Collector{Bus: bus, Cgroups: cg}
	ss, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	m := byName(ss)
	states := map[string]string{}
	for _, s := range m["watchlog_service_state"] {
		states[label(s, "unit")] = label(s, "state") + "/" + label(s, "sub")
	}
	if len(states) != 4 || states["billing.service"] != "failed/failed" || states["orders.service"] != "active/running" {
		t.Fatalf("states: %v", states)
	}
	value := func(name, unit string, extra ...string) float64 {
		for _, s := range m[name] {
			if label(s, "unit") != unit {
				continue
			}
			if len(extra) == 2 && label(s, extra[0]) != extra[1] {
				continue
			}
			return s.Value
		}
		return math.NaN()
	}
	checks := []struct {
		name, unit string
		extra      []string
		want       float64
	}{
		{"watchlog_service_restarts_total", "orders.service", nil, 2},
		{"watchlog_service_last_exit_code", "orders.service", nil, 3},
		// Killed by SIGKILL: 128 + 9, as a shell and Docker say it.
		{"watchlog_service_last_exit_code", "billing.service", nil, 137},
		{"watchlog_service_memory_limit_bytes", "orders.service", nil, 209715200},
		{"watchlog_service_cpu_limit_cores", "postgresql@16-main.service", nil, 0.5},
		{"watchlog_service_cpu_seconds_total", "orders.service", nil, 40},
		{"watchlog_service_memory_working_set_bytes", "orders.service", nil, 120 << 20},
		{"watchlog_service_io_bytes_total", "orders.service", []string{"dir", "write"}, 9},
		{"watchlog_service_tasks", "nginx.service", nil, 5},
		{"watchlog_service_oom_events_total", "orders.service", nil, 1},
		{"watchlog_service_start_time_seconds", "nginx.service", nil, 1_794_900_000},
	}
	for _, c := range checks {
		if got := value(c.name, c.unit, c.extra...); got != c.want {
			t.Errorf("%s{unit=%q}: got %v, want %v", c.name, c.unit, got, c.want)
		}
	}
	// No last exit before one happened; no OOM series where memory.events can't be read; a
	// failed unit with no cgroup sends its state and exit only.
	if !math.IsNaN(value("watchlog_service_last_exit_code", "nginx.service")) {
		t.Error("nginx has no exit yet")
	}
	if !math.IsNaN(value("watchlog_service_oom_events_total", "postgresql@16-main.service")) {
		t.Error("no OOM series without memory.events")
	}
	if !math.IsNaN(value("watchlog_service_cpu_seconds_total", "billing.service")) {
		t.Error("billing has no cgroup")
	}
	// Labels: the unit and what the series needs, never a PID or a path.
	for _, s := range ss {
		for _, l := range s.Labels {
			switch l.Name {
			case "unit", "state", "sub", "dir":
			default:
				t.Fatalf("%s carries label %q", s.Name, l.Name)
			}
		}
	}
}

func TestLimitKeepsFailedAndBusiest(t *testing.T) {
	bus, cg := measured()
	c := &Collector{Bus: bus, Cgroups: cg, Limit: 2}
	ss, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	var units []string
	for _, s := range byName(ss)["watchlog_service_state"] {
		units = append(units, label(s, "unit"))
	}
	sort.Strings(units)
	// The failed one always, then the busiest by CPU.
	if strings.Join(units, ",") != "billing.service,orders.service" || c.Dropped != 2 {
		t.Fatalf("kept %v, dropped %d", units, c.Dropped)
	}
}

func TestLimitsFromSystemd(t *testing.T) {
	if usecToCores(math.MaxUint64) != nil || usecToCores(0) != nil {
		t.Fatal("unlimited CPU quota is no limit")
	}
	if got := *usecToCores(500_000); got != 0.5 {
		t.Fatalf("500ms/s = %v cores", got)
	}
	if bytesLimit(math.MaxUint64) != nil {
		t.Fatal("infinity is no memory limit")
	}
}

// As measured: orders exits 3, systemd restarts it and reports ExecMainStatus 0 again; then
// the OOM killer ends it at MemoryMax and the restarted unit's memory.events reads 0.
func TestExitsFromEBPF(t *testing.T) {
	bus, cg := measured()
	o := bus.props["orders.service"]
	o.ExecMainCode, o.ExecMainStatus, o.MainPID = 0, 0, 100
	bus.props["orders.service"] = o
	var feed []exits.Exit
	c := &Collector{Bus: bus, Cgroups: cg, Exits: func() []exits.Exit { out := feed; feed = nil; return out }}
	if _, err := c.Collect(); err != nil {
		t.Fatal(err)
	}
	// Its main process 100 (systemd's child) exits 3; systemd restarts it as 101, which the
	// OOM killer ends before the next scrape (measured: both must count); a helper (pid 555,
	// the main process's child) in the same unit exits 1 and doesn't; neither does another
	// unit's.
	feed = []exits.Exit{
		{PID: 100, PPID: 1, Unit: "orders.service", Status: 3},
		{PID: 555, PPID: 101, Unit: "orders.service", Status: 1},
		{PID: 101, PPID: 1, Unit: "orders.service", Signal: 9, OOM: true},
		{PID: 700, PPID: 1, Unit: "cron.service", Status: 2},
	}
	o.MainPID, o.NRestarts = 101, 3
	bus.props["orders.service"] = o
	if _, err := c.Collect(); err != nil {
		t.Fatal(err)
	}
	o.MainPID = 102
	bus.props["orders.service"] = o
	ss, _ := c.Collect()
	got := map[string]float64{}
	for _, s := range ss {
		if label(s, "unit") != "orders.service" {
			continue
		}
		k := s.Name
		if e := label(s, "exit"); e != "" {
			k += ":" + e
		}
		got[k] = s.Value
	}
	want := map[string]float64{
		"watchlog_service_exits_total:error":  1,
		"watchlog_service_exits_total:signal": 1,
		"watchlog_service_oom_kills_total":    1,
		// The last non-zero exit, SIGKILL: 137, though systemd says 0.
		"watchlog_service_last_exit_code": 137,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
}

type evt struct{ kind, name, reason, typ, msg string }
type sink struct{ got []evt }

func (s *sink) Add(kind, name, reason, typ, msg string) {
	s.got = append(s.got, evt{kind, name, reason, typ, msg})
}

// A service's events (0.9.2), from one scrape to the next: started, failed (systemd's result
// and exit code), restarted (NRestarts), its unit file changed, OOM-killed at its MemoryMax,
// and stopped (no longer running: inactive). The first scrape only remembers.
func TestServiceEvents(t *testing.T) {
	mem := 200.0 * (1 << 20)
	bus := &fakeBus{
		units: []UnitStatus{
			{Name: "orders.service", LoadState: "loaded", ActiveState: "active", SubState: "running"},
			{Name: "cron.service", LoadState: "loaded", ActiveState: "active", SubState: "running"},
		},
		props: map[string]Props{"orders.service": {NRestarts: 1, MemoryMax: &mem}, "cron.service": {}},
	}
	s := &sink{}
	c := &Collector{Bus: bus, Events: s}
	if _, err := c.Collect(); err != nil {
		t.Fatal(err)
	}
	if len(s.got) != 0 {
		t.Fatalf("the first scrape told %+v", s.got)
	}
	// orders fails after a restart and a unit file change; cron stops; nginx starts.
	bus.units = []UnitStatus{
		{Name: "orders.service", LoadState: "loaded", ActiveState: "failed", SubState: "failed"},
		{Name: "nginx.service", LoadState: "loaded", ActiveState: "active", SubState: "running"},
	}
	bus.props["orders.service"] = Props{NRestarts: 3, ExecMainCode: 1, ExecMainStatus: 3, Result: "exit-code", NeedReload: true, MemoryMax: &mem}
	bus.props["nginx.service"] = Props{}
	if _, err := c.Collect(); err != nil {
		t.Fatal(err)
	}
	got := map[string]evt{}
	for _, e := range s.got {
		got[e.name+"/"+e.reason] = e
	}
	for k, want := range map[string]string{
		"orders.service/Failed":      "failed (exit-code, exit code 3)",
		"orders.service/Restarted":   "systemd restarted it 2 times (last exit code 3)",
		"orders.service/UnitChanged": "its unit file changed on disk (not yet reloaded by systemd)",
		"nginx.service/Started":      "started",
		"cron.service/Stopped":       "stopped",
	} {
		if got[k].msg != want || got[k].kind != "Service" {
			t.Errorf("%s: got %+v, want %q", k, got[k], want)
		}
	}
	if got["orders.service/Failed"].typ != "Warning" || got["nginx.service/Started"].typ != "Normal" {
		t.Errorf("types: %+v", s.got)
	}
	if oomText(Props{MemoryMax: &mem}) != "OOM-killed at its MemoryMax of 200 MiB" || oomText(Props{}) != "OOM-killed by the kernel: the server ran out of memory" {
		t.Errorf("OOM texts")
	}
}
