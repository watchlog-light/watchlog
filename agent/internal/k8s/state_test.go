// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"

	eventsv1 "k8s.io/api/events/v1"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

func labels(s metrics.Sample) map[string]string {
	out := map[string]string{}
	for _, l := range s.Labels {
		out[l.Name] = l.Value
	}
	return out
}

// find returns the value of the first sample named name whose labels include want.
func find(t *testing.T, samples []metrics.Sample, name string, want map[string]string) (float64, bool) {
	t.Helper()
	for _, s := range samples {
		if s.Name != name {
			continue
		}
		l, ok := labels(s), true
		for k, v := range want {
			ok = ok && l[k] == v
		}
		if ok {
			return s.Value, true
		}
	}
	return 0, false
}

func TestStateMetrics(t *testing.T) {
	c, _ := startCluster(t)
	sources := c.StateSources()
	names := []string{}
	var all []metrics.Sample
	for _, s := range sources {
		names = append(names, s.Name)
		got, err := s.Collect()
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, got...)
	}
	if strings.Join(names, ",") != "kube_nodes,kube_workloads,kube_pods,kube_containers" {
		t.Errorf("priority order = %v", names)
	}
	oom := map[string]string{"namespace": "wl-test", "pod": "oom", "container": "main"}
	checks := []struct {
		name string
		lbl  map[string]string
		want float64
	}{
		{"watchlog_kube_pod_container_last_termination_reason", merge(oom, "reason", "OOMKilled"), 1},
		{"watchlog_kube_pod_container_last_termination_exit_code", oom, 137},
		{"watchlog_kube_pod_container_status_waiting_reason", merge(oom, "reason", "CrashLoopBackOff"), 1},
		{"watchlog_kube_pod_container_status_waiting_reason", map[string]string{"pod": "crashloop", "reason": "CrashLoopBackOff"}, 1},
		{"watchlog_kube_deployment_replicas", map[string]string{"namespace": "wl-test", "workload": "web", "state": "desired"}, 2},
		{"watchlog_kube_statefulset_replicas", map[string]string{"workload": "db", "state": "ready"}, 1},
		{"watchlog_kube_node_condition", map[string]string{"node": "watchlog-worker", "condition": "Ready", "status": "true"}, 1},
		{"watchlog_kube_pod_status_phase", map[string]string{"pod": "guaranteed", "phase": "Running", "workload_kind": "Pod"}, 1},
		{"watchlog_kube_hpa_replicas", map[string]string{"workload_kind": "Deployment", "workload": "web", "state": "max"}, 4},
	}
	for _, c := range checks {
		if v, ok := find(t, all, c.name, c.lbl); !ok || v != c.want {
			t.Errorf("%s%v = %v (found %v), want %v", c.name, c.lbl, v, ok, c.want)
		}
	}
	if v, ok := find(t, all, "watchlog_kube_node_status_allocatable", map[string]string{"node": "watchlog-worker", "resource": "cpu"}); !ok || v <= 0 {
		t.Errorf("node allocatable cpu = %v, %v", v, ok)
	}
	if _, ok := find(t, all, "watchlog_kube_pod_info", map[string]string{"workload_kind": "Deployment", "workload": "web", "qos_class": "burstable"}); !ok {
		t.Error("no pod_info for the web Deployment's pods")
	}
	for _, s := range all {
		for _, l := range s.Labels {
			switch l.Name { // SPEC §6.3 cardinality rules
			case "uid", "pod_uid", "container_id", "ip", "pod_ip", "host_ip", "image":
				t.Fatalf("%s has a forbidden label %s", s.Name, l.Name)
			}
		}
	}
	t.Logf("%d state series for %d pods", len(all), len(c.Store("Pod").List()))
}

func merge(m map[string]string, kv ...string) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		out[k] = v
	}
	for i := 0; i+1 < len(kv); i += 2 {
		out[kv[i]] = kv[i+1]
	}
	return out
}

func TestEventRecordsAndShipping(t *testing.T) {
	c, _ := startCluster(t)
	var backoff *eventsv1.Event
	for _, obj := range c.Store("Event").List() {
		if e := obj.(*eventsv1.Event); e.Reason == "BackOff" && e.Regarding.Name == "crashloop" {
			backoff = e
		}
	}
	if backoff == nil {
		t.Fatal("no BackOff event for crashloop in the fixture")
	}
	r := ToEventRecord(backoff)
	if r.Count != backoff.DeprecatedCount || r.Count < 2 || r.Type != "Warning" || r.Involved.Kind != "Pod" ||
		r.Involved.UID == "" || !r.LastTS.After(r.FirstTS) || r.ReportingController != "kubelet" {
		t.Errorf("record = %+v", r)
	}

	var bodies [][]EventRecord
	fail := true
	s, err := NewEventShipper(c, func(_ context.Context, b []byte) (sender.Outcome, int) {
		if fail {
			return sender.Retry, 503
		}
		var body struct{ Events []EventRecord }
		_ = json.Unmarshal(b, &body)
		bodies = append(bodies, body.Events)
		return sender.Delivered, 204
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	// The handler sees the events listed at start (the informer replays them); wait for
	// all of them, or the flush below can run mid-replay (seen in CI: 31 of 41).
	want := len(c.Store("Event").List())
	waitFor(t, "initial events", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.pending) == want })
	if err := s.Flush(context.Background()); err == nil {
		t.Fatal("flush succeeded while the backend was down")
	}
	fail = false
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(bodies) != 1 || len(bodies[0]) != len(c.Store("Event").List()) {
		t.Fatalf("sent %d bodies, first with %d events; cache holds %d", len(bodies), len(bodies[0]), len(c.Store("Event").List()))
	}
	for i := 1; i < len(bodies[0]); i++ {
		if bodies[0][i].LastTS.Before(bodies[0][i-1].LastTS) {
			t.Fatal("events not sent oldest first")
		}
	}
}
