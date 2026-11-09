// SPDX-License-Identifier: AGPL-3.0-only

package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

func TestNormalise(t *testing.T) {
	got := normalise("select *\n  from orders\twhere id = $1")
	if got != "select * from orders where id = $1" {
		t.Fatalf("normalise: %q", got)
	}
	if len(normalise(strings.Repeat("x ", 400))) != textLen {
		t.Fatal("normalise must cap the text")
	}
}

func TestTrimText(t *testing.T) {
	if got := trimText("abcé", 4); got != "abc" {
		t.Fatalf("a cut inside a character: %q", got)
	}
}

// fitsIngest checks what the backend accepts in a status's extra (ingest.ts): at most 8
// lists of 100 rows, 12 fields each, values of 256 characters at most.
func fitsIngest(t *testing.T, extra map[string]any) {
	t.Helper()
	if len(extra) > 8 {
		t.Errorf("extra has %d lists", len(extra))
	}
	for k, v := range extra {
		rows, _ := v.([]map[string]any)
		if len(rows) > 100 {
			t.Errorf("%s has %d rows", k, len(rows))
		}
		for _, r := range rows {
			if len(r) > 12 {
				t.Errorf("%s row has %d fields", k, len(r))
			}
			for f, x := range r {
				switch y := x.(type) {
				case string:
					if utf8.RuneCountInString(y) > 256 {
						t.Errorf("%s.%s is %d characters", k, f, utf8.RuneCountInString(y))
					}
				case int, int64, float64, bool:
				default:
					t.Errorf("%s.%s is a %T, which the backend refuses", k, f, x)
				}
			}
		}
	}
}

func TestQuote(t *testing.T) {
	if got := quote(`a'b\c`); got != `'a\'b\\c'` {
		t.Fatalf("quote: %s", got)
	}
}

// The real-server tests run against every address in WATCHLOG_TEST_POSTGRES (comma
// separated host:port, user postgres with WATCHLOG_TEST_POSTGRES_PASSWORD); CI starts
// PostgreSQL 13 and 17.
func servers(t *testing.T) []string {
	v := os.Getenv("WATCHLOG_TEST_POSTGRES")
	if v == "" {
		t.Skip("WATCHLOG_TEST_POSTGRES not set")
	}
	return strings.Split(v, ",")
}

func admin(t *testing.T, addr, db string) *pgx.Conn {
	t.Helper()
	host, port, _ := strings.Cut(addr, ":")
	cfg, err := pgx.ParseConfig("host=" + host + " port=" + port + " user=postgres dbname=" + db + " sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	cfg.Password = os.Getenv("WATCHLOG_TEST_POSTGRES_PASSWORD")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("admin connection to %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = c.Close(context.Background()) })
	return c
}

