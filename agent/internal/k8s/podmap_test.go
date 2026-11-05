// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	authv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	k8stesting "k8s.io/client-go/testing"

	"github.com/watchlog-light/watchlog/agent/internal/podmap"
)

func TestPodMapServesOnlyTheCallersNode(t *testing.T) {
	c, cs := startCluster(t)
	// The caller is a node agent pod; reuse a real fixture pod's identity on watchlog-worker.
	var agentPod *corev1.Pod
	for _, obj := range c.Store("Pod").List() {
		if p := obj.(*corev1.Pod); p.Spec.NodeName == "watchlog-worker" && strings.HasPrefix(p.Name, "per-node-") {
			agentPod = p
		}
	}
	if agentPod == nil {
		t.Fatal("no fixture pod on watchlog-worker")
	}
	reviews := 0
	cs.PrependReactor("create", "tokenreviews", func(a k8stesting.Action) (bool, runtime.Object, error) {
		reviews++
		tr := a.(k8stesting.CreateAction).GetObject().(*authv1.TokenReview)
		res := &authv1.TokenReview{}
		if len(tr.Spec.Audiences) != 1 || tr.Spec.Audiences[0] != podmap.Audience {
			return true, res, nil
		}
		switch tr.Spec.Token {
		case "agent-token":
			res.Status = authv1.TokenReviewStatus{Authenticated: true, User: authv1.UserInfo{
				Username: "system:serviceaccount:wl-test:watchlog-agent",
				Extra:    map[string]authv1.ExtraValue{extraPodName: {agentPod.Name}, extraPodUID: {string(agentPod.UID)}}}}
		case "node-token":
			res.Status = authv1.TokenReviewStatus{Authenticated: true, User: authv1.UserInfo{
				Username: "system:serviceaccount:wl-test:watchlog-agent",
				Extra:    map[string]authv1.ExtraValue{extraNodeName: {"watchlog-worker2"}}}}
		case "other-sa":
			res.Status = authv1.TokenReviewStatus{Authenticated: true, User: authv1.UserInfo{
				Username: "system:serviceaccount:wl-test:default",
				Extra:    map[string]authv1.ExtraValue{extraPodName: {agentPod.Name}}}}
		}
		return true, res, nil
	})
	srv := &PodMapServer{Cluster: c, Reviews: cs.AuthenticationV1().TokenReviews(), Namespace: "wl-test",
		Account: "watchlog-agent", Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	get := func(token, etag string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, podmap.Path, nil)
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		if etag != "" {
			r.Header.Set("If-None-Match", etag)
		}
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, r)
		return w
	}

	w := get("agent-token", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	var m podmap.Map
	_ = json.Unmarshal(w.Body.Bytes(), &m)
	if m.Node != "watchlog-worker" || len(m.Pods) == 0 {
		t.Fatalf("map = %+v", m)
	}
	containers := 0
	for _, p := range m.Pods {
		obj, _, _ := c.Store("Pod").GetByKey(p.Namespace + "/" + p.Name)
		if obj.(*corev1.Pod).Spec.NodeName != "watchlog-worker" {
			t.Errorf("pod %s/%s of another node served", p.Namespace, p.Name)
		}
		for id, name := range p.Containers {
			if strings.Contains(id, "://") || name == "" {
				t.Errorf("container entry %q → %q", id, name)
			}
			containers++
		}
	}
	if containers == 0 {
		t.Error("no container IDs in the map")
	}
	if got := get("agent-token", w.Header().Get("ETag")); got.Code != http.StatusNotModified {
		t.Errorf("unchanged map: status %d, want 304", got.Code)
	}
	if reviews != 1 {
		t.Errorf("token reviewed %d times; the result must be cached", reviews)
	}
	var m2 podmap.Map
	if w := get("node-token", ""); w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &m2) != nil || m2.Node != "watchlog-worker2" {
		t.Errorf("node-name extra: %d %+v", w.Code, m2.Node)
	}
	for token, want := range map[string]int{"": 401, "garbage": 401, "other-sa": 403} {
		if w := get(token, ""); w.Code != want {
			t.Errorf("token %q: status %d, want %d", token, w.Code, want)
		}
	}
}
