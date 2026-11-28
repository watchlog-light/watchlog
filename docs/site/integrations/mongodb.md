---
title: MongoDB
description: Monitor MongoDB on Kubernetes and Linux servers with WatchLog: what it waits on, which operation shape is responsible, which service sends it and what changed, replica set elections and lag, sessions, collections and indexes, with a clusterMonitor user, read-only and never reading your documents.
---

# MongoDB

WatchLog finds MongoDB from the images and ports your agents already see (`mongo`,
`mongodb/mongodb-community-server` and the enterprise server image the community operator
runs, the Bitnami and Percona images, port 27017), on Kubernetes clusters and on Linux
servers (systemd services, process groups and containers). Open **Applications**, press
**Monitor** on the one you want, and choose how WatchLog logs in. MongoDB 6.0 and later is
supported, standalone or as a replica set; WatchLog is tested on 6.0, 7.0 and 8.0.

The page answers four questions: **what the server is waiting on**, **which operation is
responsible**, **which service sends it**, and **what changed**.

## What WatchLog reads, and what it never reads

WatchLog logs in with a user that has `clusterMonitor` and reads the server's statistics:

- `serverStatus` (operations, latencies, connections, the WiredTiger cache, eviction,
  checkpoints, tickets, cursors, flow control);
- `$currentOp`, sampled every 15 seconds (what each active operation is doing, its shape,
  which client sent it, open transactions, idle cursors, index builds);
- the server's own "Slow query" log lines (`getLog`), and `$queryStats` where the server
  keeps it;
- `replSetGetStatus` and `replSetGetConfig` (members, state, lag, heartbeats, votes,
  elections);
- `top`, `listDatabases`, `dbStats`, `$collStats` and `$indexStats`;
- `getParameter` (the feature compatibility version and the transaction lifetime limit);
- the oplog's first and last entries' timestamps.

It **never reads your documents**: it never runs `find` or `aggregate` on your
collections. Operations seen in `$currentOp` and in the log carry their literal values;
the collector reduces each to its **shape** before anything is stored or sent: field names
and operators kept, every value replaced by `?` (`find {createdAt: {$gt: ?}, type: ?}`).
It never changes state: no profiler level change, no index build, no `compact`, no
`killOp`. It connects to each member directly with the application name `watchlog`, and
every command stops after 2 seconds (`maxTimeMS`).

### What it costs

