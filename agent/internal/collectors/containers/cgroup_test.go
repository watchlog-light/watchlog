// SPDX-License-Identifier: AGPL-3.0-only

package containers

import (
	"errors"
	"os"
	"testing"
	"testing/fstest"
)

// Fixtures captured from Docker 29.9.2 on Ubuntu 24.04 (cgroup v2, systemd driver):
// demo-cache-1 (redis, mem_limit 128m, cpus 0.5) and demo-worker-1 (busybox writing to /tmp).
const (
	cacheID  = "0b869286b1d05b4ac849f1406237936c359e223c9fa5efc1f4cd666d4a25e100"
	workerID = "2e728c97b320e5899a75812e587dee4e2bc50be3348ce2892d43a832b97d27ad"
	cachePID = 16580
)

func v2Reader() *Reader {
	return &Reader{fsys: os.DirFS("testdata/v2"), procRoot: "/proc", cgroup: "/sys/fs/cgroup"}
}

func TestV2LimitedContainer(t *testing.T) {
	s, err := v2Reader().Container(cacheID)
	if err != nil {
		t.Fatal(err)
	}
	if s.CPUSeconds != 0.275909 || s.CPUThrottledSeconds != 0 {
		t.Errorf("cpu = %v, throttled = %v", s.CPUSeconds, s.CPUThrottledSeconds)
	}
	if s.CPULimitCores == nil || *s.CPULimitCores != 0.5 {
		t.Errorf("cpu limit = %v", s.CPULimitCores)
	}
	if s.MemoryLimit == nil || *s.MemoryLimit != 134217728 {
		t.Errorf("memory limit = %v", s.MemoryLimit)
	}
	if s.MemoryWorkingSet != 3424256 {
		t.Errorf("working set = %v", s.MemoryWorkingSet)
	}
	if s.IOReadBytes != 0 || s.IOWriteBytes != 0 {
		t.Errorf("io = %v/%v (empty io.stat)", s.IOReadBytes, s.IOWriteBytes)
	}
}

func TestV2UnlimitedContainerSubtractsInactiveFile(t *testing.T) {
	s, err := v2Reader().Container(workerID)
	if err != nil {
		t.Fatal(err)
	}
	if s.CPULimitCores != nil || s.MemoryLimit != nil {
		t.Errorf("unlimited container reported limits %v %v", s.CPULimitCores, s.MemoryLimit)
	}
	if s.MemoryWorkingSet != 17944576-16781312 {
		t.Errorf("working set = %v", s.MemoryWorkingSet)
	}
	if s.IOWriteBytes != 318767104 {
		t.Errorf("io write = %v", s.IOWriteBytes)
	}
}

func TestUnknownContainerIsNotFound(t *testing.T) {
	if _, err := v2Reader().Container("deadbeef"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v", err)
	}
}

func TestNetworkSumsNonLoopbackInterfaces(t *testing.T) {
	rx, tx, err := v2Reader().Network(cachePID)
	if err != nil || rx != 3866 || tx != 126 {
		t.Errorf("network = %v/%v, %v", rx, tx, err)
	}
	if _, _, err := v2Reader().Network(1); err == nil {
		t.Error("expected an error for a missing pid")
	}
}

// cgroup v1 fixtures: Docker 29.9.2 (cgroupfs driver) on Ubuntu 24.04 booted with
// systemd.unified_cgroup_hierarchy=0 (second Lima VM).
func v1Reader() *Reader {
	return &Reader{fsys: os.DirFS("testdata/v1"), procRoot: "/proc", cgroup: "/sys/fs/cgroup"}
}

func TestV1LimitedContainer(t *testing.T) {
	s, err := v1Reader().Container("667b8efa27ae05d39c4a07d2e34c13174b73851c17a93ee92c47b60e94f814da")
	if err != nil {
		t.Fatal(err)
	}
	if s.CPUSeconds != 0.1351755 || s.CPULimitCores == nil || *s.CPULimitCores != 0.5 {
		t.Errorf("cpu = %v limit %v", s.CPUSeconds, s.CPULimitCores)
	}
	if s.MemoryLimit == nil || *s.MemoryLimit != 134217728 || s.MemoryWorkingSet != 3854336 {
		t.Errorf("memory = %v limit %v", s.MemoryWorkingSet, s.MemoryLimit)
	}
}

func TestV1UnlimitedWriterCountsOnlyReadAndWrite(t *testing.T) {
	s, err := v1Reader().Container("64acbd619cb89490169f2f95de220039fbcfdb1d934523244ab23466eb344c1d")
	if err != nil {
		t.Fatal(err)
	}
	if s.MemoryLimit != nil || s.CPULimitCores != nil {
		t.Errorf("unlimited container reported limits %v %v", s.MemoryLimit, s.CPULimitCores)
	}
	// blkio also lists Sync/Async/Total lines; they must not be double counted.
	if s.IOWriteBytes != 110100480 || s.IOReadBytes != 0 {
		t.Errorf("io = %v/%v", s.IOReadBytes, s.IOWriteBytes)
	}
}

func TestV1ThrottlingFromSyntheticCpuStat(t *testing.T) {
	const id = "abc123"
	base := "sys/fs/cgroup/"
	r := &Reader{procRoot: "/proc", cgroup: "/sys/fs/cgroup", fsys: fstest.MapFS{
		base + "cpuacct/docker/" + id + "/cpuacct.usage": {Data: []byte("2500000000\n")},
		base + "cpu/docker/" + id + "/cpu.stat":          {Data: []byte("nr_periods 10\nnr_throttled 2\nthrottled_time 500000000\n")},
	}}
	s, err := r.Container(id)
	if err != nil || s.CPUSeconds != 2.5 || s.CPUThrottledSeconds != 0.5 {
		t.Errorf("stats = %+v, %v", s, err)
	}
}
