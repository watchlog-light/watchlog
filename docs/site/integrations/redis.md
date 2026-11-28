---
title: Redis
description: Monitor Redis and Valkey on Kubernetes and Linux servers with WatchLog: what fills the memory, which command keeps the main thread busy and who sends it, clients against their buffer limits, streams and their groups, persistence and replication, with a read-only user that never reads a value.
---

# Redis

WatchLog finds Redis and Valkey servers from the images and ports your agents already see,
on Kubernetes clusters and on Linux servers (systemd services, process groups and
containers). Open **Applications**, press **Monitor** on the one you want, and choose how
WatchLog logs in. Versions 6.2 and later are supported, and Valkey 7.2 and later; WatchLog
is tested on Redis 6.2, 7.2 and 8 and on Valkey 8, standalone, with replicas, with
Sentinel and as a cluster.

The page answers four questions: **what fills the memory**, **what keeps the main thread
busy**, **which service sends it**, and **what changed**.

## What WatchLog reads, and what it never reads

WatchLog reads `INFO` (memory, commands and their latency percentiles, the main thread's
CPU, persistence, replication, keyspace), named settings with `CONFIG GET`, `MEMORY STATS`,
`SLOWLOG GET`, `LATENCY HISTOGRAM` and `LATENCY LATEST`, `CLIENT LIST`, a cluster's
`CLUSTER INFO` and `CLUSTER SHARDS`, and a Sentinel's masters from its `INFO`.

