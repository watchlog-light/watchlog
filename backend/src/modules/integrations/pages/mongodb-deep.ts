// SPDX-License-Identifier: AGPL-3.0-only
// The MongoDB page since 1.4 (ADR-247): what it waits on ($currentOp sampled every 15 s), which
// operation shape is responsible and which service sends it, what changed; the replica set's
// elections and heartbeats, sessions, collections and indexes, the cache. Built on 1.2's
// database machinery (db-deep.ts: waits, statements, "sent mostly by", scoped alerts) with
// MongoDB as its third engine. Every number shown twice on a page is read once (aligned).
import { escapeLabelValue } from '../../query/catalog.js';
import type { QuerySeries } from '../../../lib/victoria.js';
import {
  capacityPanel,
  clientOf,
  clientsByWaits,
  clientsOfStatement,
  dominantWait,
  MG,
  missingIndex,
  ownersOf,
  periodOf,
  resourcePanels,
  scopedAlerts,
  sentBy,
  slowerSince,
  sparseAvg,
  statementFacts,
  statementRows,
  statementStats,
  statementsByWaits,
  waitsChart,
  waitsOver,
  type StatementFact,
} from './db-deep.js';
import { duration } from './mysql.js';
import { bytes, type Owner } from './owners.js';
import { instant, one, pointsOf, range, valueOf } from './query.js';
import { aligned } from './rabbitmq-tabs.js';
import type {
  ChecksPanel,
  FlowPanel,
  Link,
  PageContext,
  Panel,
  Severity,
  TablePanel,
  Text,
} from './types.js';

const E = MG;
const P = 'integrations.mongodb.panels';
const D = 'integrations.db.panels';
const RATE = '2m';
const LAG_LINE = 10;
const OPLOG_DAY = 86400;
/** Transactions worth naming: the server aborts them at 60 s by default. */
export const TXN_LONG = 30;

export interface MongoMember {
  name: string;
  state: string;
  health: number;
  lag: number;
  uptime: number;
  seen_by: string;
  set: string;
  ping?: number;
  votes?: number;
  priority?: number;
}
interface Client {
  addr: string;
  app: string;
  connections: number;
  member: string;
  opened?: number;
}
interface IndexRow {
  ns: string;
  index: string;
  member: string;
  since?: number;
  bytes?: number;
  covered_by?: string;
}
interface Txn {
  addr: string;
  app: string;
  age: number;
  idle: number;
  state: string;
  member: string;
}
interface Cursor {
  ns: string;
  idle: number;
  age: number;
  member: string;
}
interface Build {
  ns: string;
  progress: string;
  seconds?: number;
  member: string;
}
interface Setting {
  name: string;
  value: string;
  version: string;
  member: string;
}
export interface Extra {
  members?: MongoMember[];
  clients?: Client[];
  unused_indexes?: IndexRow[];
  redundant_indexes?: IndexRow[];
  transactions?: Txn[];
  cursors?: Cursor[];
  index_builds?: Build[];
  settings?: Setting[];
}
export const extraOf = (ctx: PageContext): Extra =>
  (ctx.row.status_details as { extra?: Extra }).extra ?? {};
const healthy = new Set(['PRIMARY', 'SECONDARY', 'ARBITER']);

/** Each member's current and available connections (labels member and state). */
export const connsBy = (s: string, by = 'member') =>
  `max by (${by}, state) (watchlog_mongodb_connections{${s}, state=~"current|available"})`;

/**
 * The member nearest its connection limit, per key (the service in a list, '' on a page). The
 * limit is each member's own: a full primary beside an idle secondary is 100 of 100, not 53 %.
 */
export function busiestMember(
  rows: QuerySeries[],
  key: (labels: Record<string, string>) => string = () => '',
): Map<string, { c: number; a: number }> {
  const members = new Map<string, { key: string; c?: number; a?: number }>();
  for (const r of rows) {
    const v = r.points[0]?.[1];
    if (v === undefined || v === null) continue;
    const k = key(r.labels);
    const id = `${k}\u0000${r.labels.member ?? ''}`;
    const m = members.get(id) ?? { key: k };
    if (r.labels.state === 'current') m.c = v;
    else m.a = v;
    members.set(id, m);
  }
  const out = new Map<string, { c: number; a: number }>();
  for (const m of members.values()) {
    if (m.c === undefined || m.a === undefined || m.c + m.a <= 0) continue;
    const best = out.get(m.key);
    if (!best || m.c / (m.c + m.a) > best.c / (best.c + best.a)) out.set(m.key, { c: m.c, a: m.a });
  }
  return out;
}

/**
 * The indexes unused on every member that reported indexes: a secondary serves no reads, so it
 * lists every index as unused; an index the primary uses isn't unused (1.4).
 */
export function unusedEverywhere(ex: Extra): IndexRow[] {
  const reporters = new Set((ex.unused_indexes ?? []).map((r) => r.member));
  for (const r of ex.redundant_indexes ?? []) reporters.add(r.member);
  const by = new Map<string, { row: IndexRow; members: Set<string> }>();
  for (const r of ex.unused_indexes ?? []) {
    const k = `${r.ns}\u0000${r.index}`;
    const cur = by.get(k) ?? { row: r, members: new Set<string>() };
    cur.members.add(r.member);
    if ((r.bytes ?? 0) > (cur.row.bytes ?? 0)) cur.row = r;
    by.set(k, cur);
  }
  // Members that reported nothing unused used every index: they count against.
  const all = new Set([...reporters, ...(ex.members ?? []).map((m) => m.seen_by)]);
  return [...by.values()]
    .filter((x) => [...all].every((m) => x.members.has(m) || !reporters.has(m)))
    .map((x) => x.row)
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
}

/** One per index (each member reports its own copy). */
function uniqueIndexes(rows: IndexRow[]): IndexRow[] {
  const seen = new Map<string, IndexRow>();
  for (const r of rows) {
    const k = `${r.ns}\u0000${r.index}`;
    if (!seen.has(k) || (r.bytes ?? 0) > (seen.get(k)!.bytes ?? 0)) seen.set(k, r);
  }
  return [...seen.values()].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
}

/** The members as the primary sees them (the collector keeps the primary's view). */
const membersOf = (ex: Extra) => ex.members ?? [];

/** Connections per client, the collector's own left out, summed over members. */
function clientsBy(ex: Extra, owners: Map<string, Owner>) {
  const out = new Map<
    string,
    { name: string; link?: Link; n: number; opened: number; addrs: Set<string>; app: string }
  >();
  for (const x of ex.clients ?? []) {
    const c = clientOf(owners, x.addr, x.app);
    const cur = out.get(c.name) ?? { ...c, n: 0, opened: 0, addrs: new Set<string>(), app: x.app };
    cur.n += x.connections;
    cur.opened += x.opened ?? 0;
    cur.addrs.add(x.addr);
    out.set(c.name, cur);
  }
  return out;
}

/** The shapes' last hour: calls, seconds and documents examined, by shape. */
async function lastHour(ctx: PageContext) {
  const s = one(ctx.row.id);
  const q = (m: string) => instant(ctx, `sum by (shape) (increase(${m}{${s}}[1h]))`);
  const [calls, secs, exam] = await Promise.all([
    q('watchlog_mongodb_statement_calls_total'),
    q('watchlog_mongodb_statement_seconds_total'),
    q('watchlog_mongodb_statement_docs_examined_total'),
  ]);
  const m = (r: QuerySeries[]) =>
    new Map(r.map((x) => [x.labels.shape ?? '', x.points[0]?.[1] ?? 0]));
  return { calls: m(calls), secs: m(secs), exam: m(exam) };
}

const shapeLink = (id: string, f: StatementFact | undefined): Link => {
  const text = f?.text ?? id;
  return { kind: 'statement', id, name: text.length > 60 ? `${text.slice(0, 60)}…` : text };
};

/** Which source counts the shapes, and what it can't see. */
async function sourceOf(ctx: PageContext): Promise<'querystats' | 'slowlog' | null> {
  const r = await instant(
    ctx,
    `max by (source) (last_over_time(watchlog_mongodb_shape_source{${one(ctx.row.id)}}[10m]))`,
  );
  if (r.some((x) => x.labels.source === 'querystats')) return 'querystats';
  return r.length ? 'slowlog' : null;
}

