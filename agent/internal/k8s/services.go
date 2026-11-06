// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"fmt"
	"sort"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	klabels "k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/tools/cache"

	"github.com/watchlog-light/watchlog/agent/internal/podmap"
)

// byService indexes EndpointSlices by "<namespace>/<service>".
const byService = "service"

func sliceService(obj any) ([]string, error) {
	es, ok := obj.(*discoveryv1.EndpointSlice)
	if !ok {
		return nil, nil
	}
	name := es.Labels[discoveryv1.LabelServiceName]
	if name == "" {
		return nil, nil
	}
	return []string{es.Namespace + "/" + name}, nil
}

// ServiceBackends are the workloads behind a Service's ready endpoints and how many
// ready endpoints it has (from its EndpointSlices).
func (c *Cluster) ServiceBackends(namespace, name string) ([]Workload, int) {
	inf, ok := c.informers["EndpointSlice"]
	if !ok {
		return nil, 0
	}
	slices, _ := inf.GetIndexer().ByIndex(byService, namespace+"/"+name)
	seen := map[Workload]bool{}
	ready := 0
	for _, obj := range slices {
		for _, e := range obj.(*discoveryv1.EndpointSlice).Endpoints {
			if e.Conditions.Ready != nil && !*e.Conditions.Ready {
				continue
			}
			ready++
			if e.TargetRef == nil || e.TargetRef.Kind != "Pod" {
				continue
			}
			if p, ok := c.pod(e.TargetRef.Namespace, e.TargetRef.Name); ok {
				seen[PodWorkload(p, c)] = true
			}
		}
	}
	out := make([]Workload, 0, len(seen))
	for w := range seen {
		out = append(out, w)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Kind+out[i].Name < out[j].Kind+out[j].Name })
	return out, ready
}

func (c *Cluster) pod(namespace, name string) (*corev1.Pod, bool) {
	obj, ok, _ := c.Store("Pod").GetByKey(namespace + "/" + name)
	if !ok {
		return nil, false
	}
	return obj.(*corev1.Pod), true
}

// IPMap builds the cluster-wide address map node agents resolve flow destinations
// with (ADR-101): pod IPs (hostNetwork pods share their node's IP and are left out),
// Service cluster IPs with the workloads behind them, and node IPs.
func (c *Cluster) IPMap() podmap.IPMap {
	m := podmap.IPMap{Pods: []podmap.IPPod{}, Services: []podmap.IPService{}, Nodes: []podmap.IPNode{}}
	for _, obj := range c.Store("Pod").List() {
		p := obj.(*corev1.Pod)
		if p.Spec.HostNetwork || p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed {
			continue
		}
		ips := map[string]bool{}
		if p.Status.PodIP != "" {
			ips[p.Status.PodIP] = true
		}
		for _, ip := range p.Status.PodIPs {
			ips[ip.IP] = true
		}
		w := PodWorkload(p, c)
		for ip := range ips {
			m.Pods = append(m.Pods, podmap.IPPod{IP: ip, Namespace: p.Namespace, Pod: p.Name,
				WorkloadKind: w.Kind, Workload: w.Name})
		}
	}
	for _, obj := range c.Store("Service").List() {
		s := obj.(*corev1.Service)
		ips := s.Spec.ClusterIPs
		if len(ips) == 0 && s.Spec.ClusterIP != "" {
			ips = []string{s.Spec.ClusterIP}
		}
		var cluster []string
		for _, ip := range ips {
			if ip != "" && ip != corev1.ClusterIPNone {
				cluster = append(cluster, ip)
			}
		}
		if len(cluster) == 0 {
			continue // headless: clients connect to pod IPs, resolved as pods
		}
		ws := c.serviceWorkloads(s)
		svc := podmap.IPService{IPs: cluster, Namespace: s.Namespace, Name: s.Name, Workloads: []podmap.Workload{}}
		for _, w := range ws {
			svc.Workloads = append(svc.Workloads, podmap.Workload{Kind: w.Kind, Name: w.Name})
		}
		m.Services = append(m.Services, svc)
	}
	for _, obj := range c.Store("Node").List() {
		n := obj.(*corev1.Node)
		for _, a := range n.Status.Addresses {
			if a.Type == corev1.NodeInternalIP || a.Type == corev1.NodeExternalIP {
				m.Nodes = append(m.Nodes, podmap.IPNode{IP: a.Address, Name: n.Name})
			}
		}
	}
	sort.Slice(m.Pods, func(i, j int) bool { return m.Pods[i].IP < m.Pods[j].IP })
	sort.Slice(m.Services, func(i, j int) bool {
		return fmt.Sprint(m.Services[i].IPs) < fmt.Sprint(m.Services[j].IPs)
	})
	sort.Slice(m.Nodes, func(i, j int) bool { return m.Nodes[i].IP < m.Nodes[j].IP })
	return m
}

