// SPDX-License-Identifier: AGPL-3.0-only

package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/docker"
	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

// Docker events are sent like Kubernetes events (POST /ingest/v1/events, ADR-061),
// so the Events page groups, counts and charts both the same way. Only the fields
// below are read from an event: container labels other than the Compose project are
// never sent, and the daemon's events carry no environment variables.

// EventRecord is one Docker event in the ingest format, with the host it happened on.
type EventRecord struct {
	UID string `json:"uid"`
	// Namespace is the Compose project ("" for standalone containers).
	Namespace string `json:"namespace,omitempty"`
	Host      string `json:"host"`
	Involved  struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
		UID  string `json:"uid,omitempty"`
	} `json:"involved"`
	Type                string    `json:"type"`
	Reason              string    `json:"reason"`
	Message             string    `json:"message"`
	Count               int32     `json:"count"`
	FirstTS             time.Time `json:"first_ts"`
	LastTS              time.Time `json:"last_ts"`
	ReportingController string    `json:"reporting_controller,omitempty"`
}

// maxQueuedEvents bounds the events kept while the backend is unreachable.
const maxQueuedEvents = 2000

// EventsChunk caps the events per request.
const EventsChunk = 1000

// EventInterval is how often queued events are sent.
const EventInterval = 10 * time.Second

const composeProject = "com.docker.compose.project"

// ToEventRecord turns a Docker event into a record; false for events not sent
// (health checks starting, other actions).
func ToEventRecord(e docker.Event, host string) (EventRecord, bool) {
	r := EventRecord{Host: host, Type: "Normal", Count: 1, ReportingController: "docker"}
	a := e.Actor.Attributes
	at := time.Unix(0, e.TimeNano).UTC()
	r.FirstTS, r.LastTS = at, at
	switch e.Type {
	case "image":
		if e.Action != "pull" {
			return r, false
		}
		// The actor ID is the reference pulled ("busybox:1.37"); the name attribute
		// drops the tag (measured on Docker 29).
		ref := e.Actor.ID
		if ref == "" || strings.HasPrefix(ref, "sha256:") {
			ref = a["name"]
		}
		r.Involved.Kind, r.Involved.Name = "Image", ref
		r.Reason, r.Message = "Pulled", "Pulled image "+ref
	case "container":
		r.Involved.Kind, r.Involved.Name, r.Involved.UID = "Container", a["name"], e.Actor.ID
		r.Namespace = a[composeProject]
		if r.Involved.Name == "" {
			r.Involved.Name = shortID(e.Actor.ID)
		}
		switch action := e.Action; {
		case action == "create":
			r.Reason, r.Message = "Created", "Created from image "+a["image"]
		case action == "start":
			r.Reason, r.Message = "Started", "Started"
		case action == "die":
			code, _ := strconv.Atoi(a["exitCode"])
			r.Reason, r.Message = "Exited", fmt.Sprintf("Exited with code %d", code)
			if code != 0 {
				r.Type, r.Reason = "Warning", "Died"
				if code == 137 {
					r.Message += " (killed)"
				}
			}
		case action == "oom":
			r.Type, r.Reason, r.Message = "Warning", "OOMKilled", "Killed for using too much memory"
		case action == "restart":
			r.Reason, r.Message = "Restarted", "Restarted"
		case action == "destroy":
			r.Reason, r.Message = "Destroyed", "Removed"
		case strings.HasPrefix(action, "health_status"):
			switch strings.TrimSpace(strings.TrimPrefix(action, "health_status:")) {
			case "unhealthy":
				r.Type, r.Reason, r.Message = "Warning", "Unhealthy", "Health check failing"
			case "healthy":
				r.Reason, r.Message = "Healthy", "Health check passing"
			default:
				return r, false
			}
		default:
			return r, false
		}
	default:
		return r, false
	}
	r.UID = fmt.Sprintf("%s:%s:%d", shortID(e.Actor.ID), r.Reason, e.TimeNano)
	return r, true
}

func shortID(id string) string {
	if len(id) > 12 && !strings.ContainsAny(id, ":/") {
		return id[:12]
	}
	return id
}

// queueEvent keeps a record for the next send, dropping the oldest when full.
// Callers hold c.mu.
func (c *Collector) queueEvent(e docker.Event) {
	r, ok := ToEventRecord(e, c.Host)
	if !ok {
		return
	}
	if len(c.events) >= maxQueuedEvents {
		c.events = c.events[1:]
		c.eventsDropped++
	}
	c.events = append(c.events, r)
}

// DrainEvents returns the queued events and empties the queue.
func (c *Collector) DrainEvents() []EventRecord {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := c.events
	c.events = nil
	return out
}

// requeue puts undelivered events back in front of newer ones.
func (c *Collector) requeue(rs []EventRecord) {
	c.mu.Lock()
	defer c.mu.Unlock()
	all := append(append([]EventRecord{}, rs...), c.events...)
	if extra := len(all) - maxQueuedEvents; extra > 0 {
		all = all[extra:]
		c.eventsDropped += extra
	}
	c.events = all
}

// PostFunc sends one gzipped JSON body to /ingest/v1/events.
type PostFunc func(ctx context.Context, body []byte) (sender.Outcome, int)

// FlushEvents sends the queued events; undelivered ones are kept, rejected ones dropped.
func (c *Collector) FlushEvents(ctx context.Context, post PostFunc, log *slog.Logger) error {
	records := c.DrainEvents()
	for start := 0; start < len(records); start += EventsChunk {
		chunk := records[start:min(start+EventsChunk, len(records))]
		b, err := json.Marshal(map[string]any{"events": chunk})
		if err != nil {
			return err
		}
		outcome, status := post(ctx, b)
		if outcome == sender.Rejected {
			log.Warn("docker events rejected by the backend", "status", status, "events", len(chunk))
			continue
		}
		if outcome != sender.Delivered {
			c.requeue(records[start:])
			return fmt.Errorf("docker events not delivered: %s (status %d)", outcome, status)
		}
	}
	return nil
}

// ShipEvents flushes every EventInterval until ctx ends.
func (c *Collector) ShipEvents(ctx context.Context, post PostFunc, log *slog.Logger) {
	t := time.NewTicker(EventInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := c.FlushEvents(ctx, post, log); err != nil {
				log.Debug("docker events kept for the next send", "err", err)
			}
		}
	}
}
