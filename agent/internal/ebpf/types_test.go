// SPDX-License-Identifier: AGPL-3.0-only

package ebpf

import "testing"

func TestKernelVersion(t *testing.T) {
	for release, want := range map[string][2]int{
		"6.8.0-147-generic": {6, 8},
		"5.4.0-1103-aws":    {5, 4},
		"4.19.112+":         {4, 19},
		"5.10":              {5, 10},
	} {
		major, minor, ok := kernelVersion(release)
		if !ok || major != want[0] || minor != want[1] {
			t.Errorf("%s: %d.%d %v", release, major, minor, ok)
		}
	}
	if _, _, ok := kernelVersion("garbage"); ok {
		t.Error("parsed garbage")
	}
}
