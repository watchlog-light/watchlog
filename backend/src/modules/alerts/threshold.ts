// SPDX-License-Identifier: AGPL-3.0-only
// Custom threshold rules (ADR-085): a catalog metric, a scope and a condition; never
// MetricsQL. A pod label selector is resolved to pods from the objects at evaluation
// time and capped at 500 pods.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import type { PodSpec } from '../kubernetes/views.js';
import { METRIC_KEYS, metricUnit, type MetricKey, type QueryScope } from '../query/catalog.js';
import type { Condition } from './defaults.js';
import type { EvalContext, RuleEvaluator } from './engine.js';
import { queryThreshold } from './metric-rules.js';
import { nginxSources } from '../query/nginx.js';
import { INTEGRATION_TYPES } from '../integrations/collector-config.js';
import { conditionError, isServiceMetric, metricKinds } from './conditions.js';
import type { Observation } from './state-machine.js';

export const MAX_SELECTOR_PODS = 500;

export interface ThresholdScope {
  namespaces?: string[];
  workload?: { namespace: string; kind: string; name: string };
  node?: string;
  host?: string;
  container?: string;
  labels?: Record<string, string>;
  /** A monitored service's id (SPEC §4.12). */
  service?: string;
  /** Every monitored service of a type. */
  serviceType?: string;
}

const KUBE_FIELDS = ['namespaces', 'workload', 'node', 'labels'] as const;
const DOCKER_FIELDS = ['host', 'container'] as const;
const SERVICE_FIELDS = ['service', 'serviceType'] as const;

export class SelectorTooBroad extends Error {
  constructor(readonly pods: number) {
    super(
      `The label selector matches ${pods} pods; at most ${MAX_SELECTOR_PODS} are allowed. ` +
        'Narrow it, or scope the rule to a workload or a namespace instead.',
    );
  }
}

/** Pods of a cluster whose labels match every pair of the selector. */
export async function podsMatching(
  db: Database,
  clusterId: string,
  labels: Record<string, string>,
  namespaces?: string[],
): Promise<{ namespace: string; name: string }[]> {
  let q = db
    .selectFrom('objects')
    .select(['namespace', 'name', 'spec_summary'])
    .where('cluster_id', '=', clusterId)
    .where('kind', '=', 'Pod')
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`spec_summary @> ${JSON.stringify({ labels })}::jsonb`);
  if (namespaces?.length) q = q.where('namespace', 'in', namespaces);
  const rows = await q.execute();
  return rows
    .filter((r) => {
      const l = (r.spec_summary as PodSpec).labels ?? {};
      return Object.entries(labels).every(([k, v]) => l[k] === v);
    })
    .map((r) => ({ namespace: r.namespace, name: r.name }));
}

/** The catalog scope of a rule; null when its label selector matches no pod. */
export async function resolveScope(
  db: Database,
  clusterId: string,
  scope: ThresholdScope,
  metric?: string,
): Promise<QueryScope | null> {
  const q: QueryScope = {};
  if (scope.namespaces?.length) q.namespaces = scope.namespaces;
  if (scope.workload) {
    q.namespace = scope.workload.namespace;
    q.workloadKind = scope.workload.kind;
    q.workload = scope.workload.name;
  }
  if (scope.node) q.node = scope.node;
  if (scope.host) q.host = scope.host;
  if (scope.container) q.container = scope.container;
  if (scope.service) q.service = scope.service;
  if (scope.serviceType) q.serviceType = scope.serviceType;
  // Nginx's eBPF series name the workload, not the service: resolve which (nginx.ts).
  if (metric?.startsWith('nginx.')) {
    q.nginx =
      scope.serviceType && scope.serviceType !== 'nginx'
        ? []
        : await nginxSources(db, clusterId, scope.service);
  }
  if (scope.labels && Object.keys(scope.labels).length) {
    const pods = await podsMatching(db, clusterId, scope.labels, scope.namespaces);
    if (pods.length > MAX_SELECTOR_PODS) throw new SelectorTooBroad(pods.length);
    if (pods.length === 0) return null;
    q.pods = [...new Set(pods.map((p) => p.name))];
    q.namespaces = [...new Set(pods.map((p) => p.namespace))];
  }
  return q;
}

