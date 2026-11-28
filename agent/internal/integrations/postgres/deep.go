// SPDX-License-Identifier: AGPL-3.0-only

package postgres

// The deeper reads of 1.2 (ADR-245): what the database waits on, which statement and which
// client, long transactions and the blocking tree, checkpoints, WAL and I/O, archiving and
// slots, what holds the xmin horizon back, schema findings and settings that hurt. All from
// views a pg_monitor role may read (Step 0, the notes' phases/databases-data.md); never a
// row of a user table, never pg_stat_activity.query, never EXPLAIN.

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Caps of 1.2 (ADR-245).
const (
	// CatalogEvery is how often the catalog scans run (tables, indexes, sequences); in
	// between their results are sent again from the cache.
	CatalogEvery = 10 * time.Minute
	// TopTransactions are the oldest open transactions kept.
	TopTransactions = 10
	// MaxTreeSessions caps the sessions in the blocking tree.
	MaxTreeSessions = 50
	// ClientsPerStatement caps the clients kept per statement.
	ClientsPerStatement = 5
	// TopFindings caps each schema finding's list.
	TopFindings = 20
)

// WaitClasses are the five classes of the "active sessions by wait" chart.
var WaitClasses = []string{"cpu", "io", "lock", "client", "other"}

// WaitClass maps pg_stat_activity.wait_event_type to a class: no wait is CPU (running),
// heavyweight locks and buffer pins are lock, IO is io, Client is client (the server waits
// for the application), everything else (LWLock, IPC, Timeout, Activity, Extension) other.
func WaitClass(t string) string {
	switch t {
	case "":
		return "cpu"
	case "IO":
		return "io"
	case "Lock", "BufferPin":
		return "lock"
	case "Client":
		return "client"
	}
	return "other"
}

// qid is the session's statement id where PostgreSQL has one (14+, compute_query_id).
func (s *scrape) qid(alias string) string {
	if s.major >= 14 {
		return "coalesce(" + alias + "query_id::text, '')"
	}
	return "''"
}

// waits samples the active client sessions once: by wait class, by statement (the top
// statements by id, the rest as "other") and by client address.
func (s *scrape) waits(ctx context.Context) {
	byClass := map[string]float64{}
	type sk struct{ id, class string }
	type ck struct{ addr, class string }
	byStmt := map[sk]float64{}
	byClient := map[ck]float64{}
	err := s.rows(ctx, `select coalesce(wait_event_type, ''), `+s.qid("")+`, coalesce(host(client_addr), ''), count(*)
		from pg_stat_activity
		where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid()
		group by 1, 2, 3`, func(v []any) {
		class, id, addr, n := WaitClass(str(v[0])), str(v[1]), str(v[2]), f(v[3])
		byClass[class] += n
		if id != "" {
			if !s.top[id] {
				id = "other"
			}
			byStmt[sk{id, class}] += n
		}
		if addr == "" {
			addr = "local"
		}
		byClient[ck{addr, class}] += n
	})
	if err != nil {
		return
	}
	for _, c := range WaitClasses {
		s.add("watchlog_postgres_active_sessions", byClass[c], "wait", c)
	}
	for k, n := range byStmt {
		s.add("watchlog_postgres_statement_active_sessions", n, "queryid", k.id, "wait", k.class)
	}
	clients := 0
	for k, n := range byClient {
		if clients++; clients > MaxClients {
			break
		}
		s.add("watchlog_postgres_client_active_sessions", n, "addr", k.addr, "wait", k.class)
	}
}

// statementClients counts the client sessions by their current or last statement (14+):
// idle sessions keep their last query_id, so a client that sends a statement is seen even
// between its calls.
func (s *scrape) statementClients(ctx context.Context) {
	if s.major < 14 || len(s.top) == 0 {
		return
	}
	per := map[string]int{}
	_ = s.rows(ctx, `select query_id::text, coalesce(host(client_addr), 'local'), count(*)
		from pg_stat_activity
		where backend_type = 'client backend' and query_id is not null and pid <> pg_backend_pid()
		group by 1, 2 order by 3 desc`, func(v []any) {
		id := str(v[0])
		if !s.top[id] || per[id] >= ClientsPerStatement {
			return
		}
		per[id]++
		s.add("watchlog_postgres_statement_client_sessions", f(v[2]), "queryid", id, "addr", str(v[1]))
	})
}

