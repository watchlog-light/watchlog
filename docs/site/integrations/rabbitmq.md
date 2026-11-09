---
title: RabbitMQ
description: Monitor RabbitMQ on Kubernetes and Docker with WatchLog: queues, consumers, message rates and node limits from the built-in prometheus plugin, and which consumer died when a queue stops draining.
---

# RabbitMQ

WatchLog finds RabbitMQ from the images and ports your agents already see, on Kubernetes
clusters and Docker hosts. Open **Applications** and press **Monitor**: RabbitMQ needs no
user or password. Versions 3.10 and later are supported.

## What it needs

The `rabbitmq_prometheus` plugin, which ships with RabbitMQ and is on in the official
images. WatchLog reads it on port 15692 of every node. If it's off, the page says so and
gives the command for each node, for example:

```bash
kubectl exec -n shop rabbitmq-0 -- rabbitmq-plugins enable rabbitmq_prometheus
docker exec shop-rabbitmq-1 rabbitmq-plugins enable rabbitmq_prometheus
```

No restart is needed. WatchLog doesn't use the management API, and never reads messages.

## What you see

| Tab           | What it shows                                                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview      | Ready messages and how fast they grow, unacked, publish and deliver per second (with the rate before a drop), consumers (and how many there were), memory against the high watermark; queue depth; publish against deliver; the queues |
| Queues        | Depth by queue; consumers by queue; ready messages of the deepest queues                                                                                                                                                               |
| Message rates | Publish, deliver, redeliver and ack per second; publisher confirms; unroutable and dead-lettered messages                                                                                                                              |
| Resources     | Each node's memory against the high watermark, file descriptors and Erlang processes; free disk against the alarm limit; memory over time                                                                                              |

Queues are the 200 deepest of each node, plus every queue that has messages and no
consumer, however small.

## What WatchLog tells you

- **A queue grows with no consumers**, and which consumer was probably lost: the clients
  that were connected to RabbitMQ in the last 24 hours (seen by the agents' network flows)
  and have ended since, closest first, with how: OOM-killed, crash-looping, exited, or
  gone. RabbitMQ's metrics don't say which client consumed which queue, so this is the
  likeliest one, not a certainty.
- A queue that grows although it has consumers (they're slower than the publishers).
- A memory or disk alarm (publishers are blocked).
- More than 10,000 unacked messages.
- Messages being dead-lettered (or, before 3.12, a dead-letter queue growing).
- The plugin being off on a node, with its command.

A node that doesn't answer shows as a member down, like any service.

## Default alerts

Created when you start monitoring; the drawer's ticks decide which start on.

- A queue grows with no consumers for 5 minutes (critical)
- A memory or disk alarm (critical)
- More than 10,000 unacked messages for 5 minutes (warning)
- A node down for a minute (critical)
- Messages dead-lettered for 5 minutes (warning)

## Not available

- **Network partitions:** the plugin doesn't export them. A node whose endpoint stops
  answering shows as down.
- **Dead-letter counters before RabbitMQ 3.12:** WatchLog watches queues named like
  dead-letter queues (`*dead*letter*`, `*.dlq`, `*.dlx`) instead.
- **Per-consumer details:** which connection consumes a queue needs the management API
  and a user; WatchLog doesn't ask for either.
