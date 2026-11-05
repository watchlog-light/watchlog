// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/netip"
	"testing"

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
