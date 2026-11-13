// SPDX-License-Identifier: AGPL-3.0-only
// The MongoDB page (SPEC §4.12, ADR-164, v0.5 slice 2): Overview, Operations, and Cache and
// storage, from the collector's serverStatus series; replica set members, slow operations
// (getLog's "Slow query" lines as shapes), clients ($currentOp) and unused indexes from its
// status. Shapes as MongoDB 7.0 and 8.0 gave them on the e2e VM.
import { genericPage } from './generic.js';
import { duration } from './mysql.js';
import { ipOwners, type Owner } from './owners.js';
import type { QuerySeries } from '../../../lib/victoria.js';
import { instant, one, pointsOf, range, some, SPARK_RANGE, valueOf } from './query.js';
import type { IntegrationPage, PageContext, Panel, Reason, RowMetrics, Severity } from './types.js';

const P = 'integrations.mongodb.panels';
const RATE = '2m';
const LAG_LINE = 30;
const OPLOG_LINE = 86400;

/** Each member's current and available connections (labels member and state). */
const connsBy = (s: string, by = 'member') =>
  `max by (${by}, state) (watchlog_mongodb_connections{${s}, state=~"current|available"})`;

/**
 * The member nearest its connection limit, from connsBy's series, per key (the service in a
 * list, '' on a page). The limit is each member's own: a max() of current and of available
 * taken apart mixed a full primary with an idle secondary (100 of 190, 53 %, not 100 of 100).
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

export interface MongoSlow {
  ns: string;
  op: string;
  plan: string;
  count: number;
  mean_ms: number;
  max_ms: number;
  collscan: boolean;
  /** The client address that sent most of them. */
  remote: string;
  /** Unix seconds of the last one. */
  last: number;
  member: string;
  /** Only with the service's query-text switch on (ADR-138). */
  shape?: string;
  hash?: string;
}
export interface MongoMember {
  name: string;
  state: string;
  health: number;
  lag: number;
  uptime: number;
  seen_by: string;
  set: string;
}
interface Client {
  addr: string;
  app: string;
  connections: number;
  member: string;
}
interface Unused {
  ns: string;
  index: string;
  since: number;
  member: string;
}
interface Extra {
  slow?: MongoSlow[];
  members?: MongoMember[];
  clients?: Client[];
  unused_indexes?: Unused[];
}
const extra = (ctx: PageContext): Extra =>
  (ctx.row.status_details as { extra?: Extra }).extra ?? {};
const missing = (ctx: PageContext) =>
  (ctx.row.status_details as { permissions?: { tab: string; missing: string }[] }).permissions ??
  [];

/** A panel whose read was refused (the user lacks clusterMonitor). */
function needs(ctx: PageContext, tab: string): Pick<Panel, 'state' | 'missing'> | null {
  const m = missing(ctx).find((p) => p.tab === tab)?.missing;
  return m
    ? { state: 'needs_permission', missing: { key: `${P}.role`, values: { role: m } } }
    : null;
}

/** A client by its workload or container, else its address, else its application name. */
export function clientName(owners: Map<string, Owner>, addr: string, app?: string): string {
  if (addr && owners.has(addr)) return owners.get(addr)!.name;
  if (addr && addr !== '127.0.0.1' && addr !== '::1') return addr;
  return app ? `${app} (local)` : addr || 'local';
}

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const OPS = ['query', 'insert', 'update', 'delete', 'getmore', 'command'] as const;
const LABELS = ['≤1 ms', '≤10 ms', '≤100 ms', '≤1 s', '≤10 s', '>10 s'];
const LE = ['0.001', '0.01', '0.1', '1', '10', '+Inf'];
const healthy = new Set(['PRIMARY', 'SECONDARY', 'ARBITER']);

function slowRows(list: MongoSlow[], owners: Map<string, Owner>) {
  return list.map((x) => ({
    cells: [
      x.shape ? `${x.op} ${x.shape}` : x.op || '–',
      x.ns,
      ms(x.mean_ms),
      x.count,
      x.plan || '–',
      clientName(owners, x.remote),
    ],
    severity: x.collscan ? ('warning' as Severity) : undefined,
  }));
}

