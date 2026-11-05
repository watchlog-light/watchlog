// SPDX-License-Identifier: AGPL-3.0-only

package version

import (
	"runtime"
	"strings"
	"testing"
)

func TestStringContainsBuildMetadata(t *testing.T) {
	Version, Commit = "1.2.3", "abc1234"
	t.Cleanup(func() { Version, Commit = "dev", "unknown" })

	got := String()
	for _, want := range []string{"watchlog-agent 1.2.3", "commit abc1234", runtime.GOOS + "/" + runtime.GOARCH} {
		if !strings.Contains(got, want) {
			t.Errorf("String() = %q, want it to contain %q", got, want)
		}
	}
}
