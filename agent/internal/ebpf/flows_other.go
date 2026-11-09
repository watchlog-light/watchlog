// SPDX-License-Identifier: AGPL-3.0-only

//go:build !linux

package ebpf

import "errors"

// Flows exist on Linux only; elsewhere the agent builds for development and tests.
type Flows struct {
	Bytes       bool
	BytesReason string
	DNS         bool
	DNSReason   string
	HTTP        bool
	HTTPReason  string
}

// Options choose the optional hooks.
type Options struct{ HTTP bool }

// LoadWith fails outside Linux.
func LoadWith(Options) (*Flows, error) { return nil, errors.New("eBPF needs Linux") }

// DrainHTTP returns nothing outside Linux.
func (f *Flows) DrainHTTP() ([]HTTPStat, error) { return nil, nil }

// CheckSupport: eBPF needs Linux.
func CheckSupport(release, sys string) Support { return Support{Reason: "eBPF needs Linux"} }

// KernelRelease is empty outside Linux.
func KernelRelease() string { return "" }

// Load fails outside Linux.
func Load() (*Flows, error) { return nil, errors.New("eBPF needs Linux") }

// Drain returns nothing outside Linux.
func (f *Flows) Drain() ([]Flow, error) { return nil, nil }

// Close does nothing outside Linux.
func (f *Flows) Close() {}

// DrainDNS returns nothing outside Linux.
func (f *Flows) DrainDNS() ([]DNSStat, error) { return nil, nil }

// ReadDNSResponses returns at once outside Linux.
func (f *Flows) ReadDNSResponses(func(cgroup uint64, msg []byte)) error { return nil }

// SetRoots does nothing outside Linux.
func (f *Flows) SetRoots([]uint64) error { return nil }

// SetFilter does nothing outside Linux.
func (f *Flows) SetFilter(bool) error { return nil }

// Filtered is zero outside Linux.
func (f *Flows) Filtered() (connects, dns uint64, err error) { return 0, 0, nil }
