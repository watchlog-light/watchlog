// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
	"github.com/watchlog-light/watchlog/agent/internal/runner"
)

// StateSeriesCap is the cluster-agent's series cap (ADR-056); lower-priority groups
// are dropped first and counted in watchlog_agent_series_dropped_total.
const StateSeriesCap = 150_000

// StateSources returns the kube-state metric groups (ADR-056) in priority order:
// nodes, workloads, pods, containers. Labels are namespace, pod, container, node,
// workload_kind and workload; never UIDs or IPs. Requests and limits are not
// series: they stay on the objects.
func (c *Cluster) StateSources() []runner.Source {
	return []runner.Source{
		{Name: "kube_nodes", Collect: func() ([]metrics.Sample, error) { return c.nodeState(), nil }},
		{Name: "kube_workloads", Collect: func() ([]metrics.Sample, error) { return c.workloadState(), nil }},
		{Name: "kube_pods", Collect: func() ([]metrics.Sample, error) { return c.podState(false), nil }},
		{Name: "kube_containers", Collect: func() ([]metrics.Sample, error) { return c.podState(true), nil }},
	}
}

// Node resources as series: cores, bytes and pod counts.
var nodeResources = map[corev1.ResourceName]string{
	corev1.ResourceCPU: "cpu", corev1.ResourceMemory: "memory", corev1.ResourcePods: "pods",
	corev1.ResourceEphemeralStorage: "ephemeral_storage",
}

func (c *Cluster) nodeState() []metrics.Sample {
	var out []metrics.Sample
	for _, obj := range c.Store("Node").List() {
		n := obj.(*corev1.Node)
		i := n.Status.NodeInfo
		out = append(out, metrics.New("watchlog_kube_node_info", 1, "node", n.Name, "kubelet_version", i.KubeletVersion,
			"kernel_version", i.KernelVersion, "os_image", i.OSImage, "container_runtime", i.ContainerRuntimeVersion))
		unschedulable := 0.0
		if n.Spec.Unschedulable {
			unschedulable = 1
		}
		out = append(out, metrics.New("watchlog_kube_node_unschedulable", unschedulable, "node", n.Name))
		for _, cond := range n.Status.Conditions {
			out = append(out, metrics.New("watchlog_kube_node_condition", 1, "node", n.Name,
				"condition", string(cond.Type), "status", strings.ToLower(string(cond.Status))))
		}
		for res, name := range nodeResources {
			if q, ok := n.Status.Allocatable[res]; ok {
				out = append(out, metrics.New("watchlog_kube_node_status_allocatable", q.AsApproximateFloat64(), "node", n.Name, "resource", name))
			}
			if q, ok := n.Status.Capacity[res]; ok {
				out = append(out, metrics.New("watchlog_kube_node_status_capacity", q.AsApproximateFloat64(), "node", n.Name, "resource", name))
			}
		}
	}
	return out
}

func replicas(p *int32) float64 {
	if p == nil {
		return 1 // the API default
	}
	return float64(*p)
}

