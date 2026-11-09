---
title: PostgreSQL
description: Monitor PostgreSQL on Kubernetes and Docker with WatchLog: connections, queries, locks, replication, tables and vacuum, with a pg_monitor role and default alerts.
---

# PostgreSQL

WatchLog finds PostgreSQL servers from the images and ports your agents already see, on
Kubernetes clusters and Docker hosts. Open **Applications**, press **Monitor** on the one
you want, and choose how WatchLog logs in. Versions 12 and later are supported.

WatchLog logs in with a role that has `pg_monitor`. It reads the statistics views
(`pg_stat_activity`, `pg_stat_database`, `pg_stat_replication`, `pg_locks`,
`pg_stat_user_tables` and `_indexes`) and the WAL directory's listing, never table data.
Every session it opens is read-only (`default_transaction_read_only`), with a 5-second
`statement_timeout`, a 1-second `lock_timeout`, and `application_name` set to `watchlog`.

## Connecting

- **A role WatchLog creates (recommended):** WatchLog writes the command with a new
  password, for your cluster or host, for example:

  ```bash
  kubectl exec -n shop statefulset/postgres -- psql -U postgres -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE watchlog LOGIN PASSWORD '…'" -c "GRANT pg_monitor TO watchlog"
  ```

  On Docker it is `docker exec <container> psql …`. WatchLog tries to log in every 5
  seconds and the drawer turns green when it can, after it has checked that the role has
  `pg_monitor`.

- **An existing role:** its name and password, stored encrypted. If it lacks `pg_monitor`
  the test says so, with the `GRANT` to run. A superuser works, and WatchLog tells you it
  has more privilege than it needs.
- **Your own Secret or file:** on Kubernetes, a Secret in the collector's namespace that
  WatchLog may read once you run the two `kubectl create role/rolebinding` lines it shows;
  on Docker, a file under `/etc/watchlog/secrets/` on the host. The role still needs
  `pg_monitor`.

A wrong password turns the service red with "the user or password is refused", not
"unreachable": the fix is in the service's settings.

### pg_stat_statements

The query tables need the `pg_stat_statements` extension. Without it every other tab
works, and the query panels say what to do:

```sql
-- postgresql.conf (restart needed): shared_preload_libraries = 'pg_stat_statements'
CREATE EXTENSION pg_stat_statements;  -- in the postgres database
```

Query text is on by default: WatchLog shows the normalised text from
`pg_stat_statements` (values replaced by `$1`, `$2`, …), never the text of a running query
from `pg_stat_activity`. Statements PostgreSQL doesn't normalise, such as
`CREATE ROLE … PASSWORD`, keep only their command (`CREATE ROLE …`), so a password never
leaves the server. Turn query text off in the service's settings to keep only each
statement's id, calls and timings.

## What you see

| Tab                | What it shows                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Overview           | Connections against `max_connections`, transactions per second with the commit share, cache hit, replication lag, database size and its growth per day, the longest query; commits and rollbacks; the slowest queries; the busiest databases; capacity |
| Connections        | Backends by state (active, idle, idle in transaction); connections by client workload or container, or application name for manual sessions; limits; new connections per second (PostgreSQL 14+)                                                       |
| Queries            | Rows fetched, inserted, updated and deleted per second; query duration by statement mean; temporary files written; the top queries by total time                                                                                                       |
| Locks and waits    | What sessions wait on; who blocks whom right now and for how long; lock waits by hour and day; deadlocks; the most locked tables                                                                                                                       |
| Replication        | Replay lag per replica, with the 30 s line; replicas with their state; `pg_wal` against `max_wal_size`; replication slots; WAL generated                                                                                                               |
| Tables and storage | The largest tables; estimated bloat; indexes never used; database size                                                                                                                                                                                 |
| Vacuum             | Tables waiting for vacuum; dead rows; transaction ID age per database against the 2,000 M limit                                                                                                                                                        |

The capacity gauge compares the data volume with its size: on Kubernetes, the pod's
PersistentVolumeClaim (from the kubelet's volume stats); on Docker, the host filesystem
that holds Docker's data, since a Docker volume has no size of its own. It shows the days
left at the last 7 days' growth.

WatchLog reads the 100 largest tables over the 10 largest databases, the top 50
statements, and the 20 longest lock waits, whatever the size of the server.

## What WatchLog tells you

Connections near `max_connections` (with the workloads holding most), a query running
over 5 minutes, sessions idle in a transaction, lock waits (with the blocking client's
workload), deadlocks, a replica behind, an inactive replication slot keeping WAL,
transaction ID wraparound risk, a low cache hit, autovacuum not finishing on a table, and
`pg_stat_statements` missing.

## Default alerts

Created when you start monitoring; the drawer's ticks decide which start on.

- Connections above 90 % of `max_connections` for 5 minutes (warning)
- A query running longer than 5 minutes (critical; client sessions, not autovacuum or
  replication)
- Replication lag above 30 seconds for 2 minutes (warning)
- Transaction ID age above 1,500 M (critical)
- Deadlocks detected (warning)
- The service unreachable, or slow to connect (every service has these)

Each can be changed, and reset to its default, in the rule editor.

## Not available

- **A histogram of query durations:** PostgreSQL keeps no per-execution timings. WatchLog
  buckets each statement's calls by its mean time, and says so.
- **Exact bloat:** that needs `pgstattuple`, which reads every page of every table.
  WatchLog estimates bloat from the dead-row statistics, labelled "estimate".
- **Every lock wait:** PostgreSQL doesn't count waits. WatchLog samples `pg_locks` every
  30 seconds, so very short waits are missed.
- **"Autovacuum keeps getting cancelled":** this appears only in the server log. WatchLog
  says "autovacuum isn't finishing" when a table's dead rows rise for 24 hours with no
  autovacuum completed.
- **Indexes unused over 30 days:** until WatchLog has that much history, the table lists
  indexes with no scans since the statistics were last reset, and gives that date.
