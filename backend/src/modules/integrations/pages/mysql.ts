// SPDX-License-Identifier: AGPL-3.0-only
// The MySQL and MariaDB page (SPEC §4.12, ADR-163, v0.5 slice 1): Overview, Connections,
// Queries, Locks, InnoDB and storage, and Replication, from the collector's status-variable
// series; statements (the digest summary), lock waits, clients and replica state from its
// status. One type for both servers; the product comes from the server's version.
import { genericPage } from './generic.js';
import { bytes, ipOwners, type Owner } from './owners.js';
import { instant, one, pointsOf, range, some, SPARK_RANGE, valueOf } from './query.js';
import * as deep from './mysql-deep.js';
import { volumeOf } from './postgres.js';
import {
  clientOf,
  dominantWait,
  longTxn,
  memoryLimit,
  MY,
  ownersOf,
  slowerSince,
  statementFacts,
  statementStats,
  transactionsOf,
  treeSessions,
  waitsOver,
} from './db-deep.js';
import type { IntegrationPage, PageContext, Panel, Reason, RowMetrics, Severity } from './types.js';

const P = 'integrations.mysql.panels';
const RATE = '2m';
const LONG_QUERY = 300;
const LAG_LINE = 30;

interface Statement {
  digest: string;
  db: string;
  calls: number;
  total: number;
  mean: number;
  max: number;
  rows_examined: number;
  rows_sent: number;
  query?: string;
}
export interface MysqlBlocking {
  blocked: string;
  blocked_user: string;
  blocking: string;
  blocking_user: string;
  blocking_state: string;
  /** How long the waiting session has waited. */
  seconds: number;
  /** How long the blocking session's transaction has been open. */
  held: number;
  table: string;
  member: string;
}
interface Client {
  addr: string;
  user: string;
  connections: number;
  member: string;
}
interface Replica {
  member: string;
  io: string;
  sql: string;
  source: string;
  error: string;
}
interface Extra {
  statements?: Statement[];
  blocking?: MysqlBlocking[];
  clients?: Client[];
  replica?: Replica[];
}
const extra = (ctx: PageContext): Extra =>
  (ctx.row.status_details as { extra?: Extra }).extra ?? {};
const missing = (ctx: PageContext) =>
  (ctx.row.status_details as { permissions?: { tab: string; missing: string }[] }).permissions ??
  [];
const permissionOf = (ctx: PageContext, tab: string) =>
  missing(ctx).find((p) => p.tab === tab)?.missing ?? null;

/** A client by its workload or container, else its address, else its user. */
function clientName(owners: Map<string, Owner>, addr: string, user?: string): string {
  if (addr && owners.has(addr)) return owners.get(addr)!.name;
  if (addr && addr !== 'localhost') return addr;
  return user ? `${user}@${addr || 'local'}` : addr || 'local';
}

export const duration = (s: number) =>
  s >= 3600
    ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
    : s >= 90
      ? `${Math.round(s / 60)} min`
      : `${Math.round(s)} s`;

/** A panel that needs performance_schema or a privilege the user lacks. */
function needs(ctx: PageContext, tab: string): Pick<Panel, 'state' | 'missing'> | null {
  const m = permissionOf(ctx, tab);
  if (!m) return null;
  return {
    state: 'needs_permission',
    missing:
      m === 'performance_schema'
        ? { key: `${P}.perfSchemaOff` }
        : { key: `${P}.grant`, values: { grant: m } },
  };
}

/** The Overview after the design (1.2, ADR-245). */
async function overview(ctx: PageContext): Promise<Panel[]> {
  return deep.overview(ctx, await volumeOf(ctx));
}

