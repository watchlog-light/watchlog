---
title: PostgreSQL
description: Monitor PostgreSQL on Kubernetes and Linux servers with WatchLog: what the database waits on, which statement is responsible, which service sends it and what changed, with a pg_monitor role, read-only and never reading your rows.
---

# PostgreSQL

WatchLog finds PostgreSQL servers from the images and ports your agents already see, on
Kubernetes clusters and on Linux servers (systemd services, process groups and
containers). Open **Applications**, press **Monitor** on the one you want, and choose how
WatchLog logs in. Versions 12 and later are supported; a few parts need 13, 14 or 16,
named below.

The page answers four questions: **what the database is waiting on**, **which statement
is responsible**, **which service sends it**, and **what changed**.

## What WatchLog reads, and what it never reads

WatchLog logs in with a role that has `pg_monitor` and reads PostgreSQL's statistics
views: `pg_stat_activity`, `pg_stat_database`, `pg_stat_statements`, `pg_locks` with
`pg_blocking_pids()`, `pg_stat_replication`, `pg_replication_slots`, `pg_stat_archiver`,
`pg_stat_bgwriter` (`pg_stat_checkpointer` on 17), `pg_stat_wal`, `pg_stat_io` (16+),
`pg_stat_user_tables` and `_indexes`, `pg_index`, `pg_prepared_xacts`, `pg_settings` and the
WAL directory's listing.

It **never reads a row of your tables**, never runs `EXPLAIN`, `ANALYZE`, `VACUUM` or
anything that changes state, and never reads the text of a running query from
`pg_stat_activity`: statement text comes only from `pg_stat_statements`, where PostgreSQL
has already replaced every value with `$1`, `$2`, …

Every session it opens is read-only (`default_transaction_read_only`), with a 2-second
`statement_timeout`, a 1-second `lock_timeout`, and `application_name` set to `watchlog`.

### What it costs

Measured on PostgreSQL 13, 16 and 17 under load: about 1.4 short statements a second and
0.3–0.9 ms of database time a second, under 0.1 % of one core. Sessions are sampled every
15 seconds, statements and locks read every 30 seconds, and the catalog (tables, indexes,
sequences) every 10 minutes, capped at the 100 largest tables and the 50 statements with
the most total time. The collector itself takes about 22 MB of memory.

## Connecting

- **A role WatchLog creates (recommended):** WatchLog writes the command with a new
  password, for your cluster or host, for example:

  ```bash
  kubectl exec -n shop statefulset/postgres -- psql -U postgres -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE watchlog LOGIN PASSWORD '…'" -c "GRANT pg_monitor TO watchlog"
  ```

  On a server it is `sudo -u postgres psql …`, or `docker exec <container> psql …` for a
  container. WatchLog tries to log in every 5 seconds and the drawer turns green when it
  can, after it has checked that the role has `pg_monitor`.

- **An existing role:** its name and password, stored encrypted. If it lacks `pg_monitor`
  the test says so, with the `GRANT` to run. A superuser works, and WatchLog tells you it
  has more privilege than it needs.
- **Your own Secret or file:** on Kubernetes, a Secret in the collector's namespace that
  WatchLog may read once you run the two `kubectl create role/rolebinding` lines it shows;
  on a server, a file under `/etc/watchlog/secrets/`. The role still needs `pg_monitor`.

A wrong password turns the service red with "the user or password is refused", not
"unreachable": the fix is in the service's settings.

### Grants and settings, by version

`pg_monitor` is all WatchLog asks for. Three things are optional; without them every other
panel works, and the panel that needs one says so, with the command:

