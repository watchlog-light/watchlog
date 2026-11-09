// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	eventsv1 "k8s.io/api/events/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

// Fixtures: testdata/kind/*.json are `kubectl get -A -o json` lists captured from the
// kind test cluster with deploy/test/k8s/capture-objects.sh (workloads.yaml applied).
const fixtures = "testdata/kind"

func loadList[T any](t testing.TB, file string) []T {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixtures, file))
	if err != nil {
		t.Fatal(err)
	}
	var list struct{ Items []T }
	if err := json.Unmarshal(b, &list); err != nil {
		t.Fatal(err)
	}
	return list.Items
}

func ptrs[T any](items []T) []runtime.Object {
	out := make([]runtime.Object, 0, len(items))
	for i := range items {
		if o, ok := any(&items[i]).(runtime.Object); ok {
			out = append(out, o)
		}
	}
	return out
}

func fixtureObjects(t testing.TB) []runtime.Object {
	var objs []runtime.Object
	objs = append(objs, ptrs(loadList[corev1.Node](t, "nodes.json"))...)
	objs = append(objs, ptrs(loadList[corev1.Namespace](t, "namespaces.json"))...)
	objs = append(objs, ptrs(loadList[corev1.Pod](t, "pods.json"))...)
	objs = append(objs, ptrs(loadList[corev1.PersistentVolumeClaim](t, "persistentvolumeclaims.json"))...)
	objs = append(objs, ptrs(loadList[appsv1.Deployment](t, "deployments.json"))...)
	objs = append(objs, ptrs(loadList[appsv1.ReplicaSet](t, "replicasets.json"))...)
	objs = append(objs, ptrs(loadList[appsv1.StatefulSet](t, "statefulsets.json"))...)
	objs = append(objs, ptrs(loadList[appsv1.DaemonSet](t, "daemonsets.json"))...)
	objs = append(objs, ptrs(loadList[batchv1.Job](t, "jobs.json"))...)
	objs = append(objs, ptrs(loadList[batchv1.CronJob](t, "cronjobs.json"))...)
	objs = append(objs, ptrs(loadList[autoscalingv2.HorizontalPodAutoscaler](t, "horizontalpodautoscalers.json"))...)
	objs = append(objs, ptrs(loadList[eventsv1.Event](t, "events.json"))...)
	// Captured later (Phase 4) on the same kind cluster: pod names behind the slices
	// differ from pods.json.
	objs = append(objs, ptrs(loadList[corev1.Service](t, "services.json"))...)
	objs = append(objs, ptrs(loadList[discoveryv1.EndpointSlice](t, "endpointslices.json"))...)
	return objs
}

func startCluster(t *testing.T) (*Cluster, *fake.Clientset) {
	t.Helper()
	cs := fake.NewClientset(fixtureObjects(t)...)
	c, err := NewCluster(cs, 0, true)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if !c.Start(ctx) {
		t.Fatal("caches did not sync")
	}
	return c, cs
}

func record(t *testing.T, c *Cluster, kind, ns, name string) Record {
	t.Helper()
	for _, r := range c.Records(kind) {
		if r.Namespace == ns && r.Name == name {
			return r
		}
	}
	t.Fatalf("no %s %s/%s", kind, ns, name)
	return Record{}
}

func asJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	b, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

func TestTransformDropsSecretsAndBulk(t *testing.T) {
	c, _ := startCluster(t)
	var cached []byte
	for _, kind := range append(SentKinds, "ReplicaSet", "Event") {
		b, _ := json.Marshal(c.Store(kind).List())
		cached = append(cached, b...)
	}
	for _, banned := range []string{`"managedFields"`, `"env"`, `"command"`, `"args"`, "last-applied-configuration",
		`"images"`, `"livenessProbe"`, `"readinessProbe"`} {
		if strings.Contains(string(cached), banned) {
			t.Errorf("informer cache still holds %s", banned)
		}
	}
	// Static pods keep the config hash the node agent sees in cgroup paths (ADR-050).
	found := false
	for _, obj := range c.Store("Pod").List() {
		p := obj.(*corev1.Pod)
		if strings.HasPrefix(p.Name, "kube-apiserver-") && p.Annotations["kubernetes.io/config.mirror"] != "" {
			found = true
		}
	}
	if !found {
		t.Error("static pod lost its kubernetes.io/config.mirror annotation")
	}
}