async function connections(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [connected, running, maxConn, maxUsed, aborted, refused, owners] = await Promise.all([
    range(ctx, `sum(watchlog_mysql_threads_connected{${s}})`),
    range(ctx, `sum(watchlog_mysql_threads_running{${s}})`),
    instant(ctx, `max(watchlog_mysql_setting{${s}, name="max_connections"})`),
    instant(ctx, `max(watchlog_mysql_max_used_connections{${s}})`),
    range(ctx, `sum(rate(watchlog_mysql_aborted_connects_total{${s}}[${RATE}]))`),
    range(ctx, `sum(rate(watchlog_mysql_refused_connections_total{${s}}[${RATE}]))`),
    ipOwners(ctx.db, ctx.row.cluster_id),
  ]);
  const by = new Map<string, number>();
  for (const c of extra(ctx).clients ?? []) {
    const who = clientName(owners, c.addr, c.user);
    by.set(who, (by.get(who) ?? 0) + c.connections);
  }
  const m = valueOf(maxConn);
  const used = valueOf(maxUsed);
  return [
    {
      id: 'threads',
      title: `${P}.threads`,
      kind: 'line',
      span: 2,
      unit: 'count',
      state: connected.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.connected`, points: pointsOf(connected[0]) },
        { nameKey: `${P}.series.running`, points: pointsOf(running[0]) },
      ],
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
              value: connected[0]?.points.at(-1)?.[1] ?? 0,
              max: m,
              unit: 'count',
              warnAt: 0.9,
            },
            {
              labelKey: `${P}.maxUsed`,
              value: used ?? 0,
              max: m,
              unit: 'count',
              warnAt: 0.9,
            },
          ]
        : [],
    },
    {
      id: 'aborted',
      title: `${P}.aborted`,
      kind: 'line',
      span: 2,
      unit: 'per_second',
      state: aborted.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.aborted`, points: pointsOf(aborted[0]), severity: 'warning' },
        { nameKey: `${P}.series.refused`, points: pointsOf(refused[0]), severity: 'critical' },
      ],
    },
    ...(await deep.connectionsDeep(ctx)),
  ];
}

/** Statement means into buckets, weighted by calls (MariaDB has no histogram). */
function meanBuckets(list: Statement[]) {
  const edges = [0.001, 0.01, 0.1, 1, 10];
  const n = new Array<number>(LABELS.length).fill(0);
  let total = 0;
  for (const x of list) {
    const i = edges.findIndex((e) => x.mean <= e);
    n[i === -1 ? LABELS.length - 1 : i]! += x.calls;
    total += x.calls;
  }
  return LABELS.map((label, i) => ({ label, share: total ? n[i]! / total : 0 }));
}
const LABELS = ['≤1 ms', '≤10 ms', '≤100 ms', '≤1 s', '≤10 s', '>10 s'];
const LE = ['0.001', '0.01', '0.1', '1', '10', '+Inf'];

