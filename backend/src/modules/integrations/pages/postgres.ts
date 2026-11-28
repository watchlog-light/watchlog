// SPDX-License-Identifier: AGPL-3.0-only
// The PostgreSQL page (SPEC §4.12, v0.3 slice 8; 1.2, ADR-245): Overview, Queries, Waits,
// Connections, Locks, Replication, Tables, Vacuum and Alerts, from the collector's
// pg_stat_* series; statements, blocking sessions, clients, vacuum and unused indexes
// from its status. The data volume's capacity is the PVC on Kubernetes and the host
// filesystem that holds Docker's data on Docker.
import { escapeLabelValue } from '../../query/catalog.js';
import { genericPage } from './generic.js';
import { ago, bytes, ipOwners, type Owner } from './owners.js';
import { instant, one, pointsOf, range, some, SPARK_RANGE, valueOf } from './query.js';
import type { IntegrationPage, PageContext, Panel, Reason, RowMetrics, Severity } from './types.js';
import * as deep from './postgres-deep.js';
import {
  capacityPanel,
  clientOf,
  dominantWait,
  longTxn,
  memoryLimit,
  ownersOf,
  PG,
  statementFacts,
  statementStats,
  transactionsOf,
  longestIsBlocked,
  treeSessions,
  waitsOver,
} from './db-deep.js';

const P = 'integrations.postgres.panels';
const RATE = '2m';

/**
 * Client connections, 0 when the server reports and nobody but WatchLog is connected: the
 * collector sends the per-state series only for states that have backends, so an idle
 * server has none of them (its own session is left out), and the sum would be empty.
 */
const connsOf = (s: string) =>
  `(sum(watchlog_postgres_backends{${s}, db=""}) or 0 * max(watchlog_postgres_setting{${s}, name="max_connections"}))`;
const LONG_QUERY = 300;
const LAG_LINE = 30;

interface Statement {
  queryid: string;
  calls: number;
  total: number;
  mean: number;
  rows: number;
  query?: string;
}
interface Blocking {
  blocked: string;
  blocked_state: string;
  wait: string;
  seconds: number;
  blocking: string;
  blocking_state: string;
  blocked_query: string;
  blocking_query: string;
  member: string;
}
interface Client {
  addr: string;
  app: string;
  connections: number;
  member: string;
}
interface Vacuum {
  db: string;
  table: string;
  dead: number;
  live: number;
  last_autovacuum: number;
  autovacuum_count: number;
}
interface Unused {
  db: string;
  table: string;
  index: string;
  size: number;
  since: number;
}
interface Extra {
  statements?: Statement[];
  blocking?: Blocking[];
  clients?: Client[];
  vacuum?: Vacuum[];
  unused_indexes?: Unused[];
}
const extra = (ctx: PageContext): Extra =>
  (ctx.row.status_details as { extra?: Extra }).extra ?? {};
const missing = (ctx: PageContext) =>
  (ctx.row.status_details as { permissions?: { tab: string; missing: string }[] }).permissions ??
  [];

const majorVersion = (v: string | null) => Number((v ?? '').split('.')[0]) || 0;

/** A client by its workload or container, else its address, else its application name. */
function clientName(owners: Map<string, Owner>, addr: string, app?: string): string {
  if (addr && owners.has(addr)) return owners.get(addr)!.name;
  return addr || app || 'local';
}

const ms = (seconds: number) =>
  seconds >= 1 ? `${seconds.toFixed(2)} s` : `${(seconds * 1000).toFixed(1)} ms`;
const duration = (s: number) =>
  s >= 3600
    ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
    : s >= 90
      ? `${Math.round(s / 60)} min`
      : `${Math.round(s)} s`;

/**
 * The data volume and its capacity: the pod's PVC (kubelet volume stats) on Kubernetes;
 * on Docker the host filesystem that holds Docker's data (ADR-124's closest: a volume has
 * no capacity of its own). Growth per day from the last 7 days, once a day of history
 * exists (null before).
 */
