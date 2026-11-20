// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package ebpf

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/ringbuf"
)

// Exits reads process exits from the kernel (procs.bpf.c, ADR-210).
type Exits struct {
	objs procsObjects
	link link.Link
	rd   *ringbuf.Reader
	// The cron exec program (ADR-223); nil when it couldn't attach (exits still work).
	execLink link.Link
	execRd   *ringbuf.Reader
}

// StartExits loads and attaches the exit program; an error means exit codes and OOM kills
// are unknown (the agent runs on without them).
func StartExits() (*Exits, error) {
	e := &Exits{}
	if err := loadProcsObjects(&e.objs, nil); err != nil {
		return nil, explain(err)
	}
	l, err := link.AttachTracing(link.TracingOptions{Program: e.objs.OnProcessExit})
	if err != nil {
		_ = e.objs.Close()
		return nil, explain(fmt.Errorf("attach on_process_exit: %w", err))
	}
	e.link = l
	rd, err := ringbuf.NewReader(e.objs.Exits)
	if err != nil {
		e.Close()
		return nil, err
	}
	e.rd = rd
	// The runs cron starts: optional, its failure leaves exits as they were.
	if el, err := link.AttachTracing(link.TracingOptions{Program: e.objs.OnProcessExec}); err == nil {
		if erd, err := ringbuf.NewReader(e.objs.Execs); err == nil {
			e.execLink, e.execRd = el, erd
		} else {
			_ = el.Close()
		}
	}
	return e, nil
}

// Execs says whether the cron exec program is attached.
func (e *Exits) Execs() bool { return e.execRd != nil }

// ReadExecs calls handle for every exec cron's child makes, until Close; false at once when
// the exec program isn't attached.
func (e *Exits) ReadExecs(handle func(ExecEvent)) bool {
	if e.execRd == nil {
		return false
	}
	var rec ringbuf.Record
	for {
		if err := e.execRd.ReadInto(&rec); err != nil {
			return true
		}
		var raw procsExecEvent
		if err := binary.Read(bytes.NewReader(rec.RawSample), binary.LittleEndian, &raw); err != nil {
			continue
		}
		n := int(raw.ArgsLen)
		if n > len(raw.Args) {
			n = len(raw.Args)
		}
		args := make([]byte, n)
		for i := 0; i < n; i++ {
			args[i] = byte(raw.Args[i]) //nolint:gosec // a C char's bits
		}
		handle(ExecEvent{Tgid: raw.Tgid, PPID: raw.Ppid, StartNs: raw.StartNs, Comm: cString(raw.Comm[:]), Args: splitArgs(args)})
	}
}

// Read calls handle for every exit until Close.
func (e *Exits) Read(handle func(ExitEvent)) error {
	var rec ringbuf.Record
	for {
		if err := e.rd.ReadInto(&rec); err != nil {
			if errors.Is(err, ringbuf.ErrClosed) {
				return nil
			}
			return err
		}
		var raw procsExitEvent
		if err := binary.Read(bytes.NewReader(rec.RawSample), binary.LittleEndian, &raw); err != nil {
			continue
		}
		handle(decodeExit(raw))
	}
}

// Dropped is how many exits the ring buffer had no room for.
func (e *Exits) Dropped() uint64 {
	var per []uint64
	if err := e.objs.ExitsDropped.Lookup(uint32(0), &per); err != nil {
		return 0
	}
	var n uint64
	for _, v := range per {
		n += v
	}
	return n
}

// Close detaches the program.
func (e *Exits) Close() {
	if e.rd != nil {
		_ = e.rd.Close()
	}
	if e.execRd != nil {
		_ = e.execRd.Close()
	}
	if e.execLink != nil {
		_ = e.execLink.Close()
	}
	if e.link != nil {
		_ = e.link.Close()
	}
	_ = e.objs.Close()
}

func decodeExit(raw procsExitEvent) ExitEvent {
	e := exitFromStatus(raw.Tgid, raw.ExitCode, raw.Cgroup, raw.Oom != 0, cString(raw.Comm[:]))
	e.PPID = raw.Ppid
	e.CgroupName = cString(raw.CgroupName[:])
	return e
}

func cString(b []int8) string {
	out := make([]byte, 0, len(b))
	for _, c := range b {
		if c == 0 {
			break
		}
		out = append(out, byte(c)) //nolint:gosec // a C char's bits, not a number
	}
	return string(out)
}

// ScopeTo records only the exits of tasks below these cgroups (their ids), and turns the
// filter on (ADR-211: a server inside a container records none of the machine it runs on).
// An empty list turns it off.
func (e *Exits) ScopeTo(ids []uint64) error {
	for i, id := range ids {
		if i >= 16 {
			break
		}
		if err := e.objs.ExitRoots.Put(id, uint8(1)); err != nil {
			return err
		}
	}
	var on uint32
	if len(ids) > 0 {
		on = 1
	}
	return e.objs.ExitFilter.Put(uint32(0), on)
}
