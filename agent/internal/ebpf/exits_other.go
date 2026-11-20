// SPDX-License-Identifier: AGPL-3.0-only

//go:build !linux

package ebpf

import "errors"

// Exits reads process exits; Linux only.
type Exits struct{}

// StartExits needs Linux.
func StartExits() (*Exits, error) { return nil, errors.New("eBPF needs Linux") }

// ReadExecs returns false at once off Linux.
func (e *Exits) ReadExecs(func(ExecEvent)) bool { return false }

// Execs is false outside Linux.
func (e *Exits) Execs() bool { return false }

// Read returns at once off Linux.
func (e *Exits) Read(func(ExitEvent)) error { return nil }

// Dropped is 0 off Linux.
func (e *Exits) Dropped() uint64 { return 0 }

// Close does nothing off Linux.
func (e *Exits) Close() {}

// ScopeTo does nothing off Linux.
func (e *Exits) ScopeTo([]uint64) error { return nil }
