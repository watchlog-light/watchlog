// SPDX-License-Identifier: AGPL-3.0-only

// Package mysql is the MySQL and MariaDB integration (SPEC §4.12, ADR-163): the global
// status and an allow-list of variables, the process list (client host, user, command,
// time; never the statement text), InnoDB's transactions and lock waits
// (performance_schema.data_lock_waits on MySQL, information_schema.INNODB_LOCK_WAITS on
// MariaDB), replication status, table size estimates from mysql.innodb_table_stats, and,
// when performance_schema is on, the statement digests (the server's own normalised text,
// ADR-138) and the statement latency histogram. Each member on its own read-only session
// with a 5 s statement limit. It never reads table data.
package mysql

import (
	"context"
	"crypto/tls"
	"database/sql"
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

	"github.com/go-sql-driver/mysql"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Caps (ADR-136).
const (
	TopTables     = 100
	TopStatements = 50
	MaxBlocking   = 20
	MaxClients    = 50
	// textLen is the backend's limit for a value in a status's extra (ingest.ts).
	textLen = 256
)

// MySQL is the integration.
type MySQL struct {
	mu sync.Mutex
	// heavyPerms are the heavy scrape's permission notes per target, repeated by the
	// light scrapes in between so a panel's note doesn't come and go.
	heavyPerms map[string]map[string]string
}

// New returns the integration.
func New() *MySQL { return &MySQL{heavyPerms: map[string]map[string]string{}} }

// tlsPreferred: TLS when the server offers it, without verifying its certificate (cluster
// networks; the same as PostgreSQL's sslmode=prefer).
var tlsPreferred = func() string {
	_ = mysql.RegisterTLSConfig("watchlog-preferred", &tls.Config{InsecureSkipVerify: true}) //nolint:gosec // G402: opportunistic TLS, as sslmode=prefer
	return "watchlog-preferred"
}()

// session is one read-only connection to one member.
type session struct {
	db   *sql.DB
	conn *sql.Conn
}

func (s *session) close() {
	if s.conn != nil {
		_ = s.conn.Close()
	}
	_ = s.db.Close()
}

// connect opens one connection with short timeouts and a read-only session: no write is
// possible, a lock is waited for at most 5 s, and a statement runs at most 5 s.
func connect(ctx context.Context, m integrations.Member, auth *integrations.Auth) (*session, time.Duration, error) {
	if _, _, err := net.SplitHostPort(m.Address); err != nil {
		return nil, 0, err
	}
	cfg := mysql.NewConfig()
	cfg.User = "root"
	if auth != nil {
		if auth.Username != "" {
			cfg.User = auth.Username
		}
		cfg.Passwd = auth.Password
	}
	cfg.Net, cfg.Addr = "tcp", m.Address
	cfg.Timeout, cfg.ReadTimeout, cfg.WriteTimeout = integrations.DialTimeout, 10*time.Second, 5*time.Second
	cfg.TLSConfig = tlsPreferred
	cfg.AllowNativePasswords = true
	cfg.ConnectionAttributes = "program_name:watchlog"
	conn, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, 0, err
	}
	db := sql.OpenDB(conn)
	db.SetMaxOpenConns(1)
	start := time.Now()
	c, err := db.Conn(ctx)
	if err == nil {
		err = c.PingContext(ctx)
	}
	took := time.Since(start)
	s := &session{db: db, conn: c}
	if err != nil {
		s.close()
		return nil, took, err
	}
	for _, q := range []string{"SET SESSION TRANSACTION READ ONLY", "SET SESSION lock_wait_timeout = 5"} {
		if _, err := c.ExecContext(ctx, q); err != nil {
			s.close()
			return nil, took, err
		}
	}
	// The statement limit: MySQL's in milliseconds, MariaDB's in seconds; one of them
	// exists.
	if _, err := c.ExecContext(ctx, "SET SESSION max_execution_time = 5000"); err != nil {
		_, _ = c.ExecContext(ctx, "SET SESSION max_statement_time = 5")
	}
	return s, took, nil
}