// serviceWorkloads names the workloads behind a Service for the IP map, so a flow to its
// ClusterIP is drawn to the right workload from the first connection (ADR-116). Readiness
// does not change which workload a Service fronts, so it uses, in order:
//   - every endpoint, ready or not;
//   - else the pods its selector matches (pods without an IP yet, or no slice yet);
//   - else the Deployments, StatefulSets and DaemonSets whose pod template it matches
//     (scaled to 0: a dependency that is down is still that workload, failing).
func (c *Cluster) serviceWorkloads(s *corev1.Service) []Workload {
	seen := map[Workload]bool{}
	if inf, ok := c.informers["EndpointSlice"]; ok {
		slices, _ := inf.GetIndexer().ByIndex(byService, s.Namespace+"/"+s.Name)
		for _, obj := range slices {
			for _, e := range obj.(*discoveryv1.EndpointSlice).Endpoints {
				if e.TargetRef == nil || e.TargetRef.Kind != "Pod" {
					continue
				}
				if p, ok := c.pod(e.TargetRef.Namespace, e.TargetRef.Name); ok {
					seen[PodWorkload(p, c)] = true
				}
			}
		}
	}
	if len(seen) == 0 && len(s.Spec.Selector) > 0 {
		sel := klabels.SelectorFromSet(s.Spec.Selector)
		for _, obj := range c.inNamespace("Pod", s.Namespace) {
			p := obj.(*corev1.Pod)
			if p.Status.Phase != corev1.PodSucceeded && p.Status.Phase != corev1.PodFailed && sel.Matches(klabels.Set(p.Labels)) {
				seen[PodWorkload(p, c)] = true
			}
		}
		if len(seen) == 0 {
			for _, kind := range []string{"Deployment", "StatefulSet", "DaemonSet"} {
				for _, obj := range c.inNamespace(kind, s.Namespace) {
					if name, tmpl := templateLabels(obj); name != "" && sel.Matches(klabels.Set(tmpl)) {
						seen[Workload{Kind: kind, Name: name}] = true
					}
				}
			}
		}
	}
	out := make([]Workload, 0, len(seen))
	for w := range seen {
		out = append(out, w)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Kind+out[i].Name < out[j].Kind+out[j].Name })
	return out
}

// inNamespace lists one kind's objects in a namespace (the informers' namespace index).
func (c *Cluster) inNamespace(kind, namespace string) []any {
	inf, ok := c.informers[kind]
	if !ok {
		return nil
	}
	objs, err := inf.GetIndexer().ByIndex(cache.NamespaceIndex, namespace)
	if err != nil {
		return nil
	}
	return objs
}

func templateLabels(obj any) (string, map[string]string) {
	switch o := obj.(type) {
	case *appsv1.Deployment:
		return o.Name, o.Spec.Template.Labels
	case *appsv1.StatefulSet:
		return o.Name, o.Spec.Template.Labels
	case *appsv1.DaemonSet:
		return o.Name, o.Spec.Template.Labels
	}
	return "", nil
}

// ipMapTTL bounds how often the map is rebuilt for many node agents asking.
const ipMapTTL = 5 * time.Second
