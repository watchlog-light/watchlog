// SPDX-License-Identifier: AGPL-3.0-only

// Package containers reads per-container resource usage from cgroups (v2, with a
// v1 fallback) and per-container network counters from /proc (SPEC §6.3).
//
// Measured: inside the agent container (private cgroup namespace) the host's
// /proc/<pid>/cgroup shows paths relative to the agent's own cgroup
// ("0::/../docker-<id>.scope"), so cgroups are located from the container ID
// under the host sysfs mount instead.
package containers

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Stats is one container's resource usage. Pointer fields are absent when unknown.
type Stats struct {
	CPUSeconds          float64
	CPUThrottledSeconds float64
	CPULimitCores       *float64
	MemoryWorkingSet    float64
	MemoryLimit         *float64
	IOReadBytes         float64
	IOWriteBytes        float64
}

// ErrNotFound means no cgroup exists for the container (e.g. it is not running).
var ErrNotFound = errors.New("container cgroup not found")

// Reader reads cgroup and /proc files below the host mounts.
type Reader struct {
	fsys     fs.FS
	procRoot string
	cgroup   string // <sys>/fs/cgroup
}

// NewReader returns a reader for the real filesystem; relative roots are made absolute.
func NewReader(procRoot, sysRoot string) *Reader {
	proc, _ := filepath.Abs(procRoot)
	sys, _ := filepath.Abs(sysRoot)
	return &Reader{fsys: os.DirFS("/"), procRoot: proc, cgroup: filepath.Join(sys, "fs", "cgroup")}
}

func (r *Reader) rel(p string) string { return strings.TrimPrefix(filepath.Clean(p), "/") }

func (r *Reader) read(p string) (string, error) {
	b, err := fs.ReadFile(r.fsys, r.rel(p))
	return strings.TrimSpace(string(b)), err
}

func (r *Reader) exists(p string) bool {
	_, err := fs.Stat(r.fsys, r.rel(p))
	return err == nil
}

// v2Candidates are where Docker places a container's cgroup (systemd and cgroupfs drivers).
func v2Candidates(id string) []string {
	return []string{"system.slice/docker-" + id + ".scope", "docker/" + id}
}

// DockerDir is a Docker container's cgroup v2 directory, or "" when it has none.
func (r *Reader) DockerDir(id string) string {
	for _, c := range v2Candidates(id) {
		dir := filepath.Join(r.cgroup, c)
		if r.exists(filepath.Join(dir, "cgroup.procs")) {
			return dir
		}
	}
	return ""
}

// Container returns the stats of a Docker container by full ID.
func (r *Reader) Container(id string) (Stats, error) {
	if r.exists(filepath.Join(r.cgroup, "cgroup.controllers")) {
		for _, c := range v2Candidates(id) {
			dir := filepath.Join(r.cgroup, c)
			if r.exists(filepath.Join(dir, "cpu.stat")) {
				return r.readV2(dir)
			}
		}
		return Stats{}, ErrNotFound
	}
	return r.readV1([]string{"docker/" + id, "system.slice/docker-" + id + ".scope"})
}

func (r *Reader) readV2(dir string) (Stats, error) {
	var s Stats
	cpu, err := r.keyed(filepath.Join(dir, "cpu.stat"))
	if err != nil {
		return s, err
	}
	s.CPUSeconds = cpu["usage_usec"] / 1e6
	s.CPUThrottledSeconds = cpu["throttled_usec"] / 1e6

	if v, err := r.read(filepath.Join(dir, "cpu.max")); err == nil {
		// "<quota> <period>" or "max <period>"
		if f := strings.Fields(v); len(f) == 2 && f[0] != "max" {
			quota, err1 := strconv.ParseFloat(f[0], 64)
			period, err2 := strconv.ParseFloat(f[1], 64)
			if err1 == nil && err2 == nil && period > 0 {
				cores := quota / period
				s.CPULimitCores = &cores
			}
		}
	}

	current, err := r.number(filepath.Join(dir, "memory.current"))
	if err != nil {
		return s, err
	}
	mem, err := r.keyed(filepath.Join(dir, "memory.stat"))
	if err != nil {
		return s, err
	}
	// Working set as defined by cAdvisor/kubelet: usage minus inactive file cache.
	s.MemoryWorkingSet = max(0, current-mem["inactive_file"])
	if v, err := r.read(filepath.Join(dir, "memory.max")); err == nil && v != "max" {
		if limit, err := strconv.ParseFloat(v, 64); err == nil {
			s.MemoryLimit = &limit
		}
	}

	// io.stat: "<maj:min> rbytes=N wbytes=N rios=N ..." per device; empty without I/O.
	if v, err := r.read(filepath.Join(dir, "io.stat")); err == nil {
		for _, line := range strings.Split(v, "\n") {
			for _, kv := range strings.Fields(line) {
				k, val, ok := strings.Cut(kv, "=")
				if !ok {
					continue
				}
				n, err := strconv.ParseFloat(val, 64)
				if err != nil {
					continue
				}
				switch k {
				case "rbytes":
					s.IOReadBytes += n
				case "wbytes":
					s.IOWriteBytes += n
				}
			}
		}
	}
	return s, nil
}