async function overview(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [ops, reads, conns, lag, slow, cacheUsed, cacheMax, oplog, byOp, lagSeries, isSet] =
    await Promise.all([
      instant(ctx, `sum(rate(watchlog_mongodb_ops_total{${s}}[${RATE}]))`),
      instant(ctx, `sum(rate(watchlog_mongodb_ops_total{${s}, op=~"query|getmore"}[${RATE}]))`),
      instant(ctx, connsBy(s)),
      instant(ctx, `max(watchlog_mongodb_replication_lag_seconds{${s}})`),
      instant(ctx, `sum(increase(watchlog_mongodb_slow_ops_total{${s}}[1h]))`),
      instant(ctx, `max(watchlog_mongodb_cache_bytes{${s}, state="used"})`),
      instant(ctx, `max(watchlog_mongodb_cache_bytes{${s}, state="max"})`),
      instant(ctx, `min(watchlog_mongodb_oplog_window_seconds{${s}})`),
      range(ctx, `sum by (op) (rate(watchlog_mongodb_ops_total{${s}}[${RATE}]))`),
      range(ctx, `max by (rs_member) (watchlog_mongodb_replication_lag_seconds{${s}})`),
      instant(ctx, `max(watchlog_mongodb_replica_set{${s}})`),
    ]);
  const total = valueOf(ops);
  const r = valueOf(reads) ?? 0;
  const busiest = busiestMember(conns).get('');
  const c = busiest?.c ?? null;
  const a = busiest?.a ?? null;
  const lagS = valueOf(lag);
  const used = valueOf(cacheUsed);
  const max = valueOf(cacheMax);
  const win = valueOf(oplog);
  const members = extra(ctx).members ?? [];
  const standalone = valueOf(isSet) === 0;
  const first = lagSeries[0]?.points ?? [];
  return [
    {
      id: 'summary',
      title: `${P}.summary`,
      kind: 'stat',
      span: 2,
      ...(needs(ctx, 'overview/summary') ?? { state: total === null ? 'empty' : 'ok' }),
      tiles: [
        {
          id: 'ops',
          labelKey: `${P}.ops`,
          value: total,
          unit: 'per_second',
          sub: total
            ? { key: `${P}.readsPct`, values: { pct: Math.round((r / total) * 100) } }
            : undefined,
        },
        {
          id: 'connections',
          labelKey: `${P}.connections`,
          value: c,
          unit: 'count',
          sub: a !== null && c !== null ? { key: `${P}.ofMax`, values: { max: c + a } } : undefined,
          severity:
            c !== null && a !== null && c + a > 0
              ? c / (c + a) > 0.9
                ? 'warning'
                : 'ok'
              : undefined,
        },
        {
          id: 'lag',
          labelKey: `${P}.replicationLag`,
          value: lagS,
          unit: 'seconds',
          sub: standalone ? { key: `${P}.standalone` } : undefined,
          severity: lagS !== null && lagS > LAG_LINE ? 'warning' : undefined,
        },
        {
          id: 'slow',
          labelKey: `${P}.slowOps`,
          value: valueOf(slow) === null ? null : Math.round(valueOf(slow)!),
          unit: 'count',
          sub: { key: `${P}.lastHour` },
          severity: (valueOf(slow) ?? 0) > 0 ? 'warning' : undefined,
        },
        {
          id: 'cache',
          labelKey: `${P}.cache`,
          value: used !== null && max ? used / max : null,
          unit: 'ratio',
          severity: used !== null && max && used / max > 0.95 ? 'warning' : undefined,
        },
        {
          id: 'oplog',
          labelKey: `${P}.oplogWindow`,
          value: win,
          unit: 'seconds',
          sub: standalone ? { key: `${P}.standalone` } : undefined,
          severity: win !== null && win < OPLOG_LINE ? 'info' : undefined,
        },
      ],
    } as Panel,
    {
      id: 'ops',
      title: `${P}.opsByType`,
      kind: 'stack',
      span: 1,
      unit: 'per_second',
      state: byOp.length ? 'ok' : 'empty',
      series: OPS.map((k) => ({
        nameKey: `${P}.series.${k}`,
        points: pointsOf(byOp.find((x) => x.labels.op === k)),
      })),
    },
    {
      id: 'lag',
      title: `${P}.lag`,
      kind: 'line',
      span: 1,
      unit: 'seconds',
      state: lagSeries.length ? 'ok' : 'empty',
      note: standalone ? { key: `${P}.standaloneNote` } : undefined,
      series: [
        ...lagSeries.map((x) => ({ name: x.labels.rs_member ?? '', points: pointsOf(x) })),
        ...(first.length
          ? [
              {
                nameKey: `${P}.lagLine`,
                points: first.map(([t]) => [t, LAG_LINE] as [number, number]),
                dashed: true,
              },
            ]
          : []),
      ],
    },
    {
      id: 'members',
      title: `${P}.members`,
      kind: 'table',
      span: 2,
      ...(needs(ctx, 'overview/members') ?? { state: members.length ? 'ok' : 'empty' }),
      note: standalone ? { key: `${P}.standaloneNote` } : undefined,
      columns: [`${P}.cols.member`, `${P}.cols.state`, `${P}.cols.health`, `${P}.cols.lag`],
      rows: members.map((m) => ({
        cells: [
          m.name,
          m.state,
          m.health ? 'up' : 'down',
          m.state === 'SECONDARY' ? duration(m.lag) : '–',
        ],
        severity:
          !m.health || !healthy.has(m.state)
            ? ('critical' as Severity)
            : m.lag > LAG_LINE
              ? ('warning' as Severity)
              : undefined,
      })),
    } as Panel,
  ];
}

