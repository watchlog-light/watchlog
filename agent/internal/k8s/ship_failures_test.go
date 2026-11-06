// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"sync"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

// poster answers deltas with a fixed outcome and records every body's kind.
type poster struct {
	mu         sync.Mutex
	delta      sender.Outcome // what a delta gets
	snapshotOK bool
	kinds      []string
}

func (p *poster) post(_ context.Context, body []byte) (sender.Outcome, int) {
	var b objectsBody
	_ = json.Unmarshal(body, &b)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.kinds = append(p.kinds, b.Kind)
	if b.Kind == "snapshot" {
		if p.snapshotOK {
			return sender.Delivered, 204
		}
		return sender.Retry, 500
	}
	switch p.delta {
	case sender.Delivered:
		return sender.Delivered, 204
	case sender.Rejected:
		return sender.Rejected, 400
	}
	return sender.Retry, 500
}

func (p *poster) count(kind string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, k := range p.kinds {
		if k == kind {
			n++
		}
	}
	p.kinds = nil
	return n
}

// A delta the backend keeps refusing (a 500 for one object kind, as the namespace
// marker once did) is not retried until the next 10-minute snapshot: after
// DeltaFailuresBeforeSnapshot failures in a row a fresh snapshot goes (ADR-117).
func TestRepeatedDeltaFailuresSendAFreshSnapshot(t *testing.T) {
	for _, outcome := range []sender.Outcome{sender.Retry, sender.Rejected} {
		c, cs := startCluster(t)
		p := &poster{delta: outcome, snapshotOK: true}
		s, err := NewShipper(c, p.post, slog.New(slog.NewTextHandler(io.Discard, nil)))
		if err != nil {
			t.Fatal(err)
		}
		ctx := context.Background()
		if err := s.Snapshot(ctx); err != nil {
			t.Fatal(err)
		}
		p.count("snapshot")
		var f deltaFailures
		for i := 0; i < DeltaFailuresBeforeSnapshot; i++ {
			// A change each time, so every flush has a delta to send.
			pod, err := cs.CoreV1().Pods("wl-test").Get(ctx, "guaranteed", metav1.GetOptions{})
			if err != nil {
				t.Fatal(err)
			}
			pod.Labels = map[string]string{"try": string(rune('a' + i))}
			pod.ResourceVersion = string(rune('a'+i)) + "-rv" // the fake clientset does not bump it
			if _, err := cs.CoreV1().Pods("wl-test").Update(ctx, pod, metav1.UpdateOptions{}); err != nil {
				t.Fatal(err)
			}
			waitFor(t, "informer update", func() bool {
				obj, ok, _ := c.Store("Pod").GetByKey("wl-test/guaranteed")
				return ok && obj.(*corev1.Pod).Labels["try"] == string(rune('a'+i))
			})
			waitFor(t, "change queued", func() bool {
				s.mu.Lock()
				defer s.mu.Unlock()
				return s.pending[pendingKey{"Pod", "wl-test/guaranteed"}]
			})
			sent := s.flushOrSnapshot(ctx, &f)
			if last := i == DeltaFailuresBeforeSnapshot-1; sent != last {
				t.Fatalf("%v: flush %d: snapshot sent = %v", outcome, i+1, sent)
			}
		}
		if n := p.count("snapshot"); n == 0 {
			t.Errorf("%v: no snapshot after %d failed deltas", outcome, DeltaFailuresBeforeSnapshot)
		}
		if f.n != 0 || f.limit != DeltaFailuresBeforeSnapshot {
			t.Errorf("%v: counter after a delivered snapshot = %+v", outcome, f)
		}
	}
}

// A backend that refuses snapshots too is not sent one every 30 s: the failures
// needed for the next one double, up to the snapshot interval.
func TestSnapshotFallbackBacksOff(t *testing.T) {
	c, _ := startCluster(t)
	p := &poster{delta: sender.Retry}
	s, err := NewShipper(c, p.post, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	s.requeue([]Record{{Kind: "Pod", Namespace: "wl-test", Name: "guaranteed", UID: "u"}})
	f := deltaFailures{n: DeltaFailuresBeforeSnapshot - 1, limit: DeltaFailuresBeforeSnapshot}
	if s.flushOrSnapshot(ctx, &f) {
		t.Fatal("a refused snapshot counted as sent")
	}
	if f.limit != 2*DeltaFailuresBeforeSnapshot || f.n != 0 {
		t.Errorf("after a refused snapshot: %+v", f)
	}
	f = deltaFailures{n: 1000, limit: 1000}
	s.requeue([]Record{{Kind: "Pod", Namespace: "wl-test", Name: "guaranteed", UID: "u"}})
	s.flushOrSnapshot(ctx, &f)
	if max := int(SnapshotInterval / DeltaInterval); f.limit != max {
		t.Errorf("limit = %d, want the cap %d", f.limit, max)
	}
}
