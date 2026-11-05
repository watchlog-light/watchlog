// SPDX-License-Identifier: AGPL-3.0-only

package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHostnamePrefersHostEtcHostname(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc", "hostname"), []byte("web-01\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := Hostname(HostPaths{RootFS: root}); got != "web-01" {
		t.Errorf("Hostname = %q, want web-01", got)
	}
}

func TestHostnameFallsBackToKernelHostname(t *testing.T) {
	want, _ := os.Hostname()
	if got := Hostname(HostPaths{RootFS: t.TempDir()}); got != want {
		t.Errorf("Hostname = %q, want %q", got, want)
	}
}

func TestCgroupVersion(t *testing.T) {
	root := t.TempDir()
	if got := CgroupVersion(HostPaths{Sys: root}); got != "unknown" {
		t.Errorf("empty sysfs = %s", got)
	}
	if err := os.MkdirAll(filepath.Join(root, "fs", "cgroup", "memory"), 0o750); err != nil {
		t.Fatal(err)
	}
	if got := CgroupVersion(HostPaths{Sys: root}); got != "v1" {
		t.Errorf("v1 layout = %s", got)
	}
	if err := os.WriteFile(filepath.Join(root, "fs", "cgroup", "cgroup.controllers"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := CgroupVersion(HostPaths{Sys: root}); got != "v2" {
		t.Errorf("v2 layout = %s", got)
	}
}

// Measured: busybox:1.37 on Docker 29 (Ubuntu 24.04, Lima), testdata/docker-mountinfo.txt.
func TestSelfContainerID(t *testing.T) {
	b, err := os.ReadFile("testdata/docker-mountinfo.txt")
	if err != nil {
		t.Fatal(err)
	}
	if got := SelfContainerID(string(b)); len(got) != 64 {
		t.Fatalf("SelfContainerID = %q", got)
	}
	if got := SelfContainerID("36 25 0:30 / /sys rw - sysfs sysfs rw\n"); got != "" {
		t.Fatalf("outside Docker: %q", got)
	}
}
