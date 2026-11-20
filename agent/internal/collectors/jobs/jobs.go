// SPDX-License-Identifier: AGPL-3.0-only

// Package jobs follows a server's scheduled jobs (ADR-223): systemd timers from systemd
// (timers.go) and cron jobs from the crontabs and the processes cron starts (cron.go). Each
// job keeps its last runs and a state with its reason: Failed (the last run failed; how many
// in a row; the last good run), Missed (a run was expected and none started while the server
// was up), Slow (running, or ran, far longer than usual), Working. Only a job's derived name
// leaves the server, never a command line, an argument or an environment value.
package jobs

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
	"github.com/watchlog-light/watchlog/agent/internal/serverevents"
)

// Caps and thresholds (ADR-223, ADR-224, ADR-225).
const (
	MaxJobs = 100
	// RunsKept per job in the agent (the backend keeps more).
	RunsKept = 30
	// UsualAfter is how many good runs a job needs before it can be Slow.
	UsualAfter = 5
	// FrequentEvery: a job expected at least this often is summarized, not run by run.
	FrequentEvery = 5 * time.Minute
	// MissedGrace is how long after its expected time a run may still start.
	MissedGrace = 3 * time.Minute
)

// States.
const (
	Working  = "working"
	Failed   = "failed"
	Missed   = "missed"
	Slow     = "slow"
	Running  = "running"
	Disabled = "disabled"
	New      = "new" // no run seen yet
)

// Why a run was missed.
const (
	MissedNotRun       = "not-run"       // the server was up and nothing started
	MissedServerOff    = "server-off"    // the server was off at the time (not alerted)
	MissedTimerOff     = "timer-off"     // the timer was disabled or stopped
	MissedAgentStopped = "agent-stopped" // cron, the agent wasn't running: unknown (not alerted)
)

// Run is one run of a job.
type Run struct {
	Start  int64  `json:"start"`
	End    int64  `json:"end,omitempty"`
	Code   *int   `json:"code,omitempty"`
	Result string `json:"result"` // success, failed, running, unknown (cron's log: no exit code)
}

// Seconds is how long it ran (or has been running, at now).
func (r Run) Seconds(now time.Time) float64 {
	end := r.End
	if end == 0 {
		end = now.Unix()
	}
	return float64(end - r.Start)
}

// Job is one scheduled job and its state.
type Job struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"` // timer, cron
	Name     string `json:"name"`
	Unit     string `json:"unit,omitempty"`     // the service a timer starts
	Schedule string `json:"schedule,omitempty"` // OnCalendar as systemd normalised it, or the cron fields
	Source   string `json:"source,omitempty"`   // /etc/crontab, /etc/cron.d/<file>, user crontab
	Enabled  bool   `json:"enabled"`
	// Persistent and RandomDelaySec: a timer's catch-up after boot and random delay.
	Persistent     bool  `json:"persistent,omitempty"`
	RandomDelaySec int64 `json:"randomDelaySec,omitempty"`
	Next           int64 `json:"next,omitempty"`
	Runs           []Run `json:"runs"`
	// Every is the usual time between expected runs, seconds (0 unknown).
	Every int64 `json:"every,omitempty"`

	State        string  `json:"state"`
	FailedStreak int     `json:"failedStreak"`
	LastGood     int64   `json:"lastGood,omitempty"`
	MissedRuns   int     `json:"missedRuns"`
	MissedWhy    string  `json:"missedWhy,omitempty"`
	MissedAt     int64   `json:"missedAt,omitempty"`
	UsualSeconds float64 `json:"usualSeconds,omitempty"`
	Frequent     bool    `json:"frequent,omitempty"`

	// expected are the times a run is owed (not sent).
	Expected []int64 `json:"expected,omitempty"`
}

// IDOf is a job's stable id from its kind and name.
func IDOf(kind, name string) string {
	sum := sha256.Sum256([]byte(kind + "\n" + name))
	return hex.EncodeToString(sum[:8])
}

// Observation is what a source saw of a job this round.
type Observation struct {
	Kind, Name, Unit, Schedule, Source string
	Enabled                            bool
	Persistent                         bool
	RandomDelaySec                     int64
	// Next is when the next run is expected (0: none; a stopped or disabled timer).
	Next int64
	// Runs are the runs seen (started or finished), newest last; known ones are merged.
	Runs []Run
	// Every is the time between expected runs, when the schedule says (cron).
	Every int64
	// Triggered is the source's own last trigger time (a timer's LastTriggerUSec): a run
	// systemd started counts even if its unit's run was missed between two reads.
	Triggered int64
}

// Tracker keeps every job's runs and state, across agent restarts (Path).
type Tracker struct {
	Path   string
	Events serverevents.Sink
	// Boot is the server's boot time; Since is when this agent started.
	Boot, Since time.Time

	mu   sync.Mutex
	jobs map[string]*Job
}

