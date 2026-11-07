// SPDX-License-Identifier: AGPL-3.0-only

package host

import (
	"os"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

// A kind node limited with `docker update --cpus 2 --memory 3g`, as the node agent sees
// it: the node container's cgroup at the root of its cgroup namespace, the host's
// /proc/stat and /proc/meminfo (16 CPUs, 61 GiB), the node's PID 1 and network namespace.
func kindNode() fstest.MapFS {
	cpuLines := "cpu  100 0 50 1000 0 0 0 0 0 0\n"
	for i := range 16 {
		cpuLines += "cpu" + string(rune('a'+i)) + " 1 0 1 1 0 0 0 0 0 0\n"
	}
	return fstest.MapFS{
		"rootfs/.dockerenv":                   {},
		"sys/fs/cgroup/cgroup.controllers":    {Data: []byte("cpuset cpu io memory pids\n")},
		"sys/fs/cgroup/cpu.max":               {Data: []byte("200000 100000\n")},
		"sys/fs/cgroup/cpuset.cpus.effective": {Data: []byte("0-15\n")},
		"sys/fs/cgroup/cpu.stat":              {Data: []byte("usage_usec 30000000\nuser_usec 20000000\nsystem_usec 10000000\nnr_periods 10\n")},
		"sys/fs/cgroup/memory.max":            {Data: []byte("3221225472\n")},
		"sys/fs/cgroup/memory.current":        {Data: []byte("1073741824\n")},
		"sys/fs/cgroup/memory.stat":           {Data: []byte("anon 600000000\nfile 400000000\ninactive_file 73741824\n")},
		"sys/fs/cgroup/io.stat":               {Data: []byte("254:0 rbytes=1000 wbytes=2000 rios=1 wios=2 dbytes=0 dios=0\n7:1 rbytes=24 wbytes=0 rios=1 wios=0 dbytes=0 dios=0\n")},
		"proc/stat":                           {Data: []byte(cpuLines + "btime 1762560000\n")},
		"proc/meminfo":                        {Data: []byte("MemTotal:       64000000 kB\nMemAvailable:   60000000 kB\n")},
		"proc/loadavg":                        {Data: []byte("9.00 8.00 7.00 1/100 1\n")},
		"proc/diskstats":                      {Data: []byte(" 254       0 vda 1 0 2 0 3 0 4 0 0 0 0\n")},
		"proc/1/stat":                         {Data: []byte("1 (systemd) S 0 1 1 0 -1 4194560 1 1 0 0 0 0 0 0 20 0 1 0 360000 1000 10\n")},
		"proc/1/mountinfo":                    {Data: []byte("1 0 254:1 / / rw - ext4 /dev/vda1 rw\n")},
		"proc/1/net/dev":                      {Data: []byte("Inter-|\n face |\n    lo: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\n  eth0: 500 0 0 0 0 0 0 0 700 0 0 0 0 0 0 0\nvethab12: 9 0 0 0 0 0 0 0 9 0 0 0 0 0 0 0\n")},
	}
}

func cgroupCollector(fsys fstest.MapFS, scope string) *Collector {
	c := New(Config{ProcRoot: "/proc", SysRoot: "/sys", RootFS: "/rootfs", Scope: scope})
	c.fsys = fsys
	c.statfs = func(string) (fsUsage, error) { return fsUsage{size: 1e12, free: 5e11, avail: 5e11}, nil }
	return c
}

func TestCgroupScopeReportsTheNodeNotTheHost(t *testing.T) {
	c := cgroupCollector(kindNode(), ScopeCgroup)
	now := time.Unix(1762560000+3600+60, 0) // the node started at btime + 3600 s
	c.now = func() time.Time { return now }
	samples, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	got := index(samples)
	want := map[string]float64{
		"watchlog_node_cpu_count{}":                            2,
		"watchlog_node_cpu_seconds_total{mode=user}":           20,
		"watchlog_node_cpu_seconds_total{mode=system}":         10,
		"watchlog_node_cpu_seconds_total{mode=idle}":           2*60 - 30, // 2 cores × 60 s since start − usage
		"watchlog_node_memory_bytes{state=total}":              3 << 30,
		"watchlog_node_memory_bytes{state=available}":          3<<30 - (1<<30 - 73741824),
		"watchlog_node_memory_bytes{state=free}":               2 << 30,
		"watchlog_node_memory_bytes{state=cached}":             400000000,
		"watchlog_node_disk_io_bytes_total{dev=all,dir=read}":  1024,
		"watchlog_node_disk_io_bytes_total{dev=all,dir=write}": 2000,
		"watchlog_node_network_bytes_total{iface=eth0,dir=rx}": 500,
		"watchlog_node_network_bytes_total{iface=eth0,dir=tx}": 700,
		"watchlog_node_boot_time_seconds{}":                    1762560000 + 3600,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
	if len(got) != len(want) {
		t.Errorf("got %d series, want %d: %v", len(got), len(want), got)
	}
	for k := range got {
		for _, host := range []string{"load", "filesystem", "vda", "veth", "lo,"} {
			if strings.Contains(k, host) {
				t.Errorf("host series %s in cgroup scope", k)
			}
		}
	}
	cores, mem, ok := c.Capacity()
	if !ok || cores != 2 || mem != 3<<30 {
		t.Errorf("capacity = %v, %v, %v", cores, mem, ok)
	}

	// The next scrape: 15 s, 3 s of CPU used. Idle grows by 2×15 − 3 = 27 s, so the
	// backend's non-idle / all modes is 3 / 30 = 10 % of the node's 2 cores.
	fsys := kindNode()
	fsys["sys/fs/cgroup/cpu.stat"] = &fstest.MapFile{Data: []byte("usage_usec 33000000\nuser_usec 22000000\nsystem_usec 11000000\n")}
	c.fsys = fsys
	now = now.Add(15 * time.Second)
	samples, _ = c.Collect()
	if v := index(samples)["watchlog_node_cpu_seconds_total{mode=idle}"]; v != 90+27 {
		t.Errorf("idle = %v, want 117", v)
	}
	// Usage above the limit for a moment (a burst within one period) never makes idle
	// go backwards.
	fsys["sys/fs/cgroup/cpu.stat"] = &fstest.MapFile{Data: []byte("usage_usec 70000000\nuser_usec 50000000\nsystem_usec 20000000\n")}
	now = now.Add(15 * time.Second)
	samples, _ = c.Collect()
	if v := index(samples)["watchlog_node_cpu_seconds_total{mode=idle}"]; v != 117 {
		t.Errorf("idle = %v, want 117 (unchanged)", v)
	}
}

// No CPU quota: the cpuset's size. No memory limit: the host's total.
func TestCgroupScopeWithoutLimits(t *testing.T) {
	fsys := kindNode()
	fsys["sys/fs/cgroup/cpu.max"] = &fstest.MapFile{Data: []byte("max 100000\n")}
	fsys["sys/fs/cgroup/cpuset.cpus.effective"] = &fstest.MapFile{Data: []byte("0-3,8,10-11\n")}
	fsys["sys/fs/cgroup/memory.max"] = &fstest.MapFile{Data: []byte("max\n")}
	c := cgroupCollector(fsys, ScopeCgroup)
	samples, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	got := index(samples)
	if got["watchlog_node_cpu_count{}"] != 7 {
		t.Errorf("cpu count = %v, want 7", got["watchlog_node_cpu_count{}"])
	}
	if got["watchlog_node_memory_bytes{state=total}"] != 64000000*1024 || !c.MemoryFromHost() {
		t.Errorf("memory total = %v (from host %v), want the host's", got["watchlog_node_memory_bytes{state=total}"], c.MemoryFromHost())
	}
}

func TestDetectScope(t *testing.T) {
	cases := map[string]struct {
		edit func(fstest.MapFS)
		want string
	}{
		"docker node": {func(fstest.MapFS) {}, ScopeCgroup},
		"podman node": {func(f fstest.MapFS) {
			delete(f, "rootfs/.dockerenv")
			f["rootfs/run/.containerenv"] = &fstest.MapFile{}
		}, ScopeCgroup},
		"limited cgroup root, no marker": {func(f fstest.MapFS) { delete(f, "rootfs/.dockerenv") }, ScopeCgroup},
		"a real host": {func(f fstest.MapFS) {
			delete(f, "rootfs/.dockerenv")
			delete(f, "sys/fs/cgroup/cpu.max")
			delete(f, "sys/fs/cgroup/memory.max")
		}, ScopeHost},
		"cgroup v1 host": {func(f fstest.MapFS) {
			delete(f, "rootfs/.dockerenv")
			delete(f, "sys/fs/cgroup/cgroup.controllers")
		}, ScopeHost},
	}
	for name, tc := range cases {
		fsys := kindNode()
		tc.edit(fsys)
		c := cgroupCollector(fsys, ScopeAuto)
		if got, why := detect(c); got != tc.want {
			t.Errorf("%s: %s (%s), want %s", name, got, why, tc.want)
		}
	}
	if _, err := ParseScope("container"); err == nil {
		t.Error("ParseScope accepted container")
	}
}

func TestCpusetSize(t *testing.T) {
	for in, want := range map[string]int{"0": 1, "0-15": 16, "0-3,8,10-11": 7, "": 0} {
		if got, err := cpusetSize(in); err != nil || got != want {
			t.Errorf("%q = %d, %v; want %d", in, got, err, want)
		}
	}
	if _, err := cpusetSize("3-1"); err == nil {
		t.Error("3-1 accepted")
	}
}

// One cgroup-scope scrape: cpu.stat, memory, io.stat, net/dev and the node's start.
func BenchmarkCollectCgroup(b *testing.B) {
	c := cgroupCollector(kindNode(), ScopeCgroup)
	b.ReportAllocs()
	for b.Loop() {
		if _, err := c.Collect(); err != nil {
			b.Fatal(err)
		}
	}
}

// testdata/kind-node-cgroup: a kind worker node (kind v0.33, Kubernetes 1.37, cgroup v2)
// limited with `docker update --cpus 2 --memory 3g` on an Ubuntu 24.04 arm64 VM with
// 4 CPUs and 6 GiB (kernel 6.8), as the node agent sees it: the node container's cgroup
// at the root of its cgroup namespace, the kernel's /proc files and the node's PID 1.
// The node container started at 1794090557 (docker inspect). Only the node container's
// figures may come out, none of the VM's (4 CPUs, 6 GiB, load, vda, its boot).
func TestCgroupScopeOnACapturedKindNode(t *testing.T) {
	c := New(Config{ProcRoot: "/proc", SysRoot: "/sys", RootFS: "/rootfs", Scope: ScopeCgroup})
	c.fsys = os.DirFS("testdata/kind-node-cgroup")
	c.now = func() time.Time { return time.Unix(1794090688, 0) } // captured at
	samples, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	got := index(samples)
	if got["watchlog_node_cpu_count{}"] != 2 {
		t.Errorf("cpu count = %v, want the container's 2 (the VM has 4)", got["watchlog_node_cpu_count{}"])
	}
	if got["watchlog_node_memory_bytes{state=total}"] != 3<<30 {
		t.Errorf("memory total = %v, want 3 GiB (the VM has 6)", got["watchlog_node_memory_bytes{state=total}"])
	}
	if a := got["watchlog_node_memory_bytes{state=available}"]; a <= 0 || a >= 3<<30 {
		t.Errorf("memory available = %v", a)
	}
	if b := got["watchlog_node_boot_time_seconds{}"]; b < 1794090556 || b > 1794090558 {
		t.Errorf("boot time = %v, want the node container's start 1794090557 (the VM booted at 1794090403)", b)
	}
	// Idle so far: 2 cores × (captured − started) − usage.
	if idle := got["watchlog_node_cpu_seconds_total{mode=idle}"]; idle < 200 || idle > 2*132 {
		t.Errorf("idle = %v", idle)
	}
	for k := range got {
		for _, host := range []string{"load", "filesystem", "vda", "veth", "iface=lo"} {
			if strings.Contains(k, host) {
				t.Errorf("host series %s", k)
			}
		}
	}
	if _, ok := got["watchlog_node_disk_io_bytes_total{dev=all,dir=write}"]; !ok {
		t.Error("no block I/O")
	}
	if got, why := detect(c); got != ScopeCgroup {
		t.Errorf("detect = %s (%s)", got, why)
	}
}
