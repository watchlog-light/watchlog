// SPDX-License-Identifier: AGPL-3.0-only

// Package procs groups a server's processes into workloads (ADR-208): pm2 apps, supervisord
// programs, PHP-FPM pools, gunicorn and uwsgi apps, Java jars, scripts and binaries, in any
// language and however they were started. It reads /proc locally and never a process's
// environment; no PID, command line or argument leaves it, only each group's derived and
// redacted name.
package procs

import (
	"io/fs"
	"path"
	"strconv"
	"strings"
)

// Proc is one process as the grouping needs it. Fields that couldn't be read are zero.
type Proc struct {
	PID, PPID int
	Comm      string
	// Args is the command line (argv), read locally and never sent anywhere.
	Args []string
	// Exe is the executable's path (readlink /proc/<pid>/exe); empty when not permitted.
	Exe string
	// ExeID changes when the executable on disk is replaced (a release): its inode and
	// modification time.
	ExeID string
	// Cgroup is the process's cgroup v2 path (/system.slice/nginx.service).
	Cgroup     string
	CPUTicks   uint64 // utime + stime, in clock ticks
	StartTicks uint64 // since boot, in clock ticks
	Threads    int
	RSSBytes   uint64
	PSSBytes   uint64 // 0 when smaps_rollup can't be read
	OpenFiles  int    // -1 when /proc/<pid>/fd can't be read
	UID        int
	// Sockets are the socket inodes the process holds (listening ports), read locally.
	Sockets []uint64
}

// Reader reads processes below a procfs root of an fs.FS (the real /proc, or a test tree).
type Reader struct {
	FS   fs.FS
	Root string // "proc" for os.DirFS("/"), relative to FS
	// ExeIdentity returns the executable's identity (inode and mtime); nil leaves it empty.
	ExeIdentity func(pid int) string
	// Readlink resolves /proc/<pid>/exe; nil leaves Exe empty (tests use Args[0]).
	Readlink func(pid int) (string, error)
	// ReadlinkFD resolves /proc/<pid>/fd/<n> (sockets for listening ports); nil skips them.
	ReadlinkFD func(pid int, fd string) (string, error)
}

func (r *Reader) read(pid int, name string) (string, error) {
	b, err := fs.ReadFile(r.FS, path.Join(r.Root, strconv.Itoa(pid), name))
	return string(b), err
}

// PIDs lists the numeric entries of /proc.
func (r *Reader) PIDs() ([]int, error) {
	entries, err := fs.ReadDir(r.FS, r.Root)
	if err != nil {
		return nil, err
	}
	var out []int
	for _, e := range entries {
		if pid, err := strconv.Atoi(e.Name()); err == nil && e.IsDir() {
			out = append(out, pid)
		}
	}
	return out, nil
}

