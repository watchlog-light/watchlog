// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"path/filepath"
	"testing"

	"github.com/watchlog-light/watchlog/agent/internal/collectors/containers"
)

const fixtures = "../containers/testdata/k8s"

// Every running pod container's cgroup id maps to its pod and container; sandboxes do
// not; CRI-O's nested "container" cgroup (where its processes run) maps too.
func TestPodCgroupsOnCapturedNodes(t *testing.T) {
	for _, node := range []string{"kind-containerd-systemd/watchlog-worker", "kubeadm-crio-systemd/lima-watchlog-crio"} {
		dir := filepath.Join(fixtures, node)
		r := containers.NewReader(filepath.Join(dir, "proc"), filepath.Join(dir, "sys"))
		idx, err := PodCgroups(r, Inode)
		if err != nil {
			t.Fatal(err)
		}
		found, _, _ := r.PodContainers()
		running := 0
		for _, pc := range found {
			id, ok := Inode(r.PodContainerDir(pc))
			if !ok {
				t.Fatalf("%s: no inode for %s", node, pc.ContainerID)
			}
			o, mapped := idx[id]
			if pc.Sandbox {
				if mapped {
					t.Errorf("%s: sandbox %s is indexed", node, pc.ContainerID[:12])
				}
				continue
			}
			running++
			if o != (Owner{PodID: pc.PodID, ContainerID: pc.ContainerID}) {
				t.Errorf("%s: %s maps to %+v", node, pc.ContainerID[:12], o)
			}
			if id, ok := Inode(filepath.Join(r.PodContainerDir(pc), "container")); ok && idx[id] != o {
				t.Errorf("%s: nested cgroup of %s not indexed", node, pc.ContainerID[:12])
			}
		}
		if running < 3 {
			t.Errorf("%s: only %d running containers", node, running)
		}
	}
}
