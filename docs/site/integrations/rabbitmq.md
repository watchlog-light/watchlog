---
title: RabbitMQ
description: Monitor RabbitMQ on Kubernetes, Docker and Linux servers with WatchLog: every queue with how long it takes to drain, the message flow, the clients that connect, each node against its limits, and which consumer died when a queue stops draining. No RabbitMQ user, no management API.
---

# RabbitMQ

WatchLog finds RabbitMQ from the images and ports your agents already see, on Kubernetes
clusters and Linux servers. Open **Applications** and press **Monitor**: RabbitMQ needs no
user or password. Versions 3.10 and later are supported; 3.13 and 4.1 are the ones WatchLog is
tested against.

## What it needs

The `rabbitmq_prometheus` plugin, which ships with RabbitMQ and is on in the official
images. WatchLog reads it on port 15692 of every node. If it's off, the page says so and
gives the command for each node, for example:

```bash
kubectl exec -n shop rabbitmq-0 -- rabbitmq-plugins enable rabbitmq_prometheus
docker exec shop-rabbitmq-1 rabbitmq-plugins enable rabbitmq_prometheus
```

No restart is needed. WatchLog doesn't use the management API, never creates a RabbitMQ user,
and never reads messages.

For a tour in pictures, see [RabbitMQ monitoring](/applications/rabbitmq/).

The **Clients** tab and the names of publishers and consumers come from the agents' network
flows (eBPF), which the agents report on Kubernetes and on Linux servers. Without them the page
still works, and RabbitMQ's own counts of publishing channels and consumers stand in.

## What you see

| Tab      | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview | The finding first, when there is one. The **message flow**: publishers, exchanges, queues and consumers, with the rate between each. Six tiles (ready, unacked, publish, deliver, consumers, memory) with what is usual for this hour. Publish against deliver, with what happened marked on it. Ready messages by queue. The health checks. The queues that need a look: only those with a finding, or one line saying none does |
| Queues   | Every queue: its type (classic, quorum or stream), ready messages with a bar, unacked, in and out per second, consumers and how busy they are, and **drains in**. Sorts, searches, and filters the queues with no consumers. Each name opens the queue's page. Below, what was redelivered, dropped, returned or dead-lettered: one line when nothing was                                                                         |
| Clients  | Every workload or container that opened a connection to the broker in the last 24 hours: where it runs, the connections it opened, the bytes it sends and receives now, **Mostly** publishes or consumes when its traffic clearly says so, and how it ended when it did (OOM-killed, crash-looping, exited, gone). A client whose restarted pod or container is connected again shows as running, with when it restarted          |
| Nodes    | Each node against its own limits: memory against the high watermark, the disk alarm's limit against free disk, file descriptors, sockets (where the version reports them), Erlang processes; its version, connections, queue leaders (4.x) and uptime. Connection churn, and memory over time against the watermark                                                                                                               |
| Alerts   | The rules on this broker and its queues, switched on and off in place                                                                                                                                                                                                                                                                                                                                                             |

Queues are the 200 deepest of each node, plus every queue that has messages and no consumer,
however small. The Queues tab says so.

**Drains in** is ready ÷ (out − in) while the queue shrinks. Otherwise it says **growing**
(more comes in than goes out) or **never** (nothing takes from it). A stream keeps what it
holds, so it has nothing to drain.

**What is usual** comes from [What changed](../what-changed.md): the same hour of the week over
the last 14 days. Organisations without it see the tiles without that line.

## A queue's page

Every queue has a page of its own, with a stable address
(`/applications/<id>/queues/<queue>`, and `?vhost=` outside the default virtual host):

- Ready, unacked, consumers (and how many there were until when), the time since the last ack,
  and how long it takes to drain, or when memory reaches the high watermark at this rate.
- Depth against its usual range (a grey band, with What changed), in against acked and
  redelivered, and how busy the consumers were, with a note when they were near 100% before
  they left.
- **What happened**, from what WatchLog already has: the consumer count changing, the
  consumers turning busy, the clients that ended, and the alerts that fired and resolved.
- **Probable cause**: the client that was connected to the broker and ended when the queue lost
  its consumers. RabbitMQ doesn't say which client consumed which queue, and the page says so.
