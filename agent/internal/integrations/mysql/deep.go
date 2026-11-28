// SPDX-License-Identifier: AGPL-3.0-only

package mysql

// The deeper reads of 1.2 (ADR-245): what the server waits on, by statement and by client;
// which client sends each statement; long transactions with the history list; the
// blocking tree with metadata locks; the latest deadlock with its literals stripped; redo
// in use; replication per channel and worker; binary logs; connections per user; the data
// and redo files' I/O time; unused indexes and tables without a primary key from
// performance_schema. All with PROCESS, REPLICATION CLIENT and SELECT on performance_schema
// (Step 0, the notes' phases/databases-data.md); never a row of a user table.

import (
	"context"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Caps and cadence of 1.2 (ADR-245).
const (
	CatalogEvery        = 10 * time.Minute
	TopTransactions     = 10
	MaxTreeSessions     = 50
	ClientsPerStatement = 5
	TopFindings         = 20
	MaxUsers            = 50
)

// WaitClasses are the five classes of the "active sessions by wait" chart.
var WaitClasses = []string{"cpu", "io", "lock", "client", "other"}

// WaitClass maps a thread's state (and whether InnoDB has it waiting for a row lock) to a
// class. MySQL has no wait event per session by default (events_waits_current is off and
// turning it on is a write), so the state stands in: lock waits and states that name a lock
// are lock, network states client, flushes and on-disk temporary tables io, other waits
// other, anything else running (CPU).
func WaitClass(state string, rowLockWait bool) string {
	st := strings.ToLower(state)
	switch {
	case rowLockWait || strings.Contains(st, "lock"):
		return "lock"
	case st == "sending to client" || st == "receiving from client" || st == "writing to net" || st == "reading from net":
		return "client"
	case strings.Contains(st, "flush") || strings.Contains(st, "on disk") || strings.Contains(st, "ondisk") || strings.Contains(st, "tmp table"):
		return "io"
	case strings.HasPrefix(st, "waiting"):
		return "other"
	}
	return "cpu"
}

// waits samples the client sessions that run something: by class, by statement (the top
// digests, the rest "other") and by client address.
func (s *scrape) waits(ctx context.Context) {
	lockWait := map[string]bool{}
	_ = s.s.rows(ctx, "SELECT trx_mysql_thread_id FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT'", func(v []string) {
		lockWait[v[0]] = true
	})
	digests := map[string]string{}
	if s.perfOn {
		_ = s.s.rows(ctx, `SELECT t.PROCESSLIST_ID, MIN(c.DIGEST) FROM performance_schema.threads t
			JOIN performance_schema.events_statements_current c ON c.THREAD_ID = t.THREAD_ID
			WHERE c.DIGEST IS NOT NULL AND c.END_EVENT_ID IS NULL GROUP BY t.PROCESSLIST_ID`, func(v []string) {
			digests[v[0]] = shortDigest(v[1])
		})
	}
	byClass := map[string]float64{}
	type sk struct{ id, class string }
	type ck struct{ addr, class string }
	byStmt := map[sk]float64{}
	byClient := map[ck]float64{}
	for id, p := range s.procs {
		if !client(p) || p.command == "Sleep" {
			continue
		}
		class := WaitClass(p.state, lockWait[id])
		byClass[class]++
		if d, ok := digests[id]; ok {
			if !s.top[d] {
				d = "other"
			}
			byStmt[sk{d, class}]++
		}
		addr := hostOf(p.host)
		if addr == "" {
			addr = "local"
		}
		byClient[ck{trimText(addr, 64), class}]++
	}
	for _, c := range WaitClasses {
		s.add("watchlog_mysql_active_sessions", byClass[c], "wait", c)
	}
	for k, n := range byStmt {
		s.add("watchlog_mysql_statement_active_sessions", n, "digest", k.id, "wait", k.class)
	}
	n := 0
	for k, v := range byClient {
		if n++; n > MaxClients {
			break
		}
		s.add("watchlog_mysql_client_active_sessions", v, "addr", k.addr, "wait", k.class)
	}
}

// statementClients: which clients sent each top statement lately, from each thread's last
// ten statements (events_statements_history; on by default on MySQL, off on MariaDB).
func (s *scrape) statementClients(ctx context.Context) {
	if !s.perfOn || len(s.newTop) == 0 {
		return
	}
	var on string
	_ = s.s.conn.QueryRowContext(ctx, "SELECT ENABLED FROM performance_schema.setup_consumers WHERE NAME = 'events_statements_history'").Scan(&on)
	if !strings.EqualFold(on, "YES") {
		s.perms["queries/clients"] = "performance_schema_consumer_events_statements_history"
		return
	}
	per := map[string]int{}
	_ = s.s.rows(ctx, `SELECT h.DIGEST, t.PROCESSLIST_HOST, COUNT(*) FROM performance_schema.events_statements_history h
		JOIN performance_schema.threads t ON t.THREAD_ID = h.THREAD_ID
		WHERE h.DIGEST IS NOT NULL AND t.PROCESSLIST_HOST IS NOT NULL AND t.PROCESSLIST_ID <> CONNECTION_ID()
		GROUP BY 1, 2 ORDER BY 3 DESC`, func(v []string) {
		d := shortDigest(v[0])
		if !s.newTop[d] || per[d] >= ClientsPerStatement {
			return
		}
		per[d]++
		s.add("watchlog_mysql_statement_client_sessions", f(v[2]), "digest", d, "addr", trimText(hostOf(v[1]), 64))
	})
}

// transactions are the oldest InnoDB transactions: the client, idle (its session sleeps)
// or not, since when, rows locked, how many sessions wait on it; and the history list
// length they keep from being purged.
func (s *scrape) transactions(ctx context.Context, blocks map[string]int) {
	rows := []map[string]any{}
	oldest := map[string]float64{"active": 0, "idle": 0}
	_ = s.s.rows(ctx, `SELECT trx_mysql_thread_id, trx_state, TIMESTAMPDIFF(SECOND, trx_started, NOW()), trx_rows_locked, trx_rows_modified
		FROM information_schema.INNODB_TRX ORDER BY trx_started LIMIT `+strconv.Itoa(TopTransactions), func(v []string) {
		p := s.procs[v[0]]
		kind := "active"
		if p.command == "Sleep" {
			kind = "idle"
		}
		age := f(v[2])
		oldest[kind] = max(oldest[kind], age)
		idle := 0
		if kind == "idle" {
			idle = int(p.time)
		}
		rows = append(rows, map[string]any{
			"thread": v[0], "addr": trimText(hostOf(p.host), 64), "user": trimText(p.user, 64), "state": kind,
			"trx_state": v[1], "age": int(age), "idle": idle, "rows_locked": int(f(v[3])), "rows_modified": int(f(v[4])),
			"blocks": blocks[v[0]], "member": s.member,
		})
	})
	for kind, age := range oldest {
		s.add("watchlog_mysql_oldest_xact_seconds", age, "state", kind)
	}
	s.extra["transactions"] = append(asRows(s.extra["transactions"]), rows...)
	var hll float64
	if err := s.s.conn.QueryRowContext(ctx, "SELECT `count` FROM information_schema.INNODB_METRICS WHERE name = 'trx_rseg_history_len'").Scan(&hll); err == nil {
		s.add("watchlog_mysql_history_list_length", hll)
	}
}

// redo: the redo log in use against its capacity: MySQL 8.0.30+ from the LSNs, MariaDB from
// the checkpoint age.
func (s *scrape) redo(ctx context.Context) {
	st := map[string]float64{}
	_ = s.s.rows(ctx, `SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_redo_log_current_lsn','Innodb_redo_log_checkpoint_lsn',
		'Innodb_checkpoint_age','Innodb_checkpoint_max_age')`, func(v []string) { st[strings.ToLower(v[0])] = f(v[1]) })
	if cur, ok := st["innodb_redo_log_current_lsn"]; ok {
		var capacity float64
		if err := s.s.conn.QueryRowContext(ctx, "SELECT @@innodb_redo_log_capacity").Scan(&capacity); err == nil && capacity > 0 {
			s.add("watchlog_mysql_redo_in_use_bytes", max(cur-st["innodb_redo_log_checkpoint_lsn"], 0))
			s.add("watchlog_mysql_redo_capacity_bytes", capacity)
		}
	} else if age, ok := st["innodb_checkpoint_age"]; ok && st["innodb_checkpoint_max_age"] > 0 {
		s.add("watchlog_mysql_redo_in_use_bytes", age)
		s.add("watchlog_mysql_redo_capacity_bytes", st["innodb_checkpoint_max_age"])
	}
}

// metadataWaits: sessions waiting on a metadata lock (DDL behind a long transaction, or
// the reverse), paired with the sessions holding a lock on the same object.
func (s *scrape) metadataWaits(ctx context.Context) [][2]string {
	if !s.perfOn {
		return nil
	}
	type lock struct{ thread, object, status string }
	var locks []lock
	_ = s.s.rows(ctx, `SELECT t.PROCESSLIST_ID, CONCAT(COALESCE(m.OBJECT_SCHEMA, ''), '.', COALESCE(m.OBJECT_NAME, '')), m.LOCK_STATUS
		FROM performance_schema.metadata_locks m JOIN performance_schema.threads t ON t.THREAD_ID = m.OWNER_THREAD_ID
		WHERE m.OBJECT_TYPE = 'TABLE' AND t.PROCESSLIST_ID IS NOT NULL`, func(v []string) {
		locks = append(locks, lock{v[0], strings.TrimPrefix(v[1], "."), v[2]})
	})
	var pairs [][2]string
	waits := []map[string]any{}
	for _, w := range locks {
		if w.status != "PENDING" {
			continue
		}
		for _, h := range locks {
			if h.status == "GRANTED" && h.object == w.object && h.thread != w.thread {
				pairs = append(pairs, [2]string{w.thread, h.thread})
				wp, hp := s.procs[w.thread], s.procs[h.thread]
				waits = append(waits, map[string]any{
					"blocked": trimText(hostOf(wp.host), 64), "blocked_user": trimText(wp.user, 64),
					"blocking": trimText(hostOf(hp.host), 64), "blocking_user": trimText(hp.user, 64),
					"table": trimText(w.object, 128), "seconds": int(wp.time), "kind": "metadata", "member": s.member,
				})
			}
		}
	}
	s.add("watchlog_mysql_metadata_lock_waits", float64(len(waits)))
	s.extra["metadata_waits"] = append(asRows(s.extra["metadata_waits"]), waits...)
	return pairs
}

// tree: every session in a row-lock or metadata-lock wait, with the sessions that block it.
func (s *scrape) tree(pairs [][2]string) {
	by := map[string][]string{}
	in := map[string]bool{}
	for _, p := range pairs {
		by[p[0]] = append(by[p[0]], p[1])
		in[p[0]], in[p[1]] = true, true
	}
	ids := make([]string, 0, len(in))
	for id := range in {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	if len(ids) > MaxTreeSessions {
		ids = ids[:MaxTreeSessions]
	}
	nodes := []map[string]any{}
	blocked, longest := 0.0, 0.0
	for _, id := range ids {
		p := s.procs[id]
		if len(by[id]) > 0 {
			blocked++
			longest = max(longest, p.time)
		}
		nodes = append(nodes, map[string]any{
			"thread": id, "addr": trimText(hostOf(p.host), 64), "user": trimText(p.user, 64), "command": p.command,
			"state": trimText(p.state, 64), "seconds": int(p.time), "blocked_by": strings.Join(by[id], ","), "member": s.member,
		})
	}
	s.add("watchlog_mysql_blocked_sessions", blocked)
	s.add("watchlog_mysql_longest_block_seconds", longest)
	s.extra["lock_tree"] = append(asRows(s.extra["lock_tree"]), nodes...)
}

var (
	deadlockAt   = regexp.MustCompile(`(?m)^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)`)
	deadlockTxn  = regexp.MustCompile(`(?m)^\*\*\* \((\d+)\) TRANSACTION:`)
	deadlockWho  = regexp.MustCompile(`(?:MySQL|MariaDB) thread id (\d+), OS thread handle \S+, query id \d+ (\S+)(?: (\S+))?(?: (\S+))?`)
	deadlockBack = regexp.MustCompile(`\*\*\* WE ROLL BACK TRANSACTION \((\d+)\)`)
	quoted       = regexp.MustCompile(`'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"`)
	numeric      = regexp.MustCompile(`\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\b`)
)

// StripLiterals replaces every literal in a statement by "?": quoted strings, numbers and
// hex values. The deadlock report gives the statements as they ran, values included; only
// their shape leaves the agent (ADR-138).
func StripLiterals(q string) string {
	q = quoted.ReplaceAllString(q, "?")
	q = numeric.ReplaceAllStringFunc(q, func(m string) string { return "?" })
	return Normalise(q)
}

// Deadlock is the latest deadlock InnoDB reports: when, each transaction's client and its
// statement without literals, and which one was rolled back.
type Deadlock struct {
	At     int64            `json:"at"`
	Victim int              `json:"victim"`
	Txns   []map[string]any `json:"txns"`
}

// ParseDeadlock reads the LATEST DETECTED DEADLOCK section of SHOW ENGINE INNODB STATUS. It
// never reads past a transaction's statement: the lock lines that follow hold record dumps
// (row bytes), which are skipped. A zero Deadlock: none reported.
func ParseDeadlock(status string, loc *time.Location) Deadlock {
	var d Deadlock
	i := strings.Index(status, "LATEST DETECTED DEADLOCK")
	if i < 0 {
		return d
	}
	sec := status[i:]
	if j := strings.Index(sec, "\nTRANSACTIONS\n"); j > 0 {
		sec = sec[:j]
	}
	if m := deadlockAt.FindStringSubmatch(sec[strings.Index(sec, "\n")+1:]); m != nil {
		if t, err := time.ParseInLocation("2006-01-02 15:04:05", m[1], loc); err == nil {
			d.At = t.Unix()
		}
	}
	starts := deadlockTxn.FindAllStringSubmatchIndex(sec, -1)
	for k, st := range starts {
		end := len(sec)
		if k+1 < len(starts) {
			end = starts[k+1][0]
		}
		body := sec[st[1]:end]
		lines := strings.Split(body, "\n")
		txn := map[string]any{"n": atoi(sec[st[2]:st[3]])}
		for li, line := range lines {
			if m := deadlockWho.FindStringSubmatch(line); m != nil {
				txn["thread"] = m[1]
				txn["host"] = trimText(hostOf(m[2]), 64)
				txn["user"] = trimText(m[3], 64)
				// The statement: the lines after this one, up to the first "***" (the locks).
				var q []string
				for _, l := range lines[li+1:] {
					if strings.HasPrefix(l, "***") {
						break
					}
					q = append(q, l)
				}
				txn["query"] = StripLiterals(strings.Join(q, " "))
				break
			}
		}
		d.Txns = append(d.Txns, txn)
	}
	if m := deadlockBack.FindStringSubmatch(sec); m != nil {
		d.Victim = atoi(m[1])
	}
	return d
}

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

// deadlock reads the latest deadlock (PROCESS).
func (s *scrape) deadlock(ctx context.Context) {
	var typ, name, status string
	if err := s.s.conn.QueryRowContext(ctx, "SHOW ENGINE INNODB STATUS").Scan(&typ, &name, &status); err != nil {
		return
	}
	d := ParseDeadlock(status, time.Local)
	if d.At == 0 || len(d.Txns) == 0 {
		return
	}
	// A status row holds only strings, numbers and booleans: one row per transaction.
	for _, t := range d.Txns {
		t["member"] = s.member
		t["at"] = d.At
		t["victim"] = t["n"] == d.Victim
		s.extra["deadlock"] = append(asRows(s.extra["deadlock"]), t)
	}
}

// channels: replication per channel and per worker (MySQL's performance_schema): each
// channel's receiver and applier states, the last error, the last heartbeat, and the
// workers with an error.
func (s *scrape) channels(ctx context.Context) {
	if s.mariadb || !s.perfOn {
		return
	}
	rows := []map[string]any{}
	_ = s.s.rows(ctx, `SELECT c.CHANNEL_NAME, c.SERVICE_STATE, COALESCE(a.SERVICE_STATE, ''), COALESCE(c.LAST_ERROR_MESSAGE, ''),
		  COALESCE(UNIX_TIMESTAMP(c.LAST_HEARTBEAT_TIMESTAMP), 0), COALESCE(c.RECEIVED_TRANSACTION_SET, '')
		FROM performance_schema.replication_connection_status c
		LEFT JOIN performance_schema.replication_applier_status a ON a.CHANNEL_NAME = c.CHANNEL_NAME`, func(v []string) {
		name := v[0]
		if name == "" {
			name = "default"
		}
		hb := f(v[4])
		if hb > 0 {
			s.add("watchlog_mysql_replica_heartbeat_age_seconds", max(float64(time.Now().Unix())-hb, 0), "channel", trimText(name, 64))
		}
		rows = append(rows, map[string]any{"channel": trimText(name, 64), "receiver": v[1], "applier": v[2],
			"error": trimText(redactError(v[3]), textLen), "received": trimText(v[5], textLen), "member": s.member})
	})
	_ = s.s.rows(ctx, `SELECT CHANNEL_NAME, WORKER_ID, SERVICE_STATE, LAST_ERROR_NUMBER, COALESCE(LAST_ERROR_MESSAGE, '')
		FROM performance_schema.replication_applier_status_by_worker WHERE LAST_ERROR_NUMBER <> 0`, func(v []string) {
		rows = append(rows, map[string]any{"channel": trimText(v[0], 64), "worker": v[1], "applier": v[2],
			"error": trimText(redactError(v[4]), textLen), "member": s.member})
	})
	if len(rows) > 0 {
		var executed string
		_ = s.s.conn.QueryRowContext(ctx, "SELECT @@gtid_executed").Scan(&executed)
		for _, r := range rows {
			r["executed"] = trimText(strings.Join(strings.Fields(executed), ""), textLen)
		}
	}
	s.extra["channels"] = append(asRows(s.extra["channels"]), rows...)
}

// binlogs: the binary logs' size on disk (SHOW BINARY LOGS, REPLICATION CLIENT).
func (s *scrape) binlogs(ctx context.Context) {
	total, n := 0.0, 0.0
	err := s.s.rows(ctx, "SHOW BINARY LOGS", func(v []string) {
		total += f(v[1])
		n++
	})
	if err != nil {
		return // binary logging off (1381), or no privilege
	}
	s.add("watchlog_mysql_binlog_bytes", total)
	s.add("watchlog_mysql_binlog_files", n)
}

// users: connections per user against the server's max_user_connections, and handshake
// errors per client address (performance_schema.host_cache, only when it has some).
func (s *scrape) users(ctx context.Context) {
	if !s.perfOn {
		return
	}
	_ = s.s.rows(ctx, `SELECT USER, CURRENT_CONNECTIONS FROM performance_schema.users
		WHERE USER IS NOT NULL ORDER BY CURRENT_CONNECTIONS DESC LIMIT `+strconv.Itoa(MaxUsers), func(v []string) {
		s.add("watchlog_mysql_user_connections", f(v[1]), "user", trimText(v[0], 64))
	})
	_ = s.s.rows(ctx, `SELECT IP, SUM_CONNECT_ERRORS FROM performance_schema.host_cache
		WHERE SUM_CONNECT_ERRORS > 0 ORDER BY 2 DESC LIMIT `+strconv.Itoa(MaxClients), func(v []string) {
		s.add("watchlog_mysql_host_connect_errors_total", f(v[1]), "addr", trimText(v[0], 64))
	})
}

// fileIO: time and operations on InnoDB's data and redo files (the server's own I/O
// latency; the agent sees the process's bytes, not its waits).
func (s *scrape) fileIO(ctx context.Context) {
	if !s.perfOn {
		return
	}
	_ = s.s.rows(ctx, `SELECT EVENT_NAME, COUNT_READ, SUM_TIMER_READ / 1e12, COUNT_WRITE, SUM_TIMER_WRITE / 1e12
		FROM performance_schema.file_summary_by_event_name
		WHERE EVENT_NAME IN ('wait/io/file/innodb/innodb_data_file', 'wait/io/file/innodb/innodb_log_file')`, func(v []string) {
		file := "data"
		if strings.HasSuffix(v[0], "log_file") {
			file = "redo"
		}
		s.add("watchlog_mysql_file_io_total", f(v[1]), "file", file, "op", "read")
		s.add("watchlog_mysql_file_io_seconds_total", f(v[2]), "file", file, "op", "read")
		s.add("watchlog_mysql_file_io_total", f(v[3]), "file", file, "op", "write")
		s.add("watchlog_mysql_file_io_seconds_total", f(v[4]), "file", file, "op", "write")
	})
}

// ---------------------------------------------------------------- the catalog (every 10 min)

type catalog struct {
	at      time.Time
	samples []metrics.Sample
	extra   map[string]any
	perms   map[string]string
}

// indexUsage: from performance_schema's index statistics (since the server started):
// indexes never used (not primary keys), tables without a primary key, and full-scan rows
// per table. Index and column definitions aren't readable without privileges on the tables
// (Step 0), so duplicates and auto-increment headroom aren't here.
func (s *scrape) indexUsage(ctx context.Context, cat *scrape) {
	type tk struct{ db, table string }
	hasPK := map[tk]bool{}
	seen := map[tk]bool{}
	scans := map[tk]float64{}
	unused := []map[string]any{}
	err := s.s.rows(ctx, `SELECT OBJECT_SCHEMA, OBJECT_NAME, COALESCE(INDEX_NAME, ''), COUNT_STAR, COUNT_READ
		FROM performance_schema.table_io_waits_summary_by_index_usage
		WHERE OBJECT_TYPE = 'TABLE' AND OBJECT_SCHEMA NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema')`, func(v []string) {
		k := tk{trimText(v[0], 64), trimText(v[1], 128)}
		seen[k] = true
		switch v[2] {
		case "":
			scans[k] = f(v[4])
		case "PRIMARY":
			hasPK[k] = true
		default:
			if f(v[3]) == 0 {
				unused = append(unused, map[string]any{"db": k.db, "table": k.table, "index": trimText(v[2], 128), "member": s.member})
			}
		}
	})
	if err != nil {
		if denied(err) {
			cat.perms["tables/indexes"] = "SELECT on performance_schema"
		}
		return
	}
	noPK := []map[string]any{}
	for k := range seen {
		if !hasPK[k] {
			noPK = append(noPK, map[string]any{"db": k.db, "table": k.table, "member": s.member})
		}
	}
	sortBy := func(rows []map[string]any) {
		sort.Slice(rows, func(i, j int) bool {
			return rows[i]["db"].(string)+"."+rows[i]["table"].(string) < rows[j]["db"].(string)+"."+rows[j]["table"].(string)
		})
	}
	sortBy(unused)
	sortBy(noPK)
	if len(unused) > TopFindings {
		unused = unused[:TopFindings]
	}
	if len(noPK) > TopFindings {
		noPK = noPK[:TopFindings]
	}
	type scan struct {
		k tk
		n float64
	}
	var top []scan
	for k, n := range scans {
		if n > 0 {
			top = append(top, scan{k, n})
		}
	}
	sort.Slice(top, func(i, j int) bool { return top[i].n > top[j].n })
	if len(top) > TopFindings {
		top = top[:TopFindings]
	}
	for _, t := range top {
		cat.add("watchlog_mysql_table_full_scan_rows_total", t.n, "db", t.k.db, "table", t.k.table)
	}
	cat.extra["unused_indexes"] = unused
	cat.extra["no_primary_key"] = noPK
}
