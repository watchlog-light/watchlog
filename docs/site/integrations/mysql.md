---
title: MySQL and MariaDB
description: Monitor MySQL and MariaDB on Kubernetes and Linux servers with WatchLog: what the server waits on, which statement is responsible, which service sends it and what changed, with a read-only user that never reads your rows.
---

# MySQL and MariaDB

WatchLog finds MySQL, MariaDB and Percona Server from the images and ports your agents
already see (`mysql`, `mariadb`, `percona`, the Bitnami images and the operators' server
images, port 3306), on Kubernetes clusters and on Linux servers (systemd services,
process groups and containers). Open **Applications**, press **Monitor** on the one you
want, and choose how WatchLog logs in. It is one integration for both servers, named by
what the server reports: "MySQL 8.4" or "MariaDB 11.4". MySQL 8.0 and later and MariaDB
10.6 and later are supported; Percona Server reads as MySQL.

The page answers four questions: **what the server is waiting on**, **which statement is
responsible**, **which service sends it**, and **what changed**.

## What WatchLog reads, and what it never reads

WatchLog reads the server's statistics: `SHOW GLOBAL STATUS` and a short list of variables;
the process list (client address, user, command, state and time, never a running
statement's text); `performance_schema`'s threads, statement digests and their recent
history, metadata locks, lock waits, table and index I/O counters and file I/O; InnoDB's
transactions, metrics and its status (for the latest deadlock); the replica status per
channel; the binary logs' list; and table sizes from InnoDB's persistent statistics.

It **never reads a row of your tables**, never runs `EXPLAIN`, `ANALYZE`, `KILL` or
anything that changes state. Statement text comes only from the digest summary, where
the server has already replaced every value with `?`. The latest deadlock is the one
place the server writes statements with their values (`WHERE id=1`): WatchLog's agent
replaces every literal with `?` before it leaves the host, and never reads the record
dumps (row bytes) that follow.

Every session it opens is read-only (`SET SESSION TRANSACTION READ ONLY`), waits at most
2 seconds for a lock (`lock_wait_timeout`, `innodb_lock_wait_timeout`), and stops any
statement after 2 seconds (`max_execution_time`; MariaDB: `max_statement_time`).

### What it costs

Measured on MySQL 8.0 and 8.4 and MariaDB 10.11 under load: about 1.4 short statements a
second and 0.5–1.4 ms of server time a second, under 0.2 % of one core. Sessions are
sampled every 15 seconds, statements and locks read every 30 seconds, and the catalog
(tables and indexes) every 10 minutes, capped at the 100 largest tables and the 50
statements with the most total time. The collector itself takes about 22 MB of memory.

## Connecting

- **A user WatchLog creates (recommended):** WatchLog writes the command with a new
  password, for your cluster or host, for example:

  ```bash
  kubectl exec -it -n shop statefulset/mysql -- sh -c 'exec "$(command -v mariadb || command -v mysql)" -uroot -p -e "$0"' \
    'CREATE USER `watchlog`@`%` IDENTIFIED BY "…" WITH MAX_USER_CONNECTIONS 2; GRANT PROCESS, REPLICATION CLIENT /*M!100509 , SLAVE MONITOR */ ON *.* TO `watchlog`@`%`; GRANT SELECT ON performance_schema.* TO `watchlog`@`%`; GRANT SELECT ON mysql.innodb_table_stats TO `watchlog`@`%`'
  ```

  It asks for the root password at the prompt. On a server it is the same `mysql` or
  `mariadb` command, or `docker exec -it <container> sh -c …` for a container. The same
  command works on MySQL and MariaDB: it uses the client the image has, and the `/*M!…*/`
  part, which only MariaDB runs, adds the `SLAVE MONITOR` privilege MariaDB needs to read a
  replica's status. WatchLog tries to log in every 5 seconds and the drawer turns green
  once it has checked the user's grants with `SHOW GRANTS`.

- **An existing user:** its name and password, stored encrypted. It needs `PROCESS`; the
  test fails without it and gives the `GRANT`. The other privileges only cost panels,
  which the test lists. A user with `ALL PRIVILEGES` works, and WatchLog tells you it has
  more than it needs.
- **Your own Secret or file:** on Kubernetes, a Secret in the collector's namespace that
  WatchLog may read once you run the two `kubectl create role/rolebinding` lines it shows;
  on a server, a file under `/etc/watchlog/secrets/`.

### Grants and settings

| Privilege or setting                                 | What it gives                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `PROCESS` (required)                                 | The process list, waits, InnoDB's transactions, lock waits and history list, the latest deadlock              |
| `REPLICATION CLIENT` (MariaDB: also `SLAVE MONITOR`) | Replication per channel and worker, the binary logs                                                           |
| `SELECT ON performance_schema.*`                     | Statements and their history, who sends each, the latency histogram, metadata locks, unused indexes, file I/O |
| `SELECT ON mysql.innodb_table_stats`                 | The largest tables                                                                                            |
| `performance_schema = ON`                            | Everything `performance_schema` gives; **on by default on MySQL, off on MariaDB**                             |
| MariaDB's statement consumers                        | Waits by statement and "sent mostly by"; off by default on MariaDB, on on MySQL                               |

`SELECT` on `sys` isn't asked for: its views run as the caller, so they add nothing these
grants don't give. `MAX_USER_CONNECTIONS 2` keeps WatchLog's user from ever taking more
than two of the server's connections; it uses one.

On MariaDB, turn on what the page needs in the server's configuration (a restart):

```ini
# my.cnf, or the server's command line
[mysqld]
performance_schema = ON
performance-schema-consumer-events-statements-current = ON
performance-schema-consumer-events-statements-history = ON
```

Without them every other panel works, and the panels that need them name the setting.

What each version adds:

| Version      | What it adds                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------ |
| MySQL 8.0    | Everything except what follows                                                                   |
| MySQL 8.0.30 | Redo in use against `innodb_redo_log_capacity`                                                   |
| MariaDB 10.6 | Everything with the settings above; redo from the checkpoint age; no statement latency histogram |

Managed databases (Amazon RDS and Aurora, Cloud SQL, Azure Database for MySQL) work the
same way: their admin user can grant these. Their data volume isn't visible to the agent,
so capacity and "fills the disk in" show only what the server itself reports, and the page
says so.

A wrong password turns the service red with "the user or password is refused", not
"unreachable": the fix is in the service's settings.

### Query text

Query text is on by default: WatchLog shows the statement text the digest summary keeps,
with every value already replaced by `?`. Passwords are redacted in any case. Turn query
text off in the service's settings to keep only each statement's digest, calls and
timings. WatchLog's own reads are left out of the statement tables.

## What you see

| Tab         | What it shows                                                                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview    | The finding first; the query flow (clients, threads, statements, InnoDB); six tiles (connections, queries, slow queries, buffer pool hit, replication lag, refused); connections and statements by type; eight health checks; connections by client; the statements that cost the most |
| Queries     | Every statement among the top 50 by total time: calls a second, mean, its usual mean, share of time, rows, who sends it mostly, and a hint ("probably missing an index on events", "5× slower than usual"); rows, the latency histogram, temporary tables on disk and full scans       |
| Waits       | What the active sessions wait on (CPU, I/O, lock, client, other) over time; drag across the chart to choose a period, and the statements and clients below follow it                                                                                                                   |
| Connections | Threads, connections by client with where it runs, its oldest idle connection and since when; by user; limits; aborted connections and handshake errors by client address                                                                                                              |
| Locks       | The blocking tree (row locks and metadata locks): the root blocker first, each session it blocks under it; open transactions with the history list length; row lock waits and time; the latest deadlock, values stripped; deadlocks over time                                          |
| Replication | Each channel and worker: IO and SQL threads, lag, heartbeat, received and executed GTIDs, the last error; the binary logs' size, growth and expiry, and when they fill the disk                                                                                                        |
| Tables      | The largest and fastest-growing tables (estimates); tables read by full scans; unused indexes; tables without a primary key; capacity                                                                                                                                                  |
| InnoDB      | The buffer pool; reads from disk; redo written and in use; the history list                                                                                                                                                                                                            |
| Alerts      | The service's alerts and its defaults                                                                                                                                                                                                                                                  |

**A statement's page** (`/applications/<id>/statements/<digest>`): its mean against its
usual mean, calls, rows examined against rows sent, calls with no index, temporary tables
on disk, errors, what it waits on, who sends it, the tables it names with the rows full
scans read, and alerts for this statement alone.

**A table's page** (`/applications/<id>/tables/<schema>/<table>`): its size and growth,
full scans, its indexes and which are unused, the statements that name it, and an alert
for its size.

On the Overview, the server's CPU, memory and disk I/O come from the agent (the pod on
Kubernetes; its systemd service, process group or container on a server), and the I/O
latency of the data files from `performance_schema`'s file I/O.

