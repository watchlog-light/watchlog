// SPDX-License-Identifier: AGPL-3.0-only

package jobs

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type sink struct{ got []string }

func (s *sink) Add(kind, name, reason, typ, message string) {
	s.got = append(s.got, kind+" "+name+" "+reason+" "+message)
}

var t0 = time.Date(2026, 11, 19, 0, 0, 0, 0, time.UTC)

func at(h, m int) time.Time { return t0.Add(time.Duration(h)*time.Hour + time.Duration(m)*time.Minute) }

func code(n int) *int { return &n }

func timerObs(next time.Time, runs ...Run) Observation {
	o := Observation{Kind: "timer", Name: "backup.timer", Unit: "backup.service", Enabled: true, Schedule: "*-*-* *:00:00", Runs: runs}
	if !next.IsZero() {
		o.Next = next.Unix()
	}
	return o
}

func ok(start time.Time, sec int) Run {
	return Run{Start: start.Unix(), End: start.Unix() + int64(sec), Code: code(0), Result: "success"}
}

func bad(start time.Time, c int) Run {
	return Run{Start: start.Unix(), End: start.Unix() + 4, Code: code(c), Result: "failed"}
}

func one(t *testing.T, tr *Tracker) Job {
	t.Helper()
	js := tr.Jobs()
	if len(js) != 1 {
		t.Fatalf("one job expected: %+v", js)
	}
	return js[0]
}

func TestFailingStreakAndRecovery(t *testing.T) {
	ev := &sink{}
	tr := &Tracker{Events: ev}
	for h := 0; h < 6; h++ {
		tr.Update("timer", []Observation{timerObs(at(h+1, 0), ok(at(h, 0), 60))}, at(h, 2))
	}
	j := one(t, tr)
	if j.State != Working || j.UsualSeconds != 60 || j.FailedStreak != 0 {
		t.Fatalf("working: %+v", j)
	}
	tr.Update("timer", []Observation{timerObs(at(7, 0), bad(at(6, 0), 2))}, at(6, 1))
	j = one(t, tr)
	if j.State != Failed || j.FailedStreak != 1 || j.LastGood != at(5, 0).Unix() {
		t.Fatalf("failed once: %+v", j)
	}
	tr.Update("timer", []Observation{timerObs(at(8, 0), bad(at(7, 0), 2))}, at(7, 1))
	tr.Update("timer", []Observation{timerObs(at(9, 0), bad(at(8, 0), 2))}, at(8, 1))
	if j = one(t, tr); j.FailedStreak != 3 {
		t.Fatalf("three in a row: %+v", j)
	}
	tr.Update("timer", []Observation{timerObs(at(10, 0), ok(at(9, 0), 60))}, at(9, 2))
	if j = one(t, tr); j.State != Working || j.FailedStreak != 0 {
		t.Fatalf("recovered: %+v", j)
	}
	want := []string{
		"Job backup.timer JobFailed failed with exit code 2",
		"Job backup.timer JobFailed failed with exit code 2, 3 times in a row",
		"Job backup.timer JobRecovered ran successfully again",
	}
	if strings.Join(ev.got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("events:\n%s", strings.Join(ev.got, "\n"))
	}
}

func TestMissedWhenTheServerWasUpNotWhenItWasOff(t *testing.T) {
	tr := &Tracker{Boot: at(0, 0)}
	last := ok(at(9, 0), 10)
	tr.Update("timer", []Observation{timerObs(at(10, 0), last)}, at(9, 30))
	// 10:00 came and went: systemd now expects 11:00, and nothing ran.
	tr.Update("timer", []Observation{timerObs(at(11, 0), last)}, at(10, 1))
	if j := one(t, tr); j.State != Working {
		t.Fatalf("within the grace: %+v", j)
	}
	tr.Update("timer", []Observation{timerObs(at(11, 0), last)}, at(10, 4))
	j := one(t, tr)
	if j.State != Missed || j.MissedRuns != 1 || j.MissedWhy != MissedNotRun || j.MissedAt != at(10, 0).Unix() {
		t.Fatalf("missed: %+v", j)
	}
	// The next good run resolves it.
	tr.Update("timer", []Observation{timerObs(at(12, 0), ok(at(11, 0), 10))}, at(11, 1))
	if j = one(t, tr); j.State != Working || j.MissedRuns != 0 {
		t.Fatalf("resolved: %+v", j)
	}

	// The server was off at 14:00 (it booted at 14:30): not missed.
	off := &Tracker{Boot: at(14, 30)}
	off.Update("timer", []Observation{timerObs(at(14, 0), last)}, at(13, 50))
	off.Update("timer", []Observation{timerObs(at(15, 0), last)}, at(14, 31))
	j = one(t, off)
	if j.State == Missed || j.MissedRuns != 0 || j.MissedWhy != MissedServerOff {
		t.Fatalf("server off: %+v", j)
	}
}

