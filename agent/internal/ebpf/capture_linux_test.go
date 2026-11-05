// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package ebpf

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// Captures 20 s of real flows on a node as a fixture: each flow with the cgroup path
// its id belongs to (WATCHLOG_EBPF_CAPTURE=<output file>). Run inside a kind node
// container, which sees the node's cgroup tree.
func TestCaptureFlows(t *testing.T) {
	out := os.Getenv("WATCHLOG_EBPF_CAPTURE")
	if out == "" {
		t.Skip("set WATCHLOG_EBPF_CAPTURE=<file> to capture flows")
	}
	f, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	_, _ = f.Drain()
	time.Sleep(20 * time.Second)
	flows, err := f.Drain()
	if err != nil {
		t.Fatal(err)
	}
	paths := map[uint64]string{}
	_ = filepath.WalkDir("/sys/fs/cgroup", func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.IsDir() {
			if fi, err := os.Stat(p); err == nil {
				paths[fi.Sys().(*syscall.Stat_t).Ino] = p
			}
		}
		return nil
	})
	type row struct {
		Cgroup string `json:"cgroup"`
		Addr   string `json:"addr"`
		Port   uint16 `json:"port"`
		Flow   Flow   `json:"flow"`
	}
	rows := make([]row, 0, len(flows))
	for _, fl := range flows {
		rows = append(rows, row{Cgroup: paths[fl.Cgroup], Addr: fl.Addr.String(), Port: fl.Port, Flow: fl})
	}
	b, _ := json.MarshalIndent(rows, "", "  ")
	if err := os.WriteFile(out, b, 0o644); err != nil {
		t.Fatal(err)
	}
}
