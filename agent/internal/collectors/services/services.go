// SPDX-License-Identifier: AGPL-3.0-only

// Package services collects systemd services on a server (ADR-208): each unit's state,
// restarts, last exit, start time and limits from systemd's D-Bus API, and its CPU, memory,
// I/O, tasks and OOM kills from its cgroup. Units of type service only, loaded and not
// finished (one-shots that ran and exited are left out), at most Limit of them.
package services

import (
	"errors"
	"math"
	"sort"
	"strings"

	"github.com/watchlog-light/watchlog/agent/internal/collectors/containers"
	"github.com/watchlog-light/watchlog/agent/internal/collectors/exits"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Limit is the most services one server reports (ADR-208); the rest are counted.
const Limit = 100

// UnitStatus is one row of systemd's ListUnits.
type UnitStatus struct {
	Name        string
	LoadState   string
	ActiveState string
	SubState    string
	Path        string // the unit's D-Bus object path
}

// Props are the properties read for a service unit. Unset limits are nil.
type Props struct {
	NRestarts       uint32
	ExecMainCode    int32 // CLD_EXITED (1), CLD_KILLED (2), CLD_DUMPED (3); 0 when none
	ExecMainStatus  int32 // the exit status, or the signal for KILLED and DUMPED
	ControlGroup    string
	MainPID         uint32
	ActiveEnterUsec uint64
	MemoryMax       *float64
	CPUQuotaCores   *float64
}

// Bus is what the collector needs from systemd (the D-Bus client, or a fake in tests).
type Bus interface {
	Units() ([]UnitStatus, error)
	Props(u UnitStatus) (Props, error)
}

// CgroupReader reads a unit's cgroup (containers.Reader.Unit).
type CgroupReader interface {
	Unit(controlGroup string) (containers.UnitStats, error)
}

// Collector turns systemd's view into series.
type Collector struct {
	Bus     Bus
	Cgroups CgroupReader
	Limit   int
	// Dropped is how many services were left out by the limit at the last scrape.
	Dropped int
	// Exits, when set, returns the process exits eBPF saw since the last call (ADR-210):
	// a unit's main process exits are counted, and its last non-zero exit kept, because
	// systemd's own ExecMainStatus reads 0 again once it restarted the unit (measured).
	Exits func() []exits.Exit

	mainPID map[string]uint32
	ex      map[string]*unitExits
}

type unitExits struct {
	byKind   map[string]float64
	oomKills float64
	last     *int
}

// Wanted reports whether a unit is a service the server is running or failing: loaded,
// and running, starting, stopping, reloading or failed. A one-shot that ran and exited
// ("active exited") is configuration, not a workload.
func Wanted(u UnitStatus) bool {
	if !strings.HasSuffix(u.Name, ".service") || u.LoadState != "loaded" {
		return false
	}
	switch u.ActiveState {
	case "failed", "activating", "deactivating", "reloading":
		return true
	case "active":
		return u.SubState != "exited"
	}
	return false
}

type row struct {
	u UnitStatus
	p Props
	s containers.UnitStats
	// hasStats is false when the cgroup couldn't be read (cgroup v1, a stopped unit).
	hasStats bool
}

// Collect lists the services and returns their series.
func (c *Collector) Collect() ([]metrics.Sample, error) {
	units, err := c.Bus.Units()
	if err != nil {
		return nil, err
	}
	var rows []row
	var errs []error
	for _, u := range units {
		if !Wanted(u) {
			continue
		}
		p, err := c.Bus.Props(u)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		r := row{u: u, p: p}
		if c.Cgroups != nil && p.ControlGroup != "" {
			if s, err := c.Cgroups.Unit(p.ControlGroup); err == nil {
				r.s, r.hasStats = s, true
			}
		}
		rows = append(rows, r)
	}
	c.countExits(rows)
	limit := c.Limit
	if limit <= 0 {
		limit = Limit
	}
	// The busiest first, failed ones always in: CPU seconds, then memory, then the name.
	sort.SliceStable(rows, func(i, j int) bool {
		fi, fj := rows[i].u.ActiveState == "failed", rows[j].u.ActiveState == "failed"
		if fi != fj {
			return fi
		}
		if rows[i].s.CPUSeconds != rows[j].s.CPUSeconds {
			return rows[i].s.CPUSeconds > rows[j].s.CPUSeconds
		}
		if rows[i].s.MemoryWorkingSet != rows[j].s.MemoryWorkingSet {
			return rows[i].s.MemoryWorkingSet > rows[j].s.MemoryWorkingSet
		}
		return rows[i].u.Name < rows[j].u.Name
	})
	c.Dropped = 0
	if len(rows) > limit {
		c.Dropped = len(rows) - limit
		rows = rows[:limit]
	}
	var out []metrics.Sample
	for _, r := range rows {
		out = append(out, samples(r, c.ex[r.u.Name])...)
	}
	return out, errors.Join(errs...)
}

// countExits attributes eBPF's exits to the units whose main process they were: the
// MainPID systemd reported at the previous scrape (the process that just ended).
func (c *Collector) countExits(rows []row) {
	if c.mainPID == nil {
		c.mainPID, c.ex = map[string]uint32{}, map[string]*unitExits{}
	}
	if c.Exits != nil {
		byPID := map[int]string{}
		for unit, pid := range c.mainPID {
			if pid != 0 {
				byPID[int(pid)] = unit
			}
		}
		for _, e := range c.Exits() {
			unit, ok := byPID[e.PID]
			if !ok {
				continue
			}
			u := c.ex[unit]
			if u == nil {
				u = &unitExits{byKind: map[string]float64{}}
				c.ex[unit] = u
			}
			u.byKind[e.Kind()]++
			if e.OOM {
				u.oomKills++
			}
			if code := e.Code(); code != 0 {
				u.last = &code
			}
		}
	}
	for _, r := range rows {
		c.mainPID[r.u.Name] = r.p.MainPID
	}
}

func samples(r row, ex *unitExits) []metrics.Sample {
	unit := r.u.Name
	out := []metrics.Sample{
		metrics.New("watchlog_service_state", 1, "unit", unit, "state", r.u.ActiveState, "sub", r.u.SubState),
		metrics.New("watchlog_service_restarts_total", float64(r.p.NRestarts), "unit", unit),
	}
	switch {
	case ex != nil && ex.last != nil:
		out = append(out, metrics.New("watchlog_service_last_exit_code", float64(*ex.last), "unit", unit))
	case r.p.ExecMainCode != 0:
		out = append(out, metrics.New("watchlog_service_last_exit_code", float64(exitCode(r.p)), "unit", unit))
	}
	if ex != nil {
		for _, kind := range []string{"ok", "error", "signal"} {
			out = append(out, metrics.New("watchlog_service_exits_total", ex.byKind[kind], "unit", unit, "exit", kind))
		}
		out = append(out, metrics.New("watchlog_service_oom_kills_total", ex.oomKills, "unit", unit))
	}
	if r.p.ActiveEnterUsec > 0 {
		out = append(out, metrics.New("watchlog_service_start_time_seconds", float64(r.p.ActiveEnterUsec)/1e6, "unit", unit))
	}
	if r.p.MemoryMax != nil {
		out = append(out, metrics.New("watchlog_service_memory_limit_bytes", *r.p.MemoryMax, "unit", unit))
	}
	if r.p.CPUQuotaCores != nil {
		out = append(out, metrics.New("watchlog_service_cpu_limit_cores", *r.p.CPUQuotaCores, "unit", unit))
	}
	if !r.hasStats {
		return out
	}
	s := r.s
	out = append(out,
		metrics.New("watchlog_service_cpu_seconds_total", s.CPUSeconds, "unit", unit),
		metrics.New("watchlog_service_cpu_throttled_seconds_total", s.CPUThrottledSeconds, "unit", unit),
		metrics.New("watchlog_service_memory_working_set_bytes", s.MemoryWorkingSet, "unit", unit),
		metrics.New("watchlog_service_io_bytes_total", s.IOReadBytes, "unit", unit, "dir", "read"),
		metrics.New("watchlog_service_io_bytes_total", s.IOWriteBytes, "unit", unit, "dir", "write"),
	)
	if s.Tasks >= 0 {
		out = append(out, metrics.New("watchlog_service_tasks", s.Tasks, "unit", unit))
	}
	if s.OOMKills >= 0 {
		out = append(out, metrics.New("watchlog_service_oom_events_total", s.OOMKills, "unit", unit))
	}
	return out
}

// exitCode is the shell's view of the last exit: the status for a normal exit, 128 plus
// the signal for one killed by a signal (so SIGKILL is 137, as for containers).
func exitCode(p Props) int32 {
	if p.ExecMainCode == 1 {
		return p.ExecMainStatus
	}
	return 128 + p.ExecMainStatus
}

// usecToCores turns systemd's CPUQuotaPerSecUSec into cores; nil when unlimited.
func usecToCores(v uint64) *float64 {
	if v == 0 || v == math.MaxUint64 {
		return nil
	}
	c := float64(v) / 1e6
	return &c
}

// bytesLimit turns MemoryMax into bytes; nil when unlimited.
func bytesLimit(v uint64) *float64 {
	if v == 0 || v == math.MaxUint64 {
		return nil
	}
	b := float64(v)
	return &b
}
