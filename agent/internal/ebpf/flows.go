// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package ebpf

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"sync"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/ringbuf"
	"golang.org/x/sys/unix"
)

// CheckSupport looks at the kernel release, BTF and the cgroup version without loading
// anything. sys is the host's /sys (read-only hostPath in Kubernetes).
func CheckSupport(release, sys string) Support {
	major, minor, ok := kernelVersion(release)
	if !ok {
		return Support{Reason: fmt.Sprintf("unknown kernel release %q", release)}
	}
	if major < MinKernel[0] || (major == MinKernel[0] && minor < MinKernel[1]) {
		return Support{Reason: fmt.Sprintf("kernel %d.%d is older than %d.%d", major, minor, MinKernel[0], MinKernel[1])}
	}
	if _, err := os.Stat(sys + "/kernel/btf/vmlinux"); err != nil {
		return Support{Reason: "kernel has no BTF (/sys/kernel/btf/vmlinux missing)"}
	}
	var fs unix.Statfs_t
	if err := unix.Statfs(sys+"/fs/cgroup", &fs); err != nil || fs.Type != unix.CGROUP2_SUPER_MAGIC {
		return Support{Reason: "cgroup v1: connections cannot be attributed to containers"}
	}
	return Support{OK: true}
}

// KernelRelease is uname -r.
func KernelRelease() string {
	var u unix.Utsname
	if err := unix.Uname(&u); err != nil {
		return ""
	}
	return unix.ByteSliceToString(u.Release[:])
}

// Flows are the loaded and attached flow programs.
type Flows struct {
	mu     sync.Mutex
	objs   flowsObjects
	links  []link.Link
	active uint32
	// Bytes is false when the fentry/fexit bytes hooks could not attach (e.g. arm64
	// before 6.0 has no BPF trampoline); everything else still counts.
	Bytes bool
	// BytesReason says why.
	BytesReason string
	// DNS is false when the DNS hooks could not attach (same reason as bytes).
	DNS       bool
	DNSReason string
	// drained is the map index the last Drain read; DrainDNS reads the same one.
	drained uint32
	extra   []*ebpf.Collection
	answers *ringbuf.Reader
}

// Load loads the programs and attaches them. Errors say what is missing in words
// (a capability, a hook).
func Load() (*Flows, error) {
	spec, err := loadFlows()
	if err != nil {
		return nil, err
	}
	optional := map[string]bool{"on_send": true, "on_recv": true,
		"on_dns_send": true, "on_dns_send6": true, "on_dns_recv": true, "on_dns_close": true}
	core := spec.Copy()
	for name := range optional {
		delete(core.Programs, name)
	}
	f := &Flows{}
	coll, err := ebpf.NewCollection(core)
	if err != nil {
		return nil, explain(err)
	}
	f.objs = flowsObjects{
		flowsMaps: flowsMaps{
			Active: coll.Maps["active"], Flows0: coll.Maps["flows0"],
			Flows1: coll.Maps["flows1"], Socks: coll.Maps["socks"],
			Dns0: coll.Maps["dns0"], Dns1: coll.Maps["dns1"], DnsSocks: coll.Maps["dns_socks"],
			DnsAnswers: coll.Maps["dns_answers"],
			Roots:      coll.Maps["roots"], Filter: coll.Maps["filter"], Filtered: coll.Maps["filtered"],
		},
		flowsPrograms: flowsPrograms{OnState: coll.Programs["on_state"], OnRetransmit: coll.Programs["on_retransmit"]},
	}
	for _, p := range []*ebpf.Program{f.objs.OnState, f.objs.OnRetransmit} {
		l, err := link.AttachTracing(link.TracingOptions{Program: p})
		if err != nil {
			f.Close()
			return nil, explain(fmt.Errorf("attach %s: %w", p, err))
		}
		f.links = append(f.links, l)
	}
	f.Bytes, f.BytesReason = f.attachOptional(spec, "on_send", "on_recv")
	f.DNS, f.DNSReason = f.attachOptional(spec, "on_dns_send", "on_dns_send6", "on_dns_recv", "on_dns_close")
	return f, nil
}

