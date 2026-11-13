// SPDX-License-Identifier: AGPL-3.0-only
import { nginxExpr, type NginxSource } from './nginx.js';
// Curated metrics for POST /query/range (ADR-028). Templates are fixed MetricsQL;
// user input only ever becomes escaped label values. cluster_id is enforced by
// VictoriaMetrics (extra_label), never by these templates.

export type Unit =
  'ratio' | 'bytes' | 'bytes_per_second' | 'cores' | 'load' | 'count' | 'seconds' | 'per_second';
export type Agg = 'sum' | 'avg' | 'max' | 'min';

export interface QueryScope {
  host?: string;
  container?: string;
  composeProject?: string;
  /** Kubernetes scope (ADR-062): node agents label host series with `node`. */
  node?: string;
  namespace?: string;
  /** Namespace filter of the top bar (any of these). */
  namespaces?: string[];
  pod?: string;
  workloadKind?: string;
  workload?: string;
  /** Exactly these pods (a resolved label selector, ADR-085). */
  pods?: string[];
  /** A monitored service (SPEC §4.12): the collector labels its series service=<id>. */
  service?: string;
  /** Every monitored service of a type: the collector labels them service_type=<type>. */
  serviceType?: string;
  /**
   * Nginx services whose numbers come from eBPF (resolved from the database by
   * resolveScope): their series carry the workload, not the service id.
   */
  nginx?: NginxSource[];
}

interface Entry {
  unit: Unit;
  /** Aggregation used when the request does not choose one. */
  agg: Agg;
  expr: (sel: (...extra: string[]) => string, rate: string, agg: Agg, scope: QueryScope) => string;
}

