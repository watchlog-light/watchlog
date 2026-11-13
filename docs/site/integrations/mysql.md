---
title: MySQL and MariaDB
description: Monitor MySQL and MariaDB on Kubernetes and Docker with WatchLog: connections, statements, lock waits with the session holding the lock, InnoDB and replication, with a read-only user and default alerts.
---

# MySQL and MariaDB

WatchLog finds MySQL, MariaDB and Percona Server from the images and ports your agents
already see (`mysql`, `mariadb`, `percona`, the Bitnami images and the operators' server
images, port 3306), on Kubernetes clusters and Docker hosts. Open **Applications**, press
**Monitor** on the one you want, and choose how WatchLog logs in. It is one integration
for both servers, named by what the server reports: "MySQL 8.4" or "MariaDB 11.4".
MySQL 8.0 and later and MariaDB 10.6 and later are supported; Percona Server reads as
MySQL.

WatchLog reads the server's statistics, never table data: `SHOW GLOBAL STATUS`, a short
list of variables (`max_connections`, `innodb_buffer_pool_size`, `performance_schema` and
a few more), the process list (client address, user, command and time, never a running
statement's text), InnoDB's transactions and lock waits, the replica status, and table
sizes from InnoDB's persistent statistics. With `performance_schema` on, it also reads
the statement digest summary and MySQL's statement latency histogram. Every session it
opens is read-only (`SET SESSION TRANSACTION READ ONLY`), waits at most 5 seconds for a
lock, and stops any statement after 5 seconds.

## Connecting

- **A user WatchLog creates (recommended):** WatchLog writes the command with a new
  password, for your cluster or host, for example:

  ```bash
  kubectl exec -it -n shop statefulset/mysql -- sh -c 'exec "$(command -v mariadb || command -v mysql)" -uroot -p -e "$0"' \
    'CREATE USER `watchlog`@`%` IDENTIFIED BY "…" WITH MAX_USER_CONNECTIONS 2; GRANT PROCESS, REPLICATION CLIENT /*M!100509 , SLAVE MONITOR */ ON *.* TO `watchlog`@`%`; GRANT SELECT ON performance_schema.* TO `watchlog`@`%`; GRANT SELECT ON mysql.innodb_table_stats TO `watchlog`@`%`'
  ```

  It asks for the root password at the prompt. On Docker it is
  `docker exec -it <container> sh -c …`. The same command works on MySQL and MariaDB: it
  uses the client the image has, and the `/*M!…*/` part, which only MariaDB runs, adds
  the `SLAVE MONITOR` privilege MariaDB needs to read a replica's status. WatchLog tries
  to log in every 5 seconds and the drawer turns green once it has checked the user's
  grants with `SHOW GRANTS`.

- **An existing user:** its name and password, stored encrypted. It needs `PROCESS`; the
  test fails without it and gives the `GRANT`. The other privileges only cost panels,
  which the test lists. A user with `ALL PRIVILEGES` works, and WatchLog tells you it has
  more than it needs.
- **Your own Secret or file:** on Kubernetes, a Secret in the collector's namespace that
  WatchLog may read once you run the two `kubectl create role/rolebinding` lines it shows;
  on Docker, a file under `/etc/watchlog/secrets/` on the host.

What the privileges are for:

| Privilege                                            | What it gives                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `PROCESS`                                            | The process list, InnoDB's transactions and lock waits, deadlocks (required) |
| `REPLICATION CLIENT` (MariaDB: also `SLAVE MONITOR`) | The replica status                                                           |
| `SELECT ON performance_schema.*`                     | Statements, the latency histogram, MySQL's lock tables                       |
| `SELECT ON mysql.innodb_table_stats`                 | The largest tables                                                           |

`MAX_USER_CONNECTIONS 2` keeps WatchLog's user from ever taking more than two of the
server's connections; it uses one.

A wrong password turns the service red with "the user or password is refused", not
"unreachable": the fix is in the service's settings.

### performance_schema

MySQL has `performance_schema` on by default; **MariaDB has it off.** Without it, the
statement tables and the latency histogram stay empty, and the page says what to do:

```ini
# my.cnf, or the server's command line (--performance-schema); a restart is needed
[mysqld]
performance_schema = ON
```

Lock waits don't need it on MariaDB: they come from `information_schema.INNODB_LOCK_WAITS`.

Query text is on by default: WatchLog shows the statement text the server's digest
summary keeps, with every value already replaced by `?`, never a running statement's
text. Passwords are redacted in any case. Turn query text off in the service's settings
to keep only each statement's digest, calls and timings. WatchLog's own reads are left
out of the statement tables.

## What you see

| Tab                | What it shows                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Overview           | Connections against `max_connections`, queries per second, slow queries per second, buffer pool hit, replication lag, the longest running query; connections over time; statements by type; the slowest statements |
| Connections        | Threads connected and running; connections by client workload or container (the user for local sessions); `max_connections` and the most connections at once; aborted and refused connections                      |
| Queries            | Rows read, inserted, updated and deleted per second; statement latency (MySQL's histogram, or by statement mean on MariaDB); temporary tables on disk and full scans; the top statements by total time             |
| Locks              | Row lock waits and the time spent waiting; who blocks whom right now: the waiting client, the table, how long, the blocking client and how long its transaction has been open; deadlocks                           |
| InnoDB and storage | The buffer pool's pages with data and dirty pages; reads from disk; redo written; the largest tables                                                                                                               |
| Replication        | The replica's IO and SQL threads and their last error; lag with the 30 s line                                                                                                                                      |

WatchLog reads the 100 largest tables, the top 50 statements and the 20 longest lock
waits, whatever the size of the server.

## What WatchLog tells you

Connections near `max_connections` (with the clients holding most), connections refused
at the limit, a query running over 5 minutes, **lock waits with the session holding the
lock** (its workload or container, the table, and how long its transaction has been
open), deadlocks, replication stopped or behind, a low buffer pool hit, many temporary
tables on disk, and `performance_schema` off or table statistics unreadable.

When a service waits on a lock or runs out of connections, **probable cause** follows the
finding to the workload or container behind it: "shop/mysql's writes wait on a row lock
in shop.stock: shop/inventory-sync holds it, its transaction open for 4 min", or "shop/mysql
is at 92% of max_connections: shop/report holds 37 of them".

## Default alerts

Created when you start monitoring; the drawer's ticks decide which start on.

- Connections above 90% of `max_connections` for 5 minutes (warning)
- A query running longer than 5 minutes (critical; client sessions, not replication
  threads)
- Replication stopped: the IO or SQL thread not running (critical)
- Replication lag above 30 seconds for 2 minutes (warning)
- Deadlocks detected (warning)
- The service unreachable, or slow to connect (every service has these)

Each can be changed, and reset to its default, in the rule editor.

## Not available

- **A histogram on MariaDB:** MariaDB has no statement histogram. WatchLog buckets each
  statement's calls by its mean time, and says so.
- **The slow query log:** it is a file (or a table with `log_output=TABLE`) that WatchLog
  doesn't read. The digest summary's mean and maximum per statement, and the process list
  for what runs now, stand in.
- **Exact table sizes:** they need privileges on the tables themselves. WatchLog shows
  InnoDB's persistent statistics, refreshed by automatic recalculation or
  `ANALYZE TABLE`, labelled "estimate".
- **A source's view of its replicas:** a source lists its replicas without their lag.
  Monitor each replica on its own.
- **Galera and group replication:** each server is read as a single server; WatchLog
  doesn't interpret their cluster state.
