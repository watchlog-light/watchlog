// SPDX-License-Identifier: AGPL-3.0-only

// Package network collects TCP flows with eBPF (SPEC §6.4, ADR-099).
package network

import (
	"errors"
	"log/slog"
	"strings"

	"github.com/watchlog-light/watchlog/agent/internal/ebpf"
)

// Why eBPF is not running, as the heartbeat's ebpf_cause: the UI turns it into a fix.
const (
	CauseConfig     = "config"     // turned off with --ebpf=false / WATCHLOG_EBPF=false
	CauseKernel     = "kernel"     // kernel too old, no BTF, cgroup v1 or not Linux
	CausePermission = "permission" // BPF or PERFMON capability missing
	CauseLoad       = "load"       // the programs failed to load for another reason
)

// State is what the heartbeat reports: enabled, unsupported or disabled, why, and the
// cause code for anything but enabled.
type State struct {
	State  string
	Reason string
	Cause  string
}

// Disabled is the state when eBPF is turned off by configuration.
var Disabled = State{State: "disabled", Reason: "turned off by configuration (WATCHLOG_EBPF=false)", Cause: CauseConfig}

// Start checks the kernel and loads the flow programs. Any failure is a reason, never
// fatal: the agent's other collectors keep working (ADR-102).
func Start(sys string, http bool, log *slog.Logger) (*ebpf.Flows, State) {
	release := ebpf.KernelRelease()
	if s := ebpf.CheckSupport(release, sys); !s.OK {
		log.Warn("eBPF network flows unsupported", "kernel", release, "reason", s.Reason)
		return nil, State{State: "unsupported", Reason: s.Reason, Cause: CauseKernel}
	}
	flows, err := ebpf.LoadWith(ebpf.Options{HTTP: http})
	if err != nil {
		log.Warn("eBPF network flows could not load", "kernel", release, "err", err)
		return nil, failed(err)
	}
	st := State{State: "enabled"}
	var missing []string
	if !flows.Bytes {
		missing = append(missing, "no byte counts: "+flows.BytesReason)
	}
	if !flows.DNS {
		missing = append(missing, "no DNS errors: "+flows.DNSReason)
	}
	if http && !flows.HTTP {
		missing = append(missing, "no HTTP stats: "+flows.HTTPReason)
	}
	st.Reason = clip(strings.Join(missing, "; "))
	log.Info("eBPF network flows enabled", "kernel", release, "bytes", flows.Bytes, "dns", flows.DNS, "http", flows.HTTP)
	return flows, st
}

// failed is the state for a load error: missing capabilities or anything else.
func failed(err error) State {
	cause := CauseLoad
	if errors.Is(err, ebpf.ErrNotPermitted) {
		cause = CausePermission
	}
	return State{State: "unsupported", Reason: clip(err.Error()), Cause: cause}
}

// clip keeps a reason within what the heartbeat accepts.
func clip(s string) string {
	if len(s) > 300 {
		return s[:297] + "..."
	}
	return s
}
