// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"encoding/json"
	"fmt"
	"runtime"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/cache"
)

// TestMemoryAt15kPods measures the retained heap of trimmed informer caches at the
// ADR-058 scale: 500 nodes, 1,500 Deployments with 3 ReplicaSets each (history),
// 15,000 pods — cloned from real kind objects. Run with -run Memory -v.
func TestMemoryAt15kPods(t *testing.T) {
	if testing.Short() {
		t.Skip("scale test")
	}
	const nodes, deployments, podsPerDeployment, rsPerDeployment = 500, 1500, 10, 3
	var podTpl *corev1.Pod
	for _, p := range loadList[corev1.Pod](t, "pods.json") {
		if strings.HasPrefix(p.Name, "web-") {
			podTpl = p.DeepCopy()
			break
		}
	}
	nodeTpl := loadList[corev1.Node](t, "nodes.json")[1]
	rsTpl := loadList[appsv1.ReplicaSet](t, "replicasets.json")[0]
	depTpl := loadList[appsv1.Deployment](t, "deployments.json")[0]

	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)

	stores := map[string]cache.Store{}
	for _, k := range []string{"Node", "Pod", "ReplicaSet", "Deployment"} {
		stores[k] = cache.NewStore(cache.MetaNamespaceKeyFunc)
	}
	add := func(kind string, obj any) {
		trimmed, _ := Transform(obj)
		_ = stores[kind].Add(trimmed)
	}
	uid := func(kind string, i int) types.UID {
		return types.UID(fmt.Sprintf("%s-%08d-0000-0000-0000-000000000000", kind[:4], i))
	}
	for i := range nodes {
		n := nodeTpl.DeepCopy()
		n.Name, n.UID = fmt.Sprintf("node-%03d", i), uid("node", i)
		add("Node", n)
	}
	for d := range deployments {
		dep := depTpl.DeepCopy()
		dep.Name, dep.Namespace, dep.UID = fmt.Sprintf("app-%04d", d), fmt.Sprintf("ns-%02d", d%50), uid("depl", d)
		add("Deployment", dep)
		for r := range rsPerDeployment {
			rs := rsTpl.DeepCopy()
			rs.Name, rs.Namespace, rs.UID = fmt.Sprintf("%s-%d", dep.Name, r), dep.Namespace, uid("rset", d*10+r)
			add("ReplicaSet", rs)
		}
		for p := range podsPerDeployment {
			pod := podTpl.DeepCopy()
			pod.Name, pod.Namespace = fmt.Sprintf("%s-%05d", dep.Name, p), dep.Namespace
			pod.UID = uid("pods", d*podsPerDeployment+p)
			pod.Spec.NodeName = fmt.Sprintf("node-%03d", (d*podsPerDeployment+p)%nodes)
			add("Pod", pod)
		}
	}
	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	heap := float64(after.HeapAlloc-before.HeapAlloc) / (1 << 20)
	pods := len(stores["Pod"].List())

	snapshot := 0
	for _, obj := range stores["Pod"].List() {
		r, _ := ToRecord(obj, ownersFunc(func(string, string, string) (Workload, bool) { return Workload{"Deployment", "x"}, true }))
		b, _ := json.Marshal(r)
		snapshot += len(b)
	}
	t.Logf("%d nodes, %d pods, %d ReplicaSets: trimmed caches %.0f MiB (%.1f KiB per pod incl. its share); pod snapshot %.1f MiB JSON in %d chunks",
		nodes, pods, len(stores["ReplicaSet"].List()), heap, heap*1024/float64(pods), float64(snapshot)/(1<<20), (pods+ChunkSize-1)/ChunkSize)
	if heap > 250 {
		t.Errorf("trimmed caches use %.0f MiB, above the 250 MiB estimate (ADR-058)", heap)
	}
}

type ownersFunc func(kind, namespace, name string) (Workload, bool)

func (f ownersFunc) Owner(kind, namespace, name string) (Workload, bool) {
	return f(kind, namespace, name)
}
