// SPDX-License-Identifier: AGPL-3.0-only

package mysql

import (
	"context"
	"net"
	"reflect"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
)

// The versions as MySQL 8.4 and MariaDB 11.4 report them (measured on the e2e VM).
func TestVersion(t *testing.T) {
	cases := []struct{ in, version, product string }{
		{"8.4.13", "8.4.13", ""},
		{"11.4.13-MariaDB-ubu2404", "11.4.13", "mariadb"},
		{"5.5.5-10.6.21-MariaDB-log", "10.6.21", "mariadb"},
		{"8.0.39-30", "8.0.39", ""}, // Percona Server reads as MySQL
	}
	for _, c := range cases {
		v, p := Version(c.in)
		if v != c.version || p != c.product {
			t.Errorf("Version(%q) = %q, %q; want %q, %q", c.in, v, p, c.version, c.product)
		}
	}
}

// SHOW GRANTS as the generated user gets them on MySQL 8.4 and MariaDB 11.4 (measured),
// and a root-like user.
func TestParseGrants(t *testing.T) {
	mysql84 := []string{
		"GRANT PROCESS, REPLICATION CLIENT ON *.* TO `watchlog`@`%`",
		"GRANT SELECT ON `performance_schema`.* TO `watchlog`@`%`",
		"GRANT SELECT ON `mysql`.`innodb_table_stats` TO `watchlog`@`%`",
	}
	mariadb114 := []string{
		"GRANT PROCESS, BINLOG MONITOR, SLAVE MONITOR ON *.* TO `watchlog`@`%` IDENTIFIED BY PASSWORD '*79EB7F8DD6DDD477C4103C8BED4BFB3835F6ED42' WITH MAX_USER_CONNECTIONS 2",
		"GRANT SELECT ON `performance_schema`.* TO `watchlog`@`%`",
		"GRANT SELECT ON `mysql`.`innodb_table_stats` TO `watchlog`@`%`",
	}
	want := Grants{Process: true, Replication: true, PerfSchema: true, TableStats: true}
	for name, lines := range map[string][]string{"mysql": mysql84, "mariadb": mariadb114} {
		if g := ParseGrants(lines); !reflect.DeepEqual(g, want) {
			t.Errorf("%s: %+v, want %+v", name, g, want)
		}
	}
	root := ParseGrants([]string{"GRANT ALL PRIVILEGES ON *.* TO `root`@`%` WITH GRANT OPTION"})
	if !root.Process || !root.PerfSchema || !root.TableStats || !reflect.DeepEqual(root.Excess, []string{"ALL PRIVILEGES"}) {
		t.Errorf("root: %+v", root)
	}
	bare := ParseGrants([]string{"GRANT USAGE ON *.* TO `app`@`%`", "GRANT SELECT, INSERT ON `shop`.* TO `app`@`%`"})
	if bare.Process || bare.PerfSchema || bare.TableStats || bare.Replication || len(bare.Excess) != 0 {
		t.Errorf("app user: %+v", bare)
	}
}

func TestNormalise(t *testing.T) {
	cases := map[string]string{
		"SELECT * FROM `shop` . `stock` WHERE `id` = ?":        "SELECT * FROM `shop` . `stock` WHERE `id` = ?",
		"CREATE USER 'a'@'%' IDENTIFIED BY 'secret'":           "CREATE USER 'a'@'%' IDENTIFIED BY '…'",
		"SET PASSWORD FOR `a` = PASSWORD ( 'x' )":              "SET PASSWORD FOR `a` = PASSWORD ( '…' )",
		"UPDATE `stock`\n  SET `n` = `n` + ?   WHERE `id` = ?": "UPDATE `stock` SET `n` = `n` + ? WHERE `id` = ?",
		"ALTER USER `x` IDENTIFIED BY ?":                       "ALTER USER `x` IDENTIFIED BY ?",
	}
	for in, want := range cases {
		if got := Normalise(in); got != want {
			t.Errorf("Normalise(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestHostAndClient(t *testing.T) {
	if hostOf("10.244.1.5:51234") != "10.244.1.5" || hostOf("localhost") != "localhost" || hostOf("[fd00::1]:3306") != "fd00::1" {
		t.Error("hostOf")
	}
	for _, p := range []proc{{user: "event_scheduler", command: "Daemon"}, {user: "system user", command: "Connect"}, {user: "repl", command: "Binlog Dump GTID"}} {
		if client(p) {
			t.Errorf("%+v is not a client session", p)
		}
	}
	if !client(proc{user: "app", command: "Query"}) || !client(proc{user: "app", command: "Sleep"}) {
		t.Error("client sessions")
	}
}

func TestRedactError(t *testing.T) {
	got := redactError("error connecting to master 'repl@db:3306' - retry-time: 60  password=hunter2")
	if got != "error connecting to master 'repl@db:3306' - retry-time: 60 password=***" {
		t.Errorf("redactError = %q", got)
	}
}

// A port that refuses: the member is down, the error says why, and no panic.
func TestScrapeUnreachable(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res := New().Scrape(ctx, integrations.Target{ID: "x", Members: []integrations.Member{{Name: "db-0", Address: addr}}}, true)
	if res.State != integrations.StateError || len(res.Members) != 1 || res.Members[0].Up || res.Error == "" {
		t.Errorf("unexpected result: %+v", res)
	}
	if r := New().Scrape(ctx, integrations.Target{ID: "y"}, false); r.State != integrations.StateError {
		t.Errorf("no members: %+v", r)
	}
	if p := New().Probe(ctx, integrations.Target{ID: "z", Members: []integrations.Member{{Name: "db-0", Address: addr}}}); p.Code != integrations.ProbeUnreachable {
		t.Errorf("probe: %+v", p)
	}
}
