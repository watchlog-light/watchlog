// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"os"
	"path/filepath"
	"strings"
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

// The Docker-mode filter's roots (ADR-170): the cgroupfs driver's "docker" parent once
// for all its containers (Docker in Docker: the daemon's own processes sit in a sibling
// cgroup and stay out), systemd's scopes one by one (system.slice also holds the host's
// services), and nothing for a container without a cgroup.
func TestDockerRootsByDriver(t *testing.T) {
	sys := t.TempDir()
	cg := filepath.Join(sys, "fs", "cgroup")
	mk := func(rel string) {
		d := filepath.Join(cg, rel)
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "cgroup.procs"), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	a, b, c, d := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64), strings.Repeat("d", 64)
	mk("init")
	mk("docker/" + a)
	mk("docker/" + b)
	mk("system.slice/docker-" + c + ".scope")
	mk("system.slice/docker-" + d + ".scope")
	mk("system.slice/sshd.service")
	ids := map[string]uint64{}
	inode := func(dir string) (uint64, bool) {
		rel, err := filepath.Rel(cg, dir)
		if err != nil {
			return 0, false
		}
		if _, ok := ids[rel]; !ok {
			ids[rel] = uint64(len(ids) + 1)
		}
		return ids[rel], true
	}
	r := containers.NewReader(filepath.Join(sys, "proc"), sys)

	got := DockerRoots(r, []string{a, b, strings.Repeat("e", 64)}, inode)
	if len(got) != 1 || got[0] != ids["docker"] {
		t.Errorf("cgroupfs roots = %v, want only docker (%d); ids %v", got, ids["docker"], ids)
	}
	got = DockerRoots(r, []string{c, d}, inode)
	want := []uint64{ids["system.slice/docker-"+c+".scope"], ids["system.slice/docker-"+d+".scope"]}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("systemd roots = %v, want %v", got, want)
	}
	if _, ok := ids["system.slice"]; ok {
		t.Error("system.slice became a root: the host's services would be recorded")
	}
	if got := DockerRoots(r, nil, inode); len(got) != 0 {
		t.Errorf("no containers: roots %v", got)
	}
}
