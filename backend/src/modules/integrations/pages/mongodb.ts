// SPDX-License-Identifier: AGPL-3.0-only
// The MongoDB page (SPEC §4.12, ADR-164; 1.4, ADR-247): Overview, Operations, Waits, Clients,
// Replica set, Collections, Cache and storage and Alerts, with a page for one operation shape
// and one collection (mongodb-deep.ts). The reasons put the cause first: which shape, from
// which service, does what to the server.
import { genericPage } from './generic.js';
import {
  clientOf,
  dominantWait,
  MG,
  ownersOf,
  sentBy,
  statementFacts,
  waitsOver,
} from './db-deep.js';
import {
  busiestMember,
  clientsTab,
  collectionPage,
  compact,
  collectionsTab,
  connsBy,
  extraOf,
  operations,
  overview,
  replicaTab,
  shapePage,
  storageTab,
  TXN_LONG,
  unusedEverywhere,
  waitsTab,
} from './mongodb-deep.js';
import { duration } from './mysql.js';
import { instant, one, some, SPARK_RANGE, valueOf } from './query.js';
import type { IntegrationPage, PageContext, Reason, RowMetrics } from './types.js';

const P = 'integrations.mongodb.panels';
const LAG_LINE = 30;
const OPLOG_LINE = 86400;
const healthy = new Set(['PRIMARY', 'SECONDARY', 'ARBITER']);

/** A client by its workload or container, else its address, else its application name. */
export function clientName(
  owners: Map<string, { name: string }>,
  addr: string,
  app?: string,
): string {
  if (addr && owners.has(addr)) return owners.get(addr)!.name;
  if (addr && addr !== '127.0.0.1' && addr !== '::1') return addr;
  return app ? `${app} (local)` : addr || 'local';
}

