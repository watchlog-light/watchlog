// SPDX-License-Identifier: AGPL-3.0-only

package host

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Scopes of the node metrics (ADR-121).
const (
	// ScopeHost reads the kernel's host-wide files: /proc/stat, /proc/meminfo,
	// /proc/loadavg, /proc/diskstats and statfs.
	ScopeHost = "host"
	// ScopeCgroup reads the node's own cgroup, for nodes that are containers on a
	// shared kernel (kind, k3d): nothing about the host is reported.
	ScopeCgroup = "cgroup"
	// ScopeAuto picks cgroup when the node looks like a container (DetectScope).
	ScopeAuto = "auto"
)

// ParseScope checks a --node-metrics-scope value.
func ParseScope(s string) (string, error) {
	switch s {
	case ScopeHost, ScopeCgroup, ScopeAuto:
		return s, nil
	case "":
		return ScopeAuto, nil
	}
	return "", fmt.Errorf("invalid node metrics scope %q: use host, cgroup or auto", s)
}

// DetectScope decides auto: cgroup when the node is itself a container. Only files
// are read, never another process's environment:
//   - the node's root filesystem has /.dockerenv (Docker, so kind and k3d),
//     /run/.containerenv (Podman) or /kind (kind's node image);
//   - the cgroup v2 hierarchy the agent sees is not the kernel's root: only non-root
//     cgroups have cpu.max and memory.max, so the node runs in a cgroup namespace below
//     the root (a container, an LXC guest).
//
// It returns the scope and the signal that decided it.
func DetectScope(cfg Config) (string, string) { return detect(New(cfg)) }

func detect(c *Collector) (string, string) {
	for _, marker := range []string{".dockerenv", "run/.containerenv", "kind"} {
		if c.exists(filepath.Join(c.cfg.RootFS, marker)) {
			return ScopeCgroup, "/" + marker + " in the node's root filesystem"
		}
	}
	cg := c.cgroupDir()
	if c.exists(filepath.Join(cg, "cgroup.controllers")) {
		for _, f := range []string{"cpu.max", "memory.max"} {
			if c.exists(filepath.Join(cg, f)) {
				return ScopeCgroup, "the node's cgroup root has " + f + " (not the kernel's root cgroup)"
			}
		}
	}
	return ScopeHost, "no container signal"
}

func (c *Collector) exists(p string) bool {
	_, err := fs.Stat(c.fsys, strings.TrimPrefix(filepath.Clean(p), "/"))
	return err == nil
}

func (c *Collector) cgroupDir() string { return filepath.Join(c.cfg.SysRoot, "fs", "cgroup") }

func (c *Collector) readFile(p string) (string, error) {
	f, err := c.open(p)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(f)
	return strings.TrimSpace(string(b)), err
}

// cgroupState is what the cgroup scope keeps between scrapes: the idle counter it
// builds and the capacity it last measured.
type cgroupState struct {
	idle     float64
	usage    float64
	at       time.Time
	cores    float64
	memTotal float64
	// memFromHost: memory.max is "max", so the total is the host's memory.
	memFromHost bool
}

// Capacity is the node's CPU count and memory total measured in cgroup scope, for the
// heartbeat (ADR-121); ok is false in host scope or before the first scrape.
func (c *Collector) Capacity() (cores, memoryBytes float64, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cfg.Scope != ScopeCgroup || c.cg.cores == 0 || c.cg.memTotal == 0 {
		return 0, 0, false
	}
	return c.cg.cores, c.cg.memTotal, true
}

// collectCgroup is the cgroup scope: the node container's own cgroup (the root of the
// cgroup namespace the agent sees), its network namespace, and its start as boot time.
// No load average, no block devices, no filesystem sizes: those are the host's.
func (c *Collector) collectCgroup() ([]metrics.Sample, error) {
	var samples []metrics.Sample
	var errs []error
	for _, collect := range []func() ([]metrics.Sample, error){
		c.cgroupCPU, c.cgroupMemory, c.cgroupIO, c.network, c.nodeStart,
	} {
		s, err := collect()
		samples = append(samples, s...)
		if err != nil {
			errs = append(errs, err)
		}
	}
	return samples, errors.Join(errs...)
}

