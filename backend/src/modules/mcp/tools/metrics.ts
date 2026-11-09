// SPDX-License-Identifier: AGPL-3.0-only
// query_metric (ADR-128): one catalog metric over at most 24 hours, as statistics by
// default. Catalog keys only, never raw MetricsQL; the API's caps apply too (ADR-028).
import { Type } from 'typebox';
import { METRIC_KEYS, MIN_STEP_S } from '../../query/catalog.js';
import { clusterField, resolveCluster } from '../clusters.js';
import { labels, ToolError } from '../output.js';
import { ClusterArg, defineTool, describe, round, summary } from './common.js';

const MAX_SERIES = 10;
const MAX_POINTS = 60;
const MAX_MINUTES = 24 * 60;

const DOCKER_PREFIXES = [
  'host.',
  'container.',
  'flow.',
  'service.',
  'redis.',
  'postgres.',
  'nginx.',
];
const KUBERNETES_PREFIXES = [
  'node.',
  'pod.',
  'workload.',
  'namespace.',
  'pvc.',
  'flow.',
  'service.',
  // Monitored services are both kinds' (ADR-124).
  'redis.',
  'postgres.',
  'nginx.',
];

const ScopeValue = (what: string) =>
  Type.Optional(Type.String({ minLength: 1, maxLength: 253, description: what }));

interface RangeAnswer {
  metric: string;
  unit: string;
  step: number;
  series: { labels: Record<string, string>; points: [number, number | null][] }[];
}

export const queryMetricTool = defineTool({
  name: 'query_metric',
  title: 'Query a metric',
  description: describe(
    "One metric from WatchLog's catalog over the last `minutes` (60 by default, at most 24 hours), as statistics per series: min, max, avg and last, with the unit. Pass `points: true` for the values over time (at most 60 per series).",
    'Kubernetes metrics: node.* (cpu.usage, cpu.utilization, memory.used, memory.utilization, load1, network.bytes, disk.io, filesystem.utilization, condition), pod.* (cpu.usage, memory.working_set, network.bytes, restarts, and per container), workload.* (cpu.usage, memory.working_set, container.cpu.throttling), namespace.* and pvc.utilization. Docker metrics: host.* (cpu.utilization, memory.used, memory.utilization, load1, network.bytes, disk.io, filesystem.utilization) and container.* (cpu.usage, cpu.throttled, memory.working_set, memory.limit, network.bytes, fs.io, restarts). Both: flow.failed.ratio, and for monitored services (list_applications) service.reachable.ratio (share of its pods or containers the collector reaches) and service.connect.time; for Redis, redis.* (memory.used, memory.ratio, hit.ratio, ops.rate, evicted.rate, connected_clients, blocked_clients, replica.down, save.failed); for PostgreSQL, postgres.* (connections, connections.ratio, transactions.rate, cache_hit.ratio, query.longest, idle_in_transaction.longest, replication.lag, xid.age, deadlocks.rate, database.size, lock_waits); for Nginx, nginx.* (requests.rate, 5xx.ratio, latency.p95, upstream.down, certificate.expiry: from the ingress-nginx metrics, else from eBPF).',
    `Narrow with \`scope\`: namespace, workload and workloadKind, pod or node on Kubernetes; host, container or composeProject on Docker; service (its id from list_applications) for service.* metrics. At most ${MAX_SERIES} series, the highest first; the result says when there were more.`,
    'Example question: "How much memory did the api containers use over the last 6 hours?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      metric: Type.Union(
        METRIC_KEYS.map((k) => Type.Literal(k)),
        { description: 'A metric key from the catalog, e.g. pod.memory.working_set.' },
      ),
      scope: Type.Optional(
        Type.Object(
          {
            namespace: ScopeValue('Kubernetes namespace.'),
            workload: ScopeValue('Kubernetes workload name.'),
            workloadKind: ScopeValue('Kubernetes workload kind, e.g. Deployment.'),
            pod: ScopeValue('Kubernetes pod name.'),
            node: ScopeValue('Kubernetes node name.'),
            host: ScopeValue('Docker host name.'),
            container: ScopeValue('Docker container name.'),
            composeProject: ScopeValue('Docker Compose project.'),
            service: Type.Optional(
              Type.String({
                format: 'uuid',
                description: 'A monitored service id, from list_applications.',
              }),
            ),
          },
          { additionalProperties: false },
        ),
      ),
      minutes: Type.Optional(
        Type.Integer({
          minimum: 5,
          maximum: MAX_MINUTES,
          description: `How far back, in minutes (default 60, at most ${MAX_MINUTES}).`,
        }),
      ),
      points: Type.Optional(
        Type.Boolean({
          description: `Also return the values over time, at most ${MAX_POINTS} per series.`,
        }),
      ),
      agg: Type.Optional(
        Type.Union(
          [Type.Literal('sum'), Type.Literal('avg'), Type.Literal('max'), Type.Literal('min')],
          {
            description: "How series are combined; the catalog's default when left out.",
          },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  summarize: (a) =>
    summary(
      a.cluster,
      a.metric,
      ...Object.entries(a.scope ?? {}).map(([, v]) => v as string),
      `${a.minutes ?? 60} min`,
    ),
  async run(args, { api }) {
    const cluster = await resolveCluster(api, args.cluster);
    const allowed = cluster.kind === 'docker' ? DOCKER_PREFIXES : KUBERNETES_PREFIXES;
    const metric = args.metric as string;
    if (!allowed.some((p) => metric.startsWith(p))) {
      throw new ToolError(
        cluster.kind === 'docker'
          ? 'This metric is for Kubernetes clusters; this cluster is a Docker fleet.'
          : 'This metric is for Docker fleets; this cluster is Kubernetes.',
        `Use a metric starting with ${allowed.join(', ')}`,
        { metric },
      );
    }
    const minutes = args.minutes ?? 60;
    const to = Math.floor(Date.now() / 1000);
    const from = to - minutes * 60;
    const step = Math.max(
      MIN_STEP_S,
      Math.ceil((minutes * 60) / MAX_POINTS / MIN_STEP_S) * MIN_STEP_S,
    );
    const res = await api.post<RangeAnswer>('/query/range', {
      clusterId: cluster.id,
      metric,
      ...(args.scope ? { scope: args.scope } : {}),
      ...(args.agg ? { agg: args.agg } : {}),
      from,
      to,
      step,
    });
    const series = res.series
      .map((s) => {
        const values = s.points.map((p) => p[1]).filter((v): v is number => v !== null);
        const last = [...s.points].reverse().find((p) => p[1] !== null);
        return {
          labels: labels(s.labels),
          min: values.length ? round(Math.min(...values)) : null,
          max: values.length ? round(Math.max(...values)) : null,
          avg: values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null,
          last: last ? round(last[1]) : null,
          lastAt: last ? new Date(last[0] * 1000).toISOString() : null,
          ...(args.points
            ? { points: s.points.slice(-MAX_POINTS).map(([t, v]) => [t, round(v)]) }
            : {}),
        };
      })
      .sort((a, b) => (b.max ?? -Infinity) - (a.max ?? -Infinity));
    return {
      body: {
        cluster: clusterField(cluster),
        metric: res.metric,
        unit: res.unit,
        stepSeconds: res.step,
        minutes,
        ...(series.length === 0 ? { note: 'No data for this metric and scope in this time.' } : {}),
      },
      list: {
        key: 'series',
        items: series.slice(0, MAX_SERIES),
        total: series.length,
        noun: 'series',
        narrow: 'Pass a narrower `scope`, or `agg` to combine them.',
      },
    };
  },
});