- Its facts: type, the leader (4.x), how many nodes hold a replica of a quorum queue, Raft
  commit latency, messages on disk, consumer utilisation, redelivered in the last hour.
- **Alerts on this queue**, and three to add in one click: grows with no consumers, ready above
  5,000, and receives dead letters (for a dead-letter queue).

## What WatchLog tells you

- **A queue grows with no consumers**, and which consumer was probably lost: the clients
  that were connected to RabbitMQ in the last 24 hours and have ended since, closest first,
  with how. With the time memory reaches the high watermark at this rate, and links to the
  queue and to the workload.
- A queue that grows although it has consumers (they're slower than the publishers).
- A memory or disk alarm (publishers are blocked).
- More than 10,000 unacked messages.
- Messages being dead-lettered (or, before 3.12, a dead-letter queue growing).
- The plugin being off on a node, with its command.

Streams and dead-letter queues (named like `*.dlq`, `*dead-letter*`) aren't "queues that lost
their consumers": a stream keeps what it holds, and a dead-letter queue usually has no
consumer. Their rows say so, and dead letters have their own finding.

A node that doesn't answer shows as a member down, like any service.

## Health checks

The Overview checks whether the broker itself is fine, with what its metrics can answer:

- Every queue with messages has a consumer.
- No memory alarm, no disk alarm.
- Every node answers, and has its metrics plugin on.
- The same version on every node.
- No unroutable messages (dropped or returned by an exchange).
- On 4.x, every quorum queue has a leader. With quorum queues, no leader elections in the last
  hour.

A failed check links to where it is explained or fixed.

### Quorum queues

RabbitMQ 4.x says which node leads each quorum queue; 3.13 doesn't, so the leader check and the
leader on a queue's page are 4.x only. Elections (the Raft term going up) and commit latency
come from every version. Whether each replica is caught up isn't exported by RabbitMQ: the queue's
page says how many nodes hold a replica, not that they are in sync.

### Unroutable messages

A message an exchange can't route is dropped, or returned to a publisher that asked for it
(`mandatory`). Usually a binding is missing, or the routing key has a typo. The message flow
shows them under the exchanges.

## Default alerts

Created when you start monitoring; the drawer's ticks decide which start on.

- A queue grows with no consumers for 5 minutes (critical)
- A memory or disk alarm (critical)
- More than 10,000 unacked messages for 5 minutes (warning)
- A node down for a minute (critical)
- Messages dead-lettered for 5 minutes (warning)
- A growing queue takes a node to its memory watermark within an hour (warning)

A rule can be scoped to one queue (`rabbitmq.queue.ready`, `rabbitmq.queue.consumers`,
`rabbitmq.queue.in.rate`, `rabbitmq.queue.unconsumed`), from the queue's page or the rule
editor.

## API and MCP

- `GET /api/v1/applications/<id>/rabbitmq/queues`: the queues, the worst first.
- `GET /api/v1/applications/<id>/rabbitmq/queues/<queue>?vhost=/`: one queue's numbers, facts,
  what happened and its probable cause.
- `GET /api/v1/applications/<id>/rabbitmq/clients`: the clients of the last 24 hours.

The MCP tool `get_application` includes the queues that need a look and the clients for a
RabbitMQ service; pass `queue` for one queue. See [MCP](../mcp.md).

## Not available

- **Network partitions:** the plugin doesn't export them. A node whose endpoint stops
  answering shows as down.
- **Replicas in sync:** not exported; the queue's page counts the nodes that hold a replica.
- **The quorum leader on 3.13:** 4.x only.
- **A queue's bindings and its dead-letter target:** queue arguments and policies aren't
  exported (only a count of bindings per exchange). Dead letters are counted for the whole
  broker, not per source queue.
- **Sockets on 4.x:** RabbitMQ 4 dropped the metric.
- **Dead-letter counters before RabbitMQ 3.12:** WatchLog watches queues named like
  dead-letter queues (`*dead*letter*`, `*.dlq`, `*.dlx`) instead.
- **Which client consumes which queue, and each client's message rates:** they need the
  management API and a user; WatchLog doesn't ask for either. A client's role is a guess from
  the direction of its traffic, shown only when one way clearly dominates.
