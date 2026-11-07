// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package ebpf

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The pod filter in the kernel (ADR-121). It loads the programs, so it needs root with
// BPF and PERFMON and a writable cgroup v2 hierarchy; it runs only with
// WATCHLOG_EBPF_KERNEL_TEST=1, e.g. in a privileged container:
//
//	docker run --rm --privileged -v "$PWD/agent:/src" -w /src -e WATCHLOG_EBPF_KERNEL_TEST=1 \
//	  golang:1.27-bookworm go test -run Kernel -v ./internal/ebpf/
//
// It checks that the cgroup id the programs record is the cgroup directory's inode (the
// key user space looks up), that a task below a root is recorded through the ancestor
// walk, and that a task outside every root is only counted.
func TestKernelPodFilter(t *testing.T) {
	if os.Getenv("WATCHLOG_EBPF_KERNEL_TEST") != "1" {
		t.Skip("set WATCHLOG_EBPF_KERNEL_TEST=1 (root, BPF, writable cgroup v2)")
	}
	if os.Getenv("WL_CHILD_CONNECT") != "" {
		return // the child process's side, run by connectFrom
	}
	f, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	self := ownCgroup(t)
	child := filepath.Join(self, "wl-podfilter-test")
	if err := os.Mkdir(child, 0o755); err != nil && !os.IsExist(err) {
		t.Fatal(err)
	}
	defer func() { _ = os.Remove(child) }()
	selfID, childID := inode(t, self), inode(t, child)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	addr := ln.Addr().String()
	port := uint16(ln.Addr().(*net.TCPAddr).Port)

	connects := func(flows []Flow, cg uint64) uint64 {
		var n uint64
		for _, fl := range flows {
			if fl.Port == port && fl.Cgroup == cg {
				n += fl.Connects
			}
		}
		return n
	}
	// One drain flips the maps and returns what was written since the last one.
	drain := func() []Flow {
		flows, err := f.Drain()
		if err != nil {
			t.Fatal(err)
		}
		return flows
	}

	// Filter on, root = this process's cgroup: the child (one level down) is recorded
	// under its own cgroup id, which is its directory's inode.
	if err := f.SetRoots([]uint64{selfID}); err != nil {
		t.Fatal(err)
	}
	if err := f.SetFilter(true); err != nil {
		t.Fatal(err)
	}
	_, _ = f.Drain()
	_, _ = f.Drain()
	connectFrom(t, child, addr, 5)
	dial(t, addr, 3)
	flows := drain()
	if got := connects(flows, childID); got != 5 {
		t.Errorf("child below the root: %d connects under its inode %d, want 5 (flows %+v)", got, childID, flows)
	}
	if got := connects(flows, selfID); got != 3 {
		t.Errorf("the root itself: %d connects, want 3", got)
	}

	// Root = the child's cgroup only: this process is outside it, counted and not recorded.
	if err := f.SetRoots([]uint64{childID}); err != nil {
		t.Fatal(err)
	}
	before, beforeDNS, _ := f.Filtered()
	dial(t, addr, 4)
	query(t, 3)
	connectFrom(t, child, addr, 2)
	flows = drain()
	after, afterDNS, _ := f.Filtered()
	if got := connects(flows, selfID); got != 0 {
		t.Errorf("outside every root: %d connects recorded, want 0", got)
	}
	if got := connects(flows, childID); got != 2 {
		t.Errorf("the root's own task: %d connects, want 2", got)
	}
	if after-before != 4 {
		t.Errorf("filtered connections +%d, want 4", after-before)
	}
	if afterDNS-beforeDNS != 3 {
		t.Errorf("filtered DNS queries +%d, want 3", afterDNS-beforeDNS)
	}
	dns, _ := f.DrainDNS()
	for _, d := range dns {
		if d.Cgroup == selfID {
			t.Errorf("DNS of a filtered task recorded: %+v", d)
		}
	}

	// Filter off: everything is recorded again.
	if err := f.SetFilter(false); err != nil {
		t.Fatal(err)
	}
	dial(t, addr, 2)
	if got := connects(drain(), selfID); got != 2 {
		t.Errorf("filter off: %d connects, want 2", got)
	}
}

// TestKernelPodFilterChild is the child process: it connects n times and exits.
func TestKernelPodFilterChild(t *testing.T) {
	addr := os.Getenv("WL_CHILD_CONNECT")
	if addr == "" {
		t.Skip("run by TestKernelPodFilter")
	}
	dial(t, addr, 0)
}

func connectFrom(t *testing.T, cgroup, addr string, n int) {
	t.Helper()
	fd, err := syscall.Open(cgroup, syscall.O_DIRECTORY|syscall.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = syscall.Close(fd) }()
	cmd := exec.Command(os.Args[0], "-test.run=^TestKernelPodFilterChild$")
	cmd.Env = append(os.Environ(), "WL_CHILD_CONNECT="+addr, "WL_CHILD_N="+strings.Repeat("x", n))
	cmd.SysProcAttr = &syscall.SysProcAttr{UseCgroupFD: true, CgroupFD: fd}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child: %v\n%s", err, out)
	}
}

// dial connects n times (in the child, len(WL_CHILD_N) times).
func dial(t *testing.T, addr string, n int) {
	t.Helper()
	if n == 0 {
		n = len(os.Getenv("WL_CHILD_N"))
	}
	for range n {
		c, err := net.DialTimeout("tcp", addr, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		_ = c.Close()
	}
	time.Sleep(20 * time.Millisecond)
}

// query sends n DNS-shaped datagrams to port 53 on loopback; nothing needs to answer.
func query(t *testing.T, n int) {
	t.Helper()
	c, err := net.Dial("udp", "127.0.0.1:53")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	for range n {
		_, _ = c.Write([]byte{0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 'x', 0, 0, 1, 0, 1})
	}
}

// ownCgroup is this process's cgroup v2 directory.
func ownCgroup(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		if rel, ok := strings.CutPrefix(line, "0::"); ok {
			return filepath.Join("/sys/fs/cgroup", rel)
		}
	}
	t.Fatal("no cgroup v2 entry in /proc/self/cgroup")
	return ""
}

func inode(t *testing.T, dir string) uint64 {
	t.Helper()
	var st syscall.Stat_t
	if err := syscall.Stat(dir, &st); err != nil {
		t.Fatal(err)
	}
	return st.Ino
}