async function queries(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const ops = ['read', 'inserted', 'updated', 'deleted'] as const;
  const seconds = Math.max(ctx.range, 300);
  const [rows, tmp, scans, hist] = await Promise.all([
    range(ctx, `sum by (op) (rate(watchlog_mysql_rows_total{${s}}[${RATE}]))`),
    range(ctx, `sum(rate(watchlog_mysql_tmp_disk_tables_total{${s}}[${RATE}]))`),
    range(ctx, `sum(rate(watchlog_mysql_select_scan_total{${s}}[${RATE}]))`),
    instant(
      ctx,
      `sum by (le) (increase(watchlog_mysql_statement_latency_bucket{${s}}[${seconds}s]))`,
    ),
  ]);
  const list = extra(ctx).statements ?? [];
  // The server's histogram (MySQL 8.0.19+), else statements by their mean (MariaDB).
  const cum = LE.map((le) => hist.find((x) => x.labels.le === le)?.points[0]?.[1] ?? 0);
  const totalH = cum.at(-1) ?? 0;
  const fromHist = totalH > 0;
  const buckets = fromHist
    ? LABELS.map((label, i) => ({
        label,
        share: Math.max(0, cum[i]! - (i ? cum[i - 1]! : 0)) / totalH,
      }))
    : meanBuckets(list);
  return [
    {
      id: 'rows',
      title: `${P}.rows`,
      kind: 'stack',
      span: 2,
      unit: 'per_second',
      state: rows.length ? 'ok' : 'empty',
      series: ops.map((o) => ({
        nameKey: `${P}.series.${o}`,
        points: pointsOf(rows.find((x) => x.labels.op === o)),
      })),
    },
    {
      id: 'duration',
      title: `${P}.duration`,
      kind: 'hist',
      span: 1,
      ...(fromHist
        ? { state: 'ok' }
        : (needs(ctx, 'queries/top') ?? { state: list.length ? 'ok' : 'empty' })),
      note: fromHist ? { key: `${P}.fromHistogram` } : { key: `${P}.byStatementMean` },
      buckets,
    } as Panel,
    {
      id: 'tmp',
      title: `${P}.tmpAndScans`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: tmp.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.tmpDisk`, points: pointsOf(tmp[0]), severity: 'warning' },
        { nameKey: `${P}.series.fullScans`, points: pointsOf(scans[0]) },
      ],
    },
    await deep.statementsPanel(ctx),
  ];
}

async function locks(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [waits, waitTime, deadlocks, owners] = await Promise.all([
    range(ctx, `sum(rate(watchlog_mysql_row_lock_waits_total{${s}}[${RATE}]))`),
    range(ctx, `sum(rate(watchlog_mysql_row_lock_wait_seconds_total{${s}}[${RATE}]))`),
    range(ctx, `sum(increase(watchlog_mysql_deadlocks_total{${s}}[5m]))`),
    ipOwners(ctx.db, ctx.row.cluster_id),
  ]);
  const blocking = [...(extra(ctx).blocking ?? [])].sort((a, b) => b.seconds - a.seconds);
  return [
    ...(await deep.locksDeep(ctx)),
    {
      id: 'waits',
      title: `${P}.rowLockWaits`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: waits.length ? 'ok' : 'empty',
      series: [{ nameKey: `${P}.series.waits`, points: pointsOf(waits[0]), severity: 'warning' }],
    },
    {
      id: 'wait-time',
      title: `${P}.rowLockTime`,
      kind: 'line',
      span: 1,
      unit: 'seconds',
      state: waitTime.length ? 'ok' : 'empty',
      note: { key: `${P}.rowLockTimeNote` },
      series: [{ nameKey: `${P}.series.waitTime`, points: pointsOf(waitTime[0]) }],
    },
    {
      id: 'blocking',
      title: `${P}.blocking`,
      kind: 'table',
      span: 2,
      ...(needs(ctx, 'locks/blocking') ?? { state: blocking.length ? 'ok' : 'empty' }),
      note: { key: `${P}.blockingNote` },
      columns: [
        `${P}.cols.waiting`,
        `${P}.cols.table`,
        `${P}.cols.for`,
        `${P}.cols.blockedBy`,
        `${P}.cols.openFor`,
      ],
      rows: blocking.map((x) => ({
        cells: [
          clientName(owners, x.blocked, x.blocked_user),
          x.table || '–',
          duration(x.seconds),
          `${clientName(owners, x.blocking, x.blocking_user)} (${x.blocking_state || '?'})`,
          duration(x.held),
        ],
        severity: x.seconds > 60 ? ('warning' as Severity) : undefined,
      })),
    } as Panel,
    {
      id: 'deadlocks',
      title: `${P}.deadlocks`,
      kind: 'line',
      span: 2,
      unit: 'count',
      state: deadlocks.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.deadlocks`, points: pointsOf(deadlocks[0]), severity: 'critical' },
      ],
    },
  ];
}

