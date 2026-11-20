// SPDX-License-Identifier: AGPL-3.0-only

package jobs

import (
	"fmt"
	"math/rand"
	"testing"
	"time"
)

// A generated healthy fleet for a day (ADR-225's target: under 1 alert a day per healthy
// server): 100 servers, each with stock-like systemd timers (random delays, persistent
// catch-ups) and cron lines, durations that vary ±40 %, a reboot on some servers (off 20
// minutes over a run), an agent restart on others, and the day the clocks go back in New York.
// Nothing fails, so nothing may become Failed, Missed or Slow. Fake clock, a minute a step.
func TestAHealthyFleetRaisesNoJobAlerts(t *testing.T) {
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("no tzdata:", err)
	}
	rng := rand.New(rand.NewSource(10)) //nolint:gosec // a reproducible test fleet
	start := time.Date(2026, 10, 31, 12, 0, 0, 0, ny)
	end := start.Add(24 * time.Hour)

	type timer struct {
		name    string
		every   time.Duration
		delay   time.Duration // RandomizedDelaySec
		usual   time.Duration
		next    time.Time
		last    *Run
		running *Run
	}
	type cronLine struct {
		usual time.Duration
	}
	alerts, brokenAlerts := 0, 0
	// Server 100 is broken (its sync.timer and its queue line fail): it must alert, so the
	// simulation can tell.
	for srv := 0; srv <= 100; srv++ {
		broken := srv == 100
		tr := &Tracker{Boot: start.Add(-48 * time.Hour), Since: start.Add(-48 * time.Hour)}
		timers := []*timer{
			{name: "apt-daily.timer", every: 12 * time.Hour, delay: 12 * time.Hour, usual: 40 * time.Second},
			{name: "logrotate.timer", every: 24 * time.Hour, delay: time.Hour, usual: 5 * time.Second},
			{name: "fstrim.timer", every: 24 * time.Hour, delay: 100 * time.Minute, usual: 20 * time.Second},
			{name: "backup.timer", every: time.Hour, delay: 5 * time.Minute, usual: 12 * time.Minute},
			{name: "sync.timer", every: 15 * time.Minute, usual: 30 * time.Second},
			{name: "certbot.timer", every: 12 * time.Hour, delay: 12 * time.Hour, usual: 8 * time.Second},
		}
		for _, tm := range timers {
			tm.next = start.Add(time.Duration(rng.Int63n(int64(tm.every)))).Add(time.Duration(rng.Int63n(int64(tm.delay) + 1)))
			ok := Run{Start: start.Add(-tm.every).Unix(), End: start.Add(-tm.every + tm.usual).Unix(), Code: code(0), Result: "success"}
			tm.last = &ok
		}
		c := &Cron{Loc: ny, Entries: entries(
			"*/5 * * * * /opt/queue.php",
			"30 2 * * * /usr/local/bin/report.sh",
			"0 * * * * /usr/bin/php /srv/app/artisan schedule:run",
			"15 1 * * * /opt/db-dump.sh",
		)}
		lines := map[string]cronLine{
			"/opt/queue.php":                             {usual: 20 * time.Second},
			"/usr/local/bin/report.sh":                   {usual: 3 * time.Minute},
			"/usr/bin/php /srv/app/artisan schedule:run": {usual: 2 * time.Second},
			"/opt/db-dump.sh":                            {usual: 25 * time.Minute},
		}
		var pid uint32 = 1000
		type proc struct {
			pid uint32
			end time.Time
		}
		var procs []proc
		// Server 7 reboots at 02:00 (off 20 min); server 13's agent restarts at 01:10.
		offFrom, offTo := time.Time{}, time.Time{}
		if srv%7 == 0 {
			offFrom = time.Date(2026, 11, 1, 2, 0, 0, 0, ny)
			offTo = offFrom.Add(20 * time.Minute)
		}
		agentStop, agentStart := time.Time{}, time.Time{}
		if srv%13 == 0 {
			agentStop = time.Date(2026, 11, 1, 1, 10, 0, 0, ny)
			agentStart = agentStop.Add(15 * time.Minute)
		}
		prev := map[string]string{}
		for now := start; now.Before(end); now = now.Add(time.Minute) {
			off := !offFrom.IsZero() && !now.Before(offFrom) && now.Before(offTo)
			if !offFrom.IsZero() && now.Equal(offTo) {
				tr.Boot = offTo // booted
				tr.Since = offTo
				procs = nil
			}
			stopped := !agentStop.IsZero() && !now.Before(agentStop) && now.Before(agentStart)
			if !agentStop.IsZero() && now.Equal(agentStart) {
				tr.Since = agentStart
			}
			if off {
				continue
			}
			// systemd runs the timers; a persistent timer catches up after the boot.
			for _, tm := range timers {
				if tm.running != nil && now.Unix() >= tm.running.End {
					tm.last, tm.running = tm.running, nil
				}
				if tm.running == nil && !now.Before(tm.next) {
					d := time.Duration(float64(tm.usual) * (0.6 + 0.8*rng.Float64()))
					r := Run{Start: now.Unix(), End: now.Add(d).Unix(), Code: code(0), Result: "success"}
					if broken && tm.name == "sync.timer" {
						r.Code, r.Result = code(1), "failed"
					}
					tm.running = &r
					tm.next = now.Add(tm.every).Add(time.Duration(rng.Int63n(int64(tm.delay) + 1)))
				}
			}
			// cron starts its lines at the minute (a second or two late).
			if !stopped {
				for _, p := range procs {
					if !now.Before(p.end) {
						status := 0
						if broken {
							status = 1
						}
						c.Exit(p.pid, status, 0, p.end)
					}
				}
			}
			keep := procs[:0]
			for _, p := range procs {
				if now.Before(p.end) {
					keep = append(keep, p)
				}
			}
			procs = keep
			for _, e := range c.Entries() {
				if e.Schedule.matches(now.Truncate(time.Minute)) {
					pid++
					at := now.Add(time.Duration(rng.Intn(2000)) * time.Millisecond)
					d := time.Duration(float64(lines[e.Command].usual) * (0.6 + 0.8*rng.Float64()))
					if !stopped {
						c.Exec(pid, []string{"/bin/sh", "-c", e.Command}, at)
					}
					procs = append(procs, proc{pid: pid, end: at.Add(d)})
				}
			}
			if stopped || now.Second() != 0 {
				continue
			}
			// The agent reads every 15 s; a minute is enough here.
			var obs []Observation
			for _, tm := range timers {
				o := Observation{Kind: "timer", Name: tm.name, Unit: tm.name, Enabled: true, Persistent: true,
					Next: tm.next.Unix(), Every: int64(tm.every.Seconds())}
				if tm.running != nil {
					obs = append(obs, withRun(o, Run{Start: tm.running.Start, Result: "running"}))
				} else {
					obs = append(obs, withRun(o, *tm.last))
				}
			}
			tr.Update("timer", obs, now)
			tr.Update("cron", c.Observations(now), now)
			for _, j := range tr.Jobs() {
				if (j.State == Failed || j.State == Missed || j.State == Slow) && prev[j.ID] != j.State {
					if broken {
						brokenAlerts++
						prev[j.ID] = j.State
						continue
					}
					alerts++
					t.Logf("server %d %s: %s at %s (%s)", srv, j.Name, j.State, now.Format(time.RFC3339), fmt.Sprint(j.MissedWhy, j.UsualSeconds))
				}
				prev[j.ID] = j.State
			}
		}
	}
	if alerts > 0 {
		t.Fatalf("%d job alerts on a healthy fleet of 100 servers in a day", alerts)
	}
	if brokenAlerts < 2 {
		t.Fatalf("the broken server raised %d alerts, want its failing timer and cron line", brokenAlerts)
	}
}

func withRun(o Observation, r Run) Observation {
	o.Runs = []Run{r}
	return o
}
