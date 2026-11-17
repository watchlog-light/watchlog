// SPDX-License-Identifier: AGPL-3.0-only

// Package exits hands process exits from eBPF (ADR-210) to the collectors that attribute
// them: process groups by pid, services by cgroup. Each takes its own copy; both are bounded,
// and nothing here leaves the agent.
package exits

import "sync"

// Max is the most exits kept for one consumer between two scrapes; more are dropped.
const Max = 10_000

// Exit is one process's end.
type Exit struct {
	PID    int
	Cgroup uint64
	Status int  // a normal exit's status
	Signal int  // the terminating signal, 0 for a normal exit
	OOM    bool // chosen by the OOM killer
	// PPID is the parent's pid: 1 for a systemd service's main process.
	PPID int
	// Unit is the exiting process's cgroup name when it is a unit (orders.service).
	Unit string
}

// Kind is how the exit counts: ok, error (non-zero status), signal (killed).
func (e Exit) Kind() string {
	switch {
	case e.Signal != 0 || e.OOM:
		return "signal"
	case e.Status != 0:
		return "error"
	}
	return "ok"
}

// Code is the shell's view: the status, or 128 plus the signal.
func (e Exit) Code() int {
	if e.Signal != 0 {
		return 128 + e.Signal
	}
	return e.Status
}

// Feed collects exits for two consumers.
type Feed struct {
	mu       sync.Mutex
	byPID    map[int]Exit
	byCgroup []Exit
	Dropped  uint64
}

// NewFeed returns an empty feed.
func NewFeed() *Feed { return &Feed{byPID: map[int]Exit{}} }

// Add records an exit.
func (f *Feed) Add(e Exit) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.byPID) < Max {
		f.byPID[e.PID] = e
	} else {
		f.Dropped++
	}
	if len(f.byCgroup) < Max {
		f.byCgroup = append(f.byCgroup, e)
	} else {
		f.Dropped++
	}
}

// TakeByPID returns the exits since the last call, by pid (process groups).
func (f *Feed) TakeByPID() map[int]Exit {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.byPID
	f.byPID = map[int]Exit{}
	return out
}

// TakeAll returns the exits since the last call, in order (services, by cgroup).
func (f *Feed) TakeAll() []Exit {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.byCgroup
	f.byCgroup = nil
	return out
}