async function storage(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [pages, diskReads, redo, tables] = await Promise.all([
    instant(ctx, `sum by (state) (watchlog_mysql_buffer_pool_pages{${s}})`),
    range(ctx, `sum(rate(watchlog_mysql_buffer_pool_reads_total{${s}}[${RATE}]))`),
    range(ctx, `sum(rate(watchlog_mysql_redo_written_bytes_total{${s}}[${RATE}]))`),
    instant(ctx, `topk(15, max by (db, table) (watchlog_mysql_table_size_bytes_estimate{${s}}))`),
  ]);
  const page = (st: string) => pages.find((x) => x.labels.state === st)?.points[0]?.[1] ?? 0;
  const total = page('total');
  return [
    {
      id: 'buffer-pool',
      title: `${P}.bufferPool`,
      kind: 'gauge',
      span: 1,
      state: total ? 'ok' : 'empty',
      items: total
        ? [
            {
              labelKey: `${P}.pagesWithData`,
              value: page('data'),
              max: total,
              unit: 'count',
              warnAt: 1.01,
            },
            {
              labelKey: `${P}.pagesDirty`,
              value: page('dirty'),
              max: total,
              unit: 'count',
              warnAt: 0.75,
            },
          ]
        : [],
    },
    {
      id: 'disk-reads',
      title: `${P}.diskReads`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: diskReads.length ? 'ok' : 'empty',
      series: [{ nameKey: `${P}.series.diskReads`, points: pointsOf(diskReads[0]) }],
    },
    {
      id: 'redo',
      title: `${P}.redo`,
      kind: 'line',
      span: 1,
      unit: 'bytes_per_second',
      state: redo.length ? 'ok' : 'empty',
      series: [{ nameKey: `${P}.series.redo`, points: pointsOf(redo[0]) }],
    },
    {
      id: 'tables',
      title: `${P}.largestTables`,
      kind: 'bars',
      span: 1,
      unit: 'bytes',
      ...(needs(ctx, 'storage/tables') ?? { state: tables.length ? 'ok' : 'empty' }),
      note: { key: `${P}.tablesEstimate` },
      items: tables
        .map((x) => ({
          label: `${x.labels.db}.${x.labels.table}`,
          value: x.points[0]?.[1] ?? 0,
        }))
        .sort((a, b) => b.value - a.value),
    } as Panel,
    ...(await deep.innodbDeep(ctx)),
  ];
}

