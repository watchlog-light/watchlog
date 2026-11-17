// SPDX-License-Identifier: AGPL-3.0-only

package ebpf

import "testing"

func TestExitFromStatus(t *testing.T) {
	cases := []struct {
		code        int32
		status, sig int
		core        bool
	}{
		{0, 0, 0, false},          // exit(0)
		{3 << 8, 3, 0, false},     // exit(3): the measured orders crash
		{9, 0, 9, false},          // SIGKILL (the OOM killer's)
		{0x80 | 11, 0, 11, true},  // SIGSEGV with a core
		{255 << 8, 255, 0, false}, // exit(-1)
	}
	for _, c := range cases {
		e := exitFromStatus(1, c.code, 7, false, "orders")
		if e.Status != c.status || e.Signal != c.sig || e.Core != c.core {
			t.Errorf("code %#x: got %+v", c.code, e)
		}
	}
}
