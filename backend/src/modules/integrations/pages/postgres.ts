// SPDX-License-Identifier: AGPL-3.0-only
// The PostgreSQL page (SPEC §4.12, v0.3 slice 8): Overview, Connections, Queries, Locks
// and waits, Replication, Tables and storage, and Vacuum, from the collector's
// pg_stat_* series; statements, blocking sessions, clients, vacuum and unused indexes
// from its status. The data volume's capacity is the PVC on Kubernetes and the host
// filesystem that holds Docker's data on Docker.
import { escapeLabelValue } from '../../query/catalog.js';
import { genericPage } from './generic.js';
import { ago, bytes, ipOwners, type Owner } from './owners.js';
import { instant, one, pointsOf, range, some, SPARK_RANGE, valueOf } from './query.js';
import type { IntegrationPage, PageContext, Panel, Reason, RowMetrics, Severity } from './types.js';

const P = 'integrations.postgres.panels';
const RATE = '2m';
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
async function volumeOf(
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

function statementRows(list: Statement[], calls1h: Map<string, number>) {
  return list.map((x) => ({
    cells: [
      x.query ?? `queryid ${x.queryid}`,
      ms(x.mean),
      Math.round(calls1h.get(x.queryid) ?? 0),
      ms(x.total),
    ],
    severity: x.mean > 1 ? ('warning' as Severity) : undefined,
  }));
}

async function overview(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [
    conns,
    maxConn,
    reserved,
    commits,
    rollbacks,
    hit,
    read,
    lag,
    replay,
    size,
    growth,
    longest,
    connSeries,
    maxSeries,
    commitSeries,
    rollbackSeries,
    busiest,
    calls1h,
    volume,
  ] = await Promise.all([
    instant(ctx, `sum(watchlog_postgres_backends{${s}})`),
    instant(ctx, `max(watchlog_postgres_setting{${s}, name="max_connections"})`),
    instant(ctx, `max(watchlog_postgres_setting{${s}, name="superuser_reserved_connections"})`),
    instant(ctx, `sum(rate(watchlog_postgres_xact_commit_total{${s}}[${RATE}]))`),
    instant(ctx, `sum(rate(watchlog_postgres_xact_rollback_total{${s}}[${RATE}]))`),
    instant(ctx, `sum(rate(watchlog_postgres_blks_hit_total{${s}}[15m]))`),
    instant(ctx, `sum(rate(watchlog_postgres_blks_read_total{${s}}[15m]))`),
    instant(ctx, `max(watchlog_postgres_replica_lag_seconds{${s}})`),
    instant(ctx, `max(watchlog_postgres_replay_lag_seconds{${s}})`),
    instant(ctx, `sum(max by (db) (watchlog_postgres_database_size_bytes{${s}}))`),
    instant(
      ctx,
      `sum(max by (db) (deriv(watchlog_postgres_database_size_bytes{${s}}[7d]) and last_over_time(watchlog_postgres_database_size_bytes{${s}}[1h] offset 1d))) * 86400`,
    ),
    instant(ctx, `max(watchlog_postgres_backend_max_seconds{${s}, kind="active"})`),
    range(ctx, `sum(watchlog_postgres_backends{${s}})`),
    range(ctx, `max(watchlog_postgres_setting{${s}, name="max_connections"})`),
    range(ctx, `sum(rate(watchlog_postgres_xact_commit_total{${s}}[${RATE}]))`),
    range(ctx, `sum(rate(watchlog_postgres_xact_rollback_total{${s}}[${RATE}]))`),
    instant(
      ctx,
      `topk(10, sum by (db) (rate(watchlog_postgres_xact_commit_total{${s}}[${RATE}]) + rate(watchlog_postgres_xact_rollback_total{${s}}[${RATE}])))`,
    ),
    instant(ctx, `sum by (queryid) (increase(watchlog_postgres_statement_calls_total{${s}}[1h]))`),
    volumeOf(ctx),
  ]);
  const c = valueOf(conns);
  const m = valueOf(maxConn);
  const cm = valueOf(commits) ?? 0;
  const rb = valueOf(rollbacks) ?? 0;
  const h = valueOf(hit) ?? 0;
  const r = valueOf(read) ?? 0;
  const lagS = valueOf(lag) ?? valueOf(replay);
  const g = valueOf(growth);
  const long = valueOf(longest);
  const res = valueOf(reserved);
  const callsBy = new Map(calls1h.map((x) => [x.labels.queryid ?? '', x.points[0]?.[1] ?? 0]));
  const slowest = [...(extra(ctx).statements ?? [])].sort((a, b) => b.mean - a.mean).slice(0, 10);
  const days =
    volume && volume.perDay && volume.perDay > 0
      ? Math.floor((volume.capacity - volume.used) / volume.perDay)
      : null;
  return [
    {
      id: 'summary',
      title: `${P}.summary`,
      kind: 'stat',
      span: 2,
      state: c === null ? 'empty' : 'ok',
      tiles: [
        {
          id: 'connections',
          labelKey: `${P}.connections`,
          value: c,
          unit: 'count',
          sub: m ? { key: `${P}.ofMax`, values: { max: m } } : undefined,
          severity: c !== null && m ? (c / m > 0.9 ? 'warning' : 'ok') : undefined,
        },
        {
          id: 'tps',
          labelKey: `${P}.tps`,
          value: cm + rb,
          unit: 'per_second',
          sub:
            cm + rb > 0
              ? { key: `${P}.commitPct`, values: { pct: Math.round((cm / (cm + rb)) * 100) } }
              : undefined,
        },
        {
          id: 'cache',
          labelKey: `${P}.cacheHit`,
          value: h + r > 0 ? h / (h + r) : null,
          unit: 'ratio',
          severity: h + r > 0 && h / (h + r) < 0.9 ? 'warning' : undefined,
        },
        {
          id: 'lag',
          labelKey: `${P}.replicationLag`,
          value: lagS,
          unit: 'seconds',
          sub: lagS === null ? { key: `${P}.noReplicas` } : undefined,
          severity: lagS !== null && lagS > LAG_LINE ? 'warning' : undefined,
        },
        {
          id: 'size',
          labelKey: `${P}.size`,
          value: valueOf(size),
          unit: 'bytes',
          sub:
            g !== null ? { key: `${P}.perDay`, values: { growth: bytes(Math.abs(g)) } } : undefined,
        },
        {
          id: 'longest',
          labelKey: `${P}.longestQuery`,
          value: long,
          unit: 'seconds',
          severity: long !== null && long > LONG_QUERY ? 'critical' : undefined,
        },
      ],
    },
    {
      id: 'connections',
      title: `${P}.connectionsOverTime`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: connSeries.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.connections`, points: pointsOf(connSeries[0]) },
        ...(maxSeries[0]
          ? [{ nameKey: `${P}.maxConnections`, points: pointsOf(maxSeries[0]), dashed: true }]
          : []),
      ],
    },
    {
      id: 'transactions',
      title: `${P}.transactions`,
      kind: 'stack',
      span: 1,
      unit: 'per_second',
      state: commitSeries.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.commits`, points: pointsOf(commitSeries[0]), severity: 'ok' },
        {
          nameKey: `${P}.series.rollbacks`,
          points: pointsOf(rollbackSeries[0]),
          severity: 'warning',
        },
      ],
    },
    {
      id: 'slowest',
      title: `${P}.slowest`,
      kind: 'table',
      span: 2,
      state: slowest.length ? 'ok' : 'empty',
      note: { key: `${P}.statementsNote` },
      columns: [`${P}.cols.query`, `${P}.cols.mean`, `${P}.cols.calls1h`, `${P}.cols.total`],
      rows: statementRows(slowest, callsBy),
    },
    {
      id: 'busiest',
      title: `${P}.busiest`,
      kind: 'bars',
      span: 1,
      unit: 'per_second',
      state: busiest.length ? 'ok' : 'empty',
      items: busiest
        .map((x) => ({ label: x.labels.db ?? '', value: x.points[0]?.[1] ?? 0 }))
        .sort((a, b) => b.value - a.value),
    },
    {
      id: 'capacity',
      title: `${P}.capacity`,
      kind: 'gauge',
      span: 1,
      state: m || volume ? 'ok' : 'empty',
      note: ctx.row.target.kind === 'workload' || volume ? undefined : { key: `${P}.noVolume` },
      items: [
        ...(m
          ? [
              {
                labelKey: `${P}.maxConnections`,
                value: c ?? 0,
                max: m,
                unit: 'count' as const,
                warnAt: 0.9,
                note: res ? { key: `${P}.reserved`, values: { n: res } } : undefined,
              },
            ]
          : []),
        ...(volume
          ? [
              {
                label: volume.name,
                value: volume.used,
                max: volume.capacity,
                unit: 'bytes' as const,
                warnAt: 0.85,
                // Growth needs a day of history: minutes of it would read an image pull as
                // the week's trend.
                note:
                  days !== null
                    ? { key: `${P}.daysLeft`, values: { days } }
                    : volume.perDay === null
                      ? { key: `${P}.growthUnknown` }
                      : { key: `${P}.notGrowing` },
              },
            ]
          : []),
      ],
    },
  ];
}

