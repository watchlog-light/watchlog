// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"sort"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Record is one object as sent to POST /ingest/v1/objects (ADR-055).
type Record struct {
	Kind      string `json:"kind"`
	UID       string `json:"uid"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name"`
	Node      string `json:"node,omitempty"`
	Spec      any    `json:"spec"`
	Status    any    `json:"status"`
	Deleted   bool   `json:"deleted,omitempty"`
}

// Workload names a pod's top-level controller.
type Workload struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

// Owners resolves intermediate owners: a ReplicaSet's Deployment, a Job's CronJob.
type Owners interface {
	Owner(kind, namespace, name string) (Workload, bool)
}

// PodWorkload follows a pod's controller reference to its workload: ReplicaSet →
// Deployment, Job → CronJob. Static pods (owned by their Node) are "StaticPod",
// pods without a controller are "Pod"; both use the pod name.
func PodWorkload(p *corev1.Pod, owners Owners) Workload {
	ref := metav1.GetControllerOfNoCopy(p)
	if ref == nil {
		return Workload{Kind: "Pod", Name: p.Name}
	}
	switch ref.Kind {
	case "Node":
		return Workload{Kind: "StaticPod", Name: p.Name}
	case "ReplicaSet", "Job":
		if w, ok := owners.Owner(ref.Kind, p.Namespace, ref.Name); ok {
			return w
		}
	}
	return Workload{Kind: ref.Kind, Name: ref.Name}
}

type containerSpec struct {
	Name     string            `json:"name"`
	Image    string            `json:"image"`
	Requests map[string]string `json:"requests,omitempty"`
	Limits   map[string]string `json:"limits,omitempty"`
}

func quantities(l corev1.ResourceList) map[string]string {
	if len(l) == 0 {
		return nil
	}
	out := make(map[string]string, len(l))
	for k, v := range l {
		out[string(k)] = v.String()
	}
	return out
}

func containerSpecs(cs []corev1.Container) []containerSpec {
	out := make([]containerSpec, 0, len(cs))
	for _, c := range cs {
		out = append(out, containerSpec{Name: c.Name, Image: c.Image,
			Requests: quantities(c.Resources.Requests), Limits: quantities(c.Resources.Limits)})
	}
	return out
}

func ts(t *metav1.Time) *time.Time {
	if t == nil || t.IsZero() {
		return nil
	}
	u := t.UTC()
	return &u
}

func i32(p *int32) *int32 { return p }