func number(err error) uint16 {
	var me *mysql.MySQLError
	if errors.As(err, &me) {
		return me.Number
	}
	return 0
}

// isAuth: access denied for the user (1045), or to the server from this host (1130).
func isAuth(err error) bool { n := number(err); return n == 1045 || n == 1130 || n == 1044 }

// denied: a privilege is missing for a statement or a table.
func denied(err error) bool {
	n := number(err)
	return n == 1142 || n == 1227 || n == 1143 || n == 1044
}

func short(err error) string {
	var me *mysql.MySQLError
	s := err.Error()
	if errors.As(err, &me) {
		s = me.Message
	}
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// rows runs a query and calls fn with each row's values as strings ("" for NULL).
func (s *session) rows(ctx context.Context, q string, fn func(v []string)) error {
	r, err := s.conn.QueryContext(ctx, q)
	if err != nil {
		return err
	}
	defer func() { _ = r.Close() }()
	cols, err := r.Columns()
	if err != nil {
		return err
	}
	raw := make([]sql.NullString, len(cols))
	ptr := make([]any, len(cols))
	for i := range raw {
		ptr[i] = &raw[i]
	}
	v := make([]string, len(cols))
	for r.Next() {
		if err := r.Scan(ptr...); err != nil {
			return err
		}
		for i := range raw {
			v[i] = raw[i].String
		}
		fn(v)
	}
	return r.Err()
}

// named runs a query whose columns are read by name (SHOW REPLICA STATUS).
func (s *session) named(ctx context.Context, q string) (map[string]string, error) {
	r, err := s.conn.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() { _ = r.Close() }()
	cols, err := r.Columns()
	if err != nil {
		return nil, err
	}
	if !r.Next() {
		return nil, r.Err()
	}
	raw := make([]sql.NullString, len(cols))
	ptr := make([]any, len(cols))
	for i := range raw {
		ptr[i] = &raw[i]
	}
	if err := r.Scan(ptr...); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(cols))
	for i, c := range cols {
		out[c] = raw[i].String
	}
	return out, nil
}

func f(s string) float64 {
	n, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return n
}

