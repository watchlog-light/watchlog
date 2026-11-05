// SPDX-License-Identifier: AGPL-3.0-only

// Package host reads host metrics from /proc, /sys and statfs (SPEC §6.3).
// In docker mode the host's paths are mounted at /host/proc, /host/sys and /host/root (ADR-023).
package host

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Config locates the host's filesystems as seen by the agent.
type Config struct {
	// ProcRoot is the host procfs, e.g. /host/proc. Host-wide files are read from
	// <ProcRoot>/1/... so that the host's network namespace and mounts are used.
	ProcRoot string
	// SysRoot is the host sysfs, e.g. /host/sys.
	SysRoot string
	// RootFS is the host root filesystem used for statfs, e.g. /host/root.
	RootFS string
}

type fsUsage struct {
	size, free, avail float64
}

// Collector reads host metrics.
type Collector struct {
	cfg    Config
	fsys   fs.FS // rooted at "/" so tests can substitute fixtures
	statfs func(path string) (fsUsage, error)
}

// New returns a collector reading the real filesystem. Relative paths are
// resolved against the working directory.
func New(cfg Config) *Collector {
	for _, p := range []*string{&cfg.ProcRoot, &cfg.SysRoot, &cfg.RootFS} {
		if abs, err := filepath.Abs(*p); err == nil {
			*p = abs
		}
	}
	return &Collector{cfg: cfg, fsys: os.DirFS("/"), statfs: statfs}
}

// Collect returns one scrape of host metrics. Partial results are returned
// together with an error describing the sources that failed.
func (c *Collector) Collect() ([]metrics.Sample, error) {
	var samples []metrics.Sample
	var errs []error
	for _, collect := range []func() ([]metrics.Sample, error){
		c.cpu, c.memory, c.load, c.disks, c.network, c.filesystems,
	} {
		s, err := collect()
		samples = append(samples, s...)
		if err != nil {
			errs = append(errs, err)
		}
	}
	return samples, errors.Join(errs...)
}

func (c *Collector) open(path string) (io.ReadCloser, error) {
	return c.fsys.Open(strings.TrimPrefix(filepath.Clean(path), "/"))
}

func (c *Collector) proc(name string) string { return filepath.Join(c.cfg.ProcRoot, name) }

func (c *Collector) cpu() ([]metrics.Sample, error) {
	f, err := c.open(c.proc("stat"))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	st, err := parseStat(f)
	if err != nil {
		return nil, err
	}
	out := []metrics.Sample{metrics.New("watchlog_node_cpu_count", float64(st.count))}
	// The boot time gives hosts and nodes their uptime.
	if st.bootTime > 0 {
		out = append(out, metrics.New("watchlog_node_boot_time_seconds", st.bootTime))
	}
	for _, mode := range cpuModes {
		if v, ok := st.seconds[mode]; ok {
			out = append(out, metrics.New("watchlog_node_cpu_seconds_total", v, "mode", mode))
		}
	}
	return out, nil
}

// memoryStates maps the exported state label to the /proc/meminfo field.
var memoryStates = [][2]string{
	{"total", "MemTotal"},
	{"available", "MemAvailable"},
	{"free", "MemFree"},
	{"buffers", "Buffers"},
	{"cached", "Cached"},
	{"swap_total", "SwapTotal"},
	{"swap_free", "SwapFree"},
}

func (c *Collector) memory() ([]metrics.Sample, error) {
	f, err := c.open(c.proc("meminfo"))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	mi, err := parseMeminfo(f)
	if err != nil {
		return nil, err
	}
	var out []metrics.Sample
	for _, s := range memoryStates {
		if v, ok := mi[s[1]]; ok {
			out = append(out, metrics.New("watchlog_node_memory_bytes", v, "state", s[0]))
		}
	}
	return out, nil
}

func (c *Collector) load() ([]metrics.Sample, error) {
	f, err := c.open(c.proc("loadavg"))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	l, err := parseLoadavg(f)
	if err != nil {
		return nil, err
	}
	return []metrics.Sample{
		metrics.New("watchlog_node_load1", l[0]),
		metrics.New("watchlog_node_load5", l[1]),
		metrics.New("watchlog_node_load15", l[2]),
	}, nil
}