## What WatchLog tells you

- **Lock waits with the session holding the lock**: its workload or service, the table,
  and how long its transaction has been open, sleeping or not.
- **A long-open transaction**, with the history list it keeps growing.
- **A statement far slower than usual**: at least 3 times its mean of the 6 hours before,
  and 5 ms slower, while its calls didn't rise.
- **What the threads wait on**, when one kind of wait dominates.
- **A probable connection leak**: one client's many connections, all asleep for minutes
  ("shop/reporting keeps 25 connections that have all been idle for 12 min or more").
- **Binary logs that fill the disk** within a day at the current rate.
- A long history list, redo nearly full, a risky setting
  (`innodb_flush_log_at_trx_commit`, `sync_binlog`, the doublewrite buffer), a buffer pool
  the memory limit can't hold.
- And as before: connections near the limit, connections refused, a query running over
  5 minutes, deadlocks, replication stopped or behind, a low buffer pool hit, many
  temporary tables on disk, `performance_schema` off.

**Probable cause** follows a finding to the workload or service behind it, on Kubernetes
and on servers alike: "shop/mysql's writes wait on a row lock in shop.stock: shop/inventory-sync
holds it, its transaction open for 4 min", or "shop/mysql is at 92% of max_connections:
shop/report holds 37 of them".