// sessionsByRole: client sessions per database and role (the 50 largest groups).
func (s *scrape) sessionsByRole(ctx context.Context) {
	_ = s.rows(ctx, `select coalesce(datname, ''), coalesce(usename, ''), count(*) from pg_stat_activity
		where backend_type = 'client backend' and pid <> pg_backend_pid()
		group by 1, 2 order by 3 desc limit `+strconv.Itoa(MaxClients), func(v []any) {
		s.add("watchlog_postgres_sessions", f(v[2]), "db", trimText(str(v[0]), 63), "role", trimText(str(v[1]), 63))
	})
}

// lockTree reads every session that waits on another or is waited on: its client, state,
// what it waits for, since when, its transaction's age, the sessions that block it, and its
// statement's id (text by id from pg_stat_statements). Session ids stay inside the status.
func (s *scrape) lockTree(ctx context.Context) []map[string]any {
	nodes := []map[string]any{}
	_ = s.rows(ctx, `with w as (
		  select pid, pg_blocking_pids(pid) as b from pg_stat_activity where cardinality(pg_blocking_pids(pid)) > 0
		)
		select a.pid, coalesce(host(a.client_addr), ''), coalesce(a.application_name, ''), coalesce(a.state, ''),
		  trim(coalesce(a.wait_event_type, '') || ' ' || coalesce(a.wait_event, '')),
		  coalesce(extract(epoch from now() - a.state_change), 0)::float8,
		  coalesce(extract(epoch from now() - a.xact_start), 0)::float8,
		  coalesce(array_to_string(w.b, ','), ''), `+s.qid("a.")+`
		from pg_stat_activity a left join w on w.pid = a.pid
		where a.pid in (select pid from w) or a.pid in (select unnest(b) from w)
		order by 7 desc limit `+strconv.Itoa(MaxTreeSessions), func(v []any) {
		var by []int
		for _, p := range strings.Split(str(v[7]), ",") {
			if n, err := strconv.Atoi(p); err == nil {
				by = append(by, n)
			}
		}
		nodes = append(nodes, map[string]any{
			"pid": int(f(v[0])), "addr": str(v[1]), "app": trimText(str(v[2]), 64), "state": str(v[3]),
			"wait": trimText(str(v[4]), 64), "seconds": int(f(v[5])), "xact": int(f(v[6])), "blocked_by": by,
			"queryid": str(v[8]), "member": s.member,
		})
	})
	blocked, longest := 0.0, 0.0
	for _, n := range nodes {
		if len(n["blocked_by"].([]int)) > 0 {
			blocked++
			longest = max(longest, float64(n["seconds"].(int)))
		}
		n["query"] = s.textOf(ctx, nonEmpty(n["queryid"]))
	}
	s.add("watchlog_postgres_blocked_sessions", blocked)
	s.add("watchlog_postgres_longest_block_seconds", longest)
	return nodes
}

func nonEmpty(v any) any {
	if s, _ := v.(string); s == "" {
		return nil
	}
	return v
}

// transactions are the oldest open transactions: client, idle or not, since when, whether
// they hold the xmin horizon (vacuum can't remove rows newer than it), and how many
// sessions they block (from the tree).
func (s *scrape) transactions(ctx context.Context, tree []map[string]any) {
	blocks := map[int]int{}
	for _, n := range tree {
		for _, b := range n["blocked_by"].([]int) {
			blocks[b]++
		}
	}
	rows := []map[string]any{}
	oldest := map[string]float64{"active": 0, "idle": 0}
	_ = s.rows(ctx, `select pid, coalesce(host(client_addr), ''), coalesce(application_name, ''), coalesce(state, ''),
		  extract(epoch from now() - xact_start)::float8, coalesce(extract(epoch from now() - state_change), 0)::float8,
		  backend_xmin is not null, `+s.qid("")+`
		from pg_stat_activity
		where backend_type = 'client backend' and xact_start is not null and pid <> pg_backend_pid()
		order by xact_start limit `+strconv.Itoa(TopTransactions), func(v []any) {
		state := str(v[3])
		kind := "active"
		if strings.HasPrefix(state, "idle") {
			kind = "idle"
		}
		oldest[kind] = max(oldest[kind], f(v[4]))
		pid := int(f(v[0]))
		rows = append(rows, map[string]any{
			"pid": pid, "addr": str(v[1]), "app": trimText(str(v[2]), 64), "state": state, "age": int(f(v[4])),
			"idle": map[bool]int{true: int(f(v[5])), false: 0}[kind == "idle"], "holds_xmin": v[6] == true,
			"blocks": blocks[pid], "queryid": str(v[7]), "member": s.member,
		})
	})
	for kind, age := range oldest {
		s.add("watchlog_postgres_oldest_xact_seconds", age, "state", kind)
	}
	for _, r := range rows {
		r["query"] = s.textOf(ctx, nonEmpty(r["queryid"]))
	}
	s.extra["transactions"] = append(asRows(s.extra["transactions"]), rows...)
}

