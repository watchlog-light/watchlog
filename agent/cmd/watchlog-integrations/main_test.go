// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestVersionAndRequiredSettings(t *testing.T) {
	var out bytes.Buffer
	if code := run([]string{"--version"}, &out); code != 0 || !strings.HasPrefix(out.String(), "watchlog-integrations ") {
		t.Fatalf("--version = %d %q", code, out.String())
	}
	if code := run([]string{"--mode", "swarm"}, &out); code != 2 {
		t.Errorf("unknown mode exit = %d, want 2", code)
	}
	t.Setenv("WATCHLOG_TOKEN", "")
	t.Setenv("WATCHLOG_ENDPOINT", "")
	if code := run([]string{"--mode", "docker", "--hostname", "h"}, &out); code != 2 {
		t.Errorf("missing token exit = %d, want 2", code)
	}
	t.Setenv("WATCHLOG_TOKEN", "x")
	if code := run([]string{"--mode", "docker", "--hostname", "h", "--endpoint", "ftp://x"}, &out); code != 2 {
		t.Errorf("bad endpoint exit = %d, want 2", code)
	}
}