const ms = (v: number) => (v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`);

// ------------------------------------------------------------------------- Overview

export async function overview(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const s = one(ctx.row.id);
  const [
    ops,
    reads,
    opsUsual,
    conns,
    lag,
    slow1h,
    slowScans,
    allScans,
    cache,
    evicting,
    queued,
    window,
    isSet,
    primarySeen,
    p95,
    fs,
    fsGrowth,
    data,
    p50Series,
    p95Series,
    cacheSeries,
    dirtySeries,
    scanSeries,
    owners,
    hour,
    senders,
  ] = await Promise.all([
    instant(ctx, `sum(rate(watchlog_mongodb_ops_total{${s}}[${RATE}]))`),
    instant(ctx, `sum(rate(watchlog_mongodb_ops_total{${s}, op=~"query|getmore"}[${RATE}]))`),
    instant(
      ctx,
      `avg_over_time(sum(rate(watchlog_mongodb_ops_total{${s}}[5m]))[6h:5m] offset 15m)`,
    ),
    instant(ctx, connsBy(s)),
    instant(ctx, `max(watchlog_mongodb_replication_lag_seconds{${s}})`),
    instant(ctx, `sum(increase(watchlog_mongodb_slow_ops_total{${s}}[1h]))`),
    instant(ctx, `sum(rate(watchlog_mongodb_slow_ops_total{${s}, plan="collscan"}[5m])) * 60`),
    instant(ctx, `sum(rate(watchlog_mongodb_collection_scans_total{${s}}[5m])) * 60`),
    instant(ctx, `max by (state) (watchlog_mongodb_cache_bytes{${s}})`),
    instant(
      ctx,
      `sum(rate(watchlog_mongodb_app_eviction_seconds_total{${s}}[5m])) or sum(rate(watchlog_mongodb_app_evicted_pages_total{${s}}[5m]))`,
    ),
    instant(ctx, `max(sum by (member) (watchlog_mongodb_queued{${s}}))`),
    instant(ctx, `min(watchlog_mongodb_oplog_window_seconds{${s}})`),
    instant(ctx, `max(watchlog_mongodb_replica_set{${s}})`),
    instant(ctx, `max(watchlog_mongodb_primary_seen{${s}})`),
    instant(
      ctx,
      `histogram_quantile(0.95, sum by (le) (rate(watchlog_mongodb_op_latency_bucket{${s}, type="reads"}[5m])))`,
    ),
    instant(ctx, `max by (state) (watchlog_mongodb_fs_bytes{${s}})`),
    instant(
      ctx,
      `(deriv(max(watchlog_mongodb_fs_bytes{${s}, state="used"})[7d:1h]) and max(last_over_time(watchlog_mongodb_fs_bytes{${s}, state="used"}[1h] offset 1d))) * 86400`,
    ),
    instant(ctx, `sum(max by (db) (watchlog_mongodb_db_data_bytes{${s}}))`),
    range(
      ctx,
      `histogram_quantile(0.5, sum by (le) (rate(watchlog_mongodb_op_latency_bucket{${s}, type="reads"}[5m])))`,
    ),
    range(
      ctx,
      `histogram_quantile(0.95, sum by (le) (rate(watchlog_mongodb_op_latency_bucket{${s}, type="reads"}[5m])))`,
    ),
    range(
      ctx,
      `max(watchlog_mongodb_cache_bytes{${s}, state="used"} / on (member) watchlog_mongodb_cache_bytes{${s}, state="max"})`,
    ),
    range(
      ctx,
      `max(watchlog_mongodb_cache_bytes{${s}, state="dirty"} / on (member) watchlog_mongodb_cache_bytes{${s}, state="max"})`,
    ),
    range(ctx, `sum(rate(watchlog_mongodb_slow_ops_total{${s}, plan="collscan"}[5m]))`),
    ownersOf(ctx),
    lastHour(ctx),
    sentBy(ctx, E),
  ]);
  const ex = extraOf(ctx);
  const facts = statementFacts(ctx, E);
  const total = valueOf(ops);
  const r = valueOf(reads) ?? 0;
  const usual = valueOf(opsUsual);
  const busiest = busiestMember(conns).get('');
  const c = busiest?.c ?? null;
  const max = busiest ? busiest.c + busiest.a : null;
  const pct = c !== null && max ? c / max : null;
  const lagS = valueOf(lag);
  const standalone = valueOf(isSet) === 0;
  const st = (k: string) => cache.find((x) => x.labels.state === k)?.points[0]?.[1] ?? null;
  const cacheMax = st('max');
  const cacheUsed = cacheMax && st('used') !== null ? st('used')! / cacheMax : null;
  const cacheDirty = cacheMax && st('dirty') !== null ? st('dirty')! / cacheMax : null;
  const appEvict = (valueOf(evicting) ?? 0) > 0;
  const win = valueOf(window);
  const scansMin = valueOf(slowScans) ?? 0;
  const q = valueOf(queued) ?? 0;
  const fsv = (k: string) => fs.find((x) => x.labels.state === k)?.points[0]?.[1] ?? null;
  const perDay = valueOf(fsGrowth);
  const days =
    perDay && perDay > 0 && fsv('total') && fsv('used') !== null
      ? Math.floor((fsv('total')! - fsv('used')!) / perDay)
      : null;
  const members = membersOf(ex);
  const clients = [...clientsBy(ex, owners).values()].sort((a, b) => b.n - a.n);
  // The client sending the shape that scans most (the finding's client), said in the flow.
  const scanner = topScanner(facts, hour, senders, owners);

  const flow: FlowPanel = {
    id: 'flow',
    title: `${P}.flow.title`,
    kind: 'flow',
    span: 2,
    state: total === null ? 'empty' : 'ok',
    note: { key: `${P}.flow.note` },
    columns: [
      {
        id: 'clients',
        title: { key: `${D}.flow.clients`, values: { n: clients.length } },
        value: c,
        unit: 'count',
        valueKey: `${D}.flow.connections`,
        rows: [
          ...(scanner ? clients.filter((x) => x.name === scanner.name) : []),
          ...clients.filter((x) => x.name !== scanner?.name),
        ]
          .slice(0, 3)
          .map((x) => ({
            name: x.name,
            value: x.n,
            unit: 'count' as const,
            ...(x.link ? { link: x.link } : {}),
            ...(x.name === scanner?.name
              ? {
                  text: { key: `${P}.flow.scans`, values: { n: x.n } },
                  severity: 'warning' as Severity,
                }
              : {}),
          })),
        nextText: max ? { key: `${D}.flow.ofMax`, values: { n: c ?? 0, max } } : undefined,
      },
      {
        id: 'operations',
        title: { key: `${P}.flow.operations` },
        value: total,
        unit: 'per_second',
        valueKey: `${P}.flow.opsPerSecond`,
        ...(scansMin > 0 ? { severity: 'warning' as Severity } : {}),
        rows: [
          {
            name: '',
            nameKey: `${P}.flow.scans`,
            value: null,
            unit: 'count' as const,
            text: { key: `${P}.flow.perMin`, values: { n: Math.round(valueOf(allScans) ?? 0) } },
            ...(scansMin > 0 ? { severity: 'warning' as Severity } : {}),
          },
          { name: '', nameKey: `${P}.flow.p95read`, value: valueOf(p95), unit: 'seconds' as const },
          {
            name: '',
            nameKey: `${P}.flow.queued`,
            value: q,
            unit: 'count' as const,
            ...(q > 0 ? { severity: 'warning' as Severity } : {}),
          },
          {
            name: '',
            nameKey: `${P}.flow.reads`,
            value: total ? r / total : null,
            unit: 'ratio' as const,
          },
        ],
        next: total,
      },
      {
        id: 'replica',
        title: standalone
          ? { key: `${P}.flow.standalone` }
          : { key: `${P}.flow.replicaSet`, values: { n: members.length } },
        value: standalone ? null : lagS,
        unit: 'seconds',
        valueKey: standalone ? undefined : `${P}.flow.behind`,
        ...(!standalone && valueOf(primarySeen) === 0 ? { severity: 'critical' as Severity } : {}),
        rows: [
          ...members.slice(0, 3).map((m) => ({
            name: m.name,
            value: null,
            unit: 'seconds' as const,
            text: {
              key: m.state === 'SECONDARY' ? `${P}.flow.secondaryLag` : `${P}.flow.state`,
              values: { state: m.state, lag: duration(m.lag) },
            },
            ...(!m.health || !healthy.has(m.state)
              ? { severity: 'critical' as Severity }
              : m.state === 'SECONDARY' && m.lag > LAG_LINE
                ? { severity: 'warning' as Severity }
                : {}),
          })),
          ...(win !== null
            ? [
                {
                  name: '',
                  nameKey: `${P}.flow.oplog`,
                  value: win,
                  unit: 'seconds' as const,
                  ...(win < OPLOG_DAY ? { severity: 'warning' as Severity } : {}),
                },
              ]
            : []),
        ],
      },
      {
        id: 'storage',
        title: { key: `${P}.flow.storage` },
        value: cacheUsed,
        unit: 'ratio',
        valueKey: `${P}.flow.ofCache`,
        ...(cacheUsed !== null && cacheUsed > 0.9 ? { severity: 'warning' as Severity } : {}),
        rows: [
          { name: '', nameKey: `${P}.flow.dirty`, value: cacheDirty, unit: 'ratio' as const },
          { name: '', nameKey: `${P}.flow.data`, value: valueOf(data), unit: 'bytes' as const },
          {
            name: '',
            nameKey: `${D}.flow.fullIn`,
            value: null,
            unit: 'count' as const,
            text:
              days !== null
                ? { key: `${D}.flow.days`, values: { n: days } }
                : { key: `${D}.tiles.notGrowing` },
            ...(days !== null && days < 14 ? { severity: 'warning' as Severity } : {}),
          },
        ],
      },
    ],
  };

  const unhealthy = members.filter((m) => !m.health || !healthy.has(m.state));
  const worstLag = Math.max(0, ...members.filter((m) => m.state === 'SECONDARY').map((m) => m.lag));
  const checks: ChecksPanel = {
    id: 'checks',
    title: `${D}.checks.title`,
    kind: 'checks',
    span: 1,
    layout: 'side',
    state: total === null ? 'empty' : 'ok',
    items: [
      {
        id: 'collscan',
        labelKey: `${P}.checks.collscan`,
        state: scansMin >= 1 ? 'fail' : scansMin > 0 ? 'warn' : 'pass',
        value: { key: `${P}.checks.perMin`, values: { n: Math.round(scansMin) } },
        link: { kind: 'tab', tab: 'operations', name: 'operations' },
      },
      {
        id: 'cache',
        labelKey: `${P}.checks.cache`,
        state:
          cacheUsed !== null && cacheUsed > 0.9 ? (cacheUsed > 0.95 ? 'fail' : 'warn') : 'pass',
        value: {
          key: `${D}.checks.pct`,
          values: { pct: cacheUsed === null ? null : Math.round(cacheUsed * 100) },
        },
        link: { kind: 'tab', tab: 'storage', name: 'storage' },
      },
      {
        id: 'queued',
        labelKey: `${P}.checks.queued`,
        state: q > 0 ? 'warn' : 'pass',
        value: { key: `${P}.checks.queuedN`, values: { n: Math.round(q) } },
      },
      {
        id: 'primary',
        labelKey: `${P}.checks.primary`,
        state: standalone ? 'pass' : valueOf(primarySeen) === 0 ? 'fail' : 'pass',
        value: standalone
          ? { key: `${P}.standalone` }
          : {
              key: `${P}.checks.name`,
              values: { name: members.find((m) => m.state === 'PRIMARY')?.name ?? '–' },
            },
      },
      {
        id: 'members',
        labelKey: `${P}.checks.members`,
        state: unhealthy.length ? 'fail' : 'pass',
        value: standalone
          ? { key: `${P}.standalone` }
          : {
              key: `${P}.checks.ofUp`,
              values: { n: members.length - unhealthy.length, of: members.length },
            },
        link: { kind: 'tab', tab: 'replica', name: 'replica' },
      },
      {
        id: 'lag',
        labelKey: `${P}.checks.lag`,
        state: worstLag > LAG_LINE ? (worstLag > 60 ? 'fail' : 'warn') : 'pass',
        value: standalone
          ? { key: `${P}.standalone` }
          : { key: `${D}.checks.lag`, values: { lag: duration(worstLag) } },
      },
      {
        id: 'connections',
        labelKey: `${D}.checks.connections`,
        state: pct !== null && pct > 0.8 ? (pct > 0.95 ? 'fail' : 'warn') : 'pass',
        value: {
          key: `${D}.checks.pct`,
          values: { pct: pct === null ? null : Math.round(pct * 100) },
        },
      },
      {
        id: 'oplog',
        labelKey: `${P}.checks.oplog`,
        state: win !== null && win < OPLOG_DAY ? (win < OPLOG_DAY / 2 ? 'fail' : 'warn') : 'pass',
        value:
          standalone || win === null
            ? { key: `${P}.standalone` }
            : { key: `${D}.checks.lag`, values: { lag: duration(win) } },
      },
    ],
  };

  // When the collection scans began in this range: the first point of the last run above zero.
  const scanPts = pointsOf(scanSeries[0]);
  let scanStart: number | null = null;
  for (let i = scanPts.length - 1; i >= 0; i--) {
    if ((scanPts[i]![1] ?? 0) <= 0) break;
    scanStart = scanPts[i]![0];
  }
  const markers =
    scanStart && scanStart > scanPts[0]![0]
      ? [
          {
            at: scanStart,
            text: { key: `${P}.marker.scans` } as Text,
            severity: 'warning' as Severity,
          },
        ]
      : [];

  return [
    flow,
    {
      id: 'summary',
      title: `${D}.tiles.title`,
      kind: 'stat',
      span: 2,
      state: total === null ? 'empty' : 'ok',
      tiles: [
        {
          id: 'ops',
          labelKey: `${P}.tiles.ops`,
          value: total,
          unit: 'per_second',
          sub:
            usual !== null && total !== null
              ? { key: `${P}.tiles.usual`, values: { n: Math.round(usual) } }
              : total
                ? { key: `${P}.readsPct`, values: { pct: Math.round((r / total) * 100) } }
                : undefined,
        },
        {
          id: 'slow',
          labelKey: `${P}.slowOps`,
          value: valueOf(slow1h) === null ? null : Math.round(valueOf(slow1h)!),
          unit: 'count',
          sub: { key: `${P}.tiles.lastHour` },
          ...((valueOf(slow1h) ?? 0) > 0 ? { severity: 'warning' as Severity } : {}),
        },
        {
          id: 'connections',
          labelKey: `${P}.connections`,
          value: pct,
          unit: 'ratio',
          sub: max ? { key: `${D}.flow.ofMax`, values: { n: c ?? 0, max } } : undefined,
          ...(pct !== null && pct > 0.8 ? { severity: 'warning' as Severity } : {}),
        },
        {
          id: 'lag',
          labelKey: `${P}.replicationLag`,
          value: standalone ? null : lagS,
          unit: 'seconds',
          sub: standalone ? { key: `${P}.standalone` } : { key: `${P}.tiles.worstSecondary` },
          ...(lagS !== null && lagS > LAG_LINE ? { severity: 'warning' as Severity } : {}),
        },
        {
          id: 'cache',
          labelKey: `${P}.cache`,
          value: cacheUsed,
          unit: 'ratio',
          sub: appEvict
            ? { key: `${P}.tiles.evicting` }
            : { key: `${P}.tiles.dirty`, values: { pct: Math.round((cacheDirty ?? 0) * 100) } },
          ...(appEvict || (cacheUsed !== null && cacheUsed > 0.9)
            ? { severity: 'warning' as Severity }
            : {}),
        },
        {
          id: 'oplog',
          labelKey: `${P}.oplogWindow`,
          value: standalone ? null : win,
          unit: 'seconds',
          sub: standalone
            ? { key: `${P}.standalone` }
            : win !== null && win >= OPLOG_DAY
              ? { key: `${P}.tiles.dayOff` }
              : { key: `${P}.tiles.underDay` },
          ...(win !== null && win < OPLOG_DAY ? { severity: 'warning' as Severity } : {}),
        },
      ],
    },
    {
      id: 'latency',
      title: `${P}.charts.latency`,
      kind: 'line',
      span: 1,
      unit: 'seconds',
      state: p95Series.length ? 'ok' : 'empty',
      note: { key: `${P}.charts.latencyNote` },
      ...(markers.length ? { markers } : {}),
      series: [
        { nameKey: `${P}.series.p95`, points: pointsOf(p95Series[0]), severity: 'warning' },
        { nameKey: `${P}.series.p50`, points: pointsOf(p50Series[0]) },
      ],
    },
    {
      id: 'cache',
      title: `${P}.charts.cache`,
      kind: 'line',
      span: 1,
      unit: 'ratio',
      state: cacheSeries.length ? 'ok' : 'empty',
      note: { key: `${P}.charts.cacheNote` },
      ...(markers.length ? { markers } : {}),
      series: [
        { nameKey: `${P}.series.used`, points: pointsOf(cacheSeries[0]) },
        { nameKey: `${P}.series.dirty`, points: pointsOf(dirtySeries[0]), severity: 'warning' },
        ...(cacheSeries[0]
          ? [
              {
                nameKey: `${P}.series.evictionLine`,
                points: pointsOf(cacheSeries[0]).map(([t]) => [t, 0.95] as [number, number]),
                dashed: true,
              },
            ]
          : []),
      ],
    },
    checks,
    slowTable(ctx, facts, hour, senders, owners),
    ...(await resourcePanels(ctx, E)),
  ];
}

/** The shape that scans most in the last hour and its sender, when one sends most of it. */
function topScanner(
  facts: Map<string, StatementFact>,
  hour: Awaited<ReturnType<typeof lastHour>>,
  senders: Awaited<ReturnType<typeof sentBy>>,
  owners: Map<string, Owner>,
) {
  const scanning = [...facts.values()]
    .filter((f) => f.collscan && (hour.calls.get(f.id) ?? 0) > 0)
    .sort((a, b) => (hour.calls.get(b.id) ?? 0) - (hour.calls.get(a.id) ?? 0));
  for (const f of scanning) {
    const sb = senders.get(f.id);
    if (sb) return { ...clientOf(owners, sb.addr), fact: f };
  }
  return null;
}

/** Slow operations, last hour (the Overview's table): count, mean, documents read, plan, sender. */
function slowTable(
  ctx: PageContext,
  facts: Map<string, StatementFact>,
  hour: Awaited<ReturnType<typeof lastHour>>,
  senders: Awaited<ReturnType<typeof sentBy>>,
  owners: Map<string, Owner>,
): TablePanel {
  const ids = [...hour.calls.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  return {
    id: 'slow',
    title: `${P}.slowHour.title`,
    kind: 'table',
    span: 1,
    layout: 'main',
    state: ids.length ? 'ok' : 'empty',
    note: { key: `${P}.slowHour.note` },
    columns: [
      `${P}.cols.shape`,
      `${P}.cols.collection`,
      `${P}.cols.count`,
      `${P}.cols.mean`,
      `${P}.cols.docsRead`,
      `${P}.cols.plan`,
      `${D}.cols.sentBy`,
    ],
    rows: ids.slice(0, 5).map((id) => {
      const f = facts.get(id);
      const n = hour.calls.get(id) ?? 0;
      const sb = senders.get(id);
      return {
        cells: [
          f?.text ?? id,
          f?.ns ?? '–',
          Math.round(n),
          n > 0 ? ms((hour.secs.get(id) ?? 0) / n) : '–',
          n > 0 ? compact((hour.exam.get(id) ?? 0) / n) : '–',
          f?.plan || '–',
          sb ? clientOf(owners, sb.addr).name : '–',
        ],
        link: shapeLink(id, f),
        ...(f?.collscan ? { severity: 'warning' as Severity } : {}),
      };
    }),
  };
}

/** 4.1 M, 310 k, 40. */
export function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)} k`;
  return String(Math.round(n));
}