// The informer keeps the ports a container declares: discovery picks the port to
// connect to from them (ADR-132), e.g. an ingress controller listening on 8080.
func TestTransformKeepsContainerPorts(t *testing.T) {
	pod := &corev1.Pod{Spec: corev1.PodSpec{Containers: []corev1.Container{{
		Name: "controller", Image: "registry.k8s.io/ingress-nginx/controller:v1.12.1",
		Ports: []corev1.ContainerPort{{Name: "http", ContainerPort: 8080, Protocol: corev1.ProtocolTCP}, {Name: "https", ContainerPort: 8443}},
		Env:   []corev1.EnvVar{{Name: "SECRET", Value: "x"}},
	}}}}
	out, err := Transform(pod)
	if err != nil {
		t.Fatal(err)
	}
	c := out.(*corev1.Pod).Spec.Containers[0]
	if len(c.Ports) != 2 || c.Ports[0].ContainerPort != 8080 || c.Ports[0].Name != "http" || c.Ports[1].ContainerPort != 8443 {
		t.Errorf("ports %+v", c.Ports)
	}
	if len(c.Env) != 0 {
		t.Error("env kept")
	}
	rec, ok := toRecord(out, nil)
	if !ok {
		t.Fatal("no record")
	}
	b, _ := json.Marshal(rec.Spec)
	if !strings.Contains(string(b), `"ports":[{"name":"http","port":8080,"protocol":"TCP"},{"name":"https","port":8443}]`) {
		t.Errorf("record spec %s", b)
	}
}

func TestRecordsCarryWhatTheViewsNeed(t *testing.T) {
	c, _ := startCluster(t)

	oom := asJSON(t, record(t, c, "Pod", "wl-test", "oom"))
	main := oom["status"].(map[string]any)["containers"].([]any)[0].(map[string]any)
	if main["state"] != "waiting" || main["reason"] != "CrashLoopBackOff" {
		t.Errorf("oom state = %v", main)
	}
	last := main["last_termination"].(map[string]any)
	if last["reason"] != "OOMKilled" || last["exit_code"] != float64(137) {
		t.Errorf("oom last termination = %v", last)
	}
	limits := oom["spec"].(map[string]any)["containers"].([]any)[0].(map[string]any)["limits"].(map[string]any)
	if limits["memory"] != "32Mi" {
		t.Errorf("oom limits = %v", limits)
	}

	workloads := map[string]Workload{}
	for _, r := range c.Records("Pod") {
		workloads[r.Namespace+"/"+r.Name] = r.Spec.(map[string]any)["workload"].(Workload)
	}
	for pod, want := range map[string]Workload{
		"wl-test/db-0":       {"StatefulSet", "db"},
		"wl-test/guaranteed": {"Pod", "guaranteed"},
	} {
		if workloads[pod] != want {
			t.Errorf("%s workload = %v, want %v", pod, workloads[pod], want)
		}
	}
	kinds := map[string]bool{}
	for pod, w := range workloads {
		switch {
		case strings.HasPrefix(pod, "wl-test/web-"):
			if w != (Workload{"Deployment", "web"}) {
				t.Errorf("%s → %v, want Deployment web (through its ReplicaSet)", pod, w)
			}
		case strings.HasPrefix(pod, "wl-test/every-minute-"):
			if w != (Workload{"CronJob", "every-minute"}) {
				t.Errorf("%s → %v, want CronJob every-minute (through its Job)", pod, w)
			}
		case strings.HasPrefix(pod, "kube-system/etcd-"):
			if w.Kind != "StaticPod" {
				t.Errorf("%s → %v, want a StaticPod", pod, w)
			}
		}
		kinds[w.Kind] = true
	}
	for _, k := range []string{"Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "StaticPod", "Pod"} {
		if !kinds[k] {
			t.Errorf("no pod resolved to workload kind %s", k)
		}
	}

	node := asJSON(t, c.Records("Node")[0])
	if node["status"].(map[string]any)["info"].(map[string]any)["kubelet_version"] != "v1.37.0" {
		t.Errorf("node info = %v", node["status"])
	}
	if pvc := asJSON(t, record(t, c, "PersistentVolumeClaim", "wl-test", "data-db-0")); pvc["status"].(map[string]any)["phase"] != "Bound" {
		t.Errorf("pvc = %v", pvc)
	}
	for _, kind := range SentKinds {
		if len(c.Records(kind)) == 0 {
			t.Errorf("no %s records", kind)
		}
		for _, r := range c.Records(kind) {
			if _, ok := asJSON(t, r)["spec"].(map[string]any)["created_at"].(string); !ok {
				t.Errorf("%s %s/%s: no created_at", kind, r.Namespace, r.Name)
				break
			}
		}
	}
	if _, ok := ToRecord(c.Store("ReplicaSet").List()[0], c); ok {
		t.Error("ReplicaSets must not be sent")
	}
}

type captured struct {
	mu     sync.Mutex
	bodies []objectsBody
	fail   bool
}