const ENTRIES = {
  'host.cpu.utilization': {
    unit: 'ratio',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (host) (rate(watchlog_node_cpu_seconds_total${s('mode!="idle"')}[${r}])) / ${a} by (host) (rate(watchlog_node_cpu_seconds_total${s()}[${r}]))`,
  },
  'host.memory.used': {
    unit: 'bytes',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (host) (watchlog_node_memory_bytes${s('state="total"')}) - ${a} by (host) (watchlog_node_memory_bytes${s('state="available"')})`,
  },
  'host.memory.utilization': {
    unit: 'ratio',
    agg: 'sum',
    expr: (s, _r, a) =>
      `1 - ${a} by (host) (watchlog_node_memory_bytes${s('state="available"')}) / ${a} by (host) (watchlog_node_memory_bytes${s('state="total"')})`,
  },
  'host.load1': {
    unit: 'load',
    agg: 'max',
    expr: (s, _r, a) => `${a} by (host) (watchlog_node_load1${s()})`,
  },
  'host.network.bytes': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) => `${a} by (host, dir) (rate(watchlog_node_network_bytes_total${s()}[${r}]))`,
  },
  'host.disk.io': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) => `${a} by (host, dir) (rate(watchlog_node_disk_io_bytes_total${s()}[${r}]))`,
  },
  'host.filesystem.utilization': {
    unit: 'ratio',
    agg: 'max',
    expr: (s, _r, a) =>
      `1 - ${a} by (host, mount) (watchlog_node_filesystem_bytes${s('state="avail"')}) / ${a} by (host, mount) (watchlog_node_filesystem_bytes${s('state="size"')})`,
  },
  'host.root_filesystem.utilization': {
    unit: 'ratio',
    agg: 'max',
    expr: (s, _r, a) =>
      `1 - ${a} by (host) (watchlog_node_filesystem_bytes${s('mount="/"', 'state="avail"')}) / ${a} by (host) (watchlog_node_filesystem_bytes${s('mount="/"', 'state="size"')})`,
  },
  'container.cpu.usage': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (host, container) (rate(watchlog_container_cpu_seconds_total${s()}[${r}]))`,
  },
  'container.cpu.throttled': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (host, container) (rate(watchlog_container_cpu_throttled_seconds_total${s()}[${r}]))`,
  },
  /**
   * The share of the time a container is throttled at its CPU limit: its throttled seconds a
   * second, at most 1 (ADR-154's share; the agent has no CFS period counter). The most
   * throttled one when several match.
   */
  'container.cpu.throttled_share': {
    unit: 'ratio',
    agg: 'max',
    expr: (s, r, a) =>
      `${a} by (host, container) (clamp_max(rate(watchlog_container_cpu_throttled_seconds_total${s()}[${r}]), 1))`,
  },
  'container.cpu.limit': {
    unit: 'cores',
    agg: 'max',
    expr: (s, _r, a) => `${a} by (host, container) (watchlog_container_cpu_limit_cores${s()})`,
  },
  'container.memory.working_set': {
    unit: 'bytes',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (host, container) (watchlog_container_memory_working_set_bytes${s()})`,
  },
  'container.memory.limit': {
    unit: 'bytes',
    agg: 'max',
    expr: (s, _r, a) => `${a} by (host, container) (watchlog_container_memory_limit_bytes${s()})`,
  },
  'container.network.bytes': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (host, container, dir) (rate(watchlog_container_network_bytes_total${s()}[${r}]))`,
  },
  'container.fs.io': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (host, container, dir) (rate(watchlog_container_fs_io_bytes_total${s()}[${r}]))`,
  },
  'container.restarts': {
    unit: 'count',
    agg: 'max',
    expr: (s, _r, a) => `${a} by (host, container) (watchlog_container_restarts_total${s()})`,
  },
  /** OOM kills (Docker's oom events) since the container started: a counter. */
  'container.oom_kills': {
    unit: 'count',
    agg: 'max',
    expr: (s, _r, a) => `${a} by (host, container) (watchlog_container_oom_events_total${s()})`,
  },
  /**
   * DNS lookups answered NXDOMAIN, per second, by the client that looked up (eBPF, ADR-113;
   * search-path misses are counted apart and left out): when a name stopped resolving.
   */
  'dns.nxdomain.rate': {
    unit: 'per_second',
    agg: 'sum',
    expr: (s, r) =>
      `sum by (namespace, workload_kind, workload, host, container, compose_project, compose_service) (rate(watchlog_dns_requests_total${s('rcode="NXDOMAIN"')}[${r}]))`,
  },
  /** Restarts within the last 10 minutes (the Docker restart rule, ADR-072). */
  'container.restarts.increase': {
    unit: 'count',
    agg: 'max',
    expr: (s, _r, a) =>
      `${a} by (host, container) (increase(watchlog_container_restarts_total${s()}[10m]))`,
  },
  // Kubernetes nodes: the node agent's host series carry `node` instead of `host`.
  'node.cpu.usage': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (node) (rate(watchlog_node_cpu_seconds_total${s('mode!="idle"')}[${r}]))`,
  },
  'node.cpu.utilization': {
    unit: 'ratio',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (node) (rate(watchlog_node_cpu_seconds_total${s('mode!="idle"')}[${r}])) / ${a} by (node) (rate(watchlog_node_cpu_seconds_total${s()}[${r}]))`,
  },
  'node.memory.used': {
    unit: 'bytes',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (node) (watchlog_node_memory_bytes${s('state="total"')}) - ${a} by (node) (watchlog_node_memory_bytes${s('state="available"')})`,
  },
  'node.memory.utilization': {
    unit: 'ratio',
    agg: 'sum',
    expr: (s, _r, a) =>
      `1 - ${a} by (node) (watchlog_node_memory_bytes${s('state="available"')}) / ${a} by (node) (watchlog_node_memory_bytes${s('state="total"')})`,
  },
  'node.load1': {
    unit: 'load',
    agg: 'max',
    expr: (s, _r, a) => `${a} by (node) (watchlog_node_load1${s()})`,
  },
  'node.network.bytes': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) => `${a} by (node, dir) (rate(watchlog_node_network_bytes_total${s()}[${r}]))`,
  },
  'node.disk.io': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) => `${a} by (node, dir) (rate(watchlog_node_disk_io_bytes_total${s()}[${r}]))`,
  },
  'node.filesystem.utilization': {
    unit: 'ratio',
    agg: 'max',
    expr: (s, _r, a) =>
      `1 - ${a} by (node, mount) (watchlog_node_filesystem_bytes${s('state="avail"')}) / ${a} by (node, mount) (watchlog_node_filesystem_bytes${s('state="size"')})`,
  },
  'node.root_filesystem.utilization': {
    unit: 'ratio',
    agg: 'max',
    expr: (s, _r, a) =>
      `1 - ${a} by (node) (watchlog_node_filesystem_bytes${s('mount="/"', 'state="avail"')}) / ${a} by (node) (watchlog_node_filesystem_bytes${s('mount="/"', 'state="size"')})`,
  },
  /**
   * 1 while a node condition is True, 0 otherwise. Only the current status has a
   * series (measured on kind: DiskPressure has status="false" only), so the other
   * statuses count as 0.
   */
  'node.condition': {
    unit: 'count',
    agg: 'max',
    expr: (s, _r, a) =>
      `${a} by (node, condition) (watchlog_kube_node_condition${s('status="true"')} or watchlog_kube_node_condition${s('status!="true"')} * 0)`,
  },
  // Kubernetes pods and their containers (container names are unique per pod only).
  'pod.cpu.usage': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace, pod) (rate(watchlog_container_cpu_seconds_total${s('pod!=""')}[${r}]))`,
  },
  'pod.memory.working_set': {
    unit: 'bytes',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (namespace, pod) (watchlog_container_memory_working_set_bytes${s('pod!=""')})`,
  },
  'pod.network.bytes': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace, pod, dir) (rate(watchlog_pod_network_bytes_total${s()}[${r}]))`,
  },
  'pod.restarts': {
    unit: 'count',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (namespace, pod) (watchlog_kube_pod_container_restarts_total${s()})`,
  },
  'pod.container.cpu.usage': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace, pod, container) (rate(watchlog_container_cpu_seconds_total${s('pod!=""')}[${r}]))`,
  },
  'pod.container.cpu.throttled': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace, pod, container) (rate(watchlog_container_cpu_throttled_seconds_total${s('pod!=""')}[${r}]))`,
  },
  'pod.container.cpu.limit': {
    unit: 'cores',
    agg: 'max',
    expr: (s, _r, a) =>
      `${a} by (namespace, pod, container) (watchlog_container_cpu_limit_cores${s('pod!=""')})`,
  },
  'pod.container.memory.working_set': {
    unit: 'bytes',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (namespace, pod, container) (watchlog_container_memory_working_set_bytes${s('pod!=""')})`,
  },
  'pod.container.memory.limit': {
    unit: 'bytes',
    agg: 'max',
    expr: (s, _r, a) =>
      `${a} by (namespace, pod, container) (watchlog_container_memory_limit_bytes${s('pod!=""')})`,
  },
  'pod.container.fs.io': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace, pod, container, dir) (rate(watchlog_container_fs_io_bytes_total${s('pod!=""')}[${r}]))`,
  },
  /**
   * Throttled CPU time per CPU time used (ADR-072). Not a share of the time: a near-idle
   * container throttled for a moment reads several times 1. The default rule reads
   * workload.container.cpu.throttled_share instead (ADR-160); kept for custom rules.
   */
  'workload.container.cpu.throttling': {
    unit: 'ratio',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace, workload_kind, workload, container) (rate(watchlog_container_cpu_throttled_seconds_total${s('pod!=""')}[${r}])) / ${a} by (namespace, workload_kind, workload, container) (rate(watchlog_container_cpu_seconds_total${s('pod!=""')}[${r}]))`,
  },
  /**
   * The share of the time a workload container is throttled at its CPU limit: throttled
   * seconds a second, at most 1, of its most throttled pod (ADR-154, ADR-160).
   */
  'workload.container.cpu.throttled_share': {
    unit: 'ratio',
    agg: 'max',
    expr: (s, r, a) =>
      `${a} by (namespace, workload_kind, workload, container) (clamp_max(rate(watchlog_container_cpu_throttled_seconds_total${s('pod!=""')}[${r}]), 1))`,
  },
  'workload.cpu.usage': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace, workload_kind, workload) (rate(watchlog_container_cpu_seconds_total${s('pod!=""')}[${r}]))`,
  },
  'workload.memory.working_set': {
    unit: 'bytes',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (namespace, workload_kind, workload) (watchlog_container_memory_working_set_bytes${s('pod!=""')})`,
  },
  'namespace.cpu.usage': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace) (rate(watchlog_container_cpu_seconds_total${s('pod!=""')}[${r}]))`,
  },
  'namespace.memory.working_set': {
    unit: 'bytes',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (namespace) (watchlog_container_memory_working_set_bytes${s('pod!=""')})`,
  },
  'pvc.utilization': {
    unit: 'ratio',
    agg: 'max',
    expr: (s, _r, a) =>
      `${a} by (namespace, persistentvolumeclaim) (watchlog_pod_volume_bytes${s('state="used"')}) / ${a} by (namespace, persistentvolumeclaim) (watchlog_pod_volume_bytes${s('state="capacity"')})`,
  },
  /**
   * Share of TCP connections that failed, per source and destination (Phase 4,
   * ADR-102). Only edges with at least 3 connections a minute count, so one refused
   * connection on an idle edge is not 100 %.
   */
  'flow.failed.ratio': {
    unit: 'ratio',
    agg: 'sum',
    expr: (s, r) => {
      const by =
        'namespace, workload_kind, workload, container, dst_kind, dst_namespace, dst_workload_kind, dst_workload, dst_service, dst';
      // A share is at most 1: the two counters are scraped apart, so the failed rate can
      // come out a little above the total (an alert read "102% of connections failed").
      return `clamp_max(sum by (${by}) (rate(watchlog_flow_connect_failed_total${s()}[${r}])) / (sum by (${by}) (rate(watchlog_flow_connections_total${s()}[${r}])) > 0.05), 1)`;
    },
  },
  /**
   * Monitored services (v0.3, SPEC §4.12), on Kubernetes and Docker alike: the share of a
   * service's members its collector reaches, and how long it takes to connect. Each
   * integration adds its own keys (redis.*, postgres.*) as it lands.
   */
  'service.reachable.ratio': {
    unit: 'ratio',
    agg: 'avg',
    expr: (s) =>
      `sum by (service, service_type) (watchlog_integration_up${s()}) / count by (service, service_type) (watchlog_integration_up${s()})`,
  },
  'service.connect.time': {
    unit: 'seconds',
    agg: 'max',
    expr: (s, _r, a) =>
      `${a} by (service, service_type) (watchlog_integration_connect_seconds${s()})`,
  },
  // Redis (v0.3 slice 7, SPEC §4.12): per member where a member can differ.
  'redis.memory.used': {
    unit: 'bytes',
    agg: 'max',
    expr: (s, _r, a) =>
      `${a} by (service, service_type, member) (watchlog_redis_memory_used_bytes${s()})`,
  },
  'redis.memory.ratio': {
    unit: 'ratio',
    agg: 'max',
    expr: (s) =>
      `max by (service, service_type, member) (watchlog_redis_memory_used_bytes${s()}) / (max by (service, service_type, member) (watchlog_redis_memory_max_bytes${s()}) > 0)`,
  },
  'redis.hit.ratio': {
    unit: 'ratio',
    agg: 'avg',
    expr: (s, r) =>
      `sum by (service, service_type) (rate(watchlog_redis_keyspace_hits_total${s()}[${r}])) / (sum by (service, service_type) (rate(watchlog_redis_keyspace_hits_total${s()}[${r}])) + sum by (service, service_type) (rate(watchlog_redis_keyspace_misses_total${s()}[${r}])) > 0)`,
  },
  'redis.ops.rate': {
    unit: 'per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (service, service_type) (rate(watchlog_redis_commands_processed_total${s()}[${r}]))`,
  },
  'redis.evicted.rate': {
    unit: 'per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (service, service_type) (rate(watchlog_redis_evicted_keys_total${s()}[${r}]))`,
  },
  'redis.connected_clients': {
    unit: 'count',
    agg: 'sum',
    expr: (s, _r, a) => `${a} by (service, service_type) (watchlog_redis_connected_clients${s()})`,
  },
  'redis.blocked_clients': {
    unit: 'count',
    agg: 'sum',
    expr: (s, _r, a) => `${a} by (service, service_type) (watchlog_redis_blocked_clients${s()})`,
  },
  /** 1 when a replica's link to its primary is down, or a primary sees a replica offline. */
  'redis.replica.down': {
    unit: 'count',
    agg: 'max',
    expr: (s) =>
      `max by (service, service_type) ((1 - watchlog_redis_master_link_up${s()}) or (1 - watchlog_redis_replica_online${s()}))`,
  },
  /** 1 when the last RDB save or AOF write failed. */
  'redis.save.failed': {
    unit: 'count',
    agg: 'max',
    expr: (s) =>
      `max by (service, service_type) ((1 - watchlog_redis_rdb_last_save_ok${s()}) or (1 - watchlog_redis_aof_last_write_ok${s()}))`,
  },
  // PostgreSQL (v0.3 slice 8, SPEC §4.12).
  'postgres.connections': {
    unit: 'count',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (service, service_type, member) (watchlog_postgres_backends${s('db=""')})`,
  },
  'postgres.connections.ratio': {
    unit: 'ratio',
    agg: 'max',
    expr: (s) =>
      `sum by (service, service_type, member) (watchlog_postgres_backends${s('db=""')}) / on (service, service_type, member) (max by (service, service_type, member) (watchlog_postgres_setting${s('name="max_connections"')}) > 0)`,
  },
  'postgres.transactions.rate': {
    unit: 'per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (service, service_type) (rate(watchlog_postgres_xact_commit_total${s()}[${r}]) + rate(watchlog_postgres_xact_rollback_total${s()}[${r}]))`,
  },
  'postgres.cache_hit.ratio': {
    unit: 'ratio',
    agg: 'avg',
    expr: (s, r) =>
      `sum by (service, service_type) (rate(watchlog_postgres_blks_hit_total${s()}[${r}])) / (sum by (service, service_type) (rate(watchlog_postgres_blks_hit_total${s()}[${r}])) + sum by (service, service_type) (rate(watchlog_postgres_blks_read_total${s()}[${r}])) > 0)`,
  },
  /** The longest-running active query of client backends (not autovacuum or walsenders). */
  'postgres.query.longest': {
    unit: 'seconds',
    agg: 'max',
    expr: (s) =>
      `max by (service, service_type, member) (watchlog_postgres_backend_max_seconds${s('kind="active"')})`,
  },
  'postgres.idle_in_transaction.longest': {
    unit: 'seconds',
    agg: 'max',
    expr: (s) =>
      `max by (service, service_type, member) (watchlog_postgres_backend_max_seconds${s('kind="idle_in_transaction"')})`,
  },
  /** A primary's replicas' replay lag, or a replica's own. */
  'postgres.replication.lag': {
    unit: 'seconds',
    agg: 'max',
    expr: (s) =>
      `max by (service, service_type) (watchlog_postgres_replica_lag_seconds${s()} or watchlog_postgres_replay_lag_seconds${s()})`,
  },
  'postgres.xid.age': {
    unit: 'count',
    agg: 'max',
    expr: (s) => `max by (service, service_type, db) (watchlog_postgres_xid_age${s()})`,
  },
  'postgres.deadlocks.rate': {
    unit: 'per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (service, service_type) (rate(watchlog_postgres_deadlocks_total${s()}[${r}]))`,
  },
  'postgres.database.size': {
    unit: 'bytes',
    agg: 'max',
    expr: (s, _r, a) =>
      `${a} by (service, service_type, db) (watchlog_postgres_database_size_bytes${s()})`,
  },
  'postgres.lock_waits': {
    unit: 'count',
    agg: 'max',
    expr: (s, _r, a) => `${a} by (service, service_type) (watchlog_postgres_lock_waits${s()})`,
  },
  // MySQL and MariaDB (v0.5 slice 1, ADR-163): status variables and the process list, per
  // member where a member can differ.
  'mysql.connections': {
    unit: 'count',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (service, service_type, member) (watchlog_mysql_threads_connected${s()})`,
  },
  'mysql.connections.ratio': {
    unit: 'ratio',
    agg: 'max',
    expr: (s) =>
      `max by (service, service_type, member) (watchlog_mysql_threads_connected${s()}) / on (service, service_type, member) (max by (service, service_type, member) (watchlog_mysql_setting${s('name="max_connections"')}) > 0)`,
  },
  'mysql.queries.rate': {
    unit: 'per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (service, service_type) (rate(watchlog_mysql_questions_total${s()}[${r}]))`,
  },
  'mysql.slow_queries.rate': {
    unit: 'per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (service, service_type) (rate(watchlog_mysql_slow_queries_total${s()}[${r}]))`,
  },
  'mysql.buffer_pool_hit.ratio': {
    unit: 'ratio',
    agg: 'avg',
    expr: (s, r) =>
      `1 - sum by (service, service_type) (rate(watchlog_mysql_buffer_pool_reads_total${s()}[${r}])) / (sum by (service, service_type) (rate(watchlog_mysql_buffer_pool_read_requests_total${s()}[${r}])) > 0)`,
  },
  /** The longest running statement of a client session (not replication threads). */
  'mysql.query.longest': {
    unit: 'seconds',
    agg: 'max',
    expr: (s) =>
      `max by (service, service_type, member) (watchlog_mysql_longest_query_seconds${s()})`,
  },
  'mysql.replication.lag': {
    unit: 'seconds',
    agg: 'max',
    expr: (s) =>
      `max by (service, service_type, member) (watchlog_mysql_replica_lag_seconds${s()})`,
  },
  /** 1 on a replica whose IO or SQL thread isn't running. */
  'mysql.replication.stopped': {
    unit: 'count',
    agg: 'max',
    expr: (s) =>
      `max by (service, service_type, member) (1 - min by (service, service_type, member) (watchlog_mysql_replica_running${s()}))`,
  },
  'mysql.deadlocks.rate': {
    unit: 'per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (service, service_type) (rate(watchlog_mysql_deadlocks_total${s()}[${r}]))`,
  },
  'mysql.lock_waits': {
    unit: 'count',
    agg: 'max',
    expr: (s, _r, a) =>
      `${a} by (service, service_type) (watchlog_mysql_row_lock_current_waits${s()})`,
  },
  // MongoDB (v0.5 slice 2, ADR-164): serverStatus per member; replica set members as each
  // member sees them (the worst view per member name).
  'mongodb.ops.rate': {
    unit: 'per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (service, service_type) (rate(watchlog_mongodb_ops_total${s()}[${r}]))`,
  },
  'mongodb.connections': {
    unit: 'count',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (service, service_type, member) (watchlog_mongodb_connections${s('state="current"')})`,
  },
  'mongodb.connections.ratio': {
    unit: 'ratio',
    agg: 'max',
    expr: (s) =>
      `max by (service, service_type, member) (watchlog_mongodb_connections${s('state="current"')}) / on (service, service_type, member) ((max by (service, service_type, member) (watchlog_mongodb_connections${s('state="current"')}) + max by (service, service_type, member) (watchlog_mongodb_connections${s('state="available"')})) > 0)`,
  },
  /** 1 while no member of a replica set is primary, as any reachable member sees it. */
  'mongodb.primary.missing': {
    unit: 'count',
    agg: 'max',
    expr: (s) => `1 - max by (service, service_type) (watchlog_mongodb_primary_seen${s()})`,
  },
  /** Members a reachable member sees as unhealthy. */
  'mongodb.members.down': {
    unit: 'count',
    agg: 'max',
    expr: (s) =>
      `count by (service, service_type) (max by (service, service_type, rs_member) (1 - watchlog_mongodb_member_health${s()}) > 0) or max by (service, service_type) (watchlog_mongodb_replica_set${s()}) * 0`,
  },
  'mongodb.replication.lag': {
    unit: 'seconds',
    agg: 'max',
    expr: (s) =>
      `max by (service, service_type, rs_member) (watchlog_mongodb_replication_lag_seconds${s()})`,
  },
  /** "Slow query" log lines a minute (unit count: per minute), as the collector counts them. */
  'mongodb.slow_ops.rate': {
    unit: 'count',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (service, service_type) (rate(watchlog_mongodb_slow_ops_total${s()}[${r}])) * 60`,
  },
  /**
   * The oplog's window, once the oplog is full (over 90 % of its size): before that, the
   * window is only how long the set has been running.
   */
  'mongodb.oplog.window': {
    unit: 'seconds',
    agg: 'min',
    expr: (s) =>
      `min by (service, service_type, member) (watchlog_mongodb_oplog_window_seconds${s()}) and on (service, service_type, member) (max by (service, service_type, member) (watchlog_mongodb_oplog_bytes${s('state="used"')}) / on (service, service_type, member) (max by (service, service_type, member) (watchlog_mongodb_oplog_bytes${s('state="max"')}) > 0) > 0.9)`,
  },
  'mongodb.cache.ratio': {
    unit: 'ratio',
    agg: 'max',
    expr: (s) =>
      `max by (service, service_type, member) (watchlog_mongodb_cache_bytes${s('state="used"')}) / on (service, service_type, member) (max by (service, service_type, member) (watchlog_mongodb_cache_bytes${s('state="max"')}) > 0)`,
  },
  // RabbitMQ (v0.3 slice 11): the rabbitmq_prometheus series of every node.
  'rabbitmq.messages.ready': {
    unit: 'count',
    agg: 'sum',
    expr: (s, _r, a) => `${a} by (service, service_type) (rabbitmq_queue_messages_ready${s()})`,
  },
  'rabbitmq.messages.unacked': {
    unit: 'count',
    agg: 'sum',
    expr: (s, _r, a) => `${a} by (service, service_type) (rabbitmq_queue_messages_unacked${s()})`,
  },
  'rabbitmq.publish.rate': {
    unit: 'per_second',
    agg: 'sum',
    expr: (s, r) =>
      `sum by (service, service_type) (rate(rabbitmq_global_messages_received_total${s()}[${r}]))`,
  },
  'rabbitmq.deliver.rate': {
    unit: 'per_second',
    agg: 'sum',
    expr: (s, r) =>
      `sum by (service, service_type) (rate(rabbitmq_global_messages_delivered_total${s()}[${r}]))`,
  },
  'rabbitmq.consumers': {
    unit: 'count',
    agg: 'sum',
    expr: (s, _r, a) => `${a} by (service, service_type) (rabbitmq_consumers${s()})`,
  },
  'rabbitmq.memory.ratio': {
    unit: 'ratio',
    agg: 'max',
    expr: (s) =>
      `max by (service, service_type, member) (rabbitmq_process_resident_memory_bytes${s()}) / (max by (service, service_type, member) (rabbitmq_resident_memory_limit_bytes${s()}) > 0)`,
  },
  /** A node in a memory or disk alarm: publishers are blocked. */
  'rabbitmq.alarms': {
    unit: 'count',
    agg: 'max',
    expr: (s) =>
      `max by (service, service_type, member) (rabbitmq_alarms_memory_used_watermark${s()}) + max by (service, service_type, member) (rabbitmq_alarms_free_disk_space_watermark${s()})`,
  },
  /** Ready messages of each queue with no consumer that keeps growing (5 min). */
  'rabbitmq.queue.unconsumed': {
    unit: 'count',
    agg: 'max',
    expr: (s) => {
      const by = 'service, service_type, vhost, queue';
      return `(sum by (${by}) (rabbitmq_detailed_queue_messages_ready${s()}) > 0) and (sum by (${by}) (rabbitmq_detailed_queue_consumers${s()}) == 0) and (sum by (${by}) (deriv(rabbitmq_detailed_queue_messages_ready${s()}[5m])) > 0)`;
    },
  },
  /** Messages dead-lettered per second (3.12+). */
  'rabbitmq.dead_lettered.rate': {
    unit: 'per_second',
    agg: 'sum',
    expr: (s, r) => {
      const m = s().slice(1, -1);
      return `sum by (service, service_type) (rate({__name__=~"rabbitmq_global_messages_dead_lettered_.*_total"${m ? `,${m}` : ''}}[${r}]))`;
    },
  },
  // Nginx (v0.3 slice 10): ingress-nginx's own series, or eBPF for the others (nginx.ts).
  'nginx.requests.rate': {
    unit: 'per_second',
    agg: 'sum',
    expr: (s, r, _a, scope) => nginxExpr('requests', scope.nginx ?? [], s, r),
  },
  'nginx.5xx.ratio': {
    unit: 'ratio',
    agg: 'max',
    expr: (s, r, _a, scope) => nginxExpr('5xx_ratio', scope.nginx ?? [], s, r),
  },
  'nginx.latency.p95': {
    unit: 'seconds',
    agg: 'max',
    expr: (s, r, _a, scope) => nginxExpr('p95', scope.nginx ?? [], s, r),
  },
  /** Upstreams with no ready endpoint (ingress-nginx), or every connection failing. */
  'nginx.upstream.down': {
    unit: 'count',
    agg: 'max',
    expr: (s, r, _a, scope) => nginxExpr('upstream_down', scope.nginx ?? [], s, r),
  },
  /** Seconds until a certificate ingress-nginx serves expires. */
  'nginx.certificate.expiry': {
    unit: 'seconds',
    agg: 'min',
    expr: (s, r, _a, scope) => nginxExpr('cert_expiry', scope.nginx ?? [], s, r),
  },
} satisfies Record<string, Entry>;

