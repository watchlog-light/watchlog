// SPDX-License-Identifier: AGPL-3.0-only

// Package postgres is the PostgreSQL integration (SPEC §4.12, ADR-131, ADR-138): the
// statistics views a pg_monitor role may read (pg_stat_activity, pg_stat_database,
// pg_stat_replication, pg_locks, pg_stat_user_tables and _indexes, pg_ls_waldir,
// pg_stat_statements when installed), each member on its own read-only session. It never
// reads table data, and never pg_stat_activity.query: statement text comes only from
// pg_stat_statements' normalised form, and only with the service's query-text switch on.
package postgres

import (
	"context"
	"errors"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Caps (ADR-136).
const (
	MaxDatabases  = 50
	TableDBs      = 10
	TopTables     = 100
	TopStatements = 50
	TopLocked     = 20
	TopIndexes    = 50
	MaxBlocking   = 20
	MaxClients    = 50
	// textLen is the backend's limit for a value in a status's extra (ingest.ts): a longer
	// one makes it refuse the whole status.
	textLen = 256
)

// Postgres is the integration.
type Postgres struct {
	mu sync.Mutex
	// heavyPerms are the heavy scrape's permission notes per target, repeated by the
	// light scrapes in between so a panel's note doesn't come and go.
	heavyPerms map[string]map[string]string
}

// New returns the integration.
func New() *Postgres { return &Postgres{heavyPerms: map[string]map[string]string{}} }

// connect opens a read-only session with short timeouts on one database of a member.
func connect(ctx context.Context, m integrations.Member, auth *integrations.Auth, db string) (*pgx.Conn, time.Duration, error) {
	host, port, err := net.SplitHostPort(m.Address)
	if err != nil {
		return nil, 0, err
	}
	user, pass := "postgres", ""
	if auth != nil {
		if auth.Username != "" {
			user = auth.Username
		}
		pass = auth.Password
	}
	// prefer: TLS when the server offers it, else plain (cluster networks).
	dsn := fmt.Sprintf("host=%s port=%s dbname=%s user=%s sslmode=prefer connect_timeout=5 application_name=watchlog",
		host, port, quote(db), quote(user))
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, 0, err
	}
	cfg.Password = pass
	cfg.RuntimeParams["default_transaction_read_only"] = "on"
	cfg.RuntimeParams["statement_timeout"] = "5000"
	cfg.RuntimeParams["lock_timeout"] = "1000"
	cfg.RuntimeParams["idle_in_transaction_session_timeout"] = "10000"
	// The simple protocol: no prepared statements left behind on the server.
	cfg.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	start := time.Now()
	c, err := pgx.ConnectConfig(ctx, cfg)
	return c, time.Since(start), err
}

func quote(s string) string {
	return "'" + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `'`, `\'`) + "'"
}

func code(err error) string {
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		return pe.Code
	}
	return ""
}

// isAuth: invalid password (28P01), or no such role / not allowed (28000).
func isAuth(err error) bool { c := code(err); return c == "28P01" || c == "28000" }

