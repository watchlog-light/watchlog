// SPDX-License-Identifier: AGPL-3.0-only

package jobs

import (
	"strings"
)

// TimerInfo is what systemd says of one timer and the unit it starts (ADR-223).
type TimerInfo struct {
	Name     string   // backup.timer
	Unit     string   // backup.service
	Calendar []string // OnCalendar specs as systemd normalised them
	// Monotonic is true for OnBootSec/OnUnitActiveSec timers (no calendar).
	Monotonic       bool
	Persistent      bool
	RandomDelayUsec uint64
	NextUsec        uint64 // NextElapseUSecRealtime: 0 when none (stopped or disabled)
	LastUsec        uint64 // LastTriggerUSec
	Enabled         bool   // UnitFileState enabled (or static) and the timer active
	Run             RunInfo
}

// RunInfo is the started unit's last (or current) run.
type RunInfo struct {
	StartUsec, ExitUsec uint64 // ExecMainStartTimestamp, ExecMainExitTimestamp
	Code                int32  // ExecMainCode: 1 exited, 2 killed, 3 dumped
	Status              int32  // ExecMainStatus: the exit status or the signal
	Result              string // success, exit-code, signal, timeout, oom-kill…
	Active              string // ActiveState: activating while a one-shot runs
}

// TimerSource lists the server's timers (the D-Bus client, or a fake in tests).
type TimerSource interface {
	Timers() ([]TimerInfo, error)
}

// Timers turns systemd's timers into observations.
func Timers(src TimerSource) ([]Observation, error) {
	list, err := src.Timers()
	if err != nil {
		return nil, err
	}
	out := make([]Observation, 0, len(list))
	for _, t := range list {
		o := Observation{
			Kind: "timer", Name: t.Name, Unit: t.Unit, Enabled: t.Enabled,
			Schedule: strings.Join(t.Calendar, "; "), Persistent: t.Persistent,
			RandomDelaySec: usec(t.RandomDelayUsec), Next: usec(t.NextUsec), Triggered: usec(t.LastUsec),
		}
		if t.Monotonic && o.Schedule == "" {
			o.Schedule = "after boot or its last run"
		}
		if o.Next > 0 && o.Triggered > 0 && o.Next > o.Triggered {
			o.Every = o.Next - o.Triggered
		}
		if r, ok := runOf(t.Run); ok {
			o.Runs = []Run{r}
		}
		out = append(out, o)
	}
	return out, nil
}

func usec(u uint64) int64 {
	if u == 0 || u >= 1<<62 { // unset, or systemd's "infinity"
		return 0
	}
	return int64(u / 1e6) //nolint:gosec // bounded above
}

// runOf is the unit's run: running while it hasn't exited since it started.
func runOf(r RunInfo) (Run, bool) {
	start := usec(r.StartUsec)
	if start == 0 {
		return Run{}, false
	}
	end := usec(r.ExitUsec)
	if end < start || (r.Active == "activating" && r.ExitUsec < r.StartUsec) {
		return Run{Start: start, Result: "running"}, true
	}
	run := Run{Start: start, End: end, Result: "failed"}
	if r.Code == 1 {
		code := int(r.Status)
		run.Code = &code
	}
	if r.Result == "success" {
		run.Result = "success"
	}
	return run, true
}
