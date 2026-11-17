// SPDX-License-Identifier: AGPL-3.0-only

package procs

import (
	"bufio"
	"io/fs"
	"path"
	"sort"
	"strconv"
	"strings"
)

// MaxPorts is the most listening ports one workload reports (ADR-208).
const MaxPorts = 10

// Workload is what owns a process on a server: a systemd service or a process group.
type Workload struct {
	Kind string // "Service" or "ProcessGroup", as the flow series' workload_kind
	Name string
}

// Listener is a TCP port a workload listens on.
type Listener struct {
	Workload
	Proto string // tcp or tcp6
	Port  uint16
}

// listening reads the LISTEN sockets of the host's network namespace (the one of pid 1)
// from /proc/1/net/tcp and tcp6: socket inode → (proto, port).
func (r *Reader) listening() map[uint64]Listener {
	out := map[uint64]Listener{}
	for _, proto := range []string{"tcp", "tcp6"} {
		f, err := r.FS.Open(path.Join(r.Root, "1", "net", proto))
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Scan() // header
		for sc.Scan() {
			// sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode …
			fields := strings.Fields(sc.Text())
			if len(fields) < 10 || fields[3] != "0A" { // 0A: TCP_LISTEN
				continue
			}
			_, portHex, ok := strings.Cut(fields[1], ":")
			if !ok {
				continue
			}
			port, err1 := strconv.ParseUint(portHex, 16, 16)
			inode, err2 := strconv.ParseUint(fields[9], 10, 64)
			if err1 != nil || err2 != nil || inode == 0 {
				continue
			}
			out[inode] = Listener{Proto: proto, Port: uint16(port)}
		}
		_ = f.Close()
	}
	return out
}

// socketInodes lists the socket inodes a process holds (/proc/<pid>/fd → socket:[n]).
// Needs the right to read another user's fd directory (CAP_DAC_READ_SEARCH, ADR-209).
func (r *Reader) socketInodes(pid int) []uint64 {
	dir := path.Join(r.Root, strconv.Itoa(pid), "fd")
	entries, err := fs.ReadDir(r.FS, dir)
	if err != nil {
		return nil
	}
	var out []uint64
	for _, e := range entries {
		if r.ReadlinkFD == nil {
			break
		}
		target, err := r.ReadlinkFD(pid, e.Name())
		if err != nil || !strings.HasPrefix(target, "socket:[") {
			continue
		}
		if n, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimPrefix(target, "socket:["), "]"), 10, 64); err == nil {
			out = append(out, n)
		}
	}
	return out
}

// sortedListeners keeps at most MaxPorts per workload, lowest ports first.
func sortedListeners(byWorkload map[Workload]map[Listener]bool) []Listener {
	var out []Listener
	for _, set := range byWorkload {
		var ls []Listener
		for l := range set {
			ls = append(ls, l)
		}
		sort.Slice(ls, func(i, j int) bool {
			if ls[i].Port != ls[j].Port {
				return ls[i].Port < ls[j].Port
			}
			return ls[i].Proto < ls[j].Proto
		})
		if len(ls) > MaxPorts {
			ls = ls[:MaxPorts]
		}
		out = append(out, ls...)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].Port < out[j].Port
	})
	return out
}
