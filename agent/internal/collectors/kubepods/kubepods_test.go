// SPDX-License-Identifier: AGPL-3.0-only

package kubepods

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
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
	"github.com/watchlog-light/watchlog/agent/internal/podmap"
)

// The kind worker captured in slice 1: cgroup tree, /stats/summary and ground truth.
const layout = "../containers/testdata/k8s/kind-containerd-systemd"
const node = "watchlog-worker"

type fakeMaps struct {
	m       *podmap.Map
	fetches int
}

func (f *fakeMaps) Last() *podmap.Map { return f.m }
func (f *fakeMaps) Fetch(context.Context) (*podmap.Map, error) {
	f.fetches++
	if f.m == nil {
		return nil, errors.New("cluster-agent unreachable")
	}
	return f.m, nil
}

type fileSummary struct{ path string }

func (f fileSummary) Fetch(context.Context) (*StatsSummary, error) {
	b, err := os.ReadFile(f.path)
	if err != nil {
		return nil, err
	}
	var s StatsSummary
	return &s, json.Unmarshal(b, &s)
}

// truthMap builds the pod map the cluster-agent would serve from the ground truth.
func truthMap(t testing.TB) *podmap.Map {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(layout, "pods.json"))
	if err != nil {
		t.Fatal(err)
	}
	var pods []struct {
		Namespace, Name, UID, Node string
		Mirror                     *string
		Containers                 []struct{ Name, ContainerID string }
	}
	if err := json.Unmarshal(b, &pods); err != nil {
		t.Fatal(err)
	}
	m := &podmap.Map{Node: node}
	for _, p := range pods {
		if p.Node != node {
			continue
		}
		e := podmap.Pod{ID: p.UID, Namespace: p.Namespace, Name: p.Name, WorkloadKind: "Pod", Workload: p.Name, Containers: map[string]string{}}
		if p.Mirror != nil {
			e.Mirror = *p.Mirror
		}
		for _, c := range p.Containers {
			if c.ContainerID != "" {
				e.Containers[podmap.ContainerID(c.ContainerID)] = c.Name
			}
		}
		m.Pods = append(m.Pods, e)
	}
	return m
}