// cgroupCores is the node's CPU capacity: cpu.max's quota / period, else the size of
// cpuset.cpus.effective, else the CPUs the kernel lists (the host's: no limit is set).
func (c *Collector) cgroupCores() (float64, error) {
	cg := c.cgroupDir()
	if v, err := c.readFile(filepath.Join(cg, "cpu.max")); err == nil {
		if f := strings.Fields(v); len(f) == 2 && f[0] != "max" {
			quota, err1 := strconv.ParseFloat(f[0], 64)
			period, err2 := strconv.ParseFloat(f[1], 64)
			if err1 == nil && err2 == nil && period > 0 && quota > 0 {
				return quota / period, nil
			}
		}
	}
	if v, err := c.readFile(filepath.Join(cg, "cpuset.cpus.effective")); err == nil && v != "" {
		if n, err := cpusetSize(v); err == nil && n > 0 {
			return float64(n), nil
		}
	}
	f, err := c.open(c.proc("stat"))
	if err != nil {
		return 0, err
	}
	defer func() { _ = f.Close() }()
	st, err := parseStat(f)
	if err != nil {
		return 0, err
	}
	return float64(st.count), nil
}

// cpusetSize counts the CPUs of a list such as "0-3,6,8-9".
func cpusetSize(s string) (int, error) {
	n := 0
	for _, part := range strings.Split(strings.TrimSpace(s), ",") {
		if part == "" {
			continue
		}
		lo, hi, isRange := strings.Cut(part, "-")
		a, err := strconv.Atoi(lo)
		if err != nil {
			return 0, err
		}
		b := a
		if isRange {
			if b, err = strconv.Atoi(hi); err != nil {
				return 0, err
			}
		}
		if b < a {
			return 0, fmt.Errorf("cpuset: bad range %q", part)
		}
		n += b - a + 1
	}
	return n, nil
}

// cgroupCPU: watchlog_node_cpu_count from the limit, and user, system and idle seconds
// from cpu.stat. The backend computes CPU % as non-idle over all modes, so idle grows
// by (cores × elapsed − usage) between scrapes, never backwards: the rate of all modes
// is the core count and the rate of non-idle modes is the usage.
func (c *Collector) cgroupCPU() ([]metrics.Sample, error) {
	cores, err := c.cgroupCores()
	if err != nil {
		return nil, err
	}
	st, err := c.keyed(filepath.Join(c.cgroupDir(), "cpu.stat"))
	if err != nil {
		return nil, err
	}
	usage := st["usage_usec"] / 1e6
	now := c.now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cg.at.IsZero() {
		// The first scrape: idle since the node started, so an agent restart keeps the
		// counter about where the previous agent left it.
		start := now
		if s, err := c.startTime(); err == nil && s > 0 {
			start = time.Unix(int64(s), 0)
		}
		c.cg.idle = max(0, cores*now.Sub(start).Seconds()-usage)
	} else if dt := now.Sub(c.cg.at).Seconds(); dt > 0 {
		c.cg.idle += max(0, cores*dt-max(0, usage-c.cg.usage))
	}
	c.cg.at, c.cg.usage, c.cg.cores = now, usage, cores
	return []metrics.Sample{
		metrics.New("watchlog_node_cpu_count", cores),
		metrics.New("watchlog_node_cpu_seconds_total", st["user_usec"]/1e6, "mode", "user"),
		metrics.New("watchlog_node_cpu_seconds_total", st["system_usec"]/1e6, "mode", "system"),
		metrics.New("watchlog_node_cpu_seconds_total", c.cg.idle, "mode", "idle"),
	}, nil
}

