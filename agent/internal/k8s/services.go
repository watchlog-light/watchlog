// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"fmt"
	"sort"
	"time"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"

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
		ws, _ := c.ServiceBackends(s.Namespace, s.Name)
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

// ipMapTTL bounds how often the map is rebuilt for many node agents asking.
const ipMapTTL = 5 * time.Second