async function operations(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const seconds = Math.max(ctx.range, 300);
  const [hist, busiest, owners] = await Promise.all([
    instant(ctx, `sum by (le) (increase(watchlog_mongodb_op_latency_bucket{${s}}[${seconds}s]))`),
    instant(
      ctx,
      `topk(15, sum by (ns) (rate(watchlog_mongodb_collection_time_seconds_total{${s}}[${seconds}s])))`,
    ),
    ipOwners(ctx.db, ctx.row.cluster_id),
  ]);
  const cum = LE.map((le) => hist.find((x) => x.labels.le === le)?.points[0]?.[1] ?? 0);
  const totalH = cum.at(-1) ?? 0;
  const slow = [...(extra(ctx).slow ?? [])].sort((a, b) => b.count - a.count).slice(0, 20);
  const by = new Map<string, number>();
  for (const c of extra(ctx).clients ?? []) {
    const who = clientName(owners, c.addr, c.app);
    by.set(who, (by.get(who) ?? 0) + c.connections);
  }
  return [
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
      ...(needs(ctx, 'operations/busiest') ?? { state: busiest.length ? 'ok' : 'empty' }),
      note: { key: `${P}.busiestNote` },
      items: busiest
        .map((x) => ({ label: x.labels.ns ?? '', value: x.points[0]?.[1] ?? 0 }))
        .filter((x) => x.value > 0)
        .sort((a, b) => b.value - a.value),
    } as Panel,
    {
      id: 'slow',
      title: `${P}.slow`,
      kind: 'table',
      span: 2,
      ...(needs(ctx, 'operations/slow') ?? { state: slow.length ? 'ok' : 'empty' }),
      note: { key: `${P}.slowNote` },
      columns: [
        `${P}.cols.shape`,
        `${P}.cols.collection`,
        `${P}.cols.mean`,
        `${P}.cols.count`,
        `${P}.cols.plan`,
        `${P}.cols.client`,
      ],
      rows: slowRows(slow, owners),
    } as Panel,
    {
      id: 'clients',
      title: `${P}.byClient`,
      kind: 'bars',
      span: 2,
      unit: 'count',
      ...(needs(ctx, 'operations/clients') ?? { state: by.size ? 'ok' : 'empty' }),
      items: [...by]
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 15),
    } as Panel,
  ];
}

