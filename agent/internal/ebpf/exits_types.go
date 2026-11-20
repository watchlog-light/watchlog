// SPDX-License-Identifier: AGPL-3.0-only

package ebpf

// ExitEvent is one process's end: its exit status for a normal exit, else the signal that
// ended it, and whether the OOM killer chose it. Tgid and Comm stay in the agent.
type ExitEvent struct {
	Tgid   uint32
	Status int  // the exit status (0–255) of a normal exit
	Signal int  // the terminating signal, 0 for a normal exit
	Core   bool // a core was dumped
	OOM    bool
	Cgroup uint64
	Comm   string
	// PPID is the parent's tgid (1 for a systemd service's main process).
	PPID uint32
	// CgroupName is the cgroup's own name: the unit (orders.service) for a service's process.
	CgroupName string
}

// exitFromStatus decodes the kernel's wait status: (status << 8) | signal, 0x80 for a core.
func exitFromStatus(tgid uint32, code int32, cgroup uint64, oom bool, comm string) ExitEvent {
	e := ExitEvent{Tgid: tgid, Cgroup: cgroup, OOM: oom, Comm: comm}
	return withStatus(e, code)
}

func withStatus(e ExitEvent, code int32) ExitEvent {
	if sig := int(code & 0x7f); sig != 0 {
		e.Signal = sig
		e.Core = code&0x80 != 0
	} else {
		e.Status = int((code >> 8) & 0xff)
	}
	return e
}

// ExecEvent is a process cron's child started (ADR-223): its command line stays in the agent,
// matched to a crontab line and dropped.
type ExecEvent struct {
	Tgid, PPID uint32
	// StartNs is when it started, nanoseconds since boot.
	StartNs uint64
	Comm    string
	// Args is the command line, cut at 256 bytes.
	Args []string
}

// splitArgs splits a NUL-separated command line.
func splitArgs(b []byte) []string {
	var out []string
	start := 0
	for i, c := range b {
		if c == 0 {
			out = append(out, string(b[start:i]))
			start = i + 1
		}
	}
	if start < len(b) {
		out = append(out, string(b[start:]))
	}
	return out
}
