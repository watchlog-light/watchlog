// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	authv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	authclient "k8s.io/client-go/kubernetes/typed/authentication/v1"

	"github.com/watchlog-light/watchlog/agent/internal/podmap"
)

// Pod map authentication cache lifetimes (ADR-066).
const (
	reviewTTL   = 5 * time.Minute
	rejectedTTL = 30 * time.Second
)

// Extra keys of a TokenReview for a pod-bound ServiceAccount token.
const (
	extraPodName  = "authentication.kubernetes.io/pod-name"
	extraPodUID   = "authentication.kubernetes.io/pod-uid"
	extraNodeName = "authentication.kubernetes.io/node-name" // Kubernetes 1.32+
)

// PodMap builds the map of the pods scheduled on node.
func (c *Cluster) PodMap(node string) podmap.Map {
	m := podmap.Map{Node: node, Pods: []podmap.Pod{}}
	for _, obj := range c.Store("Pod").List() {
		p := obj.(*corev1.Pod)
		if p.Spec.NodeName != node {
			continue
		}
		w := PodWorkload(p, c)
		e := podmap.Pod{ID: string(p.UID), Mirror: p.Annotations["kubernetes.io/config.mirror"], Namespace: p.Namespace,
			Name: p.Name, WorkloadKind: w.Kind, Workload: w.Name, Containers: map[string]string{}}
		for _, ss := range [][]corev1.ContainerStatus{p.Status.InitContainerStatuses, p.Status.ContainerStatuses} {
			for _, s := range ss {
				if s.ContainerID != "" {
					e.Containers[podmap.ContainerID(s.ContainerID)] = s.Name
				}
				// A restarted container's previous instance can still have a cgroup.
				if t := s.LastTerminationState.Terminated; t != nil && t.ContainerID != "" {
					e.Containers[podmap.ContainerID(t.ContainerID)] = s.Name
				}
			}
		}
		m.Pods = append(m.Pods, e)
	}
	sort.Slice(m.Pods, func(i, j int) bool { return m.Pods[i].ID < m.Pods[j].ID })
	return m
}

type review struct {
	node    string
	status  int // 0 when accepted
	expires time.Time
}

// PodMapServer answers node agents' GET /v1/podmap (ADR-066).
type PodMapServer struct {
	Cluster   *Cluster
	Reviews   authclient.TokenReviewInterface
	Namespace string // node agents' namespace
	Account   string // node agents' ServiceAccount
	Log       *slog.Logger

	mu    sync.Mutex
	cache map[[32]byte]review
	now   func() time.Time

	ipMu   sync.Mutex
	ipBody []byte
	ipAt   time.Time
}

func (s *PodMapServer) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

// authenticate returns the caller's node, or an HTTP status to refuse with.
func (s *PodMapServer) authenticate(ctx context.Context, token string) (string, int) {
	key := sha256.Sum256([]byte(token))
	now := s.clock()
	s.mu.Lock()
	if s.cache == nil {
		s.cache = map[[32]byte]review{}
	}
	if r, ok := s.cache[key]; ok && now.Before(r.expires) {
		s.mu.Unlock()
		return r.node, r.status
	}
	s.mu.Unlock()

	res, err := s.Reviews.Create(ctx, &authv1.TokenReview{Spec: authv1.TokenReviewSpec{
		Token: token, Audiences: []string{podmap.Audience}}}, metav1.CreateOptions{})
	if err != nil {
		s.Log.Warn("token review failed", "err", err)
		return "", http.StatusServiceUnavailable // not cached: the API server may recover
	}
	r := review{status: http.StatusUnauthorized, expires: now.Add(rejectedTTL)}
	st := res.Status
	want := "system:serviceaccount:" + s.Namespace + ":" + s.Account
	switch {
	case !st.Authenticated:
	case st.User.Username != want:
		r.status = http.StatusForbidden
	default:
		if node := first(st.User.Extra[extraNodeName]); node != "" {
			r = review{node: node, expires: now.Add(reviewTTL)}
		} else if node := s.podNode(first(st.User.Extra[extraPodName]), first(st.User.Extra[extraPodUID])); node != "" {
			r = review{node: node, expires: now.Add(reviewTTL)}
		} else {
			r.status = http.StatusForbidden // not a pod-bound token, or the pod is unknown
		}
	}
	s.mu.Lock()
	s.cache[key] = r
	s.mu.Unlock()
	return r.node, r.status
}

func first(v authv1.ExtraValue) string {
	if len(v) == 0 {
		return ""
	}
	return v[0]
}

// podNode finds the bound pod in the cache; the UID must match (a recreated pod with
// the same name is a different identity).
func (s *PodMapServer) podNode(name, uid string) string {
	if name == "" {
		return ""
	}
	obj, ok, err := s.Cluster.Store("Pod").GetByKey(s.Namespace + "/" + name)
	if err != nil || !ok {
		return ""
	}
	p := obj.(*corev1.Pod)
	if uid != "" && string(p.UID) != uid {
		return ""
	}
	return p.Spec.NodeName
}

func (s *PodMapServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || (r.URL.Path != podmap.Path && r.URL.Path != podmap.IPMapPath) {
		http.NotFound(w, r)
		return
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || token == "" {
		http.Error(w, "bearer token required", http.StatusUnauthorized)
		return
	}
	node, status := s.authenticate(r.Context(), token)
	if status != 0 {
		http.Error(w, http.StatusText(status), status)
		return
	}
	var b []byte
	var err error
	if r.URL.Path == podmap.IPMapPath {
		// Cluster-wide: flow destinations are anywhere in the cluster (ADR-101).
		b, err = s.ipMap()
	} else {
		b, err = json.Marshal(s.Cluster.PodMap(node))
	}
	if err != nil {
		http.Error(w, "encoding", http.StatusInternalServerError)
		return
	}
	h := fnv.New64a()
	_, _ = h.Write(b)
	etag := fmt.Sprintf(`"%x"`, h.Sum64())
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(b)
}

// ipMap is the encoded IP map, rebuilt at most every ipMapTTL however many node
// agents ask.
func (s *PodMapServer) ipMap() ([]byte, error) {
	s.ipMu.Lock()
	defer s.ipMu.Unlock()
	if s.ipBody != nil && s.clock().Sub(s.ipAt) < ipMapTTL {
		return s.ipBody, nil
	}
	b, err := json.Marshal(s.Cluster.IPMap())
	if err != nil {
		return nil, err
	}
	s.ipBody, s.ipAt = b, s.clock()
	return b, nil
}