// ------------------------------------------------------------------------- Operations

export async function operations(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const s = one(ctx.row.id);
  const seconds = Math.max(ctx.range, 300);
  const [stats, senders, owners, source, hist, busiest] = await Promise.all([
    statementStats(ctx, E),
    sentBy(ctx, E),
    ownersOf(ctx),
    sourceOf(ctx),
    instant(ctx, `sum by (le) (increase(watchlog_mongodb_op_latency_bucket{${s}}[${seconds}s]))`),
    instant(
      ctx,
      `topk(15, sum by (ns) (rate(watchlog_mongodb_collection_time_seconds_total{${s}}[${seconds}s])))`,
    ),
  ]);
  const facts = statementFacts(ctx, E);
  const ids = [...new Set([...stats.keys(), ...facts.keys()])].sort(
    (a, b) => (stats.get(b)?.share ?? 0) - (stats.get(a)?.share ?? 0),
  );
  const none = new Map<string, number>();
  const hinted = [...facts.values()].filter((f) => missingIndex(E, f, none));
  const LE = ['0.001', '0.01', '0.1', '1', '10', '+Inf'];
  const LABELS = ['≤1 ms', '≤10 ms', '≤100 ms', '≤1 s', '≤10 s', '>10 s'];
  const cum = LE.map((le) => hist.find((x) => x.labels.le === le)?.points[0]?.[1] ?? 0);
  const totalH = cum.at(-1) ?? 0;
  return [
    {
      id: 'top',
      title: `${P}.shapes.title`,
      kind: 'statements',
      span: 2,
      state: ids.length ? 'ok' : 'empty',
      note: { key: `${P}.shapes.source.${source ?? 'none'}` },
      shareOf: 'time',
      full: true,
      total: ids.length,
      rows: statementRows(E, ids, stats, facts, senders, owners, none),
    },
    {
      id: 'indexes',
      title: `${P}.missingIndex.title`,
      kind: 'table',
      span: 2,
      state: hinted.length ? 'ok' : 'empty',
      note: { key: `${P}.missingIndex.note` },
      columns: [
        `${P}.cols.shape`,
        `${P}.cols.collection`,
        `${P}.cols.fields`,
        `${P}.cols.examinedPerReturned`,
        `${P}.cols.plan`,
        `${D}.cols.sentBy`,
      ],
      rows: hinted.slice(0, 15).map((f) => {
        const sb = senders.get(f.id);
        return {
          cells: [
            f.text,
            f.ns ?? '–',
            f.fields ? f.fields.split(',').join(', ') : '–',
            compact((f.examined ?? 0) / Math.max(f.sent ?? 0, 1)),
            f.plan || '–',
            sb ? clientOf(owners, sb.addr).name : '–',
          ],
          link: shapeLink(f.id, f),
          severity: 'warning' as Severity,
        };
      }),
    },
    {
      id: 'latency',
      title: `${P}.latency`,
      kind: 'hist',
      span: 1,
      state: totalH > 0 ? 'ok' : 'empty',
      note: { key: `${P}.latencyNote` },
      buckets: LABELS.map((label, i) => ({
        label,
        share: totalH ? Math.max(0, cum[i]! - (i ? cum[i - 1]! : 0)) / totalH : 0,
      })),
    },
    {
      id: 'busiest',
      title: `${P}.busiest`,
      kind: 'bars',
      span: 1,
      unit: 'seconds',
      state: busiest.length ? 'ok' : 'empty',
      note: { key: `${P}.busiestNote` },
      items: busiest
        .map((x) => ({ label: x.labels.ns ?? '', value: x.points[0]?.[1] ?? 0 }))
        .filter((x) => x.value > 0)
        .sort((a, b) => b.value - a.value),
    },
  ];
}