// attachOptional loads and attaches fentry/fexit programs that some kernels cannot run
// (arm64 has no BPF trampoline before 6.0), sharing the maps already created.
func (f *Flows) attachOptional(spec *ebpf.CollectionSpec, names ...string) (bool, string) {
	progs := map[string]*ebpf.ProgramSpec{}
	for _, n := range names {
		progs[n] = spec.Programs[n]
	}
	opt := &ebpf.CollectionSpec{Maps: spec.Maps, Programs: progs, Types: spec.Types}
	coll, err := ebpf.NewCollectionWithOptions(opt, ebpf.CollectionOptions{MapReplacements: map[string]*ebpf.Map{
		"active": f.objs.Active, "flows0": f.objs.Flows0, "flows1": f.objs.Flows1, "socks": f.objs.Socks,
		"dns0": f.objs.Dns0, "dns1": f.objs.Dns1, "dns_socks": f.objs.DnsSocks, "dns_answers": f.objs.DnsAnswers,
		"roots": f.objs.Roots, "filter": f.objs.Filter, "filtered": f.objs.Filtered,
	}})
	if err != nil {
		return false, explain(err).Error()
	}
	var links []link.Link
	for _, n := range names {
		l, err := link.AttachTracing(link.TracingOptions{Program: coll.Programs[n]})
		if err != nil {
			for _, l := range links {
				_ = l.Close()
			}
			coll.Close()
			return false, explain(err).Error()
		}
		links = append(links, l)
	}
	f.links = append(f.links, links...)
	f.extra = append(f.extra, coll)
	return true, ""
}

func explain(err error) error {
	switch {
	case errors.Is(err, os.ErrPermission), errors.Is(err, unix.EPERM):
		// Before 5.11 the kernel charges BPF maps to RLIMIT_MEMLOCK, which also gives EPERM.
		if major, minor, ok := kernelVersion(KernelRelease()); ok && (major < 5 || major == 5 && minor < 11) {
			return fmt.Errorf("%w, or RLIMIT_MEMLOCK is too low for kernel %d.%d (%w)", ErrNotPermitted, major, minor, err)
		}
		return fmt.Errorf("%w (%w)", ErrNotPermitted, err)
	case errors.Is(err, unix.EOPNOTSUPP), errors.Is(err, ebpf.ErrNotSupported):
		return fmt.Errorf("the kernel does not support this hook (%w)", err)
	}
	return err
}

// Drain flips the map the programs write to and returns what the other one counted,
// clearing it. Called every 15 s.
func (f *Flows) Drain() ([]Flow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	old := f.active
	f.active ^= 1
	if err := f.objs.Active.Put(uint32(0), f.active); err != nil {
		f.active = old
		return nil, err
	}
	// A program that read the old index just before the flip finishes within
	// microseconds; give it time before reading.
	time.Sleep(5 * time.Millisecond)
	f.drained = old
	m := f.objs.Flows0
	if old == 1 {
		m = f.objs.Flows1
	}
	var (
		key  flowsFlowKey
		vals []flowsFlowVal
		keys []flowsFlowKey
		out  []Flow
	)
	it := m.Iterate()
	for it.Next(&key, &vals) {
		keys = append(keys, key)
		out = append(out, sum(key, vals))
	}
	if err := it.Err(); err != nil {
		return nil, err
	}
	for i := range keys {
		_ = m.Delete(&keys[i])
	}
	return out, nil
}

func sum(k flowsFlowKey, vals []flowsFlowVal) Flow {
	f := Flow{Cgroup: k.Cgroup, Addr: netip.AddrFrom16(k.Daddr).Unmap(), Port: k.Dport}
	for _, v := range vals {
		f.Connects += v.Connects
		f.Failures += v.Failures
		f.Established += v.Established
		f.LatSumNs += v.LatSumNs
		for i := range v.Lat {
			f.Latency[i] += v.Lat[i]
		}
		f.BytesSent += v.BytesSent
		f.BytesRecv += v.BytesRecv
		f.Retransmits += v.Retransmits
	}
	return f
}

// dnsMsgHeader is struct dns_msg before its data: cgroup (u64), len (u32), pad (u32).
const dnsMsgHeader = 16