export async function volumeOf(
  ctx: PageContext,
): Promise<{ used: number; capacity: number; perDay: number | null; name: string } | null> {
  const t = ctx.row.target;
  if (t.kind === 'workload') {
    const sel = `namespace="${escapeLabelValue(t.namespace)}", workload_kind="${escapeLabelValue(t.workload_kind)}", workload="${escapeLabelValue(t.workload)}"`;
    const [used, cap, growth] = await Promise.all([
      instant(
        ctx,
        `max by (persistentvolumeclaim) (watchlog_pod_volume_bytes{${sel}, state="used"})`,
      ),
      instant(
        ctx,
        `max by (persistentvolumeclaim) (watchlog_pod_volume_bytes{${sel}, state="capacity"})`,
      ),
      instant(
        ctx,
        `max by (persistentvolumeclaim) (deriv(watchlog_pod_volume_bytes{${sel}, state="used"}[7d]) and last_over_time(watchlog_pod_volume_bytes{${sel}, state="used"}[1h] offset 1d)) * 86400`,
      ),
    ]);
    // The fullest claim (a StatefulSet's replicas each have one).
    const top = used
      .map((u) => {
        const pvc = u.labels.persistentvolumeclaim ?? '';
        const c = cap.find((x) => x.labels.persistentvolumeclaim === pvc)?.points[0]?.[1] ?? 0;
        return { pvc, used: u.points[0]?.[1] ?? 0, capacity: c };
      })
      .filter((x) => x.capacity > 0)
      .sort((a, b) => b.used / b.capacity - a.used / a.capacity)[0];
    if (!top) return null;
    const g = growth.find((x) => x.labels.persistentvolumeclaim === top.pvc)?.points[0]?.[1];
    return { used: top.used, capacity: top.capacity, perDay: g ?? null, name: top.pvc };
  }
  const host =
    t.kind === 'compose' || t.kind === 'container' ? t.host : ctx.row.collector_host || null;
  if (!host) return null;
  const sel = `host="${escapeLabelValue(host)}"`;
  const [size, avail, growth] = await Promise.all([
    instant(ctx, `max by (mount) (watchlog_node_filesystem_bytes{${sel}, state="size"})`),
    instant(ctx, `max by (mount) (watchlog_node_filesystem_bytes{${sel}, state="avail"})`),
    instant(
      ctx,
      `-max by (mount) (deriv(watchlog_node_filesystem_bytes{${sel}, state="avail"}[7d]) and last_over_time(watchlog_node_filesystem_bytes{${sel}, state="avail"}[1h] offset 1d)) * 86400`,
    ),
  ]);
  // The mount that holds /var/lib/docker: the longest mount point that prefixes it.
  const mounts = size
    .map((x) => x.labels.mount ?? '')
    .filter((m) => m === '/' || '/var/lib/docker/'.startsWith(m.replace(/\/?$/, '/')))
    .sort((a, b) => b.length - a.length);
  const mount = mounts[0];
  if (mount === undefined) return null;
  const s = size.find((x) => x.labels.mount === mount)?.points[0]?.[1] ?? 0;
  const a = avail.find((x) => x.labels.mount === mount)?.points[0]?.[1] ?? 0;
  if (s <= 0) return null;
  const g = growth.find((x) => x.labels.mount === mount)?.points[0]?.[1];
  return { used: s - a, capacity: s, perDay: g ?? null, name: `${host}:${mount}` };
}

/** The Overview after the design (1.2, ADR-245). */
async function overview(ctx: PageContext): Promise<Panel[]> {
  return deep.overview(ctx, await volumeOf(ctx));
}

async function connections(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [byState, maxConn, now, idleTx, timeout, sessions, owners] = await Promise.all([
    range(ctx, `sum by (state) (watchlog_postgres_backends{${s}, db=""})`),
    instant(ctx, `max(watchlog_postgres_setting{${s}, name="max_connections"})`),
    instant(ctx, connsOf(s)),
    instant(ctx, `sum(watchlog_postgres_backends{${s}, db="", state=~"idle in transaction.*"})`),
    instant(
      ctx,
      `max(watchlog_postgres_setting{${s}, name="idle_in_transaction_session_timeout"})`,
    ),
    range(ctx, `sum(rate(watchlog_postgres_sessions_total{${s}}[${RATE}]))`),
    ipOwners(ctx.db, ctx.row.cluster_id),
  ]);
  const by = new Map<string, number>();
  for (const c of extra(ctx).clients ?? []) {
    const who = clientName(owners, c.addr, c.app);
    by.set(who, (by.get(who) ?? 0) + c.connections);
  }
  const m = valueOf(maxConn);
  const t = valueOf(timeout);
  const old = majorVersion(ctx.row.version) > 0 && majorVersion(ctx.row.version) < 14;
  return [
    {
      id: 'by-state',
      title: `${P}.byState`,
      kind: 'stack',
      span: 2,
      unit: 'count',
      state: byState.length ? 'ok' : 'empty',
      series: byState.map((x) => ({
        name: x.labels.state ?? '',
        points: pointsOf(x),
        severity: (x.labels.state ?? '').startsWith('idle in transaction')
          ? ('warning' as Severity)
          : undefined,
      })),
    },
    {
      id: 'by-client',
      title: `${P}.byClient`,
      kind: 'bars',
      span: 1,
      unit: 'count',
      state: by.size ? 'ok' : 'empty',
      items: [...by]
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 15),
    },
    {
      id: 'limits',
      title: `${P}.limits`,
      kind: 'gauge',
      span: 1,
      state: m ? 'ok' : 'empty',
      items: m
        ? [
            {
              labelKey: `${P}.maxConnections`,
              value: valueOf(now) ?? 0,
              max: m,
              unit: 'count',
              warnAt: 0.9,
            },
            {
              labelKey: `${P}.idleInTransaction`,
              value: valueOf(idleTx) ?? 0,
              max: m,
              unit: 'count',
              warnAt: 0.1,
              note: t
                ? { key: `${P}.idleTimeout`, values: { timeout: duration(t) } }
                : { key: `${P}.noIdleTimeout` },
            },
          ]
        : [],
    },
    {
      id: 'new',
      title: `${P}.newConnections`,
      kind: 'line',
      span: 2,
      unit: 'per_second',
      state: sessions.length ? 'ok' : 'empty',
      note: old ? { key: `${P}.noSessions`, values: { version: ctx.row.version } } : undefined,
      series: [{ nameKey: `${P}.series.sessions`, points: pointsOf(sessions[0]) }],
    },
    ...(await deep.connectionsDeep(ctx)),
  ];
}