// Scrape implements integrations.Integration.
func (p *MySQL) Scrape(ctx context.Context, t integrations.Target, heavy bool) integrations.Result {
	res := integrations.Result{State: integrations.StateOK}
	extra := map[string]any{}
	perms := map[string]string{}
	up, authFailed := 0, 0
	for _, m := range t.Members {
		ms := integrations.MemberStatus{Name: m.Name}
		c, connectTime, err := connect(ctx, m, t.Auth)
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
		s := &scrape{s: c, member: m.Name, queryText: t.Settings.QueryText, perms: perms, extra: extra}
		s.add("watchlog_integration_connect_seconds", connectTime.Seconds())
		s.light(ctx)
		if res.ServiceVersion == "" {
			res.ServiceVersion, res.Product = s.version, s.product
		}
		if heavy {
			s.heavy(ctx)
		}
		res.Samples = append(res.Samples, s.out...)
		c.close()
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
	s         *session
	member    string
	queryText bool
	out       []metrics.Sample
	perms     map[string]string
	extra     map[string]any
	version   string
	product   string
	mariadb   bool
	perfOn    bool
	threadID  string
	procs     map[string]proc
}

// proc is one row of the process list: never its statement text.
type proc struct {
	user, host, command string
	time                float64
}

func (s *scrape) add(name string, v float64, pairs ...string) {
	s.out = append(s.out, metrics.New(name, v, append([]string{"member", s.member}, pairs...)...))
}

// Version splits the server's version into its number and product: MariaDB reports
// "11.4.13-MariaDB-ubu2404"; MySQL and Percona Server "8.4.13" (Percona reads as MySQL).
func Version(version string) (string, string) {
	v, rest, _ := strings.Cut(version, "-")
	if strings.Contains(strings.ToLower(rest), "mariadb") {
		// MariaDB 10.x before 10.10 may prefix "5.5.5-" for old clients.
		if v == "5.5.5" {
			v, _, _ = strings.Cut(rest, "-")
		}
		return v, "mariadb"
	}
	return v, ""
}

// statusCounters are the global status counters kept, by WatchLog's name.
var statusCounters = map[string]string{
	"questions":                         "watchlog_mysql_questions_total",
	"slow_queries":                      "watchlog_mysql_slow_queries_total",
	"innodb_buffer_pool_read_requests":  "watchlog_mysql_buffer_pool_read_requests_total",
	"innodb_buffer_pool_reads":          "watchlog_mysql_buffer_pool_reads_total",
	"aborted_connects":                  "watchlog_mysql_aborted_connects_total",
	"connection_errors_max_connections": "watchlog_mysql_refused_connections_total",
	"connections":                       "watchlog_mysql_connections_total",
	"created_tmp_disk_tables":           "watchlog_mysql_tmp_disk_tables_total",
	"select_scan":                       "watchlog_mysql_select_scan_total",
	"innodb_row_lock_waits":             "watchlog_mysql_row_lock_waits_total",
	"innodb_os_log_written":             "watchlog_mysql_redo_written_bytes_total",
	"innodb_deadlocks":                  "watchlog_mysql_deadlocks_total", // MariaDB
}

var statusGauges = map[string]string{
	"threads_connected":             "watchlog_mysql_threads_connected",
	"threads_running":               "watchlog_mysql_threads_running",
	"max_used_connections":          "watchlog_mysql_max_used_connections",
	"innodb_row_lock_current_waits": "watchlog_mysql_row_lock_current_waits",
	"uptime":                        "watchlog_mysql_uptime_seconds",
}

// settings are the variables read (an allow-list, ADR-163).
var settings = []string{"max_connections", "innodb_buffer_pool_size", "innodb_page_size", "read_only", "performance_schema", "wsrep_on", "max_user_connections"}

func (s *scrape) light(ctx context.Context) {
	var version string
	_ = s.s.conn.QueryRowContext(ctx, "SELECT @@version, CONNECTION_ID()").Scan(&version, &s.threadID)
	s.version, s.product = Version(version)
	s.mariadb = s.product == "mariadb"

	_ = s.s.rows(ctx, "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('"+strings.Join(settings, "','")+"')", func(v []string) {
		name, val := strings.ToLower(v[0]), v[1]
		n := f(val)
		switch strings.ToUpper(val) {
		case "ON":
			n = 1
		case "OFF":
			n = 0
		}
		if name == "performance_schema" {
			s.perfOn = n == 1
		}
		s.add("watchlog_mysql_setting", n, "name", name)
	})

	status := map[string]float64{}
	_ = s.s.rows(ctx, `SHOW GLOBAL STATUS WHERE Variable_name IN ('Questions','Slow_queries','Innodb_buffer_pool_read_requests',
		'Innodb_buffer_pool_reads','Aborted_connects','Connection_errors_max_connections','Connections','Created_tmp_disk_tables',
		'Select_scan','Innodb_row_lock_waits','Innodb_row_lock_time','Innodb_os_log_written','Innodb_deadlocks','Threads_connected',
		'Threads_running','Max_used_connections','Innodb_row_lock_current_waits','Uptime','Com_select','Com_insert','Com_update',
		'Com_delete','Com_replace','Innodb_rows_read','Innodb_rows_inserted','Innodb_rows_updated','Innodb_rows_deleted',
		'Innodb_buffer_pool_pages_data','Innodb_buffer_pool_pages_dirty','Innodb_buffer_pool_pages_free',
		'Innodb_buffer_pool_pages_total','wsrep_ready','wsrep_cluster_size','group_replication_primary_member')`, func(v []string) {
		status[strings.ToLower(v[0])] = f(v[1])
	})
	for k, name := range statusCounters {
		if v, ok := status[k]; ok {
			s.add(name, v)
		}
	}
	for k, name := range statusGauges {
		if v, ok := status[k]; ok {
			s.add(name, v)
		}
	}
	if v, ok := status["innodb_row_lock_time"]; ok {
		s.add("watchlog_mysql_row_lock_wait_seconds_total", v/1000)
	}
	// Statements by type: the four Com_ counters, and the rest of Questions as "other".
	known := 0.0
	for _, c := range []string{"select", "insert", "update", "delete"} {
		v := status["com_"+c]
		if c == "insert" {
			v += status["com_replace"]
		}
		known += v
		s.add("watchlog_mysql_commands_total", v, "command", c)
	}
	s.add("watchlog_mysql_commands_total", max(status["questions"]-known, 0), "command", "other")
	for _, op := range []string{"read", "inserted", "updated", "deleted"} {
		s.add("watchlog_mysql_rows_total", status["innodb_rows_"+op], "op", op)
	}
	for _, st := range []string{"data", "dirty", "free", "total"} {
		s.add("watchlog_mysql_buffer_pool_pages", status["innodb_buffer_pool_pages_"+st], "state", st)
	}
	if _, ok := status["wsrep_ready"]; ok {
		s.add("watchlog_mysql_cluster", 1, "kind", "galera")
	}

	// Deadlocks on MySQL: INNODB_METRICS (PROCESS); MariaDB has Innodb_deadlocks above.
	if !s.mariadb {
		var n float64
		if err := s.s.conn.QueryRowContext(ctx, "SELECT `count` FROM information_schema.INNODB_METRICS WHERE name = 'lock_deadlocks'").Scan(&n); err == nil {
			s.add("watchlog_mysql_deadlocks_total", n)
		}
	}

	// The process list: client sessions only (not replication or daemon threads, not
	// WatchLog's own); the longest running statement's time.
	s.procs = map[string]proc{}
	longest, sessions := 0.0, 0.0
	byCommand := map[string]float64{}
	err := s.s.rows(ctx, "SELECT ID, COALESCE(USER, ''), COALESCE(HOST, ''), COALESCE(COMMAND, ''), COALESCE(TIME, 0) FROM information_schema.PROCESSLIST", func(v []string) {
		if v[0] == s.threadID {
			return
		}
		p := proc{user: v[1], host: v[2], command: v[3], time: f(v[4])}
		s.procs[v[0]] = p
		if !client(p) {
			return
		}
		sessions++
		byCommand[p.command]++
		if p.command == "Query" || p.command == "Execute" {
			longest = max(longest, p.time)
		}
	})
	if err == nil {
		s.add("watchlog_mysql_longest_query_seconds", longest)
		s.add("watchlog_mysql_client_sessions", sessions)
		for c, n := range byCommand {
			s.add("watchlog_mysql_sessions", n, "command", c)
		}
	}

	s.replication(ctx)
}

// client: a session a client opened, not a replication, daemon or system thread.
func client(p proc) bool {
	switch p.command {
	case "Daemon", "Binlog Dump", "Binlog Dump GTID", "Connect", "Slave_IO", "Slave_SQL", "Slave_worker":
		return false
	}
	return p.user != "system user" && p.user != "event_scheduler" && p.user != ""
}

// replication: this server as a replica (SHOW REPLICA STATUS; the older word before
// MySQL 8.0.22 and MariaDB 10.5.1). The error text is kept short and without addresses'
// credentials.
func (s *scrape) replication(ctx context.Context) {
	r, err := s.s.named(ctx, "SHOW REPLICA STATUS")
	if err != nil && !denied(err) {
		r, err = s.s.named(ctx, "SHOW SLAVE STATUS")
	}
	if err != nil {
		if denied(err) {
			s.perms["replication/status"] = map[bool]string{true: "REPLICA MONITOR", false: "REPLICATION CLIENT"}[s.mariadb]
		}
		return
	}
	if r == nil {
		s.add("watchlog_mysql_is_replica", 0)
		return
	}
	s.add("watchlog_mysql_is_replica", 1)
	get := func(names ...string) string {
		for _, n := range names {
			if v, ok := r[n]; ok {
				return v
			}
		}
		return ""
	}
	yes := func(v string) float64 {
		if strings.EqualFold(v, "Yes") {
			return 1
		}
		return 0
	}
	s.add("watchlog_mysql_replica_running", yes(get("Replica_IO_Running", "Slave_IO_Running")), "thread", "io")
	s.add("watchlog_mysql_replica_running", yes(get("Replica_SQL_Running", "Slave_SQL_Running")), "thread", "sql")
	if lag := get("Seconds_Behind_Source", "Seconds_Behind_Master"); lag != "" {
		s.add("watchlog_mysql_replica_lag_seconds", f(lag))
	}
	lastErr := get("Last_IO_Error")
	if e := get("Last_SQL_Error"); e != "" {
		lastErr = e
	}
	s.extra["replica"] = append(asRows(s.extra["replica"]), map[string]any{
		"member": s.member, "io": get("Replica_IO_Running", "Slave_IO_Running"), "sql": get("Replica_SQL_Running", "Slave_SQL_Running"),
		"source": trimText(get("Source_Host", "Master_Host"), 128), "error": trimText(redactError(lastErr), textLen),
	})
}

// credential is a password or a user:password@ in a replication error.
var credential = regexp.MustCompile(`(?i)(password\s*[=:]\s*|://[^:/@\s]+:)[^\s@'"]+`)

func redactError(s string) string {
	return credential.ReplaceAllString(strings.Join(strings.Fields(s), " "), "${1}***")
}

func (s *scrape) heavy(ctx context.Context) {
	s.clients()
	s.locks(ctx)
	s.tables(ctx)
	if s.perfOn {
		s.statements(ctx)
		if !s.mariadb {
			s.histogram(ctx)
		}
	} else {
		s.perms["queries/top"] = "performance_schema"
		s.perms["overview/slowest"] = "performance_schema"
	}
}

// hostOf is a process list host without its port ("10.244.1.5:51234" → "10.244.1.5");
// "localhost" and sockets stay as they are.
func hostOf(h string) string {
	if host, _, err := net.SplitHostPort(h); err == nil {
		return host
	}
	return h
}

// clients: who is connected, by client address (mapped to a workload by the backend) and
// user, for the sessions that are clients.
func (s *scrape) clients() {
	type key struct{ addr, user string }
	by := map[key]int{}
	for _, p := range s.procs {
		if client(p) {
			by[key{hostOf(p.host), p.user}]++
		}
	}
	rows := make([]map[string]any, 0, len(by))
	for k, n := range by {
		rows = append(rows, map[string]any{"addr": trimText(k.addr, 64), "user": trimText(k.user, 64), "connections": n, "member": s.member})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i]["connections"].(int) > rows[j]["connections"].(int) })
	if len(rows) > MaxClients {
		rows = rows[:MaxClients]
	}
	s.extra["clients"] = append(asRows(s.extra["clients"]), rows...)
}

