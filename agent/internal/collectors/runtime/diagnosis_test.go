// SPDX-License-Identifier: AGPL-3.0-only

package runtime

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/collectors/containers"
	"github.com/watchlog-light/watchlog/agent/internal/docker"
)

// diagDocker serves the diagnosis fixtures: fx-unhealthy (failing HTTP check with a
// credential in the command), fx-exited (exit 1), fx-oom (OOM killed, 137) and
// fx-crashloop (restarting), captured on the Lima VM. fx-oom was re-created after the
// list was captured; its ID in containers.json was updated to match the inspect file.
type diagDocker struct {
	byID     map[string]string
	inspects int
}

func (d *diagDocker) load(name string, into any) error {
	b, err := os.ReadFile(filepath.Join(apiFixtures, "diagnosis", name))
	if err != nil {
		return err
	}
	return json.Unmarshal(b, into)
}

func (d *diagDocker) Negotiate(context.Context) (docker.Version, error) {
	return docker.Version{Version: "29.9.2"}, nil
}

func (d *diagDocker) ListContainers(context.Context, bool) ([]docker.ContainerSummary, error) {
	var out []docker.ContainerSummary
	err := d.load("containers.json", &out)
	d.byID = map[string]string{}
	for _, s := range out {
		d.byID[s.ID] = s.Name()
	}
	return out, err
}

func (d *diagDocker) Inspect(_ context.Context, id string) (docker.ContainerState, error) {
	d.inspects++
	var st docker.ContainerState
	return st, d.load("inspect-"+d.byID[id]+".json", &st)
}

func (d *diagDocker) Events(context.Context, time.Time, func(docker.Event)) error { return nil }

type noCgroups struct{}

func (noCgroups) Container(string) (containers.Stats, error) {
	return containers.Stats{}, containers.ErrNotFound
}
func (noCgroups) Network(int) (float64, float64, error) { return 0, 0, nil }

func newDiagCollector() (*Collector, *diagDocker) {
	d := &diagDocker{}
	c := New(d, noCgroups{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return c, d
}

func byName(inv Inventory) map[string]ContainerObject {
	out := map[string]ContainerObject{}
	for _, o := range inv.Containers {
		out[o.Name] = o
	}
	return out
}

func TestInventoryExplainsBadStates(t *testing.T) {
	c, _ := newDiagCollector()
	_, _ = c.Collect()
	inv, _ := c.Inventory()
	objs := byName(inv)

	u := objs["fx-unhealthy"].HealthDetail
	if u == nil || u.Status != "unhealthy" || u.FailingStreak != 3 || len(u.Probes) != 3 {
		t.Fatalf("health detail = %+v", u)
	}
	if p := u.Probes[2]; p.ExitCode != 1 || p.Output != "wget: can't connect to remote host (127.0.0.1): Connection refused" {
		t.Errorf("last probe = %+v", p)
	}
	want := `wget -qO- --header 'Authorization: Bearer ***' http://admin:***@127.0.0.1:9/health || exit 1`
	if ch := u.Check; ch == nil || ch.Command != want || !ch.Shell || ch.IntervalS != 5 || ch.TimeoutS != 3 ||
		ch.StartPeriodS != 2 || ch.Retries != 3 {
		t.Errorf("check = %+v", ch)
	}

	if o := objs["fx-oom"]; !o.OOMKilled || o.ExitCode != 137 || o.FinishedAt == "" || o.HealthDetail != nil {
		t.Errorf("fx-oom = %+v", o)
	}
	if e := objs["fx-exited"]; e.ExitCode != 1 || e.FinishedAt == "" || e.State != "exited" {
		t.Errorf("fx-exited = %+v", e)
	}
	if r := objs["fx-crashloop"]; !r.Restarting || r.RestartCount != 4 || r.ExitCode != 2 {
		t.Errorf("fx-crashloop = %+v", r)
	}

	b, _ := json.Marshal(inv)
	for _, secret := range []string{"s3cret", "fixture-token-123", "PATH=", "REDACTED"} {
		if strings.Contains(string(b), secret) {
			t.Errorf("inventory leaks %q", secret)
		}
	}
}

func TestHealthOutputOff(t *testing.T) {
	c, _ := newDiagCollector()
	c.HealthOutput = false
	_, _ = c.Collect()
	inv, _ := c.Inventory()
	u := byName(inv)["fx-unhealthy"].HealthDetail
	for _, p := range u.Probes {
		if p.Output != "" || p.ExitCode != 1 {
			t.Errorf("probe = %+v, want exit code only", p)
		}
	}
	b, _ := json.Marshal(inv)
	if strings.Contains(string(b), "Connection refused") || strings.Contains(string(b), `"output"`) {
		t.Error("probe output sent although WATCHLOG_HEALTH_OUTPUT=false")
	}
}

func TestEventsTriggerAnImmediateDelta(t *testing.T) {
	c, d := newDiagCollector()
	_, _ = c.Collect()
	var unhealthyID string
	for id, name := range d.byID {
		if name == "fx-unhealthy" {
			unhealthyID = id
		}
	}

	if inv, err := c.Delta(context.Background()); inv != nil || err != nil {
		t.Fatalf("delta without events = %+v, %v", inv, err)
	}
	ev := docker.Event{Type: "container", Action: "start"}
	ev.Actor.ID = unhealthyID
	c.handleEvent(ev) // start alone waits for the next scrape
	select {
	case <-c.Changes():
		t.Fatal("start must not trigger a delta")
	default:
	}

	ev.Action = "health_status: unhealthy"
	c.handleEvent(ev)
	c.handleEvent(ev) // coalesced
	select {
	case <-c.Changes():
	default:
		t.Fatal("health_status did not signal a change")
	}
	before := d.inspects
	inv, err := c.Delta(context.Background())
	if err != nil || inv == nil || len(inv.Containers) != 1 || inv.Containers[0].Name != "fx-unhealthy" ||
		inv.Containers[0].HealthDetail == nil || inv.Host.DockerVersion != "29.9.2" {
		t.Fatalf("delta = %+v, %v", inv, err)
	}
	if d.inspects != before+1 {
		t.Errorf("delta inspected %d containers, want 1", d.inspects-before)
	}
	if again, _ := c.Delta(context.Background()); again != nil {
		t.Errorf("second delta = %+v, want nil", again)
	}
}

// BenchmarkCollectWithHealth measures a scrape that re-inspects all four diagnosis
// containers and builds their health details (redaction included).
func BenchmarkCollectWithHealth(b *testing.B) {
	c, _ := newDiagCollector()
	b.ReportAllocs()
	for b.Loop() {
		c.states = map[string]*inspected{} // force re-inspection every round
		_, _ = c.Collect()
	}
}
