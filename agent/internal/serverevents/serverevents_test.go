// SPDX-License-Identifier: AGPL-3.0-only

package serverevents

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

// Repeated events group as Kubernetes events do: one record per workload, reason and day,
// with a count and its first and last time, a stable uid; only changed records are sent,
// undelivered ones are sent again, and a new day starts a new record.
func TestRecorderGroupsAndShips(t *testing.T) {
	at := time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)
	r := New("ubuntu-8gb-nbg1-1")
	r.Now = func() time.Time { return at }
	r.Add(Process, "activity2", FailedExit, Warning, "exited with code 1")
	at = at.Add(time.Minute)
	r.Add(Process, "activity2", FailedExit, Warning, "killed by SIGKILL (9)")
	r.Add(Service, "nginx.service", Started, Normal, "started")
	got := r.Drain()
	if len(got) != 2 {
		t.Fatalf("drained %+v", got)
	}
	// Both records have the same last time, so Drain may return them in either order.
	fe := got[0]
	if fe.Involved.Kind != Process {
		fe = got[1]
	}
	if fe.Involved.Kind != Process || fe.Involved.Name != "activity2" || fe.Count != 2 || fe.Message != "killed by SIGKILL (9)" ||
		fe.Type != Warning || !fe.FirstTS.Before(fe.LastTS) || fe.Host != "ubuntu-8gb-nbg1-1" {
		t.Fatalf("failed exit record %+v", fe)
	}
	if again := r.Drain(); len(again) != 0 {
		t.Fatalf("unchanged records sent again: %+v", again)
	}
	r.Add(Process, "activity2", FailedExit, Warning, "exited with code 1")
	third := r.Drain()
	if len(third) != 1 || third[0].UID != fe.UID || third[0].Count != 3 {
		t.Fatalf("same uid, count 3: %+v", third)
	}
	// A new day: a new record (a new uid), the old one kept until it was sent.
	at = at.Add(24 * time.Hour)
	r.Add(Process, "activity2", FailedExit, Warning, "exited with code 1")
	next := r.Drain()
	if len(next) != 1 || next[0].UID == fe.UID || next[0].Count != 1 {
		t.Fatalf("next day: %+v", next)
	}

	// Undelivered: kept and sent again; delivered: not.
	r.Add(Service, "orders.service", Failed, Warning, "failed (exit-code, exit code 3)")
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	var bodies [][]byte
	retry := func(_ context.Context, b []byte) (sender.Outcome, int) {
		bodies = append(bodies, b)
		return sender.Retry, 503
	}
	_ = r.Flush(context.Background(), retry, log)
	ok := func(_ context.Context, b []byte) (sender.Outcome, int) {
		bodies = append(bodies, b)
		return sender.Delivered, 204
	}
	_ = r.Flush(context.Background(), ok, log)
	_ = r.Flush(context.Background(), ok, log)
	if len(bodies) != 2 {
		t.Fatalf("posts %d, want 2 (a retry, then delivered once)", len(bodies))
	}
	var body struct {
		Events []map[string]any `json:"events"`
	}
	if err := json.Unmarshal(bodies[1], &body); err != nil || len(body.Events) != 1 || body.Events[0]["reason"] != Failed {
		t.Fatalf("body %s", bodies[1])
	}
	for _, k := range []string{"pid", "cmdline", "args"} {
		if _, has := body.Events[0][k]; has {
			t.Fatalf("an event carries %s", k)
		}
	}
}

// The recorder is bounded: past maxKeys distinct events in a day, the rest are counted.
func TestRecorderIsBounded(t *testing.T) {
	r := New("h")
	for i := range maxKeys + 5 {
		r.Add(Process, "g"+string(rune('a'+i%26))+time.Duration(i).String(), Appeared, Normal, "started")
	}
	if len(r.Drain()) != maxKeys || r.Dropped != 5 {
		t.Fatalf("kept %d, dropped %d", len(r.events), r.Dropped)
	}
}