## Default alerts

Created when you start monitoring; the drawer's ticks decide which start on.

- A session blocked for over 1 minute (critical)
- A transaction open for over 30 minutes (warning)
- A statement far slower than usual for 10 minutes (warning)
- The binary logs filling the disk within a day (critical)
- Connections above 90% of `max_connections` for 5 minutes (warning)
- A query running longer than 5 minutes (critical; client sessions, not replication
  threads)
- Replication stopped: the IO or SQL thread not running (critical)
- Replication lag above 30 seconds for 2 minutes (warning)
- Deadlocks detected (warning)
- The service unreachable, or slow to connect (every service has these)

The first four are new in 1.2. A service you monitored before keeps the rules it had, and
its Alerts tab offers the new ones, added in one click. Each rule can be changed, and
reset to its default, in the rule editor. A statement's page and a table's page add alerts
for that statement or table in one click.

## Not available

- **Plans:** `EXPLAIN` needs privileges on the tables, which can read their rows. WatchLog
  never runs it; the index hint comes from the server's own "no index used" count and the
  rows examined per row sent, and says it is a hint.
- **Duplicate indexes and auto-increment headroom:** `information_schema` shows them only
  to a user with privileges on the tables themselves. WatchLog doesn't ask for those.
- **Per-account connection limits:** they live in `mysql.user`, which WatchLog doesn't
  read. Accounts are shown against the global `max_user_connections`.
- **Aborted connections per client:** the server counts them per server only; per client
  address, only handshake errors (`performance_schema.host_cache`).
- **Each wait:** WatchLog samples the threads every 15 seconds, so a wait shorter than that
  is seen in proportion to how often it happens, not each time.
- **A histogram on MariaDB:** MariaDB has no statement histogram. WatchLog buckets each
  statement's calls by its mean time, and says so.
- **The slow query log:** it is a file (or a table with `log_output=TABLE`) that WatchLog
  doesn't read. The digest summary and the process list stand in.
- **Exact table sizes:** they need privileges on the tables themselves. WatchLog shows
  InnoDB's persistent statistics, labelled "estimate".
- **Galera and group replication:** each server is read as a single server; WatchLog
  doesn't interpret their cluster state.
- **The log:** WatchLog collects no logs, traces or in-application query timings (it is
  not an APM agent); everything here comes from the server's own statistics.