async function connections(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [byState, maxConn, now, idleTx, timeout, sessions, owners] = await Promise.all([
    range(ctx, `sum by (state) (watchlog_postgres_backends{${s}})`),
    instant(ctx, `max(watchlog_postgres_setting{${s}, name="max_connections"})`),
    instant(ctx, `sum(watchlog_postgres_backends{${s}})`),
    instant(ctx, `sum(watchlog_postgres_backends{${s}, state=~"idle in transaction.*"})`),
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
  const top = [...list].sort((a, b) => b.total - a.total).slice(0, 20);
  return [
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
    {
      id: 'top',
      title: `${P}.topQueries`,
      kind: 'table',
      span: 2,
      state: top.length ? 'ok' : 'empty',
      note: { key: `${P}.statementsNote` },
      columns: [`${P}.cols.query`, `${P}.cols.total`, `${P}.cols.mean`, `${P}.cols.rowsPerCall`],
      rows: top.map((x) => ({
        cells: [
          x.query ?? `queryid ${x.queryid}`,
          ms(x.total),
          ms(x.mean),
          x.calls ? +(x.rows / x.calls).toFixed(1) : 0,
        ],
      })),
    },
  ];
}

async function locks(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const end = Math.floor(ctx.now / 1000 / 3600) * 3600;
  const [waits, deadlocks, locked, heat, owners] = await Promise.all([
    range(ctx, `sum by (wait) (watchlog_postgres_backends{${s}, wait!=""})`),
    range(ctx, `sum(increase(watchlog_postgres_deadlocks_total{${s}}[5m]))`),
    instant(ctx, `topk(10, max by (table) (watchlog_postgres_locked_relation{${s}}))`),
    ctx.vm
      ? ctx.vm.queryRange(
          { clusterId: ctx.row.cluster_id },
          `max_over_time(sum(watchlog_postgres_lock_waits{${s}})[1h])`,
          end - 7 * 86400,
          end,
          3600,
        )
      : Promise.resolve([]),
    ipOwners(ctx.db, ctx.row.cluster_id),
  ]);
  const blocking = [...(extra(ctx).blocking ?? [])].sort((a, b) => b.seconds - a.seconds);
  const q = (text: string) => text || '–';
  return [
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
      id: 'blocking',
      title: `${P}.blocking`,
      kind: 'table',
      span: 2,
      state: blocking.length ? 'ok' : 'empty',
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
    instant(ctx, `sum(watchlog_postgres_backends{${s}})`),
    instant(ctx, `max(watchlog_postgres_setting{${s}, name="max_connections"})`),
    instant(ctx, `max(watchlog_postgres_backend_max_seconds{${s}, kind="active"})`),
    instant(ctx, `max(watchlog_postgres_backend_max_seconds{${s}, kind="idle_in_transaction"})`),
    instant(ctx, `sum(watchlog_postgres_backends{${s}, state=~"idle in transaction.*"})`),
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
  if (long !== null && long > LONG_QUERY)
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
  const blocking = extra(ctx).blocking ?? [];
  if ((valueOf(waits) ?? 0) > 0 || blocking.length) {
    const worst = [...blocking].sort((a, b) => b.seconds - a.seconds)[0];
    out.push({
      severity: 'warning',
      code: 'lock_waits',
      facts: {
        n: Math.max(valueOf(waits) ?? 0, blocking.length),
        who: worst ? clientName(owners, worst.blocking) : 'another session',
      },
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
  return out;
}

export const postgresPage: IntegrationPage = {
  id: 'postgres',
  tabs: [
    { id: 'overview', title: 'integrations.postgres.tabs.overview', panels: overview },
    { id: 'connections', title: 'integrations.postgres.tabs.connections', panels: connections },
    { id: 'queries', title: 'integrations.postgres.tabs.queries', panels: queries },
    { id: 'locks', title: 'integrations.postgres.tabs.locks', panels: locks },
    { id: 'replication', title: 'integrations.postgres.tabs.replication', panels: replication },
    { id: 'tables', title: 'integrations.postgres.tabs.tables', panels: tables },
    { id: 'vacuum', title: 'integrations.postgres.tabs.vacuum', panels: vacuum },
    {
      id: 'connection',
      title: 'integrations.tabs.connection',
      panels: genericPage.tabs[0]!.panels,
    },
  ],

  async listMetrics({ vm, clusterId, ids, now }) {
    const scope = { clusterId };
    const s = some(ids);
    const end = Math.floor(now / 1000 / 300) * 300;
    const tps = `rate(watchlog_postgres_xact_commit_total{${s}}[5m]) + rate(watchlog_postgres_xact_rollback_total{${s}}[5m])`;
    const [conns, max, xact, hit, read, spark] = await Promise.all([
      vm.query(scope, `sum by (service) (watchlog_postgres_backends{${s}})`),
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