func (c *Cluster) workloadState() []metrics.Sample {
	var out []metrics.Sample
	add := func(name string, value float64, ns, workload, state string) {
		out = append(out, metrics.New(name, value, "namespace", ns, "workload", workload, "state", state))
	}
	for _, obj := range c.Store("Deployment").List() {
		d := obj.(*appsv1.Deployment)
		s := d.Status
		for state, v := range map[string]float64{"desired": replicas(d.Spec.Replicas), "ready": float64(s.ReadyReplicas),
			"available": float64(s.AvailableReplicas), "updated": float64(s.UpdatedReplicas), "unavailable": float64(s.UnavailableReplicas)} {
			add("watchlog_kube_deployment_replicas", v, d.Namespace, d.Name, state)
		}
	}
	for _, obj := range c.Store("StatefulSet").List() {
		d := obj.(*appsv1.StatefulSet)
		s := d.Status
		for state, v := range map[string]float64{"desired": replicas(d.Spec.Replicas), "ready": float64(s.ReadyReplicas),
			"available": float64(s.AvailableReplicas), "current": float64(s.CurrentReplicas), "updated": float64(s.UpdatedReplicas)} {
			add("watchlog_kube_statefulset_replicas", v, d.Namespace, d.Name, state)
		}
	}
	for _, obj := range c.Store("DaemonSet").List() {
		d := obj.(*appsv1.DaemonSet)
		s := d.Status
		for state, v := range map[string]float64{"desired": float64(s.DesiredNumberScheduled), "current": float64(s.CurrentNumberScheduled),
			"ready": float64(s.NumberReady), "available": float64(s.NumberAvailable), "updated": float64(s.UpdatedNumberScheduled),
			"misscheduled": float64(s.NumberMisscheduled)} {
			add("watchlog_kube_daemonset_replicas", v, d.Namespace, d.Name, state)
		}
	}
	for _, obj := range c.Store("Job").List() {
		j := obj.(*batchv1.Job)
		for state, v := range map[string]float64{"active": float64(j.Status.Active), "succeeded": float64(j.Status.Succeeded), "failed": float64(j.Status.Failed)} {
			add("watchlog_kube_job_status", v, j.Namespace, j.Name, state)
		}
	}
	for _, obj := range c.Store("HorizontalPodAutoscaler").List() {
		h := obj.(*autoscalingv2.HorizontalPodAutoscaler)
		target := h.Spec.ScaleTargetRef
		for state, v := range map[string]float64{"current": float64(h.Status.CurrentReplicas), "desired": float64(h.Status.DesiredReplicas),
			"min": replicas(h.Spec.MinReplicas), "max": float64(h.Spec.MaxReplicas)} {
			out = append(out, metrics.New("watchlog_kube_hpa_replicas", v, "namespace", h.Namespace,
				"workload_kind", target.Kind, "workload", target.Name, "state", state))
		}
	}
	for _, obj := range c.Store("PersistentVolumeClaim").List() {
		p := obj.(*corev1.PersistentVolumeClaim)
		if q, ok := p.Status.Capacity[corev1.ResourceStorage]; ok {
			out = append(out, metrics.New("watchlog_kube_pvc_capacity_bytes", q.AsApproximateFloat64(),
				"namespace", p.Namespace, "persistentvolumeclaim", p.Name))
		}
	}
	return out
}

// podState emits pod-level series, or with containers=true the per-container ones.
func (c *Cluster) podState(containers bool) []metrics.Sample {
	var out []metrics.Sample
	for _, obj := range c.Store("Pod").List() {
		p := obj.(*corev1.Pod)
		w := PodWorkload(p, c)
		if !containers {
			out = append(out,
				metrics.New("watchlog_kube_pod_info", 1, "namespace", p.Namespace, "pod", p.Name, "node", p.Spec.NodeName,
					"workload_kind", w.Kind, "workload", w.Name, "qos_class", strings.ToLower(string(p.Status.QOSClass))),
				metrics.New("watchlog_kube_pod_status_phase", 1, "namespace", p.Namespace, "pod", p.Name,
					"workload_kind", w.Kind, "workload", w.Name, "phase", string(p.Status.Phase)))
			continue
		}
		for _, s := range p.Status.ContainerStatuses {
			l := []string{"namespace", p.Namespace, "pod", p.Name, "container", s.Name, "workload_kind", w.Kind, "workload", w.Name}
			out = append(out, metrics.New("watchlog_kube_pod_container_restarts_total", float64(s.RestartCount), l...))
			if wt := s.State.Waiting; wt != nil && wt.Reason != "" {
				out = append(out, metrics.New("watchlog_kube_pod_container_status_waiting_reason", 1, append(l, "reason", wt.Reason)...))
			}
			if t := s.LastTerminationState.Terminated; t != nil {
				out = append(out,
					metrics.New("watchlog_kube_pod_container_last_termination_reason", 1, append(l, "reason", t.Reason)...),
					metrics.New("watchlog_kube_pod_container_last_termination_exit_code", float64(t.ExitCode), l...))
			}
		}
	}
	return out
}
