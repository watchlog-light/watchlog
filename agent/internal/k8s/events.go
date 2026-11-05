// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	eventsv1 "k8s.io/api/events/v1"
	"k8s.io/client-go/tools/cache"

	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

// EventsChunk caps the events per request to /ingest/v1/events.
const EventsChunk = 1000

// EventRecord is one Kubernetes event as sent to POST /ingest/v1/events (ADR-061).
type EventRecord struct {
	UID       string `json:"uid"`
	Namespace string `json:"namespace,omitempty"`
	Involved  struct {
		Kind      string `json:"kind"`
		Namespace string `json:"namespace,omitempty"`
		Name      string `json:"name"`
		UID       string `json:"uid,omitempty"`
	} `json:"involved"`
	Type                string    `json:"type"`
	Reason              string    `json:"reason"`
	Message             string    `json:"message"`
	Count               int32     `json:"count"`
	FirstTS             time.Time `json:"first_ts"`
	LastTS              time.Time `json:"last_ts"`
	ReportingController string    `json:"reporting_controller,omitempty"`
}

// ToEventRecord reads count and times from whichever fields the reporter set.
// Measured on kind: kubelet events read through events.k8s.io/v1 have eventTime
// and series empty and carry deprecatedCount / deprecated*Timestamp.
func ToEventRecord(e *eventsv1.Event) EventRecord {
	r := EventRecord{UID: string(e.UID), Namespace: e.Namespace, Type: e.Type, Reason: e.Reason,
		Message: e.Note, ReportingController: e.ReportingController}
	r.Involved.Kind, r.Involved.Namespace = e.Regarding.Kind, e.Regarding.Namespace
	r.Involved.Name, r.Involved.UID = e.Regarding.Name, string(e.Regarding.UID)

	switch {
	case !e.DeprecatedFirstTimestamp.IsZero():
		r.FirstTS = e.DeprecatedFirstTimestamp.UTC()
	case !e.EventTime.IsZero():
		r.FirstTS = e.EventTime.UTC()
	default:
		r.FirstTS = e.CreationTimestamp.UTC()
	}
	switch {
	case e.Series != nil && !e.Series.LastObservedTime.IsZero():
		r.LastTS = e.Series.LastObservedTime.UTC()
	case !e.DeprecatedLastTimestamp.IsZero():
		r.LastTS = e.DeprecatedLastTimestamp.UTC()
	case !e.EventTime.IsZero():
		r.LastTS = e.EventTime.UTC()
	default:
		r.LastTS = r.FirstTS
	}
	switch {
	case e.Series != nil && e.Series.Count > 0:
		r.Count = e.Series.Count
	case e.DeprecatedCount > 0:
		r.Count = e.DeprecatedCount
	default:
		r.Count = 1
	}
	if r.Type == "" {
		r.Type = "Normal"
	}
	return r
}

// EventShipper sends new and updated events in batches. Expired events (the API
// server deletes them after an hour) are kept in the backend.
type EventShipper struct {
	cluster *Cluster
	post    PostFunc
	log     *slog.Logger

	mu      sync.Mutex
	pending map[string]bool // store keys
}

// NewEventShipper registers on the cluster's event informer (NewCluster withEvents).
func NewEventShipper(c *Cluster, post PostFunc, log *slog.Logger) (*EventShipper, error) {
	s := &EventShipper{cluster: c, post: post, log: log, pending: map[string]bool{}}
	mark := func(obj any) {
		if key, err := cache.MetaNamespaceKeyFunc(obj); err == nil {
			s.mu.Lock()
			s.pending[key] = true
			s.mu.Unlock()
		}
	}
	// Events present at start are sent too: the backend de-duplicates them (ADR-061).
	err := c.AddHandler("Event", cache.ResourceEventHandlerFuncs{AddFunc: mark, UpdateFunc: func(_, n any) { mark(n) }})
	return s, err
}

// Flush sends pending events, oldest first; undelivered ones are kept.
func (s *EventShipper) Flush(ctx context.Context) error {
	s.mu.Lock()
	keys := s.pending
	s.pending = map[string]bool{}
	s.mu.Unlock()

	store := s.cluster.Store("Event")
	records := make([]EventRecord, 0, len(keys))
	byUID := map[string]string{}
	for key := range keys {
		obj, ok, err := store.GetByKey(key)
		if err != nil || !ok {
			continue
		}
		if e, ok := obj.(*eventsv1.Event); ok {
			r := ToEventRecord(e)
			records = append(records, r)
			byUID[r.UID] = key
		}
	}
	sort.Slice(records, func(i, j int) bool { return records[i].LastTS.Before(records[j].LastTS) })
	for start := 0; start < len(records); start += EventsChunk {
		chunk := records[start:min(start+EventsChunk, len(records))]
		b, err := json.Marshal(map[string]any{"events": chunk})
		if err != nil {
			return err
		}
		outcome, status := s.post(ctx, b)
		if outcome == sender.Rejected {
			s.log.Warn("events rejected by the backend", "status", status, "events", len(chunk))
			continue
		}
		if outcome != sender.Delivered {
			s.mu.Lock()
			for _, r := range records[start:] {
				s.pending[byUID[r.UID]] = true
			}
			s.mu.Unlock()
			return fmt.Errorf("events not delivered: %s (status %d)", outcome, status)
		}
	}
	return nil
}

// Run flushes every DeltaInterval until ctx ends.
func (s *EventShipper) Run(ctx context.Context) {
	t := time.NewTicker(DeltaInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.Flush(ctx); err != nil {
				s.log.Debug("events kept for the next flush", "err", err)
			}
		}
	}
}
