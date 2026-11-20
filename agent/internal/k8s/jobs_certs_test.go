// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/watchlog-light/watchlog/agent/internal/collectors/jobs"
)

var t0 = time.Date(2026, 11, 19, 0, 0, 0, 0, time.UTC)

func at(h, m int) metav1.Time {
	return metav1.NewTime(t0.Add(time.Duration(h)*time.Hour + time.Duration(m)*time.Minute))
}

func owned(kind, name string) []metav1.OwnerReference {
	return []metav1.OwnerReference{{Kind: kind, Name: name, Controller: ptr(true)}}
}

func job(name string, created metav1.Time, cond batchv1.JobConditionType, at metav1.Time) *batchv1.Job {
	j := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "shop", CreationTimestamp: created,
		OwnerReferences: owned("CronJob", "nightly")}}
	if cond != "" {
		j.Status.Conditions = []batchv1.JobCondition{{Type: cond, Status: corev1.ConditionTrue, LastTransitionTime: at}}
	}
	return j
}

func clusterWith(t *testing.T, ingresses bool, objs ...runtime.Object) *Cluster {
	t.Helper()
	cs := fake.NewClientset(objs...)
	c, err := NewCluster(cs, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if ingresses {
		if err := c.WatchIngresses(); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if !c.Start(ctx) {
		t.Fatal("caches did not sync")
	}
	return c
}

func TestCronJobsAsScheduledJobs(t *testing.T) {
	c := clusterWith(t, false,
		&batchv1.CronJob{ObjectMeta: metav1.ObjectMeta{Name: "nightly", Namespace: "shop"},
			Spec: batchv1.CronJobSpec{Schedule: "0 3 * * *", TimeZone: ptr("Europe/Berlin")}},
		&batchv1.CronJob{ObjectMeta: metav1.ObjectMeta{Name: "paused", Namespace: "shop"},
			Spec: batchv1.CronJobSpec{Schedule: "CRON_TZ=America/New_York */10 * * * *", Suspend: ptr(true)}},
		job("nightly-1", at(2, 0), batchv1.JobComplete, at(2, 4)),
		job("nightly-2", at(3, 0), batchv1.JobFailed, at(3, 2)),
		job("nightly-3", at(4, 0), "", metav1.Time{}),
		// The failed Job's pods: the last one to end gives the code.
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "nightly-2-a", Namespace: "shop", OwnerReferences: owned("Job", "nightly-2")},
			Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{Name: "main",
				State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 1, FinishedAt: at(3, 1)}}}}}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "nightly-2-b", Namespace: "shop", OwnerReferences: owned("Job", "nightly-2")},
			Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{Name: "main",
				State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 137, FinishedAt: at(3, 2)}}}}}},
	)
	now := t0.Add(4*time.Hour + 30*time.Minute)
	obs := c.CronJobs(now)
	if len(obs) != 2 {
		t.Fatalf("two CronJobs: %+v", obs)
	}
	var n, p jobs.Observation
	for _, o := range obs {
		switch o.Name {
		case "shop/nightly":
			n = o
		case "shop/paused":
			p = o
		}
	}
	// 03:00 in Berlin is 02:00 UTC in November.
	if n.Kind != "cronjob" || !n.Enabled || n.Next != t0.Add(26*time.Hour).Unix() || n.Every != 86400 || len(n.Runs) != 3 {
		t.Fatalf("nightly: %+v", n)
	}
	byStart := map[int64]jobs.Run{}
	for _, r := range n.Runs {
		byStart[r.Start] = r
	}
	if r := byStart[at(2, 0).Unix()]; r.Result != "success" || r.End-r.Start != 240 {
		t.Fatalf("complete: %+v", r)
	}
	if r := byStart[at(3, 0).Unix()]; r.Result != "failed" || r.Code == nil || *r.Code != 137 {
		t.Fatalf("failed with the last pod's code: %+v", r)
	}
	if r := byStart[at(4, 0).Unix()]; r.Result != "running" {
		t.Fatalf("running: %+v", r)
	}
	if p.Enabled || p.Next != 0 || p.Every != 600 {
		t.Fatalf("suspended, in its CRON_TZ: %+v", p)
	}

	// Through the tracker: failed, then the series carry the namespace.
	tr := &jobs.Tracker{}
	tr.Update("cronjob", obs, now)
	samples, _ := tr.Collect()
	found := false
	for _, s := range samples {
		l := map[string]string{}
		for _, x := range s.Labels {
			l[x.Name] = x.Value
		}
		if s.Name == "watchlog_job_failed_streak" && s.Value == 1 && l["namespace"] == "shop" && l["job"] == "nightly" {
			found = true
		}
	}
	if !found {
		t.Fatalf("series: %+v", samples)
	}
}