/** Statement means into buckets, weighted by calls (no per-execution histogram exists). */
function meanBuckets(list: Statement[]) {
  const edges = [0.001, 0.01, 0.1, 1, 10];
  const labels = ['≤1 ms', '≤10 ms', '≤100 ms', '≤1 s', '≤10 s', '>10 s'];
  const n = new Array<number>(labels.length).fill(0);
  let total = 0;
  for (const x of list) {
    const i = edges.findIndex((e) => x.mean <= e);
    n[i === -1 ? labels.length - 1 : i]! += x.calls;
    total += x.calls;
  }
  return labels.map((label, i) => ({ label, share: total ? n[i]! / total : 0 }));
}

async function queries(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const ops = ['fetched', 'inserted', 'updated', 'deleted'] as const;
  const [rows, temp] = await Promise.all([
    Promise.all(
      ops.map((o) => range(ctx, `sum(rate(watchlog_postgres_tup_${o}_total{${s}}[${RATE}]))`)),
    ),
    range(ctx, `sum(rate(watchlog_postgres_temp_bytes_total{${s}}[${RATE}]))`),
  ]);
  const list = extra(ctx).statements ?? [];
  return [
    await deep.statementsPanel(ctx),
    {
      id: 'rows',
      title: `${P}.rows`,
      kind: 'stack',
      span: 2,
      unit: 'per_second',
      state: rows[0]!.length ? 'ok' : 'empty',
      series: ops.map((o, i) => ({ nameKey: `${P}.series.${o}`, points: pointsOf(rows[i]![0]) })),
    },
    {
      id: 'duration',
      title: `${P}.duration`,
      kind: 'hist',
      span: 1,
      state: list.length ? 'ok' : 'empty',
      note: { key: `${P}.byStatementMean` },
      buckets: meanBuckets(list),
    },
    {
      id: 'temp',
      title: `${P}.temp`,
      kind: 'line',
      span: 1,
      unit: 'bytes_per_second',
      state: temp.length ? 'ok' : 'empty',
      series: [{ nameKey: `${P}.series.temp`, points: pointsOf(temp[0]) }],
    },
  ];
}

