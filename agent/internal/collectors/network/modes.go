// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/collectors/runtime"
	"github.com/watchlog-light/watchlog/agent/internal/podmap"
)

// KubeNames names a pod container's flows by its workload, from the node's pod map.
func KubeNames(last func() *podmap.Map) func(Owner) (Source, bool) {
	var (
		mu   sync.Mutex
		from *podmap.Map
		idx  podmap.Index
	)
	return func(o Owner) (Source, bool) {
		mu.Lock()
		defer mu.Unlock()
		if m := last(); m != from {
			from, idx = m, nil
			if m != nil {
				idx = m.Index()
			}
		}
		p := idx[o.PodID]
		if p == nil {
			return Source{}, false
		}
		return Source{Namespace: p.Namespace, WorkloadKind: p.WorkloadKind, Workload: p.Workload}, true
	}
}

// KubeResolver refreshes the cluster-agent's IP map at most every interval and keeps
// the last one when the cluster-agent is unreachable.
func KubeResolver(fetch func(context.Context) (*podmap.IPMap, error), interval time.Duration, log *slog.Logger) func() *Resolver {
	var (
		mu      sync.Mutex
		at      time.Time
		from    *podmap.IPMap
		res     *Resolver
		lastErr string
	)
	return func() *Resolver {
		mu.Lock()
		defer mu.Unlock()
		if time.Since(at) < interval && res != nil {
			return res
		}
		at = time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		m, err := fetch(ctx)
		cancel()
		if msg := errText(err); msg != lastErr {
			lastErr = msg
			if err != nil {
				log.Warn("ip map unavailable; flow destinations use the last known map", "err", err)
			}
		}
		if m != from || res == nil {
			from, res = m, NewResolver(m, nil)
		}
		return res
	}
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// DockerNames names a container's flows by the container (and its Compose service).
func DockerNames(ids func() map[string]runtime.Identity) func(Owner) (Source, bool) {
	return func(o Owner) (Source, bool) {
		id, ok := ids()[o.ContainerID]
		if !ok {
			return Source{}, false
		}
		return Source{Container: id.Name, ComposeProject: id.ComposeProject, ComposeService: id.ComposeService}, true
	}
}

// DockerResolver resolves destinations to the host's containers by their addresses.
func DockerResolver(ids func() map[string]runtime.Identity) func() *Resolver {
	return func() *Resolver {
		byIP := map[string]string{}
		for _, id := range ids() {
			for _, ip := range id.IPs {
				byIP[ip] = id.Name
			}
		}
		return NewResolver(nil, byIP)
	}
}
