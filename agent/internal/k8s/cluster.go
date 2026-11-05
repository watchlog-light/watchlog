// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"sort"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
)

// SentKinds are the kinds sent to the backend (ADR-052), in snapshot order.
var SentKinds = []string{"Namespace", "Node", "Pod", "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob",
	"HorizontalPodAutoscaler", "PersistentVolumeClaim", "Service"}

// Cluster holds the cluster-agent's informers (ADR-052), each trimmed by Transform.
type Cluster struct {
	factory   informers.SharedInformerFactory
	informers map[string]cache.SharedIndexInformer
}

// NewCluster creates the informers; call Start to run them. withEvents adds the
// events.k8s.io/v1 informer (slice 3).
func NewCluster(cs kubernetes.Interface, resync time.Duration, withEvents bool) (*Cluster, error) {
	f := informers.NewSharedInformerFactory(cs, resync)
	c := &Cluster{factory: f, informers: map[string]cache.SharedIndexInformer{
		"Namespace":               f.Core().V1().Namespaces().Informer(),
		"Node":                    f.Core().V1().Nodes().Informer(),
		"Pod":                     f.Core().V1().Pods().Informer(),
		"PersistentVolumeClaim":   f.Core().V1().PersistentVolumeClaims().Informer(),
		"Deployment":              f.Apps().V1().Deployments().Informer(),
		"ReplicaSet":              f.Apps().V1().ReplicaSets().Informer(),
		"StatefulSet":             f.Apps().V1().StatefulSets().Informer(),
		"DaemonSet":               f.Apps().V1().DaemonSets().Informer(),
		"Job":                     f.Batch().V1().Jobs().Informer(),
		"CronJob":                 f.Batch().V1().CronJobs().Informer(),
		"HorizontalPodAutoscaler": f.Autoscaling().V2().HorizontalPodAutoscalers().Informer(),
		// Service map (Phase 4, ADR-101): Services and the EndpointSlices behind them.
		"Service":       f.Core().V1().Services().Informer(),
		"EndpointSlice": f.Discovery().V1().EndpointSlices().Informer(),
	}}
	if err := c.informers["EndpointSlice"].AddIndexers(cache.Indexers{byService: sliceService}); err != nil {
		return nil, err
	}
	if withEvents {
		c.informers["Event"] = f.Events().V1().Events().Informer()
	}
	for _, inf := range c.informers {
		if err := inf.SetTransform(Transform); err != nil {
			return nil, err
		}
	}
	return c, nil
}

// Start runs the informers until ctx ends and waits for their caches to fill.
func (c *Cluster) Start(ctx context.Context) bool {
	c.factory.Start(ctx.Done())
	for _, ok := range c.factory.WaitForCacheSync(ctx.Done()) {
		if !ok {
			return false
		}
	}
	return true
}

// Store returns the cache of one kind (nil if not watched).
func (c *Cluster) Store(kind string) cache.Store {
	if inf, ok := c.informers[kind]; ok {
		return inf.GetStore()
	}
	return nil
}

// AddHandler registers change notifications for one kind.
func (c *Cluster) AddHandler(kind string, h cache.ResourceEventHandler) error {
	_, err := c.informers[kind].AddEventHandler(h)
	return err
}

// Owner implements Owners from the ReplicaSet and Job caches.
func (c *Cluster) Owner(kind, namespace, name string) (Workload, bool) {
	obj, ok, err := c.Store(kind).GetByKey(namespace + "/" + name)
	if err != nil || !ok {
		return Workload{}, false
	}
	var ref *metav1.OwnerReference
	switch o := obj.(type) {
	case *appsv1.ReplicaSet:
		ref = metav1.GetControllerOfNoCopy(o)
	case *batchv1.Job:
		ref = metav1.GetControllerOfNoCopy(o)
	}
	if ref != nil && (ref.Kind == "Deployment" || ref.Kind == "CronJob") {
		return Workload{Kind: ref.Kind, Name: ref.Name}, true
	}
	return Workload{Kind: kind, Name: name}, true
}

// Records summarises every cached object of a kind, sorted by namespace and name.
func (c *Cluster) Records(kind string) []Record {
	items := c.Store(kind).List()
	out := make([]Record, 0, len(items))
	for _, obj := range items {
		if r, ok := ToRecord(obj, c); ok {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Namespace != out[j].Namespace {
			return out[i].Namespace < out[j].Namespace
		}
		return out[i].Name < out[j].Name
	})
	return out
}