// ReadDNSResponses passes each DNS response with answers (at most 512 bytes of the DNS
// message, ADR-104) and each NXDOMAIN response up to its question (ADR-113) to handle
// with the cgroup that asked, until Close. The bytes are reused after handle returns.
// It returns at once when the DNS hooks are not attached.
func (f *Flows) ReadDNSResponses(handle func(cgroup uint64, msg []byte)) error {
	if !f.DNS {
		return nil
	}
	r, err := ringbuf.NewReader(f.objs.DnsAnswers)
	if err != nil {
		return err
	}
	f.mu.Lock()
	f.answers = r
	f.mu.Unlock()
	var rec ringbuf.Record
	for {
		if err := r.ReadInto(&rec); err != nil {
			if errors.Is(err, ringbuf.ErrClosed) {
				return nil
			}
			return err
		}
		b := rec.RawSample
		if len(b) < dnsMsgHeader {
			continue
		}
		n := int(binary.LittleEndian.Uint32(b[8:12]))
		if n > len(b)-dnsMsgHeader {
			n = len(b) - dnsMsgHeader
		}
		handle(binary.LittleEndian.Uint64(b[0:8]), b[dnsMsgHeader:dnsMsgHeader+n])
	}
}

// Close detaches the programs and frees the maps.
func (f *Flows) Close() {
	f.mu.Lock()
	if f.answers != nil {
		_ = f.answers.Close()
	}
	f.mu.Unlock()
	for _, l := range f.links {
		_ = l.Close()
	}
	f.links = nil
	for _, c := range f.extra {
		c.Close()
	}
	_ = f.objs.Close()
}

// DrainDNS returns and clears the DNS counters of the map the last Drain read.
func (f *Flows) DrainDNS() ([]DNSStat, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := f.objs.Dns0
	if f.drained == 1 {
		m = f.objs.Dns1
	}
	var (
		cg   uint64
		vals []flowsDnsVal
		keys []uint64
		out  []DNSStat
	)
	it := m.Iterate()
	for it.Next(&cg, &vals) {
		keys = append(keys, cg)
		d := DNSStat{Cgroup: cg}
		for _, v := range vals {
			d.Queries += v.Queries
			d.NoError += v.Rcode[0]
			d.ServFail += v.Rcode[1]
			d.NXDomain += v.Rcode[2]
			d.Other += v.Rcode[3]
			d.Timeouts += v.Timeouts
		}
		out = append(out, d)
	}
	if err := it.Err(); err != nil {
		return nil, err
	}
	for i := range keys {
		_ = m.Delete(&keys[i])
	}
	return out, nil
}

// SetRoots replaces the cgroups whose tasks the pod filter records (ADR-121): the node's
// kubepods cgroup ids. At most RootsMax; the rest are ignored.
func (f *Flows) SetRoots(ids []uint64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	want := map[uint64]bool{}
	for _, id := range ids {
		if len(want) < RootsMax {
			want[id] = true
		}
	}
	var (
		id    uint64
		v     uint8
		stale []uint64
	)
	it := f.objs.Roots.Iterate()
	for it.Next(&id, &v) {
		if !want[id] {
			stale = append(stale, id)
		}
	}
	if err := it.Err(); err != nil {
		return err
	}
	// Add before removing, so a root that moves never leaves the map empty.
	for id := range want {
		if err := f.objs.Roots.Put(id, uint8(1)); err != nil {
			return err
		}
	}
	for i := range stale {
		_ = f.objs.Roots.Delete(&stale[i])
	}
	return nil
}

// SetFilter turns the pod filter on or off. On with no roots records nothing, so the
// caller turns it on only once a root is known.
func (f *Flows) SetFilter(on bool) error {
	var v uint32
	if on {
		v = 1
	}
	return f.objs.Filter.Put(uint32(0), v)
}

// Filtered returns how many connections and DNS queries the pod filter left out since
// the programs were loaded.
func (f *Flows) Filtered() (connects, dns uint64, err error) {
	read := func(slot uint32) (uint64, error) {
		var per []uint64
		if err := f.objs.Filtered.Lookup(slot, &per); err != nil {
			return 0, err
		}
		var n uint64
		for _, v := range per {
			n += v
		}
		return n, nil
	}
	if connects, err = read(0); err != nil {
		return 0, 0, err
	}
	dns, err = read(1)
	return connects, dns, err
}
