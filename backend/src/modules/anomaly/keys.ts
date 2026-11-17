// SPDX-License-Identifier: AGPL-3.0-only
// What changed's scored keys (ADR-196's as-built list, slice 1) and how a series is named:
// its key and its subject labels, hashed into one identity. Each key is read at a 60-second
// step through the catalog's own template (ADR-028); the service map's edges, which are not
// catalog keys, through fixed templates below with the map's own labels (ADR-139).
import { createHash } from 'node:crypto';
import { buildQuery, metricUnit, type MetricKey, type Unit } from '../query/catalog.js';

export type ClusterKind = 'kubernetes' | 'server';

/** The read's step and the rate window it implies (catalog.rateWindow(60) = 120 s). */
export const STEP_S = 60;

const BOTH_HTTP: MetricKey[] = [
  'workload.http.requests.rate',
  'workload.http.errors.ratio',
  'workload.http.latency.p95',
];

/** The resource keys of each platform, and the per-server HTTP keys of both. */
export const PLATFORM_KEYS: Record<ClusterKind, MetricKey[]> = {
  kubernetes: [
    'node.cpu.utilization',
    'node.memory.utilization',
    'node.network.bytes',
    'node.disk.io',
    'workload.cpu.usage',
    'workload.memory.working_set',
    ...BOTH_HTTP,
  ],
  server: [
    'host.cpu.utilization',
    'host.memory.utilization',
    'host.network.bytes',
    'host.disk.io',
    'container.cpu.usage',
    'container.memory.working_set',
    'container.network.bytes',
    // Services and process groups (ADR-208): CPU and memory, like containers'.
    'unit.cpu.usage',
    'unit.memory.working_set',
    'process.cpu.usage',
    'process.memory.rss',
    ...BOTH_HTTP,
  ],
};

/**
 * The integrations' behaviour keys (29): rates, ratios, latencies, connections, lag and
 * queue depth. No up/down, missing, alarm, certificate, size or XID key: their default
 * rules cover them as events, and they are flat (slice 1). By integration type, so a
 * cluster is asked only for the types it monitors.
 */
export const INTEGRATION_KEYS: Record<string, MetricKey[]> = {
  redis: ['redis.memory.used', 'redis.hit.ratio', 'redis.ops.rate', 'redis.connected_clients'],
  postgres: [
    'postgres.connections',
    'postgres.transactions.rate',
    'postgres.cache_hit.ratio',
    'postgres.replication.lag',
  ],
  mysql: [
    'mysql.connections',
    'mysql.queries.rate',
    'mysql.slow_queries.rate',
    'mysql.buffer_pool_hit.ratio',
    'mysql.replication.lag',
  ],
  mongodb: [
    'mongodb.ops.rate',
    'mongodb.connections',
    'mongodb.replication.lag',
    'mongodb.cache.ratio',
  ],
  kafka: ['kafka.messages_in.rate', 'kafka.group.lag'],
  rabbitmq: [
    'rabbitmq.messages.ready',
    'rabbitmq.messages.unacked',
    'rabbitmq.publish.rate',
    'rabbitmq.deliver.rate',
  ],
  nginx: ['nginx.requests.rate', 'nginx.5xx.ratio', 'nginx.latency.p95'],
  traefik: ['traefik.requests.rate', 'traefik.5xx.ratio', 'traefik.latency.p95'],
  'php-fpm': [
    'php-fpm.requests.rate',
    'php-fpm.processes.busy_ratio',
    'php-fpm.request.duration.p95',
  ],
};

/** The labels of a service-map edge (servicemap/graph.ts EDGE_LABELS). */
const EDGE = [
  'namespace',
  'workload_kind',
  'workload',
  'container',
  'compose_project',
  'compose_service',
  'dst_kind',
  'dst_namespace',
  'dst_workload_kind',
  'dst_workload',
  'dst_service',
  'dst',
  'dst_port',
].join(', ');
const RATE = `${2 * STEP_S}s`;

/**
 * The service map's edges between a source and a destination (ADR-196): connections a
 * second, HTTP requests a second and HTTP p95. Not catalog keys: the map reads them with
 * its own labels, and so does this. `connect.p95` is left out (flat, slice 1).
 */
export const EDGE_KEYS = {
  'edge.connections.rate': {
    unit: 'per_second' as Unit,
    expr: `sum by (${EDGE}) (rate(watchlog_flow_connections_total[${RATE}]))`,
  },
  'edge.http.requests.rate': {
    unit: 'per_second' as Unit,
    expr: `sum by (${EDGE}) (rate(watchlog_http_requests_total[${RATE}]))`,
  },
  'edge.http.latency.p95': {
    unit: 'seconds' as Unit,
    expr: `histogram_quantile(0.95, sum by (${EDGE}, le) (rate(watchlog_http_request_duration_seconds_bucket[${RATE}])))`,
  },
} as const;

export type ScoredKey = MetricKey | keyof typeof EDGE_KEYS;

export interface KeyQuery {
  key: ScoredKey;
  unit: Unit;
  expr: string;
}

/** Every key the worker may score, for both platforms (the tests' and the docs' list). */
export function allScoredKeys(): ScoredKey[] {
  return [
    ...new Set<ScoredKey>([
      ...PLATFORM_KEYS.kubernetes,
      ...PLATFORM_KEYS.server,
      ...Object.values(INTEGRATION_KEYS).flat(),
      ...(Object.keys(EDGE_KEYS) as ScoredKey[]),
    ]),
  ];
}

/**
 * The queries for one cluster: its platform's keys, the edges, and the keys of the
 * integration types it monitors only (slice 1: about 50 queries a second at 250 clusters
 * instead of 170).
 */
export function queriesFor(kind: ClusterKind, integrationTypes: Iterable<string>): KeyQuery[] {
  const out: KeyQuery[] = [];
  const types = new Set(integrationTypes);
  const catalog = [
    ...PLATFORM_KEYS[kind],
    ...Object.entries(INTEGRATION_KEYS)
      .filter(([t]) => types.has(t))
      .flatMap(([, keys]) => keys),
  ];
  for (const key of catalog) {
    const q = buildQuery(key, {}, STEP_S);
    out.push({ key, unit: q.unit, expr: q.expr });
  }
  for (const [key, e] of Object.entries(EDGE_KEYS)) {
    out.push({ key: key as ScoredKey, unit: e.unit, expr: e.expr });
  }
  return out;
}

/** The unit of a scored key. */
export function unitOf(key: string): Unit {
  if (key in EDGE_KEYS) return EDGE_KEYS[key as keyof typeof EDGE_KEYS].unit;
  return metricUnit(key) ?? 'count';
}

/** A series' subject: its labels in a fixed key order, without empty values. */
export function subjectOf(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(labels).sort()) {
    if (k === '__name__' || k === 'cluster_id' || !labels[k]) continue;
    out[k] = labels[k]!;
  }
  return out;
}

/** A series' identity: sha256 of its key and its subject (32 bytes). */
export function seriesHash(key: string, subject: Record<string, string>): Buffer {
  return createHash('sha256').update(key).update('\u0000').update(JSON.stringify(subject)).digest();
}