async function storage(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [cache, fs, tickets, colls] = await Promise.all([
    instant(ctx, `max by (state) (watchlog_mongodb_cache_bytes{${s}})`),
    instant(ctx, `max by (state) (watchlog_mongodb_fs_bytes{${s}})`),
    range(ctx, `min by (op) (watchlog_mongodb_tickets{${s}, state="available"})`),
    instant(ctx, `topk(15, max by (ns) (watchlog_mongodb_collection_size_bytes{${s}}))`),
  ]);
  const c = (st: string) => cache.find((x) => x.labels.state === st)?.points[0]?.[1] ?? 0;
  const f = (st: string) => fs.find((x) => x.labels.state === st)?.points[0]?.[1] ?? 0;
  const unused = extra(ctx).unused_indexes ?? [];
  return [
    {
      id: 'cache',
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
                warnAt: 0.95,
              },
              {
                labelKey: `${P}.cacheDirty`,
                value: c('dirty'),
                max: c('max'),
                unit: 'bytes' as const,
                warnAt: 0.2,
              },
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
      id: 'tickets',
      title: `${P}.tickets`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: tickets.length ? 'ok' : 'empty',
      note: { key: `${P}.ticketsNote` },
      series: ['read', 'write'].map((op) => ({
        nameKey: `${P}.series.${op}`,
        points: pointsOf(tickets.find((x) => x.labels.op === op)),
      })),
    },
    {
      id: 'collections',
      title: `${P}.largest`,
      kind: 'bars',
      span: 1,
      unit: 'bytes',
      ...(needs(ctx, 'storage/collections') ?? { state: colls.length ? 'ok' : 'empty' }),
      note: { key: `${P}.largestNote` },
      items: colls
        .map((x) => ({ label: x.labels.ns ?? '', value: x.points[0]?.[1] ?? 0 }))
        .sort((a, b) => b.value - a.value),
    } as Panel,
    {
      id: 'indexes',
      title: `${P}.unusedIndexes`,
      kind: 'table',
      span: 1,
      ...(needs(ctx, 'storage/indexes') ?? { state: unused.length ? 'ok' : 'empty' }),
      note: { key: `${P}.unusedNote` },
      columns: [`${P}.cols.collection`, `${P}.cols.index`],
      rows: unused.map((x) => ({ cells: [x.ns, x.index] })),
    } as Panel,
  ];
}

async function reasons(ctx: PageContext): Promise<Reason[]> {
  const s = one(ctx.row.id);
  const [isSet, primary, lag, collscan, conns, dirty, used, max, queued, window, full, owners] =
    await Promise.all([
      instant(ctx, `max(watchlog_mongodb_replica_set{${s}})`),
      instant(ctx, `max(watchlog_mongodb_primary_seen{${s}})`),
      instant(ctx, `topk(1, max by (rs_member) (watchlog_mongodb_replication_lag_seconds{${s}}))`),
      instant(ctx, `sum(increase(watchlog_mongodb_slow_ops_total{${s}, plan="collscan"}[15m]))`),
      instant(ctx, connsBy(s)),
      instant(ctx, `max(watchlog_mongodb_cache_bytes{${s}, state="dirty"})`),
      instant(ctx, `max(watchlog_mongodb_cache_bytes{${s}, state="used"})`),
      instant(ctx, `max(watchlog_mongodb_cache_bytes{${s}, state="max"})`),
      instant(ctx, `max(sum by (member) (watchlog_mongodb_queued{${s}}))`),
      instant(ctx, `min(watchlog_mongodb_oplog_window_seconds{${s}})`),
      instant(
        ctx,
        `max(max by (member) (watchlog_mongodb_oplog_bytes{${s}, state="used"}) / on (member) (max by (member) (watchlog_mongodb_oplog_bytes{${s}, state="max"}) > 0))`,
      ),
      ipOwners(ctx.db, ctx.row.cluster_id),
    ]);
  const out: Reason[] = [];
  const ex = extra(ctx);
  const replicaSet = valueOf(isSet) === 1;
  if (replicaSet && valueOf(primary) === 0)
    out.push({
      severity: 'critical',
      code: 'no_primary',
      facts: { set: ex.members?.[0]?.set ?? null },
    });
  const down = (ex.members ?? []).filter((m) => !m.health || !healthy.has(m.state));
  if (replicaSet && down.length) {
    const m = down[0]!;
    // On Docker the member's name is its container's ("shop-mongo-2"): probable cause
    // follows it there. On Kubernetes it is the pod's.
    out.push({
      severity: 'critical',
      code: 'member_down',
      facts: {
        member: m.name,
        state: m.state,
        error: `replica set state ${m.state}`,
        n: down.length,
      },
    });
  }
  const l = valueOf(lag);
  if (l !== null && l > LAG_LINE)
    out.push({
      severity: 'warning',
      code: 'replica_lag',
      facts: { duration: duration(l), member: lag[0]?.labels.rs_member ?? null },
    });
  const scans = valueOf(collscan) ?? 0;
  const scanning = (ex.slow ?? []).filter((x) => x.collscan).sort((a, b) => b.count - a.count);
  if (scans >= 5 && scanning.length) {
    const worst = scanning[0]!;
    const owner = owners.get(worst.remote);
    out.push({
      severity: 'warning',
      code: 'slow_collscan',
      facts: {
        perMin: +(scans / 15).toFixed(1),
        ns: worst.ns,
        mean: ms(worst.mean_ms),
        client: clientName(owners, worst.remote),
        // The client as probable cause looks it up: a workload ("ns/name") or a container.
        holder: owner?.name ?? null,
      },
    });
  }
  const busiest = busiestMember(conns).get('');
  if (busiest && busiest.c / (busiest.c + busiest.a) > 0.9) {
    const { c, a } = busiest;
    const by = new Map<string, number>();
    for (const x of ex.clients ?? []) {
      const name = clientName(owners, x.addr, x.app);
      by.set(name, (by.get(name) ?? 0) + x.connections);
    }
    const top = [...by].sort((x, y) => y[1] - x[1]).slice(0, 3);
    out.push({
      severity: c / (c + a) > 0.97 ? 'critical' : 'warning',
      code: 'connections_near_max',
      facts: {
        n: c,
        max: c + a,
        pct: Math.round((c / (c + a)) * 100),
        top: top.map(([name, n]) => `${name} (${n})`).join(', ') || 'clients WatchLog can’t see',
      },
    });
  }
  const m = valueOf(max);
  const d = valueOf(dirty);
  const u = valueOf(used);
  if (m && ((d !== null && d / m > 0.2) || (u !== null && u / m > 0.95)))
    out.push({
      severity: 'warning',
      code: 'cache_pressure',
      facts: { pct: Math.round(((u ?? 0) / m) * 100), dirtyPct: Math.round(((d ?? 0) / m) * 100) },
    });
  const q = valueOf(queued) ?? 0;
  if (q > 10)
    out.push({ severity: 'warning', code: 'operations_queued', facts: { n: Math.round(q) } });
  const w = valueOf(window);
  if (w !== null && w < OPLOG_LINE && (valueOf(full) ?? 0) > 0.9)
    out.push({ severity: 'warning', code: 'oplog_window_short', facts: { duration: duration(w) } });
  return out;
}

