// SPDX-License-Identifier: AGPL-3.0-only

package procs

import (
	"strconv"
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

// pm2 run by an account whose home isn't in /home (www-data's /var/www, as `pm2 startup`
// sets it up for a web user): its apps are named from its pid files and its logs are found,
// from the home in /etc/passwd. "/" and /nonexistent homes are never looked at.
func TestPM2OutsideHome(t *testing.T) {
	fsys := fstest.MapFS{
		"host/etc/passwd": {Data: []byte("root:x:0:0:root:/root:/bin/bash\n" +
			"daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n" +
			"www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\n" +
			"nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n" +
			"odd:x:9:9::/:/bin/sh\n" + "broken line\n")},
		"host/var/www/.pm2/pids/api-0.pid":     {Data: []byte("4242\n")},
		"host/var/www/.pm2/logs/api-out.log":   {Data: []byte("x")},
		"host/var/www/.pm2/logs/api-error.log": {Data: []byte("x")},
	}
	if got := pm2Apps(fsys, "host"); got[4242] != "api" || len(got) != 1 {
		t.Fatalf("pm2 apps: %v", got)
	}
	logs := LogFiles(fsys, "host", "api", "pm2")
	if logs["stdout"] != "host/var/www/.pm2/logs/api-out.log" || logs["stderr"] != "host/var/www/.pm2/logs/api-error.log" {
		t.Fatalf("pm2 logs: %v", logs)
	}
	homes := userHomes(fsys, "host")
	want := []string{"host/root", "host/usr/sbin", "host/var/www"}
	if len(homes) != len(want) {
		t.Fatalf("homes: %v", homes)
	}
	for i := range want {
		if homes[i] != want[i] {
			t.Fatalf("homes: %v, want %v", homes, want)
		}
	}
}

// BenchmarkReadHints: a scrape's pm2 and supervisord lookup on a server with 60 accounts in
// /etc/passwd, 20 homes in /home and one pm2 with 8 apps (SPEC §6.1's budget: well under
// a millisecond a scrape).
func BenchmarkReadHints(b *testing.B) {
	fsys := fstest.MapFS{}
	var passwd string
	for i := range 60 {
		passwd += "svc" + strconv.Itoa(i) + ":x:1:1::/var/lib/svc" + strconv.Itoa(i) + ":/usr/sbin/nologin\n"
	}
	passwd += "www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\n"
	fsys["etc/passwd"] = &fstest.MapFile{Data: []byte(passwd)}
	for i := range 20 {
		fsys["home/u"+strconv.Itoa(i)+"/.profile"] = &fstest.MapFile{Data: []byte("x")}
	}
	for i := range 8 {
		fsys["var/www/.pm2/pids/app"+strconv.Itoa(i)+"-"+strconv.Itoa(i)+".pid"] = &fstest.MapFile{Data: []byte(strconv.Itoa(1000 + i))}
	}
	b.ReportAllocs()
	for b.Loop() {
		if h := ReadHints(fsys, ""); len(h.PM2) != 8 {
			b.Fatal(h.PM2)
		}
	}
}