Measured on Step 0's servers (6.0, 7.0 and an 8.0 replica set) under load: about 0.6
commands a second on each member (from MongoDB's own `metrics.commands`), and at most 1 ms
of server time a second on each member (the collector's measured round trips, network
included), about 0.1 % of one core. The collector took 12 MB of memory watching eight
services.
Operations are sampled every 15 seconds; the slow log, members and server status read
every 15 seconds; clients and the shapes' facts every 30 seconds; collections and indexes
every 10 minutes, capped at the 50 largest databases and 100 largest collections, the 50
shapes with the most time and the 50 busiest clients.

## Connecting

- **A user WatchLog creates (recommended):** WatchLog writes the command with a new
  password, for your cluster or host, for example:

  ```bash
  kubectl exec -it -n shop statefulset/mongo -- mongosh -u root -p --authenticationDatabase admin --quiet \
    --eval 'db.getSiblingDB("admin").createUser({ user: "watchlog", pwd: "…", roles: [{ role: "clusterMonitor", db: "admin" }] })'
  ```

  It asks for the admin's password at the prompt; change `root` if your admin user has
  another name. On a server it is `mongosh …`, or `docker exec -it <container> mongosh …`
  for a container. On a replica set, run it once, against the primary: the user reaches
  every member. WatchLog tries to log in every 5 seconds and the drawer turns green once it
  has checked the user's roles.

- **An existing user:** its name and password, stored encrypted. It needs
  `clusterMonitor`; the test fails without it and gives the command that grants it. A
  user with `root` works, and WatchLog tells you it has more than it needs.
- **Your own Secret or file:** on Kubernetes, a Secret in the collector's namespace that
  WatchLog may read once you run the two `kubectl create role/rolebinding` lines it shows;
  on a server, a file under `/etc/watchlog/secrets/`.
- **Authentication off:** nothing to enter. WatchLog says the server lets anyone in.

### The privilege, by version

`clusterMonitor` is all WatchLog needs, on every version: it reads `$currentOp` for all
users, `getLog`, `top`, the replica set's status and configuration, `$collStats` and
`$indexStats` on every collection, `getParameter`, and the `local` database's oplog.
Nothing broader is asked for. A panel whose read is refused says so, with the command
that grants the role.

| Version | What it adds                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.0     | Everything except what follows; eviction by application threads in pages a second; checkpoints from `wiredTiger.transaction`                            |
| 7.0     | `$queryStats` from 7.0.12 when the server keeps it                                                                                                      |
| 8.0     | Operations waiting for a ticket told apart (`currentQueue`); eviction by application threads in time a second; checkpoints from `wiredTiger.checkpoint` |

**Where the shapes come from.** `$queryStats` counts every operation, but a self-hosted
server keeps it only when its owner turns it on (`internalQueryStatsRateLimit`, 0 by
default); Atlas keeps it. When it has rows, WatchLog uses it. Otherwise the shapes come
from the slow log, which holds only operations over `slowms` (100 ms by default), and
from the 15-second sample, which sees what runs while it looks. The Operations tab says
which source is in use.

### Managed services

**MongoDB Atlas** works the same way, with a database user that has `clusterMonitor`
(Atlas's "Monitor" built-in role grants it); `$queryStats` is on there. **Amazon
DocumentDB** answers only part of these commands; a panel whose command the server doesn't
have says "not available on this server", and the rest works. The data volume of a managed service isn't visible, so capacity shows what the
server reports.

### Query text

Query text is on by default: WatchLog shows each shape with its field names and operators,
never its values. Turn it off in the service's settings to keep only the operation, the
collection, its plan and timings; the shape is then named by a short hash.

## What you see

| Tab               | What it shows                                                                                                                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview          | The finding first; the operation flow (clients, operations, the replica set, the cache); six tiles with what is usual; read latency and the cache over time; eight health checks; the slow operations of the last hour by shape, with the documents each one reads and who sends it |
| Operations        | Every shape by its share of the time, with calls, mean against usual, "sent mostly by" and the missing-index hint; the shapes probably missing an index (collection, fields, documents examined per one returned); latency; the busiest collections                                 |
| Waits             | Active operations by what they wait on (running, a lock, a ticket, flow control, other), with a period to choose; the shapes and clients of that period                                                                                                                             |
| Clients           | Connections per workload, those opened since the last look, operations running now; connections and churn over time; open transactions and who holds them; idle cursors that never time out                                                                                         |
| Replica set       | Each member's state, lag, heartbeat, priority and votes; lag and heartbeats over time; the oplog's window, size and how fast it fills; rollbacks; elections, with why; flow control                                                                                                 |
| Collections       | The 100 largest: size, data, documents, average document, reusable space, growth; indexes unused on every member, redundant indexes, builds in progress; capacity of the volume and the connections                                                                                 |
| Cache and storage | The cache, dirty bytes and all indexes against it; eviction by application threads; tickets and the queue; checkpoint duration; page faults; the largest collections; the process's CPU, memory and disk I/O                                                                        |
| Alerts            | The service's alerts, and the defaults you haven't added                                                                                                                                                                                                                            |

A shape opens its own page: its mean against usual over time, calls and documents
returned, documents and keys examined, what it waits on, who sends it, and the alerts on
it (add "far slower than usual" or "mean above 1 s" in one click). A collection opens its
page: size and documents over time, operations and time, its shapes and its index
findings.

## What WatchLog tells you

The finding puts the cause first:

- **Collection scans, who sends them, and what they do:** "collection scans on
  shop.events, sent by analytics, fill the cache: 290 slow ones a minute, each reading about
  4.1 M documents", with the fields the filter uses.
- **What the operations wait on**, when it is mostly a lock, a ticket or flow control.
- No primary, a member down or behind, an oplog too short to ride out a secondary's day
  off, connections near the limit (with who holds them), the cache under pressure,
  operations queued for a ticket.
- Transactions open over 30 seconds (the server aborts them at its lifetime limit, 60
  seconds by default) and who holds them; idle cursors that never time out.
- Settings that hurt: access control off, an even number of voting members, a
  single-member set, the feature compatibility version behind the binary, many unused
  indexes.

When a service is slowed by collection scans, **probable cause** follows the finding to
the workload or container that sends them.

## Default alerts

Created when you start monitoring; the drawer's ticks decide which start on. The Alerts
tab offers the ones a service monitored before 1.4 doesn't have yet.

- The replica set has no primary for a minute (critical)
- A member down, or more than 60 seconds behind, for a minute (critical)
- Application threads evicting from the cache for 5 minutes (warning)
- Collection scans above 100 a minute for 5 minutes (warning)
- The oplog window under 12 hours for 10 minutes, once the oplog is full (warning)
- A replica set member down for a minute (critical), replication lag above 30 seconds for
  2 minutes (warning), and more than 20 slow operations a minute for 5 minutes (warning)
- The service unreachable, or slow to connect (every service has these)

Each can be changed, and reset to its default, in the rule editor.

## Not available

- **Documents near the 16 MB limit:** finding them would mean reading every document.
- **Disk latency:** MongoDB doesn't time its reads, and the agent sees the process's bytes,
  not its waits.
- **Every slow operation:** WatchLog reads the server's ring of its last 1,024 log lines.
  On a busy server, entries between two reads can be missed; the counters and latency
  histograms stay exact.
- **Ticket waits before 8.0:** on 6.0 and 7.0 an operation waiting for a ticket counts as
  running.
- **Who owns an idle cursor:** `$currentOp` names its collection, not its client.
- **Sharded clusters:** a `mongos` is read for its own operations and connections, and the
  page says so. Monitor each shard's replica set on its own to see its members. The
  balancer and chunk balance are not shown.
- **The oplog window of a new set:** until the oplog is full, the window is only how long
  the set has run. The alert waits until the oplog is full.
