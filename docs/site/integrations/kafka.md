---
title: Kafka
description: Monitor Kafka on Kubernetes and Docker with WatchLog: brokers up, offline and under-replicated partitions, consumer-group lag per topic, and the consumer group that lost its members, read-only through the Kafka protocol, with no JMX agent and default alerts.
---

# Kafka

WatchLog finds Kafka from the images and ports your agents already see
(`apache/kafka`, `apache/kafka-native`, `bitnami/kafka`, `confluentinc/cp-kafka` and
Strimzi's, port 9092), on Kubernetes clusters and Docker hosts. Open **Applications**,
press **Monitor** on the one you want, and choose how WatchLog logs in (on a PLAINTEXT
listener, nothing). Kafka 3.0 and later is supported, with ZooKeeper or KRaft; WatchLog is
tested on Kafka 4.1 as a single KRaft node.

WatchLog reads Kafka through the Kafka protocol's admin API, the way a client does, and
never your messages. It doesn't need a Java agent in the broker (no JMX). What it asks,
all read-only:

- `Metadata`: the brokers, the controller, every partition with its leader, replicas and
  in-sync replicas;
- `ListOffsets`: each partition's end offset;
- `ListGroups`, `DescribeGroups` and `OffsetFetch`: each consumer group's state, its
  members (client id, the host they connect from, the partitions assigned) and its
  committed offsets;
- `DescribeLogDirs`: the size of each topic on each broker;
- `DescribeConfigs`: each topic's retention, when allowed;
- `DescribeQuorum`: the KRaft controllers, when allowed.

No call that changes anything is in WatchLog's code. The collector bootstraps from the
broker it discovered and learns the others from `Metadata`; every request stops after 5
seconds.

## Connecting

- **Nothing (a PLAINTEXT listener):** no user, no password. The test says the cluster lets
  anyone in.
- **A user WatchLog creates (recommended with SASL):** WatchLog writes the commands with a
  new password, for your cluster or host: a SCRAM-SHA-512 user, and ACLs for `Describe` on
  the cluster, every topic and every group, plus `DescribeConfigs` on topics (for
  retention). For example:

  ```bash
  kubectl exec -it -n shop statefulset/kafka -- /opt/kafka/bin/kafka-configs.sh \
    --bootstrap-server localhost:9092 --alter --entity-type users --entity-name watchlog \
    --add-config 'SCRAM-SHA-512=[password=…]'
  kubectl exec -it -n shop statefulset/kafka -- /opt/kafka/bin/kafka-acls.sh \
    --bootstrap-server localhost:9092 --add --allow-principal User:watchlog \
    --operation Describe --cluster --topic '*' --group '*'
  kubectl exec -it -n shop statefulset/kafka -- /opt/kafka/bin/kafka-acls.sh \
    --bootstrap-server localhost:9092 --add --allow-principal User:watchlog \
    --operation DescribeConfigs --topic '*'
  ```

  On Docker it is `docker exec -it <container> …`. If your listener on 9092 itself needs
  a login, add `--command-config` with an admin's client properties. The `apache/kafka-native`
  image ships the broker only, without these tools: run them from an `apache/kafka`
  container on the same network, with `--bootstrap-server` set to the broker. WatchLog tries to log
  in every 5 seconds and the drawer turns green once it has checked what the user may
  describe.

- **An existing user:** its name and password, stored encrypted.
- **Your own Secret or file:** on Kubernetes, a Secret in the collector's namespace that
  WatchLog may read once you run the two `kubectl create role/rolebinding` lines it shows;
  on Docker, a file under `/etc/watchlog/secrets/` on the host.

With a password, WatchLog logs in with SASL and picks the first mechanism the broker
offers of SCRAM-SHA-512, SCRAM-SHA-256 and PLAIN. If the listener wants TLS, WatchLog uses
it; the certificate is not verified, as for MongoDB and PostgreSQL's `sslmode=prefer`.

Each missing ACL costs only its panels, and the page names it: `Describe` on groups
(consumer groups and lag), `Describe` on the cluster (topic sizes, the KRaft quorum),
`DescribeConfigs` on topics (retention).

### Advertised listeners

A Kafka client connects to the address each broker **advertises**, not to the one it
started from. In Compose that is often a service name (`kafka:9092`) that the host, where
the collector runs, can't resolve; on Kubernetes it is usually the pod's DNS name, which
resolves. When an advertised name doesn't resolve, or names `localhost`, WatchLog connects
to the address of the pod or container it discovered instead. Nothing to change on your
side.

## What you see

| Tab              | What it shows                                                                                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview         | Brokers up of those known, offline and under-replicated partitions, messages in per second, consumer groups (and how many have no members), the largest lag; messages in by topic; lag per group; the groups: state, members, topics, lag and lag in time |
| Topics           | The largest topics; the busiest by messages in; every topic: partitions, replication factor, offline and under-replicated partitions, retention, size                                                                                                     |
| Consumer groups  | Lag per group and topic; messages consumed per second per group; the members: client id, the workload or container they run in, the partitions assigned                                                                                                   |
| Brokers          | The brokers: id, host, rack, controller, reachable (and the KRaft quorum when allowed); partitions and leaders per broker; log size per broker                                                                                                            |
| Broker internals | Bytes in and out, messages in and requests per second, from your Prometheus endpoint (only when there is one, see below)                                                                                                                                  |

WatchLog keeps the 200 largest topics and the 100 groups that lag most, whatever the size
of the cluster. Partitions are summed per topic; only offline and under-replicated
partitions are listed one by one (the first 50).

### Broker internals

If your brokers already expose a Prometheus endpoint (the JMX exporter, Strimzi's or
Bitnami's), WatchLog finds it on its own on port 9404 (Strimzi), 5556 (Bitnami) or 7071,
at `/metrics`, and reads it into the **Broker internals** tab. Nothing else depends on
it, and WatchLog never asks you to install it.

## What WatchLog tells you

- **A consumer group lost its members** while its lag grows, and which member it lost:
  WatchLog remembers each group's members (their client id and the host they connected
  from), maps that address to a workload or container, and says how it ended: OOM-killed,
  crash-looping, exited, or gone. When the address is no longer known, the clients
  connected to the broker port in the last 24 hours that ended since stand in (seen by the
  agents' network flows), as for RabbitMQ.
- Offline partitions (no leader: nobody can write to or read from them), with the topic.
- Under-replicated partitions (an in-sync replica is missing), with the topic.
- A broker gone from the cluster.
- A group whose lag keeps growing although it has members (they're slower than the
  producers).

When a group stops consuming, **probable cause** follows the finding to the member it
lost and that member's own cause: "group audit is falling behind because its member
shop/audit is OOM-killed at its 64 MiB memory limit".

## Default alerts

Created when you start monitoring; the drawer's ticks decide which start on.

- Offline partitions for a minute (critical)
- Under-replicated partitions for 5 minutes (warning)
- A broker down for a minute (critical)
- A group's lag grows for 10 minutes (warning)
- A group lost its members while its lag grows, for 5 minutes (critical)
- The service unreachable, or slow to connect (every service has these)

Each can be changed, and reset to its default, in the rule editor.

## Ask your cluster (MCP)

`get_application` returns the Kafka service's brokers, partitions, groups with their lag
and state, and its findings with the member a group lost; `list_applications` lists it
with its health. Metrics such as `kafka.group.lag` can be read and used in rules like any
other.

## Not available

- **Bytes in and out, request latency, request handler idle time and ISR shrinks** are JMX
  metrics, outside the Kafka protocol. Without a Prometheus endpoint they aren't shown.
- **Messages in per second** is the growth of the end offsets, labelled "offsets/s":
  transaction markers and compaction make it approximate.
- **Lag in time** isn't in the protocol. WatchLog shows the lag divided by the topic's
  rate in, labelled "about".
- **ZooKeeper's own health** isn't read; on a ZooKeeper cluster WatchLog reads the
  brokers.
- **Redpanda** speaks the protocol and may work, but isn't tested.
