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
	"time"

	appsv1 "k8s.io/api/apps/v1"
	authv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	k8stesting "k8s.io/client-go/testing"

	"github.com/watchlog-light/watchlog/agent/internal/podmap"
)

// A Service fronts the same workload whatever its endpoints' readiness: new pods without
// an EndpointSlice yet, and a Deployment scaled to 0, still name their workload (ADR-116).
func TestIPMapNamesServiceWorkloadsBeforeEndpointsAreReady(t *testing.T) {
	c, cs := mapCluster(t)
	ctx := context.Background()
	sel := func(app string) map[string]string { return map[string]string{"app": app} }
	must := func(_ any, err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(cs.AppsV1().ReplicaSets("shop").Create(ctx, &appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "cart-5c4",
		OwnerReferences: ownedBy("Deployment", "cart")}}, metav1.CreateOptions{}))
	must(cs.CoreV1().Pods("shop").Create(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "cart-5c4-a", Labels: sel("cart"),
		OwnerReferences: ownedBy("ReplicaSet", "cart-5c4")}, Status: corev1.PodStatus{Phase: corev1.PodPending}}, metav1.CreateOptions{}))
	must(cs.CoreV1().Services("shop").Create(ctx, &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "cart"},
		Spec: corev1.ServiceSpec{ClusterIP: "10.96.2.2", ClusterIPs: []string{"10.96.2.2"}, Selector: sel("cart")}}, metav1.CreateOptions{}))
	must(cs.AppsV1().Deployments("shop").Create(ctx, &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "catalog"},
		Spec: appsv1.DeploymentSpec{Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "catalog", "tier": "x"}}}}},
		metav1.CreateOptions{}))
	must(cs.CoreV1().Services("shop").Create(ctx, &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "catalog"},
		Spec: corev1.ServiceSpec{ClusterIP: "10.96.3.3", ClusterIPs: []string{"10.96.3.3"}, Selector: sel("catalog")}}, metav1.CreateOptions{}))
	must(cs.CoreV1().Services("shop").Create(ctx, &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "nothing"},
		Spec: corev1.ServiceSpec{ClusterIP: "10.96.4.4", ClusterIPs: []string{"10.96.4.4"}, Selector: sel("gone")}}, metav1.CreateOptions{}))

	want := map[string][]podmap.Workload{
		"api":     {{Kind: "Deployment", Name: "api"}},     // endpoints, one not ready
		"cart":    {{Kind: "Deployment", Name: "cart"}},    // a pending pod, no slice yet
		"catalog": {{Kind: "Deployment", Name: "catalog"}}, // scaled to 0: the template
		"nothing": {},
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		got := map[string][]podmap.Workload{}
		for _, s := range c.IPMap().Services {
			got[s.Name] = s.Workloads
		}
		if reflect.DeepEqual(got, want) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("services = %+v, want %+v", got, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

type pushFixture struct {
	get        func(etag string, watch bool) *httptest.ResponseRecorder
	addService func(name, ip string)
	stop       context.CancelFunc
}

func pushServer(t *testing.T) pushFixture {
	t.Helper()
	c, cs := mapCluster(t)
	cs.PrependReactor("create", "tokenreviews", func(a k8stesting.Action) (bool, runtime.Object, error) {
		return true, &authv1.TokenReview{Status: authv1.TokenReviewStatus{Authenticated: true, User: authv1.UserInfo{
			Username: "system:serviceaccount:wl:watchlog-agent", Extra: map[string]authv1.ExtraValue{extraNodeName: {"n1"}}}}}, nil
	})
	srv := &PodMapServer{Cluster: c, Reviews: cs.AuthenticationV1().TokenReviews(), Namespace: "wl",
		Account: "watchlog-agent", Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := srv.Run(ctx); err != nil {
		t.Fatal(err)
	}
	return pushFixture{
		get: func(etag string, watch bool) *httptest.ResponseRecorder {
			path := podmap.IPMapPath
			if watch {
				path += "?watch=1"
			}
			r := httptest.NewRequest(http.MethodGet, path, nil)
			r.Header.Set("Authorization", "Bearer agent")
			if etag != "" {
				r.Header.Set("If-None-Match", etag)
			}
			w := httptest.NewRecorder()
			srv.ServeHTTP(w, r)
			return w
		},
		addService: func(name, ip string) {
			_, err := cs.CoreV1().Services("shop").Create(context.Background(), &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: name},
				Spec: corev1.ServiceSpec{ClusterIP: ip, ClusterIPs: []string{ip}}}, metav1.CreateOptions{})
			if err != nil {
				t.Error(err)
			}
		},
		stop: cancel,
	}
}

// A watching node agent learns about a new Service within about a second of its
// creation, not at its next poll (ADR-116).
func TestWatchIsAnsweredWhenTheMapChanges(t *testing.T) {
	f := pushServer(t)
	get := f.get
	first := get("", false)
	if first.Code != http.StatusOK || first.Header().Get(podmap.WatchHeader) != "1" {
		t.Fatalf("first: %d, watch header %q", first.Code, first.Header().Get(podmap.WatchHeader))
	}
	etag := first.Header().Get("ETag")
	if got := get(etag, false); got.Code != http.StatusNotModified {
		t.Fatalf("poll without changes: %d", got.Code)
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	start := time.Now()
	go func() { done <- get(etag, true) }()
	time.Sleep(100 * time.Millisecond)
	f.addService("checkout", "10.96.9.9")
	select {
	case w := <-done:
		var m podmap.IPMap
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &m) != nil {
			t.Fatalf("watch: %d %s", w.Code, w.Body)
		}
		found := false
		for _, s := range m.Services {
			found = found || s.Name == "checkout"
		}
		if !found || w.Header().Get("ETag") == etag {
			t.Errorf("watch answered without the new Service: %+v", m.Services)
		}
		if took := time.Since(start); took > 3*time.Second {
			t.Errorf("watch answered after %v", took)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("watch not answered within 5 s of a new Service")
	}
}

// When the server stops, open watches end at once.
func TestWatchEndsWhenTheServerStops(t *testing.T) {
	f := pushServer(t)
	etag := f.get("", false).Header().Get("ETag")
	done := make(chan int, 1)
	go func() { done <- f.get(etag, true).Code }()
	time.Sleep(100 * time.Millisecond)
	f.stop()
	select {
	case code := <-done:
		if code != http.StatusNotModified {
			t.Errorf("stopped watch: %d", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("watch still open after the server stopped")
	}
}