func newCollector(maps Maps, now *time.Time) *Collector {
	dir := filepath.Join(layout, node)
	c := New(containers.NewReader(filepath.Join(dir, "proc"), filepath.Join(dir, "sys")), maps,
		fileSummary{filepath.Join(dir, "summary.json")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.now = func() time.Time { return *now }
	return c
}

func byName(samples []metrics.Sample, name string) []metrics.Sample {
	var out []metrics.Sample
	for _, s := range samples {
		if s.Name == name {
			out = append(out, s)
		}
	}
	return out
}

func label(s metrics.Sample, name string) string {
	for _, l := range s.Labels {
		if l.Name == name {
			return l.Value
		}
	}
	return ""
}

func TestMappedContainersGetNamesNeverIDs(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	c := newCollector(&fakeMaps{m: truthMap(t)}, &now)
	out, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	cpu := byName(out, "watchlog_container_cpu_seconds_total")
	if len(cpu) < 5 {
		t.Fatalf("cpu series = %d", len(cpu))
	}
	pods := map[string]bool{}
	for _, s := range cpu {
		if label(s, "namespace") == "" || label(s, "pod") == "" || label(s, "container") == "" || label(s, "workload") == "" {
			t.Errorf("unlabelled series %+v", s.Labels)
		}
		pods[label(s, "pod")] = true
	}
	if !pods["guaranteed"] {
		t.Errorf("guaranteed pod missing: %v", pods)
	}
	for _, s := range out {
		for _, l := range s.Labels {
			if len(l.Value) >= 32 && !strings.ContainsAny(l.Value, "-/") {
				t.Errorf("%s carries an ID-like label %s=%s", s.Name, l.Name, l.Value)
			}
		}
	}
	if len(byName(out, "watchlog_pod_network_bytes_total")) == 0 || len(byName(out, "watchlog_container_fs_bytes")) == 0 {
		t.Error("no kubelet summary series")
	}
	if u := byName(out, "watchlog_agent_unmapped_containers_total"); len(u) != 1 || u[0].Value != 0 {
		t.Errorf("unmapped = %+v", u)
	}
}

func TestUnmappedSeriesAreHeldThenDroppedAndCounted(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	maps := &fakeMaps{}
	c := newCollector(maps, &now)
	out, _ := c.Collect()
	if n := len(byName(out, "watchlog_container_cpu_seconds_total")); n != 0 {
		t.Fatalf("%d container series emitted without names", n)
	}
	held := len(c.held)
	if held == 0 {
		t.Fatal("nothing held")
	}
	now = now.Add(Hold + 15*time.Second)
	out, _ = c.Collect()
	if u := byName(out, "watchlog_agent_unmapped_containers_total"); u[0].Value != float64(held) {
		t.Errorf("unmapped = %v, want %d (containers and pods held past %s)", u[0].Value, held, Hold)
	}
	if len(byName(out, "watchlog_container_cpu_seconds_total")) != 0 || len(c.held) != 0 {
		t.Error("given-up series must not come back")
	}
	if maps.fetches < 2 {
		t.Errorf("map fetched %d times; unknown pods must trigger refreshes", maps.fetches)
	}
}

func TestHeldSeriesAreReleasedWithTheirOwnTimestamps(t *testing.T) {
	start := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	now := start
	maps := &fakeMaps{}
	c := newCollector(maps, &now)
	_, _ = c.Collect() // no map yet: held

	maps.m = truthMap(t) // the cluster-agent answers 15 s later
	now = start.Add(15 * time.Second)
	out, _ := c.Collect()
	cpu := byName(out, "watchlog_container_cpu_seconds_total")
	old, fresh := 0, 0
	for _, s := range cpu {
		switch s.TimestampMs {
		case start.UnixMilli():
			old++
		case 0:
			fresh++
		}
	}
	if old == 0 || old != fresh {
		t.Errorf("released %d held and %d current samples; want the same, non-zero", old, fresh)
	}
	if u := byName(out, "watchlog_agent_unmapped_containers_total"); u[0].Value != 0 {
		t.Errorf("unmapped = %v", u[0].Value)
	}
}

// Measured on kind: without hostPID the agent cannot see other pods' PIDs, so the
// fixture is read without /proc here; sandboxes must still never count as unmapped.
func TestSandboxesWithoutProcessInfoAreNotUnmapped(t *testing.T) {
	start := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	now := start
	dir := filepath.Join(layout, node)
	c := New(containers.NewReader(t.TempDir(), filepath.Join(dir, "sys")), &fakeMaps{m: truthMap(t)},
		fileSummary{filepath.Join(dir, "summary.json")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.now = func() time.Time { return now }
	for i := 0; i <= 6; i++ { // 90 s of scrapes
		out, _ := c.Collect()
		if u := byName(out, "watchlog_agent_unmapped_containers_total"); u[0].Value != 0 {
			t.Fatalf("scrape %d: %v unmapped; sandboxes were counted", i, u[0].Value)
		}
		if i == 6 && len(byName(out, "watchlog_container_cpu_seconds_total")) < 5 {
			t.Error("real containers lost")
		}
		now = now.Add(15 * time.Second)
	}
	if len(c.sandboxes) == 0 || len(c.held) != 0 {
		t.Errorf("sandboxes=%d held=%d", len(c.sandboxes), len(c.held))
	}
}

// vanishing hides container cgroups, as when a container exits and its cgroup goes.
type vanishing struct {
	Cgroups
	gone map[string]bool
}

func (v vanishing) PodContainers() ([]containers.PodContainer, []string, error) {
	found, unrecognized, err := v.Cgroups.PodContainers()
	out := found[:0:0]
	for _, pc := range found {
		if !v.gone[pc.ContainerID] {
			out = append(out, pc)
		}
	}
	return out, unrecognized, err
}

// Measured on kind: an OOM-killed container in a crash loop lives a few seconds, and
// its cgroup is gone before the pod map lists its ID (as the last-terminated
// container). Its held samples must still be released once the map names it.
func TestShortLivedContainersAreNamedAfterTheyExit(t *testing.T) {
	start := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	for _, named := range []bool{true, false} {
		now := start
		full := truthMap(t)
		// The map before the cluster-agent saw the new container: one ID missing.
		dir := filepath.Join(layout, node)
		reader := containers.NewReader(filepath.Join(dir, "proc"), filepath.Join(dir, "sys"))
		live, _, err := reader.PodContainers()
		if err != nil {
			t.Fatal(err)
		}
		alive := map[string]bool{}
		for _, pc := range live {
			if !pc.Sandbox {
				alive[pc.ContainerID] = true
			}
		}
		var podIdx int
		var id, name string
		for i, p := range full.Pods {
			for cid, n := range p.Containers {
				if p.Namespace == "wl-test" && alive[cid] && id == "" {
					podIdx, id, name = i, cid, n
				}
			}
		}
		if id == "" {
			t.Fatal("no wl-test container in the fixture")
		}
		early := &podmap.Map{Node: full.Node}
		for i, p := range full.Pods {
			cp := p
			if i == podIdx {
				cp.Containers = map[string]string{}
				for k, v := range p.Containers {
					if k != id {
						cp.Containers[k] = v
					}
				}
			}
			early.Pods = append(early.Pods, cp)
		}
		maps := &fakeMaps{m: early}
		cg := vanishing{reader, map[string]bool{}}
		c := New(cg, maps, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
		c.now = func() time.Time { return now }

		_, _ = c.Collect()
		if c.held["c:"+id] == nil {
			t.Fatal("the new container is not held")
		}
		cg.gone[id] = true // it exits
		if named {
			maps.m = full // the map now lists it
		}
		now = now.Add(15 * time.Second)
		out, _ := c.Collect()
		var released []metrics.Sample
		for _, s := range byName(out, "watchlog_container_memory_working_set_bytes") {
			if label(s, "container") == name && s.TimestampMs == start.UnixMilli() {
				released = append(released, s)
			}
		}
		if named && len(released) != 1 {
			t.Errorf("released %d samples of the exited container, want 1", len(released))
		}
		if !named && (len(released) != 0 || c.held["c:"+id] == nil) {
			t.Errorf("unnamed exited container: released %d, held %v", len(released), c.held["c:"+id] != nil)
		}
		now = now.Add(Hold)
		out, _ = c.Collect()
		want := 0.0
		if !named {
			want = 1
		}
		if u := byName(out, "watchlog_agent_unmapped_containers_total"); u[0].Value != want {
			t.Errorf("named=%v: unmapped = %v, want %v", named, u[0].Value, want)
		}
	}
}

// Measured on kind: kube-proxy crash-looped for longer than Hold, the pod map was
// unreachable and every container was given up on; they must come back once the
// map names them again, not stay dropped for as long as they live.
func TestGivenUpSeriesComeBackWhenTheMapReturns(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	maps := &fakeMaps{}
	c := newCollector(maps, &now)
	_, _ = c.Collect()
	now = now.Add(Hold + 15*time.Second)
	_, _ = c.Collect()
	given := len(c.given)
	if given == 0 {
		t.Fatal("nothing given up on")
	}

	maps.m = truthMap(t)
	now = now.Add(15 * time.Second)
	out, _ := c.Collect()
	want := len(byName(mustCollect(t, truthMap(t)), "watchlog_container_cpu_seconds_total"))
	if got := len(byName(out, "watchlog_container_cpu_seconds_total")); got != want {
		t.Errorf("cpu series after the map returned = %d, want %d", got, want)
	}
	if got := len(byName(out, "watchlog_pod_network_bytes_total")); got == 0 {
		t.Error("pod series did not come back")
	}
	if u := byName(out, "watchlog_agent_unmapped_containers_total"); u[0].Value != float64(given) {
		t.Errorf("unmapped = %v, want %d (counted once, not undone)", u[0].Value, given)
	}
}

func mustCollect(t *testing.T, m *podmap.Map) []metrics.Sample {
	t.Helper()
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	out, err := newCollector(&fakeMaps{m: m}, &now).Collect()
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func BenchmarkCollect(b *testing.B) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	c := newCollector(&fakeMaps{m: truthMap(b)}, &now)
	b.ReportAllocs()
	for b.Loop() {
		if _, err := c.Collect(); err != nil {
			b.Fatal(err)
		}
	}
}