// lockQuery pairs each waiting transaction with the one blocking it: the waiting and
// blocking threads, how long it waited, how long the blocker's transaction has run, and
// the table. Never the locked row's key (data_locks.LOCK_DATA, INNODB_LOCKS.lock_data).
const lockQueryMySQL = `SELECT w.trx_mysql_thread_id, b.trx_mysql_thread_id,
	COALESCE(TIMESTAMPDIFF(SECOND, w.trx_wait_started, NOW()), 0), COALESCE(TIMESTAMPDIFF(SECOND, b.trx_started, NOW()), 0),
	COALESCE(CONCAT(l.OBJECT_SCHEMA, '.', l.OBJECT_NAME), '')
	FROM performance_schema.data_lock_waits lw
	JOIN information_schema.INNODB_TRX w ON w.trx_id = lw.REQUESTING_ENGINE_TRANSACTION_ID
	JOIN information_schema.INNODB_TRX b ON b.trx_id = lw.BLOCKING_ENGINE_TRANSACTION_ID
	LEFT JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = lw.REQUESTING_ENGINE_LOCK_ID
	ORDER BY 3 DESC LIMIT 20`

const lockQueryMariaDB = `SELECT w.trx_mysql_thread_id, b.trx_mysql_thread_id,
	COALESCE(TIMESTAMPDIFF(SECOND, w.trx_wait_started, NOW()), 0), COALESCE(TIMESTAMPDIFF(SECOND, b.trx_started, NOW()), 0),
	COALESCE(l.lock_table, '')
	FROM information_schema.INNODB_LOCK_WAITS lw
	JOIN information_schema.INNODB_TRX w ON w.trx_id = lw.requesting_trx_id
	JOIN information_schema.INNODB_TRX b ON b.trx_id = lw.blocking_trx_id
	LEFT JOIN information_schema.INNODB_LOCKS l ON l.lock_id = lw.requested_lock_id
	ORDER BY 3 DESC LIMIT 20`

