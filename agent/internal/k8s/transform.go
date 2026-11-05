// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"sort"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	eventsv1 "k8s.io/api/events/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Trimming limits (ADR-053).
const (
	maxLabels     = 64
	maxLabelValue = 256
	maxMessage    = 256
)

// keepAnnotations is the annotation allow-list (ADR-053): rollout revision, change
// cause, and the static pod config hash the node agent sees in cgroup paths.
var keepAnnotations = map[string]bool{
	"deployment.kubernetes.io/revision": true,
	"kubernetes.io/change-cause":        true,
	"kubernetes.io/config.mirror":       true,
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func trimMeta(m metav1.ObjectMeta) metav1.ObjectMeta {
	out := metav1.ObjectMeta{
		Name: m.Name, Namespace: m.Namespace, UID: m.UID, ResourceVersion: m.ResourceVersion,
		Generation: m.Generation, CreationTimestamp: m.CreationTimestamp, DeletionTimestamp: m.DeletionTimestamp,
	}
	for _, o := range m.OwnerReferences {
		out.OwnerReferences = append(out.OwnerReferences, metav1.OwnerReference{Kind: o.Kind, Name: o.Name, UID: o.UID, Controller: o.Controller})
	}
	if len(m.Labels) > 0 {
		keys := make([]string, 0, len(m.Labels))
		for k := range m.Labels {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		out.Labels = make(map[string]string, min(len(keys), maxLabels))
		for _, k := range keys[:min(len(keys), maxLabels)] {
			out.Labels[k] = truncate(m.Labels[k], maxLabelValue)
		}
	}
	for k, v := range m.Annotations {
		if keepAnnotations[k] {
			if out.Annotations == nil {
				out.Annotations = map[string]string{}
			}
			out.Annotations[k] = truncate(v, maxLabelValue)
		}
	}
	return out
}

// trimContainers keeps name, image and resources. Env, envFrom, command, args and
// probe/lifecycle exec commands are dropped: they can carry credentials (ADR-053).
func trimContainers(cs []corev1.Container) []corev1.Container {
	if len(cs) == 0 {
		return nil
	}
	out := make([]corev1.Container, len(cs))
	for i, c := range cs {
		out[i] = corev1.Container{Name: c.Name, Image: c.Image,
			Resources: corev1.ResourceRequirements{Requests: c.Resources.Requests, Limits: c.Resources.Limits}}
	}
	return out
}

func trimContainerState(s corev1.ContainerState) corev1.ContainerState {
	var out corev1.ContainerState
	if w := s.Waiting; w != nil {
		out.Waiting = &corev1.ContainerStateWaiting{Reason: w.Reason, Message: truncate(w.Message, maxMessage)}
	}
	if r := s.Running; r != nil {
		out.Running = &corev1.ContainerStateRunning{StartedAt: r.StartedAt}
	}
	if t := s.Terminated; t != nil {
		// The termination message is written by the application; it is not kept.
		out.Terminated = &corev1.ContainerStateTerminated{Reason: t.Reason, ExitCode: t.ExitCode, Signal: t.Signal,
			StartedAt: t.StartedAt, FinishedAt: t.FinishedAt, ContainerID: t.ContainerID}
	}
	return out
}

func trimContainerStatuses(ss []corev1.ContainerStatus) []corev1.ContainerStatus {
	if len(ss) == 0 {
		return nil
	}
	out := make([]corev1.ContainerStatus, len(ss))
	for i, s := range ss {
		out[i] = corev1.ContainerStatus{Name: s.Name, Ready: s.Ready, Started: s.Started, RestartCount: s.RestartCount,
			ContainerID: s.ContainerID, Image: s.Image,
			State: trimContainerState(s.State), LastTerminationState: trimContainerState(s.LastTerminationState)}
	}
	return out
}

func trimPodTemplate(t corev1.PodTemplateSpec) corev1.PodTemplateSpec {
	return corev1.PodTemplateSpec{Spec: corev1.PodSpec{
		Containers: trimContainers(t.Spec.Containers), InitContainers: trimContainers(t.Spec.InitContainers)}}
}

// Transform trims an object before the informer caches it (ADR-053). Objects of
// other types (tombstones) pass through unchanged.
func Transform(obj any) (any, error) {
	switch o := obj.(type) {
	case *corev1.Pod:
		p := &corev1.Pod{ObjectMeta: trimMeta(o.ObjectMeta)}
		p.Spec = corev1.PodSpec{NodeName: o.Spec.NodeName, HostNetwork: o.Spec.HostNetwork,
			Containers: trimContainers(o.Spec.Containers), InitContainers: trimContainers(o.Spec.InitContainers)}
		for _, v := range o.Spec.Volumes {
			if v.PersistentVolumeClaim != nil {
				p.Spec.Volumes = append(p.Spec.Volumes, corev1.Volume{Name: v.Name, VolumeSource: corev1.VolumeSource{
					PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: v.PersistentVolumeClaim.ClaimName}}})
			}
		}
		s := o.Status
		p.Status = corev1.PodStatus{Phase: s.Phase, Reason: s.Reason, Message: truncate(s.Message, maxMessage),
			PodIP: s.PodIP, PodIPs: s.PodIPs, StartTime: s.StartTime, QOSClass: s.QOSClass,
			ContainerStatuses: trimContainerStatuses(s.ContainerStatuses), InitContainerStatuses: trimContainerStatuses(s.InitContainerStatuses)}
		for _, c := range s.Conditions {
			p.Status.Conditions = append(p.Status.Conditions, corev1.PodCondition{Type: c.Type, Status: c.Status,
				Reason: c.Reason, LastTransitionTime: c.LastTransitionTime})
		}
		return p, nil
	case *corev1.Node:
		n := &corev1.Node{ObjectMeta: trimMeta(o.ObjectMeta)}
		n.Spec = corev1.NodeSpec{Unschedulable: o.Spec.Unschedulable, PodCIDR: o.Spec.PodCIDR}
		for _, t := range o.Spec.Taints {
			n.Spec.Taints = append(n.Spec.Taints, corev1.Taint{Key: t.Key, Effect: t.Effect})
		}
		s := o.Status
		n.Status = corev1.NodeStatus{Capacity: s.Capacity, Allocatable: s.Allocatable, NodeInfo: s.NodeInfo}
		for _, c := range s.Conditions {
			n.Status.Conditions = append(n.Status.Conditions, corev1.NodeCondition{Type: c.Type, Status: c.Status,
				Reason: c.Reason, Message: truncate(c.Message, maxMessage), LastTransitionTime: c.LastTransitionTime})
		}
		for _, a := range s.Addresses {
			if a.Type == corev1.NodeInternalIP {
				n.Status.Addresses = append(n.Status.Addresses, a)
			}
		}
		// status.images (every image on the node) is dropped: large and unused.
		return n, nil
	case *corev1.Service:
		svc := &corev1.Service{ObjectMeta: trimMeta(o.ObjectMeta), Spec: corev1.ServiceSpec{Type: o.Spec.Type,
			ClusterIP: o.Spec.ClusterIP, ClusterIPs: o.Spec.ClusterIPs, Selector: o.Spec.Selector, ExternalName: o.Spec.ExternalName}}
		for _, p := range o.Spec.Ports {
			svc.Spec.Ports = append(svc.Spec.Ports, corev1.ServicePort{Name: p.Name, Port: p.Port, Protocol: p.Protocol})
		}
		return svc, nil
	case *discoveryv1.EndpointSlice:
		es := &discoveryv1.EndpointSlice{ObjectMeta: trimMeta(o.ObjectMeta), AddressType: o.AddressType, Ports: o.Ports}
		for _, e := range o.Endpoints {
			te := discoveryv1.Endpoint{Addresses: e.Addresses, NodeName: e.NodeName,
				Conditions: discoveryv1.EndpointConditions{Ready: e.Conditions.Ready}}
			if r := e.TargetRef; r != nil {
				te.TargetRef = &corev1.ObjectReference{Kind: r.Kind, Namespace: r.Namespace, Name: r.Name}
			}
			es.Endpoints = append(es.Endpoints, te)
		}
		return es, nil
	case *corev1.Namespace:
		return &corev1.Namespace{ObjectMeta: trimMeta(o.ObjectMeta), Status: corev1.NamespaceStatus{Phase: o.Status.Phase}}, nil
	case *corev1.PersistentVolumeClaim:
		return &corev1.PersistentVolumeClaim{ObjectMeta: trimMeta(o.ObjectMeta),
			Spec: corev1.PersistentVolumeClaimSpec{AccessModes: o.Spec.AccessModes, StorageClassName: o.Spec.StorageClassName,
				VolumeName: o.Spec.VolumeName, Resources: corev1.VolumeResourceRequirements{Requests: o.Spec.Resources.Requests}},
			Status: corev1.PersistentVolumeClaimStatus{Phase: o.Status.Phase, Capacity: o.Status.Capacity}}, nil
	case *appsv1.Deployment:
		return &appsv1.Deployment{ObjectMeta: trimMeta(o.ObjectMeta),
			Spec: appsv1.DeploymentSpec{Replicas: o.Spec.Replicas, Strategy: appsv1.DeploymentStrategy{Type: o.Spec.Strategy.Type},
				Template: trimPodTemplate(o.Spec.Template)},
			Status: appsv1.DeploymentStatus{ObservedGeneration: o.Status.ObservedGeneration, Replicas: o.Status.Replicas,
				UpdatedReplicas: o.Status.UpdatedReplicas, ReadyReplicas: o.Status.ReadyReplicas,
				AvailableReplicas: o.Status.AvailableReplicas, UnavailableReplicas: o.Status.UnavailableReplicas}}, nil
	case *appsv1.ReplicaSet:
		// Owner resolution only (pod → ReplicaSet → Deployment); never sent.
		return &appsv1.ReplicaSet{ObjectMeta: trimMeta(o.ObjectMeta)}, nil
	case *appsv1.StatefulSet:
		return &appsv1.StatefulSet{ObjectMeta: trimMeta(o.ObjectMeta),
			Spec: appsv1.StatefulSetSpec{Replicas: o.Spec.Replicas, ServiceName: o.Spec.ServiceName, Template: trimPodTemplate(o.Spec.Template)},
			Status: appsv1.StatefulSetStatus{ObservedGeneration: o.Status.ObservedGeneration, Replicas: o.Status.Replicas,
				ReadyReplicas: o.Status.ReadyReplicas, CurrentReplicas: o.Status.CurrentReplicas, UpdatedReplicas: o.Status.UpdatedReplicas,
				AvailableReplicas: o.Status.AvailableReplicas, CurrentRevision: o.Status.CurrentRevision, UpdateRevision: o.Status.UpdateRevision}}, nil
	case *appsv1.DaemonSet:
		return &appsv1.DaemonSet{ObjectMeta: trimMeta(o.ObjectMeta),
			Spec:   appsv1.DaemonSetSpec{Template: trimPodTemplate(o.Spec.Template)},
			Status: o.Status}, nil
	case *batchv1.Job:
		j := &batchv1.Job{ObjectMeta: trimMeta(o.ObjectMeta),
			Spec: batchv1.JobSpec{Completions: o.Spec.Completions, Parallelism: o.Spec.Parallelism, BackoffLimit: o.Spec.BackoffLimit, Suspend: o.Spec.Suspend},
			Status: batchv1.JobStatus{Active: o.Status.Active, Succeeded: o.Status.Succeeded, Failed: o.Status.Failed,
				StartTime: o.Status.StartTime, CompletionTime: o.Status.CompletionTime}}
		for _, c := range o.Status.Conditions {
			j.Status.Conditions = append(j.Status.Conditions, batchv1.JobCondition{Type: c.Type, Status: c.Status, Reason: c.Reason,
				LastTransitionTime: c.LastTransitionTime})
		}
		return j, nil
	case *batchv1.CronJob:
		c := &batchv1.CronJob{ObjectMeta: trimMeta(o.ObjectMeta),
			Spec:   batchv1.CronJobSpec{Schedule: o.Spec.Schedule, Suspend: o.Spec.Suspend},
			Status: batchv1.CronJobStatus{LastScheduleTime: o.Status.LastScheduleTime, LastSuccessfulTime: o.Status.LastSuccessfulTime}}
		for _, a := range o.Status.Active {
			c.Status.Active = append(c.Status.Active, corev1.ObjectReference{Name: a.Name})
		}
		return c, nil
	case *autoscalingv2.HorizontalPodAutoscaler:
		return &autoscalingv2.HorizontalPodAutoscaler{ObjectMeta: trimMeta(o.ObjectMeta),
			Spec: autoscalingv2.HorizontalPodAutoscalerSpec{ScaleTargetRef: o.Spec.ScaleTargetRef, MinReplicas: o.Spec.MinReplicas, MaxReplicas: o.Spec.MaxReplicas},
			Status: autoscalingv2.HorizontalPodAutoscalerStatus{CurrentReplicas: o.Status.CurrentReplicas, DesiredReplicas: o.Status.DesiredReplicas,
				LastScaleTime: o.Status.LastScaleTime}}, nil
	case *eventsv1.Event:
		return trimEvent(o), nil
	}
	return obj, nil
}

// trimEvent keeps what the events table stores (SPEC §4.6, ADR-061).
func trimEvent(o *eventsv1.Event) *eventsv1.Event {
	return &eventsv1.Event{ObjectMeta: metav1.ObjectMeta{Name: o.Name, Namespace: o.Namespace, UID: o.UID,
		ResourceVersion: o.ResourceVersion, CreationTimestamp: o.CreationTimestamp},
		EventTime: o.EventTime, Series: o.Series, ReportingController: o.ReportingController, Reason: o.Reason,
		Regarding: corev1.ObjectReference{Kind: o.Regarding.Kind, Namespace: o.Regarding.Namespace, Name: o.Regarding.Name, UID: o.Regarding.UID},
		Note:      truncate(o.Note, 1024), Type: o.Type, DeprecatedCount: o.DeprecatedCount,
		DeprecatedFirstTimestamp: o.DeprecatedFirstTimestamp, DeprecatedLastTimestamp: o.DeprecatedLastTimestamp}
}
