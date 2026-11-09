---
title: Redis
description: Monitor Redis and Valkey on Kubernetes and Docker with WatchLog: memory, commands, clients, persistence and replication, with a read-only user and default alerts.
---

# Redis

WatchLog finds Redis and Valkey servers from the images and ports your agents already
see, on Kubernetes clusters and Docker hosts. Open **Applications**, press **Monitor** on
the one you want, and choose how WatchLog logs in. Versions 6.2 and later are supported;
Redis 7 adds the latency histogram.

## Connecting

- **No password:** nothing to set up. WatchLog tests the connection when the drawer opens.
  It tells you that the default user can run every command; a dedicated user is safer.
- **A read-only user WatchLog creates (recommended):** WatchLog writes the command with a
  new password, for your cluster or host, for example:

  ```bash
  kubectl exec -n shop statefulset/redis -- redis-cli ACL SETUSER watchlog reset on '>…' '~*' \
    +info +ping +slowlog +latency '+config|get' '+client|list' '+memory|stats' '+memory|usage' +scan
  ```

  On Docker it is `docker exec <container> redis-cli …`. If your Redis needs a password for
  the admin connection, add `-a` (or set `REDISCLI_AUTH`). WatchLog tries to log in every 5
  seconds and the drawer turns green when it can.

- **An existing user:** its name and password, stored encrypted. WatchLog checks which of
  the commands above it can run and says which tab needs what.
- **Your own Secret or file:** on Kubernetes, a Secret in the collector's namespace that
  WatchLog may read once you run the two `kubectl create role/rolebinding` lines it shows;
  on Docker, a file under `/etc/watchlog/secrets/` on the host.

The `~*` lets WatchLog see key names for the biggest-prefixes panel. It never reads a
value: key sizes come from `MEMORY USAGE`, and the slow log keeps only the command and the
key's prefix (turn query text off in the service's settings to keep only the command).

## What you see

| Tab                         | What it shows                                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview                    | Memory against `maxmemory`, hit rate, commands per second and their peak, clients and blocked clients, keys evicted in 24 hours, keys and the share with a TTL; memory and hits over time; the slow log              |
| Memory                      | Dataset, overhead and fragmentation; `maxmemory` with its policy; fragmentation ratio (healthy below 1.5); the biggest key prefixes, estimated from a sample of key names every 10 minutes; expired and evicted keys |
| Commands                    | Calls per second by command; the slowest commands by mean; the latency histogram (Redis 7+)                                                                                                                          |
| Clients                     | Connected and blocked clients; clients by workload or container; clients against `maxclients`                                                                                                                        |
| Persistence and replication | The last RDB save and AOF status, the replica state, changes since the last save; how many bytes each replica is behind                                                                                              |

A tab that needs a command the user can't run says which and how to grant it; the other
tabs keep working.

## What WatchLog tells you

Memory near `maxmemory`, keys being evicted, no `maxmemory` set (memory grows until the
container's limit), `KEYS` in the slow log, a replica disconnected, a failed save,
connections refused at `maxclients`, and blocked clients.

## Default alerts

Created when you start monitoring; the drawer's ticks decide which start on.

- Memory above 90 % of `maxmemory` for 5 minutes (warning)
- Keys are being evicted (warning)
- A replica disconnected (critical)
- The last RDB or AOF save failed (critical)
- Clients blocked for 2 minutes (warning)
- The service unreachable, or slow to connect (every service has these)

Each can be changed, and reset to its default, in the rule editor.

## Not available

- **Replication lag in seconds:** Redis reports offsets, not time. WatchLog shows how many
  bytes a replica is behind and when it last acknowledged.
- **Operations per second per client:** `CLIENT LIST` doesn't count commands per client.
  The service map shows bytes and connections per workload instead.
