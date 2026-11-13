// SPDX-License-Identifier: AGPL-3.0-only

package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/collectors/containers"
	"github.com/watchlog-light/watchlog/agent/internal/docker"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

const apiFixtures = "../../docker/testdata/docker-29"

// fakeDocker serves the real responses captured from Docker 29.9.2.
type fakeDocker struct {
	t        *testing.T
	inspects []string
	// reservations sets HostConfig.MemoryReservation by container name (the fixtures have none).
	reservations map[string]int64
}

func (f *fakeDocker) load(name string, into any) error {
	b, err := os.ReadFile(filepath.Join(apiFixtures, name))
	if err != nil {
		return err
	}
	return json.Unmarshal(b, into)
}

func (f *fakeDocker) Negotiate(context.Context) (docker.Version, error) {
	var v docker.Version
	return v, f.load("version.json", &v)
}

func (f *fakeDocker) ListContainers(_ context.Context, withSize bool) ([]docker.ContainerSummary, error) {
	var out []docker.ContainerSummary
	name := "containers.json"
	if withSize {
		name = "containers-size.json"
	}
	return out, f.load(name, &out)
}

var nameByID = map[string]string{}

func (f *fakeDocker) Inspect(_ context.Context, id string) (docker.ContainerState, error) {
	f.inspects = append(f.inspects, nameByID[id])
	var st docker.ContainerState
	if err := f.load("inspect-"+nameByID[id]+".json", &st); err != nil {
		return st, errors.New("no such container fixture")
	}
	if r, ok := f.reservations[nameByID[id]]; ok {
		st.HostConfig.MemoryReservation = r
	}
	return st, nil
}

func (f *fakeDocker) Events(context.Context, time.Time, func(docker.Event)) error { return nil }