// checkpoints: timed against requested, write and sync time, buffers written by whom
// (pg_stat_bgwriter up to 16, pg_stat_checkpointer from 17, backends from pg_stat_io on 16+);
// pg_stat_io's reads and writes by backend type (16+).
func (s *scrape) checkpoints(ctx context.Context) {
	var timed, req, write, sync, byCkpt, byBg, byBackend float64
	if s.major >= 17 {
		if err := s.c.QueryRow(ctx, `select num_timed, num_requested, write_time, sync_time, buffers_written
			from pg_stat_checkpointer`).Scan(&timed, &req, &write, &sync, &byCkpt); err != nil {
			return
		}
		_ = s.c.QueryRow(ctx, "select buffers_clean::float8 from pg_stat_bgwriter").Scan(&byBg)
	} else if err := s.c.QueryRow(ctx, `select checkpoints_timed, checkpoints_req, checkpoint_write_time, checkpoint_sync_time,
		  buffers_checkpoint, buffers_clean, buffers_backend from pg_stat_bgwriter`).Scan(&timed, &req, &write, &sync, &byCkpt, &byBg, &byBackend); err != nil {
		return
	}
	s.add("watchlog_postgres_checkpoints_total", timed, "kind", "timed")
	s.add("watchlog_postgres_checkpoints_total", req, "kind", "requested")
	s.add("watchlog_postgres_checkpoint_seconds_total", write/1000, "phase", "write")
	s.add("watchlog_postgres_checkpoint_seconds_total", sync/1000, "phase", "sync")
	s.add("watchlog_postgres_buffers_written_total", byCkpt, "by", "checkpointer")
	s.add("watchlog_postgres_buffers_written_total", byBg, "by", "bgwriter")
	if s.major >= 16 {
		byBackend = 0
		_ = s.rows(ctx, `select backend_type, coalesce(sum(reads), 0)::float8, coalesce(sum(writes), 0)::float8,
			  coalesce(sum(read_time), 0)::float8, coalesce(sum(write_time), 0)::float8
			from pg_stat_io group by 1`, func(v []any) {
			bt := str(v[0])
			s.add("watchlog_postgres_io_ops_total", f(v[1]), "backend_type", bt, "op", "read")
			s.add("watchlog_postgres_io_ops_total", f(v[2]), "backend_type", bt, "op", "write")
			s.add("watchlog_postgres_io_op_seconds_total", f(v[3])/1000, "backend_type", bt, "op", "read")
			s.add("watchlog_postgres_io_op_seconds_total", f(v[4])/1000, "backend_type", bt, "op", "write")
			if bt == "client backend" {
				byBackend += f(v[2])
			}
		})
	}
	s.add("watchlog_postgres_buffers_written_total", byBackend, "by", "backend")
	// Read and write time over every database (track_io_timing; 0 without it).
	var rt, wt float64
	if err := s.c.QueryRow(ctx, "select coalesce(sum(blk_read_time), 0)::float8, coalesce(sum(blk_write_time), 0)::float8 from pg_stat_database").Scan(&rt, &wt); err == nil {
		s.add("watchlog_postgres_io_time_seconds_total", rt/1000, "op", "read")
		s.add("watchlog_postgres_io_time_seconds_total", wt/1000, "op", "write")
	}
}

// archiving: pg_stat_archiver's counts and last times.
func (s *scrape) archiving(ctx context.Context) {
	var archived, failed, lastOK, lastFail float64
	var mode string
	if err := s.c.QueryRow(ctx, `select archived_count, failed_count, coalesce(extract(epoch from last_archived_time), 0)::float8,
		  coalesce(extract(epoch from last_failed_time), 0)::float8, current_setting('archive_mode') from pg_stat_archiver`).Scan(&archived, &failed, &lastOK, &lastFail, &mode); err != nil {
		return
	}
	on := 0.0
	if mode == "on" || mode == "always" {
		on = 1
	}
	s.add("watchlog_postgres_archive_mode", on)
	s.add("watchlog_postgres_archived_total", archived)
	s.add("watchlog_postgres_archive_failed_total", failed)
	s.add("watchlog_postgres_archive_last_seconds", lastOK, "result", "archived")
	s.add("watchlog_postgres_archive_last_seconds", lastFail, "result", "failed")
}