func exec(t *testing.T, c *pgx.Conn, sql string) {
	t.Helper()
	if _, err := c.Exec(context.Background(), sql); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

func target(addr, user, password string) integrations.Target {
	return integrations.Target{ID: "t1", Type: "postgres", Members: []integrations.Member{{Name: "pg-0", Address: addr}},
		Auth: &integrations.Auth{Username: user, Password: password}}
}

func has(samples []metrics.Sample, name string, pairs ...string) bool {
	for _, s := range samples {
		if s.Name != name {
			continue
		}
		labels := map[string]string{}
		for _, l := range s.Labels {
			labels[l.Name] = l.Value
		}
		ok := true
		for i := 0; i+1 < len(pairs); i += 2 {
			if labels[pairs[i]] != pairs[i+1] {
				ok = false
			}
		}
		if ok {
			return true
		}
	}
	return false
}

func value(samples []metrics.Sample, name string) float64 {
	sum := 0.0
	for _, s := range samples {
		if s.Name == name {
			sum += s.Value
		}
	}
	return sum
}

func TestRealServer(t *testing.T) {
	for _, addr := range servers(t) {
		t.Run(addr, func(t *testing.T) { realServer(t, addr) })
	}
}

func realServer(t *testing.T, addr string) {
	ctx := context.Background()
	a := admin(t, addr, "postgres")
	var major int
	if err := a.QueryRow(ctx, "select current_setting('server_version_num')::int / 10000").Scan(&major); err != nil {
		t.Fatal(err)
	}
	const pass = "wl_mon_testtesttesttesttesttest"
	// The statements WatchLog's "create the user" command runs (credentials.ts).
	exec(t, a, "drop database if exists shop")
	exec(t, a, "drop role if exists watchlog")
	exec(t, a, "drop role if exists watchlog_nomon")
	exec(t, a, "CREATE ROLE watchlog LOGIN PASSWORD '"+pass+"'")
	exec(t, a, "GRANT pg_monitor TO watchlog")
	exec(t, a, "CREATE ROLE watchlog_nomon LOGIN PASSWORD '"+pass+"'")
	exec(t, a, "create database shop")
	stmts := false
	if _, err := a.Exec(ctx, "create extension if not exists pg_stat_statements"); err == nil {
		var loaded bool
		_ = a.QueryRow(ctx, "select current_setting('shared_preload_libraries') like '%pg_stat_statements%'").Scan(&loaded)
		stmts = loaded
		if !loaded {
			exec(t, a, "drop extension pg_stat_statements")
		}
	}
	shop := admin(t, addr, "shop")
	exec(t, shop, "create table orders (id serial primary key, note text) with (autovacuum_enabled = false)")
	exec(t, shop, "create index orders_note on orders (note)")
	exec(t, shop, "insert into orders (note) select 'n' || g from generate_series(1, 2000) g")
	exec(t, shop, "delete from orders where id % 2 = 0")
	exec(t, shop, "analyze orders")
	// The statistics reach pg_stat_user_tables a moment later.
	for i := 0; i < 50; i++ {
		var dead int64
		_ = shop.QueryRow(ctx, "select n_dead_tup from pg_stat_user_tables where relname = 'orders'").Scan(&dead)
		if dead > 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	p := New()

	t.Run("probe", func(t *testing.T) {
		pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		r := p.Probe(pctx, target(addr, "watchlog", pass))
		if r.Code != integrations.ProbeOK || len(r.Excess) != 0 || !strings.HasPrefix(r.Version, "1") {
			t.Fatalf("watchlog: %+v", r)
		}
		r = p.Probe(pctx, target(addr, "watchlog", "wrong"))
		if r.Code != integrations.ProbeAuthFailed {
			t.Fatalf("wrong password: %+v", r)
		}
		r = p.Probe(pctx, target(addr, "nobody", "wrong"))
		if r.Code != integrations.ProbeAuthFailed {
			t.Fatalf("unknown user: %+v", r)
		}
		r = p.Probe(pctx, target(addr, "watchlog_nomon", pass))
		if r.Code != integrations.ProbePermission || len(r.Missing) != 1 || r.Missing[0] != "pg_monitor" {
			t.Fatalf("no pg_monitor: %+v", r)
		}
		r = p.Probe(pctx, target(addr, "postgres", os.Getenv("WATCHLOG_TEST_POSTGRES_PASSWORD")))
		if r.Code != integrations.ProbeOK || len(r.Excess) != 1 || r.Excess[0] != "superuser" {
			t.Fatalf("superuser: %+v", r)
		}
		r = p.Probe(pctx, target("127.0.0.1:1", "watchlog", pass))
		if r.Code != integrations.ProbeUnreachable {
			t.Fatalf("closed port: %+v", r)
		}
	})

	t.Run("read-only session", func(t *testing.T) {
		m := integrations.Member{Name: "pg-0", Address: addr}
		c, _, err := connect(ctx, m, &integrations.Auth{Username: "postgres", Password: os.Getenv("WATCHLOG_TEST_POSTGRES_PASSWORD")}, "shop")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = c.Close(ctx) }()
		_, err = c.Exec(ctx, "insert into orders (note) values ('x')")
		if code(err) != "25006" {
			t.Fatalf("a write must fail in WatchLog's session even as a superuser, got %v", err)
		}
	})

	t.Run("scrape", func(t *testing.T) {
		if stmts {
			exec(t, shop, "select count(*) from orders where note = 'n1'")
			// A statement longer than the backend takes for a value.
			exec(t, shop, "select id, note from orders where note in ('"+strings.Repeat("a", 40)+"', '"+strings.Repeat("b", 400)+"') and id > 0 and id < 1000000 order by id desc limit 1")
		}
		// A lock wait: one transaction holds a row, a second waits for it.
		holder, err := shop.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = holder.Rollback(ctx) }()
		if _, err := holder.Exec(ctx, "update orders set note = 'held' where id = 1"); err != nil {
			t.Fatal(err)
		}
		waiter := admin(t, addr, "shop")
		done := make(chan struct{})
		go func() {
			_, _ = waiter.Exec(context.Background(), "set lock_timeout = '20s'; update orders set note = 'waiting' where id = 1")
			close(done)
		}()
		defer func() { <-done }()
		deadline := time.Now().Add(5 * time.Second)
		for {
			var n int
			_ = a.QueryRow(ctx, "select count(*) from pg_locks where not granted").Scan(&n)
			if n > 0 || time.Now().After(deadline) {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}

		sctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		tg := target(addr, "watchlog", pass)
		res := p.Scrape(sctx, tg, true)
		// With query text on (the default), each side's text is looked up too.
		tg.Settings.QueryText = true
		withText := p.Scrape(sctx, tg, true)
		tg.Settings.QueryText = false
		_ = holder.Rollback(ctx)
		if b, _ := withText.Extra["blocking"].([]map[string]any); len(b) == 0 {
			t.Errorf("no blocking row with query text on: %+v", withText.Extra["blocking"])
		} else if _, ok := b[0]["blocked_query"].(string); !ok {
			t.Errorf("blocked_query is not text: %#v", b[0]["blocked_query"])
		}
		if res.State != integrations.StateOK || !strings.HasPrefix(res.ServiceVersion, "1") {
			t.Fatalf("state %s %s version %q", res.State, res.Error, res.ServiceVersion)
		}
		fitsIngest(t, res.Extra)
		fitsIngest(t, withText.Extra)
		for _, name := range []string{"watchlog_postgres_backends", "watchlog_postgres_xact_commit_total",
			"watchlog_postgres_database_size_bytes", "watchlog_postgres_xid_age", "watchlog_postgres_setting",
			"watchlog_postgres_is_replica", "watchlog_postgres_wal_bytes_total", "watchlog_postgres_wal_dir_bytes",
			"watchlog_integration_connect_seconds"} {
			if !has(res.Samples, name) {
				t.Errorf("no %s", name)
			}
		}
		if !has(res.Samples, "watchlog_postgres_setting", "name", "max_connections") {
			t.Error("no max_connections")
		}
		if !has(res.Samples, "watchlog_postgres_table_size_bytes", "db", "shop", "table", "public.orders") {
			t.Error("the shop database's tables weren't read")
		}
		if value(res.Samples, "watchlog_postgres_lock_waits") < 1 {
			t.Error("the lock wait wasn't seen")
		}
		if value(res.Samples, "watchlog_postgres_table_bloat_bytes_estimate") <= 0 {
			t.Error("no bloat estimate for a table with dead rows")
		}
		blocking, _ := res.Extra["blocking"].([]map[string]any)
		if len(blocking) == 0 {
			t.Errorf("no blocking row: %+v", res.Extra["blocking"])
		}
		unused, _ := res.Extra["unused_indexes"].([]map[string]any)
		found := false
		for _, u := range unused {
			found = found || u["index"] == "orders_note"
		}
		if !found {
			t.Errorf("orders_note is never scanned but wasn't listed: %+v", unused)
		}
		statements, _ := res.Extra["statements"].([]map[string]any)
		perms := map[string]string{}
		for _, pm := range res.Permissions {
			perms[pm.Tab] = pm.Missing
		}
		if stmts {
			if len(statements) == 0 || !has(res.Samples, "watchlog_postgres_statement_calls_total") {
				t.Error("pg_stat_statements is installed but no statement was read")
			}
			for _, s := range statements {
				if _, ok := s["query"]; ok {
					t.Fatal("statement text without the query-text switch")
				}
			}
			if _, ok := perms["queries/top"]; ok {
				t.Errorf("perms: %+v", perms)
			}
		} else if perms["queries/top"] != "pg_stat_statements" {
			t.Errorf("without pg_stat_statements the queries tab must say so: %+v", perms)
		}

		// A light scrape repeats the heavy scrape's permission notes.
		light := p.Scrape(sctx, tg, false)
		if len(light.Permissions) != len(res.Permissions) || light.Extra != nil {
			t.Errorf("light scrape: perms %+v extra %v", light.Permissions, light.Extra != nil)
		}

		if stmts {
			tg.Settings.QueryText = true
			res = p.Scrape(sctx, tg, true)
			fitsIngest(t, res.Extra)
			statements, _ = res.Extra["statements"].([]map[string]any)
			withText := false
			for _, s := range statements {
				q, _ := s["query"].(string)
				if strings.Contains(q, "orders") {
					withText = true
					if strings.Contains(q, "'n1'") {
						t.Fatalf("statement text must be normalised: %s", q)
					}
				}
			}
			if !withText {
				t.Errorf("query text on, but no statement text: %+v", statements)
			}
		}
	})

	t.Run("scrape without pg_monitor", func(t *testing.T) {
		sctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		res := p.Scrape(sctx, target(addr, "watchlog_nomon", pass), true)
		if res.State != integrations.StateOK {
			t.Fatalf("%s %s", res.State, res.Error)
		}
		perms := map[string]string{}
		for _, pm := range res.Permissions {
			perms[pm.Tab] = pm.Missing
		}
		if perms["replication/wal"] != "pg_monitor" {
			t.Errorf("pg_ls_waldir needs pg_monitor: %+v", perms)
		}
	})

	t.Run("wrong password", func(t *testing.T) {
		res := p.Scrape(ctx, target(addr, "watchlog", "wrong"), true)
		if res.State != integrations.StateError || res.ErrorCode != integrations.ProbeAuthFailed ||
			!strings.HasPrefix(res.Error, "password authentication failed") {
			t.Fatalf("%s %s %q", res.State, res.ErrorCode, res.Error)
		}
	})
}

// BenchmarkScrape is one heavy scrape of the first test server (SPEC §6.1 budgets).
func BenchmarkScrape(b *testing.B) {
	v := os.Getenv("WATCHLOG_TEST_POSTGRES")
	if v == "" {
		b.Skip("WATCHLOG_TEST_POSTGRES not set")
	}
	addr, _, _ := strings.Cut(v, ",")
	p := New()
	tg := target(addr, "postgres", os.Getenv("WATCHLOG_TEST_POSTGRES_PASSWORD"))
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if res := p.Scrape(context.Background(), tg, i%10 == 0); res.State != integrations.StateOK {
			b.Fatal(res.Error)
		}
	}
}
