// SPDX-License-Identifier: AGPL-3.0-only
// Metric default rules (ADR-072): a query catalog expression as an instant query,
// isolated by extra_label=cluster_id, compared with the rule's thresholds.
import { buildQuery, type MetricKey, type QueryScope } from '../query/catalog.js';
import type { Condition, DefaultRule } from './defaults.js';
import type { ClusterKind, EvalContext, RuleEvaluator } from './engine.js';
import type { Observation, Severity } from './state-machine.js';
import { authorisedScope } from '../../lib/victoria.js';

/** Instant queries use a 60 s step: rates over 2 minutes (rateWindow). */
const STEP_S = 60;

interface MetricSpec {
  /** The catalog key per cluster kind (host equivalents for Docker). */
  metric: Partial<Record<ClusterKind, MetricKey>>;
  /** Fingerprint and labels of one result series; null skips it. */
  scope(
    series: Record<string, string>,
  ): { fingerprint: string; labels: Record<string, string> } | null;
  summary(value: number, labels: Record<string, string>): string;
  /** A usage ratio whose linear trend says when it is full (disk, PVC). */
  trend?: boolean;
}

export function validCondition(c: unknown): c is Condition {
  const v = c as Condition;
  return (
    !!v &&
    (v.op === '>' || v.op === '<') &&
    Number.isFinite(v.value) &&
    (v.critical === undefined || Number.isFinite(v.critical))
  );
}

const crosses = (op: Condition['op'], v: number, t: number) => (op === '>' ? v > t : v < t);

export interface ThresholdHit {
  labels: Record<string, string>;
  value: number;
  severity: Severity;
  /** A usage ratio rising steadily: when it reaches 100 % (only when meaningful). */
  fullInSeconds?: number;
  /** The rise in percentage points per hour, rounded to 0.5. */
  risePerHour?: number;
}

const TREND_MIN_RISE_PER_HOUR = 0.005;
const TREND_MAX_S = 7 * 86_400;

/**
 * "Full in ~6 h" for a usage ratio (alerts redesign item 6): the slope over the last
 * hour, kept only when it rises at least 0.5 points an hour and would reach 100 %
 * within a week. Rounded (hours above 2 h, else 10 min) so the alert is not rewritten
 * every cycle.
 */
export function fullIn(value: number, slopePerSecond: number) {
  const perHour = slopePerSecond * 3600;
  if (!(perHour >= TREND_MIN_RISE_PER_HOUR) || value >= 1) return undefined;
  const s = (1 - value) / slopePerSecond;
  if (s < 600 || s > TREND_MAX_S) return undefined;
  const rounded = s >= 7200 ? Math.round(s / 3600) * 3600 : Math.round(s / 600) * 600;
  return { fullInSeconds: rounded, risePerHour: Math.round(perHour * 200) / 2 };
}

/**
 * Runs a catalog expression with a scope as an instant query and returns the series
 * past the rule's thresholds. Only numbers from the rule reach the query, never text.
 */
export async function queryThreshold(
  ctx: EvalContext,
  key: MetricKey,
  scope: QueryScope,
): Promise<ThresholdHit[]> {
  if (!ctx.victoria) throw new Error('VictoriaMetrics is not configured');
  const cond = ctx.rule.condition;
  if (!validCondition(cond)) throw new Error('invalid condition');
  const { expr } = buildQuery(key, scope, STEP_S);
  const thresholds = [cond.value, cond.critical ?? cond.value];
  const bound = cond.op === '>' ? Math.min(...thresholds) : Math.max(...thresholds);
  const series = await ctx.victoria.query(
    // The org's own cluster, read under withOrg by the engine (ADR-174).
    authorisedScope(ctx.cluster.id),
    `(${expr}) ${cond.op} ${Number(bound)}`,
    ctx.now / 1000,
  );
  const out: ThresholdHit[] = [];
  for (const s of series) {
    const v = s.points[0]?.[1];
    if (v === null || v === undefined) continue;
    const critical = cond.critical !== undefined && crosses(cond.op, v, cond.critical);
    if (!critical && !crosses(cond.op, v, cond.value)) continue;
    out.push({
      labels: s.labels,
      value: v,
      severity: critical ? 'critical' : (ctx.rule.severity as Severity),
    });
  }
  return out;
}