// slots: each replication slot's WAL kept, state (wal_status, 13+), how much more it may
// keep before it is invalidated (safe_wal_size, 13+, with max_slot_wal_keep_size), and since
// when it is inactive (17).
func (s *scrape) slots(ctx context.Context) {
	status, safe, since := "''", "null::float8", "null::float8"
	if s.major >= 13 {
		status, safe = "coalesce(wal_status, '')", "safe_wal_size::float8"
	}
	if s.major >= 17 {
		since = "extract(epoch from inactive_since)::float8"
	}
	rows := []map[string]any{}
	_ = s.rows(ctx, `select slot_name, coalesce(slot_type, ''), active::int,
		  coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0)::float8, `+status+`, `+safe+`, `+since+`,
		  coalesce(age(xmin), 0)::float8, coalesce(age(catalog_xmin), 0)::float8
		from pg_replication_slots`, func(v []any) {
		name := trimText(str(v[0]), 63)
		row := map[string]any{"slot": name, "type": str(v[1]), "active": f(v[2]) == 1, "retained": int64(f(v[3])),
			"wal_status": str(v[4]), "member": s.member}
		if v[5] != nil {
			row["safe"] = int64(f(v[5]))
			s.add("watchlog_postgres_slot_safe_wal_bytes", f(v[5]), "slot", name)
		}
		if v[6] != nil {
			row["inactive_since"] = int64(f(v[6]))
		}
		rows = append(rows, row)
	})
	s.extra["slots"] = append(asRows(s.extra["slots"]), rows...)
}

// xminHolders: the age of the oldest xmin each kind of holder keeps (sessions, slots,
// prepared transactions, replicas' hot-standby feedback), and the holders themselves.
func (s *scrape) xminHolders(ctx context.Context) {
	holders := []map[string]any{}
	add := func(kind, name string, age float64) {
		if age > 0 {
			holders = append(holders, map[string]any{"kind": kind, "name": trimText(name, 128), "age": int64(age), "member": s.member})
		}
	}
	ages := map[string]float64{"session": 0, "slot": 0, "prepared": 0, "replica": 0}
	_ = s.rows(ctx, `select coalesce(host(client_addr), application_name, ''), age(backend_xmin)::float8 from pg_stat_activity
		where backend_xmin is not null and pid <> pg_backend_pid() order by 2 desc limit 3`, func(v []any) {
		ages["session"] = max(ages["session"], f(v[1]))
		add("session", str(v[0]), f(v[1]))
	})
	_ = s.rows(ctx, `select slot_name, greatest(coalesce(age(xmin), 0), coalesce(age(catalog_xmin), 0))::float8 from pg_replication_slots
		where xmin is not null or catalog_xmin is not null order by 2 desc limit 3`, func(v []any) {
		ages["slot"] = max(ages["slot"], f(v[1]))
		add("slot", str(v[0]), f(v[1]))
	})
	_ = s.rows(ctx, `select gid, age(transaction)::float8, extract(epoch from now() - prepared)::float8 from pg_prepared_xacts order by 2 desc limit 3`, func(v []any) {
		ages["prepared"] = max(ages["prepared"], f(v[1]))
		add("prepared", str(v[0]), f(v[1]))
	})
	_ = s.rows(ctx, `select coalesce(application_name, host(client_addr), 'replica'), age(backend_xmin)::float8 from pg_stat_replication
		where backend_xmin is not null order by 2 desc limit 3`, func(v []any) {
		ages["replica"] = max(ages["replica"], f(v[1]))
		add("replica", str(v[0]), f(v[1]))
	})
	for kind, age := range ages {
		s.add("watchlog_postgres_xmin_age", age, "holder", kind)
	}
	var prepared, oldest float64
	if err := s.c.QueryRow(ctx, `select count(*)::float8, coalesce(max(extract(epoch from now() - prepared)), 0)::float8 from pg_prepared_xacts`).Scan(&prepared, &oldest); err == nil {
		s.add("watchlog_postgres_prepared_xacts", prepared)
		s.add("watchlog_postgres_prepared_xact_oldest_seconds", oldest)
	}
	s.extra["xmin_holders"] = append(asRows(s.extra["xmin_holders"]), holders...)
}

// hurtful are the settings read beyond the light scrape's: those that risk data or
// performance when set wrong (8 kB pages and kB converted to bytes, booleans to 1 and 0).
var hurtful = []string{"fsync", "full_page_writes", "autovacuum", "track_counts", "track_io_timing",
	"shared_buffers", "work_mem", "maintenance_work_mem", "synchronous_commit", "archive_mode", "max_slot_wal_keep_size"}