// v1Dir finds the container's directory under one v1 controller, trying each
// candidate path relative to the controller.
func (r *Reader) v1Dir(controller string, candidates []string, probe string) (string, bool) {
	for _, c := range candidates {
		dir := filepath.Join(r.cgroup, controller, c)
		if r.exists(filepath.Join(dir, probe)) {
			return dir, true
		}
	}
	return "", false
}

// v1UnlimitedThreshold: memory.limit_in_bytes reports a page-aligned huge value when unlimited.
const v1UnlimitedThreshold = 1 << 62

func (r *Reader) readV1(candidates []string) (Stats, error) {
	var s Stats
	cpuDir, ok := r.v1Dir("cpuacct", candidates, "cpuacct.usage")
	if !ok {
		return s, ErrNotFound
	}
	usage, err := r.number(filepath.Join(cpuDir, "cpuacct.usage"))
	if err != nil {
		return s, err
	}
	s.CPUSeconds = usage / 1e9
	if dir, ok := r.v1Dir("cpu", candidates, "cpu.stat"); ok {
		if st, err := r.keyed(filepath.Join(dir, "cpu.stat")); err == nil {
			s.CPUThrottledSeconds = st["throttled_time"] / 1e9
		}
		quota, err1 := r.number(filepath.Join(dir, "cpu.cfs_quota_us"))
		period, err2 := r.number(filepath.Join(dir, "cpu.cfs_period_us"))
		if err1 == nil && err2 == nil && quota > 0 && period > 0 {
			cores := quota / period
			s.CPULimitCores = &cores
		}
	}
	if dir, ok := r.v1Dir("memory", candidates, "memory.usage_in_bytes"); ok {
		usage, err := r.number(filepath.Join(dir, "memory.usage_in_bytes"))
		if err != nil {
			return s, err
		}
		st, err := r.keyed(filepath.Join(dir, "memory.stat"))
		if err != nil {
			return s, err
		}
		s.MemoryWorkingSet = max(0, usage-st["total_inactive_file"])
		if limit, err := r.number(filepath.Join(dir, "memory.limit_in_bytes")); err == nil && limit < v1UnlimitedThreshold {
			s.MemoryLimit = &limit
		}
	}
	if dir, ok := r.v1Dir("blkio", candidates, "blkio.throttle.io_service_bytes"); ok {
		if v, err := r.read(filepath.Join(dir, "blkio.throttle.io_service_bytes")); err == nil {
			// "<maj:min> Read N" / "<maj:min> Write N" / "Total N"
			for _, line := range strings.Split(v, "\n") {
				f := strings.Fields(line)
				if len(f) != 3 {
					continue
				}
				n, err := strconv.ParseFloat(f[2], 64)
				if err != nil {
					continue
				}
				switch f[1] {
				case "Read":
					s.IOReadBytes += n
				case "Write":
					s.IOWriteBytes += n
				}
			}
		}
	}
	return s, nil
}

func (r *Reader) number(p string) (float64, error) {
	v, err := r.read(p)
	if err != nil {
		return 0, err
	}
	n, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", p, err)
	}
	return n, nil
}

// keyed parses "key value" lines (cpu.stat, memory.stat).
func (r *Reader) keyed(p string) (map[string]float64, error) {
	f, err := r.fsys.Open(r.rel(p))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return parseKeyed(f)
}

func parseKeyed(rd io.Reader) (map[string]float64, error) {
	out := map[string]float64{}
	sc := bufio.NewScanner(rd)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), " ")
		if !ok {
			continue
		}
		if n, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
			out[k] = n
		}
	}
	return out, sc.Err()
}

// Network returns a container's received and transmitted bytes over its
// interfaces (excluding loopback), read from /proc/<pid>/net/dev on the host.
func (r *Reader) Network(pid int) (rx, tx float64, err error) {
	f, err := r.fsys.Open(r.rel(filepath.Join(r.procRoot, strconv.Itoa(pid), "net", "dev")))
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok || strings.TrimSpace(name) == "lo" {
			continue
		}
		fl := strings.Fields(rest)
		if len(fl) < 9 {
			continue
		}
		in, err1 := strconv.ParseFloat(fl[0], 64)
		out, err2 := strconv.ParseFloat(fl[8], 64)
		if err1 != nil || err2 != nil {
			return 0, 0, fmt.Errorf("net/dev: bad counters for %s", name)
		}
		rx += in
		tx += out
	}
	return rx, tx, sc.Err()
}
