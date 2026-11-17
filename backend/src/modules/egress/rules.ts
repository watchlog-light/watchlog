// SPDX-License-Identifier: AGPL-3.0-only
// The three default egress rules (ADR-187), for Kubernetes clusters and Docker fleets:
//   - egress.new_destination: a source talks to a destination and port that weren't in its
//     inventory, once the cluster and the source have learned for 7 days; quiet for private
//     networks, local names and "Internet" (slice 1), and for anything expected (ADR-186);
//   - egress.raw_ip: at least 5 connections in 10 minutes to one public raw network and port;
//   - egress.large_upload_new: more than 100 MiB sent in an hour to a destination first seen in
//     the last 24 hours.
// The alert's subject is the source, in its platform's labels (a workload; a Compose service or
// a container on its host), so probable cause finds it (change_before_egress). Every time comes
// from the engine's clock (`ctx.now`).
import { authorisedScope } from '../../lib/victoria.js';
import type { Condition, DefaultRule } from '../alerts/defaults.js';
import type { EvalContext, RuleEvaluator } from '../alerts/engine.js';
import { validCondition } from '../alerts/metric-rules.js';
import type { Observation, Severity } from '../alerts/state-machine.js';
import { edgeOf, SOURCE_LABELS, type ClusterKind, type SourceIdentity } from './inventory.js';
import { egressLearningMs, learningStart } from './learning.js';
import { EGRESS_NEW_CLASSES, EGRESS_NEW_MS } from './read.js';

export const EGRESS_NEW_DESTINATION = 'egress.new_destination';
export const EGRESS_RAW_IP = 'egress.raw_ip';
export const EGRESS_LARGE_UPLOAD = 'egress.large_upload_new';
export const isEgressRule = (key: string | null | undefined): boolean =>
  !!key && key.startsWith('egress.');

/** "New external destination" resolves after this long without traffic to it (ADR-187). */
export const EGRESS_QUIET_MS = 24 * 3_600_000;
/** Raw IP counts connections over this window, and resolves after as long below it. */
export const RAW_IP_WINDOW = '10m';
/** 100 MiB: alert thresholds are typed and shown in MiB (slice 1). */
export const LARGE_UPLOAD_BYTES = 100 * 2 ** 20;

/** A source's labels on its alert, in the platform's vocabulary (ADR-124). */
export function sourceLabels(s: SourceIdentity): Record<string, string> {
  if (s.workload !== undefined) {
    return { namespace: s.namespace!, workload_kind: s.workload_kind!, workload: s.workload };
  }
  if (s.compose_service !== undefined) {
    return { compose_project: s.compose_project!, compose_service: s.compose_service };
  }
  return { node: s.host!, container: s.container! };
}

/** "shop/Deployment/orders", "shop/api", "docker-01/redis": the fingerprint's source part. */
function sourceRef(s: SourceIdentity): string {
  if (s.workload !== undefined) return `${s.namespace}/${s.workload_kind}/${s.workload}`;
  if (s.compose_service !== undefined) return `${s.compose_project}/${s.compose_service}`;
  return `${s.host}/${s.container}`;
}

const fingerprintOf = (s: SourceIdentity, destination: string, port: number) =>
  `egress:${sourceRef(s)}>${destination}:${port}`;

/** A row's source with its keys in sourceRef's order (jsonb reorders them). */
function identity(raw: unknown): SourceIdentity {
  return raw as SourceIdentity;
}

function labelsOf(s: SourceIdentity, destination: string, port: number) {
  return { ...sourceLabels(s), destination, port: String(port) };
}

/** The open (pending or firing) alerts of this rule and cluster, by fingerprint. */
async function openFingerprints(ctx: EvalContext): Promise<Set<string>> {
  const rows = await ctx.db
    .selectFrom('alert_states')
    .select('fingerprint')
    .where('rule_id', '=', ctx.rule.id)
    .where('cluster_id', '=', ctx.cluster.id)
    .where('state', '<>', 'resolved')
    .execute();
  return new Set(rows.map((r) => r.fingerprint));
}

/** How many sources of the cluster use each destination (any port). */
async function sourcesUsing(
  ctx: EvalContext,
  destinations: string[],
): Promise<Map<string, number>> {
  if (destinations.length === 0) return new Map();
  const rows = await ctx.db
    .selectFrom('egress_destinations')
    .select(['destination', (eb) => eb.fn.count<string>('source').distinct().as('n')])
    .where('cluster_id', '=', ctx.cluster.id)
    .where('destination', 'in', [...new Set(destinations)])
    .groupBy('destination')
    .execute();
  return new Map(rows.map((r) => [r.destination, Number(r.n)]));
}

const iso = (d: Date) => d.toISOString();

