// SPDX-License-Identifier: AGPL-3.0-only

package inventory

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

func TestSendsOnChangeResendsAndWaitsWhenRefused(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	certs := []string{"a"}
	var sent [][]byte
	out := sender.Delivered
	s := &Shipper{
		Build: func() Snapshot { return Snapshot{Node: "web-1", Certificates: certs} },
		Send:  func(_ context.Context, b []byte) (sender.Outcome, int) { sent = append(sent, b); return out, 204 },
		Now:   func() time.Time { return now },
	}
	ctx := context.Background()
	if !s.Tick(ctx) || len(sent) != 1 {
		t.Fatal("the first snapshot goes out")
	}
	var got map[string]any
	_ = json.Unmarshal(sent[0], &got)
	if got["source"] != "inventory" || got["node"] != "web-1" {
		t.Fatalf("payload: %s", sent[0])
	}
	now = now.Add(time.Minute)
	if s.Tick(ctx) {
		t.Fatal("unchanged within 10 minutes: nothing sent")
	}
	certs = []string{"a", "b"}
	if !s.Tick(ctx) {
		t.Fatal("a change goes out at once")
	}
	now = now.Add(11 * time.Minute)
	if !s.Tick(ctx) {
		t.Fatal("unchanged, but 10 minutes passed: sent again")
	}
	// An older backend refuses it: an hour's quiet.
	out = sender.Rejected
	certs = []string{"c"}
	s.Tick(ctx)
	n := len(sent)
	now = now.Add(30 * time.Minute)
	certs = []string{"d"}
	s.Tick(ctx)
	if len(sent) != n {
		t.Fatal("refused: no retry within the hour")
	}
	now = now.Add(31 * time.Minute)
	s.Tick(ctx)
	if len(sent) != n+1 {
		t.Fatal("an hour later it tries again")
	}
}
