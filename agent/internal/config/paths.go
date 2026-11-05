// SPDX-License-Identifier: AGPL-3.0-only

package config

import (
	"os"
	"path/filepath"
	"strings"
)

// HostPaths locates the host's filesystems inside the agent container (ADR-023).
type HostPaths struct {
	Proc   string
	Sys    string
	RootFS string
}

// DefaultHostPaths are the mount points used by the install command and Helm chart.
var DefaultHostPaths = HostPaths{Proc: "/host/proc", Sys: "/host/sys", RootFS: "/host/root"}

// Hostname returns the host's name. Inside a container /proc/sys/kernel/hostname
// is the container's own name (measured), so the host's /etc/hostname is read
// from the root filesystem mount, falling back to the kernel hostname.
func Hostname(paths HostPaths) string {
	if b, err := os.ReadFile(filepath.Join(paths.RootFS, "etc", "hostname")); err == nil {
		if name := strings.TrimSpace(string(b)); name != "" {
			return name
		}
	}
	name, _ := os.Hostname()
	return name
}

// CgroupVersion reports "v2", "v1" or "unknown" from the host's sysfs mount.
func CgroupVersion(paths HostPaths) string {
	if _, err := os.Stat(filepath.Join(paths.Sys, "fs", "cgroup", "cgroup.controllers")); err == nil {
		return "v2"
	}
	if _, err := os.Stat(filepath.Join(paths.Sys, "fs", "cgroup", "memory")); err == nil {
		return "v1"
	}
	return "unknown"
}

// SelfContainerID is the agent's own Docker container ID from /proc/self/mountinfo,
// where Docker bind-mounts /etc/hostname from /var/lib/docker/containers/<id>/; empty
// outside Docker. The UI names the container in the upgrade command (ADR-107).
func SelfContainerID(mountinfo string) string {
	for _, line := range strings.Split(mountinfo, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 || f[4] != "/etc/hostname" {
			continue
		}
		dir := filepath.Base(filepath.Dir(f[3]))
		if len(dir) == 64 && strings.Trim(dir, "0123456789abcdef") == "" {
			return dir
		}
	}
	return ""
}