// ------------------------------------------------------------------------- Waits

export async function waitsTab(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const { end, dur } = periodOf(ctx);
  const [chart, over, shapes, clients, owners, stats, senders] = await Promise.all([
    waitsChart(ctx, E),
    waitsOver(ctx, E, end, dur),
    statementsByWaits(ctx, E, end, dur),
    clientsByWaits(ctx, E, end, dur),
    ownersOf(ctx),
    statementStats(ctx, E),
    sentBy(ctx, E),
  ]);
  const facts = statementFacts(ctx, E);
  const totalShape = shapes.reduce((a, b) => a + b.sessions, 0);
  const share = new Map(shapes.map((x) => [x.id, totalShape > 0 ? x.sessions / totalShape : 0]));
  const top = dominantWait(over);
  const old = (Number((ctx.row.version ?? '').split('.')[0]) || 99) < 8;
  return [
    { ...chart, note: { key: `${P}.waits.note${old ? 'Old' : ''}` } } as Panel,
    {
      id: 'summary',
      title: `${D}.waitsSummary.title`,
      kind: 'facts',
      span: 2,
      state: over.total > 0 ? 'ok' : 'empty',
      note: { key: `${D}.waitsSummary.period`, values: { from: end - dur, to: end } },
      rows: [
        {
          labelKey: `${P}.waits.average`,
          value: Math.round(over.total * 100) / 100,
          unit: 'count',
        },
        ...E.waits.map((w) => ({
          labelKey: `${D}.wait.${w}`,
          value: over.total > 0 ? (over.by[w] ?? 0) / over.total : 0,
          unit: 'ratio' as const,
        })),
        ...(top && top.wait !== 'running' && top.share >= 0.5
          ? [
              {
                labelKey: `${D}.waitsSummary.mostly`,
                value: null,
                text: {
                  key: `${D}.waitsSummary.mostlyText`,
                  values: { pct: Math.round(top.share * 100), wait: top.wait },
                },
              },
            ]
          : []),
      ],
    },
    {
      id: 'by-statement',
      title: `${P}.waits.byShape`,
      kind: 'statements',
      span: 2,
      state: shapes.length ? 'ok' : 'empty',
      shareOf: 'waits',
      full: false,
      total: shapes.length,
      rows: statementRows(
        E,
        shapes
          .filter((x) => x.id !== 'other')
          .slice(0, 10)
          .map((x) => x.id),
        stats,
        facts,
        senders,
        owners,
        new Map(),
        share,
      ),
    },
    {
      id: 'by-client',
      title: `${P}.waits.byClient`,
      kind: 'bars',
      span: 2,
      unit: 'count',
      state: clients.length ? 'ok' : 'empty',
      note: { key: `${P}.waits.byClientNote` },
      items: clients.slice(0, 15).map((x) => ({
        label: `${clientOf(owners, x.addr).name}${x.wait && x.wait !== 'running' ? ` · ${x.wait}` : ''}`,
        value: Math.round(x.sessions * 100) / 100,
        ...(x.wait && E.severe[x.wait] ? { severity: E.severe[x.wait] } : {}),
      })),
    },
  ];
}