export type MetricKey = keyof typeof ENTRIES;
export const METRIC_KEYS = Object.keys(ENTRIES) as MetricKey[];

export function metricUnit(key: string): Unit | null {
  return key in ENTRIES ? (ENTRIES as Record<string, Entry>)[key]!.unit : null;
}

/** Escapes a value for a double-quoted MetricsQL label matcher. */
export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** A regex alternation matching exactly these values (metacharacters escaped). */
export function anyOf(values: string[]): string {
  return values.map((v) => escapeLabelValue(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('|');
}

function matchers(scope: QueryScope): string[] {
  const out: string[] = [];
  if (scope.host !== undefined) out.push(`host="${escapeLabelValue(scope.host)}"`);
  if (scope.container !== undefined) out.push(`container="${escapeLabelValue(scope.container)}"`);
  if (scope.composeProject !== undefined) {
    out.push(`compose_project="${escapeLabelValue(scope.composeProject)}"`);
  }
  const k8s: [keyof QueryScope, string][] = [
    ['node', 'node'],
    ['namespace', 'namespace'],
    ['pod', 'pod'],
    ['workloadKind', 'workload_kind'],
    ['workload', 'workload'],
  ];
  for (const [key, label] of k8s) {
    const v = scope[key];
    if (typeof v === 'string') out.push(`${label}="${escapeLabelValue(v)}"`);
  }
  if (scope.namespaces?.length) out.push(`namespace=~"${anyOf(scope.namespaces)}"`);
  if (scope.pods?.length) out.push(`pod=~"${anyOf(scope.pods)}"`);
  if (scope.service !== undefined) out.push(`service="${escapeLabelValue(scope.service)}"`);
  if (scope.serviceType !== undefined) {
    out.push(`service_type="${escapeLabelValue(scope.serviceType)}"`);
  }
  return out;
}

/** A series selector with the scope's matchers, for fixed expressions outside the catalog. */
export function selector(scope: QueryScope, ...extra: string[]): string {
  return `{${[...extra, ...matchers(scope)].join(',')}}`;
}

export const MIN_STEP_S = 15;
export const MAX_POINTS = 1000;

/** Step in seconds: at least 15 s and at most ~1,000 points, a multiple of 15 s. */
export function chooseStep(rangeS: number, requested?: number): number {
  const needed = Math.ceil(rangeS / MAX_POINTS);
  const step = Math.max(MIN_STEP_S, requested ?? 0, needed);
  return Math.ceil(step / MIN_STEP_S) * MIN_STEP_S;
}

/** Rate window: at least four 15 s scrapes, and at least two steps. */
export function rateWindow(step: number): string {
  return `${Math.max(60, 2 * step)}s`;
}

export interface BuiltQuery {
  expr: string;
  unit: Unit;
}

export function buildQuery(
  metric: MetricKey,
  scope: QueryScope,
  step: number,
  agg?: Agg,
): BuiltQuery {
  const entry: Entry = ENTRIES[metric];
  const base = matchers(scope);
  const sel = (...extra: string[]) => `{${[...extra, ...base].join(',')}}`;
  return { expr: entry.expr(sel, rateWindow(step), agg ?? entry.agg, scope), unit: entry.unit };
}
