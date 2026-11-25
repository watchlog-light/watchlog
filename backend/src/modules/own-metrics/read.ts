// SPDX-License-Identifier: AGPL-3.0-only
// Reading a cluster's own metrics (1.0.0, ADR-236): the list with each metric's value now, one
// metric's page, and its line over a range, split by at most one label (the top 5 and the rest).
// The registry (PostgreSQL) says what exists and what it belongs to; VictoriaMetrics has the
// values. Expressions come from expr.ts only.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import type { ClusterScope, QuerySeries, VictoriaQueryClient } from '../../lib/victoria.js';
import {
  exprFor,
  exprForMany,
  MANY_NAME,
  shownUnit,
  summed,
  type ExprMetric,
  type Stat,
} from './expr.js';
import {
  shownAs,
  unitFromName,
  wordsOf,
  type OwnType,
  type OwnUnit,
  type Shown,
} from './naming.js';
import { NO_OWNER, type Owner, type SourceKind } from './service.js';

/** A series counts while it reported within the hour (the caps' window too). */
const ACTIVE_MS = 3_600_000;
/** A metric stays on the list for a week after it last reported. */
const LISTED_MS = 7 * 86_400_000;
export const MAX_LISTED = 1000;
/** Lines of a split: the top ones by their last value, the rest as one "other". */
export const SPLIT_TOP = 5;

export interface MetricInfo {
  id: string;
  name: string;
  /** A few words made from the name. */
  words: string;
  type: OwnType;
  /** What the name and the TYPE line said, when the user corrected it. */
  detectedType: OwnType;
  unit: OwnUnit;
  detectedUnit: OwnUnit;
  shown: Shown;
  help: string;
  hidden: boolean;
  labels: string[];
  /** Refused for a label with too many values: nothing new of it is stored. */
  refused: { label: string } | null;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Series that reported within the hour. */
  series: number;
  sources: { id: string; label: string; kind: SourceKind }[];
  /** What its series belong to (up to 5), and how many owners there are. */
  owners: Owner[];
  ownerCount: number;
  /** Some of its series belong to nothing WatchLog knows. */
  untied: boolean;
  /** Every source of it is a push. */
  pushed: boolean;
}

export interface MetricFilter {
  /** Only metrics with series of this owner. */
  owner?: Owner;
  ids?: readonly string[];
  names?: readonly string[];
}

const ownerKey = (o: Owner) => `${o.kind}|${o.namespace}|${o.workloadKind}|${o.name}`;

export const exprMetric = (m: MetricInfo): ExprMetric => ({
  name: m.name,
  type: m.type,
  unit: m.unit,
  pushed: m.pushed,
});