const labelKey = (l: Record<string, string>) =>
  Object.entries(l)
    .filter(([k]) => k !== '__name__')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');

async function addTrend(ctx: EvalContext, key: MetricKey, hits: ThresholdHit[]) {
  const { expr } = buildQuery(key, {}, STEP_S);
  const slopes = await ctx.victoria!.query(
    authorisedScope(ctx.cluster.id),
    `deriv((${expr})[1h:1m])`,
    ctx.now / 1000,
  );
  const by = new Map(slopes.map((s) => [labelKey(s.labels), s.points[0]?.[1] ?? null]));
  for (const hit of hits) {
    const slope = by.get(labelKey(hit.labels));
    if (slope === null || slope === undefined) continue;
    Object.assign(hit, fullIn(hit.value, slope));
  }
}

export function metricRule(spec: MetricSpec): RuleEvaluator {
  return {
    kinds: Object.keys(spec.metric) as ClusterKind[],
    async evaluate(ctx) {
      const key = spec.metric[ctx.cluster.kind];
      if (!key) return [];
      const out: Observation[] = [];
      const hits = await queryThreshold(ctx, key, {});
      if (spec.trend && hits.length) await addTrend(ctx, key, hits);
      for (const hit of hits) {
        const scope = spec.scope(hit.labels);
        if (!scope) continue;
        const cond = ctx.rule.condition as unknown as Condition;
        out.push({
          ...scope,
          severity: hit.severity,
          details: {
            summary: spec.summary(hit.value, scope.labels),
            value: hit.value,
            threshold: cond.value,
            ...(cond.critical !== undefined ? { critical: cond.critical } : {}),
            forSeconds: ctx.rule.for_seconds,
            ...(hit.fullInSeconds !== undefined
              ? { fullInSeconds: hit.fullInSeconds, risePerHour: hit.risePerHour }
              : {}),
          },
        });
      }
      return out;
    },
  };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** One alert per source and destination of failing connections. */
function flowScope(l: Record<string, string>) {
  const src = l.workload ?? l.container;
  if (!src || !l.dst_kind) return null;
  const labels: Record<string, string> = {};
  for (const k of [
    'namespace',
    'workload_kind',
    'workload',
    'container',
    'dst_kind',
    'dst_namespace',
    'dst_workload_kind',
    'dst_workload',
    'dst_service',
    'dst',
  ]) {
    if (l[k]) labels[k] = l[k]!;
  }
  const dst = l.dst_workload ?? l.dst_service ?? l.dst ?? l.dst_kind;
  return {
    fingerprint: `flow:${l.namespace ?? ''}/${src}>${l.dst_kind}:${l.dst_namespace ?? ''}/${dst}`,
    labels,
  };
}

/** Kubernetes node series carry `node`, Docker host series `host`; both become `node`. */
function nodeScope(l: Record<string, string>, ...extra: string[]) {
  const node = l.node ?? l.host;
  if (!node) return null;
  const labels: Record<string, string> = { node };
  for (const k of extra) if (l[k] !== undefined) labels[k] = l[k]!;
  const kind = l.node !== undefined ? 'node' : 'host';
  return { fingerprint: [`${kind}:${node}`, ...extra.map((k) => l[k] ?? '')].join(':'), labels };
}

export const METRIC_RULES: DefaultRule[] = [
  {
    // Phase 4 (ADR-102): eBPF flows; nothing fires without them.
    key: 'network.connections.failed',
    metrics: { kubernetes: 'flow.failed.ratio', docker: 'flow.failed.ratio' },
    unit: 'ratio',
    name: 'Service-to-service failed connections',
    severity: 'warning',
    forSeconds: 300,
    condition: { op: '>', value: 0.05 },
    evaluator: metricRule({
      metric: { kubernetes: 'flow.failed.ratio', docker: 'flow.failed.ratio' },
      scope: (l) => flowScope(l),
      summary: (v) => `${pct(v)} of connections failed`,
    }),
  },
  {
    key: 'node.cpu.high',
    metrics: { kubernetes: 'node.cpu.utilization', docker: 'host.cpu.utilization' },
    unit: 'ratio',
    name: 'Node CPU high',
    severity: 'warning',
    forSeconds: 600,
    condition: { op: '>', value: 0.9 },
    evaluator: metricRule({
      metric: { kubernetes: 'node.cpu.utilization', docker: 'host.cpu.utilization' },
      scope: (l) => nodeScope(l),
      summary: (v) => `CPU ${pct(v)}`,
    }),
  },
  {
    key: 'node.disk.usage',
    metrics: { kubernetes: 'node.filesystem.utilization', docker: 'host.filesystem.utilization' },
    unit: 'ratio',
    name: 'Node disk usage',
    severity: 'warning',
    forSeconds: 0,
    condition: { op: '>', value: 0.85, critical: 0.95 },
    evaluator: metricRule({
      metric: { kubernetes: 'node.filesystem.utilization', docker: 'host.filesystem.utilization' },
      trend: true,
      scope: (l) => nodeScope(l, 'mount'),
      summary: (v, l) => `${l.mount} ${pct(v)} used`,
    }),
  },
  {
    key: 'k8s.pvc.usage',
    metrics: { kubernetes: 'pvc.utilization' },
    unit: 'ratio',
    name: 'PVC usage',
    severity: 'warning',
    forSeconds: 0,
    condition: { op: '>', value: 0.85 },
    evaluator: metricRule({
      metric: { kubernetes: 'pvc.utilization' },
      trend: true,
      scope: (l) =>
        l.namespace && l.persistentvolumeclaim
          ? {
              fingerprint: `pvc:${l.namespace}/${l.persistentvolumeclaim}`,
              labels: { namespace: l.namespace, pvc: l.persistentvolumeclaim },
            }
          : null,
      summary: (v) => `${pct(v)} used`,
    }),
  },
  {
    // The share of the time throttled, as cpu_throttled reads it (ADR-160): 25 % is at least
    // 0.25 s throttled every second for 15 minutes, which a near-idle container never is.
    key: 'k8s.container.throttling',
    metrics: { kubernetes: 'workload.container.cpu.throttled_share' },
    unit: 'ratio',
    name: 'Container CPU throttling',
    severity: 'warning',
    forSeconds: 900,
    condition: { op: '>', value: 0.25 },
    evaluator: metricRule({
      metric: { kubernetes: 'workload.container.cpu.throttled_share' },
      scope: (l) =>
        l.namespace && l.workload && l.workload_kind && l.container
          ? {
              fingerprint: `pod:${l.namespace}/${l.workload_kind}/${l.workload}:${l.container}`,
              labels: {
                namespace: l.namespace,
                workload: l.workload,
                workload_kind: l.workload_kind,
                container: l.container,
              },
            }
          : null,
      summary: (v, l) => `${l.container}: throttled ${pct(v)} of the time`,
    }),
  },
  {
    // The Docker form (ADR-124, ADR-160): the same share, per container.
    key: 'docker.container.throttling',
    metrics: { docker: 'container.cpu.throttled_share' },
    unit: 'ratio',
    name: 'Docker container CPU throttling',
    severity: 'warning',
    forSeconds: 900,
    condition: { op: '>', value: 0.25 },
    evaluator: metricRule({
      metric: { docker: 'container.cpu.throttled_share' },
      scope: (l) =>
        l.host && l.container
          ? {
              fingerprint: `docker:${l.host}/${l.container}`,
              labels: { node: l.host, container: l.container },
            }
          : null,
      summary: (v) => `throttled ${pct(v)} of the time`,
    }),
  },
  {
    key: 'docker.container.restarts',
    metrics: { docker: 'container.restarts.increase' },
    unit: 'count',
    name: 'Docker container restarting',
    severity: 'warning',
    forSeconds: 0,
    condition: { op: '>', value: 3 },
    evaluator: metricRule({
      metric: { docker: 'container.restarts.increase' },
      scope: (l) =>
        l.host && l.container
          ? {
              fingerprint: `docker:${l.host}/${l.container}`,
              labels: { node: l.host, container: l.container },
            }
          : null,
      summary: (v) => `${Math.round(v)} restarts in 10 min`,
    }),
  },
];