// Read reads one process; ok is false when it is gone or a kernel thread.
func (r *Reader) Read(pid int) (Proc, bool) {
	p := Proc{PID: pid, OpenFiles: -1}
	stat, err := r.read(pid, "stat")
	if err != nil {
		return p, false
	}
	// "pid (comm) state ppid …": comm may hold spaces and parentheses.
	open, close := strings.IndexByte(stat, '('), strings.LastIndexByte(stat, ')')
	if open < 0 || close < open {
		return p, false
	}
	p.Comm = stat[open+1 : close]
	f := strings.Fields(stat[close+1:])
	// f[0] state, f[1] ppid, f[11] utime, f[12] stime, f[17] num_threads, f[19] starttime
	if len(f) < 20 {
		return p, false
	}
	p.PPID, _ = strconv.Atoi(f[1])
	ut, _ := strconv.ParseUint(f[11], 10, 64)
	st, _ := strconv.ParseUint(f[12], 10, 64)
	p.CPUTicks = ut + st
	p.Threads, _ = strconv.Atoi(f[17])
	p.StartTicks, _ = strconv.ParseUint(f[19], 10, 64)
	// Kernel threads: kthreadd (2) and its children, with no command line.
	if pid == 2 || p.PPID == 2 {
		return p, false
	}
	if cl, err := r.read(pid, "cmdline"); err == nil {
		p.Args = splitArgs(cl)
	}
	if len(p.Args) == 0 {
		return p, false // a kernel thread or a zombie
	}
	if status, err := r.read(pid, "status"); err == nil {
		for _, line := range strings.Split(status, "\n") {
			k, v, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			v = strings.TrimSpace(v)
			switch k {
			case "VmRSS":
				p.RSSBytes = kib(v)
			case "Uid":
				if fs := strings.Fields(v); len(fs) > 0 {
					p.UID, _ = strconv.Atoi(fs[0])
				}
			}
		}
	}
	if smaps, err := r.read(pid, "smaps_rollup"); err == nil {
		for _, line := range strings.Split(smaps, "\n") {
			if k, v, ok := strings.Cut(line, ":"); ok && k == "Pss" {
				p.PSSBytes = kib(strings.TrimSpace(v))
			}
		}
	}
	if cg, err := r.read(pid, "cgroup"); err == nil {
		p.Cgroup = cgroupV2(cg)
	}
	if entries, err := fs.ReadDir(r.FS, path.Join(r.Root, strconv.Itoa(pid), "fd")); err == nil {
		p.OpenFiles = len(entries)
		p.Sockets = r.socketInodes(pid)
	}
	if r.Readlink != nil {
		if exe, err := r.Readlink(pid); err == nil {
			p.Exe = strings.TrimSuffix(exe, " (deleted)")
		}
	}
	if r.ExeIdentity != nil {
		p.ExeID = r.ExeIdentity(pid)
	}
	return p, true
}

func splitArgs(cl string) []string {
	cl = strings.TrimRight(cl, "\x00")
	if cl == "" {
		return nil
	}
	if strings.Contains(cl, "\x00") {
		return strings.Split(cl, "\x00")
	}
	// A rewritten title (setproctitle, pm2, PHP-FPM) is one string with spaces.
	return strings.Fields(cl)
}

// cgroupV2 picks the unified hierarchy's path ("0::/system.slice/x.service"); on a v1 host,
// the name=systemd or pids controller's path, which systemd keeps per unit too.
func cgroupV2(s string) string {
	var fallback string
	for _, line := range strings.Split(strings.TrimSpace(s), "\n") {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		if parts[0] == "0" && parts[1] == "" {
			return parts[2]
		}
		if parts[1] == "name=systemd" || (fallback == "" && parts[1] == "pids") {
			fallback = parts[2]
		}
	}
	return fallback
}

func kib(v string) uint64 {
	n, _ := strconv.ParseUint(strings.TrimSuffix(strings.TrimSpace(v), " kB"), 10, 64)
	return n * 1024
}

// Unit is the systemd unit a cgroup path belongs to (the deepest .service in it), or "".
func Unit(cgroup string) string {
	parts := strings.Split(cgroup, "/")
	for i := len(parts) - 1; i >= 0; i-- {
		if strings.HasSuffix(parts[i], ".service") {
			return parts[i]
		}
	}
	return ""
}

// InContainer reports whether a cgroup is a container's (Docker, Podman, containerd,
// Kubernetes): those processes are the container source's, never grouped here.
func InContainer(cgroup string) bool {
	for _, part := range strings.Split(cgroup, "/") {
		switch {
		case strings.HasPrefix(part, "docker-") && strings.HasSuffix(part, ".scope"),
			strings.HasPrefix(part, "libpod-"), strings.HasPrefix(part, "cri-containerd-"),
			strings.HasPrefix(part, "crio-"), strings.HasPrefix(part, "kubepods"),
			part == "docker", part == "libpod_parent", part == "machine.slice":
			return true
		}
	}
	return false
}
