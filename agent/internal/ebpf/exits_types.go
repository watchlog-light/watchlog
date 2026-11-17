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
}

// exitFromStatus decodes the kernel's wait status: (status << 8) | signal, 0x80 for a core.
func exitFromStatus(tgid uint32, code int32, cgroup uint64, oom bool, comm string) ExitEvent {
	e := ExitEvent{Tgid: tgid, Cgroup: cgroup, OOM: oom, Comm: comm}
	if sig := int(code & 0x7f); sig != 0 {
		e.Signal = sig
		e.Core = code&0x80 != 0
	} else {
		e.Status = int((code >> 8) & 0xff)
	}
	return e
}
