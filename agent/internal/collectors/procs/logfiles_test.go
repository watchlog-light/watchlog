// SPDX-License-Identifier: AGPL-3.0-only

package procs

import (
	"testing"
	"testing/fstest"
)

func TestLogFiles(t *testing.T) {
	fsys := fstest.MapFS{
		"home/app/.pm2/logs/api-out.log":   {Data: []byte("x")},
		"home/app/.pm2/logs/api-error.log": {Data: []byte("x")},
		"etc/supervisor/conf.d/worker.conf": {Data: []byte(
			"[program:worker]\ncommand=/usr/bin/python3 /opt/wl-apps/worker.py\nstdout_logfile=/var/log/supervisor/%(program_name)s.log\nstderr_logfile=AUTO\n")},
		"var/log/supervisor/worker.log": {Data: []byte("x")},
	}
	pm2 := LogFiles(fsys, "", "api", "pm2")
	if pm2["stdout"] != "home/app/.pm2/logs/api-out.log" || pm2["stderr"] != "home/app/.pm2/logs/api-error.log" {
		t.Fatalf("%v", pm2)
	}
	sup := LogFiles(fsys, "", "worker", "supervisord")
	if len(sup) != 1 || sup["stdout"] != "var/log/supervisor/worker.log" {
		t.Fatalf("%v", sup)
	}
	if len(LogFiles(fsys, "", "sync.py", "script")) != 0 {
		t.Fatal("a script has no manager's log")
	}
}