// ------------------------------------------------------------------------- Clients

export async function clientsTab(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const s = one(ctx.row.id);
  const [owners, activeNow, current, created, cursors] = await Promise.all([
    ownersOf(ctx),
    instant(ctx, `sum by (addr) (watchlog_mongodb_client_active_sessions{${s}})`),
    range(ctx, `max(watchlog_mongodb_connections{${s}, state="current"})`),
    range(ctx, `sum(rate(watchlog_mongodb_connections_created_total{${s}}[${RATE}]))`),
    instant(ctx, `max by (kind) (watchlog_mongodb_cursors_open{${s}})`),
  ]);
  const ex = extraOf(ctx);
  const active = new Map(activeNow.map((x) => [x.labels.addr ?? '', x.points[0]?.[1] ?? 0]));
  const rows = [...clientsBy(ex, owners).values()].sort((a, b) => b.n - a.n);
  const txns = [...(ex.transactions ?? [])].sort((a, b) => b.age - a.age);
  const cur = [...(ex.cursors ?? [])].sort((a, b) => b.idle - a.idle);
  const noTimeout = cursors.find((x) => x.labels.kind === 'notimeout')?.points[0]?.[1] ?? null;
  return [
    {
      id: 'clients',
      title: `${D}.clients.title`,
      kind: 'table',
      span: 2,
      state: rows.length ? 'ok' : 'empty',
      note: { key: `${P}.clients.note` },
      columns: [
        `${D}.cols.client`,
        `${P}.cols.app`,
        `${D}.cols.connections`,
        `${P}.cols.opened`,
        `${P}.cols.activeNow`,
      ],
      rows: rows.slice(0, 50).map((x) => ({
        cells: [
          x.name,
          x.app || '–',
          x.n,
          x.opened,
          Math.round([...x.addrs].reduce((a, ad) => a + (active.get(ad) ?? 0), 0)),
        ],
        ...(x.link ? { link: x.link } : {}),
        ...(x.opened > Math.max(5, x.n) ? { severity: 'warning' as Severity } : {}),
      })),
    },
    {
      id: 'connections',
      title: `${P}.clients.connections`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: current.length ? 'ok' : 'empty',
      series: [{ nameKey: `${D}.series.connected`, points: pointsOf(current[0]) }],
    },
    {
      id: 'churn',
      title: `${P}.clients.churn`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: created.length ? 'ok' : 'empty',
      note: { key: `${P}.clients.churnNote` },
      series: [{ nameKey: `${P}.series.opened`, points: pointsOf(created[0]) }],
    },
    {
      id: 'transactions',
      title: `${P}.transactions.title`,
      kind: 'table',
      span: 2,
      state: txns.length ? 'ok' : 'empty',
      note: { key: `${P}.transactions.note` },
      columns: [`${D}.cols.client`, `${D}.cols.state`, `${D}.cols.open`, `${D}.cols.idle`],
      rows: txns.map((t) => ({
        cells: [clientOf(owners, t.addr, t.app).name, t.state, duration(t.age), duration(t.idle)],
        ...(t.age >= TXN_LONG ? { severity: 'warning' as Severity } : {}),
      })),
    },
    {
      id: 'cursors',
      title: `${P}.cursors.title`,
      kind: 'table',
      span: 2,
      state: cur.length ? 'ok' : 'empty',
      note: {
        key: `${P}.cursors.note`,
        values: { n: noTimeout === null ? '–' : Math.round(noTimeout) },
      },
      columns: [`${P}.cols.collection`, `${P}.cols.idleFor`, `${D}.cols.open`],
      rows: cur.map((x) => ({
        cells: [x.ns, duration(x.idle), duration(x.age)],
        ...(x.idle > 600 ? { severity: 'warning' as Severity } : {}),
      })),
    },
  ];
}

// ------------------------------------------------------------------------- Replica set