func (c *captured) post(_ context.Context, body []byte) (sender.Outcome, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fail {
		return sender.Retry, 503
	}
	var b objectsBody
	if err := json.Unmarshal(body, &b); err != nil {
		panic(err)
	}
	c.bodies = append(c.bodies, b)
	return sender.Delivered, 204
}

func (c *captured) take() []objectsBody {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := c.bodies
	c.bodies = nil
	return out
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSnapshotsAndDeltas(t *testing.T) {
	c, cs := startCluster(t)
	out := &captured{}
	s, err := NewShipper(c, out.post, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	s.ChunkSize = 20
	ctx := context.Background()

	if err := s.Snapshot(ctx); err != nil {
		t.Fatal(err)
	}
	chunks := out.take()
	total := 0
	for i, b := range chunks {
		total += len(b.Objects)
		if b.Kind != "snapshot" || b.Source != "kubernetes" || b.SnapshotID != chunks[0].SnapshotID || len(b.Objects) > 20 {
			t.Errorf("chunk %d: %s/%s id=%s n=%d", i, b.Source, b.Kind, b.SnapshotID, len(b.Objects))
		}
		if final := i == len(chunks)-1; b.Final != final || (final && len(b.Kinds) != len(SentKinds)) {
			t.Errorf("chunk %d: final=%v kinds=%v", i, b.Final, b.Kinds)
		}
	}
	if len(chunks) < 3 || total < 40 { // 46 objects in the kind fixture
		t.Fatalf("snapshot: %d chunks, %d objects", len(chunks), total)
	}

	// Nothing changed: no delta.
	if err := s.Flush(ctx); err != nil || len(out.take()) != 0 {
		t.Fatalf("empty flush sent something (err %v)", err)
	}

	// A status change of one pod is one delta; a delete is one deleted record.
	pod, err := cs.CoreV1().Pods("wl-test").Get(ctx, "guaranteed", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	pod.Status.Phase = corev1.PodFailed
	pod.ResourceVersion = "999999"
	if _, err := cs.CoreV1().Pods("wl-test").UpdateStatus(ctx, pod, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := cs.CoreV1().Pods("wl-test").Delete(ctx, "besteffort", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "informer update", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.pending) > 0 && len(s.deleted) > 0
	})

	out.fail = true // undelivered changes are kept
	if err := s.Flush(ctx); err == nil {
		t.Fatal("flush reported success while the backend was down")
	}
	out.fail = false
	if err := s.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	deltas := out.take()
	if len(deltas) != 1 || deltas[0].Kind != "delta" || deltas[0].SnapshotID != chunks[0].SnapshotID {
		t.Fatalf("deltas = %+v", deltas)
	}
	got := map[string]Record{}
	for _, r := range deltas[0].Objects {
		got[r.Name] = r
	}
	if len(got) != 2 || got["besteffort"].Deleted != true || asJSON(t, got["guaranteed"])["status"].(map[string]any)["phase"] != "Failed" {
		t.Errorf("delta objects = %+v", deltas[0].Objects)
	}
}

func TestGzipBodyFitsTheBackendLimit(t *testing.T) {
	// One full chunk of the largest pod summary must stay far below 16 MiB decoded.
	c, _ := startCluster(t)
	var biggest Record
	size := 0
	for _, r := range c.Records("Pod") {
		if b, _ := json.Marshal(r); len(b) > size {
			biggest, size = r, len(b)
		}
	}
	chunk := make([]Record, ChunkSize)
	for i := range chunk {
		chunk[i] = biggest
	}
	b, _ := json.Marshal(objectsBody{Source: "kubernetes", Kind: "snapshot", Objects: chunk})
	if len(b) > 8<<20 {
		t.Errorf("a %d-pod chunk of the largest pod (%d B) is %d bytes", ChunkSize, size, len(b))
	}
	var gz strings.Builder
	w := gzip.NewWriter(&gz)
	_, _ = w.Write(b)
	_ = w.Close()
	t.Logf("largest pod summary %d B; %d-pod chunk %d KiB, %d KiB gzipped", size, ChunkSize, len(b)>>10, gz.Len()>>10)
}

func TestContainerSpecsKeepDeclaredPorts(t *testing.T) {
	got := containerSpecs([]corev1.Container{{Name: "db", Image: "postgres:16",
		Ports: []corev1.ContainerPort{{Name: "pg", ContainerPort: 5432, Protocol: corev1.ProtocolTCP}, {ContainerPort: 0}}}})
	if len(got) != 1 || len(got[0].Ports) != 1 || got[0].Ports[0] != (containerPort{Name: "pg", Port: 5432, Protocol: "TCP"}) {
		t.Fatalf("specs = %+v", got)
	}
}