func (s *scrape) locks(ctx context.Context) {
	q := lockQueryMySQL
	if s.mariadb {
		q = lockQueryMariaDB
	}
	blocking := []map[string]any{}
	err := s.s.rows(ctx, q, func(v []string) {
		w, b := s.procs[v[0]], s.procs[v[1]]
		blocking = append(blocking, map[string]any{
			"blocked": trimText(hostOf(w.host), 64), "blocked_user": trimText(w.user, 64),
			"blocking": trimText(hostOf(b.host), 64), "blocking_user": trimText(b.user, 64),
			"blocking_state": trimText(b.command, 32), "seconds": int(f(v[2])), "held": int(f(v[3])),
			"table": trimText(strings.ReplaceAll(v[4], "`", ""), 128), "member": s.member,
		})
	})
	switch {
	case err == nil:
	case denied(err) && !s.mariadb && !s.perfOn:
		// MySQL with performance_schema off: no lock table to read.
		s.perms["locks/blocking"] = "performance_schema"
	case denied(err):
		s.perms["locks/blocking"] = "PROCESS"
	case number(err) == 1146 || number(err) == 1109:
		s.perms["locks/blocking"] = "performance_schema"
	}
	s.add("watchlog_mysql_lock_waits", float64(len(blocking)))
	s.extra["blocking"] = append(asRows(s.extra["blocking"]), blocking...)
}