**What fills the memory** comes from a bounded sample of key names: `SCAN` with
`COUNT 100` and a short pause between calls, at most 20,000 names every 10 minutes, then
for each name its size (`MEMORY USAGE`, with Redis's default sampling), its type (`TYPE`)
and whether it has a TTL (`PTTL`), and for a collection its number of elements (`HLEN`,
`LLEN`, `SCARD`, `ZCARD`, `XLEN`). The sample stops early when Redis answers more slowly
than when it began. Only each prefix (`session:`), its size, keys, share with a TTL and
type leave the collector; a key's full name only if you turn **Show key names** on in the
service's settings. A pass picks up where the last one stopped, so on a large instance
every key is seen, a window at a time; a small one is sampled again every minute or two
within the same budget.

**Streams** are found by that sample. For each stream WatchLog reads `XLEN`, `XINFO GROUPS`,
`XINFO CONSUMERS` and the summary form of `XPENDING` (counts and the oldest pending
entry's id, which is its time). It never runs `XINFO STREAM`, which returns entries.

It **never reads a value**: no `GET`, no `KEYS`, no `MONITOR`, no `XINFO STREAM`. It never
changes state: no `CONFIG SET`, no `CLIENT KILL`, no `FLUSH`, no `DEBUG`. `CONFIG GET` is
only ever asked for named settings (`maxmemory`, `save`, `appendonly`, `bind`,
`protected-mode`, `latency-monitor-threshold`, `client-output-buffer-limit`), never a
pattern that could return `requirepass` or `masterauth`. Every call stops after 2 seconds.

### What it costs

Measured on Step 0's instances under load, between two snapshots of each instance's own
`commandstats` 150 s apart (the commands only the collector sends):

| Instance                                   | Calls a second | Redis time a second | Share of the main thread |
| ------------------------------------------ | -------------- | ------------------- | ------------------------ |
| Redis 6.2, 150 k keys (sampler at its cap) | 100            | 0.12 ms             | 0.012 %                  |
| Redis 7.2, 300 k keys (sampler at its cap) | 100            | 0.21 ms             | 0.021 %                  |
| Valkey 8, 220 k keys (sampler at its cap)  | 102            | 0.20 ms             | 0.020 %                  |
| Redis 8 cluster node, 1 k keys             | 0.3            | 0.05 ms             | 0.005 %                  |

Almost all of it is the key sampler, which reads at most 20,000 names every 10 minutes:
on a small instance it finishes in seconds and rests until the next window. Server status
is read every 15 seconds; clients, the slow log and streams every 30 seconds. The collector
took 12 MB of memory watching eight services.

## Connecting

- **No password:** nothing to set up. WatchLog tests the connection when the drawer opens.
  It tells you that the default user can run every command; a dedicated user is safer.
- **A read-only user WatchLog creates (recommended):** WatchLog writes the command with a
  new password, for your cluster or host, for example:

  ```bash
  kubectl exec -n shop statefulset/redis -- redis-cli ACL SETUSER watchlog reset on '>…' '~*' \
    +info +ping '+slowlog|get' '+slowlog|len' '+latency|latest' '+latency|histogram' \
    '+config|get' '+client|list' '+memory|stats' '+memory|usage' +scan +type +pttl \
    +hlen +llen +scard +zcard +xlen '+xinfo|groups' '+xinfo|consumers' +xpending \
    '+cluster|info' '+cluster|shards' '+acl|whoami'
  ```

  On a server it is `redis-cli …`, or `docker exec <container> redis-cli …` for a
  container. If your Redis needs a password for the admin connection, add `-a` (or set
  `REDISCLI_AUTH`). WatchLog tries to log in every 5 seconds and the drawer turns green
  when it can.

- **An existing user:** its name and password, stored encrypted. WatchLog checks which of
  the commands above it can run and says which panel needs what, with the `ACL SETUSER`
  line that adds it.
- **Your own Secret or file:** on Kubernetes, a Secret in the collector's namespace that
  WatchLog may read once you run the two `kubectl create role/rolebinding` lines it shows;
  on a server, a file under `/etc/watchlog/secrets/`.

Each command is named: the user gets no category (`+@read`), and only the reading
subcommands of `SLOWLOG` and `LATENCY` (their `RESET` writes). `~*` lets the sampler's
commands see key names; none of them returns a value. On a cluster, run it on every node.
On a Sentinel, which has its own users, the default user is enough: WatchLog reads only its
`INFO`.

### Managed services

**Amazon ElastiCache and MemoryDB** rename or drop `CONFIG`; WatchLog takes `maxmemory`
and its policy from `INFO` instead, and the panels that need another setting say "not
available on this server". **Upstash** answers only part of these commands; the same note
marks what it lacks, and the rest works. Their process isn't visible, so CPU and memory come
from Redis's own counters, and "does the next save fit" isn't said.

## What you see

| Tab         | What it shows                                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview    | The finding first; the command flow (clients, commands, memory, persistence); six tiles with what is usual; memory against `maxmemory` with the largest prefix beneath it; evicted and expired keys; eight health checks; what fills the memory |
| Memory      | Dataset, overhead and fragmentation; `maxmemory`, its policy, and when it fills at the last hour's growth; every prefix with its share, keys, TTL share, growth and type; the largest sampled keys; keys without a TTL over time                |
| Commands    | The main thread's share of one core; each command's calls, mean, p50, p99 and p99.9 (7.0+) and failures; calls over time; latency; the slow log, each entry with the workload that sent it                                                      |
| Clients     | Each workload's connections, blocked ones, subscribers, idle time, output buffer against its limit, connections opened since the last look and its last command; connections, churn and refusals over time; `maxclients`                        |
| Streams     | Shown when there are streams: each group's consumers, lag, pending entries and the oldest pending; length and lag over time; each consumer and when it last read                                                                                |
| Persistence | The last save, how long it and its fork took; does the next save fit in the memory left; AOF size, rewrites and delayed fsyncs; changes since the last save; latency events                                                                     |
| Replication | Role, the link to the primary and how long it has been down, how many seconds of writes the backlog holds; each replica's offset lag; role changes; a Sentinel's masters; a cluster's state, slots and nodes                                    |
| Alerts      | The service's alerts, and the defaults you haven't added                                                                                                                                                                                        |

A prefix opens its own page (its memory and keys over time, its largest keys), as do a
command (calls, failures and latency over time, its slow log entries) and a stream group
(lag and pending over time, its consumers).

## What WatchLog tells you

The finding puts the cause first:

- **What fills the memory:** "keys under session:\* grew to 58% of memory, and 92% of them
  have no TTL: keys are being evicted".
- **The main thread saturated:** busy most of one core whatever the memory says, with the
  costliest command in the slow log and who sends it ("KEYS, sent by report-cron").
- **A group nobody serves:** "group billing on orders is falling behind: its consumer
  billing-worker-1 has read nothing for 18 min", linked to its workload.
- **The next save may be killed for memory:** its copy-on-write against the memory left
  under the process's limit.
- Memory near `maxmemory`, keys evicted, a client near its output-buffer limit, a replica
  disconnected, a backlog too short to ride out a disconnect, a failed save, a cluster with
  failing slots, a master a Sentinel considers down, connections refused, blocked clients.
- Settings that hurt: no password while listening beyond the host, no `maxmemory`, the
  `noeviction` policy on an instance used as a cache, no persistence at all on one used as
  a store (with how many keys a restart loses), and on a server transparent huge pages set
  to always and `vm.overcommit_memory` 0.

When the main thread is saturated by a client's command or a stream group loses its
consumer, **probable cause** follows the finding to that workload or container.

## Default alerts

Created when you start monitoring; the drawer's ticks decide which start on. The Alerts
tab offers the ones a service monitored before 1.4 doesn't have yet.

- Keys evicted where none were the day before (warning)
- The main thread saturated for 5 minutes (critical)
- The last RDB or AOF save failed (critical)
- A replica disconnected (critical)
- A stream group with lag and no consumer for 2 minutes (critical)
- A client near its output-buffer limit for a minute (warning)
- Memory above 90 % of `maxmemory` for 5 minutes, keys being evicted, clients blocked for
  2 minutes (warning)
- The service unreachable, or slow to connect (every service has these)

Each can be changed, and reset to its default, in the rule editor.

## Not available

- **Which service writes a prefix:** without `MONITOR`, Redis doesn't say who wrote a key.
  `CLIENT LIST` shows each connection's last command, not its key, so the Clients tab
  shows what each workload runs, and the prefixes show what fills the memory.
- **Latency percentiles on 6.2:** `INFO latencystats` comes with Redis 7.
- **Stream lag on 6.2:** `XINFO GROUPS` reports lag from Redis 7; on 6.2 the pending
  entries are shown.
- **Latency events with the monitor off:** the Persistence tab says so and gives
  `CONFIG SET latency-monitor-threshold 100`.
- **Replication lag in seconds:** Redis reports offsets, not time. WatchLog shows how many
  bytes a replica is behind, and how many seconds of writes the backlog holds.
- **Slot imbalance on 6.2:** `CLUSTER SHARDS` comes with Redis 7; on 6.2 the cluster's
  state and slot counts are shown.