// skippedDiskPrefixes are virtual or removable block devices.
var skippedDiskPrefixes = []string{"loop", "ram", "zram", "sr", "fd", "nbd", "dm-", "md"}

func (c *Collector) isWholeDisk(device string) bool {
	for _, p := range skippedDiskPrefixes {
		if strings.HasPrefix(device, p) {
			return false
		}
	}
	// Whole disks appear in /sys/block; partitions do not.
	_, err := fs.Stat(c.fsys, strings.TrimPrefix(filepath.Join(c.cfg.SysRoot, "block", device), "/"))
	return err == nil
}

func (c *Collector) disks() ([]metrics.Sample, error) {
	f, err := c.open(c.proc("diskstats"))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	stats, err := parseDiskstats(f, c.isWholeDisk)
	if err != nil {
		return nil, err
	}
	var out []metrics.Sample
	for _, d := range stats {
		out = append(out,
			metrics.New("watchlog_node_disk_io_bytes_total", d.readBytes, "dev", d.device, "dir", "read"),
			metrics.New("watchlog_node_disk_io_bytes_total", d.writtenBytes, "dev", d.device, "dir", "write"),
		)
	}
	return out, nil
}

// skippedIfacePrefixes are loopback and container/overlay virtual interfaces;
// per-container traffic is reported by the containers collector instead.
var skippedIfacePrefixes = []string{"lo", "veth", "docker", "br-", "cni", "flannel", "cali", "vxlan", "tunl", "virbr", "kube-"}

func keepIface(name string) bool {
	for _, p := range skippedIfacePrefixes {
		if strings.HasPrefix(name, p) {
			return false
		}
	}
	return true
}

func (c *Collector) network() ([]metrics.Sample, error) {
	// PID 1's view is the host network namespace (requires --pid host in docker mode).
	f, err := c.open(c.proc("1/net/dev"))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	stats, err := parseNetDev(f, keepIface)
	if err != nil {
		return nil, err
	}
	var out []metrics.Sample
	for _, n := range stats {
		out = append(out,
			metrics.New("watchlog_node_network_bytes_total", n.rxBytes, "iface", n.iface, "dir", "rx"),
			metrics.New("watchlog_node_network_bytes_total", n.txBytes, "iface", n.iface, "dir", "tx"),
		)
	}
	return out, nil
}

// localFilesystems are the filesystem types reported; network filesystems are
// skipped because statfs on an unreachable server can block.
var localFilesystems = map[string]bool{
	"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true, "zfs": true,
	"vfat": true, "exfat": true, "f2fs": true,
}

func (c *Collector) filesystems() ([]metrics.Sample, error) {
	f, err := c.open(c.proc("1/mountinfo"))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	mounts, err := parseMountinfo(f)
	if err != nil {
		return nil, err
	}
	// One entry per device: the shortest mount point wins (bind mounts are duplicates).
	sort.SliceStable(mounts, func(i, j int) bool { return len(mounts[i].mountPoint) < len(mounts[j].mountPoint) })
	seen := map[string]bool{}
	var out []metrics.Sample
	var errs []error
	for _, m := range mounts {
		if !localFilesystems[m.fsType] || seen[m.device] {
			continue
		}
		seen[m.device] = true
		usage, err := c.statfs(filepath.Join(c.cfg.RootFS, m.mountPoint))
		if err != nil {
			errs = append(errs, fmt.Errorf("statfs %s: %w", m.mountPoint, err))
			continue
		}
		out = append(out,
			metrics.New("watchlog_node_filesystem_bytes", usage.size, "mount", m.mountPoint, "state", "size"),
			metrics.New("watchlog_node_filesystem_bytes", usage.free, "mount", m.mountPoint, "state", "free"),
			metrics.New("watchlog_node_filesystem_bytes", usage.avail, "mount", m.mountPoint, "state", "avail"),
		)
	}
	return out, errors.Join(errs...)
}