// tables: the largest tables by InnoDB's persistent statistics (estimates: clustered and
// other index pages × the page size).
func (s *scrape) tables(ctx context.Context) {
	err := s.s.rows(ctx, `SELECT database_name, table_name, (clustered_index_size + sum_of_other_index_sizes) * @@innodb_page_size, n_rows
		FROM mysql.innodb_table_stats WHERE database_name NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema')
		ORDER BY 3 DESC LIMIT `+strconv.Itoa(TopTables), func(v []string) {
		db, table := trimText(v[0], 64), trimText(v[1], 128)
		s.add("watchlog_mysql_table_size_bytes_estimate", f(v[2]), "db", db, "table", table)
		s.add("watchlog_mysql_table_rows_estimate", f(v[3]), "db", db, "table", table)
	})
	if err != nil && denied(err) {
		s.perms["storage/tables"] = "SELECT on mysql.innodb_table_stats"
	}
}

// statements: the digest summary's top statements by total time. WatchLog's own reads
// are left out. The text is the server's digest (literals already "?"), kept only with
// the service's query-text switch on, passwords redacted in any case.
func (s *scrape) statements(ctx context.Context) {
	rows := []map[string]any{}
	// One row per digest: the same statement run in several schemas is summed.
	err := s.s.rows(ctx, `SELECT DIGEST, MIN(COALESCE(SCHEMA_NAME, '')), MIN(COALESCE(DIGEST_TEXT, '')), SUM(COUNT_STAR),
		SUM(SUM_TIMER_WAIT) / 1e12, SUM(SUM_TIMER_WAIT) / GREATEST(SUM(COUNT_STAR), 1) / 1e12, MAX(MAX_TIMER_WAIT) / 1e12,
		SUM(SUM_ROWS_EXAMINED), SUM(SUM_ROWS_SENT)
		FROM performance_schema.events_statements_summary_by_digest
		WHERE DIGEST IS NOT NULL AND DIGEST_TEXT NOT LIKE 'SHOW %' AND DIGEST_TEXT NOT LIKE 'SET %'
		  AND DIGEST_TEXT NOT LIKE 'SELECT @@%' AND DIGEST_TEXT NOT LIKE '%performance\\_schema%'
		  AND DIGEST_TEXT NOT LIKE '%information\\_schema%' AND DIGEST_TEXT NOT LIKE '%innodb\\_table\\_stats%'
		GROUP BY DIGEST ORDER BY 5 DESC LIMIT `+strconv.Itoa(TopStatements), func(v []string) {
		id := shortDigest(v[0])
		s.add("watchlog_mysql_statement_calls_total", f(v[3]), "digest", id)
		s.add("watchlog_mysql_statement_seconds_total", f(v[4]), "digest", id)
		row := map[string]any{
			"digest": id, "db": trimText(v[1], 64), "calls": int64(f(v[3])), "total": f(v[4]), "mean": f(v[5]),
			"max": f(v[6]), "rows_examined": int64(f(v[7])), "rows_sent": int64(f(v[8])),
		}
		if s.queryText {
			row["query"] = Normalise(v[2])
		}
		rows = append(rows, row)
	})
	if err != nil && denied(err) {
		s.perms["queries/top"] = "SELECT on performance_schema"
		s.perms["overview/slowest"] = "SELECT on performance_schema"
	}
	s.extra["statements"] = append(asRows(s.extra["statements"]), rows...)
}

