// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"strings"
	"testing"

	"github.com/watchlog-light/watchlog/agent/internal/config"
)

func TestRunVersion(t *testing.T) {
	var out strings.Builder
	if code := run([]string{"--version"}, &out); code != 0 || !strings.HasPrefix(out.String(), "watchlog-agent ") {
		t.Fatalf("run --version = %d, %q", code, out.String())
	}
}

func TestRunRejectsBadFlags(t *testing.T) {
	var out strings.Builder
	for _, args := range [][]string{{"--mode=swarm"}, {"--once", "--output=json"}} {
		if code := run(args, &out); code != 2 {
			t.Errorf("run %v = %d, want 2", args, code)
		}
	}
}

func TestRunOncePrintsHostMetricsFromFixture(t *testing.T) {
	var out strings.Builder
	fixture := "../../internal/collectors/host/testdata/ubuntu-24.04-arm64"
	code := run([]string{"--once", "--mode=docker", "--host-proc=" + fixture + "/proc",
		"--host-sys=" + fixture + "/sys", "--host-root=/nonexistent", "--hostname=web-01",
		"--docker-socket=/nonexistent/docker.sock"}, &out) // never the developer's real Docker
	if code != 0 {
		t.Fatalf("run --once = %d", code)
	}
	if !strings.Contains(out.String(), `watchlog_node_load1{host="web-01"} 0.26 `) {
		t.Errorf("missing load1 line in:\n%s", out.String())
	}
}

func TestRunRequiresTokenAndEndpoint(t *testing.T) {
	t.Setenv("WATCHLOG_TOKEN", "")
	var out strings.Builder
	if code := run([]string{"--mode=docker", "--endpoint=http://x"}, &out); code != 2 {
		t.Errorf("missing token: exit %d", code)
	}
	t.Setenv("WATCHLOG_TOKEN", "wl_ct_x")
	if code := run([]string{"--mode=docker", "--endpoint=ftp://x"}, &out); code != 2 {
		t.Errorf("bad endpoint: exit %d", code)
	}
	if code := run([]string{"--mode=cluster", "--endpoint=http://x"}, &out); code != 2 {
		t.Errorf("cluster mode: exit %d", code)
	}
}

// The chart's release name goes into the heartbeat only when it looks like a name.
func TestHelmRelease(t *testing.T) {
	for in, want := range map[string]string{
		"watchlog-dev/kind-demo": "watchlog-dev/kind-demo",
		"watchlog-agent":         "watchlog-agent",
		"":                       "",
		"a b":                    "",
		"ns/Rel":                 "",
		strings.Repeat("a", 129): "",
	} {
		if got := helmRelease(in); got != want {
			t.Errorf("helmRelease(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestInstallMethod(t *testing.T) {
	file := func(s string, err error) func() ([]byte, error) {
		return func() ([]byte, error) { return []byte(s), err }
	}
	cases := []struct {
		mode      config.Mode
		container string
		read      func() ([]byte, error)
		want      string
	}{
		{config.ModeServer, "abc123", file("deb\n", nil), "docker"},
		{config.ModeServer, "", file("script\n", nil), "script"},
		{config.ModeServer, "", file("deb", nil), "deb"},
		{config.ModeServer, "", file(" rpm \n", nil), "rpm"},
		{config.ModeServer, "", file("something else", nil), ""},
		{config.ModeServer, "", file("", os.ErrNotExist), ""},
		{config.ModeNode, "abc123", file("script", nil), ""},
		{config.ModeCluster, "", file("script", nil), ""},
	}
	for _, c := range cases {
		if got := installMethod(c.mode, c.container, c.read); got != c.want {
			t.Errorf("installMethod(%s, %q) = %q, want %q", c.mode, c.container, got, c.want)
		}
	}
}