export async function replicaTab(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const s = one(ctx.row.id);
  const [lag, ping, elections, flow, rbid, used, max, window, fillRate, isSet] = await Promise.all([
    range(ctx, `max by (rs_member) (watchlog_mongodb_replication_lag_seconds{${s}})`),
    range(ctx, `max by (rs_member) (watchlog_mongodb_member_ping_seconds{${s}})`),
    range(ctx, `max by (rs_member, reason) (watchlog_mongodb_election_timestamp_seconds{${s}})`),
    range(ctx, `max(watchlog_mongodb_flow_control_lagged{${s}})`),
    instant(ctx, `max(increase(watchlog_mongodb_rollback_id{${s}}[${ctx.range}s]))`),
    instant(ctx, `max(watchlog_mongodb_oplog_bytes{${s}, state="used"})`),
    instant(ctx, `max(watchlog_mongodb_oplog_bytes{${s}, state="max"})`),
    instant(ctx, `min(watchlog_mongodb_oplog_window_seconds{${s}})`),
    instant(ctx, `max(deriv(watchlog_mongodb_oplog_bytes{${s}, state="used"}[1h])) * 3600`),
    instant(ctx, `max(watchlog_mongodb_replica_set{${s}})`),
  ]);
  const ex = extraOf(ctx);
  const members = membersOf(ex);
  const standalone = valueOf(isSet) === 0;
  const note = standalone ? { key: `${P}.standaloneNote` } : undefined;
  const u = valueOf(used);
  const m = valueOf(max);
  const w = valueOf(window);
  const full = u !== null && m ? u / m > 0.9 : false;
  // Each election once: a member became primary at the time its series holds.
  const seen = new Set<string>();
  const events = elections
    .flatMap((x) =>
      pointsOf(x)
        .map(([, v]) => v)
        .filter((v): v is number => v !== null)
        .map((v) => ({ at: v, member: x.labels.rs_member ?? '', reason: x.labels.reason ?? '' })),
    )
    .filter((e) => {
      const k = `${e.member}\u0000${e.at}`;
      if (seen.has(k) || e.at < Math.floor(ctx.now / 1000) - ctx.range) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.at - b.at);
  const rollbacks = Math.round(valueOf(rbid) ?? 0);
  const first = lag[0]?.points ?? [];
  return [
    {
      id: 'members',
      title: `${P}.members`,
      kind: 'table',
      span: 2,
      state: members.length ? 'ok' : 'empty',
      ...(note ? { note } : {}),
      columns: [
        `${P}.cols.member`,
        `${P}.cols.state`,
        `${P}.cols.health`,
        `${P}.cols.lag`,
        `${P}.cols.ping`,
        `${P}.cols.priority`,
        `${P}.cols.votes`,
      ],
      rows: members.map((x) => ({
        cells: [
          x.name,
          x.state,
          x.health ? 'up' : 'down',
          x.state === 'SECONDARY' ? duration(x.lag) : '–',
          x.ping !== undefined ? `${Math.round(x.ping * 1000)} ms` : '–',
          x.priority ?? '–',
          x.votes ?? '–',
        ],
        severity:
          !x.health || !healthy.has(x.state)
            ? ('critical' as Severity)
            : x.state === 'SECONDARY' && x.lag > LAG_LINE
              ? ('warning' as Severity)
              : undefined,
      })),
    },
    {
      id: 'lag',
      title: `${P}.lag`,
      kind: 'line',
      span: 1,
      unit: 'seconds',
      state: lag.length ? 'ok' : 'empty',
      ...(note ? { note } : {}),
      series: [
        ...lag.map((x) => ({ name: x.labels.rs_member ?? '', points: pointsOf(x) })),
        ...(first.length
          ? [
              {
                nameKey: `${P}.replica.lagLine`,
                points: first.map(([t]) => [t, LAG_LINE] as [number, number]),
                dashed: true,
              },
            ]
          : []),
      ],
    },
    {
      id: 'ping',
      title: `${P}.replica.ping`,
      kind: 'line',
      span: 1,
      unit: 'seconds',
      state: ping.length ? 'ok' : 'empty',
      note: { key: `${P}.replica.pingNote` },
      series: ping.map((x) => ({ name: x.labels.rs_member ?? '', points: pointsOf(x) })),
    },
    {
      id: 'oplog',
      title: `${P}.replica.oplog`,
      kind: 'facts',
      span: 1,
      state: w === null ? 'empty' : 'ok',
      ...(note ? { note } : {}),
      rows: [
        { labelKey: `${P}.oplogWindow`, value: w, unit: 'seconds' },
        { labelKey: `${P}.replica.oplogUsed`, value: u, unit: 'bytes' },
        { labelKey: `${P}.replica.oplogMax`, value: m, unit: 'bytes' },
        {
          labelKey: `${P}.replica.fills`,
          value: null,
          text: full
            ? { key: `${P}.replica.fullHolds`, values: { d: w === null ? '–' : duration(w) } }
            : (valueOf(fillRate) ?? 0) > 0
              ? { key: `${P}.replica.perHour`, values: { size: bytes(valueOf(fillRate)!) } }
              : { key: `${D}.tiles.notGrowing` },
        },
        {
          labelKey: `${P}.replica.rollbacks`,
          value: rollbacks,
          unit: 'count',
        },
      ],
    },
    {
      id: 'elections',
      title: `${P}.replica.elections`,
      kind: 'timeline',
      span: 1,
      state: events.length ? 'ok' : 'empty',
      note: { key: `${P}.replica.electionsNote` },
      events: events.map((e) => ({
        at: e.at,
        text: {
          key: e.reason ? `${P}.replica.elected` : `${P}.replica.electedNoReason`,
          values: { member: e.member, reason: e.reason },
        },
        sourceKey: `${P}.replica.source`,
        severity: 'warning' as Severity,
      })),
    },
    {
      id: 'flow-control',
      title: `${P}.replica.flowControl`,
      kind: 'line',
      span: 2,
      unit: 'count',
      state: flow.length ? 'ok' : 'empty',
      note: { key: `${P}.replica.flowControlNote` },
      zeroKey: `${P}.replica.flowControlZero`,
      series: [{ nameKey: `${P}.series.lagged`, points: pointsOf(flow[0]), severity: 'warning' }],
    },
  ];
}

// ------------------------------------------------------------------------- Collections

export async function collectionsTab(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const s = one(ctx.row.id);
  const by = (m: string) => instant(ctx, `max by (ns) (${m}{${s}})`);
  const [size, data, docs, avg, free, growth, fs, fsGrowth] = await Promise.all([
    by('watchlog_mongodb_collection_size_bytes'),
    by('watchlog_mongodb_collection_data_bytes'),
    by('watchlog_mongodb_collection_documents'),
    by('watchlog_mongodb_collection_avg_doc_bytes'),
    by('watchlog_mongodb_collection_free_bytes'),
    instant(
      ctx,
      `max by (ns) (deriv(watchlog_mongodb_collection_size_bytes{${s}}[7d]) and last_over_time(watchlog_mongodb_collection_size_bytes{${s}}[1h] offset 1d)) * 86400`,
    ),
    instant(ctx, `max by (state) (watchlog_mongodb_fs_bytes{${s}})`),
    instant(
      ctx,
      `(deriv(max(watchlog_mongodb_fs_bytes{${s}, state="used"})[7d:1h]) and max(last_over_time(watchlog_mongodb_fs_bytes{${s}, state="used"}[1h] offset 1d))) * 86400`,
    ),
  ]);
  const ex = extraOf(ctx);
  const v = (r: QuerySeries[], ns: string) =>
    r.find((x) => x.labels.ns === ns)?.points[0]?.[1] ?? null;
  const names = size
    .map((x) => ({ ns: x.labels.ns ?? '', n: x.points[0]?.[1] ?? 0 }))
    .sort((a, b) => b.n - a.n)
    .map((x) => x.ns);
  const unused = unusedEverywhere(ex);
  const redundant = uniqueIndexes(ex.redundant_indexes ?? []);
  const builds = ex.index_builds ?? [];
  const fv = (k: string) => fs.find((x) => x.labels.state === k)?.points[0]?.[1] ?? null;
  const volume =
    fv('total') && fv('used') !== null
      ? { used: fv('used')!, capacity: fv('total')!, perDay: valueOf(fsGrowth), name: 'Disk' }
      : null;
  return [
    {
      id: 'collections',
      title: `${P}.collections.title`,
      kind: 'table',
      span: 2,
      state: names.length ? 'ok' : 'empty',
      note: { key: `${P}.collections.note` },
      columns: [
        `${P}.cols.collection`,
        `${P}.cols.size`,
        `${P}.cols.data`,
        `${P}.cols.documents`,
        `${P}.cols.avgDoc`,
        `${P}.cols.reusable`,
        `${P}.cols.growth`,
      ],
      rows: names.map((ns) => {
        const g = v(growth, ns);
        const f = v(free, ns) ?? 0;
        const sz = v(size, ns) ?? 0;
        return {
          cells: [
            ns,
            bytes(sz),
            bytes(v(data, ns) ?? 0),
            compact(v(docs, ns) ?? 0),
            bytes(v(avg, ns) ?? 0),
            bytes(f),
            g === null ? '–' : `${g >= 0 ? '+' : '−'}${bytes(Math.abs(g))}/day`,
          ],
          link: collectionLink(ns),
          ...(sz > 0 && f / sz > 0.5 ? { severity: 'info' as Severity } : {}),
        };
      }),
    },
    {
      id: 'unused',
      title: `${P}.unusedIndexes`,
      kind: 'table',
      span: 1,
      state: unused.length ? 'ok' : 'empty',
      note: { key: `${P}.indexes.unusedNote` },
      columns: [`${P}.cols.collection`, `${P}.cols.index`, `${P}.cols.size`, `${D}.cols.since`],
      clock: [3],
      rows: unused.map((x) => ({
        cells: [x.ns, x.index, bytes(x.bytes ?? 0), x.since ?? null],
        link: collectionLink(x.ns),
      })),
    },
    {
      id: 'redundant',
      title: `${P}.indexes.redundant`,
      kind: 'table',
      span: 1,
      state: redundant.length ? 'ok' : 'empty',
      note: { key: `${P}.indexes.redundantNote` },
      columns: [`${P}.cols.collection`, `${P}.cols.index`, `${P}.cols.coveredBy`, `${P}.cols.size`],
      rows: redundant.map((x) => ({
        cells: [x.ns, x.index, x.covered_by ?? '–', bytes(x.bytes ?? 0)],
        link: collectionLink(x.ns),
      })),
    },
    {
      id: 'builds',
      title: `${P}.indexes.builds`,
      kind: 'table',
      span: 2,
      state: builds.length ? 'ok' : 'empty',
      columns: [`${P}.cols.collection`, `${P}.cols.progress`],
      rows: builds.map((x) => ({ cells: [x.ns, x.progress] })),
    },
    await capacityPanel(ctx, E, volume),
  ];
}

export const collectionLink = (ns: string): Link => {
  const [db, ...rest] = ns.split('.');
  return { kind: 'table', id: `${db}/${rest.join('.')}`, name: ns };
};

// ------------------------------------------------------------------------- Cache and storage

export async function storageTab(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const s = one(ctx.row.id);
  const [cache, fs, indexTotal, used, dirty, evictT, evictP, tickets, queued, ckpt, faults, colls] =
    await Promise.all([
      instant(ctx, `max by (state) (watchlog_mongodb_cache_bytes{${s}})`),
      instant(ctx, `max by (state) (watchlog_mongodb_fs_bytes{${s}})`),
      instant(ctx, `max(watchlog_mongodb_index_total_bytes{${s}})`),
      range(ctx, `max(watchlog_mongodb_cache_bytes{${s}, state="used"})`),
      range(ctx, `max(watchlog_mongodb_cache_bytes{${s}, state="dirty"})`),
      range(ctx, `sum(rate(watchlog_mongodb_app_eviction_seconds_total{${s}}[${RATE}]))`),
      range(ctx, `sum(rate(watchlog_mongodb_app_evicted_pages_total{${s}}[${RATE}]))`),
      range(ctx, `min by (op) (watchlog_mongodb_tickets{${s}, state="available"})`),
      range(ctx, `max(sum by (member) (watchlog_mongodb_queued{${s}}))`),
      range(ctx, `max(watchlog_mongodb_checkpoint_seconds{${s}})`),
      range(ctx, `sum(rate(watchlog_mongodb_page_faults_total{${s}}[${RATE}]))`),
      instant(ctx, `topk(15, max by (ns) (watchlog_mongodb_collection_size_bytes{${s}}))`),
    ]);
  const c = (st: string) => cache.find((x) => x.labels.state === st)?.points[0]?.[1] ?? 0;
  const f = (st: string) => fs.find((x) => x.labels.state === st)?.points[0]?.[1] ?? 0;
  const idx = valueOf(indexTotal);
  const timeBased = evictT.length > 0;
  return [
    {
      id: 'cache-gauge',
      title: `${P}.cacheAndDisk`,
      kind: 'gauge',
      span: 1,
      state: c('max') ? 'ok' : 'empty',
      items: [
        ...(c('max')
          ? [
              {
                labelKey: `${P}.cacheUsed`,
                value: c('used'),
                max: c('max'),
                unit: 'bytes' as const,
                warnAt: 0.9,
              },
              {
                labelKey: `${P}.cacheDirty`,
                value: c('dirty'),
                max: c('max'),
                unit: 'bytes' as const,
                warnAt: 0.2,
              },
              ...(idx !== null
                ? [
                    {
                      labelKey: `${P}.storage.indexes`,
                      value: idx,
                      max: c('max'),
                      unit: 'bytes' as const,
                      warnAt: 0.8,
                      note: { key: `${P}.storage.indexesNote` },
                    },
                  ]
                : []),
            ]
          : []),
        ...(f('total')
          ? [
              {
                labelKey: `${P}.disk`,
                value: f('used'),
                max: f('total'),
                unit: 'bytes' as const,
                warnAt: 0.85,
              },
            ]
          : []),
      ],
    },
    {
      id: 'cache',
      title: `${P}.storage.cacheOverTime`,
      kind: 'line',
      span: 1,
      unit: 'bytes',
      state: used.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.used`, points: pointsOf(used[0]) },
        { nameKey: `${P}.series.dirty`, points: pointsOf(dirty[0]), severity: 'warning' },
      ],
    },
    {
      id: 'eviction',
      title: `${P}.storage.eviction`,
      kind: 'line',
      span: 1,
      unit: timeBased ? 'seconds' : 'per_second',
      state: evictT.length || evictP.length ? 'ok' : 'empty',
      note: { key: timeBased ? `${P}.storage.evictionTime` : `${P}.storage.evictionPages` },
      zeroKey: `${P}.storage.evictionZero`,
      series: [
        {
          nameKey: `${P}.series.appEviction`,
          points: pointsOf((timeBased ? evictT : evictP)[0]),
          severity: 'warning',
        },
      ],
    },
    {
      id: 'tickets',
      title: `${P}.tickets`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: tickets.length ? 'ok' : 'empty',
      note: { key: `${P}.ticketsNote` },
      series: [
        ...['read', 'write'].map((op) => ({
          nameKey: `${P}.series.${op}`,
          points: pointsOf(tickets.find((x) => x.labels.op === op)),
        })),
        {
          nameKey: `${P}.series.queued`,
          points: pointsOf(queued[0]),
          severity: 'warning' as Severity,
        },
      ],
    },
    {
      id: 'checkpoint',
      title: `${P}.storage.checkpoint`,
      kind: 'line',
      span: 1,
      unit: 'seconds',
      state: ckpt.length ? 'ok' : 'empty',
      note: { key: `${P}.storage.checkpointNote` },
      series: [{ nameKey: `${P}.series.checkpoint`, points: pointsOf(ckpt[0]) }],
    },
    {
      id: 'faults',
      title: `${P}.storage.faults`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: faults.length ? 'ok' : 'empty',
      note: { key: `${P}.storage.faultsNote` },
      series: [{ nameKey: `${P}.series.faults`, points: pointsOf(faults[0]) }],
    },
    {
      id: 'collections',
      title: `${P}.largest`,
      kind: 'bars',
      span: 2,
      unit: 'bytes',
      state: colls.length ? 'ok' : 'empty',
      note: { key: `${P}.largestNote` },
      items: colls
        .map((x) => ({ label: x.labels.ns ?? '', value: x.points[0]?.[1] ?? 0 }))
        .sort((a, b) => b.value - a.value),
    },
    ...(await resourcePanels(ctx, E)),
  ];
}

// ------------------------------------------------------------------------- one shape

export async function shapePage(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const id = ctx.params?.statement ?? '';
  const sel = `${one(ctx.row.id)}, shape="${escapeLabelValue(id)}"`;
  const w = RATE;
  const [stats, owners, clients, mean, calls, returned, examined, keys, waits, source] =
    await Promise.all([
      statementStats(ctx, E),
      ownersOf(ctx),
      clientsOfStatement(ctx, E, id),
      range(
        ctx,
        `sum(rate(watchlog_mongodb_statement_seconds_total{${sel}}[${w}])) / sum(rate(watchlog_mongodb_statement_calls_total{${sel}}[${w}]))`,
      ),
      range(ctx, `sum(rate(watchlog_mongodb_statement_calls_total{${sel}}[${w}]))`),
      range(ctx, `sum(rate(watchlog_mongodb_statement_docs_returned_total{${sel}}[${w}]))`),
      range(ctx, `sum(rate(watchlog_mongodb_statement_docs_examined_total{${sel}}[${w}]))`),
      range(ctx, `sum(rate(watchlog_mongodb_statement_keys_examined_total{${sel}}[${w}]))`),
      range(
        ctx,
        sparseAvg(
          E,
          one(ctx.row.id),
          `watchlog_mongodb_statement_active_sessions{${sel}}`,
          'wait',
          w,
        ),
      ),
      sourceOf(ctx),
    ]);
  const st = stats.get(id);
  const f = statementFacts(ctx, E).get(id);
  const since = st?.slower && st.usual ? await slowerSince(ctx, E, id, st.usual) : null;
  const idx = missingIndex(E, f, new Map());
  const byWait = new Map(waits.map((x) => [x.labels.wait ?? '', x]));
  const perReturned = f && f.calls ? (f.examined ?? 0) / Math.max(f.sent ?? 0, 1) : null;
  return [
    {
      id: 'facts',
      title: `${P}.shape.facts`,
      kind: 'facts',
      span: 2,
      state: st || f ? 'ok' : 'empty',
      note: { key: `${P}.shapes.source.${source ?? 'none'}` },
      rows: [
        { labelKey: `${D}.statement.text`, value: f?.text ?? id },
        { labelKey: `${P}.shape.collection`, value: f?.ns ?? null },
        { labelKey: `${P}.shape.plan`, value: f?.plan || null },
        { labelKey: `${D}.statement.calls`, value: st?.calls ?? null, unit: 'per_second' },
        { labelKey: `${D}.statement.mean`, value: st?.mean ?? null, unit: 'seconds' },
        { labelKey: `${D}.statement.usual`, value: st?.usual ?? null, unit: 'seconds' },
        {
          labelKey: `${P}.shape.examinedPerReturned`,
          value: perReturned === null ? null : Math.round(perReturned),
          unit: 'count',
        },
        ...(st?.slower
          ? [
              {
                labelKey: `${D}.statement.changed`,
                value: null,
                text: {
                  key: since ? `${D}.statement.slowerSince` : `${D}.statement.slower`,
                  values: { x: Math.round(st.slower), at: since },
                },
              },
            ]
          : []),
        ...(idx
          ? [
              {
                labelKey: `${D}.statement.hint`,
                value: null,
                text: { key: `${D}.hint.index`, values: { table: idx.table } },
              },
            ]
          : []),
      ],
    },
    {
      id: 'mean',
      title: `${D}.statement.meanOverTime`,
      kind: 'line',
      span: 1,
      unit: 'seconds',
      state: mean.length ? 'ok' : 'empty',
      ...(since
        ? {
            markers: [
              {
                at: since,
                text: { key: `${D}.marker.slower`, values: { x: Math.round(st!.slower!) } },
                severity: 'warning' as Severity,
              },
            ],
          }
        : {}),
      series: [
        { nameKey: `${D}.series.mean`, points: pointsOf(mean[0]) },
        ...(st?.usual
          ? [
              {
                nameKey: `${D}.series.usual`,
                points: pointsOf(mean[0]).map(([t]) => [t, st.usual] as [number, number]),
                dashed: true,
              },
            ]
          : []),
      ],
    },
    {
      id: 'calls',
      title: `${P}.shape.callsOverTime`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: calls.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${D}.series.calls`, points: pointsOf(calls[0]) },
        { nameKey: `${P}.series.returned`, points: pointsOf(returned[0]) },
      ],
    },
    {
      id: 'examined',
      title: `${P}.shape.examined`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: examined.length ? 'ok' : 'empty',
      note: { key: `${P}.shape.examinedNote` },
      series: [
        { nameKey: `${P}.series.docsExamined`, points: pointsOf(examined[0]), severity: 'warning' },
        { nameKey: `${P}.series.keysExamined`, points: pointsOf(keys[0]) },
        { nameKey: `${P}.series.returned`, points: pointsOf(returned[0]) },
      ],
    },
    {
      id: 'waits',
      title: `${D}.statement.waits`,
      kind: 'stack',
      span: 1,
      unit: 'count',
      state: waits.length ? 'ok' : 'empty',
      series: E.waits.map((wc) => ({
        nameKey: `${D}.wait.${wc}`,
        points: pointsOf(byWait.get(wc)),
        ...(E.severe[wc] ? { severity: E.severe[wc] } : {}),
      })),
    },
    {
      id: 'senders',
      title: `${D}.statement.senders`,
      kind: 'bars',
      span: 2,
      unit: 'ratio',
      state: clients.length ? 'ok' : 'empty',
      note: { key: `${P}.shape.sendersNote` },
      items: clients
        .slice(0, 10)
        .map((x) => ({ label: clientOf(owners, x.addr).name, value: x.share })),
    },
    await scopedAlerts(ctx, E, { statement: id }, [
      {
        key: 'slower',
        nameKey: `${D}.presets.slower`,
        metric: 'mongodb.statement.slower',
        op: '>',
        value: 3,
        forSeconds: 600,
        severity: 'warning',
      },
      {
        key: 'mean',
        nameKey: `${D}.presets.mean`,
        metric: 'mongodb.statement.mean',
        op: '>',
        value: 1,
        forSeconds: 300,
        severity: 'warning',
      },
    ]),
  ];
}

