// SPDX-License-Identifier: AGPL-3.0-only

package podmap

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestClientETagFailuresAndDiskCache(t *testing.T) {
	var up atomic.Bool
	up.Store(true)
	var auth atomic.Value
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth.Store(r.Header.Get("Authorization"))
		if !up.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		if r.Header.Get("If-None-Match") == `"v1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_ = json.NewEncoder(w).Encode(Map{Node: "n1", Pods: []Pod{{ID: "u1", Mirror: "hash1", Namespace: "ns", Name: "p",
			WorkloadKind: "Deployment", Workload: "web", Containers: map[string]string{"c1": "nginx"}}}})
	}))
	defer srv.Close()
	dir := t.TempDir()
	ca, token, cache := filepath.Join(dir, "ca.crt"), filepath.Join(dir, "token"), filepath.Join(dir, "podmap.json")
	_ = os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0o600)
	_ = os.WriteFile(token, []byte("projected\n"), 0o600)

	c, err := NewClient(srv.URL, ca, token, cache)
	if err != nil {
		t.Fatal(err)
	}
	m, err := c.Fetch(context.Background())
	if err != nil || m.Node != "n1" || auth.Load() != "Bearer projected" {
		t.Fatalf("fetch: %+v %v auth=%v", m, err, auth.Load())
	}
	idx := m.Index()
	if idx["u1"] != idx["hash1"] || idx["u1"].Containers["c1"] != "nginx" {
		t.Errorf("index = %+v", idx)
	}
	if m2, err := c.Fetch(context.Background()); err != nil || m2 != m {
		t.Errorf("304 must keep the same map: %v", err)
	}
	up.Store(false)
	if m3, err := c.Fetch(context.Background()); err == nil || m3 != m {
		t.Errorf("an outage must keep the last map: %v", err)
	}
	// A restarted agent starts from the disk cache.
	c2, err := NewClient(srv.URL, ca, token, cache)
	if err != nil || c2.Last() == nil || c2.Last().Pods[0].Workload != "web" {
		t.Fatalf("cache not loaded: %+v %v", c2.Last(), err)
	}
	if ContainerID("containerd://abc") != "abc" || ContainerID("abc") != "abc" {
		t.Error("ContainerID")
	}
}