export const mongodbPage: IntegrationPage = {
  id: 'mongodb',
  tabs: [
    { id: 'overview', title: 'integrations.mongodb.tabs.overview', panels: overview },
    { id: 'operations', title: 'integrations.mongodb.tabs.operations', panels: operations },
    { id: 'storage', title: 'integrations.mongodb.tabs.storage', panels: storage },
    {
      id: 'connection',
      title: 'integrations.tabs.connection',
      panels: genericPage.tabs[0]!.panels,
    },
  ],

  async listMetrics({ vm, scope, ids, now }) {
    const s = some(ids);
    const end = Math.floor(now / 1000 / 300) * 300;
    const opsQ = `sum by (service) (rate(watchlog_mongodb_ops_total{${s}}[5m]))`;
    const [conns, ops, used, max, spark] = await Promise.all([
      vm.query(scope, connsBy(s, 'service, member')),
      vm.query(scope, opsQ),
      vm.query(scope, `max by (service) (watchlog_mongodb_cache_bytes{${s}, state="used"})`),
      vm.query(scope, `max by (service) (watchlog_mongodb_cache_bytes{${s}, state="max"})`),
      vm.queryRange(scope, opsQ, end - SPARK_RANGE, end, 300),
    ]);
    const at = (rows: typeof ops, id: string) =>
      rows.find((r) => r.labels.service === id)?.points[0]?.[1] ?? null;
    const busiest = busiestMember(conns, (l) => l.service ?? '');
    const out = new Map<string, RowMetrics>();
    for (const id of ids) {
      const c = busiest.get(id)?.c ?? null;
      const a = busiest.get(id)?.a ?? null;
      const u = at(used, id);
      const m = at(max, id);
      const ratio = c !== null && a !== null && c + a > 0 ? c / (c + a) : null;
      out.set(id, {
        keyMetrics: [
          { id: 'ops', labelKey: `${P}.ops`, value: at(ops, id), unit: 'per_second' },
          ratio !== null
            ? {
                id: 'connections',
                labelKey: `${P}.connectionsPct`,
                value: ratio,
                unit: 'ratio',
                severity: ratio > 0.9 ? 'warning' : undefined,
              }
            : { id: 'connections', labelKey: `${P}.connections`, value: c, unit: 'count' },
          {
            id: 'cache',
            labelKey: `${P}.cache`,
            value: u !== null && m ? u / m : null,
            unit: 'ratio',
          },
        ],
        spark: spark.find((x) => x.labels.service === id)?.points ?? [],
      });
    }
    return out;
  },

  reasons,
};