| What                    | Gives                                                                            | How                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pg_monitor` (required) | Everything on the page except the three below                                    | `GRANT pg_monitor TO watchlog;`                                                                                                 |
| `pg_stat_statements`    | Statements, their history, "sent mostly by", "slower than usual", the index hint | `shared_preload_libraries = 'pg_stat_statements'` in `postgresql.conf` (a restart), then `CREATE EXTENSION pg_stat_statements;` |
| `track_io_timing = on`  | I/O latency (the time a block read or write takes)                               | `ALTER SYSTEM SET track_io_timing = on; SELECT pg_reload_conf();`                                                               |
| `SELECT` on sequences   | How full each sequence is against its type's maximum                             | `GRANT SELECT ON ALL SEQUENCES IN SCHEMA <schema> TO watchlog;` (it reads only their counters, never a row)                     |

What each version adds:

| Version | What it adds                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 12      | Everything except what follows; statements' `total_time` stands in for `total_exec_time`                                        |
| 13      | Replication slots' `safe_wal_size`                                                                                              |
| 14      | Waits by statement and "sent mostly by" (`query_id` in `pg_stat_activity`; set `compute_query_id = on` if it is off); WAL stats |
| 16      | `pg_stat_io`: writes by backends, checkpointer and background writer, and I/O times                                             |
| 17      | `pg_stat_checkpointer`; slots' `inactive_since`                                                                                 |

Managed databases (Amazon RDS and Aurora, Cloud SQL, Azure Database for PostgreSQL) work
the same way: their admin user can grant `pg_monitor`. Their data volume isn't visible to
the agent, so capacity and "fills the disk in" show only what PostgreSQL itself reports,
and the page says so.

### Query text

Query text is on by default: WatchLog shows the normalised text from `pg_stat_statements`.
Statements PostgreSQL doesn't normalise, such as `CREATE ROLE … PASSWORD`, keep only their
command (`CREATE ROLE …`), so a password never leaves the server. Turn query text off in the
service's settings to keep only each statement's id, calls and timings.

## What you see

| Tab         | What it shows                                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview    | The finding first; the query flow (clients, sessions, queries, storage); six tiles (connections, transactions, lock waits, replication lag, cache hit, disk); transactions and sessions by state; eight health checks; the statements that cost the most, with who sends each |
| Queries     | Every statement among the top 50 by total time: calls a second, mean, its usual mean, share of time, rows, who sends it mostly, and a hint ("probably missing an index on shop.events", "5× slower than usual"); rows, durations, temporary files                             |
| Waits       | What the active sessions wait on (CPU, I/O, lock, client, other) over time; drag across the chart to choose a period, and the statements and clients below follow it                                                                                                          |
| Connections | Sessions by state, by client workload or service, by database and role; limits; new connections; open transactions with their age and whether they are idle; pgbouncer noted when a client is one                                                                             |
| Locks       | The blocking tree: the root blocker first, each session it blocks under it, with its client, what it does, for how long and its statement; open transactions; lock waits by hour and day; deadlocks; the most locked tables                                                   |
| Replication | Replicas and their lag; replication slots with the WAL each keeps and when it fills the disk; archiving; checkpoints (timed and requested), their write and sync time, buffers written, WAL generated                                                                         |
| Tables      | The largest and fastest-growing tables; bloat (estimate); unused and duplicate indexes; tables without a primary key; invalid indexes; sequences against their maximum; capacity                                                                                              |
| Vacuum      | Tables waiting for vacuum; dead rows; transaction ID age against wraparound; who holds the xmin horizon back (a session, a slot, a prepared transaction, a replica); prepared transactions                                                                                    |
| Alerts      | The service's alerts and its defaults                                                                                                                                                                                                                                         |

**A statement's page** (`/applications/<id>/statements/<statement>`, from any statement):
its mean against its usual mean, calls and rows, the blocks it reads, what it waits on,
who sends it, the tables it names with how much of them full scans read, and alerts for
this statement alone ("far slower than usual", "mean above 1 s").

**A table's page** (`/applications/<id>/tables/<database>/<table>`): its size and growth,
dead rows and autovacuum, scans, its indexes, the statements that name it, and alerts for
this table alone ("dead rows above 1 M", "larger than 100 GiB").

On Kubernetes, the database pod's CPU, memory and disk I/O come from the agent; on a
server, those of its systemd service, process group or container. A service known only by
its address says so.

## What WatchLog tells you

- **A blocking session**, with its workload or service, whether it is idle in its
  transaction, how long it has held the lock and on which table: "A transaction of
  shop/stock-sync has been open for 18 min and blocks another session."
- **A long-open transaction**, and whether it holds the xmin horizon back.
- **A statement far slower than usual**: at least 3 times its mean of the 6 hours before,
  and 5 ms slower, while its calls didn't rise.
- **What the sessions wait on**, when one kind of wait dominates.
- **A probable connection leak**: one client's many connections all idle for minutes.
- **A replication slot that fills the disk** within a day at the current rate.
- A sequence near its maximum, a risky setting (`fsync`, `full_page_writes`, `autovacuum`
  or `track_counts` off), settings waiting for a restart, `max_connections` that
  `work_mem` can't afford in the memory limit.
- And as before: connections near the limit, a query running over 5 minutes, deadlocks,
  a replica behind, an inactive slot, wraparound risk, a low cache hit, autovacuum not
  finishing, `pg_stat_statements` missing.

**Probable cause** follows a finding to the workload or service behind it, on Kubernetes
and on servers alike.

## Default alerts

Created when you start monitoring; the drawer's ticks decide which start on.

- A session blocked for over 1 minute (critical)
- A transaction open for over 30 minutes (warning)
- A statement far slower than usual for 10 minutes (warning)
- A replication slot filling the disk within a day (critical)
- A sequence above 90 % of its maximum (warning)
- Connections above 90 % of `max_connections` for 5 minutes (warning)
- A query running longer than 5 minutes (critical; client sessions, not autovacuum or
  replication)
- Replication lag above 30 seconds for 2 minutes (warning)
- Transaction ID age above 1,500 M (critical)
- Deadlocks detected (warning)
- The service unreachable, or slow to connect (every service has these)

The first five are new in 1.2. A service you monitored before keeps the rules it had, and
its Alerts tab offers the new ones, added in one click. Each rule can be changed, and reset to its default, in
the rule editor. A statement's page and a table's page add alerts for that statement or
table in one click.

## Not available

- **Plans:** `EXPLAIN` needs privileges that can read your tables, and planning takes
  locks. WatchLog never runs it; the index hint ("probably missing an index") comes from
  the blocks a statement reads per row and the tables full scans read, and says it is a
  hint.
- **Integer columns near their maximum:** that needs reading the column's values, which
  are your data. Sequences are shown instead.
- **Each wait:** PostgreSQL doesn't count waits. WatchLog samples the sessions every
  15 seconds, so a wait shorter than that is seen in proportion to how often it happens,
  not each time.
- **Waits by statement on 12 and 13:** `pg_stat_activity` has no `query_id` before 14.
- **A histogram of query durations:** PostgreSQL keeps no per-execution timings. WatchLog
  buckets each statement's calls by its mean time, and says so.
- **Exact bloat:** that needs `pgstattuple`, which reads every page of every table.
  WatchLog estimates bloat from the statistics, labelled "estimate".
- **"Autovacuum keeps getting cancelled":** this appears only in the server log. WatchLog
  says "autovacuum isn't finishing" when a table's dead rows rise for 24 hours with no
  autovacuum completed.
- **Indexes unused over 30 days:** until WatchLog has that much history, the table lists
  indexes with no scans since the statistics were last reset, and gives that date.
- **The log:** WatchLog collects no logs, traces or in-application query timings (it is
  not an APM agent); everything here comes from PostgreSQL's own statistics.