const ms = (v: number) => (v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`);

async function reasons(ctx: PageContext): Promise<Reason[]> {
  const s = one(ctx.row.id);
  const [
    isSet,
    primary,
    lag,
    shapeScans,
    shapeExamined,
    slowScans,
    conns,
    cache,
    evicting,
    queued,
    window,
    full,
    accessOff,
    fcvBehind,
    voters,
    mongos,
    p95,
    p95Usual,
    owners,
    senders,
    w15,
  ] = await Promise.all([
    instant(ctx, `max(watchlog_mongodb_replica_set{${s}})`),
    instant(ctx, `max(watchlog_mongodb_primary_seen{${s}})`),
    instant(ctx, `topk(1, max by (rs_member) (watchlog_mongodb_replication_lag_seconds{${s}}))`),
    // The shapes' calls in 15 minutes (the slow log's, or $queryStats'), by shape.
    instant(ctx, `sum by (shape) (increase(watchlog_mongodb_statement_calls_total{${s}}[15m]))`),
    instant(
      ctx,
      `sum by (shape) (increase(watchlog_mongodb_statement_docs_examined_total{${s}}[15m]))`,
    ),
    instant(ctx, `sum(increase(watchlog_mongodb_slow_ops_total{${s}, plan="collscan"}[15m]))`),
    instant(ctx, connsBy(s)),
    instant(ctx, `max by (state) (watchlog_mongodb_cache_bytes{${s}})`),
    instant(
      ctx,
      `sum(rate(watchlog_mongodb_app_eviction_seconds_total{${s}}[5m])) or sum(rate(watchlog_mongodb_app_evicted_pages_total{${s}}[5m]))`,
    ),
    instant(ctx, `max(sum by (member) (watchlog_mongodb_queued{${s}}))`),
    instant(ctx, `min(watchlog_mongodb_oplog_window_seconds{${s}})`),
    instant(
      ctx,
      `max(max by (member) (watchlog_mongodb_oplog_bytes{${s}, state="used"}) / on (member) (max by (member) (watchlog_mongodb_oplog_bytes{${s}, state="max"}) > 0))`,
    ),
    instant(ctx, `max(watchlog_mongodb_access_control_off{${s}})`),
    instant(ctx, `max(watchlog_mongodb_fcv_behind{${s}})`),
    instant(ctx, `max(watchlog_mongodb_voting_members{${s}})`),
    instant(ctx, `max(watchlog_mongodb_mongos{${s}})`),
    instant(
      ctx,
      `histogram_quantile(0.95, sum by (le) (rate(watchlog_mongodb_op_latency_bucket{${s}, type="reads"}[15m])))`,
    ),
    instant(
      ctx,
      `histogram_quantile(0.95, sum by (le) (rate(watchlog_mongodb_op_latency_bucket{${s}, type="reads"}[6h] offset 15m)))`,
    ),
    ownersOf(ctx),
    sentBy(ctx, MG),
    waitsOver(ctx, MG, Math.floor(ctx.now / 1000), 900),
  ]);
  const out: Reason[] = [];
  const ex = extraOf(ctx);
  const facts = statementFacts(ctx, MG);
  const replicaSet = valueOf(isSet) === 1;
  const members = ex.members ?? [];
  const st = (k: string) => cache.find((x) => x.labels.state === k)?.points[0]?.[1] ?? null;
  const cacheMax = st('max');
  const cachePct = cacheMax && st('used') !== null ? st('used')! / cacheMax : null;
  const dirtyPct = cacheMax && st('dirty') !== null ? st('dirty')! / cacheMax : null;
  const appEvict = (valueOf(evicting) ?? 0) > 0;

  if (replicaSet && valueOf(primary) === 0)
    out.push({ severity: 'critical', code: 'no_primary', facts: { set: members[0]?.set ?? null } });
  const down = members.filter((m) => !m.health || !healthy.has(m.state));
  if (replicaSet && down.length) {
    const m = down[0]!;
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
      severity: l > 60 ? 'critical' : 'warning',
      code: 'replica_lag',
      facts: { duration: duration(l), member: lag[0]?.labels.rs_member ?? null },
    });

  // Collection scans: the shape that scans most, its collection, the fields it filters on, who
  // sends it, and what it does to the cache and to the other reads.
  const calls = new Map(shapeScans.map((x) => [x.labels.shape ?? '', x.points[0]?.[1] ?? 0]));
  const scanning = [...facts.values()]
    .filter((f) => f.collscan && (calls.get(f.id) ?? 0) > 0)
    .sort((a, b) => (calls.get(b.id) ?? 0) - (calls.get(a.id) ?? 0));
  const scans15 = valueOf(slowScans) ?? 0;
  if (scanning.length && scans15 >= 5) {
    const worst = scanning[0]!;
    const sb = senders.get(worst.id);
    const owner = sb ? owners.get(sb.addr) : undefined;
    const client = sb ? clientOf(owners, sb.addr).name : null;
    const n = calls.get(worst.id) ?? 0;
    const slower = valueOf(p95) && valueOf(p95Usual) ? valueOf(p95)! / valueOf(p95Usual)! : null;
    const fills = appEvict || (cachePct !== null && cachePct > 0.9);
    out.push({
      severity: 'warning',
      code: fills ? 'collscan_fills_cache' : 'slow_collscan',
      facts: {
        perMin: +(scans15 / 15).toFixed(1),
        ns: worst.ns ?? null,
        fields: worst.fields ? worst.fields.split(',').join(', ') : null,
        // Documents each one read, in the same 15 minutes as the count ("197 k", as the table).
        examined:
          n > 0
            ? compact(
                (shapeExamined.find((x) => x.labels.shape === worst.id)?.points[0]?.[1] ?? 0) / n,
              )
            : null,
        mean: null,
        client,
        // Probable cause follows it: a workload ("ns/name") or a container.
        holder: owner?.name ?? null,
        cachePct: cachePct === null ? null : Math.round(cachePct * 100),
        slower: slower && slower >= 1.5 ? Math.round(slower * 10) / 10 : null,
        shape: worst.id,
      },
      ...(owner?.id
        ? {
            links: [
              { kind: owner.kind as 'workload' | 'container', id: owner.id, name: owner.name },
            ],
          }
        : {}),
    });
  }
  // What the operations wait on, when it is mostly one thing other than running.
  const top = dominantWait(w15);
  if (top && top.wait !== 'running' && top.share >= 0.5 && w15.total >= 0.5)
    out.push({
      severity: top.wait === 'lock' ? 'critical' : 'warning',
      code: 'waits_mostly',
      facts: {
        pct: Math.round(top.share * 100),
        wait: top.wait,
        sessions: Math.round(w15.total * 10) / 10,
      },
    });
  const busiest = busiestMember(conns).get('');
  if (busiest && busiest.c / (busiest.c + busiest.a) > 0.9) {
    const { c, a } = busiest;
    const by = new Map<string, number>();
    for (const x of ex.clients ?? []) {
      const name = clientName(owners, x.addr, x.app);
      by.set(name, (by.get(name) ?? 0) + x.connections);
    }
    const topC = [...by].sort((x, y) => y[1] - x[1]).slice(0, 3);
    out.push({
      severity: c / (c + a) > 0.97 ? 'critical' : 'warning',
      code: 'connections_near_max',
      facts: {
        n: c,
        max: c + a,
        pct: Math.round((c / (c + a)) * 100),
        top: topC.map(([name, n]) => `${name} (${n})`).join(', ') || 'clients WatchLog can’t see',
      },
    });
  }
  if (
    cacheMax &&
    !out.some((r) => r.code === 'collscan_fills_cache') &&
    (appEvict || (dirtyPct ?? 0) > 0.2 || (cachePct ?? 0) > 0.95)
  )
    out.push({
      severity: 'warning',
      code: 'cache_pressure',
      facts: {
        pct: Math.round((cachePct ?? 0) * 100),
        dirtyPct: Math.round((dirtyPct ?? 0) * 100),
        appEvict: appEvict ? 1 : 0,
      },
    });
  const q = valueOf(queued) ?? 0;
  if (q > 10)
    out.push({ severity: 'warning', code: 'operations_queued', facts: { n: Math.round(q) } });
  // Transactions open long: the server aborts them at its lifetime limit (60 s by default).
  const txn = [...(ex.transactions ?? [])].sort((a, b) => b.age - a.age)[0];
  if (txn && txn.age >= TXN_LONG) {
    const who = clientOf(owners, txn.addr, txn.app);
    out.push({
      severity: 'warning',
      code: 'long_transaction',
      facts: {
        who: who.name,
        holder: owners.has(txn.addr) ? who.name : null,
        age: duration(txn.age),
        idle: txn.state === 'idleSession' ? duration(txn.idle) : null,
        blocks: 0,
      },
    });
  }
  const idleCursors = (ex.cursors ?? []).filter((x) => x.idle > 600);
  if (idleCursors.length)
    out.push({
      severity: 'info',
      code: 'cursors_no_timeout',
      facts: {
        n: idleCursors.length,
        ns: idleCursors[0]!.ns,
        idle: duration(idleCursors[0]!.idle),
      },
    });
  const w = valueOf(window);
  if (w !== null && w < OPLOG_LINE && (valueOf(full) ?? 0) > 0.9)
    out.push({
      severity: w < OPLOG_LINE / 2 ? 'warning' : 'info',
      code: 'oplog_window_short',
      facts: { duration: duration(w) },
    });
  // Settings that hurt.
  if (valueOf(accessOff) === 1)
    out.push({ severity: 'warning', code: 'access_control_off', facts: {} });
  const v = valueOf(voters);
  if (replicaSet && v !== null && v > 0 && v % 2 === 0)
    out.push({ severity: 'warning', code: 'voting_members_even', facts: { n: v } });
  if (replicaSet && v === 1 && members.length <= 1)
    out.push({
      severity: 'info',
      code: 'single_member_set',
      facts: { set: members[0]?.set ?? null },
    });
  if (valueOf(fcvBehind) === 1) {
    const set = (ex.settings ?? []).find((x) => x.name === 'featureCompatibilityVersion');
    out.push({
      severity: 'info',
      code: 'fcv_behind',
      facts: { fcv: set?.value ?? null, version: set?.version ?? ctx.row.version ?? null },
    });
  }
  if (valueOf(mongos) === 1) out.push({ severity: 'info', code: 'mongos_only', facts: {} });
  const unused = unusedEverywhere(ex);
  if (unused.length >= 3)
    out.push({
      severity: 'info',
      code: 'indexes_unused',
      facts: { n: unused.length, index: unused[0]!.index, ns: unused[0]!.ns },
    });
  return out;
}

export const mongodbPage: IntegrationPage = {
  id: 'mongodb',
  tabs: [
    { id: 'overview', title: 'integrations.mongodb.tabs.overview', panels: overview },
    { id: 'operations', title: 'integrations.mongodb.tabs.operations', panels: operations },
    { id: 'waits', title: 'integrations.db.tabs.waits', panels: waitsTab },
    { id: 'clients', title: 'integrations.mongodb.tabs.clients', panels: clientsTab },
    { id: 'replica', title: 'integrations.mongodb.tabs.replica', panels: replicaTab },
    { id: 'collections', title: 'integrations.mongodb.tabs.collections', panels: collectionsTab },
    { id: 'storage', title: 'integrations.mongodb.tabs.storage', panels: storageTab },
    { id: 'alerts', title: 'integrations.db.tabs.alerts', panels: async () => [], view: 'alerts' },
    // One shape and one collection at their own addresses (1.4).
    { id: 'statement', title: 'integrations.mongodb.tabs.shape', panels: shapePage, hidden: true },
    {
      id: 'table',
      title: 'integrations.mongodb.tabs.collection',
      panels: collectionPage,
      hidden: true,
    },
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

export { ms };
