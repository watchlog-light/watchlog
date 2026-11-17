// SPDX-License-Identifier: AGPL-3.0-only

package services

import (
	"os"
	"path/filepath"
	"testing"
)

func TestServerInfo(t *testing.T) {
	root, proc := t.TempDir(), t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "etc"), 0o755)
	_ = os.WriteFile(filepath.Join(root, "etc", "os-release"), []byte("NAME=\"Debian GNU/Linux\"\nPRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\n"), 0o644)
	_ = os.MkdirAll(filepath.Join(proc, "sys", "kernel"), 0o755)
	_ = os.WriteFile(filepath.Join(proc, "sys", "kernel", "osrelease"), []byte("6.1.0-53-cloud-arm64\n"), 0o644)
	ss, err := ServerInfo(root, proc, func() string { return "252" })()
	if err != nil || len(ss) != 1 {
		t.Fatal(ss, err)
	}
	got := map[string]string{}
	for _, l := range ss[0].Labels {
		got[l.Name] = l.Value
	}
	if got["os"] != "Debian GNU/Linux 12 (bookworm)" || got["kernel"] != "6.1.0-53-cloud-arm64" || got["systemd"] != "252" {
		t.Fatalf("%v", got)
	}
}
