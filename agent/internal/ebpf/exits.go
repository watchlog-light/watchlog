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
		e.objs.Close()
		return nil, explain(fmt.Errorf("attach on_process_exit: %w", err))
	}
	e.link = l
	rd, err := ringbuf.NewReader(e.objs.Exits)
	if err != nil {
		e.Close()
		return nil, err
	}
	e.rd = rd
	return e, nil
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
	if e.link != nil {
		_ = e.link.Close()
	}
	e.objs.Close()
}

func decodeExit(raw procsExitEvent) ExitEvent {
	comm := make([]byte, 0, len(raw.Comm))
	for _, c := range raw.Comm {
		if c == 0 {
			break
		}
		comm = append(comm, byte(c))
	}
	return exitFromStatus(raw.Tgid, raw.ExitCode, raw.Cgroup, raw.Oom != 0, string(comm))
}