async function locks(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const end = Math.floor(ctx.now / 1000 / 3600) * 3600;
  const [waits, deadlocks, locked, heat] = await Promise.all([
    range(ctx, `sum by (wait) (watchlog_postgres_backends{${s}, db="", wait!=""})`),
    range(ctx, `sum(increase(watchlog_postgres_deadlocks_total{${s}}[5m]))`),
    instant(ctx, `topk(10, max by (table) (watchlog_postgres_locked_relation{${s}}))`),
    ctx.vm
      ? ctx.vm.queryRange(
          ctx.scope,
          `max_over_time(sum(watchlog_postgres_lock_waits{${s}})[1h])`,
          end - 7 * 86400,
          end,
          3600,
        )
      : Promise.resolve([]),
  ]);
  // A collector before 1.2 sends the pairs, not the tree: they stay readable.
  const blocking = [...(extra(ctx).blocking ?? [])].sort((a, b) => b.seconds - a.seconds);
  const legacy = !(ctx.row.status_details as { extra?: { lock_tree?: unknown } }).extra?.lock_tree;
  const owners = legacy && blocking.length ? await ipOwners(ctx.db, ctx.row.cluster_id) : null;
  const q = (text: string) => text || '–';
  return [
    ...(await deep.locksDeep(ctx)),
    ...(owners
      ? [
          {
            id: 'blocking',
            title: `${P}.blocking`,
            kind: 'table' as const,
            span: 2 as const,
            state: 'ok' as const,
            note: { key: `${P}.blockingNote` },
            columns: [
              `${P}.cols.blocked`,
              `${P}.cols.waitingFor`,
              `${P}.cols.for`,
              `${P}.cols.blockedBy`,
              `${P}.cols.blockedQuery`,
              `${P}.cols.blockingQuery`,
            ],
            rows: blocking.map((x) => ({
              cells: [
                `${clientName(owners, x.blocked)} (${x.blocked_state})`,
                x.wait,
                duration(x.seconds),
                `${clientName(owners, x.blocking)} (${x.blocking_state})`,
                q(x.blocked_query),
                q(x.blocking_query),
              ],
              severity: x.seconds > 60 ? ('warning' as Severity) : undefined,
            })),
          },
        ]
      : []),
    {
      id: 'waits',
      title: `${P}.waits`,
      kind: 'stack',
      span: 2,
      unit: 'count',
      state: waits.length ? 'ok' : 'empty',
      series: waits.map((x) => ({
        name: x.labels.wait ?? '',
        points: pointsOf(x),
        severity: x.labels.wait === 'Lock' ? ('warning' as Severity) : undefined,
      })),
    },
    {
      id: 'heat',
      title: `${P}.lockHeat`,
      kind: 'heat',
      span: 2,
      unit: 'count',
      state: heat.length ? 'ok' : 'empty',
      note: { key: `${P}.lockHeatNote` },
      points: pointsOf(heat[0]),
    },
    {
      id: 'deadlocks',
      title: `${P}.deadlocks`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: deadlocks.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.deadlocks`, points: pointsOf(deadlocks[0]), severity: 'critical' },
      ],
    },
    {
      id: 'locked',
      title: `${P}.lockedTables`,
      kind: 'bars',
      span: 1,
      unit: 'count',
      state: locked.length ? 'ok' : 'empty',
      items: locked
        .map((x) => ({ label: x.labels.table ?? '', value: x.points[0]?.[1] ?? 0 }))
        .sort((a, b) => b.value - a.value),
    },
  ];
}

async function replication(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [lag, replay, replicas, wal, maxWal, slots, generated] = await Promise.all([
    range(ctx, `max by (replica) (watchlog_postgres_replica_lag_seconds{${s}})`),
    range(ctx, `max by (member) (watchlog_postgres_replay_lag_seconds{${s}})`),
    instant(ctx, `max by (replica, state, sync) (watchlog_postgres_replica_lag_seconds{${s}})`),
    instant(ctx, `max(watchlog_postgres_wal_dir_bytes{${s}})`),
    instant(ctx, `max(watchlog_postgres_setting{${s}, name="max_wal_size"})`),
    instant(ctx, `max by (slot) (watchlog_postgres_slot_active{${s}})`),
    range(ctx, `sum(rate(watchlog_postgres_wal_bytes_total{${s}}[${RATE}]))`),
  ]);
  const lines = [
    ...lag.map((x) => ({ name: x.labels.replica ?? '', points: pointsOf(x) })),
    ...replay.map((x) => ({ name: x.labels.member ?? '', points: pointsOf(x) })),
  ];
  const w = valueOf(wal);
  const mw = valueOf(maxWal);
  const active = slots.filter((x) => (x.points[0]?.[1] ?? 0) > 0).length;
  const first = lines[0]?.points ?? [];
  return [
    {
      id: 'lag',
      title: `${P}.replayLag`,
      kind: 'line',
      span: 2,
      unit: 'seconds',
      state: lines.length ? 'ok' : 'empty',
      note: lines.length ? undefined : { key: `${P}.noReplicas` },
      series: [
        ...lines,
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
      id: 'replicas',
      title: `${P}.replicas`,
      kind: 'table',
      span: 1,
      state: replicas.length ? 'ok' : 'empty',
      columns: [`${P}.cols.replica`, `${P}.cols.state`, `${P}.cols.sync`, `${P}.cols.lag`],
      rows: replicas.map((x) => {
        const v = x.points[0]?.[1] ?? 0;
        return {
          cells: [x.labels.replica ?? '', x.labels.state ?? '', x.labels.sync ?? '', ms(v)],
          severity: v > LAG_LINE ? ('warning' as Severity) : undefined,
        };
      }),
    },
    {
      id: 'wal',
      title: `${P}.wal`,
      kind: 'gauge',
      span: 1,
      state: w === null && !slots.length ? 'empty' : 'ok',
      items: [
        ...(w !== null && mw
          ? [
              {
                labelKey: `${P}.walDir`,
                value: w,
                max: mw,
                unit: 'bytes' as const,
                warnAt: 0.9,
                note: { key: `${P}.maxWalSize`, values: { size: bytes(mw) } },
              },
            ]
          : []),
        ...(slots.length
          ? [
              {
                labelKey: `${P}.slotsActive`,
                value: active,
                max: slots.length,
                unit: 'count' as const,
                note:
                  active < slots.length
                    ? { key: `${P}.slotsInactive`, values: { n: slots.length - active } }
                    : undefined,
              },
            ]
          : []),
      ],
    },
    {
      id: 'generated',
      title: `${P}.walGenerated`,
      kind: 'line',
      span: 2,
      unit: 'bytes_per_second',
      state: generated.length ? 'ok' : 'empty',
      series: [{ nameKey: `${P}.series.wal`, points: pointsOf(generated[0]) }],
    },
    ...(await deep.replicationDeep(ctx, await volumeOf(ctx))),
  ];
}

async function tables(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [largest, bloat, sizes] = await Promise.all([
    instant(ctx, `topk(15, max by (db, table) (watchlog_postgres_table_size_bytes{${s}}))`),
    instant(
      ctx,
      `topk(15, max by (db, table) (watchlog_postgres_table_bloat_bytes_estimate{${s}}) > 0)`,
    ),
    range(ctx, `max by (db) (watchlog_postgres_database_size_bytes{${s}})`),
  ]);
  const unused = extra(ctx).unused_indexes ?? [];
  const since = unused.reduce((m, x) => Math.max(m, x.since), 0);
  const bar = (x: (typeof largest)[number]) => ({
    label: `${x.labels.db}: ${x.labels.table}`,
    value: x.points[0]?.[1] ?? 0,
  });
  return [
    {
      id: 'largest',
      title: `${P}.largest`,
      kind: 'bars',
      span: 1,
      unit: 'bytes',
      state: largest.length ? 'ok' : 'empty',
      items: largest.map(bar).sort((a, b) => b.value - a.value),
    },
    {
      id: 'bloat',
      title: `${P}.bloat`,
      kind: 'bars',
      span: 1,
      unit: 'bytes',
      state: bloat.length ? 'ok' : 'empty',
      note: { key: `${P}.bloatNote` },
      items: bloat.map(bar).sort((a, b) => b.value - a.value),
    },
    {
      id: 'unused',
      title: `${P}.unused`,
      kind: 'table',
      span: 2,
      state: unused.length ? 'ok' : 'empty',
      note: since
        ? {
            key: `${P}.unusedSince`,
            values: { date: new Date(since * 1000).toISOString().slice(0, 10) },
          }
        : { key: `${P}.unusedNote` },
      columns: [`${P}.cols.index`, `${P}.cols.table`, `${P}.cols.db`, `${P}.cols.size`],
      rows: unused.map((x) => ({ cells: [x.index, x.table, x.db, bytes(x.size)] })),
    },
    {
      id: 'size',
      title: `${P}.databaseSize`,
      kind: 'line',
      span: 2,
      unit: 'bytes',
      state: sizes.length ? 'ok' : 'empty',
      series: sizes.map((x) => ({ name: x.labels.db ?? '', points: pointsOf(x) })),
    },
    ...(await deep.tablesDeep(ctx)),
    await capacityPanel(ctx, PG, await volumeOf(ctx)),
  ];
}

/**
 * Tables whose dead rows rose over 24 hours while autovacuum didn't finish once: the
 * closest to "autovacuum keeps getting cancelled", which is only in the server log.
 */
async function stuckTables(ctx: PageContext): Promise<Set<string>> {
  const s = one(ctx.row.id);
  const rows = await instant(
    ctx,
    `max by (db, table) (delta(watchlog_postgres_table_dead_rows{${s}}[24h]) > 1000 and on (db, table, member) increase(watchlog_postgres_table_autovacuum_total{${s}}[24h]) == 0 and on (db, table, member) watchlog_postgres_table_dead_rows{${s}} > 10000)`,
  );
  return new Set(rows.map((x) => `${x.labels.db}/${x.labels.table}`));
}

async function vacuum(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [dead, xid, freeze, stuck] = await Promise.all([
    range(ctx, `topk(10, max by (db, table) (watchlog_postgres_table_dead_rows{${s}}))`),
    instant(ctx, `max by (db) (watchlog_postgres_xid_age{${s}})`),
    instant(ctx, `max(watchlog_postgres_setting{${s}, name="autovacuum_freeze_max_age"})`),
    stuckTables(ctx),
  ]);
  const list = (extra(ctx).vacuum ?? []).filter((x) => x.dead > 0);
  const fz = valueOf(freeze);
  return [
    {
      id: 'waiting',
      title: `${P}.vacuumWaiting`,
      kind: 'table',
      span: 2,
      state: list.length ? 'ok' : 'empty',
      columns: [
        `${P}.cols.table`,
        `${P}.cols.db`,
        `${P}.cols.dead`,
        `${P}.cols.deadRatio`,
        `${P}.cols.lastAutovacuum`,
        `${P}.cols.note`,
      ],
      rows: list.map((x) => {
        const ratio = x.live + x.dead > 0 ? x.dead / (x.live + x.dead) : 0;
        const isStuck = stuck.has(`${x.db}/${x.table}`);
        return {
          cells: [
            x.table,
            x.db,
            x.dead,
            `${Math.round(ratio * 100)} %`,
            x.last_autovacuum ? ago(x.last_autovacuum, ctx.now) : '–',
            isStuck ? 'autovacuum isn’t finishing' : ratio > 0.2 ? 'due for vacuum' : '',
          ],
          severity: isStuck ? ('warning' as Severity) : undefined,
          link: deep.tableLink(x.db, x.table),
        };
      }),
    },
    {
      id: 'dead',
      title: `${P}.deadRows`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: dead.length ? 'ok' : 'empty',
      series: dead.map((x) => ({ name: `${x.labels.db}: ${x.labels.table}`, points: pointsOf(x) })),
    },
    {
      id: 'xid',
      title: `${P}.xidAge`,
      kind: 'gauge',
      span: 1,
      state: xid.length ? 'ok' : 'empty',
      items: xid
        .sort((a, b) => (b.points[0]?.[1] ?? 0) - (a.points[0]?.[1] ?? 0))
        .slice(0, 5)
        .map((x) => ({
          label: x.labels.db ?? '',
          value: x.points[0]?.[1] ?? 0,
          max: 2_000_000_000,
          unit: 'count' as const,
          warnAt: 0.5,
          note: fz
            ? { key: `${P}.freezeAge`, values: { n: `${Math.round(fz / 1e6)} M` } }
            : undefined,
        })),
    },
    ...(await deep.vacuumDeep(ctx)),
  ];
}

async function reasons(ctx: PageContext): Promise<Reason[]> {
  const s = one(ctx.row.id);
  const [
    conns,
    maxConn,
    longest,
    idleTx,
    idleTxN,
    waits,
    deadlocks,
    lag,
    replay,
    slots,
    xid,
    hit,
    read,
    stuck,
    owners,
  ] = await Promise.all([
    instant(ctx, connsOf(s)),
    instant(ctx, `max(watchlog_postgres_setting{${s}, name="max_connections"})`),
    instant(ctx, `max(watchlog_postgres_backend_max_seconds{${s}, kind="active"})`),
    instant(ctx, `max(watchlog_postgres_backend_max_seconds{${s}, kind="idle_in_transaction"})`),
    instant(ctx, `sum(watchlog_postgres_backends{${s}, db="", state=~"idle in transaction.*"})`),
    instant(ctx, `max(watchlog_postgres_lock_waits{${s}})`),
    instant(ctx, `sum(increase(watchlog_postgres_deadlocks_total{${s}}[15m]))`),
    instant(ctx, `max(watchlog_postgres_replica_lag_seconds{${s}})`),
    instant(ctx, `max(watchlog_postgres_replay_lag_seconds{${s}})`),
    instant(
      ctx,
      `max by (slot) (watchlog_postgres_slot_retained_bytes{${s}} and on (slot, member) watchlog_postgres_slot_active{${s}} == 0)`,
    ),
    instant(ctx, `topk(1, max by (db) (watchlog_postgres_xid_age{${s}}))`),
    instant(ctx, `sum(rate(watchlog_postgres_blks_hit_total{${s}}[15m]))`),
    instant(ctx, `sum(rate(watchlog_postgres_blks_read_total{${s}}[15m]))`),
    stuckTables(ctx),
    ipOwners(ctx.db, ctx.row.cluster_id),
  ]);
  const out: Reason[] = [];
  const c = valueOf(conns);
  const m = valueOf(maxConn);
  if (c !== null && m && c / m > 0.9) {
    // The clients holding most connections, by name only: the address map doesn't know a
    // workload's kind, so no link is guessed.
    const by = new Map<string, number>();
    for (const x of extra(ctx).clients ?? []) {
      const name = clientName(owners, x.addr, x.app);
      by.set(name, (by.get(name) ?? 0) + x.connections);
    }
    const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 3);
    out.push({
      severity: c / m > 0.97 ? 'critical' : 'warning',
      code: 'connections_near_max',
      facts: {
        n: c,
        max: m,
        pct: Math.round((c / m) * 100),
        top: top.map(([name, n]) => `${name} (${n})`).join(', ') || 'clients WatchLog can’t see',
      },
    });
  }
  const long = valueOf(longest);
  if (long !== null && long > LONG_QUERY && !longestIsBlocked(ctx, long))
    out.push({
      severity: 'critical',
      code: 'long_query',
      facts: { duration: duration(long) },
    });
  const it = valueOf(idleTx);
  if (it !== null && it > 300)
    out.push({
      severity: 'warning',
      code: 'idle_in_transaction',
      facts: { n: valueOf(idleTxN) ?? 1, duration: duration(it) },
    });
  // Lock waits (1.2): the root of the blocking tree is the holder; probable cause follows it
  // to its workload or container (facts.holder), the finding names its state and table. A
  // collector before 1.2 sends only the pairs: the longest wait's blocker is the holder.
  const tree = treeSessions(ctx);
  const blockedN = tree.filter((t) => t.blockedBy.length).length;
  const pairs = [...(extra(ctx).blocking ?? [])].sort((a, b) => b.seconds - a.seconds);
  if ((valueOf(waits) ?? 0) > 0 || blockedN || pairs.length) {
    const root = tree.find(
      (t) => !t.blockedBy.length && tree.some((o) => o.blockedBy.includes(t.id)),
    );
    const pair = pairs[0];
    const holderAddr = root?.addr ?? pair?.blocking ?? '';
    const holder = root
      ? clientOf(owners, root.addr, root.app)
      : pair
        ? clientOf(owners, pair.blocking)
        : null;
    const longest = Math.max(
      tree.filter((t) => t.blockedBy.length).reduce((m, t) => Math.max(m, t.seconds), 0),
      pair?.seconds ?? 0,
    );
    const table =
      (await instant(ctx, `topk(1, max by (table) (watchlog_postgres_locked_relation{${s}}))`))[0]
        ?.labels.table ?? null;
    out.push({
      severity: longest > 60 ? 'critical' : 'warning',
      code: 'lock_waits',
      facts: {
        n: Math.max(valueOf(waits) ?? 0, blockedN, pairs.length),
        who: holder?.name ?? 'another session',
        holder: holder && owners.has(holderAddr) ? holder.name : null,
        idle: root
          ? /idle/.test(root.state)
            ? 1
            : 0
          : pair
            ? /idle/.test(pair.blocking_state)
              ? 1
              : 0
            : null,
        held: root?.xact ? duration(root.xact) : null,
        longest: duration(longest),
        // The sentence's word for it, as MySQL's facts name it.
        duration: duration(longest),
        table,
      },
      ...(holder?.link && (holder.link.kind === 'workload' || holder.link.kind === 'container')
        ? { links: [{ kind: holder.link.kind, id: holder.link.id, name: holder.link.name }] }
        : {}),
    });
  }
  if ((valueOf(deadlocks) ?? 0) > 0)
    out.push({
      severity: 'warning',
      code: 'deadlocks',
      facts: { n: Math.round(valueOf(deadlocks)!) },
    });
  const l = valueOf(lag) ?? valueOf(replay);
  if (l !== null && l > LAG_LINE)
    out.push({ severity: 'warning', code: 'replica_lag', facts: { duration: duration(l) } });
  for (const x of slots) {
    const b = x.points[0]?.[1] ?? 0;
    if (b > 2 ** 30)
      out.push({
        severity: 'warning',
        code: 'slot_retains_wal',
        facts: { slot: x.labels.slot ?? '', size: bytes(b) },
      });
  }
  const x = xid[0];
  const age = x?.points[0]?.[1] ?? 0;
  if (age > 1e9)
    out.push({
      severity: age > 1.5e9 ? 'critical' : 'warning',
      code: 'wraparound_risk',
      facts: { db: x!.labels.db ?? '', n: `${Math.round(age / 1e6)} M` },
    });
  const h = valueOf(hit) ?? 0;
  const r = valueOf(read) ?? 0;
  // Only with real reads: an idle server's ratio says nothing.
  if (r > 10 && h / (h + r) < 0.9)
    out.push({
      severity: 'info',
      code: 'cache_hit_low',
      facts: { pct: Math.round((h / (h + r)) * 100) },
    });
  if (stuck.size)
    out.push({
      severity: 'warning',
      code: 'autovacuum_not_finishing',
      facts: { n: stuck.size, table: [...stuck][0]!.split('/')[1] ?? null },
    });
  if (missing(ctx).some((p) => p.missing === 'pg_stat_statements'))
    out.push({ severity: 'info', code: 'statements_unavailable', facts: {} });
  out.push(...(await deepReasons(ctx, owners)));
  return out;
}

/**
 * The 1.2 findings (ADR-245): a statement far slower than its usual, a transaction open too
 * long, a slot that fills the disk, what the database mostly waits on, a sequence near its
 * maximum, settings that hurt, a client leaking connections.
 */
async function deepReasons(
  ctx: PageContext,
  owners: Awaited<ReturnType<typeof ownersOf>>,
): Promise<Reason[]> {
  const s = one(ctx.row.id);
  const now = Math.floor(ctx.now / 1000);
  const [stats, w15, settings, pending, slotGrowth, seqs, mem, maxConn, conns] = await Promise.all([
    statementStats(ctx, PG),
    waitsOver(ctx, PG, now, 900),
    instant(
      ctx,
      `max by (name) (watchlog_postgres_setting{${s}, name=~"fsync|full_page_writes|autovacuum|track_counts|shared_buffers|work_mem"})`,
    ),
    instant(ctx, `max(watchlog_postgres_pending_restart{${s}})`),
    instant(ctx, `max by (slot) (deriv(watchlog_postgres_slot_retained_bytes{${s}}[1h]) > 0)`),
    instant(ctx, `topk(1, max by (db, sequence) (watchlog_postgres_sequence_used_ratio{${s}}))`),
    memoryLimit(ctx),
    instant(ctx, `max(watchlog_postgres_setting{${s}, name="max_connections"})`),
    instant(ctx, connsOf(s)),
  ]);
  const out: Reason[] = [];
  const facts = statementFacts(ctx, PG);
  const slow = [...stats.values()]
    .filter((x) => x.slower)
    .sort((a, b) => (b.share ?? 0) - (a.share ?? 0))[0];
  if (slow) {
    const since = slow.usual ? await deep.slowerSince(ctx, slow.id, slow.usual) : null;
    out.push({
      severity: 'warning',
      code: 'statement_slower',
      facts: {
        statement: slow.id,
        query: (facts.get(slow.id)?.text ?? `queryid ${slow.id}`).slice(0, 120),
        x: Math.round(slow.slower!),
        mean: deep.duration(slow.mean ?? 0),
        sinceAt: since,
      },
    });
  }
  const txn = transactionsOf(ctx).find(longTxn);
  if (txn) {
    const who = clientOf(owners, txn.addr, txn.app);
    out.push({
      severity: txn.blocks > 0 ? 'critical' : 'warning',
      code: 'long_transaction',
      facts: {
        who: who.name,
        holder: owners.has(txn.addr) ? who.name : null,
        age: deep.duration(txn.age),
        idle: txn.idle ? deep.duration(txn.idleFor) : null,
        blocks: txn.blocks,
        xmin: txn.holdsXmin ? 1 : 0,
      },
      ...(who.link && (who.link.kind === 'workload' || who.link.kind === 'container')
        ? { links: [{ kind: who.link.kind, id: who.link.id, name: who.link.name }] }
        : {}),
    });
  }
  // A slot whose kept WAL grows: when it fills the data volume at this rate.
  const vol = slotGrowth.length ? await volumeOf(ctx) : null;
  for (const x of slotGrowth) {
    const g = x.points[0]?.[1] ?? 0;
    if (!vol || g <= 0) continue;
    const eta = (vol.capacity - vol.used) / g;
    if (eta < 7 * 86400)
      out.push({
        severity: eta < 86400 ? 'critical' : 'warning',
        code: 'slot_fills_disk',
        facts: { slot: x.labels.slot ?? '', eta: deep.duration(eta) },
      });
  }
  const top = dominantWait(w15);
  if (top && top.wait !== 'cpu' && top.share >= 0.5 && w15.total >= 1)
    out.push({
      severity: top.wait === 'lock' ? 'warning' : 'info',
      code: 'waits_mostly',
      facts: {
        pct: Math.round(top.share * 100),
        wait: top.wait,
        sessions: Math.round(w15.total * 10) / 10,
      },
    });
  const q = seqs[0];
  const used = q?.points[0]?.[1] ?? 0;
  if (q && used >= 0.7)
    out.push({
      severity: used >= 0.9 ? 'warning' : 'info',
      code: 'sequence_near_max',
      facts: { sequence: `${q.labels.db}: ${q.labels.sequence}`, pct: Math.round(used * 100) },
    });
  const set = new Map(settings.map((x) => [x.labels.name ?? '', x.points[0]?.[1] ?? null]));
  for (const name of ['fsync', 'full_page_writes', 'autovacuum', 'track_counts'])
    if (set.get(name) === 0)
      out.push({
        severity: name === 'fsync' || name === 'full_page_writes' ? 'critical' : 'warning',
        code: 'setting_risky',
        facts: { name },
      });
  if ((valueOf(pending) ?? 0) > 0)
    out.push({ severity: 'info', code: 'pending_restart', facts: { n: valueOf(pending) } });
  const m = valueOf(maxConn);
  const sb = set.get('shared_buffers');
  const wm = set.get('work_mem');
  if (mem && m && sb !== null && sb !== undefined && wm) {
    const need = sb + m * wm;
    if (need > 2 * mem)
      out.push({
        severity: 'info',
        code: 'connections_vs_memory',
        facts: { max: m, need: bytes(need), mem: bytes(mem) },
      });
  }
  // A client keeping many connections that all sit idle: probably a leak.
  const c = valueOf(conns);
  if (m && c) {
    const clients =
      (ctx.row.status_details as { extra?: { clients?: Record<string, unknown>[] } }).extra
        ?.clients ?? [];
    const leak = clients
      .filter(
        (x) =>
          Number(x.connections) >= 20 &&
          Number(x.idle) === Number(x.connections) &&
          Number(x.idle_min) >= 300,
      )
      .sort((a, b) => Number(b.connections) - Number(a.connections))[0];
    if (leak && Number(leak.connections) / m >= 0.2) {
      const who = clientOf(owners, String(leak.addr ?? ''), String(leak.app ?? ''));
      out.push({
        severity: c / m > 0.9 ? 'critical' : 'warning',
        code: 'connection_leak',
        facts: {
          who: who.name,
          holder: owners.has(String(leak.addr ?? '')) ? who.name : null,
          n: Number(leak.connections),
          idle: deep.duration(Number(leak.idle_min)),
          pct: Math.round((c / m) * 100),
        },
        ...(who.link && (who.link.kind === 'workload' || who.link.kind === 'container')
          ? { links: [{ kind: who.link.kind, id: who.link.id, name: who.link.name }] }
          : {}),
      });
    }
  }
  return out;
}

export const postgresPage: IntegrationPage = {
  id: 'postgres',
  tabs: [
    // 1.2 (ADR-245): Overview, Queries, Waits, Connections, Locks, Replication, Tables,
    // Vacuum, Alerts; a statement's and a table's page at their own addresses.
    { id: 'overview', title: 'integrations.postgres.tabs.overview', panels: overview },
    { id: 'queries', title: 'integrations.postgres.tabs.queries', panels: queries },
    { id: 'waits', title: 'integrations.db.tabs.waits', panels: deep.waitsTab },
    { id: 'connections', title: 'integrations.postgres.tabs.connections', panels: connections },
    {
      id: 'locks',
      title: 'integrations.postgres.tabs.locks',
      panels: locks,
      count: async (ctx) => {
        const n = treeSessions(ctx).filter((t) => t.blockedBy.length).length;
        return n || null;
      },
    },
    { id: 'replication', title: 'integrations.postgres.tabs.replication', panels: replication },
    { id: 'tables', title: 'integrations.postgres.tabs.tables', panels: tables },
    { id: 'vacuum', title: 'integrations.postgres.tabs.vacuum', panels: vacuum },
    { id: 'alerts', title: 'integrations.db.tabs.alerts', panels: async () => [], view: 'alerts' },
    // A statement's page (/applications/:id/statements/:statement), a table's
    // (/applications/:id/tables/:db/:table).
    {
      id: 'statement',
      title: 'integrations.db.tabs.statement',
      panels: deep.statementPage,
      hidden: true,
    },
    { id: 'table', title: 'integrations.db.tabs.table', panels: deep.tablePage, hidden: true },
    {
      id: 'connection',
      title: 'integrations.tabs.connection',
      panels: genericPage.tabs[0]!.panels,
    },
  ],

  async listMetrics({ vm, scope, ids, now }) {
    const s = some(ids);
    const end = Math.floor(now / 1000 / 300) * 300;
    const tps = `rate(watchlog_postgres_xact_commit_total{${s}}[5m]) + rate(watchlog_postgres_xact_rollback_total{${s}}[5m])`;
    const [conns, max, xact, hit, read, spark] = await Promise.all([
      vm.query(
        scope,
        `sum by (service) (watchlog_postgres_backends{${s}, db=""}) or 0 * max by (service) (watchlog_postgres_setting{${s}, name="max_connections"})`,
      ),
      vm.query(scope, `max by (service) (watchlog_postgres_setting{${s}, name="max_connections"})`),
      vm.query(scope, `sum by (service) (${tps})`),
      vm.query(scope, `sum by (service) (rate(watchlog_postgres_blks_hit_total{${s}}[15m]))`),
      vm.query(scope, `sum by (service) (rate(watchlog_postgres_blks_read_total{${s}}[15m]))`),
      vm.queryRange(scope, `sum by (service) (${tps})`, end - SPARK_RANGE, end, 300),
    ]);
    const at = (rows: typeof conns, id: string) =>
      rows.find((r) => r.labels.service === id)?.points[0]?.[1] ?? null;
    const out = new Map<string, RowMetrics>();
    for (const id of ids) {
      const c = at(conns, id);
      const m = at(max, id);
      const h = at(hit, id) ?? 0;
      const r = at(read, id) ?? 0;
      const ratio = c !== null && m ? c / m : null;
      out.set(id, {
        keyMetrics: [
          ratio !== null
            ? {
                id: 'connections',
                labelKey: `${P}.connectionsPct`,
                value: ratio,
                unit: 'ratio',
                severity: ratio > 0.9 ? 'warning' : undefined,
              }
            : { id: 'connections', labelKey: `${P}.connections`, value: c, unit: 'count' },
          { id: 'tps', labelKey: `${P}.tps`, value: at(xact, id), unit: 'per_second' },
          {
            id: 'cache',
            labelKey: `${P}.cacheHit`,
            value: h + r > 0 ? h / (h + r) : null,
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