func svc(ns, name, ip string, port int32, portName string, labels map[string]string, lb ...string) *corev1.Service {
	s := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, Labels: labels},
		Spec: corev1.ServiceSpec{ClusterIP: ip, Ports: []corev1.ServicePort{{Name: portName, Port: port, Protocol: corev1.ProtocolTCP}}}}
	for _, a := range lb {
		s.Status.LoadBalancer.Ingress = append(s.Status.LoadBalancer.Ingress, corev1.LoadBalancerIngress{IP: a})
	}
	return s
}

func ingress(ns, name string, status string, hosts ...string) *networkingv1.Ingress {
	in := &networkingv1.Ingress{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec: networkingv1.IngressSpec{TLS: []networkingv1.IngressTLS{{Hosts: hosts, SecretName: "wl-test-secret-tls"}},
			Rules: []networkingv1.IngressRule{{Host: hosts[0]}}}}
	if status != "" {
		in.Status.LoadBalancer.Ingress = []networkingv1.IngressLoadBalancerIngress{{IP: status}}
	}
	return in
}

func TestCertificateTargetsInACluster(t *testing.T) {
	ctl := map[string]string{"app.kubernetes.io/name": "ingress-nginx", "app.kubernetes.io/component": "controller"}
	c := clusterWith(t, true,
		svc("default", "kubernetes", "10.96.0.1", 443, "https", nil),
		svc("ingress-nginx", "ingress-nginx-controller", "10.96.0.50", 443, "https", ctl, "172.18.0.10"),
		svc("shop", "api", "10.96.0.60", 8443, "https", nil),
		svc("shop", "web", "10.96.0.61", 80, "http", nil),
		svc("shop", "headless", corev1.ClusterIPNone, 443, "https", nil),
		ingress("shop", "web", "172.18.0.10", "shop.example.test", "*.api.example.test"),
		ingress("shop", "pending", "", "new.example.test"),
	)
	got := map[string]string{}
	for _, tg := range c.CertTargets() {
		got[tg.Kind+" "+tg.Workload] = tg.Addr + ":" + itoa(int(tg.Port)) + " " + strings.Join(tg.Names, ",")
	}
	want := map[string]string{
		"Service default/kubernetes":                     "10.96.0.1:443 ",
		"Service ingress-nginx/ingress-nginx-controller": "10.96.0.50:443 ",
		"Service shop/api":                               "10.96.0.60:8443 ",
		// Its status points to the controller's load balancer: read on its cluster address.
		"Ingress shop/web": "10.96.0.50:443 shop.example.test,watchlog-check.api.example.test",
		// No status yet: the one controller Service in the cluster.
		"Ingress shop/pending": "10.96.0.50:443 new.example.test",
	}
	if len(got) != len(want) {
		t.Fatalf("targets: %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: %q, want %q", k, got[k], v)
		}
	}
	// The cached Ingress keeps hosts only: never the Secret's name.
	for _, obj := range c.Store("Ingress").List() {
		b, _ := json.Marshal(obj)
		if strings.Contains(string(b), "wl-test-secret") {
			t.Fatalf("the Secret's name was kept: %s", b)
		}
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestIngressesNeedTheRBAC(t *testing.T) {
	cs := fake.NewClientset()
	if !CanWatchIngresses(context.Background(), cs) {
		t.Fatal("allowed")
	}
	cs.PrependReactor("list", "ingresses", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Group: "networking.k8s.io", Resource: "ingresses"}, "", errors.New("RBAC"))
	})
	if CanWatchIngresses(context.Background(), cs) {
		t.Fatal("an older chart's RBAC: no Ingresses")
	}
	// Without the Ingress informer: TLS Services only.
	c := clusterWith(t, false, svc("default", "kubernetes", "10.96.0.1", 443, "https", nil))
	if tg := c.CertTargets(); len(tg) != 1 || tg[0].Kind != "Service" {
		t.Fatalf("services only: %+v", tg)
	}
}