func newCollector(t *testing.T) (*Collector, *fakeDocker) {
	t.Helper()
	fd := &fakeDocker{t: t}
	var list []docker.ContainerSummary
	if err := fd.load("containers.json", &list); err != nil {
		t.Fatal(err)
	}
	for _, s := range list {
		nameByID[s.ID] = s.Name()
	}
	cg := containers.NewReader("../containers/testdata/v2/proc", "../containers/testdata/v2/sys")
	c := New(fd, cg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	now := time.Date(2026, 10, 31, 0, 5, 0, 0, time.UTC)
	c.now = func() time.Time { return now }
	return c, fd
}

func find(samples []metrics.Sample, name string, labels map[string]string) (float64, bool) {
	for _, s := range samples {
		if s.Name != name {
			continue
		}
		have := map[string]string{}
		for _, l := range s.Labels {
			have[l.Name] = l.Value
		}
		match := true
		for k, v := range labels {
			if have[k] != v {
				match = false
			}
		}
		if match {
			return s.Value, true
		}
	}
	return 0, false
}

func TestCollectFromRealFixtures(t *testing.T) {
	c, _ := newCollector(t)
	samples, err := c.Collect()
	// The agent's own container has no inspect fixture: a partial error, not a failure.
	if err == nil || !strings.Contains(err.Error(), "watchlog-agent") {
		t.Errorf("err = %v", err)
	}
	cache := map[string]string{"container": "demo-cache-1", "image": "redis:7-alpine", "compose_project": "demo", "compose_service": "cache"}
	checks := []struct {
		name   string
		labels map[string]string
		want   float64
	}{
		{"watchlog_docker_info", map[string]string{"docker_version": "29.9.2", "kernel": "6.8.0-142-generic"}, 1},
		{"watchlog_container_state", map[string]string{"container": "demo-web-1", "state": "running"}, 1},
		{"watchlog_container_health", map[string]string{"container": "demo-web-1", "status": "healthy"}, 1},
		{"watchlog_container_health", map[string]string{"container": "fx-unhealthy", "status": "unhealthy"}, 1},
		{"watchlog_container_state", map[string]string{"container": "fx-crashloop", "state": "restarting"}, 1},
		{"watchlog_container_restarts_total", map[string]string{"container": "fx-crashloop"}, 9},
		{"watchlog_container_state", map[string]string{"container": "fx-exited", "state": "exited"}, 1},
		{"watchlog_container_cpu_seconds_total", cache, 0.275909},
		{"watchlog_container_cpu_limit_cores", cache, 0.5},
		{"watchlog_container_memory_limit_bytes", cache, 134217728},
		{"watchlog_container_memory_working_set_bytes", cache, 3424256},
		{"watchlog_container_network_bytes_total", map[string]string{"container": "demo-cache-1", "dir": "rx"}, 3866},
		{"watchlog_container_fs_io_bytes_total", map[string]string{"container": "demo-worker-1", "dir": "write"}, 318767104},
		{"watchlog_container_fs_bytes", map[string]string{"container": "demo-web-1"}, 81920},
	}
	for _, ck := range checks {
		got, ok := find(samples, ck.name, ck.labels)
		if !ok || got != ck.want {
			t.Errorf("%s%v = %v (found %v), want %v", ck.name, ck.labels, got, ok, ck.want)
		}
	}
	if _, ok := find(samples, "watchlog_container_cpu_seconds_total", map[string]string{"container": "fx-exited"}); ok {
		t.Error("exited container must not report CPU")
	}
	if _, ok := find(samples, "watchlog_container_memory_limit_bytes", map[string]string{"container": "demo-worker-1"}); ok {
		t.Error("unlimited container must not report a memory limit")
	}
	for _, s := range samples {
		for _, l := range s.Labels {
			if l.Name == "id" || l.Name == "container_id" || strings.Contains(l.Value, "0b869286b1d05b4a") {
				t.Fatalf("container IDs must not be labels (SPEC §6.3): %v", s)
			}
		}
	}
}

func TestMemoryReservationIsReported(t *testing.T) {
	c, fd := newCollector(t)
	fd.reservations = map[string]int64{"demo-cache-1": 64 << 20}
	samples, _ := c.Collect()
	if got, ok := find(samples, "watchlog_container_memory_reservation_bytes", map[string]string{"container": "demo-cache-1"}); !ok || got != 64<<20 {
		t.Errorf("reservation = %v (found %v), want 64 MiB", got, ok)
	}
	if _, ok := find(samples, "watchlog_container_memory_reservation_bytes", map[string]string{"container": "demo-web-1"}); ok {
		t.Error("a container without a reservation must not report one")
	}
}

func TestInspectIsCachedAndRefreshedByEvents(t *testing.T) {
	c, fd := newCollector(t)
	_, _ = c.Collect()
	first := len(fd.inspects)
	_, _ = c.Collect()
	// Only the restarting container and the one without a fixture are re-inspected.
	again := fd.inspects[first:]
	for _, n := range again {
		if n != "fx-crashloop" && n != "watchlog-agent" {
			t.Errorf("unexpected re-inspect of %s", n)
		}
	}
	var webID string
	for id, n := range nameByID {
		if n == "demo-web-1" {
			webID = id
		}
	}
	c.handleEvent(docker.Event{Type: "container", Action: "die", Actor: struct {
		ID         string            `json:"ID"`
		Attributes map[string]string `json:"Attributes"`
	}{ID: webID}})
	before := len(fd.inspects)
	_, _ = c.Collect()
	if !contains(fd.inspects[before:], "demo-web-1") {
		t.Error("an event must trigger a re-inspect")
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func TestOOMEventsAreCounted(t *testing.T) {
	c, _ := newCollector(t)
	_, _ = c.Collect()
	var cacheID string
	for id, n := range nameByID {
		if n == "demo-cache-1" {
			cacheID = id
		}
	}
	ev := docker.Event{Type: "container", Action: "oom"}
	ev.Actor.ID = cacheID
	c.handleEvent(ev)
	c.handleEvent(ev)
	samples, _ := c.Collect()
	if v, _ := find(samples, "watchlog_container_oom_events_total", map[string]string{"container": "demo-cache-1"}); v != 2 {
		t.Errorf("oom events = %v", v)
	}
	inv, _ := c.Inventory()
	for _, o := range inv.Containers {
		if o.Name == "demo-cache-1" && !o.OOMKilled {
			t.Error("inventory should flag the OOM kill")
		}
	}
}

func TestInventory(t *testing.T) {
	c, _ := newCollector(t)
	_, _ = c.Collect()
	inv, hash := c.Inventory()
	if inv.Host.DockerVersion != "29.9.2" || inv.Host.KernelVersion != "6.8.0-142-generic" {
		t.Errorf("host = %+v", inv.Host)
	}
	byName := map[string]ContainerObject{}
	for _, o := range inv.Containers {
		byName[o.Name] = o
	}
	web := byName["demo-web-1"]
	if web.Health != "healthy" || web.ComposeProject != "demo" || web.ComposeService != "web" || web.StartedAt == "" {
		t.Errorf("web = %+v", web)
	}
	// User-defined networks only: the default bridge says nothing about who talks to whom.
	if strings.Join(web.Networks, ",") != "demo_default" || len(byName["fx-exited"].Networks) != 0 {
		t.Errorf("networks = %v / %v", web.Networks, byName["fx-exited"].Networks)
	}
	if len(web.Ports) != 1 || web.Ports[0] != (PortObject{PublicPort: 8081, PrivatePort: 80, Protocol: "tcp"}) {
		t.Errorf("ports = %+v (IPv4 and IPv6 bindings should collapse)", web.Ports)
	}
	// Where the integrations collector reaches it, and what it listens on (ADR-131, ADR-132).
	if strings.Join(web.IPs, ",") != "172.18.0.2" || len(web.Exposed) != 1 || web.Exposed[0] != 80 {
		t.Errorf("ips = %v, exposed = %v", web.IPs, web.Exposed)
	}
	if byName["fx-crashloop"].RestartCount != 9 || byName["fx-exited"].State != "exited" {
		t.Errorf("crashloop/exited = %+v %+v", byName["fx-crashloop"], byName["fx-exited"])
	}
	b, _ := json.Marshal(inv)
	for _, forbidden := range []string{"Env", "REDACTED", "Command", "while true"} {
		if strings.Contains(string(b), forbidden) {
			t.Errorf("inventory leaks %q", forbidden)
		}
	}

	// The status text changes every scrape ("Up 39 seconds"); the hash must not.
	c.mu.Lock()
	for i := range c.inventory.Containers {
		c.inventory.Containers[i].Status = "Up 2 hours"
	}
	c.mu.Unlock()
	if _, h2 := c.Inventory(); h2 != hash {
		t.Error("hash changed although only the status text did")
	}
}

func BenchmarkCollect(b *testing.B) {
	c, _ := newCollector(&testing.T{})
	b.ReportAllocs()
	for b.Loop() {
		_, _ = c.Collect()
	}
}

type goneCgroups struct{ Cgroups }

func (goneCgroups) Container(string) (containers.Stats, error) {
	return containers.Stats{}, containers.ErrNotFound
}

func TestStoppedBetweenInspectAndCgroupReadIsNotAnError(t *testing.T) {
	c, _ := newCollector(t)
	c.cgroups = goneCgroups{c.cgroups}
	_, err := c.Collect()
	if err != nil && strings.Contains(err.Error(), "cgroup") {
		t.Errorf("ErrNotFound must not be reported: %v", err)
	}
}