type termination struct {
	Reason     string     `json:"reason"`
	ExitCode   int32      `json:"exit_code"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

type containerStatus struct {
	Name            string       `json:"name"`
	Init            bool         `json:"init,omitempty"`
	Ready           bool         `json:"ready"`
	RestartCount    int32        `json:"restart_count"`
	State           string       `json:"state"` // running, waiting, terminated
	Reason          string       `json:"reason,omitempty"`
	Message         string       `json:"message,omitempty"`
	ExitCode        *int32       `json:"exit_code,omitempty"`
	StartedAt       *time.Time   `json:"started_at,omitempty"`
	LastTermination *termination `json:"last_termination,omitempty"`
}

func containerStatuses(ss []corev1.ContainerStatus, init bool) []containerStatus {
	out := make([]containerStatus, 0, len(ss))
	for _, s := range ss {
		c := containerStatus{Name: s.Name, Init: init, Ready: s.Ready, RestartCount: s.RestartCount}
		switch {
		case s.State.Running != nil:
			c.State, c.StartedAt = "running", ts(&s.State.Running.StartedAt)
		case s.State.Waiting != nil:
			c.State, c.Reason, c.Message = "waiting", s.State.Waiting.Reason, s.State.Waiting.Message
		case s.State.Terminated != nil:
			t := s.State.Terminated
			c.State, c.Reason, c.ExitCode = "terminated", t.Reason, &t.ExitCode
			c.StartedAt = ts(&t.StartedAt)
		}
		if t := s.LastTerminationState.Terminated; t != nil {
			c.LastTermination = &termination{Reason: t.Reason, ExitCode: t.ExitCode, FinishedAt: ts(&t.FinishedAt)}
		}
		out = append(out, c)
	}
	return out
}

func podRecord(p *corev1.Pod, owners Owners) Record {
	spec := map[string]any{
		"workload":   PodWorkload(p, owners),
		"containers": containerSpecs(p.Spec.Containers),
	}
	if len(p.Spec.InitContainers) > 0 {
		spec["init_containers"] = containerSpecs(p.Spec.InitContainers)
	}
	if h := p.Annotations["kubernetes.io/config.mirror"]; h != "" {
		spec["mirror"] = h
	}
	var pvcs []string
	for _, v := range p.Spec.Volumes {
		if v.PersistentVolumeClaim != nil {
			pvcs = append(pvcs, v.PersistentVolumeClaim.ClaimName)
		}
	}
	if pvcs != nil {
		spec["pvcs"] = pvcs
	}
	if len(p.Labels) > 0 {
		spec["labels"] = p.Labels
	}
	ready := false
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodReady {
			ready = c.Status == corev1.ConditionTrue
		}
	}
	status := map[string]any{
		"phase":      p.Status.Phase,
		"qos_class":  p.Status.QOSClass,
		"ready":      ready,
		"containers": append(containerStatuses(p.Status.InitContainerStatuses, true), containerStatuses(p.Status.ContainerStatuses, false)...),
	}
	if p.Status.Reason != "" {
		status["reason"], status["message"] = p.Status.Reason, p.Status.Message
	}
	if p.Status.PodIP != "" {
		status["pod_ip"] = p.Status.PodIP
	}
	if t := ts(p.Status.StartTime); t != nil {
		status["started_at"] = t
	}
	if t := ts(p.DeletionTimestamp); t != nil {
		status["deleting_since"] = t
	}
	return Record{Kind: "Pod", UID: string(p.UID), Namespace: p.Namespace, Name: p.Name, Node: p.Spec.NodeName,
		Spec: spec, Status: status}
}

func nodeRecord(n *corev1.Node) Record {
	var roles []string
	for l := range n.Labels {
		if r, ok := strings.CutPrefix(l, "node-role.kubernetes.io/"); ok {
			roles = append(roles, r)
		}
	}
	sort.Strings(roles)
	var taints []string
	for _, t := range n.Spec.Taints {
		taints = append(taints, t.Key+":"+string(t.Effect))
	}
	conditions := make([]map[string]any, 0, len(n.Status.Conditions))
	for _, c := range n.Status.Conditions {
		conditions = append(conditions, map[string]any{"type": c.Type, "status": c.Status, "reason": c.Reason,
			"message": c.Message, "since": ts(&c.LastTransitionTime)})
	}
	ip := ""
	if len(n.Status.Addresses) > 0 {
		ip = n.Status.Addresses[0].Address
	}
	i := n.Status.NodeInfo
	return Record{Kind: "Node", UID: string(n.UID), Name: n.Name, Node: n.Name,
		Spec: map[string]any{"unschedulable": n.Spec.Unschedulable, "roles": roles, "taints": taints, "labels": n.Labels},
		Status: map[string]any{"conditions": conditions, "capacity": quantities(n.Status.Capacity),
			"allocatable": quantities(n.Status.Allocatable), "internal_ip": ip,
			"info": map[string]string{"kubelet_version": i.KubeletVersion, "kernel_version": i.KernelVersion,
				"os_image": i.OSImage, "container_runtime": i.ContainerRuntimeVersion, "architecture": i.Architecture}}}
}

func meta(kind string, m metav1.ObjectMeta) Record {
	return Record{Kind: kind, UID: string(m.UID), Namespace: m.Namespace, Name: m.Name}
}

func storage(l corev1.ResourceList) string {
	if q, ok := l[corev1.ResourceStorage]; ok {
		return q.String()
	}
	return ""
}

// ToRecord summarises a trimmed object (ADR-055). ok is false for kinds that are
// never sent (ReplicaSets) and for unknown types. Every summary's spec carries the
// object's creation time ("created_at") for ages in the UI.
func ToRecord(obj any, owners Owners) (Record, bool) {
	r, ok := toRecord(obj, owners)
	if !ok {
		return r, false
	}
	if m, err := apimeta.Accessor(obj); err == nil {
		if spec, isMap := r.Spec.(map[string]any); isMap {
			if t := m.GetCreationTimestamp(); !t.IsZero() {
				spec["created_at"] = t.UTC()
			}
		}
	}
	return r, true
}

func toRecord(obj any, owners Owners) (Record, bool) {
	switch o := obj.(type) {
	case *corev1.Pod:
		return podRecord(o, owners), true
	case *corev1.Node:
		return nodeRecord(o), true
	case *corev1.Service:
		r := meta("Service", o.ObjectMeta)
		ports := make([]map[string]any, 0, len(o.Spec.Ports))
		for _, p := range o.Spec.Ports {
			ports = append(ports, map[string]any{"name": p.Name, "port": p.Port, "protocol": p.Protocol})
		}
		ips := o.Spec.ClusterIPs
		if len(ips) == 0 && o.Spec.ClusterIP != "" {
			ips = []string{o.Spec.ClusterIP}
		}
		r.Spec = map[string]any{"type": o.Spec.Type, "cluster_ips": ips, "headless": o.Spec.ClusterIP == corev1.ClusterIPNone,
			"ports": ports, "selector": o.Spec.Selector, "external_name": o.Spec.ExternalName}
		workloads, ready := []Workload{}, 0
		if b, ok := owners.(interface {
			ServiceBackends(namespace, name string) ([]Workload, int)
		}); ok {
			workloads, ready = b.ServiceBackends(o.Namespace, o.Name)
		}
		r.Status = map[string]any{"workloads": workloads, "ready_endpoints": ready}
		return r, true
	case *corev1.Namespace:
		r := meta("Namespace", o.ObjectMeta)
		r.Spec, r.Status = map[string]any{"labels": o.Labels}, map[string]any{"phase": o.Status.Phase}
		return r, true
	case *corev1.PersistentVolumeClaim:
		r := meta("PersistentVolumeClaim", o.ObjectMeta)
		r.Spec = map[string]any{"storage_class": o.Spec.StorageClassName, "requested": storage(o.Spec.Resources.Requests),
			"volume": o.Spec.VolumeName, "access_modes": o.Spec.AccessModes}
		r.Status = map[string]any{"phase": o.Status.Phase, "capacity": storage(o.Status.Capacity)}
		return r, true
	case *appsv1.Deployment:
		r := meta("Deployment", o.ObjectMeta)
		r.Spec = map[string]any{"replicas": i32(o.Spec.Replicas), "strategy": o.Spec.Strategy.Type,
			"revision": o.Annotations["deployment.kubernetes.io/revision"], "generation": o.Generation,
			"containers": containerSpecs(o.Spec.Template.Spec.Containers)}
		r.Status = map[string]any{"replicas": o.Status.Replicas, "ready": o.Status.ReadyReplicas,
			"available": o.Status.AvailableReplicas, "updated": o.Status.UpdatedReplicas,
			"unavailable": o.Status.UnavailableReplicas, "observed_generation": o.Status.ObservedGeneration}
		return r, true
	case *appsv1.StatefulSet:
		r := meta("StatefulSet", o.ObjectMeta)
		r.Spec = map[string]any{"replicas": i32(o.Spec.Replicas), "service_name": o.Spec.ServiceName,
			"generation": o.Generation, "containers": containerSpecs(o.Spec.Template.Spec.Containers)}
		r.Status = map[string]any{"replicas": o.Status.Replicas, "ready": o.Status.ReadyReplicas,
			"available": o.Status.AvailableReplicas, "current": o.Status.CurrentReplicas, "updated": o.Status.UpdatedReplicas,
			"current_revision": o.Status.CurrentRevision, "update_revision": o.Status.UpdateRevision,
			"observed_generation": o.Status.ObservedGeneration}
		return r, true
	case *appsv1.DaemonSet:
		r := meta("DaemonSet", o.ObjectMeta)
		r.Spec = map[string]any{"generation": o.Generation, "containers": containerSpecs(o.Spec.Template.Spec.Containers)}
		r.Status = map[string]any{"desired": o.Status.DesiredNumberScheduled, "current": o.Status.CurrentNumberScheduled,
			"ready": o.Status.NumberReady, "available": o.Status.NumberAvailable, "updated": o.Status.UpdatedNumberScheduled,
			"misscheduled": o.Status.NumberMisscheduled, "observed_generation": o.Status.ObservedGeneration}
		return r, true
	case *batchv1.Job:
		r := meta("Job", o.ObjectMeta)
		spec := map[string]any{"completions": i32(o.Spec.Completions), "parallelism": i32(o.Spec.Parallelism)}
		if ref := metav1.GetControllerOfNoCopy(o); ref != nil && ref.Kind == "CronJob" {
			spec["cronjob"] = ref.Name
		}
		state := "running"
		for _, c := range o.Status.Conditions {
			if c.Status == corev1.ConditionTrue && (c.Type == batchv1.JobComplete || c.Type == batchv1.JobFailed) {
				state = strings.ToLower(string(c.Type))
			}
		}
		r.Spec = spec
		r.Status = map[string]any{"state": state, "active": o.Status.Active, "succeeded": o.Status.Succeeded,
			"failed": o.Status.Failed, "started_at": ts(o.Status.StartTime), "completed_at": ts(o.Status.CompletionTime)}
		return r, true
	case *batchv1.CronJob:
		r := meta("CronJob", o.ObjectMeta)
		suspend := o.Spec.Suspend != nil && *o.Spec.Suspend
		r.Spec = map[string]any{"schedule": o.Spec.Schedule, "suspend": suspend}
		r.Status = map[string]any{"active": len(o.Status.Active), "last_schedule": ts(o.Status.LastScheduleTime),
			"last_success": ts(o.Status.LastSuccessfulTime)}
		return r, true
	case *autoscalingv2.HorizontalPodAutoscaler:
		r := meta("HorizontalPodAutoscaler", o.ObjectMeta)
		r.Spec = map[string]any{"target": Workload{Kind: o.Spec.ScaleTargetRef.Kind, Name: o.Spec.ScaleTargetRef.Name},
			"min": i32(o.Spec.MinReplicas), "max": o.Spec.MaxReplicas}
		r.Status = map[string]any{"current": o.Status.CurrentReplicas, "desired": o.Status.DesiredReplicas,
			"last_scale": ts(o.Status.LastScaleTime)}
		return r, true
	}
	return Record{}, false
}

// Quantity parses a Kubernetes quantity string; used by tests and state metrics.
func Quantity(s string) (float64, bool) {
	q, err := resource.ParseQuantity(s)
	if err != nil {
		return 0, false
	}
	return q.AsApproximateFloat64(), true
}