func TestARandomDelayOrACatchUpIsNotLate(t *testing.T) {
	tr := &Tracker{}
	last := ok(at(0, 0), 5)
	// systemd's next elapse already includes the random delay: 01:07:47.
	next := at(1, 7).Add(47 * time.Second)
	tr.Update("timer", []Observation{timerObs(next, last)}, at(0, 30))
	tr.Update("timer", []Observation{timerObs(at(2, 3), ok(next, 5))}, next.Add(10*time.Second))
	if j := one(t, tr); j.State != Working || j.MissedRuns != 0 {
		t.Fatalf("a run at its delayed time: %+v", j)
	}
	// A persistent timer's catch-up after a reboot: systemd triggers it (LastTrigger) though
	// its unit's run happened between two reads of ours.
	o := timerObs(at(4, 0))
	o.Triggered = at(3, 1).Unix()
	tr.Update("timer", []Observation{timerObs(at(3, 0), ok(next, 5))}, at(2, 50))
	tr.Update("timer", []Observation{o}, at(3, 10))
	if j := one(t, tr); j.MissedRuns != 0 {
		t.Fatalf("a catch-up run: %+v", j)
	}
}

func TestSlowRunningAndFrequent(t *testing.T) {
	tr := &Tracker{}
	var runs []Run
	for i := 0; i < 5; i++ {
		runs = append(runs, ok(at(i, 15), 60))
	}
	tr.Update("cron", []Observation{{Kind: "cron", Name: "export.php", Enabled: true, Runs: runs, Every: 3600}}, at(5, 0))
	running := Run{Start: at(5, 15).Unix(), Result: "running"}
	tr.Update("cron", []Observation{{Kind: "cron", Name: "export.php", Enabled: true, Runs: []Run{running}, Every: 3600}}, at(5, 18))
	if j := one(t, tr); j.State != Running {
		t.Fatalf("3 minutes in: running, not slow yet: %+v", j)
	}
	tr.Update("cron", []Observation{{Kind: "cron", Name: "export.php", Enabled: true, Runs: []Run{running}, Every: 3600}}, at(5, 22))
	j := one(t, tr)
	if j.State != Slow || j.UsualSeconds != 60 {
		t.Fatalf("7 minutes against a usual minute: slow: %+v", j)
	}
	samples, _ := tr.Collect()
	if len(samples) != 3 || samples[2].Name != "watchlog_job_slow" || samples[2].Value != 1 {
		t.Fatalf("series: %+v", samples)
	}
	every := &Tracker{}
	every.Update("cron", []Observation{{Kind: "cron", Name: "queue", Enabled: true, Every: 60}}, at(1, 0))
	if j := one(t, every); !j.Frequent || j.State != New {
		t.Fatalf("a job every minute is frequent: %+v", j)
	}
}

func TestADisabledTimer(t *testing.T) {
	tr := &Tracker{}
	tr.Update("timer", []Observation{{Kind: "timer", Name: "unused.timer", Enabled: false}}, at(1, 0))
	if j := one(t, tr); j.State != Disabled {
		t.Fatalf("never ran, disabled: %+v", j)
	}
	// A timer that was expected at 03:00 and then got disabled: missed, the timer is off.
	lr := &Tracker{}
	last := ok(at(2, 0), 5)
	lr.Update("timer", []Observation{timerObs(at(3, 0), last)}, at(2, 30))
	o := timerObs(time.Time{}, last)
	o.Enabled = false
	lr.Update("timer", []Observation{o}, at(3, 5))
	if j := one(t, lr); j.State != Missed || j.MissedWhy != MissedTimerOff {
		t.Fatalf("disabled after being due: %+v", j)
	}
}

func TestStateSurvivesARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.json")
	tr := &Tracker{Path: path}
	tr.Update("timer", []Observation{timerObs(at(2, 0), bad(at(1, 0), 1))}, at(1, 1))
	again := &Tracker{Path: path}
	again.Load()
	if j := one(t, again); j.FailedStreak != 1 || len(j.Runs) != 1 {
		t.Fatalf("after a restart: %+v", j)
	}
	// A job that's gone from systemd goes from the list.
	again.Update("timer", nil, at(2, 0))
	if len(again.Jobs()) != 0 {
		t.Fatal("gone")
	}
}

func TestRunsFromSystemd(t *testing.T) {
	src := fakeTimers{
		{Name: "a.timer", Unit: "a.service", Calendar: []string{"*-*-* 03:00:00"}, NextUsec: uint64(at(3, 0).UnixMicro()), LastUsec: uint64(at(2, 0).UnixMicro()), Enabled: true,
			Run: RunInfo{StartUsec: uint64(at(2, 0).UnixMicro()), ExitUsec: uint64(at(2, 1).UnixMicro()), Code: 1, Status: 2, Result: "exit-code", Active: "failed"}},
		{Name: "b.timer", Unit: "b.service", Enabled: true,
			Run: RunInfo{StartUsec: uint64(at(2, 0).UnixMicro()), Active: "activating"}},
		{Name: "c.timer", Unit: "c.service", Enabled: true, Monotonic: true},
	}
	obs, err := Timers(src)
	if err != nil || len(obs) != 3 {
		t.Fatal(err, obs)
	}
	if r := obs[0].Runs[0]; r.Result != "failed" || r.Code == nil || *r.Code != 2 || r.End-r.Start != 60 || obs[0].Every != 3600 {
		t.Fatalf("a failed run: %+v every=%d", r, obs[0].Every)
	}
	if r := obs[1].Runs[0]; r.Result != "running" {
		t.Fatalf("running: %+v", r)
	}
	if obs[2].Schedule != "after boot or its last run" || len(obs[2].Runs) != 0 {
		t.Fatalf("monotonic: %+v", obs[2])
	}
}

type fakeTimers []TimerInfo

func (f fakeTimers) Timers() ([]TimerInfo, error) { return f, nil }
