---
title: MongoDB
description: Monitor MongoDB on Kubernetes and Docker with WatchLog: operations, replica set members and lag, slow operations with the client that sends them, the WiredTiger cache and the largest collections, with a clusterMonitor user and default alerts.
---

# MongoDB

WatchLog finds MongoDB from the images and ports your agents already see (`mongo`,
`mongodb/mongodb-community-server` and the enterprise server image the community operator
runs, the Bitnami and Percona images, port 27017), on Kubernetes clusters and Docker
hosts. Open **Applications**, press **Monitor** on the one you want, and choose how
WatchLog logs in. MongoDB 6.0 and later is supported, standalone or as a replica set;
WatchLog is tested on 7.0 and 8.0.

WatchLog reads the server's statistics, never your documents: `serverStatus` (operation
counters and latencies, connections, the WiredTiger cache and tickets, queues),
`replSetGetStatus` (the members, their state and lag), the server's own "Slow query" log
lines (`getLog`), `top`, `dbStats`, `$collStats` and `$indexStats`, the clients connected
(`$currentOp`), and the oplog's first and last entries' timestamps. It connects to each
member directly, so each member reports for itself, and every command stops after 5
seconds.

## Connecting

- **A user WatchLog creates (recommended):** WatchLog writes the command with a new
  password, for your cluster or host, for example:

  ```bash
  kubectl exec -it -n shop statefulset/mongo -- mongosh -u root -p --authenticationDatabase admin --quiet \
    --eval 'db.getSiblingDB("admin").createUser({ user: "watchlog", pwd: "…", roles: [{ role: "clusterMonitor", db: "admin" }] })'
  ```

  It asks for the admin's password at the prompt; change `root` if your admin user has
  another name. On Docker it is `docker exec -it <container> mongosh …`. On a replica set,
  run it once, against the primary: the user reaches every member. WatchLog tries to log
  in every 5 seconds and the drawer turns green once it has checked the user's roles.

- **An existing user:** its name and password, stored encrypted. It needs
  `clusterMonitor`; the test fails without it and gives the command that grants it. A
  user with `root` works, and WatchLog tells you it has more than it needs.
- **Your own Secret or file:** on Kubernetes, a Secret in the collector's namespace that
  WatchLog may read once you run the two `kubectl create role/rolebinding` lines it shows;
  on Docker, a file under `/etc/watchlog/secrets/` on the host.
- **Authentication off:** nothing to enter. The test says the server lets anyone in.

`clusterMonitor` is all WatchLog needs: on MongoDB 7.0 and 8.0 it also reads the `local`
database, so the oplog window needs nothing more.

Query text is on by default: for each slow operation WatchLog keeps its **shape**, the
field names and operators of its filter with every value replaced by `?`
(`find {amount: {$gt: ?}, kind: ?}`), never the values themselves. Turn query text off in
the service's settings to keep only the operation, the collection, its plan and timings
(and, on 8.0, the server's `queryShapeHash`).

## What you see

| Tab               | What it shows                                                                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview          | Operations per second (the share of reads), connections against the limit, replication lag, slow operations in the last hour, the WiredTiger cache, the oplog window; operations by type; lag per secondary; the replica set's members       |
| Operations        | Operation latency (the server's histograms); the busiest collections; recent slow operations: shape, collection, mean time, count, plan (collection scans marked) and the client workload or container that sent them; connections by client |
| Cache and storage | The WiredTiger cache used and dirty, and the disk; read and write tickets available; the largest collections; indexes never used since the server started                                                                                    |

WatchLog reads the 50 largest databases, the 100 largest collections and the clients of
the 50 busiest addresses, whatever the size of the server.

## What WatchLog tells you

No primary, a member down, a secondary behind, **slow collection scans with the client
that sends them** (its workload or container, the collection, how many a minute),
connections near the limit (with the clients holding most), the WiredTiger cache under
pressure, operations queued for a ticket, and an oplog too short to ride out a secondary's
day off.

When a service is slowed by collection scans or runs out of connections, **probable
cause** follows the finding to the workload or container behind it: "shop/mongo runs slow
collection scans on shop.events (290 a minute): shop/analytics sends them", or "shop/mongo
is at 93% of its connections: shop/report holds 56 of them".

## Default alerts

Created when you start monitoring; the drawer's ticks decide which start on.

- The replica set has no primary for a minute (critical)
- Replication lag above 30 seconds for 2 minutes (warning)
- A replica set member down for a minute (critical)
- More than 20 slow operations a minute for 5 minutes (warning)
- The oplog window under 24 hours for 10 minutes, once the oplog is full (warning)
- The service unreachable, or slow to connect (every service has these)

Each can be changed, and reset to its default, in the rule editor.

## Not available

- **Every slow operation:** WatchLog reads the server's in-memory ring of its last 1,024
  log lines. On a busy server, entries between two reads can be missed; the table says
  "recent", and the operation counters and latency histograms stay exact. The threshold is
  the server's `slowms` (100 ms by default).
- **Sharded clusters:** a `mongos` is read as one member (`serverStatus`). Monitor each
  shard's replica set on its own to see its members.
- **The oplog window of a new set:** until the oplog is full, the window is only how long
  the set has run. The alert waits until the oplog is full.
