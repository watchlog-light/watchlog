// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	fakediscovery "k8s.io/client-go/discovery/fake"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

// fakeDiscovery is client-go's fake discovery with the given group versions served.
func fakeDiscovery(lists ...*metav1.APIResourceList) *fakediscovery.FakeDiscovery {
	cs := fake.NewClientset()
	d := cs.Discovery().(*fakediscovery.FakeDiscovery)
	d.Resources = lists
	return d
}

func ciliumList(resources ...string) *metav1.APIResourceList {
	l := &metav1.APIResourceList{GroupVersion: CiliumGroupVersion}
	for _, r := range resources {
		l.APIResources = append(l.APIResources, metav1.APIResource{Name: r, Namespaced: true})
	}
	return l
}

func TestDetectCilium(t *testing.T) {
	apps := &metav1.APIResourceList{GroupVersion: "apps/v1", APIResources: []metav1.APIResource{{Name: "deployments"}}}
	cases := []struct {
		name  string
		lists []*metav1.APIResourceList
		want  bool
	}{
		{"cilium installed", []*metav1.APIResourceList{apps, ciliumList("ciliumendpoints", "ciliumnetworkpolicies")}, true},
		{"no cilium (kindnet)", []*metav1.APIResourceList{apps}, false},
		{"cilium.io/v2 without the policy resource", []*metav1.APIResourceList{ciliumList("ciliumendpoints")}, false},
		{"an older group version only", []*metav1.APIResourceList{{GroupVersion: "cilium.io/v2alpha1",
			APIResources: []metav1.APIResource{{Name: "ciliumnetworkpolicies"}}}}, false},
	}
	for _, c := range cases {
		got, err := DetectCilium(fakeDiscovery(c.lists...))
		if err != nil || got != c.want {
			t.Errorf("%s: got %v, %v; want %v", c.name, got, err, c.want)
		}
	}
}

// errDiscovery answers every group version with an error.
type errDiscovery struct {
	*fakediscovery.FakeDiscovery
	err error
}

func (e errDiscovery) ServerResourcesForGroupVersion(string) (*metav1.APIResourceList, error) {
	return nil, e.err
}

func TestDetectCiliumErrors(t *testing.T) {
	notFound := apierrors.NewNotFound(schema.GroupResource{Group: "cilium.io"}, "v2")
	if got, err := DetectCilium(errDiscovery{fakeDiscovery(), notFound}); err != nil || got {
		t.Fatalf("a 404 is 'not installed': got %v, %v", got, err)
	}
	refused := errors.New("dial tcp 10.96.0.1:443: connect: connection refused")
	if _, err := DetectCilium(errDiscovery{fakeDiscovery(), refused}); err == nil {
		t.Fatal("a connection error must stay an error (unknown)")
	}
	forbidden := apierrors.NewForbidden(schema.GroupResource{}, "", errors.New("no discovery"))
	if _, err := DetectCilium(errDiscovery{fakeDiscovery(), forbidden}); err == nil {
		t.Fatal("a 403 must stay an error (unknown)")
	}
}

// switchDiscovery serves cilium or fails, as the test sets it.
type switchDiscovery struct {
	*fakediscovery.FakeDiscovery
	fail bool
}

func (s *switchDiscovery) ServerResourcesForGroupVersion(gv string) (*metav1.APIResourceList, error) {
	if s.fail {
		return nil, errors.New("timeout")
	}
	return s.FakeDiscovery.ServerResourcesForGroupVersion(gv)
}

func TestCiliumDetectorKeepsTheLastAnswer(t *testing.T) {
	d := &switchDiscovery{FakeDiscovery: fakeDiscovery(ciliumList("ciliumnetworkpolicies")), fail: true}
	det := &CiliumDetector{Discovery: d}
	det.Check()
	if det.Installed() != nil {
		t.Fatal("an error before any answer must leave it unknown")
	}
	d.fail = false
	det.Check()
	if v := det.Installed(); v == nil || !*v {
		t.Fatalf("want installed, got %v", v)
	}
	d.fail = true
	det.Check()
	if v := det.Installed(); v == nil || !*v {
		t.Fatal("a transient error must keep the last answer")
	}
	d.fail = false
	d.Resources = nil
	det.Check()
	if v := det.Installed(); v == nil || *v {
		t.Fatalf("cilium removed: want false, got %v", v)
	}
}

func TestCiliumDetectorRunChecksAtOnce(t *testing.T) {
	d := fakeDiscovery(ciliumList("ciliumnetworkpolicies"))
	det := &CiliumDetector{Discovery: d}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { det.Run(ctx, time.Hour); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for det.Installed() == nil && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if v := det.Installed(); v == nil || !*v {
		t.Fatalf("Run must check at start: got %v", v)
	}
	// Discovery only: the fake records no object reads (no Secrets, ConfigMaps or env).
	for _, a := range d.Actions() {
		if a.GetVerb() != "get" || a.GetResource().Resource != "resource" {
			t.Errorf("unexpected API call: %v", a)
		}
	}
}

func TestHeartbeatCiliumField(t *testing.T) {
	yes, no := true, false
	for _, c := range []struct {
		v    *bool
		want string
	}{{&yes, `"cilium":true`}, {&no, `"cilium":false`}, {nil, ""}} {
		b, _ := json.Marshal(sender.Capabilities{EBPF: "disabled", Cgroup: "none", Cilium: c.v})
		has := c.want != "" && strings.Contains(string(b), c.want)
		if c.want == "" && strings.Contains(string(b), "cilium") {
			t.Errorf("unknown must leave the field out: %s", b)
		} else if c.want != "" && !has {
			t.Errorf("want %s in %s", c.want, b)
		}
	}
}
