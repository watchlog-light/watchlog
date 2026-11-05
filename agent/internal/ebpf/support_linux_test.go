// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package ebpf

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Each reason a node cannot run the programs is said in words (ADR-102).
func TestCheckSupportReasons(t *testing.T) {
	sys := t.TempDir()
	if s := CheckSupport("5.4.0-1103-aws", sys); s.OK || !strings.Contains(s.Reason, "kernel 5.4 is older than 5.8") {
		t.Errorf("old kernel: %+v", s)
	}
	if s := CheckSupport("6.8.0", sys); s.OK || !strings.Contains(s.Reason, "no BTF") {
		t.Errorf("no BTF: %+v", s)
	}
	if err := os.MkdirAll(filepath.Join(sys, "kernel/btf"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sys, "kernel/btf/vmlinux"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	// A temp dir is not a cgroup2 mount: treated like cgroup v1.
	if s := CheckSupport("6.8.0", sys); s.OK || !strings.Contains(s.Reason, "cgroup v1") {
		t.Errorf("cgroup v1: %+v", s)
	}
	if s := CheckSupport("garbage", sys); s.OK || !strings.Contains(s.Reason, "unknown kernel") {
		t.Errorf("unknown: %+v", s)
	}
}