// short is the server's own message, or the last connection attempt's error (pgx lists
// every attempt: TLS first, then plain).
func short(err error) string {
	var pe *pgconn.PgError
	s := err.Error()
	if errors.As(err, &pe) {
		s = pe.Message
	} else if lines := strings.Split(s, "\n"); len(lines) > 1 {
		s = strings.TrimSpace(lines[len(lines)-1])
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// Scrape implements integrations.Integration.
func (p *Postgres) Scrape(ctx context.Context, t integrations.Target, heavy bool) integrations.Result {
	res := integrations.Result{State: integrations.StateOK}
	extra := map[string]any{}
	perms := map[string]string{}
	up, authFailed := 0, 0
	for _, m := range t.Members {
		ms := integrations.MemberStatus{Name: m.Name}
		c, connectTime, err := connect(ctx, m, t.Auth, "postgres")
		if code(err) == "3D000" {
			c, connectTime, err = connect(ctx, m, t.Auth, "template1")
		}
		if err != nil {
			ms.Error = short(err)
			if isAuth(err) {
				authFailed++
			}
			res.Members = append(res.Members, ms)
			continue
		}
		ms.Up = true
		up++
		res.Members = append(res.Members, ms)
		s := &scrape{c: c, member: m.Name, queryText: t.Settings.QueryText, perms: perms, extra: extra}
		s.add("watchlog_integration_connect_seconds", connectTime.Seconds())
		version := s.light(ctx)
		if res.ServiceVersion == "" {
			res.ServiceVersion = version
		}
		if heavy {
			s.heavy(ctx, m, t.Auth)
		}
		res.Samples = append(res.Samples, s.out...)
		_ = c.Close(ctx)
	}
	p.mu.Lock()
	if heavy {
		p.heavyPerms[t.ID] = perms
	} else {
		for k, v := range p.heavyPerms[t.ID] {
			if _, ok := perms[k]; !ok {
				perms[k] = v
			}
		}
	}
	p.mu.Unlock()
	for tab, missing := range perms {
		res.Permissions = append(res.Permissions, integrations.Permission{Tab: tab, Missing: missing})
	}
	sort.Slice(res.Permissions, func(i, j int) bool { return res.Permissions[i].Tab < res.Permissions[j].Tab })
	if heavy {
		res.Extra = extra
	}
	switch {
	case len(t.Members) == 0:
		res.State, res.Error = integrations.StateError, "no member to connect to: no pod or container of this service has an address yet"
	case up == 0:
		res.State, res.Error = integrations.StateError, res.Members[0].Error
		if authFailed > 0 {
			res.ErrorCode = integrations.ProbeAuthFailed
		}
	}
	return res
}

type scrape struct {
	c         *pgx.Conn
	member    string
	queryText bool
	out       []metrics.Sample
	perms     map[string]string
	extra     map[string]any
	major     int
	stmts     bool
}

func (s *scrape) add(name string, v float64, pairs ...string) {
	s.out = append(s.out, metrics.New(name, v, append([]string{"member", s.member}, pairs...)...))
}

// rows runs a query and calls fn for each row's values.
func (s *scrape) rows(ctx context.Context, sql string, fn func(vals []any)) error {
	r, err := s.c.Query(ctx, sql)
	if err != nil {
		return err
	}
	defer r.Close()
	for r.Next() {
		v, err := r.Values()
		if err != nil {
			return err
		}
		fn(v)
	}
	return r.Err()
}

func f(v any) float64 {
	switch x := v.(type) {
	case int64:
		return float64(x)
	case int32:
		return float64(x)
	case int16:
		return float64(x)
	case float64:
		return x
	case float32:
		return float64(x)
	case string:
		n, _ := strconv.ParseFloat(x, 64)
		return n
	case pgtype.Numeric:
		n, err := x.Float64Value()
		if err != nil {
			return 0
		}
		return n.Float64
	}
	return 0
}

func str(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

func (s *scrape) light(ctx context.Context) string {
	var version string
	_ = s.c.QueryRow(ctx, "select current_setting('server_version'), current_setting('server_version_num')::int").Scan(&version, &s.major)
	s.major /= 10000
	if fields := strings.Fields(version); len(fields) > 0 {
		version = fields[0]
	}

	// Settings that the pages and rules compare against.
	_ = s.rows(ctx, `select name, setting, unit from pg_settings where name in
		('max_connections','superuser_reserved_connections','idle_in_transaction_session_timeout',
		 'max_wal_size','autovacuum_freeze_max_age')`, func(v []any) {
		name, val, unit := str(v[0]), f(v[1]), str(v[2])
		switch {
		case name == "max_wal_size" && unit == "MB":
			val *= 1 << 20
		case unit == "ms":
			val /= 1000
		}
		s.add("watchlog_postgres_setting", val, "name", name)
	})

	// Client backends by state and what they wait on; the longest active query, the
	// longest idle-in-transaction; sessions blocked by another (never their query text).
	_ = s.rows(ctx, `select coalesce(state, 'unknown'), coalesce(wait_event_type, ''), count(*),
		  coalesce(max(extract(epoch from now() - query_start)) filter (where state = 'active'), 0)::float8,
		  coalesce(max(extract(epoch from now() - state_change)) filter (where state like 'idle in transaction%'), 0)::float8,
		  count(*) filter (where cardinality(pg_blocking_pids(pid)) > 0)
		from pg_stat_activity
		where backend_type = 'client backend' and pid <> pg_backend_pid()
		group by 1, 2`, func(v []any) {
		state, wait := str(v[0]), str(v[1])
		s.add("watchlog_postgres_backends", f(v[2]), "state", state, "wait", wait)
		s.add("watchlog_postgres_backend_max_seconds", f(v[3]), "state", state, "wait", wait, "kind", "active")
		s.add("watchlog_postgres_backend_max_seconds", f(v[4]), "state", state, "wait", wait, "kind", "idle_in_transaction")
		s.add("watchlog_postgres_blocked_backends", f(v[5]), "state", state, "wait", wait)
	})

	// Per database (the largest 50): transactions, cache, rows, temp files, deadlocks,
	// sessions (14+), size, transaction ID age.
	sessions := "0"
	if s.major >= 14 {
		sessions = "d.sessions"
	}
	_ = s.rows(ctx, `select d.datname, d.numbackends, d.xact_commit, d.xact_rollback, d.blks_hit, d.blks_read,
		  d.tup_fetched, d.tup_inserted, d.tup_updated, d.tup_deleted, d.temp_bytes, d.deadlocks, `+sessions+`,
		  pg_database_size(d.datname), age(db.datfrozenxid)
		from pg_stat_database d join pg_database db on db.oid = d.datid
		where d.datname is not null and not db.datistemplate
		order by pg_database_size(d.datname) desc limit `+strconv.Itoa(MaxDatabases), func(v []any) {
		db := str(v[0])
		names := []string{"backends", "xact_commit_total", "xact_rollback_total", "blks_hit_total", "blks_read_total",
			"tup_fetched_total", "tup_inserted_total", "tup_updated_total", "tup_deleted_total", "temp_bytes_total",
			"deadlocks_total", "sessions_total", "database_size_bytes", "xid_age"}
		for i, n := range names {
			if n == "sessions_total" && s.major < 14 {
				continue
			}
			s.add("watchlog_postgres_"+n, f(v[i+1]), "db", db)
		}
	})

	// Replication: a primary's replicas, or this replica's replay lag; slots.
	var inRecovery bool
	_ = s.c.QueryRow(ctx, "select pg_is_in_recovery()").Scan(&inRecovery)
	if inRecovery {
		s.add("watchlog_postgres_is_replica", 1)
		var lag float64
		if err := s.c.QueryRow(ctx, "select coalesce(extract(epoch from now() - pg_last_xact_replay_timestamp()), 0)::float8").Scan(&lag); err == nil {
			s.add("watchlog_postgres_replay_lag_seconds", lag)
		}
	} else {
		s.add("watchlog_postgres_is_replica", 0)
		n := 0
		_ = s.rows(ctx, `select coalesce(application_name, client_addr::text, 'replica'), state, sync_state,
			  coalesce(extract(epoch from replay_lag), 0)::float8 from pg_stat_replication`, func(v []any) {
			n++
			name := str(v[0])
			s.add("watchlog_postgres_replica_lag_seconds", f(v[3]), "replica", name, "state", str(v[1]), "sync", str(v[2]))
		})
		s.add("watchlog_postgres_replicas", float64(n))
		_ = s.rows(ctx, `select slot_name, active::int, coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0)::float8
			from pg_replication_slots`, func(v []any) {
			s.add("watchlog_postgres_slot_active", f(v[1]), "slot", str(v[0]))
			s.add("watchlog_postgres_slot_retained_bytes", f(v[2]), "slot", str(v[0]))
		})
		// WAL generated: pg_stat_wal (14+), else the LSN's position.
		var wal float64
		q := "select pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::float8"
		if s.major >= 14 {
			q = "select wal_bytes::float8 from pg_stat_wal"
		}
		if err := s.c.QueryRow(ctx, q).Scan(&wal); err == nil {
			s.add("watchlog_postgres_wal_bytes_total", wal)
		}
	}
	return version
}

func (s *scrape) heavy(ctx context.Context, m integrations.Member, auth *integrations.Auth) {
	// pg_stat_statements: optional; it unlocks the query tables (SPEC §4.12).
	var has bool
	_ = s.c.QueryRow(ctx, "select exists (select 1 from pg_extension where extname = 'pg_stat_statements')").Scan(&has)
	s.stmts = has
	if !has {
		s.perms["overview/slowest"] = "pg_stat_statements"
		s.perms["queries/top"] = "pg_stat_statements"
		s.perms["queries/duration"] = "pg_stat_statements"
	} else {
		s.statements(ctx)
	}

	// The WAL directory against max_wal_size (pg_ls_waldir: pg_monitor).
	var waldir float64
	if err := s.c.QueryRow(ctx, "select coalesce(sum(size), 0)::float8 from pg_ls_waldir()").Scan(&waldir); err == nil {
		s.add("watchlog_postgres_wal_dir_bytes", waldir)
	} else if code(err) == "42501" {
		s.perms["replication/wal"] = "pg_monitor"
	}

	// Who is connected: client address (mapped to a workload by the backend), or the
	// application name for local sessions.
	clients := []map[string]any{}
	_ = s.rows(ctx, `select coalesce(host(client_addr), ''), coalesce(application_name, ''), count(*)
		from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()
		group by 1, 2 order by 3 desc limit `+strconv.Itoa(MaxClients), func(v []any) {
		clients = append(clients, map[string]any{"addr": str(v[0]), "app": trimText(str(v[1]), 64), "connections": int(f(v[2])), "member": s.member})
	})
	s.extra["clients"] = append(asRows(s.extra["clients"]), clients...)

	// Blocking right now: both sides' clients and states, what is waited for, how long;
	// their statement text only by query_id from pg_stat_statements (14+).
	blocking := []map[string]any{}
	wq, bq := "null::bigint", "null::bigint"
	if s.major >= 14 {
		wq, bq = "w.query_id", "b.query_id"
	}
	_ = s.rows(ctx, `select coalesce(host(w.client_addr), w.application_name, ''), w.state, coalesce(w.wait_event_type, ''),
		  coalesce(w.wait_event, ''), coalesce(extract(epoch from now() - w.state_change), 0)::float8,
		  coalesce(host(b.client_addr), b.application_name, ''), b.state, `+wq+`, `+bq+`
		from pg_stat_activity w
		join lateral unnest(pg_blocking_pids(w.pid)) as bp(pid) on true
		join pg_stat_activity b on b.pid = bp.pid
		order by 5 desc limit `+strconv.Itoa(MaxBlocking), func(v []any) {
		blocking = append(blocking, map[string]any{
			"blocked": str(v[0]), "blocked_state": str(v[1]), "wait": trimText(str(v[2])+" "+str(v[3]), 64),
			"seconds": int(f(v[4])), "blocking": str(v[5]), "blocking_state": str(v[6]),
			"blocked_query": v[7], "blocking_query": v[8], "member": s.member,
		})
	})
	// The texts once the rows are read: a connection runs one query at a time.
	for _, row := range blocking {
		row["blocked_query"] = s.textOf(ctx, row["blocked_query"])
		row["blocking_query"] = s.textOf(ctx, row["blocking_query"])
	}
	s.extra["blocking"] = append(asRows(s.extra["blocking"]), blocking...)

	// Lock waits right now (sampled each heavy scrape, for the hour × day heatmap), and the
	// most locked tables.
	var waiting float64
	_ = s.c.QueryRow(ctx, "select count(*) from pg_locks where not granted").Scan(&waiting)
	s.add("watchlog_postgres_lock_waits", waiting)
	_ = s.rows(ctx, `select coalesce(c.relname, l.relation::text), count(*) from pg_locks l
		left join pg_class c on c.oid = l.relation
		where l.locktype = 'relation' and l.relation is not null and c.relnamespace not in
		  (select oid from pg_namespace where nspname in ('pg_catalog', 'information_schema'))
		group by 1 order by 2 desc limit `+strconv.Itoa(TopLocked), func(v []any) {
		s.add("watchlog_postgres_locked_relation", f(v[1]), "table", trimText(str(v[0]), 63))
	})

	// Tables, indexes and vacuum: per database, the 10 largest databases.
	var dbs []string
	_ = s.rows(ctx, `select datname from pg_database where not datistemplate and datallowconn
		order by pg_database_size(datname) desc limit `+strconv.Itoa(TableDBs), func(v []any) {
		dbs = append(dbs, str(v[0]))
	})
	var tables []tableRow
	unused := []map[string]any{}
	for _, db := range dbs {
		c := s.c
		if db != s.c.Config().Database {
			other, _, err := connect(ctx, m, auth, db)
			if err != nil {
				continue
			}
			c = other
		}
		t := &scrape{c: c, member: s.member}
		tables = append(tables, t.tables(ctx, db)...)
		unused = append(unused, t.unusedIndexes(ctx, db)...)
		if c != s.c {
			_ = c.Close(ctx)
		}
	}
	// The largest tables over every database: the series are capped at TopTables.
	sort.Slice(tables, func(i, j int) bool { return tables[i].size > tables[j].size })
	if len(tables) > TopTables {
		tables = tables[:TopTables]
	}
	vacuum := []map[string]any{}
	for _, t := range tables {
		s.add("watchlog_postgres_table_size_bytes", t.size, "db", t.db, "table", t.table)
		s.add("watchlog_postgres_table_dead_rows", t.dead, "db", t.db, "table", t.table)
		s.add("watchlog_postgres_table_autovacuum_total", t.autovacuums, "db", t.db, "table", t.table)
		// An estimate from the statistics (exact bloat needs pgstattuple, which reads every
		// page): the dead rows' share of the table's size.
		if t.live+t.dead > 0 {
			s.add("watchlog_postgres_table_bloat_bytes_estimate", t.size*t.dead/(t.live+t.dead), "db", t.db, "table", t.table)
		}
		vacuum = append(vacuum, map[string]any{
			"db": t.db, "table": t.table, "dead": int64(t.dead), "live": int64(t.live),
			"last_autovacuum": int64(t.lastAutovacuum), "autovacuum_count": int64(t.autovacuums), "member": s.member,
		})
	}
	sort.SliceStable(vacuum, func(i, j int) bool { return vacuum[i]["dead"].(int64) > vacuum[j]["dead"].(int64) })
	if len(vacuum) > 20 {
		vacuum = vacuum[:20]
	}
	sort.SliceStable(unused, func(i, j int) bool { return unused[i]["size"].(int64) > unused[j]["size"].(int64) })
	if len(unused) > TopIndexes {
		unused = unused[:TopIndexes]
	}
	s.extra["vacuum"] = append(asRows(s.extra["vacuum"]), vacuum...)
	s.extra["unused_indexes"] = append(asRows(s.extra["unused_indexes"]), unused...)
}

func asRows(v any) []map[string]any {
	r, _ := v.([]map[string]any)
	return r
}

// trimText keeps at most n bytes, cut at a character boundary.
func trimText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// textOf is a statement's normalised text by its query_id (pg_stat_statements), or "".
func (s *scrape) textOf(ctx context.Context, id any) string {
	if !s.queryText || !s.stmts || id == nil {
		return ""
	}
	var q string
	if err := s.c.QueryRow(ctx, "select query from pg_stat_statements where queryid = $1 limit 1", id).Scan(&q); err != nil {
		return ""
	}
	return normalise(q)
}

// dml are the statements pg_stat_statements normalises: their constants are $1, $2, ….
var dml = map[string]bool{
	"SELECT": true, "INSERT": true, "UPDATE": true, "DELETE": true, "WITH": true,
	"VALUES": true, "TABLE": true, "MERGE": true,
}

// password is a password literal in any statement, redacted whatever its kind.
var password = regexp.MustCompile(`(?i)(password\s+)('(?:[^']|'')*'|\$[a-z0-9_]*\$[\s\S]*?\$[a-z0-9_]*\$)`)

// normalise is a statement's text as WatchLog keeps it (ADR-138): pg_stat_statements
// normalises only queries (SELECT, INSERT, UPDATE, DELETE, …); a utility statement keeps
// its literals (CREATE ROLE … PASSWORD 'x', a DO block), so only its command is kept
// ("ALTER ROLE …"). Passwords are redacted in any case. One line, short.
func normalise(q string) string {
	words := strings.Fields(q)
	if len(words) == 0 {
		return ""
	}
	if first := strings.ToUpper(strings.TrimLeft(words[0], "(")); !dml[first] {
		kept := []string{first}
		if len(words) > 1 && isWord(words[1]) {
			kept = append(kept, strings.ToUpper(words[1]))
		}
		return strings.Join(kept, " ") + " …"
	}
	return trimText(password.ReplaceAllString(strings.Join(words, " "), "${1}'…'"), textLen)
}

// objectKinds are the second words kept after a utility command (ALTER ROLE, CREATE
// TABLE); anything else may be a name and is dropped.
var objectKinds = map[string]bool{
	"ROLE": true, "USER": true, "GROUP": true, "TABLE": true, "INDEX": true, "VIEW": true,
	"MATERIALIZED": true, "SEQUENCE": true, "SCHEMA": true, "DATABASE": true, "EXTENSION": true,
	"FUNCTION": true, "PROCEDURE": true, "TRIGGER": true, "TYPE": true, "DOMAIN": true,
	"POLICY": true, "PUBLICATION": true, "SUBSCRIPTION": true, "SERVER": true, "TABLESPACE": true,
	"UNIQUE": true, "TEMP": true, "TEMPORARY": true, "UNLOGGED": true, "OR": true,
}

// isWord: a keyword naming the kind of object, never a name or a literal.
func isWord(w string) bool { return objectKinds[strings.ToUpper(w)] }

func (s *scrape) statements(ctx context.Context) {
	exec := "total_exec_time"
	mean := "mean_exec_time"
	if s.major < 13 {
		exec, mean = "total_time", "mean_time"
	}
	rows := []map[string]any{}
	err := s.rows(ctx, `select queryid::text, calls, `+exec+`/1000, `+mean+`/1000, rows, query
		from pg_stat_statements where queryid is not null
		order by `+exec+` desc limit `+strconv.Itoa(TopStatements), func(v []any) {
		id := str(v[0])
		s.add("watchlog_postgres_statement_calls_total", f(v[1]), "queryid", id)
		s.add("watchlog_postgres_statement_seconds_total", f(v[2]), "queryid", id)
		s.add("watchlog_postgres_statement_rows_total", f(v[4]), "queryid", id)
		row := map[string]any{"queryid": id, "calls": int64(f(v[1])), "total": f(v[2]), "mean": f(v[3]), "rows": int64(f(v[4]))}
		if s.queryText {
			row["query"] = normalise(str(v[5]))
		}
		rows = append(rows, row)
	})
	if err != nil && code(err) == "42501" {
		s.perms["queries/top"] = "pg_read_all_stats"
	}
	s.extra["statements"] = append(asRows(s.extra["statements"]), rows...)
}

type tableRow struct {
	db, table                                     string
	size, live, dead, lastAutovacuum, autovacuums float64
}

func (s *scrape) tables(ctx context.Context, db string) []tableRow {
	var out []tableRow
	_ = s.rows(ctx, `select schemaname || '.' || relname, pg_total_relation_size(relid), n_live_tup, n_dead_tup,
		  coalesce(extract(epoch from last_autovacuum), 0)::float8, autovacuum_count
		from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit `+strconv.Itoa(TopTables), func(v []any) {
		out = append(out, tableRow{db: db, table: trimText(str(v[0]), 128), size: f(v[1]), live: f(v[2]), dead: f(v[3]),
			lastAutovacuum: f(v[4]), autovacuums: f(v[5])})
	})
	return out
}

// unusedIndexes are indexes never scanned since the statistics were reset, apart from
// unique and primary keys, which enforce something even unread.
func (s *scrape) unusedIndexes(ctx context.Context, db string) []map[string]any {
	out := []map[string]any{}
	_ = s.rows(ctx, `select i.schemaname || '.' || i.relname, i.indexrelname, pg_relation_size(i.indexrelid),
		  coalesce(extract(epoch from d.stats_reset), 0)::float8
		from pg_stat_user_indexes i
		join pg_index x on x.indexrelid = i.indexrelid
		cross join (select stats_reset from pg_stat_database where datname = current_database()) d
		where i.idx_scan = 0 and not x.indisunique and not x.indisprimary
		order by pg_relation_size(i.indexrelid) desc limit 20`, func(v []any) {
		out = append(out, map[string]any{
			"db": db, "table": trimText(str(v[0]), 128), "index": trimText(str(v[1]), 128),
			"size": int64(f(v[2])), "since": int64(f(v[3])), "member": s.member,
		})
	})
	return out
}

// ---------------------------------------------------------------- probe

// Probe implements integrations.Prober: log in, then check the role can read the
// statistics (pg_monitor, or a superuser, which is more than needed).
func (p *Postgres) Probe(ctx context.Context, t integrations.Target) integrations.ProbeResult {
	out := integrations.ProbeResult{Code: integrations.ProbeUnreachable}
	for _, m := range t.Members {
		c, _, err := connect(ctx, m, t.Auth, "postgres")
		if code(err) == "3D000" { // no database "postgres": every server has template1
			c, _, err = connect(ctx, m, t.Auth, "template1")
		}
		if err != nil {
			switch {
			case isAuth(err):
				return integrations.ProbeResult{Code: integrations.ProbeAuthFailed, Error: short(err)}
			case code(err) != "":
				return integrations.ProbeResult{Code: integrations.ProbeError, Error: short(err)}
			}
			out.Error = short(err)
			continue
		}
		defer func() { _ = c.Close(ctx) }()
		var version string
		var super, monitor, stmts bool
		var dbs int
		err = c.QueryRow(ctx, `select current_setting('server_version'),
			  (select rolsuper from pg_roles where rolname = current_user),
			  pg_has_role(current_user, 'pg_monitor', 'member'),
			  exists (select 1 from pg_extension where extname = 'pg_stat_statements'),
			  (select count(*) from pg_database where not datistemplate)`).Scan(&version, &super, &monitor, &stmts, &dbs)
		if err != nil {
			return integrations.ProbeResult{Code: integrations.ProbeError, Error: short(err)}
		}
		if fields := strings.Fields(version); len(fields) > 0 {
			version = fields[0]
		}
		out = integrations.ProbeResult{Code: integrations.ProbeOK, Version: version,
			Facts: map[string]any{"databases": dbs}}
		if stmts {
			out.Facts["pg_stat_statements"] = "installed"
		} else {
			out.Facts["pg_stat_statements"] = "not installed"
		}
		switch {
		case super:
			out.Excess = []string{"superuser"}
		case !monitor:
			out.Code, out.Missing = integrations.ProbePermission, []string{"pg_monitor"}
		}
		return out
	}
	return out
}