const UNITS: Record<string, (v: number) => string> = {
  ratio: (v) => `${Math.round(v * 1000) / 10} %`,
  bytes: (v) =>
    v >= 2 ** 30 ? `${(v / 2 ** 30).toFixed(2)} GiB` : `${Math.round(v / 2 ** 20)} MiB`,
  bytes_per_second: (v) =>
    v >= 2 ** 20 ? `${(v / 2 ** 20).toFixed(1)} MiB/s` : `${Math.round(v / 2 ** 10)} KiB/s`,
  cores: (v) => `${v.toFixed(2)} cores`,
  seconds: (v) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${Math.round(v * 100) / 100} s`),
  per_second: (v) => `${Math.round(v * 100) / 100}/s`,
};
export function formatMetricValue(v: number, unit: string | null): string {
  return (unit && UNITS[unit]?.(v)) ?? String(Math.round(v * 100) / 100);
}

/** Series labels as alert labels: Docker's `host` is the `node` (silences, links). */
function alertLabels(series: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(series)) {
    if (k === '__name__' || k === 'cluster_id') continue;
    if (k === 'host') out.node = v;
    else if (k === 'persistentvolumeclaim') out.pvc = v;
    else out[k] = v;
  }
  return out;
}

export function thresholdEvaluator(metric: string): RuleEvaluator | undefined {
  if (!(METRIC_KEYS as string[]).includes(metric)) return undefined;
  const unit = metricUnit(metric);
  return {
    kinds: metricKinds(metric),
    async evaluate(ctx: EvalContext) {
      const scope = await resolveScope(
        ctx.db,
        ctx.cluster.id,
        ctx.rule.scope as ThresholdScope,
        metric,
      );
      if (!scope) return [];
      const out: Observation[] = [];
      const hits = await queryThreshold(ctx, metric as MetricKey, scope);
      const services = await servicesOf(ctx, hits);
      for (const hit of hits) {
        const labels = alertLabels(hit.labels);
        // A monitored service is named in its alert, with what its collector last said.
        const svc = labels.service ? services.get(labels.service) : undefined;
        if (labels.service && !svc) continue; // removed since the series was written
        if (svc) labels.service_name = svc.name;
        out.push({
          fingerprint: `m:${Object.entries(labels)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(',')}`,
          severity: hit.severity,
          labels,
          details: {
            summary: formatMetricValue(hit.value, unit),
            value: hit.value,
            op: (ctx.rule.condition as { op?: string }).op ?? '>',
            threshold: (ctx.rule.condition as { value?: number }).value ?? null,
            unit,
            forSeconds: ctx.rule.for_seconds,
            ...(svc?.reason ? { reason: svc.reason } : {}),
          },
        });
      }
      return out;
    },
  };
}

/** The monitored services behind these series: name and the collector's last error. */
async function servicesOf(ctx: EvalContext, hits: { labels: Record<string, string> }[]) {
  const ids = [...new Set(hits.map((h) => h.labels.service).filter((v): v is string => !!v))];
  const out = new Map<string, { name: string; reason: string | null }>();
  if (ids.length === 0) return out;
  const rows = await ctx.db
    .selectFrom('integrations')
    .select(['id', 'name', 'status_details'])
    .where('cluster_id', '=', ctx.cluster.id)
    .where('id', 'in', ids)
    .execute();
  for (const r of rows) {
    const d = (r.status_details ?? {}) as {
      error?: string;
      members?: { name: string; up: boolean; error?: string }[];
    };
    const down = d.members?.find((m) => !m.up && m.error);
    const reason = d.error ?? (down ? `${down.name}: ${down.error}` : null);
    out.set(r.id, { name: r.name, reason: reason ? reason.slice(0, 200) : null });
  }
  return out;
}

/**
 * Checks a custom rule's metric, cluster and scope (ADR-085): the scope must fit the
 * metric's cluster kind, and a label selector may match at most 500 pods in any target
 * cluster.
 */
export async function validateThreshold(
  db: Database,
  orgId: string,
  rule: { metric: string; clusterId: string | null; scope: ThresholdScope; condition?: Condition },
): Promise<string | null> {
  if (!(METRIC_KEYS as string[]).includes(rule.metric)) return `Unknown metric "${rule.metric}"`;
  const kinds = metricKinds(rule.metric);
  const isService = isServiceMetric(rule.metric);
  const allowed: readonly string[] = isService
    ? SERVICE_FIELDS
    : kinds.includes('docker')
      ? DOCKER_FIELDS
      : KUBE_FIELDS;
  const extra = Object.keys(rule.scope).filter(
    (k) => rule.scope[k as keyof ThresholdScope] !== undefined && !allowed.includes(k),
  );
  if (extra.length) {
    return `Scope "${extra[0]}" does not apply to a ${isService ? 'service' : kinds[0] === 'docker' ? 'Docker' : 'Kubernetes'} metric`;
  }
  if (rule.scope.service && rule.scope.serviceType) {
    return 'A rule is about one service or every service of a type, not both';
  }
  if (rule.scope.serviceType) {
    const t = rule.scope.serviceType;
    if (!(INTEGRATION_TYPES as readonly string[]).includes(t)) return `Unknown service type "${t}"`;
    const own = rule.metric.split('.')[0];
    if (own !== 'service' && own !== t) return `${rule.metric} is not a ${t} metric`;
  }
  if (rule.scope.service) {
    const svc = await db
      .selectFrom('integrations')
      .select('cluster_id')
      .where('id', '=', rule.scope.service)
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    if (!svc) return 'The service is not monitored';
    if (rule.clusterId && rule.clusterId !== svc.cluster_id) {
      return 'The service is not in this cluster';
    }
  }
  if (rule.condition) {
    const err = conditionError(rule.condition, metricUnit(rule.metric));
    if (err) return err;
  }
  let clusters = db
    .selectFrom('clusters')
    .select(['id', 'kind'])
    .where('org_id', '=', orgId)
    .where('kind', 'in', kinds);
  if (rule.clusterId) clusters = clusters.where('id', '=', rule.clusterId);
  const targets = await clusters.execute();
  if (rule.clusterId && targets.length === 0) {
    return 'The cluster does not exist or does not have this metric';
  }
  if (rule.scope.labels && Object.keys(rule.scope.labels).length) {
    for (const c of targets) {
      const pods = await podsMatching(db, c.id, rule.scope.labels, rule.scope.namespaces);
      if (pods.length > MAX_SELECTOR_PODS) return new SelectorTooBroad(pods.length).message;
    }
  }
  return null;
}
