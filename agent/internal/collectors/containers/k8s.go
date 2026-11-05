// SPDX-License-Identifier: AGPL-3.0-only

package containers

import (
	"errors"
	"io/fs"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// PodContainer is a container cgroup below the kubelet's kubepods hierarchy
// (ADR-050). Pod ID and container ID come from the cgroup path only; names are
// resolved elsewhere (ADR-049) and neither value is ever used as a label.
type PodContainer struct {
	// PodID is the pod's metadata.uid (with dashes) or, for a static pod, the
	// kubelet's config hash (32 hex characters), which the API server shows as the
	// mirror pod's annotation kubernetes.io/config.mirror (measured on kind).
	PodID       string
	QoS         string // guaranteed, burstable or besteffort
	ContainerID string // 64 hex characters, without the runtime prefix
	Runtime     string // containerd, crio, docker; empty for the cgroupfs driver
	// Sandbox is a cgroup without workload: the pod's infrastructure container
	// ("pause"), CRI-O's process-less sandbox cgroup, or a container that has exited.
	// It gets no metrics and is never counted as unmapped.
	Sandbox bool

	rel string // path below the cgroup root (v2) or below each v1 controller
	v1  bool
}

var (
	// Pod segment: systemd "kubepods-burstable-pod<uid with _>.slice" (kind adds a
	// "kubelet-" prefix) or cgroupfs "pod<uid>"; static pods use a 32-hex config hash.
	podSegment = regexp.MustCompile(`(?:^|-)pod([0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12}|[0-9a-f]{32})(?:\.slice)?$`)
	// Container segment: systemd "<runtime>-<id>.scope" or cgroupfs "<id>".
	containerSegment = regexp.MustCompile(`^(?:(cri-containerd|crio|docker)-)?([0-9a-f]{64})(?:\.scope)?$`)
)

var runtimeNames = map[string]string{"cri-containerd": "containerd", "crio": "crio", "docker": "docker"}

// parsePodContainer recognises a container cgroup path (relative to the cgroup root
// or a v1 controller). ok is false for anything else, including pod and QoS slices.
func parsePodContainer(rel string) (pc PodContainer, ok bool) {
	segs := strings.Split(rel, "/")
	if len(segs) < 2 {
		return pc, false
	}
	m := containerSegment.FindStringSubmatch(segs[len(segs)-1])
	if m == nil {
		return pc, false
	}
	p := podSegment.FindStringSubmatch(segs[len(segs)-2])
	if p == nil {
		return pc, false
	}
	pc = PodContainer{PodID: strings.ReplaceAll(p[1], "_", "-"), ContainerID: m[2], Runtime: runtimeNames[m[1]],
		QoS: "guaranteed", rel: rel}
	for _, s := range segs[:len(segs)-2] {
		switch {
		case strings.Contains(s, "burstable"):
			pc.QoS = "burstable"
		case strings.Contains(s, "besteffort"):
			pc.QoS = "besteffort"
		}
	}
	return pc, true
}

// anyContainerID finds a container ID in a cgroup directory name of an unknown layout.
var anyContainerID = regexp.MustCompile(`[0-9a-f]{64}`)

// PodContainers lists the container cgroups of all pods on this node. Cgroups below
// kubepods that carry a container ID but match no captured layout (ADR-050) are
// returned as unrecognized IDs: never labelled, counted by the caller.
func (r *Reader) PodContainers() ([]PodContainer, []string, error) {
	root, v1 := r.cgroup, false
	if !r.exists(path.Join(r.cgroup, "cgroup.controllers")) {
		// cgroup v1: discover under cpuacct, read every controller at the same path.
		root, v1 = path.Join(r.cgroup, "cpuacct"), true
	}
	var out []PodContainer
	var unrecognized []string
	base := r.rel(root)
	err := fs.WalkDir(r.fsys, base, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == base {
				return err
			}
			return nil // a cgroup removed while walking
		}
		if !d.IsDir() || p == base {
			return nil
		}
		rel := strings.TrimPrefix(p, base+"/")
		if !strings.Contains(rel, "kubepods") {
			// kubepods sits at the top (kubepods.slice, kubepods) or one level down
			// (kind: kubelet.slice/kubelet-kubepods.slice); skip the rest of the tree.
			if strings.Count(rel, "/") >= 1 {
				return fs.SkipDir
			}
			return nil
		}
		if pc, ok := parsePodContainer(rel); ok {
			pc.v1 = v1
			pc.Sandbox = r.isSandbox(path.Join(root, rel))
			out = append(out, pc)
			return fs.SkipDir
		}
		if id := anyContainerID.FindString(d.Name()); id != "" {
			unrecognized = append(unrecognized, id)
			return fs.SkipDir
		}
		return nil
	})
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil, nil // no kubepods on this host
	}
	return out, unrecognized, err
}

// PodContainerDir is the container's cgroup directory (cgroup v2: its inode is the
// cgroup id that eBPF programs see, ADR-099).
func (r *Reader) PodContainerDir(pc PodContainer) string { return path.Join(r.cgroup, pc.rel) }

// isSandbox reports whether a container cgroup runs no workload. Measured on the
// captured layouts: containerd and Docker sandboxes run "pause"; CRI-O 1.36 sandbox
// cgroups ("crio-<id>", no ".scope") hold no process at all, and CRI-O container
// processes sit one level down ("crio-<id>.scope/container").
func (r *Reader) isSandbox(dir string) bool {
	pid, ok := r.firstPID(dir, 2)
	if !ok {
		return true
	}
	comm, err := r.read(path.Join(r.procRoot, strconv.Itoa(pid), "comm"))
	return err == nil && comm == "pause"
}

// firstPID returns a process of the cgroup or of its descendants (up to depth levels).
func (r *Reader) firstPID(dir string, depth int) (int, bool) {
	if procs, err := r.read(path.Join(dir, "cgroup.procs")); err == nil && procs != "" {
		if pid, err := strconv.Atoi(strings.Fields(procs)[0]); err == nil {
			return pid, true
		}
	}
	if depth == 0 {
		return 0, false
	}
	entries, err := fs.ReadDir(r.fsys, r.rel(dir))
	if err != nil {
		return 0, false
	}
	for _, e := range entries {
		if e.IsDir() {
			if pid, ok := r.firstPID(path.Join(dir, e.Name()), depth-1); ok {
				return pid, true
			}
		}
	}
	return 0, false
}

// PodContainerStats reads the usage of a container found by PodContainers.
func (r *Reader) PodContainerStats(pc PodContainer) (Stats, error) {
	if pc.v1 {
		return r.readV1([]string{pc.rel})
	}
	dir := path.Join(r.cgroup, pc.rel)
	if !r.exists(path.Join(dir, "cpu.stat")) {
		return Stats{}, ErrNotFound
	}
	return r.readV2(dir)
}