// shortDigest keeps 16 hex characters of a digest: enough to tell statements apart, and
// short as a label.
func shortDigest(d string) string {
	if len(d) > 16 {
		return d[:16]
	}
	return d
}

// latencyEdges are the histogram's upper bounds in seconds (SPEC §4.12: the same buckets
// as the other databases' "by statement mean").
var latencyEdges = []float64{0.001, 0.01, 0.1, 1, 10}

// histogram: events_statements_histogram_global (MySQL 8.0.19+), summed into WatchLog's
// buckets, as cumulative counters.
func (s *scrape) histogram(ctx context.Context) {
	counts := make([]float64, len(latencyEdges)+1)
	any := false
	err := s.s.rows(ctx, `SELECT BUCKET_TIMER_HIGH / 1e12, COUNT_BUCKET FROM performance_schema.events_statements_histogram_global
		WHERE COUNT_BUCKET > 0`, func(v []string) {
		any = true
		high, n := f(v[0]), f(v[1])
		i := sort.SearchFloat64s(latencyEdges, high)
		counts[i] += n
	})
	if err != nil || !any {
		return
	}
	cum := 0.0
	for i, n := range counts {
		cum += n
		le := "+Inf"
		if i < len(latencyEdges) {
			le = strconv.FormatFloat(latencyEdges[i], 'g', -1, 64)
		}
		s.add("watchlog_mysql_statement_latency_bucket", cum, "le", le)
	}
}

// password is a password literal left in a statement's text (the digest replaces
// literals with "?", but a utility statement's may survive in older servers).
var password = regexp.MustCompile(`(?i)((?:password|identified\s+by)\s*(?:\(\s*)?)('(?:[^']|'')*'|"(?:[^"]|"")*")`)

// Normalise is a digest's text as WatchLog keeps it (ADR-138): one line, short, passwords
// redacted.
func Normalise(q string) string {
	return trimText(password.ReplaceAllString(strings.Join(strings.Fields(q), " "), "${1}'…'"), textLen)
}

func asRows(v any) []map[string]any {
	r, _ := v.([]map[string]any)
	return r
}

func trimText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// ---------------------------------------------------------------- probe

// Grants is what SHOW GRANTS gives the user, as WatchLog needs it.
type Grants struct {
	Process, Replication, PerfSchema, TableStats bool
	// Excess are privileges beyond what WatchLog needs (ADR-134).
	Excess []string
}

var grantLine = regexp.MustCompile(`(?i)^GRANT (.+?) ON (\S+) TO `)