// settings reads the curated list, and which settings wait for a restart.
func (s *scrape) settings(ctx context.Context) {
	pending := []string{}
	_ = s.rows(ctx, `select name, setting, coalesce(unit, ''), vartype, pending_restart from pg_settings
		where name in ('`+strings.Join(hurtful, "','")+`') or pending_restart`, func(v []any) {
		name := str(v[0])
		if v[4] == true {
			pending = append(pending, name)
		}
		var val float64
		switch str(v[3]) {
		case "bool":
			if str(v[1]) == "on" {
				val = 1
			}
		case "enum":
			// synchronous_commit and archive_mode: off is 0, anything else 1.
			if str(v[1]) != "off" {
				val = 1
			}
		default:
			val = f(v[1])
			switch str(v[2]) {
			case "8kB":
				val *= 8192
			case "kB":
				val *= 1024
			case "MB":
				val *= 1 << 20
			}
		}
		for _, h := range hurtful {
			if h == name {
				s.add("watchlog_postgres_setting", val, "name", name)
			}
		}
	})
	sort.Strings(pending)
	s.add("watchlog_postgres_pending_restart", float64(len(pending)))
	if len(pending) > 0 {
		s.extra["pending_restart"] = strings.Join(pending, ", ")
	}
}

// ---------------------------------------------------------------- the catalog (every 10 min)

// catalog is one target's last catalog scan: re-sent until the next.
type catalog struct {
	at      time.Time
	samples []metrics.Sample
	extra   map[string]any
	perms   map[string]string
}

// schema reads, in one database, the duplicate indexes, the tables without a primary key,
// the invalid indexes and the sequences WatchLog may read (and counts those it may not).
func (s *scrape) schema(ctx context.Context, db string) map[string][]map[string]any {
	out := map[string][]map[string]any{"duplicate_indexes": {}, "no_primary_key": {}, "invalid_indexes": {}, "sequences": {}}
	user := `n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'`
	_ = s.rows(ctx, `select n.nspname || '.' || c.relname, string_agg(i.relname, ', ' order by i.relname),
		  sum(pg_relation_size(x.indexrelid))::float8
		from pg_index x join pg_class c on c.oid = x.indrelid join pg_class i on i.oid = x.indexrelid
		join pg_namespace n on n.oid = c.relnamespace where `+user+`
		group by n.nspname, c.relname, x.indrelid, x.indkey::text, x.indclass::text, coalesce(x.indexprs::text, ''), coalesce(x.indpred::text, '')
		having count(*) > 1 order by 3 desc limit `+strconv.Itoa(TopFindings), func(v []any) {
		out["duplicate_indexes"] = append(out["duplicate_indexes"], map[string]any{"db": db, "table": trimText(str(v[0]), 128),
			"indexes": trimText(str(v[1]), 200), "size": int64(f(v[2])), "member": s.member})
	})
	_ = s.rows(ctx, `select n.nspname || '.' || c.relname, pg_total_relation_size(c.oid)::float8
		from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where c.relkind in ('r', 'p') and `+user+`
		  and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p')
		order by 2 desc limit `+strconv.Itoa(TopFindings), func(v []any) {
		out["no_primary_key"] = append(out["no_primary_key"], map[string]any{"db": db, "table": trimText(str(v[0]), 128),
			"size": int64(f(v[1])), "member": s.member})
	})
	_ = s.rows(ctx, `select n.nspname || '.' || c.relname, i.relname from pg_index x
		join pg_class c on c.oid = x.indrelid join pg_class i on i.oid = x.indexrelid
		join pg_namespace n on n.oid = c.relnamespace where not x.indisvalid and `+user+` limit `+strconv.Itoa(TopFindings), func(v []any) {
		out["invalid_indexes"] = append(out["invalid_indexes"], map[string]any{"db": db, "table": trimText(str(v[0]), 128),
			"index": trimText(str(v[1]), 128), "member": s.member})
	})
	// Sequences: their value is readable only with SELECT on the sequence (pg_monitor isn't
	// enough); the unreadable ones are counted so the page can name the grant.
	_ = s.rows(ctx, `select n.nspname || '.' || c.relname, has_sequence_privilege(c.oid, 'SELECT'),
		  coalesce(case when has_sequence_privilege(c.oid, 'SELECT') then pg_sequence_last_value(c.oid) end, 0)::float8,
		  q.seqmax::float8, q.seqincrement::float8
		from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_sequence q on q.seqrelid = c.oid
		where c.relkind = 'S' and `+user, func(v []any) {
		row := map[string]any{"db": db, "sequence": trimText(str(v[0]), 128), "readable": v[1] == true, "member": s.member}
		if v[1] == true && f(v[3]) > 0 && f(v[4]) > 0 {
			row["used"] = f(v[2]) / f(v[3])
		}
		out["sequences"] = append(out["sequences"], row)
	})
	return out
}
