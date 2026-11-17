// SPDX-License-Identifier: AGPL-3.0-only

package procs

import (
	"fmt"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

type fakeProc struct {
	pid, ppid      int
	comm, cmdline  string // cmdline: NUL-separated argv, or a rewritten title
	cgroup         string
	cpu, start     uint64
	threads, rssKB int
}

// The processes measured on Ubuntu 24.04 (phases/v0.9-measure/ubuntu-24.04.txt).
func ubuntu() []fakeProc {
	nul := func(args ...string) string { return strings.Join(args, "\x00") + "\x00" }
	return []fakeProc{
		{pid: 1, ppid: 0, comm: "systemd", cmdline: nul("/sbin/init"), cgroup: "/init.scope", cpu: 50, start: 1, threads: 1, rssKB: 9000},
		{pid: 2, ppid: 0, comm: "kthreadd", cgroup: "/", start: 1},
		{pid: 40, ppid: 2, comm: "kworker/0:1", cgroup: "/", start: 2},
		{pid: 14072, ppid: 1, comm: "nginx", cmdline: "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;", cgroup: "/system.slice/nginx.service", cpu: 3, start: 100, threads: 1, rssKB: 4000},
		{pid: 14074, ppid: 14072, comm: "nginx", cmdline: "nginx: worker process", cgroup: "/system.slice/nginx.service", cpu: 2, start: 101, threads: 1, rssKB: 3000},
		{pid: 22371, ppid: 1, comm: "php-fpm8.3", cmdline: "php-fpm: master process (/etc/php/8.3/fpm/php-fpm.conf)", cgroup: "/system.slice/php8.3-fpm.service", cpu: 4, start: 200, threads: 1, rssKB: 8000},
		{pid: 22372, ppid: 22371, comm: "php-fpm8.3", cmdline: "php-fpm: pool www", cgroup: "/system.slice/php8.3-fpm.service", cpu: 10, start: 201, threads: 1, rssKB: 12000},
		{pid: 22373, ppid: 22371, comm: "php-fpm8.3", cmdline: "php-fpm: pool www", cgroup: "/system.slice/php8.3-fpm.service", cpu: 11, start: 201, threads: 1, rssKB: 12000},
		{pid: 26900, ppid: 1, comm: "PM2 v7.1.2: God", cmdline: "PM2 v7.1.2: God Daemon (/home/app/.pm2)", cgroup: "/system.slice/pm2-app.service", cpu: 6, start: 300, threads: 11, rssKB: 50000},
		{pid: 26915, ppid: 26900, comm: "node /opt/wl-ap", cmdline: "node /opt/wl-apps/api.js", cgroup: "/system.slice/pm2-app.service", cpu: 30, start: 301, threads: 7, rssKB: 60000},
		{pid: 26916, ppid: 26900, comm: "node /opt/wl-ap", cmdline: "node /opt/wl-apps/api.js", cgroup: "/system.slice/pm2-app.service", cpu: 5, start: 301, threads: 7, rssKB: 40000},
		{pid: 9174, ppid: 1, comm: "supervisord", cmdline: nul("/usr/bin/python3", "/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"), cgroup: "/system.slice/supervisor.service", cpu: 1, start: 90, threads: 1, rssKB: 20000},
		{pid: 26714, ppid: 9174, comm: "python3", cmdline: nul("python3", "/opt/wl-apps/worker.py"), cgroup: "/system.slice/supervisor.service", cpu: 2, start: 302, threads: 1, rssKB: 9000},
		{pid: 23714, ppid: 1, comm: "gunicorn", cmdline: nul("/usr/bin/python3", "/usr/bin/gunicorn", "--workers", "2", "--bind", "0.0.0.0:8094", "app:app"), cgroup: "/system.slice/shop.service", cpu: 4, start: 303, threads: 1, rssKB: 22000},
		{pid: 23730, ppid: 23714, comm: "gunicorn", cmdline: nul("/usr/bin/python3", "/usr/bin/gunicorn", "--workers", "2", "--bind", "0.0.0.0:8094", "app:app"), cgroup: "/system.slice/shop.service", cpu: 2, start: 304, threads: 1, rssKB: 20000},
		{pid: 23875, ppid: 1, comm: "java", cmdline: nul("java", "-jar", "/opt/wl-apps/billing.jar"), cgroup: "/user.slice/user-501.slice/session-6.scope", cpu: 90, start: 305, threads: 20, rssKB: 120000},
		{pid: 23655, ppid: 1, comm: "orders", cmdline: nul("/opt/wl-apps/orders"), cgroup: "/system.slice/orders.service", cpu: 7, start: 306, threads: 5, rssKB: 6000},
		{pid: 24033, ppid: 24009, comm: "redis-server", cmdline: "redis-server *:6379", cgroup: "/system.slice/docker-295029bbdb91.scope", cpu: 8, start: 307, threads: 5, rssKB: 7000},
		{pid: 31000, ppid: 1, comm: "watchlog-agent", cmdline: nul("/usr/bin/watchlog-agent", "--mode=server"), cgroup: "/system.slice/watchlog-agent.service", cpu: 3, start: 400, threads: 9, rssKB: 30000},
	}
}

func mapFS(ps []fakeProc, extra fstest.MapFS) fstest.MapFS {
	m := fstest.MapFS{}
	for _, p := range ps {
		d := fmt.Sprintf("proc/%d/", p.pid)
		// pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt
		// utime stime cutime cstime priority nice num_threads itrealvalue starttime …
		m[d+"stat"] = &fstest.MapFile{Data: []byte(fmt.Sprintf("%d (%s) S %d 0 0 0 0 0 0 0 0 0 %d 0 0 0 20 0 %d 0 %d 0 0\n",
			p.pid, p.comm, p.ppid, p.cpu, p.threads, p.start))}
		m[d+"cmdline"] = &fstest.MapFile{Data: []byte(p.cmdline)}
		m[d+"status"] = &fstest.MapFile{Data: []byte(fmt.Sprintf("Name:\t%s\nUid:\t1000\t1000\t1000\t1000\nVmRSS:\t%d kB\n", p.comm, p.rssKB))}
		m[d+"cgroup"] = &fstest.MapFile{Data: []byte("0::" + p.cgroup + "\n")}
	}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func ubuntuHints() fstest.MapFS {
	return fstest.MapFS{
		"home/app/.pm2/pids/api-0.pid":    &fstest.MapFile{Data: []byte("26915")},
		"home/app/.pm2/pids/mailer-1.pid": &fstest.MapFile{Data: []byte("26916")},
		"etc/supervisor/conf.d/worker.conf": &fstest.MapFile{Data: []byte(
			"[program:worker]\ncommand=python3 /opt/wl-apps/worker.py\nuser=app\nautorestart=true\n")},
	}
}

func newCollector(fsys fstest.MapFS, at *time.Time) *Collector {
	return &Collector{
		Reader: &Reader{FS: fsys, Root: "proc"},
		Hints:  func() Hints { return ReadHints(fsys, "") },
		Self:   31000,
		Now:    func() time.Time { return *at },
	}
}

// groups maps "unit/group" to its series' values by name (and exit kind).
func groups(ss []metrics.Sample) map[string]map[string]float64 {
	out := map[string]map[string]float64{}
	for _, s := range ss {
		var group, unit, exit string
		for _, l := range s.Labels {
			switch l.Name {
			case "group":
				group = l.Value
			case "unit":
				unit = l.Value
			case "exit":
				exit = l.Value
			}
		}
		if group == "" {
			continue
		}
		k := unit + "/" + group
		if out[k] == nil {
			out[k] = map[string]float64{}
		}
		name := strings.TrimPrefix(s.Name, "watchlog_process_group_")
		if exit != "" {
			name += ":" + exit
		}
		out[k][name] = s.Value
	}
	return out
}

func TestGroupsAsMeasured(t *testing.T) {
	at := time.Unix(1_794_900_000, 0)
	c := newCollector(mapFS(ubuntu(), ubuntuHints()), &at)
	ss, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	g := groups(ss)
	var keys []string
	for k := range g {
		keys = append(keys, k)
	}
	want := map[string]float64{
		// pm2's two apps, told apart by its pid files though /proc shows the same title.
		"pm2-app.service/api":    1,
		"pm2-app.service/mailer": 1,
		"pm2-app.service/pm2":    1,
		// PHP-FPM's pools and master.
		"php8.3-fpm.service/pool www":       2,
		"php8.3-fpm.service/php-fpm master": 1,
		// supervisord's program by its configuration, and supervisord itself.
		"supervisor.service/worker":      1,
		"supervisor.service/supervisord": 1,
		// gunicorn's master and worker share a cmdline: one group, two instances.
		"shop.service/gunicorn app:app": 2,
		// Started by hand: the jar's name, no unit.
		"/billing.jar": 1,
		// PID 1 (init.scope) is a process outside any service: "init" from its argument here;
		// on a server /proc/1/exe names it systemd.
		"/init": 1,
	}
	for k, n := range want {
		if g[k] == nil || g[k]["instances"] != n {
			t.Errorf("%s: instances %v, want %v (groups: %v)", k, g[k]["instances"], n, keys)
		}
	}
	// Left out: nginx alone in nginx.service and orders alone in orders.service (the
	// service covers them), the container's redis, kernel threads, the agent itself.
	for _, k := range []string{"nginx.service/nginx", "orders.service/orders", "/redis-server", "/kworker/0:1", "watchlog-agent.service/watchlog-agent"} {
		if g[k] != nil {
			t.Errorf("%s should not be a group", k)
		}
	}
	if len(g) != len(want) {
		t.Errorf("%d groups, want %d: %v", len(g), len(want), keys)
	}
	if got := g["/billing.jar"]["cpu_seconds_total"]; got != 0.9 {
		t.Errorf("billing CPU %v s, want 0.9 (90 ticks)", got)
	}
	if got := g["pm2-app.service/api"]["memory_rss_bytes"]; got != 60000*1024 {
		t.Errorf("api RSS %v", got)
	}
}

func TestExitsStartsReleasesAndCPU(t *testing.T) {
	at := time.Unix(1_794_900_000, 0)
	procs := ubuntu()
	fsys := mapFS(procs, ubuntuHints())
	c := newCollector(fsys, &at)
	ids := map[int]string{26915: "inode1"}
	c.Reader.ExeIdentity = func(pid int) string { return ids[pid] }
	if _, err := c.Collect(); err != nil {
		t.Fatal(err)
	}
	// pm2 restarts api with a new binary (pid 27000), the old process ended with code 1;
	// one php-fpm worker was OOM-killed; billing's java pid is reused by a new process.
	at = at.Add(15 * time.Second)
	next := []fakeProc{}
	for _, p := range procs {
		switch p.pid {
		case 26915, 22373:
			continue
		case 23875:
			p.start = 999 // the same pid, a different process
			p.cpu = 1
		}
		next = append(next, p)
	}
	next = append(next, fakeProc{pid: 27000, ppid: 26900, comm: "node /opt/wl-ap", cmdline: "node /opt/wl-apps/api.js",
		cgroup: "/system.slice/pm2-app.service", cpu: 1, start: 500, threads: 7, rssKB: 30000})
	fsys2 := mapFS(next, fstest.MapFS{
		"home/app/.pm2/pids/api-0.pid":      &fstest.MapFile{Data: []byte("27000")},
		"home/app/.pm2/pids/mailer-1.pid":   &fstest.MapFile{Data: []byte("26916")},
		"etc/supervisor/conf.d/worker.conf": ubuntuHints()["etc/supervisor/conf.d/worker.conf"],
	})
	c.Reader.FS = fsys2
	c.Hints = func() Hints { return ReadHints(fsys2, "") }
	ids[27000] = "inode2"
	c.Exits = func() map[int]Exit {
		return map[int]Exit{26915: {Code: 1}, 22373: {Signal: 9, OOM: true}}
	}
	ss, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	g := groups(ss)
	api := g["pm2-app.service/api"]
	if api["exits_total:error"] != 1 || api["starts_total"] != 1 || api["releases_total"] != 1 {
		t.Errorf("api: %v", api)
	}
	// CPU never goes back: the ended process's 30 ticks stay in the counter.
	if api["cpu_seconds_total"] != 0.31 {
		t.Errorf("api CPU %v, want 0.31", api["cpu_seconds_total"])
	}
	pool := g["php8.3-fpm.service/pool www"]
	if pool["oom_kills_total"] != 1 || pool["exits_total:signal"] != 1 || pool["instances"] != 1 {
		t.Errorf("pool: %v", pool)
	}
	billing := g["/billing.jar"]
	if billing["starts_total"] != 1 || billing["exits_total:unknown"] != 1 {
		t.Errorf("a reused pid is an exit and a start: %v", billing)
	}
	// The first scan counts no starts.
	if g["/init"]["starts_total"] != 0 {
		t.Error("the first scan is the baseline")
	}
}

func TestGroupGoneIsKeptAnHour(t *testing.T) {
	at := time.Unix(1_794_900_000, 0)
	procs := ubuntu()
	c := newCollector(mapFS(procs, ubuntuHints()), &at)
	if _, err := c.Collect(); err != nil {
		t.Fatal(err)
	}
	var rest []fakeProc
	for _, p := range procs {
		if p.pid != 23875 {
			rest = append(rest, p)
		}
	}
	c.Reader.FS = mapFS(rest, ubuntuHints())
	at = at.Add(30 * time.Minute)
	ss, _ := c.Collect()
	if g := groups(ss)["/billing.jar"]; g == nil || g["instances"] != 0 || g["exits_total:unknown"] != 1 {
		t.Fatalf("a gone group stays with 0 instances: %v", g)
	}
	at = at.Add(31 * time.Minute)
	ss, _ = c.Collect()
	if groups(ss)["/billing.jar"] != nil {
		t.Fatal("forgotten after an hour")
	}
}

func TestLimitAndOther(t *testing.T) {
	at := time.Unix(1_794_900_000, 0)
	c := newCollector(mapFS(ubuntu(), ubuntuHints()), &at)
	c.Limit = 3
	ss, _ := c.Collect()
	g := groups(ss)
	if len(g) != 4 || g["/"+OtherGroup] == nil || c.Dropped != 7 {
		t.Fatalf("3 groups and other processes, dropped %d: %v", c.Dropped, g)
	}
	// The busiest by CPU stay: billing.jar (90), init (50), api (30).
	for _, k := range []string{"/billing.jar", "/init", "pm2-app.service/api"} {
		if g[k] == nil {
			t.Errorf("%s should be kept", k)
		}
	}
}

func TestRulesAndNames(t *testing.T) {
	rules := []Rule{
		{Exe: "java", Args: `-Dapp=(\w+)`, Name: "java $1"},
		{Unit: "worker-*.service", Name: "workers"},
		{Args: `--token=(\S+)`, Name: "leaky $1"},
	}
	for i := range rules {
		if err := rules[i].Compile(); err != nil {
			t.Fatal(err)
		}
	}
	nul := func(a ...string) []string { return a }
	cases := []struct {
		p          Proc
		parent     string
		unit, want string
	}{
		{Proc{Comm: "java", Args: nul("/usr/bin/java", "-Dapp=ledger", "-jar", "x.jar")}, "", "", "java ledger"},
		{Proc{Comm: "python3", Args: nul("python3", "q.py")}, "", "worker-3.service", "workers"},
		// A user's template never leaks a secret it captured.
		{Proc{Comm: "srv", Args: nul("/opt/srv", "--token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")}, "", "", "leaky ***"},
		{Proc{Comm: "java", Args: nul("java", "-cp", "lib/*", "com.acme.Main")}, "", "", "com.acme.Main"},
		{Proc{Comm: "python3", Args: nul("python3", "-m", "celery", "worker")}, "", "", "celery"},
		{Proc{Comm: "node", Args: nul("/usr/bin/node", "--max-old-space-size=512", "dist/server.js")}, "", "", "server.js"},
		{Proc{Comm: "uwsgi", Args: nul("/usr/bin/uwsgi", "--module", "shop.wsgi")}, "", "", "uwsgi shop.wsgi"},
		{Proc{Comm: "gunicorn", Args: []string{"gunicorn:", "master", "[shop]"}}, "", "", "gunicorn shop"},
		{Proc{Comm: "myd", Args: nul("/srv/bin/myd", "-c", "/etc/myd.conf")}, "", "", "myd"},
	}
	for _, tc := range cases {
		if got, _ := Name(tc.p, tc.parent, tc.unit, rules, Hints{}); got != tc.want {
			t.Errorf("%v: got %q, want %q", tc.p.Args, got, tc.want)
		}
	}
	if (&Rule{Args: "("}).Compile() == nil {
		t.Error("a bad pattern is refused")
	}
}

func groupOf(s metrics.Sample) string {
	for _, l := range s.Labels {
		if l.Name == "group" {
			return l.Value
		}
	}
	return ""
}

func TestNoPIDOrCommandLineInLabels(t *testing.T) {
	at := time.Unix(1_794_900_000, 0)
	c := newCollector(mapFS(ubuntu(), ubuntuHints()), &at)
	ss, _ := c.Collect()
	byRule := map[string]string{}
	for _, s := range ss {
		for _, l := range s.Labels {
			if l.Name == "by" {
				byRule[groupOf(s)] = l.Value
			}
			switch l.Name {
			case "group", "unit", "exit", "by":
			default:
				t.Fatalf("%s has label %s", s.Name, l.Name)
			}
			if strings.Contains(l.Value, "/opt/") || strings.Contains(l.Value, "--") {
				t.Fatalf("%s carries part of a command line: %q", s.Name, l.Value)
			}
		}
	}
	if byRule["api"] != "pm2" {
		t.Errorf("api's rule: got %q, want pm2 (%v)", byRule["api"], byRule)
	}
}

func TestCgroupAndUnit(t *testing.T) {
	if got := cgroupV2("12:pids:/system.slice/x.service\n1:name=systemd:/system.slice/x.service\n0::/\n"); got != "/" {
		t.Errorf("v2 first: %q", got)
	}
	if got := cgroupV2("12:pids:/system.slice/a.service\n1:name=systemd:/system.slice/x.service\n"); got != "/system.slice/x.service" {
		t.Errorf("v1 name=systemd: %q", got)
	}
	if Unit("/system.slice/system-postgresql.slice/postgresql@16-main.service") != "postgresql@16-main.service" {
		t.Error("template units keep their instance")
	}
	if Unit("/user.slice/user-501.slice/session-6.scope") != "" {
		t.Error("a login session is no unit")
	}
	for _, cg := range []string{"/system.slice/docker-abc.scope", "/machine.slice/libpod-abc.scope", "/kubepods.slice/x"} {
		if !InContainer(cg) {
			t.Errorf("%s is a container", cg)
		}
	}
}

func TestListenersAndOwners(t *testing.T) {
	at := time.Unix(1_794_900_000, 0)
	procs := ubuntu()
	extra := ubuntuHints()
	// pid → its socket inode; and the LISTEN table (0A) with those inodes.
	sockets := map[int]uint64{14072: 1001, 26915: 1002, 23875: 1003, 22371: 1004}
	for pid := range sockets {
		extra[fmt.Sprintf("proc/%d/fd/7", pid)] = &fstest.MapFile{Data: []byte{}}
	}
	extra["proc/1/net/tcp"] = &fstest.MapFile{Data: []byte(
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
			"   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1001 1\n" +
			"   1: 00000000:1F9C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1002 1\n" +
			"   2: 0100007F:1F9D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1003 1\n" +
			"   3: 0100007F:9000 0100007F:1F9D 01 00000000:00000000 00:00000000 00000000  1000        0 1005 1\n")}
	extra["proc/1/net/tcp6"] = &fstest.MapFile{Data: []byte(
		"  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
			"   0: 00000000000000000000000000000000:2382 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000   113        0 1004 1\n")}
	c := newCollector(mapFS(procs, extra), &at)
	c.Reader.ReadlinkFD = func(pid int, fd string) (string, error) {
		return fmt.Sprintf("socket:[%d]", sockets[pid]), nil
	}
	ss, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, s := range ss {
		if s.Name != "watchlog_listen_info" {
			continue
		}
		var src, w, proto, port string
		for _, l := range s.Labels {
			switch l.Name {
			case "source":
				src = l.Value
			case "workload":
				w = l.Value
			case "proto":
				proto = l.Value
			case "port":
				port = l.Value
			}
		}
		got = append(got, src+"/"+w+"/"+proto+"/"+port)
	}
	want := []string{
		// pm2's api app, the jar started by hand, nginx's service, and php-fpm's master on
		// 9090 (0x2382) as its process group; the connected socket 1005 isn't a listener.
		"process/api/tcp/8092", "process/billing.jar/tcp/8093", "service/nginx.service/tcp/80",
		"process/php-fpm master/tcp6/9090",
	}
	if strings.Join(sortStrings(got), ",") != strings.Join(sortStrings(want), ",") {
		t.Fatalf("listeners:\n got %v\nwant %v", got, want)
	}
	owners := c.Owners()
	cases := map[string]Workload{
		// One group in a login session: the jar.
		"/user.slice/user-501.slice/session-6.scope": {Kind: "ProcessGroup", Name: "billing.jar"},
		// nginx alone in its unit: the service.
		"/system.slice/nginx.service": {Kind: "Service", Name: "nginx.service"},
		// pm2's apps and daemon share one unit: the unit, until flows carry the tgid.
		"/system.slice/pm2-app.service": {Kind: "Service", Name: "pm2-app.service"},
		// The containers' cgroups are the container source's.
		"/system.slice/docker-295029bbdb91.scope": {},
	}
	for cg, w := range cases {
		if owners[cg] != w {
			t.Errorf("owner of %s: %+v, want %+v", cg, owners[cg], w)
		}
	}
}

func sortStrings(s []string) []string {
	out := append([]string(nil), s...)
	for i := range out {
		for j := i + 1; j < len(out); j++ {
			if out[j] < out[i] {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

func TestServiceRelease(t *testing.T) {
	at := time.Unix(1_794_900_000, 0)
	procs := ubuntu()
	c := newCollector(mapFS(procs, ubuntuHints()), &at)
	ids := map[int]string{23655: "orders-v1"}
	c.Reader.ExeIdentity = func(pid int) string { return ids[pid] }
	release := func(ss []metrics.Sample) float64 {
		for _, s := range ss {
			if s.Name == "watchlog_service_releases_total" && groupOf(s) == "" {
				for _, l := range s.Labels {
					if l.Name == "unit" && l.Value == "orders.service" {
						return s.Value
					}
				}
			}
		}
		return -1
	}
	ss, _ := c.Collect()
	if release(ss) != -1 {
		t.Fatal("no release yet: the counter isn't sent")
	}
	// A deploy: systemd restarts orders.service on a new binary (a new pid, started later).
	at = at.Add(15 * time.Second)
	next := []fakeProc{}
	for _, p := range procs {
		if p.pid != 23655 {
			next = append(next, p)
		}
	}
	next = append(next, fakeProc{pid: 27100, ppid: 1, comm: "orders", cmdline: "/opt/wl-apps/orders\x00",
		cgroup: "/system.slice/orders.service", cpu: 1, start: 900, threads: 5, rssKB: 6000})
	c.Reader.FS = mapFS(next, ubuntuHints())
	ids[27100] = "orders-v2"
	ss, _ = c.Collect()
	if got := release(ss); got != 1 {
		t.Fatalf("orders.service releases %v, want 1", got)
	}
	// The same binary again: no new release.
	at = at.Add(15 * time.Second)
	ss, _ = c.Collect()
	if got := release(ss); got != 1 {
		t.Fatalf("still 1, got %v", got)
	}
}
