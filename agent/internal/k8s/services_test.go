// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	authv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/watchlog-light/watchlog/agent/internal/podmap"
)

// Captured on kind: a Service record carries what the topology fallback needs.
func TestServiceRecordsFromCapturedServices(t *testing.T) {
	c, _ := startCluster(t)
	r := record(t, c, "Service", "kube-system", "kube-dns")
	spec := r.Spec.(map[string]any)
	if !reflect.DeepEqual(spec["cluster_ips"], []string{"10.96.0.10"}) || spec["headless"] != false {
		t.Errorf("spec = %+v", spec)
	}
	if ports := spec["ports"].([]map[string]any); len(ports) != 3 {
		t.Errorf("ports = %+v", ports)
	}
	if _, ok := r.Status.(map[string]any)["workloads"]; !ok {
		t.Errorf("status = %+v", r.Status)
	}
}

func ptr[T any](v T) *T { return &v }

func ownedBy(kind, name string) []metav1.OwnerReference {
	return []metav1.OwnerReference{{Kind: kind, Name: name, Controller: ptr(true)}}
}

// A small consistent cluster: Deployment api → ReplicaSet → two pods (one not ready),
// a hostNetwork pod, Services with and without a cluster IP, a node.
func mapCluster(t *testing.T) (*Cluster, *fake.Clientset) {
	t.Helper()
	pod := func(name, ip string, host bool) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: name, UID: types.UID("u-" + name), OwnerReferences: ownedBy("ReplicaSet", "api-7f9")},
			Spec:   corev1.PodSpec{NodeName: "n1", HostNetwork: host},
			Status: corev1.PodStatus{Phase: corev1.PodRunning, PodIP: ip, PodIPs: []corev1.PodIP{{IP: ip}}}}
	}
	cs := fake.NewClientset(
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "api"}},
		&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "api-7f9", OwnerReferences: ownedBy("Deployment", "api")}},
		pod("api-7f9-a", "10.244.1.5", false), pod("api-7f9-b", "10.244.2.6", false), pod("node-exporter", "172.19.0.3", true),
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "api"},
			Spec: corev1.ServiceSpec{ClusterIP: "10.96.1.1", ClusterIPs: []string{"10.96.1.1"}, Ports: []corev1.ServicePort{{Port: 80}}}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "db"},
			Spec: corev1.ServiceSpec{ClusterIP: corev1.ClusterIPNone}},
		&discoveryv1.EndpointSlice{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "api-x", Labels: map[string]string{discoveryv1.LabelServiceName: "api"}},
			Endpoints: []discoveryv1.Endpoint{
				{Addresses: []string{"10.244.1.5"}, Conditions: discoveryv1.EndpointConditions{Ready: ptr(true)}, TargetRef: &corev1.ObjectReference{Kind: "Pod", Namespace: "shop", Name: "api-7f9-a"}},
				{Addresses: []string{"10.244.2.6"}, Conditions: discoveryv1.EndpointConditions{Ready: ptr(false)}, TargetRef: &corev1.ObjectReference{Kind: "Pod", Namespace: "shop", Name: "api-7f9-b"}},
			}},
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "n1"}, Status: corev1.NodeStatus{Addresses: []corev1.NodeAddress{
			{Type: corev1.NodeInternalIP, Address: "172.19.0.3"}, {Type: corev1.NodeHostName, Address: "n1"}}}},
	)
	c, err := NewCluster(cs, 0, false)
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

func TestIPMapResolvesPodsServicesAndNodes(t *testing.T) {
	c, _ := mapCluster(t)
	if ws, ready := c.ServiceBackends("shop", "api"); ready != 1 || len(ws) != 1 || ws[0] != (Workload{Kind: "Deployment", Name: "api"}) {
		t.Errorf("backends = %+v, ready %d", ws, ready)
	}
	m := c.IPMap()
	want := podmap.IPMap{
		Pods: []podmap.IPPod{
			{IP: "10.244.1.5", Namespace: "shop", Pod: "api-7f9-a", WorkloadKind: "Deployment", Workload: "api"},
			{IP: "10.244.2.6", Namespace: "shop", Pod: "api-7f9-b", WorkloadKind: "Deployment", Workload: "api"},
		},
		// The headless Service has no cluster IP: its clients reach pod IPs.
		Services: []podmap.IPService{{IPs: []string{"10.96.1.1"}, Namespace: "shop", Name: "api",
			Workloads: []podmap.Workload{{Kind: "Deployment", Name: "api"}}}},
		Nodes: []podmap.IPNode{{IP: "172.19.0.3", Name: "n1"}},
	}
	if !reflect.DeepEqual(m, want) {
		t.Errorf("map =\n%+v\nwant\n%+v", m, want)
	}
}

func TestIPMapIsServedToNodeAgents(t *testing.T) {
	c, cs := mapCluster(t)
	cs.PrependReactor("create", "tokenreviews", func(a k8stesting.Action) (bool, runtime.Object, error) {
		res := &authv1.TokenReview{}
		if a.(k8stesting.CreateAction).GetObject().(*authv1.TokenReview).Spec.Token == "agent" {
			res.Status = authv1.TokenReviewStatus{Authenticated: true, User: authv1.UserInfo{
				Username: "system:serviceaccount:wl:watchlog-agent",
				Extra:    map[string]authv1.ExtraValue{extraNodeName: {"n1"}}}}
		}
		return true, res, nil
	})
	srv := &PodMapServer{Cluster: c, Reviews: cs.AuthenticationV1().TokenReviews(), Namespace: "wl",
		Account: "watchlog-agent", Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	get := func(token, etag string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, podmap.IPMapPath, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		if etag != "" {
			r.Header.Set("If-None-Match", etag)
		}
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, r)
		return w
	}
	w := get("agent", "")
	var m podmap.IPMap
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &m) != nil || len(m.Pods) != 2 || len(m.Services) != 1 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if got := get("agent", w.Header().Get("ETag")); got.Code != http.StatusNotModified {
		t.Errorf("unchanged map: %d", got.Code)
	}
	if got := get("stranger", ""); got.Code != http.StatusUnauthorized {
		t.Errorf("unknown token: %d", got.Code)
	}
}
