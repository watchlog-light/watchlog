// SPDX-License-Identifier: AGPL-3.0-only

package ebpf

import (
	"errors"
	"net/netip"
	"strconv"
	"strings"
)

// LatencyBuckets are the upper bounds of the connect latency histogram in seconds,
// matching lat_bucket() in bpf/flows.bpf.c; the last bucket is +Inf.
var LatencyBuckets = []float64{0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1}

// Flow is one (cgroup, destination, port) aggregate since the previous drain.
type Flow struct {
	Cgroup      uint64
	Addr        netip.Addr
	Port        uint16
	Connects    uint64
	Failures    uint64
	Established uint64
	LatSumNs    uint64
	Latency     [12]uint64 // per bucket, not cumulative
	BytesSent   uint64
	BytesRecv   uint64
	Retransmits uint64
}

// DNSStat is one container's DNS outcomes since the previous drain: rcodes from the
// response header only, timeouts for queries unanswered when the socket closed.
type DNSStat struct {
	Cgroup   uint64
	Queries  uint64
	NoError  uint64
	ServFail uint64
	NXDomain uint64
	Other    uint64
	Timeouts uint64
}

// ErrNotPermitted wraps load errors caused by missing capabilities (BPF, PERFMON), so the
// heartbeat can say "missing capability" rather than "unsupported".
var ErrNotPermitted = errors.New("not permitted: the agent needs the BPF and PERFMON capabilities")

// Support says whether this kernel can run the flow programs, and if not, why.
type Support struct {
	OK     bool
	Reason string
}

// MinKernel is the oldest kernel the programs support: BTF raw tracepoints and
// BPF/PERFMON capabilities (SPEC §6.1, ADR-102).
var MinKernel = [2]int{5, 8}

func kernelVersion(release string) (int, int, bool) {
	parts := strings.SplitN(release, ".", 3)
	if len(parts) < 2 {
		return 0, 0, false
	}
	digits := func(s string) string {
		n := 0
		for n < len(s) && s[n] >= '0' && s[n] <= '9' {
			n++
		}
		return s[:n]
	}
	major, err1 := strconv.Atoi(digits(parts[0]))
	minor, err2 := strconv.Atoi(digits(parts[1]))
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return major, minor, true
}