// ParseGrants reads SHOW GRANTS lines. Roles granted to the user (GRANT `r` TO …) aren't
// expanded; a privilege missing here may then come from a role and the scrape tells.
func ParseGrants(lines []string) Grants {
	var g Grants
	excess := map[string]bool{}
	for _, line := range lines {
		m := grantLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		on := strings.ToLower(strings.ReplaceAll(m[2], "`", ""))
		privs := map[string]bool{}
		for _, p := range strings.Split(m[1], ",") {
			privs[strings.ToUpper(strings.TrimSpace(p))] = true
		}
		all := privs["ALL PRIVILEGES"] || privs["ALL"]
		global := on == "*.*"
		if global && all {
			excess["ALL PRIVILEGES"] = true
		}
		if global {
			for _, p := range []string{"SUPER", "INSERT", "UPDATE", "DELETE", "DROP", "CREATE USER", "SHUTDOWN", "FILE"} {
				if privs[p] {
					excess[p] = true
				}
			}
		}
		if global && (all || privs["PROCESS"]) {
			g.Process = true
		}
		if global && (all || privs["REPLICATION CLIENT"] || privs["BINLOG MONITOR"] || privs["SLAVE MONITOR"] || privs["REPLICA MONITOR"]) {
			g.Replication = true
		}
		sel := all || privs["SELECT"]
		if sel && (global || on == "performance_schema.*") {
			g.PerfSchema = true
		}
		if sel && (global || on == "mysql.*" || on == "mysql.innodb_table_stats") {
			g.TableStats = true
		}
	}
	for p := range excess {
		g.Excess = append(g.Excess, p)
	}
	sort.Strings(g.Excess)
	return g
}

// Probe implements integrations.Prober: log in, then check the user's grants. PROCESS is
// required (the process list, lock waits, InnoDB's transactions); the rest only cost
// panels, which the facts name.
func (p *MySQL) Probe(ctx context.Context, t integrations.Target) integrations.ProbeResult {
	out := integrations.ProbeResult{Code: integrations.ProbeUnreachable}
	for _, m := range t.Members {
		c, _, err := connect(ctx, m, t.Auth)
		if err != nil {
			switch {
			case isAuth(err):
				return integrations.ProbeResult{Code: integrations.ProbeAuthFailed, Error: short(err)}
			case number(err) != 0:
				return integrations.ProbeResult{Code: integrations.ProbeError, Error: short(err)}
			}
			out.Error = short(err)
			continue
		}
		defer c.close()
		var version, perf string
		if err := c.conn.QueryRowContext(ctx, "SELECT @@version, @@performance_schema").Scan(&version, &perf); err != nil {
			return integrations.ProbeResult{Code: integrations.ProbeError, Error: short(err)}
		}
		var lines []string
		if err := c.rows(ctx, "SHOW GRANTS", func(v []string) { lines = append(lines, v[0]) }); err != nil {
			return integrations.ProbeResult{Code: integrations.ProbeError, Error: short(err)}
		}
		g := ParseGrants(lines)
		v, product := Version(version)
		out = integrations.ProbeResult{Code: integrations.ProbeOK, Version: v, Excess: g.Excess, Facts: map[string]any{}}
		if product == "mariadb" {
			out.Facts["product"] = "MariaDB"
		} else {
			out.Facts["product"] = "MySQL"
		}
		if perf == "1" || strings.EqualFold(perf, "ON") {
			out.Facts["performance_schema"] = "on"
		} else {
			out.Facts["performance_schema"] = "off"
		}
		var costs []string
		if !g.Replication {
			costs = append(costs, map[bool]string{true: "REPLICA MONITOR", false: "REPLICATION CLIENT"}[product == "mariadb"]+" (replication)")
		}
		if !g.PerfSchema {
			costs = append(costs, "SELECT on performance_schema (statements, lock waits)")
		}
		if !g.TableStats {
			costs = append(costs, "SELECT on mysql.innodb_table_stats (largest tables)")
		}
		if len(costs) > 0 {
			out.Facts["missing"] = strings.Join(costs, "; ")
		}
		if !g.Process {
			out.Code, out.Missing = integrations.ProbePermission, []string{"PROCESS"}
		}
		return out
	}
	return out
}

// String keeps the type readable in logs.
func (p *MySQL) String() string { return fmt.Sprintf("mysql(%d targets)", len(p.heavyPerms)) }