// Load reads the saved state (a missing or broken file starts empty).
func (t *Tracker) Load() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.jobs = map[string]*Job{}
	if t.Path == "" {
		return
	}
	b, err := os.ReadFile(t.Path)
	if err != nil {
		return
	}
	var saved []*Job
	if json.Unmarshal(b, &saved) != nil {
		return
	}
	for _, j := range saved {
		t.jobs[j.ID] = j
	}
}

func (t *Tracker) save() {
	if t.Path == "" {
		return
	}
	list := make([]*Job, 0, len(t.jobs))
	for _, j := range t.jobs {
		list = append(list, j)
	}
	b, err := json.Marshal(list)
	if err != nil {
		return
	}
	tmp := t.Path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, t.Path)
	}
}

// Update applies one round of observations of one kind (jobs of that kind not observed are
// gone) and works out every state at now.
func (t *Tracker) Update(kind string, obs []Observation, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.jobs == nil {
		t.jobs = map[string]*Job{}
	}
	seen := map[string]bool{}
	for _, o := range obs {
		id := IDOf(o.Kind, o.Name)
		seen[id] = true
		j := t.jobs[id]
		if j == nil {
			if len(t.jobs) >= MaxJobs {
				continue
			}
			j = &Job{ID: id, Kind: o.Kind, Name: o.Name, State: New}
			t.jobs[id] = j
		}
		t.observe(j, o, now)
	}
	for id, j := range t.jobs {
		if j.Kind == kind && !seen[id] {
			delete(t.jobs, id)
		}
	}
	t.save()
}

// owe records an expected run time once.
func owe(j *Job, at int64) {
	if at <= 0 {
		return
	}
	for _, e := range j.Expected {
		if e == at {
			return
		}
	}
	j.Expected = append(j.Expected, at)
	if len(j.Expected) > 50 {
		j.Expected = j.Expected[len(j.Expected)-50:]
	}
}

func (t *Tracker) observe(j *Job, o Observation, now time.Time) {
	prevState, prevStreak := j.State, j.FailedStreak
	j.Unit, j.Schedule, j.Source, j.Enabled = o.Unit, o.Schedule, o.Source, o.Enabled
	j.Persistent, j.RandomDelaySec = o.Persistent, o.RandomDelaySec
	// The next run is owed once its time comes; a new Next is a new debt.
	if j.Next > 0 && o.Next != j.Next {
		owe(j, j.Next)
	}
	j.Next = o.Next
	if o.Every > 0 {
		j.Every = o.Every
	}
	for _, r := range o.Runs {
		merge(j, r)
	}
	if o.Triggered > 0 {
		// systemd triggered a run we may not have seen as a unit run: it settles that debt.
		settle(j, o.Triggered)
	}
	for _, r := range j.Runs {
		settle(j, r.Start)
	}
	t.work(j, now)
	t.events(j, prevState, prevStreak, now)
}

// merge adds a run, or completes the one with the same start.
func merge(j *Job, r Run) {
	for i := range j.Runs {
		if j.Runs[i].Start == r.Start {
			if r.End != 0 || j.Runs[i].End == 0 {
				j.Runs[i] = r
			}
			return
		}
	}
	j.Runs = append(j.Runs, r)
	sort.Slice(j.Runs, func(a, b int) bool { return j.Runs[a].Start < j.Runs[b].Start })
	if len(j.Runs) > RunsKept {
		j.Runs = j.Runs[len(j.Runs)-RunsKept:]
	}
}

// settle removes the debts a run that started at `start` pays: every expected time before
// it, and one a little after it (a run may start up to MissedGrace early: cron's minute).
func settle(j *Job, start int64) {
	keep := j.Expected[:0]
	for _, e := range j.Expected {
		if e <= start+int64(MissedGrace.Seconds()) {
			continue
		}
		keep = append(keep, e)
	}
	j.Expected = keep
}

