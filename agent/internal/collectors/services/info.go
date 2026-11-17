// SPDX-License-Identifier: AGPL-3.0-only

package services

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// ServerInfo is the server page's header (ADR-207): the OS, the kernel and systemd's version,
// as one info series. rootFS is the host's root (/ natively), procRoot its /proc.
func ServerInfo(rootFS, procRoot string, systemd func() string) func() ([]metrics.Sample, error) {
	osName := osRelease(rootFS)
	return func() ([]metrics.Sample, error) {
		kernel := ""
		if b, err := os.ReadFile(filepath.Join(procRoot, "sys", "kernel", "osrelease")); err == nil { //nolint:gosec // a fixed /proc file
			kernel = strings.TrimSpace(string(b))
		}
		sd := ""
		if systemd != nil {
			sd = systemd()
		}
		return []metrics.Sample{metrics.New("watchlog_server_info", 1, "os", osName, "kernel", kernel, "systemd", sd)}, nil
	}
}

// osRelease is os-release's PRETTY_NAME ("Debian GNU/Linux 12 (bookworm)"), else NAME.
func osRelease(rootFS string) string {
	for _, p := range []string{"etc/os-release", "usr/lib/os-release"} {
		f, err := os.Open(filepath.Join(rootFS, p)) //nolint:gosec // os-release under the host root
		if err != nil {
			continue
		}
		var name, pretty string
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			k, v, ok := strings.Cut(sc.Text(), "=")
			if !ok {
				continue
			}
			v = strings.Trim(v, `"'`)
			switch k {
			case "PRETTY_NAME":
				pretty = v
			case "NAME":
				name = v
			}
		}
		_ = f.Close()
		if pretty != "" {
			return pretty
		}
		if name != "" {
			return name
		}
	}
	return ""
}