// ------------------------------------------------------------------------- one collection

export async function collectionPage(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const raw = ctx.params?.table ?? '';
  const [db, ...rest] = raw.split('/');
  const ns = `${db}.${rest.join('/')}`;
  const sel = `${one(ctx.row.id)}, ns="${escapeLabelValue(ns)}"`;
  const [
    size,
    data,
    docs,
    avg,
    free,
    idxBytes,
    sizeSeries,
    docsSeries,
    time,
    ops,
    stats,
    senders,
    owners,
  ] = await Promise.all([
    instant(ctx, `max(watchlog_mongodb_collection_size_bytes{${sel}})`),
    instant(ctx, `max(watchlog_mongodb_collection_data_bytes{${sel}})`),
    instant(ctx, `max(watchlog_mongodb_collection_documents{${sel}})`),
    instant(ctx, `max(watchlog_mongodb_collection_avg_doc_bytes{${sel}})`),
    instant(ctx, `max(watchlog_mongodb_collection_free_bytes{${sel}})`),
    instant(ctx, `max(watchlog_mongodb_collection_index_bytes{${sel}})`),
    range(ctx, `max(watchlog_mongodb_collection_size_bytes{${sel}})`),
    range(ctx, `max(watchlog_mongodb_collection_documents{${sel}})`),
    range(ctx, `sum(rate(watchlog_mongodb_collection_time_seconds_total{${sel}}[${RATE}]))`),
    range(ctx, `sum(rate(watchlog_mongodb_collection_ops_total{${sel}}[${RATE}]))`),
    statementStats(ctx, E),
    sentBy(ctx, E),
    ownersOf(ctx),
  ]);
  const ex = extraOf(ctx);
  const facts = statementFacts(ctx, E);
  const ids = [...facts.values()]
    .filter((f) => f.ns === ns)
    .map((f) => f.id)
    .sort((a, b) => (stats.get(b)?.share ?? 0) - (stats.get(a)?.share ?? 0));
  const unused = unusedEverywhere(ex).filter((x) => x.ns === ns);
  const redundant = uniqueIndexes(ex.redundant_indexes ?? []).filter((x) => x.ns === ns);
  return [
    {
      id: 'facts',
      title: `${P}.collection.facts`,
      kind: 'facts',
      span: 2,
      state: valueOf(size) === null ? 'empty' : 'ok',
      note: { key: `${P}.collections.note` },
      rows: [
        { labelKey: `${P}.collection.name`, value: ns },
        { labelKey: `${P}.cols.size`, value: valueOf(size), unit: 'bytes' },
        { labelKey: `${P}.cols.data`, value: valueOf(data), unit: 'bytes' },
        { labelKey: `${P}.cols.documents`, value: valueOf(docs), unit: 'count' },
        { labelKey: `${P}.cols.avgDoc`, value: valueOf(avg), unit: 'bytes' },
        { labelKey: `${P}.cols.reusable`, value: valueOf(free), unit: 'bytes' },
        { labelKey: `${P}.collection.indexes`, value: valueOf(idxBytes), unit: 'bytes' },
      ],
    },
    {
      id: 'size',
      title: `${P}.collection.sizeOverTime`,
      kind: 'line',
      span: 1,
      unit: 'bytes',
      state: sizeSeries.length ? 'ok' : 'empty',
      series: [{ nameKey: `${D}.series.size`, points: pointsOf(sizeSeries[0]) }],
    },
    {
      id: 'documents',
      title: `${P}.collection.documentsOverTime`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: docsSeries.length ? 'ok' : 'empty',
      series: [{ nameKey: `${P}.series.documents`, points: pointsOf(docsSeries[0]) }],
    },
    {
      id: 'time',
      title: `${P}.collection.time`,
      kind: 'line',
      span: 2,
      unit: 'per_second',
      state: ops.length ? 'ok' : 'empty',
      note: { key: `${P}.busiestNote` },
      series: [
        { nameKey: `${P}.series.ops`, points: pointsOf(ops[0]) },
        { nameKey: `${P}.series.seconds`, points: pointsOf(time[0]) },
      ],
    },
    {
      id: 'statements',
      title: `${P}.collection.shapes`,
      kind: 'statements',
      span: 2,
      state: ids.length ? 'ok' : 'empty',
      shareOf: 'time',
      full: true,
      total: ids.length,
      rows: statementRows(E, ids, stats, facts, senders, owners, new Map()),
    },
    {
      id: 'unused',
      title: `${P}.unusedIndexes`,
      kind: 'table',
      span: 1,
      state: unused.length ? 'ok' : 'empty',
      note: { key: `${P}.indexes.unusedNote` },
      columns: [`${P}.cols.index`, `${P}.cols.size`, `${D}.cols.since`],
      clock: [2],
      rows: unused.map((x) => ({ cells: [x.index, bytes(x.bytes ?? 0), x.since ?? null] })),
    },
    {
      id: 'redundant',
      title: `${P}.indexes.redundant`,
      kind: 'table',
      span: 1,
      state: redundant.length ? 'ok' : 'empty',
      note: { key: `${P}.indexes.redundantNote` },
      columns: [`${P}.cols.index`, `${P}.cols.coveredBy`, `${P}.cols.size`],
      rows: redundant.map((x) => ({ cells: [x.index, x.covered_by ?? '–', bytes(x.bytes ?? 0)] })),
    },
  ];
}