func (t *Tracker) work(j *Job, now time.Time) {
	// Failures in a row, newest first; the last good run.
	j.FailedStreak, j.LastGood = 0, 0
	streakDone := false
	var good []float64
	for i := len(j.Runs) - 1; i >= 0; i-- {
		r := j.Runs[i]
		switch r.Result {
		case "running":
			continue
		case "unknown":
			// A run seen in cron's log, without its exit code: neither good nor failed.
			streakDone = true
		case "success":
			if j.LastGood == 0 {
				j.LastGood = r.Start
			}
			streakDone = true
			if len(good) < 14 {
				good = append(good, r.Seconds(now))
			}
		default:
			if !streakDone {
				j.FailedStreak++
			}
		}
	}
	j.UsualSeconds = 0
	if len(good) >= UsualAfter {
		sort.Float64s(good)
		j.UsualSeconds = good[len(good)/2]
	}
	j.Frequent = j.Every > 0 && j.Every <= int64(FrequentEvery.Seconds())

	// Missed: a debt older than the grace, with the server up at that time. The agent's
	// own absence (cron only) and the server being off are told apart and not counted.
	j.MissedRuns, j.MissedWhy, j.MissedAt = 0, "", 0
	grace := int64(MissedGrace.Seconds())
	var keep []int64
	for _, e := range j.Expected {
		if now.Unix() < e+grace {
			keep = append(keep, e)
			continue
		}
		switch {
		case !t.Boot.IsZero() && t.Boot.Unix() > e:
			j.MissedWhy = MissedServerOff
		case j.Kind == "cron" && !t.Since.IsZero() && t.Since.Unix() > e:
			j.MissedWhy = MissedAgentStopped
		default:
			j.MissedRuns++
			j.MissedAt = e
			j.MissedWhy = MissedNotRun
			if !j.Enabled {
				j.MissedWhy = MissedTimerOff
			}
			keep = append(keep, e) // owed until a run starts
		}
	}
	j.Expected = keep

	last := len(j.Runs) - 1
	slowFor := func(sec float64) bool {
		return j.UsualSeconds > 0 && sec > 3*j.UsualSeconds && sec > j.UsualSeconds+300
	}
	switch {
	case last >= 0 && j.Runs[last].Result == "running" && slowFor(j.Runs[last].Seconds(now)):
		j.State = Slow
	case j.FailedStreak > 0:
		j.State = Failed
	case j.MissedRuns > 0:
		j.State = Missed
	case last >= 0 && j.Runs[last].Result == "running":
		j.State = Running
	case last >= 0 && j.Runs[last].End > 0 && slowFor(j.Runs[last].Seconds(now)):
		j.State = Slow
	case !j.Enabled && j.Next == 0:
		j.State = Disabled
	case last < 0:
		j.State = New
	default:
		j.State = Working
	}
}

// events: failed (once per streak, again at 3), missed, recovered (ADR-225); grouped per job,
// reason and day by the recorder, so a job every minute is a few records a day.
func (t *Tracker) events(j *Job, prevState string, prevStreak int, _ time.Time) {
	if t.Events == nil {
		return
	}
	switch {
	case j.State == Failed && (prevStreak == 0 || (prevStreak < 3 && j.FailedStreak >= 3)):
		msg := "failed"
		if last := j.lastEnded(); last != nil && last.Code != nil {
			msg = "failed with exit code " + itoa(*last.Code)
		}
		if j.FailedStreak > 1 {
			msg += ", " + itoa(j.FailedStreak) + " times in a row"
		}
		t.Events.Add("Job", j.Name, "JobFailed", serverevents.Warning, msg)
	case j.State == Missed && prevState != Missed:
		t.Events.Add("Job", j.Name, "JobMissed", serverevents.Warning, "a run was expected and didn't start")
	case (prevState == Failed || prevState == Missed) && (j.State == Working || j.State == Running):
		t.Events.Add("Job", j.Name, "JobRecovered", serverevents.Normal, "ran successfully again")
	}
}

func (j *Job) lastEnded() *Run {
	for i := len(j.Runs) - 1; i >= 0; i-- {
		if j.Runs[i].Result != "running" {
			return &j.Runs[i]
		}
	}
	return nil
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// Jobs is every job, worst first.
func (t *Tracker) Jobs() []Job {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]Job, 0, len(t.jobs))
	for _, j := range t.jobs {
		c := *j
		c.Runs = append([]Run(nil), j.Runs...)
		c.Expected = nil
		out = append(out, c)
	}
	rank := map[string]int{Failed: 0, Missed: 1, Slow: 2, Running: 3, New: 4, Working: 5, Disabled: 6}
	sort.Slice(out, func(a, b int) bool {
		if rank[out[a].State] != rank[out[b].State] {
			return rank[out[a].State] < rank[out[b].State]
		}
		return out[a].Name < out[b].Name
	})
	return out
}

// Collect sends the three series the rules read (ADR-224).
func (t *Tracker) Collect() ([]metrics.Sample, error) {
	var out []metrics.Sample
	for _, j := range t.Jobs() {
		l := []string{"job", j.Name, "job_id", j.ID, "kind", j.Kind}
		if ns, name, ok := strings.Cut(j.Name, "/"); ok && j.Kind == "cronjob" {
			// A Kubernetes CronJob: its namespace, as every kube series has (ADR-223).
			l = []string{"job", name, "job_id", j.ID, "kind", j.Kind, "namespace", ns}
		}
		out = append(out,
			metrics.New("watchlog_job_failed_streak", float64(j.FailedStreak), l...),
			metrics.New("watchlog_job_missed_runs", float64(j.MissedRuns), l...))
		slow := 0.0
		if j.State == Slow {
			slow = 1
		}
		out = append(out, metrics.New("watchlog_job_slow", slow, l...))
	}
	return out, nil
}

// StatePath is where the tracker keeps its state, next to the agent's buffer.
func StatePath(bufferDir string) string {
	return filepath.Join(filepath.Dir(bufferDir), "jobs.json")
}

// BootTime is the server's boot time from /proc/stat's btime (zero when unknown).
func BootTime(proc string) time.Time {
	b, err := os.ReadFile(filepath.Join(proc, "stat")) //nolint:gosec // the host's procfs
	if err != nil {
		return time.Time{}
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "btime "); ok {
			if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
				return time.Unix(n, 0)
			}
		}
	}
	return time.Time{}
}