/** The cluster's metrics from the registry, with what each belongs to and comes from. */
export async function listMetrics(
  db: Database,
  clusterId: string,
  filter: MetricFilter = {},
  now = Date.now(),
): Promise<MetricInfo[]> {
  let q = db
    .selectFrom('own_metrics')
    .selectAll()
    .where('cluster_id', '=', clusterId)
    .where('last_seen', '>', new Date(now - LISTED_MS))
    .orderBy('name')
    .limit(MAX_LISTED);
  if (filter.ids) {
    if (!filter.ids.length) return [];
    q = q.where('id', 'in', [...filter.ids]);
  }
  if (filter.names) {
    if (!filter.names.length) return [];
    q = q.where('name', 'in', [...filter.names]);
  }
  const o = filter.owner;
  if (o && o.kind) {
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom('own_series as s')
          .select(sql.lit(1).as('one'))
          .whereRef('s.metric_id', '=', 'own_metrics.id')
          .where('s.owner_kind', '=', o.kind)
          .where('s.owner_namespace', '=', o.namespace)
          .where('s.owner_workload_kind', '=', o.workloadKind)
          .where('s.owner_name', '=', o.name),
      ),
    );
  }
  const rows = await q.execute();
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [groups, sources] = await Promise.all([
    db
      .selectFrom('own_series')
      .select([
        'metric_id',
        'source_id',
        'owner_kind',
        'owner_namespace',
        'owner_workload_kind',
        'owner_name',
        (eb) => eb.fn.countAll<string>().as('n'),
      ])
      .where('cluster_id', '=', clusterId)
      .where('metric_id', 'in', ids)
      .where('last_seen', '>', new Date(now - ACTIVE_MS))
      .groupBy([
        'metric_id',
        'source_id',
        'owner_kind',
        'owner_namespace',
        'owner_workload_kind',
        'owner_name',
      ])
      .execute(),
    db
      .selectFrom('own_sources')
      .select(['id', 'label', 'kind'])
      .where('cluster_id', '=', clusterId)
      .execute(),
  ]);
  const sourceOf = new Map(sources.map((s) => [s.id, s]));
  const by = new Map<
    string,
    { series: number; sources: Set<string>; owners: Map<string, Owner>; untied: boolean }
  >();
  for (const g of groups) {
    let m = by.get(g.metric_id);
    if (!m)
      by.set(
        g.metric_id,
        (m = { series: 0, sources: new Set(), owners: new Map(), untied: false }),
      );
    m.series += Number(g.n);
    m.sources.add(g.source_id);
    if (g.owner_kind === '') m.untied = true;
    else {
      const owner: Owner = {
        kind: g.owner_kind as 'workload',
        namespace: g.owner_namespace,
        workloadKind: g.owner_workload_kind,
        name: g.owner_name,
      };
      m.owners.set(ownerKey(owner), owner);
    }
  }
  return rows.map((r) => {
    const agg = by.get(r.id);
    const type = (r.type_override ?? r.type) as OwnType;
    const detectedUnit = unitFromName(r.name, type);
    const unit = (r.unit_override as OwnUnit | null) ?? detectedUnit;
    const from = [...(agg?.sources ?? [])]
      .map((id) => sourceOf.get(id))
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map((s) => ({ id: s.id, label: s.label, kind: s.kind as SourceKind }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const owners = [...(agg?.owners.values() ?? [])].sort((a, b) =>
      ownerKey(a).localeCompare(ownerKey(b)),
    );
    return {
      id: r.id,
      name: r.name,
      words: wordsOf(r.name),
      type,
      detectedType: r.type as OwnType,
      unit,
      detectedUnit,
      shown: shownAs(type),
      help: r.help,
      hidden: r.hidden,
      labels: [...r.label_names].sort(),
      refused: (r.refused as { label: string } | null) ?? null,
      firstSeenAt: r.first_seen.getTime(),
      lastSeenAt: r.last_seen.getTime(),
      series: agg?.series ?? 0,
      sources: from,
      owners: owners.slice(0, 5),
      ownerCount: owners.length,
      untied: agg?.untied ?? false,
      pushed: from.length > 0 && from.every((s) => s.kind === 'push'),
    };
  });
}

const last = (s: QuerySeries | undefined): number | null => {
  const p = s?.points[s.points.length - 1];
  return p ? p[1] : null;
};

/**
 * The value now of each metric, by id: a handful of queries for the whole list (the metrics of
 * one kind share one), or one per metric when an owner narrows them.
 */
export async function valuesNow(
  victoria: VictoriaQueryClient,
  scope: ClusterScope,
  metrics: readonly MetricInfo[],
  owner?: Owner,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const one = async (m: MetricInfo) => {
    const rows = await victoria.query(scope, exprFor(exprMetric(m), { owner }));
    out.set(m.id, last(rows[0]));
  };
  if (owner?.kind) {
    await Promise.all(metrics.map(one));
    return out;
  }
  const groups = new Map<string, MetricInfo[]>();
  const alone: MetricInfo[] = [];
  for (const m of metrics) {
    if (m.type === 'summary') {
      alone.push(m);
      continue;
    }
    const sum = m.type === 'gauge' ? summed(m.unit) : true;
    const key = `${m.type}|${sum}|${m.pushed}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const jobs: Promise<void>[] = alone.map(one);
  for (const [key, list] of groups) {
    const [type, sum, pushed] = key.split('|');
    for (let i = 0; i < list.length; i += 60) {
      const chunk = list.slice(i, i + 60);
      const suffix = type === 'histogram' ? '_bucket' : '';
      jobs.push(
        victoria
          .query(
            scope,
            exprForMany(
              { type: type as 'counter', sum: sum === 'true', pushed: pushed === 'true' },
              chunk.map((m) => m.name),
            ),
          )
          .then((rows) => {
            const byName = new Map(rows.map((r) => [r.labels[MANY_NAME] ?? '', r]));
            for (const m of chunk) out.set(m.id, last(byName.get(m.name + suffix)));
          }),
      );
    }
  }
  await Promise.all(jobs);
  return out;
}

export interface Line {
  /** The split label's value; null for the metric's one line and for "other". */
  value: string | null;
  other: boolean;
  points: [number, number | null][];
}

export interface SeriesAnswer {
  step: number;
  unit: OwnUnit;
  shown: Shown;
  lines: Line[];
  /** How many values the split label has in the range (the lines show the top 5). */
  values: number;
}

const lastValue = (s: QuerySeries): number => {
  for (let i = s.points.length - 1; i >= 0; i--) {
    const v = s.points[i]![1];
    if (v !== null) return v;
  }
  return -Infinity;
};

/** A metric's line over a range; split by one label: the top 5 by their last value, and the rest. */
export async function metricSeries(
  victoria: VictoriaQueryClient,
  scope: ClusterScope,
  m: MetricInfo,
  o: { from: number; to: number; step: number; by?: string; owner?: Owner; stat?: Stat },
): Promise<SeriesAnswer> {
  const em = exprMetric(m);
  const base = { step: o.step, owner: o.owner, stat: o.stat };
  const answer = { step: o.step, unit: shownUnit(em), shown: m.shown };
  if (!o.by) {
    const rows = await victoria.queryRange(scope, exprFor(em, base), o.from, o.to, o.step);
    return {
      ...answer,
      values: 0,
      lines: rows.length ? [{ value: null, other: false, points: rows[0]!.points }] : [],
    };
  }
  const rows = await victoria.queryRange(
    scope,
    exprFor(em, { ...base, by: o.by }),
    o.from,
    o.to,
    o.step,
  );
  const ranked = [...rows].sort((a, b) => lastValue(b) - lastValue(a));
  const top = ranked.slice(0, SPLIT_TOP);
  const lines: Line[] = top.map((r) => ({
    value: r.labels[o.by!] ?? '',
    other: false,
    points: r.points,
  }));
  if (ranked.length > SPLIT_TOP) {
    const rest = await victoria.queryRange(
      scope,
      exprFor(em, { ...base, by: o.by, exclude: lines.map((l) => l.value ?? '') }),
      o.from,
      o.to,
      o.step,
    );
    if (rest.length) lines.push({ value: null, other: true, points: rest[0]!.points });
  }
  return { ...answer, values: rows.length, lines };
}

export interface LabelFacts {
  name: string;
  /** Distinct values among the active series. */
  values: number;
  /** The most common ones. */
  top: string[];
}

/** A metric's labels with how many values each has now (from the registry, not a query). */
export async function labelFacts(
  db: Database,
  clusterId: string,
  metricId: string,
  now = Date.now(),
): Promise<LabelFacts[]> {
  const rows = await db
    .selectFrom('own_series')
    .select('labels')
    .where('cluster_id', '=', clusterId)
    .where('metric_id', '=', metricId)
    .where('last_seen', '>', new Date(now - ACTIVE_MS))
    .limit(5000)
    .execute();
  const by = new Map<string, Map<string, number>>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.labels as Record<string, string>)) {
      if (k === 'le' || k === 'quantile' || k.startsWith('wl_')) continue;
      let values = by.get(k);
      if (!values) by.set(k, (values = new Map()));
      values.set(v, (values.get(v) ?? 0) + 1);
    }
  }
  return [...by]
    .map(([name, values]) => ({
      name,
      values: values.size,
      top: [...values]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([v]) => v),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export { NO_OWNER };
