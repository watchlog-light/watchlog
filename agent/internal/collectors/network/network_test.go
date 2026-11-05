// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/watchlog-light/watchlog/agent/internal/ebpf"
)

// The heartbeat's cause code decides the fix the UI shows (config, kernel,
// permission, load).
func TestFailedLoadCause(t *testing.T) {
	perm := failed(fmt.Errorf("load flows: %w (operation not permitted)", ebpf.ErrNotPermitted))
	if perm.State != "unsupported" || perm.Cause != CausePermission {
		t.Fatalf("missing capability: got %+v", perm)
	}
	other := failed(errors.New("attach tcp_sendmsg: invalid argument"))
	if other.Cause != CauseLoad {
		t.Fatalf("other load error: got %+v", other)
	}
	long := failed(errors.New(strings.Repeat("x", 400)))
	if len(long.Reason) != 300 {
		t.Fatalf("reason not clipped: %d", len(long.Reason))
	}
	if Disabled.State != "disabled" || Disabled.Cause != CauseConfig || Disabled.Reason == "" {
		t.Fatalf("disabled by configuration: got %+v", Disabled)
	}
}