async function replication(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [lag, isReplica] = await Promise.all([
    range(ctx, `max by (member) (watchlog_mysql_replica_lag_seconds{${s}})`),
    instant(ctx, `max(watchlog_mysql_is_replica{${s}})`),
  ]);
  const replicas = extra(ctx).replica ?? [];
  const first = lag[0]?.points ?? [];
  const denied = needs(ctx, 'replication/status');
  const notReplica = valueOf(isReplica) === 0;
  return [
    {
      id: 'threads',
      title: `${P}.replicaThreads`,
      kind: 'table',
      span: 2,
      ...(denied ?? { state: replicas.length ? 'ok' : 'empty' }),
      note: notReplica ? { key: `${P}.notReplicaNote` } : undefined,
      columns: [
        `${P}.cols.member`,
        `${P}.cols.source`,
        `${P}.cols.io`,
        `${P}.cols.sql`,
        `${P}.cols.lastError`,
      ],
      rows: replicas.map((r) => ({
        cells: [r.member, r.source, r.io, r.sql, r.error || '–'],
        severity:
          r.io.toLowerCase() !== 'yes' || r.sql.toLowerCase() !== 'yes'
            ? ('critical' as Severity)
            : undefined,
      })),
    } as Panel,
    {
      id: 'lag',
      title: `${P}.replicaLag`,
      kind: 'line',
      span: 2,
      unit: 'seconds',
      state: lag.length ? 'ok' : 'empty',
      note: lag.length ? undefined : { key: `${P}.notReplicaNote` },
      series: [
        ...lag.map((x) => ({ name: x.labels.member ?? '', points: pointsOf(x) })),
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
    ...(await deep.replicationDeep(ctx, await volumeOf(ctx))),
  ];
}

async function reasons(ctx: PageContext): Promise<Reason[]> {
  const s = one(ctx.row.id);
  const [
    conns,
    maxConn,
    refused,
    longest,
    waits,
    deadlocks,
    lag,
    stopped,
    reads,
    requests,
    tmpDisk,
    owners,
  ] = await Promise.all([
    instant(ctx, `sum(watchlog_mysql_threads_connected{${s}})`),
    instant(ctx, `max(watchlog_mysql_setting{${s}, name="max_connections"})`),
    instant(ctx, `sum(increase(watchlog_mysql_refused_connections_total{${s}}[15m]))`),
    instant(ctx, `max(watchlog_mysql_longest_query_seconds{${s}})`),
    instant(ctx, `max(watchlog_mysql_row_lock_current_waits{${s}})`),
    instant(ctx, `sum(increase(watchlog_mysql_deadlocks_total{${s}}[15m]))`),
    instant(ctx, `max(watchlog_mysql_replica_lag_seconds{${s}})`),
    instant(ctx, `max(1 - watchlog_mysql_replica_running{${s}})`),
    instant(ctx, `sum(rate(watchlog_mysql_buffer_pool_reads_total{${s}}[15m]))`),
    instant(ctx, `sum(rate(watchlog_mysql_buffer_pool_read_requests_total{${s}}[15m]))`),
    instant(ctx, `sum(rate(watchlog_mysql_tmp_disk_tables_total{${s}}[15m]))`),
    ipOwners(ctx.db, ctx.row.cluster_id),
  ]);
  const out: Reason[] = [];
  const c = valueOf(conns);
  const m = valueOf(maxConn);
  if (c !== null && m && c / m > 0.9) {
    // The clients holding most connections, by name (as PostgreSQL's): probable cause
    // follows the first to its own cause.
    const by = new Map<string, number>();
    for (const x of extra(ctx).clients ?? []) {
      const name = clientName(owners, x.addr, x.user);
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
  const r = valueOf(refused) ?? 0;
  if (r > 0)
    out.push({
      severity: 'critical',
      code: 'connections_refused',
      facts: { n: Math.round(r), max: m },
    });
  const long = valueOf(longest);
  if (long !== null && long > LONG_QUERY)
    out.push({ severity: 'critical', code: 'long_query', facts: { duration: duration(long) } });
  const blocking = extra(ctx).blocking ?? [];
  if ((valueOf(waits) ?? 0) > 0 || blocking.length) {
    const worst = [...blocking].sort((a, b) => b.seconds - a.seconds)[0];
    const holder = worst ? owners.get(worst.blocking) : undefined;
    out.push({
      severity: 'warning',
      code: 'lock_waits',
      facts: {
        n: Math.max(valueOf(waits) ?? 0, blocking.length),
        who: worst ? clientName(owners, worst.blocking, worst.blocking_user) : 'another session',
        waiting: worst ? clientName(owners, worst.blocked, worst.blocked_user) : null,
        table: worst?.table || null,
        duration: worst ? duration(worst.seconds) : null,
        held: worst ? duration(worst.held) : null,
        // When the blocking transaction began: the "since" of probable cause's chain.
        sinceAt: worst ? Math.floor(ctx.now / 1000) - worst.held : null,
        // The holder as probable cause looks it up: a workload ("ns/name") or a container.
        holder: holder?.name ?? null,
      },
    });
  }
  if ((valueOf(deadlocks) ?? 0) > 0)
    out.push({
      severity: 'warning',
      code: 'deadlocks',
      facts: { n: Math.round(valueOf(deadlocks)!) },
    });
  if ((valueOf(stopped) ?? 0) > 0) {
    const r0 = (extra(ctx).replica ?? []).find(
      (x) => x.io.toLowerCase() !== 'yes' || x.sql.toLowerCase() !== 'yes',
    );
    out.push({
      severity: 'critical',
      code: 'replica_stopped',
      facts: {
        member: r0?.member ?? null,
        thread: r0 ? (r0.io.toLowerCase() !== 'yes' ? 'IO' : 'SQL') : null,
        error: r0?.error || null,
      },
    });
  }
  const l = valueOf(lag);
  if (l !== null && l > LAG_LINE)
    out.push({ severity: 'warning', code: 'replica_lag', facts: { duration: duration(l) } });
  const rd = valueOf(reads) ?? 0;
  const rq = valueOf(requests) ?? 0;
  // Only with real reads from disk: an idle server's ratio says nothing.
  if (rd > 10 && rq > 0 && 1 - rd / rq < 0.9)
    out.push({
      severity: 'info',
      code: 'buffer_pool_hit_low',
      facts: { pct: Math.round((1 - rd / rq) * 100) },
    });
  const td = valueOf(tmpDisk) ?? 0;
  if (td > 1)
    out.push({
      severity: 'info',
      code: 'tmp_disk_tables_high',
      facts: { perSec: +td.toFixed(1) },
    });
  const perms = missing(ctx);
  if (perms.some((p) => p.missing === 'performance_schema'))
    out.push({ severity: 'info', code: 'performance_schema_off', facts: {} });
  if (perms.some((p) => p.tab === 'storage/tables'))
    out.push({ severity: 'info', code: 'table_stats_unavailable', facts: {} });
  out.push(...(await deepReasons(ctx, owners, valueOf(conns), valueOf(maxConn))));
  return out;
}

/**
 * The 1.2 findings (ADR-245): a statement far slower than its usual, a transaction open too
 * long (with the history list it holds), the binary logs filling the disk, what the server
 * mostly waits on, settings that hurt, a client leaking connections, the redo log nearly full.
 */
async function deepReasons(
  ctx: PageContext,
  owners: Awaited<ReturnType<typeof ownersOf>>,
  c: number | null,
  m: number | null,
): Promise<Reason[]> {
  const s = one(ctx.row.id);
  const now = Math.floor(ctx.now / 1000);
  const [stats, w15, settings, binlogGrowth, hll, redoUse, redoCap, mem, pool] = await Promise.all([
    statementStats(ctx, MY),
    waitsOver(ctx, MY, now, 900),
    instant(
      ctx,
      `max by (name) (watchlog_mysql_setting{${s}, name=~"innodb_flush_log_at_trx_commit|sync_binlog|innodb_doublewrite|log_bin"})`,
    ),
    instant(ctx, `max(deriv(watchlog_mysql_binlog_bytes{${s}}[1h]))`),
    instant(ctx, `max(watchlog_mysql_history_list_length{${s}})`),
    instant(ctx, `max(watchlog_mysql_redo_in_use_bytes{${s}})`),
    instant(ctx, `max(watchlog_mysql_redo_capacity_bytes{${s}})`),
    memoryLimit(ctx),
    instant(ctx, `max(watchlog_mysql_setting{${s}, name="innodb_buffer_pool_size"})`),
  ]);
  const out: Reason[] = [];
  const facts = statementFacts(ctx, MY);
  const slow = [...stats.values()]
    .filter((x) => x.slower)
    .sort((a, b) => (b.share ?? 0) - (a.share ?? 0))[0];
  if (slow) {
    const since = slow.usual ? await slowerSince(ctx, MY, slow.id, slow.usual) : null;
    out.push({
      severity: 'warning',
      code: 'statement_slower',
      facts: {
        statement: slow.id,
        query: (facts.get(slow.id)?.text ?? `digest ${slow.id}`).slice(0, 120),
        x: Math.round(slow.slower!),
        mean: duration(slow.mean ?? 0),
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
        age: duration(txn.age),
        idle: txn.idle ? duration(txn.idleFor) : null,
        blocks: txn.blocks,
        history: valueOf(hll),
      },
      ...(who.link && (who.link.kind === 'workload' || who.link.kind === 'container')
        ? { links: [{ kind: who.link.kind, id: who.link.id, name: who.link.name }] }
        : {}),
    });
  } else if ((valueOf(hll) ?? 0) > 1_000_000)
    out.push({ severity: 'warning', code: 'history_list_long', facts: { n: valueOf(hll) } });
  const g = valueOf(binlogGrowth) ?? 0;
  if (g > 0) {
    const vol = await volumeOf(ctx);
    const eta = vol ? (vol.capacity - vol.used) / g : null;
    if (eta !== null && eta < 7 * 86400)
      out.push({
        severity: eta < 86400 ? 'critical' : 'warning',
        code: 'binlog_fills_disk',
        facts: { eta: duration(eta) },
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
  const set = new Map(settings.map((x) => [x.labels.name ?? '', x.points[0]?.[1] ?? null]));
  if (
    set.get('innodb_flush_log_at_trx_commit') !== undefined &&
    set.get('innodb_flush_log_at_trx_commit') !== 1
  )
    out.push({
      severity: 'warning',
      code: 'setting_risky',
      facts: { name: 'innodb_flush_log_at_trx_commit' },
    });
  if (set.get('log_bin') === 1 && set.get('sync_binlog') === 0)
    out.push({ severity: 'warning', code: 'setting_risky', facts: { name: 'sync_binlog' } });
  if (set.get('innodb_doublewrite') === 0)
    out.push({ severity: 'warning', code: 'setting_risky', facts: { name: 'innodb_doublewrite' } });
  const bp = valueOf(pool);
  if (mem && bp && bp > 0.9 * mem)
    out.push({
      severity: 'info',
      code: 'buffer_pool_vs_memory',
      facts: { pool: bytes(bp), mem: bytes(mem) },
    });
  const ru = valueOf(redoUse);
  const rc = valueOf(redoCap);
  if (ru !== null && rc && ru / rc > 0.9)
    out.push({
      severity: 'warning',
      code: 'redo_nearly_full',
      facts: { pct: Math.round((ru / rc) * 100) },
    });
  // A client keeping many connections that all sleep: probably a leak.
  if (c && m) {
    const leak = (extra(ctx).clients ?? [])
      .map((x) => x as unknown as Record<string, unknown>)
      .filter(
        (x) =>
          Number(x.connections) >= 20 &&
          Number(x.sleeping) === Number(x.connections) &&
          Number(x.idle_min) >= 300,
      )
      .sort((a, b) => Number(b.connections) - Number(a.connections))[0];
    if (leak && Number(leak.connections) / m >= 0.2) {
      const who = clientOf(owners, String(leak.addr ?? ''), String(leak.user ?? ''));
      out.push({
        severity: c / m > 0.9 ? 'critical' : 'warning',
        code: 'connection_leak',
        facts: {
          who: who.name,
          holder: owners.has(String(leak.addr ?? '')) ? who.name : null,
          n: Number(leak.connections),
          idle: duration(Number(leak.idle_min)),
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

export const mysqlPage: IntegrationPage = {
  id: 'mysql',
  tabs: [
    // 1.2 (ADR-245): Overview, Queries, Waits, Connections, Locks, Replication, Tables,
    // InnoDB, Alerts; a statement's and a table's page at their own addresses.
    { id: 'overview', title: 'integrations.mysql.tabs.overview', panels: overview },
    { id: 'queries', title: 'integrations.mysql.tabs.queries', panels: queries },
    { id: 'waits', title: 'integrations.db.tabs.waits', panels: deep.waitsTab },
    { id: 'connections', title: 'integrations.mysql.tabs.connections', panels: connections },
    {
      id: 'locks',
      title: 'integrations.mysql.tabs.locks',
      panels: locks,
      count: async (ctx) => treeSessions(ctx).filter((t) => t.blockedBy.length).length || null,
    },
    { id: 'replication', title: 'integrations.mysql.tabs.replication', panels: replication },
    { id: 'tables', title: 'integrations.db.tabs.tables', panels: deep.tablesTab },
    { id: 'storage', title: 'integrations.mysql.tabs.storage', panels: storage },
    { id: 'alerts', title: 'integrations.db.tabs.alerts', panels: async () => [], view: 'alerts' },
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
    const qps = `rate(watchlog_mysql_questions_total{${s}}[5m])`;
    const [conns, max, q, reads, requests, spark] = await Promise.all([
      vm.query(scope, `sum by (service) (watchlog_mysql_threads_connected{${s}})`),
      vm.query(scope, `max by (service) (watchlog_mysql_setting{${s}, name="max_connections"})`),
      vm.query(scope, `sum by (service) (${qps})`),
      vm.query(scope, `sum by (service) (rate(watchlog_mysql_buffer_pool_reads_total{${s}}[15m]))`),
      vm.query(
        scope,
        `sum by (service) (rate(watchlog_mysql_buffer_pool_read_requests_total{${s}}[15m]))`,
      ),
      vm.queryRange(scope, `sum by (service) (${qps})`, end - SPARK_RANGE, end, 300),
    ]);
    const at = (rows: typeof conns, id: string) =>
      rows.find((r) => r.labels.service === id)?.points[0]?.[1] ?? null;
    const out = new Map<string, RowMetrics>();
    for (const id of ids) {
      const c = at(conns, id);
      const m = at(max, id);
      const rd = at(reads, id) ?? 0;
      const rq = at(requests, id) ?? 0;
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
          { id: 'qps', labelKey: `${P}.qps`, value: at(q, id), unit: 'per_second' },
          {
            id: 'buffer',
            labelKey: `${P}.bufferPoolHit`,
            value: rq > 0 ? Math.max(0, 1 - rd / rq) : null,
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
