// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package ebpf

import (
	"errors"
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

	// This test binary, run through a link named cron, plays cron: the kernel names a process
	// after the path it ran, so its child shell's parent is "cron" whatever the shell is (CI's
	// may be busybox, which a link named cron would turn into an unknown applet). A link: the
	// test's temp directory may be mounted noexec; the binary itself isn't.
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cron := filepath.Join(t.TempDir(), "cron")
	if err := os.Symlink(self, cron); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(cron, "-test.run=^TestFakeCron$") //nolint:gosec // this test binary
	cmd.Env = append(os.Environ(), "WATCHLOG_FAKE_CRON=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
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

// TestFakeCron is the cron TestExitsAndCronExecs runs: a child shell with a job that exits 3.
func TestFakeCron(t *testing.T) {
	if os.Getenv("WATCHLOG_FAKE_CRON") != "1" {
		t.Skip("run by TestExitsAndCronExecs")
	}
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Fatal(err)
	}
	err = exec.Command(sh, "-c", "sleep 0.2; exit 3").Run() //nolint:gosec // test input
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 3 {
		t.Fatalf("the job: %v", err)
	}
}
