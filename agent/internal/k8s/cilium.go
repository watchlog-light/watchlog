// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/discovery"
)

// Cilium detection (ADR-191): the API server's discovery endpoint says whether the
// group version cilium.io/v2 serves ciliumnetworkpolicies. Discovery is readable by
// every authenticated ServiceAccount (system:discovery): no RBAC change, no informer,
// no object read. The backend uses it to put the Cilium flavour of the egress policy
// suggestion first (ADR-190).
const (
	CiliumGroupVersion = "cilium.io/v2"
	ciliumPolicies     = "ciliumnetworkpolicies"
	// CiliumRecheck is how often the cluster-agent asks again (ADR-191: every 10 minutes).
	CiliumRecheck = 10 * time.Minute
)

// DetectCilium asks discovery once. A group version the server doesn't serve is
// "not installed" (false, nil); any other error leaves the answer unknown (the error).
func DetectCilium(d discovery.ServerResourcesInterface) (bool, error) {
	list, err := d.ServerResourcesForGroupVersion(CiliumGroupVersion)
	if err != nil {
		if apierrors.IsNotFound(err) {
			return false, nil
		}
		return false, err
	}
	if list == nil {
		return false, nil
	}
	for _, r := range list.APIResources {
		if r.Name == ciliumPolicies {
			return true, nil
		}
	}
	return false, nil
}

// CiliumDetector keeps the last answer for the heartbeat's capabilities.
type CiliumDetector struct {
	Discovery discovery.ServerResourcesInterface
	Log       *slog.Logger
	// state: 0 unknown, 1 not installed, 2 installed.
	state atomic.Int32
}

// Check asks discovery and keeps the answer; an error keeps the previous one (a
// transient error must not flip a known answer), and the first error leaves it unknown.
func (c *CiliumDetector) Check() {
	ok, err := DetectCilium(c.Discovery)
	if err != nil {
		if c.Log != nil {
			c.Log.Warn("cilium detection: discovery failed; keeping the last answer", "err", err)
		}
		return
	}
	if ok {
		c.state.Store(2)
	} else {
		c.state.Store(1)
	}
}

// Installed is nil while unknown, else whether cilium.io/v2 serves ciliumnetworkpolicies.
func (c *CiliumDetector) Installed() *bool {
	switch c.state.Load() {
	case 1:
		v := false
		return &v
	case 2:
		v := true
		return &v
	}
	return nil
}

// Run checks now and every interval until ctx ends.
func (c *CiliumDetector) Run(ctx context.Context, interval time.Duration) {
	c.Check()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.Check()
		}
	}
}
