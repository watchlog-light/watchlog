// SPDX-License-Identifier: AGPL-3.0-only

package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/watchlog-light/watchlog/agent/internal/docker"
	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

// lifecycle reads events captured from Docker 29 while a container was OOM-killed,
// one exited with code 3, one turned unhealthy, and an image was pulled.
func lifecycle(t testing.TB) []docker.Event {
	f, err := os.Open(filepath.Join("..", "..", "docker", "testdata", "docker-29", "events-lifecycle.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	var out []docker.Event
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var e docker.Event
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			t.Fatal(err)
		}
		out = append(out, e)
	}
	return out
}

func TestToEventRecordFromRealEvents(t *testing.T) {
	var got []string
	for _, e := range lifecycle(t) {
		r, ok := ToEventRecord(e, "h1")
		if !ok {
			continue
		}
		if r.Host != "h1" || r.Count != 1 || r.UID == "" || r.FirstTS.IsZero() {
			t.Fatalf("incomplete record %+v", r)
		}
		got = append(got, strings.Join([]string{r.Type, r.Reason, r.Involved.Kind, r.Involved.Name, r.Message}, "|"))
	}
	want := []string{
		"Normal|Pulled|Image|busybox:1.37|Pulled image busybox:1.37",
		"Normal|Created|Container|wl-evt-oom|Created from image busybox:1.37",
		"Normal|Started|Container|wl-evt-oom|Started",
		"Warning|OOMKilled|Container|wl-evt-oom|Killed for using too much memory",
		"Normal|Created|Container|wl-evt-hc|Created from image busybox:1.37",
		"Warning|Died|Container|wl-evt-oom|Exited with code 137 (killed)",
		"Normal|Started|Container|wl-evt-hc|Started",
		"Normal|Created|Container|wl-evt-exit|Created from image busybox:1.37",
		"Normal|Started|Container|wl-evt-exit|Started",
		"Warning|Died|Container|wl-evt-exit|Exited with code 3",
		"Warning|Unhealthy|Container|wl-evt-hc|Health check failing",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("records:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestEventRecordsCarryOnlyNamedFields(t *testing.T) {
	e := docker.Event{Type: "container", Action: "die", TimeNano: 1}
	e.Actor.ID = "abc"
	e.Actor.Attributes = map[string]string{"name": "web", "exitCode": "0",
		"com.docker.compose.project": "shop", "secret.label": "do-not-send", "image": "nginx"}
	r, ok := ToEventRecord(e, "h1")
	if !ok || r.Namespace != "shop" || r.Type != "Normal" || r.Reason != "Exited" {
		t.Fatalf("got %+v", r)
	}
	b, _ := json.Marshal(r)
	if strings.Contains(string(b), "do-not-send") {
		t.Fatalf("a label other than the Compose project was sent: %s", b)
	}
	for _, skip := range []string{"exec_start: sh", "kill", "attach", "health_status: starting"} {
		if _, ok := ToEventRecord(docker.Event{Type: "container", Action: skip}, "h"); ok {
			t.Fatalf("%q should not be sent", skip)
		}
	}
}

func TestEventsQueueAndRequeue(t *testing.T) {
	c, _ := newCollector(t)
	c.Host = "h1"
	for _, e := range lifecycle(t) {
		c.handleEvent(e)
	}
	var posted int
	fail := func(context.Context, []byte) (sender.Outcome, int) { return sender.Retry, 503 }
	if err := c.FlushEvents(context.Background(), fail, slog.Default()); err == nil {
		t.Fatal("expected an error")
	}
	ok := func(_ context.Context, b []byte) (sender.Outcome, int) {
		var body struct{ Events []EventRecord }
		_ = json.Unmarshal(b, &body)
		posted += len(body.Events)
		return sender.Delivered, 204
	}
	if err := c.FlushEvents(context.Background(), ok, slog.Default()); err != nil {
		t.Fatal(err)
	}
	if posted != 11 || len(c.DrainEvents()) != 0 {
		t.Fatalf("posted %d", posted)
	}
	for i := 0; i < maxQueuedEvents+5; i++ {
		c.handleEvent(lifecycle(t)[1])
	}
	if n := len(c.DrainEvents()); n != maxQueuedEvents || c.eventsDropped != 5 {
		t.Fatalf("queue %d, dropped %d", n, c.eventsDropped)
	}
}

// BenchmarkHandleEvent: the cost of one Docker event (re-inspection mark and record).
func BenchmarkHandleEvent(b *testing.B) {
	c, _ := newCollector(&testing.T{})
	events := lifecycle(b)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		c.handleEvent(events[i%len(events)])
		if i%1000 == 999 {
			c.DrainEvents()
		}
	}
}
