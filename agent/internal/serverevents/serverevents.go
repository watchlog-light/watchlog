// SPDX-License-Identifier: AGPL-3.0-only

// Package serverevents keeps a server's own events (0.9.2, ADR-207/208 amended): a service
// failing, starting, stopping, restarting or its unit file changing; a process group's failed
// exit, crash loop, appearing and going; OOM kills and releases. They are sent like Docker's
// and Kubernetes' (POST /ingest/v1/events, ADR-061), so the Events page groups, counts and
// charts them the same way. An event names its workload (the unit, the group's derived name)
// and never a pid, an argument or a command line.
package serverevents

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/collectors/runtime"
	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

// Kinds of workload an event is about.
const (
	Service = "Service"
	Process = "Process"
)

// Types, as Kubernetes events have them.
const (
	Normal  = "Normal"
	Warning = "Warning"
)

// Reasons the agent sends.
const (
	Failed         = "Failed"         // a service failed (systemd's result, its exit code)
	Started        = "Started"        // a service started
	Stopped        = "Stopped"        // a service stopped
	Restarted      = "Restarted"      // systemd restarted it (NRestarts)
	UnitChanged    = "UnitChanged"    // its unit file changed on disk
	FailedExit     = "FailedExit"     // a group's process exited with an error or a signal
	CrashLoop      = "CrashLoop"      // 3 failed exits in 10 minutes
	CrashLoopEnded = "CrashLoopEnded" // no failed exit for 10 minutes after a crash loop
	Appeared       = "Appeared"       // a process group started
	Gone           = "Gone"           // every instance of a group exited
	OOMKilled      = "OOMKilled"      // the OOM killer chose it
	Release        = "Release"        // its executable changed on disk
)

// maxKeys bounds the events kept (one per workload, reason and day): a flood of distinct
// workloads can't grow the agent past its budget (SPEC §6.1).
const maxKeys = 2000

// Sink is what the collectors call: one occurrence of an event.
type Sink interface {
	Add(kind, name, reason, typ, message string)
}

type entry struct {
	rec   runtime.EventRecord
	dirty bool
}

// Recorder groups occurrences per workload, reason and UTC day, as Kubernetes counts an
// event: one record with a count and its first and last time; only changed ones are sent.
type Recorder struct {
	Host string
	Now  func() time.Time

	mu      sync.Mutex
	started int64
	events  map[string]*entry
	// Dropped is how many occurrences were not kept (maxKeys reached).
	Dropped int
}

// New returns a recorder for one server.
func New(host string) *Recorder {
	return &Recorder{Host: host, started: time.Now().UnixNano(), events: map[string]*entry{}}
}

func (r *Recorder) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

// Add records one occurrence. The message is the newest's; the type too (a Warning stays a
// Warning for the day once one occurred).
func (r *Recorder) Add(kind, name, reason, typ, message string) {
	if name == "" || reason == "" {
		return
	}
	now := r.now()
	day := now.Format("2006-01-02")
	key := kind + "\x00" + name + "\x00" + reason + "\x00" + day
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.events == nil {
		r.events = map[string]*entry{}
	}
	e := r.events[key]
	if e == nil {
		r.pruneOldDays(day)
		if len(r.events) >= maxKeys {
			r.Dropped++
			return
		}
		e = &entry{}
		e.rec.UID = r.uid(key)
		e.rec.Host = r.Host
		e.rec.Involved.Kind = kind
		e.rec.Involved.Name = name
		e.rec.Reason = reason
		e.rec.FirstTS = now
		e.rec.ReportingController = "watchlog-agent"
		r.events[key] = e
	}
	e.rec.Count++
	e.rec.LastTS = now
	e.rec.Message = clip(message)
	if typ == Warning || e.rec.Type == "" {
		e.rec.Type = typ
	}
	e.dirty = true
}

// uid is stable for a workload, reason and day within this agent's run, so the backend keeps
// one count per run (ADR-061's per-uid counts) and adds the runs of a day together.
func (r *Recorder) uid(key string) string {
	sum := sha256.Sum256([]byte(key + "\x00" + strconv.FormatInt(r.started, 10)))
	return "sv-" + hex.EncodeToString(sum[:20])
}

// pruneOldDays drops records of earlier days that were sent (callers hold mu).
func (r *Recorder) pruneOldDays(today string) {
	for k, e := range r.events {
		if !e.dirty && e.rec.LastTS.Format("2006-01-02") != today {
			delete(r.events, k)
		}
	}
}

// Drain returns the changed records, oldest first, and marks them sent.
func (r *Recorder) Drain() []runtime.EventRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []runtime.EventRecord
	for _, e := range r.events {
		if e.dirty {
			out = append(out, e.rec)
			e.dirty = false
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastTS.Before(out[j].LastTS) })
	return out
}

// requeue marks undelivered records changed again (unless a newer occurrence did already).
func (r *Recorder) requeue(rs []runtime.EventRecord) {
	r.mu.Lock()
	defer r.mu.Unlock()
	byUID := map[string]bool{}
	for _, x := range rs {
		byUID[x.UID] = true
	}
	for _, e := range r.events {
		if byUID[e.rec.UID] {
			e.dirty = true
		}
	}
}

// Flush sends the changed records; undelivered ones are kept, rejected ones dropped.
func (r *Recorder) Flush(ctx context.Context, post runtime.PostFunc, log *slog.Logger) error {
	records := r.Drain()
	for start := 0; start < len(records); start += runtime.EventsChunk {
		chunk := records[start:min(start+runtime.EventsChunk, len(records))]
		b, err := json.Marshal(map[string]any{"events": chunk})
		if err != nil {
			return err
		}
		outcome, status := post(ctx, b)
		switch outcome {
		case sender.Rejected:
			log.Warn("server events rejected by the backend", "status", status, "events", len(chunk))
		case sender.Delivered:
		default:
			r.requeue(records[start:])
			return nil
		}
	}
	return nil
}

// Ship sends the changed records every runtime.EventInterval until ctx ends.
func (r *Recorder) Ship(ctx context.Context, post runtime.PostFunc, log *slog.Logger) {
	t := time.NewTicker(runtime.EventInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := r.Flush(ctx, post, log); err != nil {
				log.Warn("server events", "err", err)
			}
		}
	}
}

func clip(s string) string {
	if len(s) > 1024 {
		return s[:1024]
	}
	return s
}
