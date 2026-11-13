// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/watchlog-light/watchlog/agent/internal/collectors/containers"
)

// Owner is the container a cgroup belongs to: a pod container (PodID set) or a Docker
// container.
type Owner struct {
	PodID       string
	ContainerID string
}

// Inode is a cgroup v2 directory's inode: the cgroup id bpf_get_current_cgroup_id()
// returns (ADR-099).
func Inode(dir string) (uint64, bool) {
	fi, err := os.Stat(dir)
	if err != nil {
		return 0, false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return uint64(st.Ino), true //nolint:unconvert // Ino is uint32 on some platforms
}

// index maps the container cgroup and every cgroup below it (CRI-O runs container
// processes one level down, ADR-050) to its owner.
func index(out map[uint64]Owner, dir string, o Owner, inode func(string) (uint64, bool)) {
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		if strings.Count(strings.TrimPrefix(p, dir), "/") > 2 {
			return fs.SkipDir
		}
		if id, ok := inode(p); ok {
			out[id] = o
		}
		return nil
	})
}

// PodCgroups indexes the cgroups of every pod container on the node.
func PodCgroups(r *containers.Reader, inode func(string) (uint64, bool)) (map[uint64]Owner, error) {
	found, _, err := r.PodContainers()
	if err != nil {
		return nil, err
	}
	out := make(map[uint64]Owner, len(found))
	for _, pc := range found {
		if pc.Sandbox {
			continue
		}
		index(out, r.PodContainerDir(pc), Owner{PodID: pc.PodID, ContainerID: pc.ContainerID}, inode)
	}
	return out, nil
}

// DockerCgroups indexes the cgroups of the given Docker containers.
func DockerCgroups(r *containers.Reader, ids []string, inode func(string) (uint64, bool)) map[uint64]Owner {
	out := make(map[uint64]Owner, len(ids))
	for _, id := range ids {
		if dir := r.DockerDir(id); dir != "" {
			index(out, dir, Owner{ContainerID: id}, inode)
		}
	}
	return out
}

// DockerRoots are the Docker-mode filter's roots (ADR-170): the cgroups of the given
// containers, the ones this daemon runs. Under the cgroupfs driver (Docker in Docker, or
// a host without systemd) they sit in one parent named "docker" that holds containers
// only, so that parent is the root and a container started between two scans is
// recorded from its first connection. Under the systemd driver each container is a
// scope in system.slice, next to the host's own services, so each scope is a root.
func DockerRoots(r *containers.Reader, ids []string, inode func(string) (uint64, bool)) []uint64 {
	seen := map[string]bool{}
	var out []uint64
	for _, id := range ids {
		dir := r.DockerDir(id)
		if dir == "" {
			continue
		}
		if parent := filepath.Dir(dir); filepath.Base(parent) == "docker" {
			dir = parent
		}
		if seen[dir] {
			continue
		}
		seen[dir] = true
		if n, ok := inode(dir); ok {
			out = append(out, n)
		}
	}
	return out
}