/**
 * New external destination. A row qualifies when it was first seen after the cluster's and
 * its source's learning ended, is a name or a public network (never a private network, a local
 * name or "Internet"), isn't marked expected (the inventory's copy, kept in sync, ADR-186) and
 * wasn't only "before" the oldest retained sample. It fires for a destination first seen in the
 * last 24 hours and stays while it is used, until 24 hours without traffic to it; a row that
 * becomes expected leaves at the next evaluation, which resolves its alert.
 */
const newDestination: RuleEvaluator = {
  kinds: ['kubernetes', 'server'],
  async evaluate(ctx) {
    const cluster = await ctx.db
      .selectFrom('clusters')
      .select(['egress_learning_since', 'first_seen_at', 'created_at'])
      .where('id', '=', ctx.cluster.id)
      .executeTakeFirst();
    if (!cluster) return [];
    const learnMs = egressLearningMs();
    const learnedAt = learningStart(cluster).getTime() + learnMs;
    // The cluster is still learning: nothing new can qualify yet.
    if (ctx.now < learnedAt) return [];
    const [open, rows] = await Promise.all([
      openFingerprints(ctx),
      ctx.db
        .selectFrom('egress_destinations as d')
        .leftJoin('egress_sources as s', (j) =>
          j.onRef('s.cluster_id', '=', 'd.cluster_id').onRef('s.source', '=', 'd.source'),
        )
        .select([
          'd.source',
          'd.destination',
          'd.port',
          'd.destination_class',
          'd.first_seen',
          's.first_seen as source_first_seen',
        ])
        .where('d.cluster_id', '=', ctx.cluster.id)
        .where('d.destination_class', 'in', [...EGRESS_NEW_CLASSES])
        .where('d.pattern', 'is', null)
        .where('d.first_seen_before', '=', false)
        .where('d.first_seen', '>=', new Date(learnedAt))
        .where('d.last_seen', '>=', new Date(ctx.now - EGRESS_QUIET_MS))
        .execute(),
    ]);
    const kept = rows.filter((r) => {
      const first = new Date(r.first_seen).getTime();
      const sourceFirst = r.source_first_seen ? new Date(r.source_first_seen).getTime() : first;
      // The source is learning (a new workload or container): its destinations are learned.
      if (first < sourceFirst + learnMs) return false;
      const fp = fingerprintOf(identity(r.source), r.destination, r.port);
      return first >= ctx.now - EGRESS_NEW_MS || open.has(fp);
    });
    const using = await sourcesUsing(
      ctx,
      kept.map((r) => r.destination),
    );
    return kept.map((r): Observation => {
      const s = identity(r.source);
      const first = new Date(r.first_seen);
      return {
        fingerprint: fingerprintOf(s, r.destination, r.port),
        severity: ctx.rule.severity as Severity,
        labels: labelsOf(s, r.destination, r.port),
        details: {
          destination: r.destination,
          port: r.port,
          class: r.destination_class,
          firstSeen: iso(first),
          // Other sources of the cluster or fleet that use it ("Nothing else … talks to it").
          others: Math.max(0, (using.get(r.destination) ?? 1) - 1),
        },
        since: first.getTime(),
      };
    });
  },
};

const crosses = (c: Condition, v: number) => (c.op === '>' ? v > c.value : v < c.value);

/** Series values summed per inventory edge (Docker replicas fold into their Compose service). */
function perEdge(
  kind: ClusterKind,
  series: { labels: Record<string, string>; points: [number, number | null][] }[],
) {
  const out = new Map<
    string,
    { source: SourceIdentity; destination: string; port: number; cls: string; value: number }
  >();
  for (const s of series) {
    const v = s.points[0]?.[1];
    if (v === null || v === undefined) continue;
    const e = edgeOf(kind, s.labels);
    if (!e) continue;
    const fp = fingerprintOf(e.source, e.destination, e.port);
    const seen = out.get(fp);
    if (seen) seen.value += v;
    else
      out.set(fp, {
        source: e.source,
        destination: e.destination,
        port: e.port,
        cls: e.destination_class,
        value: v,
      });
  }
  return out;
}

function needVictoria(ctx: EvalContext) {
  if (!ctx.victoria) throw new Error('VictoriaMetrics is not configured');
  const cond = ctx.rule.condition;
  if (!validCondition(cond)) throw new Error('invalid condition');
  return { victoria: ctx.victoria, cond };
}

/**
 * Raw IP egress: connections to one public raw network and port (the `/24` or `/48` the series
 * carry, ADR-104) over 10 minutes, past the threshold (more than 4: at least 5). The largest
 * 10-minute count of the last 10 minutes is compared, so the alert resolves once the count has
 * stayed below the threshold for 10 minutes. Private networks never fire it (ADR-185).
 */
