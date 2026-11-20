// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package ebpf

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// The exit and cron exec programs load and report a run as cron starts it: a process named
// cron whose child execs `sh -c <command>` and exits with its code (WATCHLOG_EBPF_TEST=1, as
// root).
func TestExitsAndCronExecs(t *testing.T) {
	if os.Getenv("WATCHLOG_EBPF_TEST") != "1" {
		t.Skip("set WATCHLOG_EBPF_TEST=1")
	}
	ex, err := StartExits()
	if err != nil {
		t.Fatal(err)
	}
	defer ex.Close()
	if !ex.Execs() {
		t.Fatal("the exec program didn't attach")
	}
	execs := make(chan ExecEvent, 16)
	go ex.ReadExecs(func(e ExecEvent) { execs <- e })
	exits := make(chan ExitEvent, 1024)
	go func() { _ = ex.Read(func(e ExitEvent) { exits <- e }) }()

	// A shell named cron: its child (named cron until it execs) runs the job.
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Fatal(err)
	}
	// A link named cron: the kernel names the process after the path it ran (the test's temp
	// directory may be mounted noexec; the shell itself isn't).
	cron := filepath.Join(t.TempDir(), "cron")
	if err := os.Symlink(sh, cron); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(cron, "-c", sh+` -c 'sleep 0.2; exit 3'; true`) //nolint:gosec // test input
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	var job ExecEvent
	select {
	case job = <-execs:
	case <-time.After(5 * time.Second):
		t.Fatal("no exec seen")
	}
	if len(job.Args) != 3 || job.Args[1] != "-c" || job.Args[2] != "sleep 0.2; exit 3" || job.Comm != "sh" {
		t.Fatalf("exec: %+v", job)
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case e := <-exits:
			if e.Tgid == job.Tgid {
				if e.Status != 3 || e.Signal != 0 {
					t.Fatalf("exit: %+v", e)
				}
				return
			}
		case <-deadline:
			t.Fatal("the job's exit wasn't seen")
		}
	}
}
