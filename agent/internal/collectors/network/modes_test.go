// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/netip"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/collectors/runtime"
	"github.com/watchlog-light/watchlog/agent/internal/podmap"
)

func TestKubeNamesFollowThePodMap(t *testing.T) {
	m := &podmap.Map{Pods: []podmap.Pod{{ID: "uid-1", Namespace: "shop", Name: "web-1", WorkloadKind: "Deployment", Workload: "web"}}}
	names := KubeNames(func() *podmap.Map { return m })
	if s, ok := names(Owner{PodID: "uid-1"}); !ok || s != (Source{Namespace: "shop", WorkloadKind: "Deployment", Workload: "web"}) {
		t.Errorf("%+v %v", s, ok)
	}
	if _, ok := names(Owner{PodID: "uid-2"}); ok {
		t.Error("unknown pod named")
	}
	m = &podmap.Map{Pods: []podmap.Pod{{ID: "uid-2", Namespace: "shop", WorkloadKind: "Pod", Workload: "job"}}}
	if _, ok := names(Owner{PodID: "uid-2"}); !ok {
		t.Error("a new map is not used")
	}
}

func TestKubeResolverKeepsTheLastMap(t *testing.T) {
	calls := 0
	fetch := func(context.Context) (*podmap.IPMap, error) {
		calls++
		if calls > 1 {
			return ipmap, errors.New("cluster-agent unreachable") // the client returns its last map
		}
		return ipmap, nil
	}
	res := KubeResolver(fetch, 0, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for range 2 {
		if d, ok := res().Resolve(netip.MustParseAddr("10.244.1.5"), 80); !ok || d.Workload != "api" {
			t.Fatalf("%+v", d)
		}
	}
}

func TestDockerNamesAndAddresses(t *testing.T) {
	ids := func() map[string]runtime.Identity {
		return map[string]runtime.Identity{
			"c1": {Name: "demo-web-1", ComposeProject: "demo", ComposeService: "web", IPs: []string{"172.18.0.2"}},
			"c2": {Name: "demo-cache-1", ComposeProject: "demo", ComposeService: "cache", IPs: []string{"172.18.0.4"}},
		}
	}
	if s, ok := DockerNames(ids)(Owner{ContainerID: "c1"}); !ok || s.Container != "demo-web-1" || s.ComposeService != "web" {
		t.Errorf("%+v", s)
	}
	if d, _ := DockerResolver(ids)().Resolve(netip.MustParseAddr("172.18.0.4"), 6379); d.Kind != DstContainer || d.Name != "demo-cache-1" {
		t.Errorf("%+v", d)
	}
}

// Before the first IP map (the agent started before the cluster-agent answers), the
// cluster's private addresses are unresolved, never externals: seen on kind after a
// reboot as "10.244.2.0/24:5432", "10.96.0.0/24:443" and "172.18.0.0/24:6443".
func TestKubeResolverBeforeTheFirstMap(t *testing.T) {
	var m *podmap.IPMap
	fetch := func(context.Context) (*podmap.IPMap, error) {
		if m == nil {
			return nil, errors.New("no such host")
		}
		return m, nil
	}
	res := KubeResolver(fetch, 0, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, addr := range []string{"10.244.1.5", "10.96.0.1", "172.18.0.2", "192.168.5.2", "100.64.3.4", "fd00::5"} {
		if d, ok := res().Resolve(netip.MustParseAddr(addr), 443); !ok || d.Kind != dstUnresolved {
			t.Errorf("%s before the map: %+v %v, want unresolved", addr, d, ok)
		}
	}
	if d, _ := res().Resolve(netip.MustParseAddr("203.0.113.7"), 443); d.Kind != DstExternal || d.Name != "203.0.113.0/24" {
		t.Errorf("a public address before the map: %+v, want external", d)
	}
	m = ipmap
	if d, _ := res().Resolve(netip.MustParseAddr("10.244.1.5"), 80); d.Kind != DstWorkload || d.Workload != "api" {
		t.Errorf("after the map: %+v", d)
	}
	// With a map, an address it doesn't have is an external (a database outside the
	// cluster), private or not.
	if d, _ := res().Resolve(netip.MustParseAddr("10.0.5.9"), 5432); d.Kind != DstExternal || d.Name != "10.0.5.0/24" {
		t.Errorf("unknown private address with a map: %+v", d)
	}
}

// A pod that leaves the map (scaled to 0, deleted) keeps its workload for a client
// still dialling its address, until another pod takes the address.
func TestKubeResolverRemembersDepartedPods(t *testing.T) {
	m := ipmap
	res := KubeResolver(func(context.Context) (*podmap.IPMap, error) { return m, nil }, 0,
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	_ = res()
	m = &podmap.IPMap{Pods: []podmap.IPPod{}}
	if d, _ := res().Resolve(netip.MustParseAddr("10.244.1.5"), 9898); d.Kind != DstWorkload || d.Workload != "api" || d.Port != 9898 {
		t.Errorf("departed pod: %+v", d)
	}
	if d, _ := res().Resolve(netip.MustParseAddr("10.96.0.30"), 80); d.Kind != DstService || d.Service != "mixed" {
		t.Errorf("departed Service: %+v", d)
	}
	m = &podmap.IPMap{Pods: []podmap.IPPod{{IP: "10.244.1.5", Namespace: "shop", WorkloadKind: "Deployment", Workload: "cart"}}}
	if d, _ := res().Resolve(netip.MustParseAddr("10.244.1.5"), 80); d.Workload != "cart" {
		t.Errorf("reused address: %+v, want the new pod's workload", d)
	}
}

// A stopped container's address keeps its name: a client still dialling it fails to
// reach that container ("web → api", failing), not an external named "api". Another
// container taking the address wins; after departedTTL it is an external.
func TestDockerResolverRemembersStoppedContainers(t *testing.T) {
	running := map[string]runtime.Identity{
		"c1": {Name: "causes-e2e-web-1", IPs: []string{"172.23.0.5"}},
		"c2": {Name: "causes-e2e-api-1", IPs: []string{"172.23.0.6"}},
	}
	ids := running
	now := time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)
	res := dockerResolver(func() map[string]runtime.Identity { return ids }, func() time.Time { return now })
	api := netip.MustParseAddr("172.23.0.6")
	_ = res()
	// docker stop: the container is listed without an address.
	ids = map[string]runtime.Identity{"c1": running["c1"], "c2": {Name: "causes-e2e-api-1"}}
	for range 3 {
		now = now.Add(15 * time.Second)
		if d, _ := res().Resolve(api, 9898); d.Kind != DstContainer || d.Name != "causes-e2e-api-1" {
			t.Fatalf("stopped container: %+v", d)
		}
	}
	now = now.Add(departedTTL)
	if d, _ := res().Resolve(api, 9898); d.Kind != DstExternal {
		t.Errorf("after departedTTL: %+v, want external", d)
	}
	ids = map[string]runtime.Identity{"c3": {Name: "other-1", IPs: []string{"172.23.0.6"}}}
	if d, _ := res().Resolve(api, 9898); d.Name != "other-1" {
		t.Errorf("reused address: %+v", d)
	}
}