const rawIp: RuleEvaluator = {
  kinds: ['kubernetes', 'server'],
  async evaluate(ctx) {
    const { victoria, cond } = needVictoria(ctx);
    const kind = ctx.cluster.kind;
    const expr =
      `max_over_time((sum by (${SOURCE_LABELS[kind]}, dst_kind, dst, dst_port) ` +
      `(increase(watchlog_flow_connections_total{dst_kind="external"}[${RAW_IP_WINDOW}])))` +
      `[${RAW_IP_WINDOW}:1m])`;
    // The org's own cluster, read under withOrg by the engine (ADR-174).
    const series = await victoria.query(authorisedScope(ctx.cluster.id), expr, ctx.now / 1000);
    const out: Observation[] = [];
    for (const [fp, e] of perEdge(kind, series)) {
      if (e.cls !== 'public_network' || !crosses(cond, e.value)) continue;
      out.push({
        fingerprint: fp,
        severity: ctx.rule.severity as Severity,
        labels: labelsOf(e.source, e.destination, e.port),
        details: {
          destination: e.destination,
          port: e.port,
          class: e.cls,
          connections: Math.round(e.value),
          threshold: cond.value,
        },
      });
    }
    return out;
  },
};

/**
 * Large upload to a new destination: bytes sent over the last hour to one destination and port,
 * past the threshold, when that destination was first seen by the source in the last 24 hours
 * (and isn't a private network, a local name or "Internet", as for "New"). An open alert stays
 * while the hour's total is past the threshold. A cluster whose first-seen look-back hasn't run
 * yet is skipped: until then an upgrade's destinations in use look new.
 */
const largeUpload: RuleEvaluator = {
  kinds: ['kubernetes', 'server'],
  async evaluate(ctx) {
    const { victoria, cond } = needVictoria(ctx);
    const kind = ctx.cluster.kind;
    const cluster = await ctx.db
      .selectFrom('clusters')
      .select('egress_backfilled_at')
      .where('id', '=', ctx.cluster.id)
      .executeTakeFirst();
    if (!cluster?.egress_backfilled_at) return [];
    const expr =
      `sum by (${SOURCE_LABELS[kind]}, dst_kind, dst, dst_port) ` +
      `(increase(watchlog_flow_bytes_total{dst_kind="external", dir="sent"}[1h]))`;
    const series = await victoria.query(authorisedScope(ctx.cluster.id), expr, ctx.now / 1000);
    const hits = [...perEdge(kind, series)].filter(
      ([, e]) => EGRESS_NEW_CLASSES.has(e.cls) && crosses(cond, e.value),
    );
    if (hits.length === 0) return [];
    const [open, rows] = await Promise.all([
      openFingerprints(ctx),
      ctx.db
        .selectFrom('egress_destinations')
        .select(['source', 'destination', 'port', 'first_seen', 'first_seen_before'])
        .where('cluster_id', '=', ctx.cluster.id)
        .where('destination', 'in', [...new Set(hits.map(([, e]) => e.destination))])
        .execute(),
    ]);
    const firstSeen = new Map(
      rows.map((r) => [fingerprintOf(identity(r.source), r.destination, r.port), r]),
    );
    const out: Observation[] = [];
    for (const [fp, e] of hits) {
      const row = firstSeen.get(fp);
      if (!row) continue;
      const first = new Date(row.first_seen);
      const isNew = !row.first_seen_before && first.getTime() >= ctx.now - EGRESS_NEW_MS;
      if (!isNew && !open.has(fp)) continue;
      out.push({
        fingerprint: fp,
        severity: ctx.rule.severity as Severity,
        labels: labelsOf(e.source, e.destination, e.port),
        details: {
          destination: e.destination,
          port: e.port,
          class: e.cls,
          sentBytes: Math.round(e.value),
          threshold: cond.value,
          firstSeen: iso(first),
        },
      });
    }
    return out;
  },
};

/** The three default rules (ADR-187), warning, on by default, editable like every default. */
export const EGRESS_RULES: DefaultRule[] = [
  {
    key: EGRESS_NEW_DESTINATION,
    name: 'New external destination',
    severity: 'warning',
    forSeconds: 0,
    evaluator: newDestination,
  },
  {
    key: EGRESS_RAW_IP,
    name: 'Raw IP egress',
    severity: 'warning',
    forSeconds: 0,
    unit: 'count',
    // At least 5 connections in 10 minutes (ADR-187): thresholds compare strictly.
    condition: { op: '>', value: 4 },
    evaluator: rawIp,
  },
  {
    key: EGRESS_LARGE_UPLOAD,
    name: 'Large upload to a new destination',
    severity: 'warning',
    forSeconds: 0,
    unit: 'bytes',
    condition: { op: '>', value: LARGE_UPLOAD_BYTES },
    evaluator: largeUpload,
  },
];