// cgroupMemory: total is memory.max (the host's MemTotal only when it is "max");
// available is total minus the working set (memory.current − inactive_file), as for
// containers; free is total minus memory.current; cached is the page cache (file).
func (c *Collector) cgroupMemory() ([]metrics.Sample, error) {
	cg := c.cgroupDir()
	current, err := c.readFile(filepath.Join(cg, "memory.current"))
	if err != nil {
		return nil, err
	}
	cur, err := strconv.ParseFloat(current, 64)
	if err != nil {
		return nil, fmt.Errorf("memory.current: %w", err)
	}
	st, err := c.keyed(filepath.Join(cg, "memory.stat"))
	if err != nil {
		return nil, err
	}
	total, fromHost := 0.0, false
	if v, err := c.readFile(filepath.Join(cg, "memory.max")); err == nil && v != "max" {
		if total, err = strconv.ParseFloat(v, 64); err != nil {
			return nil, fmt.Errorf("memory.max: %w", err)
		}
	} else {
		f, err := c.open(c.proc("meminfo"))
		if err != nil {
			return nil, err
		}
		mi, err := parseMeminfo(f)
		_ = f.Close()
		if err != nil {
			return nil, err
		}
		total, fromHost = mi["MemTotal"], true
	}
	ws := max(0, cur-st["inactive_file"])
	c.mu.Lock()
	if fromHost && !c.cg.memFromHost && c.cfg.Log != nil {
		c.cfg.Log.Warn("node memory.max is unlimited: the node's memory total is the host's")
	}
	c.cg.memTotal, c.cg.memFromHost = total, fromHost
	c.mu.Unlock()
	return []metrics.Sample{
		metrics.New("watchlog_node_memory_bytes", total, "state", "total"),
		metrics.New("watchlog_node_memory_bytes", max(0, total-ws), "state", "available"),
		metrics.New("watchlog_node_memory_bytes", max(0, total-cur), "state", "free"),
		metrics.New("watchlog_node_memory_bytes", st["file"], "state", "cached"),
	}, nil
}

// MemoryFromHost says whether the last memory total was the host's, because the
// node's memory.max is unlimited.
func (c *Collector) MemoryFromHost() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cg.memFromHost
}

// cgroupIO: the node's block I/O from io.stat, summed over devices; the label dev is
// "all" so no host device name is reported.
func (c *Collector) cgroupIO() ([]metrics.Sample, error) {
	f, err := c.open(filepath.Join(c.cgroupDir(), "io.stat"))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil // the io controller is not enabled for this cgroup
		}
		return nil, err
	}
	defer func() { _ = f.Close() }()
	var rd, wr float64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		for _, kv := range strings.Fields(sc.Text())[1:] {
			k, v, ok := strings.Cut(kv, "=")
			if !ok {
				continue
			}
			n, err := strconv.ParseFloat(v, 64)
			if err != nil {
				continue
			}
			switch k {
			case "rbytes":
				rd += n
			case "wbytes":
				wr += n
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return []metrics.Sample{
		metrics.New("watchlog_node_disk_io_bytes_total", rd, "dev", "all", "dir", "read"),
		metrics.New("watchlog_node_disk_io_bytes_total", wr, "dev", "all", "dir", "write"),
	}, nil
}

// startTime is when the node's PID 1 started (the node container's start), in Unix
// seconds: the host's boot time plus field 22 of /proc/1/stat. Neither is reported
// on its own.
func (c *Collector) startTime() (float64, error) {
	f, err := c.open(c.proc("stat"))
	if err != nil {
		return 0, err
	}
	st, err := parseStat(f)
	_ = f.Close()
	if err != nil {
		return 0, err
	}
	if st.bootTime == 0 {
		return 0, errors.New("stat: no btime")
	}
	s, err := c.readFile(c.proc("1/stat"))
	if err != nil {
		return 0, err
	}
	// The command (field 2) is in parentheses and may contain spaces.
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return 0, errors.New("1/stat: no command")
	}
	f2 := strings.Fields(s[i+1:])
	// After the command: state is field 3, so starttime (field 22) is index 19.
	if len(f2) < 20 {
		return 0, errors.New("1/stat: too few fields")
	}
	ticks, err := strconv.ParseFloat(f2[19], 64)
	if err != nil {
		return 0, fmt.Errorf("1/stat: starttime: %w", err)
	}
	return st.bootTime + ticks/userHZ, nil
}

// nodeStart reports the node container's start as watchlog_node_boot_time_seconds.
func (c *Collector) nodeStart() ([]metrics.Sample, error) {
	s, err := c.startTime()
	if err != nil {
		return nil, err
	}
	return []metrics.Sample{metrics.New("watchlog_node_boot_time_seconds", s)}, nil
}

// keyed reads a "key value" file such as cpu.stat or memory.stat.
func (c *Collector) keyed(p string) (map[string]float64, error) {
	f, err := c.open(p)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	out := map[string]float64{}
	sc := bufio.NewScanner(f)
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
