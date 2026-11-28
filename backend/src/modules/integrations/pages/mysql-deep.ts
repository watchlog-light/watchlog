// SPDX-License-Identifier: AGPL-3.0-only
// The MySQL and MariaDB page's 1.2 parts (ADR-245), after the notes' design/applications/
// AppMysql: the Overview (finding, query flow, six tiles, two charts, health checks,
// connections by client, the queries that cost the most, the process), Waits, a statement's
// and a table's page, Tables, and the deeper panels of Connections, Locks, InnoDB and
// Replication. One instant per page (aligned).
import { escapeLabelValue } from '../../query/catalog.js';
import { aligned } from './rabbitmq-tabs.js';
import {
  clientOf,
  clientsByWaits,
  clientsOfStatement,
  dominantWait,
  missingIndex,
  MY,
  ownersOf,
  periodOf,
  resourcePanels,
  scopedAlerts,
  sentBy,
  slowerSince,
  statementFacts,
  statementRows,
  statementsByWaits,
  statementStats,
  tablesIn,
  transactionsOf,
  treePanel,
  treeSessions,
  waitsChart,
  waitsOver,
  WAITS,
} from './db-deep.js';
import { ago, bytes, type Owner } from './owners.js';
import { instant, one, pointsOf, range, valueOf } from './query.js';
import type { ChecksPanel, FlowPanel, Link, PageContext, Panel, Severity, Text } from './types.js';

const E = MY;
const P = 'integrations.db.panels';
const RATE = '2m';

export const duration = (s: number) =>
  s >= 3600
    ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
    : s >= 90
      ? `${Math.round(s / 60)} min`
      : `${Math.round(s)} s`;

export const tableLink = (db: string, table: string): Link => ({
  kind: 'table',
  id: `${db}/${table}`,
  name: `${db}.${table}`,
});

/** Rows read by full scans per table over 6 h (performance_schema, every 10 min). */
async function fullScans(ctx: PageContext): Promise<Map<string, number>> {
  const r = await instant(
    ctx,
    `sum by (table) (increase(watchlog_mysql_table_full_scan_rows_total{${one(ctx.row.id)}}[6h]))`,
  );
  return new Map(r.map((x) => [(x.labels.table ?? '').toLowerCase(), x.points[0]?.[1] ?? 0]));
}

interface ClientRow {
  addr: string;
  user: string;
  connections: number;
  sleeping?: number;
  idle_min?: number;
}
const clientsOf = (ctx: PageContext): ClientRow[] =>
  ((ctx.row.status_details as { extra?: { clients?: ClientRow[] } }).extra?.clients ?? []).map(
    (x) => ({
      ...x,
      connections: Number(x.connections ?? 0),
    }),
  );

/** Clients by name (a workload or container, else the address and user), summed. */
function clientTable(owners: Map<string, Owner>, rows: ClientRow[]) {
  const by = new Map<
    string,
    {
      name: string;
      link?: Link;
      n: number;
      sleeping: number;
      idleMin: number | null;
      local: boolean;
    }
  >();
  for (const x of rows) {
    const local = !x.addr || x.addr === 'localhost';
    const who = local ? { name: `${x.user}@localhost` } : clientOf(owners, x.addr, x.user);
    const cur = by.get(who.name) ?? { ...who, n: 0, sleeping: 0, idleMin: null, local };
    cur.n += x.connections;
    cur.sleeping += Number(x.sleeping ?? 0);
    if (Number(x.sleeping ?? 0) > 0)
      cur.idleMin =
        cur.idleMin === null
          ? Number(x.idle_min ?? 0)
          : Math.min(cur.idleMin, Number(x.idle_min ?? 0));
    by.set(who.name, cur);
  }
  return [...by.values()].sort((a, b) => b.n - a.n);
}

// ------------------------------------------------------------------------- Overview

export async function overview(
  input: PageContext,
  volume: { used: number; capacity: number; perDay: number | null } | null,
): Promise<Panel[]> {
  // The data volume's days left (as PostgreSQL's), said on the InnoDB column.
  const daysLeft =
    volume && volume.perDay && volume.perDay > 0
      ? Math.floor((volume.capacity - volume.used) / volume.perDay)
      : null;
  const ctx = aligned(input);
  const s = one(ctx.row.id);
  const [
    connected,
    running,
    maxConn,
    refused,
    refusedHour,
    qps,
    selects,
    slow,
    scans,
    longest,
    blocked,
    longestBlock,
    deadlocks,
    reads,
    requests,
    pageSize,
    pagesDirty,
    pagesTotal,
    redo,
    lag,
    stopped,
    perf,
    largest,
    connSeries,
    runSeries,
    maxSeries,
    cmdSeries,
    owners,
    stats,
    senders,
    full,
  ] = await Promise.all([
    instant(ctx, `sum(watchlog_mysql_threads_connected{${s}})`),
    instant(ctx, `sum(watchlog_mysql_threads_running{${s}})`),
    instant(ctx, `max(watchlog_mysql_setting{${s}, name="max_connections"})`),
    instant(ctx, `sum(watchlog_mysql_refused_connections_total{${s}})`),
    instant(ctx, `sum(increase(watchlog_mysql_refused_connections_total{${s}}[1h]))`),
    instant(ctx, `sum(rate(watchlog_mysql_questions_total{${s}}[${RATE}]))`),
    instant(ctx, `sum(rate(watchlog_mysql_commands_total{${s}, command="select"}[${RATE}]))`),
    instant(ctx, `sum(rate(watchlog_mysql_slow_queries_total{${s}}[${RATE}]))`),
    instant(ctx, `sum(rate(watchlog_mysql_select_scan_total{${s}}[${RATE}]))`),
    instant(ctx, `max(watchlog_mysql_longest_query_seconds{${s}})`),
    instant(ctx, `sum(watchlog_mysql_blocked_sessions{${s}})`),
    instant(ctx, `max(watchlog_mysql_longest_block_seconds{${s}})`),
    instant(ctx, `sum(increase(watchlog_mysql_deadlocks_total{${s}}[1h]))`),
    instant(ctx, `sum(rate(watchlog_mysql_buffer_pool_reads_total{${s}}[15m]))`),
    instant(ctx, `sum(rate(watchlog_mysql_buffer_pool_read_requests_total{${s}}[15m]))`),
    instant(ctx, `max(watchlog_mysql_setting{${s}, name="innodb_page_size"})`),
    instant(ctx, `sum(watchlog_mysql_buffer_pool_pages{${s}, state="dirty"})`),
    instant(ctx, `sum(watchlog_mysql_buffer_pool_pages{${s}, state="total"})`),
    instant(ctx, `sum(rate(watchlog_mysql_redo_written_bytes_total{${s}}[${RATE}]))`),
    instant(ctx, `max(watchlog_mysql_replica_lag_seconds{${s}})`),
    instant(ctx, `max(1 - watchlog_mysql_replica_running{${s}})`),
    instant(ctx, `max(watchlog_mysql_setting{${s}, name="performance_schema"})`),
    instant(ctx, `topk(1, max by (db, table) (watchlog_mysql_table_size_bytes_estimate{${s}}))`),
    range(ctx, `sum(watchlog_mysql_threads_connected{${s}})`),
    range(ctx, `sum(watchlog_mysql_threads_running{${s}})`),
    range(ctx, `max(watchlog_mysql_setting{${s}, name="max_connections"})`),
    range(
      ctx,
      `sum by (command) (rate(watchlog_mysql_commands_total{${s}, command=~"select|insert|update"}[${RATE}]))`,
    ),
    ownersOf(ctx),
    statementStats(ctx, E),
    sentBy(ctx, E),
    fullScans(ctx),
  ]);
  const c = valueOf(connected);
  const m = valueOf(maxConn);
  const pct = c !== null && m ? c / m : null;
  const q = valueOf(qps) ?? 0;
  const rd = valueOf(reads) ?? 0;
  const rq = valueOf(requests) ?? 0;
  const hit = rq > 0 ? 1 - rd / rq : null;
  const nBlocked = valueOf(blocked) ?? 0;
  const longBlock = valueOf(longestBlock) ?? 0;
  const lagS = valueOf(lag);
  const ref = valueOf(refused) ?? 0;
  const clients = clientTable(owners, clientsOf(ctx));
  const sleepingAll = clients.reduce((a, b) => a + b.sleeping, 0);
  const facts = statementFacts(ctx, E);
  const leak = clients.find((x) => x.n >= 20 && x.sleeping === x.n && (x.idleMin ?? 0) >= 300);
  const large = largest[0];
  const flow: FlowPanel = {
    id: 'flow',
    title: `${P}.flow.title`,
    kind: 'flow',
    span: 2,
    state: c === null ? 'empty' : 'ok',
    note: { key: `${P}.flow.noteMysql` },
    columns: [
      {
        id: 'clients',
        title: { key: `${P}.flow.clients`, values: { n: clients.length } },
        value: c,
        unit: 'count',
        valueKey: `${P}.flow.connections`,
        ...(pct !== null && pct > 0.9 ? { severity: 'critical' as Severity } : {}),
        rows: clients.slice(0, 3).map((x) => ({
          name: x.name,
          value: x.n,
          unit: 'count' as const,
          ...(x.link ? { link: x.link } : {}),
          ...(x === leak
            ? {
                text: { key: `${P}.flow.sleeping`, values: { n: x.n } },
                severity: 'critical' as Severity,
              }
            : {}),
        })),
        nextText: m ? { key: `${P}.flow.ofMax`, values: { n: c ?? 0, max: m } } : undefined,
      },
      {
        id: 'threads',
        title: { key: `${P}.flow.threads` },
        value: valueOf(running),
        unit: 'count',
        valueKey: `${P}.flow.running`,
        ...(nBlocked > 0 ? { severity: 'critical' as Severity } : {}),
        rows: [
          {
            name: '',
            nameKey: `${P}.flow.sleepingThreads`,
            value: sleepingAll,
            unit: 'count' as const,
          },
          {
            name: '',
            nameKey: `${P}.flow.waitingLock`,
            value: nBlocked,
            unit: 'count' as const,
            ...(nBlocked > 0 ? { severity: 'critical' as Severity } : {}),
          },
          {
            name: '',
            nameKey: `${P}.flow.longest`,
            value: valueOf(longest),
            unit: 'seconds' as const,
            ...((valueOf(longest) ?? 0) > 300 ? { severity: 'critical' as Severity } : {}),
          },
        ],
        next: q,
      },
      {
        id: 'statements',
        title: { key: `${P}.flow.statements` },
        value: q,
        unit: 'per_second',
        valueKey: `${P}.flow.qPerSecond`,
        rows: [
          {
            name: '',
            nameKey: `${P}.flow.selects`,
            value: q > 0 ? (valueOf(selects) ?? 0) / q : null,
            unit: 'ratio' as const,
          },
          {
            name: '',
            nameKey: `${P}.flow.slowQueries`,
            value: valueOf(slow) ?? 0,
            unit: 'per_second' as const,
          },
          {
            name: '',
            nameKey: `${P}.flow.fullScans`,
            value: q > 0 ? (valueOf(scans) ?? 0) / q : null,
            unit: 'ratio' as const,
          },
        ],
        nextText: {
          key: `${P}.flow.readPerSecond`,
          values: { size: bytes(rd * (valueOf(pageSize) ?? 16384)) },
        },
      },
      {
        id: 'innodb',
        title: { key: `${P}.flow.innodb` },
        value: hit,
        unit: 'ratio',
        valueKey: `${P}.flow.bufferPoolHit`,
        rows: [
          {
            name: '',
            nameKey: `${P}.flow.dirtyPages`,
            value:
              (valueOf(pagesTotal) ?? 0) > 0
                ? (valueOf(pagesDirty) ?? 0) / valueOf(pagesTotal)!
                : null,
            unit: 'ratio' as const,
          },
          {
            name: '',
            nameKey: `${P}.flow.redoWritten`,
            value: valueOf(redo),
            unit: 'bytes_per_second' as const,
          },
          ...(daysLeft !== null
            ? [
                {
                  name: '',
                  nameKey: `${P}.flow.fullIn`,
                  value: null,
                  unit: 'count' as const,
                  text: { key: `${P}.flow.days`, values: { n: daysLeft } },
                  ...(daysLeft < 14 ? { severity: 'warning' as Severity } : {}),
                },
              ]
            : []),
          ...(large
            ? [
                {
                  name: '',
                  nameKey: `${P}.flow.largestTable`,
                  value: null,
                  unit: 'bytes' as const,
                  text: {
                    key: `${P}.flow.tableSize`,
                    values: {
                      table: large.labels.table ?? '',
                      size: bytes(large.points[0]?.[1] ?? 0),
                    },
                  },
                  link: tableLink(large.labels.db ?? '', large.labels.table ?? ''),
                },
              ]
            : []),
        ],
      },
    ],
  };
  const replicaRunning = lagS !== null || (valueOf(stopped) ?? 0) > 0;
  const checks: ChecksPanel = {
    id: 'checks',
    title: `${P}.checks.title`,
    kind: 'checks',
    span: 1,
    layout: 'side',
    state: c === null ? 'empty' : 'ok',
    items: [
      {
        id: 'connections',
        labelKey: `${P}.checks.connections`,
        state: pct !== null && pct > 0.8 ? (pct > 0.95 ? 'fail' : 'warn') : 'pass',
        value: {
          key: `${P}.checks.pct`,
          values: { pct: pct === null ? null : Math.round(pct * 100) },
        },
      },
      {
        id: 'refused',
        labelKey: `${P}.checks.refused`,
        state: (valueOf(refusedHour) ?? 0) > 0 ? 'fail' : 'pass',
        value: { key: `${P}.checks.count`, values: { n: Math.round(valueOf(refusedHour) ?? 0) } },
      },
      {
        id: 'long_query',
        labelKey: `${P}.checks.longQuery`,
        state: (valueOf(longest) ?? 0) > 300 ? 'fail' : 'pass',
        value: { key: `${P}.checks.longestIs`, values: { d: duration(valueOf(longest) ?? 0) } },
      },
      {
        id: 'lock_waits',
        labelKey: `${P}.checks.lockWaits`,
        state: longBlock > 60 ? 'fail' : nBlocked > 0 ? 'warn' : 'pass',
        value: { key: `${P}.checks.sessions`, values: { n: nBlocked } },
        link: { kind: 'tab', tab: 'locks', name: 'locks' },
      },
      {
        id: 'deadlocks',
        labelKey: `${P}.checks.deadlocks`,
        state: (valueOf(deadlocks) ?? 0) > 0 ? 'warn' : 'pass',
        value: { key: `${P}.checks.count`, values: { n: Math.round(valueOf(deadlocks) ?? 0) } },
      },
      {
        id: 'replication',
        labelKey: `${P}.checks.replication`,
        state: (valueOf(stopped) ?? 0) > 0 ? 'fail' : lagS !== null && lagS > 30 ? 'warn' : 'pass',
        value: replicaRunning
          ? { key: `${P}.checks.lag`, values: { lag: duration(lagS ?? 0) } }
          : { key: `${P}.checks.notReplica` },
      },
      {
        id: 'buffer',
        labelKey: `${P}.checks.bufferPool`,
        state: hit !== null && rd > 10 && hit < 0.99 ? 'warn' : 'pass',
        value: {
          key: `${P}.checks.pct`,
          values: { pct: hit === null ? null : Math.round(hit * 1000) / 10 },
        },
      },
      {
        id: 'perf',
        labelKey: `${P}.checks.perfSchema`,
        state: valueOf(perf) === 1 ? 'pass' : 'warn',
        value: { key: valueOf(perf) === 1 ? `${P}.checks.yes` : `${P}.checks.no` },
      },
    ],
  };
  const costly = [...stats.values()].sort((a, b) => (b.share ?? 0) - (a.share ?? 0)).slice(0, 5);
  return [
    flow,
    {
      id: 'summary',
      title: `${P}.tiles.title`,
      kind: 'stat',
      span: 2,
      state: c === null ? 'empty' : 'ok',
      tiles: [
        {
          id: 'connections',
          labelKey: `${P}.tiles.connections`,
          value: pct,
          unit: 'ratio',
          sub: m ? { key: `${P}.tiles.ofMax`, values: { n: c ?? 0, max: m } } : undefined,
          ...(pct !== null && pct > 0.9
            ? { severity: 'critical' as Severity }
            : pct !== null && pct > 0.8
              ? { severity: 'warning' as Severity }
              : {}),
        },
        {
          id: 'queries',
          labelKey: `${P}.tiles.queries`,
          value: q,
          unit: 'per_second',
          sub: { key: `${P}.tiles.aSecond` },
        },
        {
          id: 'slow',
          labelKey: `${P}.tiles.slow`,
          value: valueOf(slow) ?? 0,
          unit: 'per_second',
          sub: { key: `${P}.tiles.slowerThanLongQuery` },
        },
        {
          id: 'buffer',
          labelKey: `${P}.tiles.bufferPool`,
          value: hit,
          unit: 'ratio',
          sub: { key: `${P}.tiles.healthyAbove`, values: { pct: 99 } },
          ...(hit !== null && rd > 10 && hit < 0.99 ? { severity: 'warning' as Severity } : {}),
        },
        {
          id: 'lag',
          labelKey: `${P}.tiles.lag`,
          value: lagS,
          unit: 'seconds',
          sub: replicaRunning
            ? {
                key:
                  (valueOf(stopped) ?? 0) > 0
                    ? `${P}.tiles.replicaStopped`
                    : `${P}.tiles.replicaRunning`,
              }
            : { key: `${P}.tiles.notReplica` },
          ...((valueOf(stopped) ?? 0) > 0
            ? { severity: 'critical' as Severity }
            : lagS !== null && lagS > 30
              ? { severity: 'warning' as Severity }
              : {}),
        },
        {
          id: 'refused',
          labelKey: `${P}.tiles.refused`,
          value: ref,
          unit: 'count',
          sub: { key: `${P}.tiles.sinceStart` },
          ...((valueOf(refusedHour) ?? 0) > 0 ? { severity: 'critical' as Severity } : {}),
        },
      ],
    },
    {
      id: 'connections',
      title: `${P}.charts.connections`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: connSeries.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.connected`, points: pointsOf(connSeries[0]) },
        { nameKey: `${P}.series.running`, points: pointsOf(runSeries[0]) },
        ...(maxSeries[0]
          ? [
              {
                nameKey: `${P}.series.maxConnections`,
                points: pointsOf(maxSeries[0]),
                dashed: true,
              },
            ]
          : []),
      ],
    },
    {
      id: 'statements-by-type',
      title: `${P}.charts.byType`,
      kind: 'stack',
      span: 1,
      unit: 'per_second',
      state: cmdSeries.length ? 'ok' : 'empty',
      series: ['select', 'insert', 'update'].map((k) => ({
        nameKey: `${P}.series.${k}`,
        points: pointsOf(cmdSeries.find((x) => x.labels.command === k)),
      })),
    },
    checks,
    {
      id: 'clients',
      title: `${P}.clients.title`,
      kind: 'table',
      span: 1,
      layout: 'main',
      state: clients.length ? 'ok' : 'empty',
      columns: [
        `${P}.cols.client`,
        `${P}.cols.connections`,
        `${P}.cols.running`,
        `${P}.cols.sleeping`,
        `${P}.cols.noStatementFor`,
      ],
      rows: clients.slice(0, 8).map((x) => ({
        cells: [
          x.name,
          x.n,
          x.n - x.sleeping,
          x.sleeping,
          x.sleeping && x.idleMin !== null ? duration(x.idleMin) : '–',
        ],
        ...(x === leak ? { severity: 'critical' as Severity } : {}),
        ...(x.link ? { link: x.link } : {}),
      })),
    },
    {
      id: 'slowest',
      title: `${P}.costly.title`,
      kind: 'statements',
      span: 2,
      state: stats.size ? 'ok' : 'empty',
      shareOf: 'time',
      full: false,
      total: stats.size,
      rows: statementRows(
        E,
        costly.map((x) => x.id),
        stats,
        facts,
        senders,
        owners,
        full,
      ),
    },
    ...(await resourcePanels(ctx, E)),
  ];
}

// ------------------------------------------------------------------------- Queries, Waits

export async function statementsPanel(ctx: PageContext): Promise<Panel> {
  const [owners, stats, senders, scans] = await Promise.all([
    ownersOf(ctx),
    statementStats(ctx, E),
    sentBy(ctx, E),
    fullScans(ctx),
  ]);
  const facts = statementFacts(ctx, E);
  const ids = [...new Set([...stats.keys(), ...facts.keys()])].sort(
    (a, b) => (stats.get(b)?.share ?? 0) - (stats.get(a)?.share ?? 0),
  );
  return {
    // The id the permission note names (queries/top): without the source it says what to do.
    id: 'top',
    title: `${P}.statements.title`,
    kind: 'statements',
    span: 2,
    state: ids.length ? 'ok' : 'empty',
    note: { key: `${P}.statements.noteMysql` },
    shareOf: 'time',
    full: true,
    total: ids.length,
    rows: statementRows(E, ids, stats, facts, senders, owners, scans),
  };
}

export async function waitsTab(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const { end, dur } = periodOf(ctx);
  const [chart, over, stmts, clients, owners, stats, senders, scans] = await Promise.all([
    waitsChart(ctx, E),
    waitsOver(ctx, E, end, dur),
    statementsByWaits(ctx, E, end, dur),
    clientsByWaits(ctx, E, end, dur),
    ownersOf(ctx),
    statementStats(ctx, E),
    sentBy(ctx, E),
    fullScans(ctx),
  ]);
  const facts = statementFacts(ctx, E);
  const totalStmt = stmts.reduce((a, b) => a + b.sessions, 0);
  const share = new Map(stmts.map((x) => [x.id, totalStmt > 0 ? x.sessions / totalStmt : 0]));
  const top = dominantWait(over);
  return [
    chart,
    {
      id: 'summary',
      title: `${P}.waitsSummary.title`,
      kind: 'facts',
      span: 2,
      state: over.total > 0 ? 'ok' : 'empty',
      note: { key: `${P}.waitsSummary.periodMysql`, values: { from: end - dur, to: end } },
      rows: [
        {
          labelKey: `${P}.waitsSummary.average`,
          value: Math.round(over.total * 100) / 100,
          unit: 'count',
        },
        ...WAITS.map((w) => ({
          labelKey: `${P}.wait.${w}`,
          value: over.total > 0 ? over.by[w] / over.total : 0,
          unit: 'ratio' as const,
        })),
        ...(top && top.wait !== 'cpu' && top.share >= 0.5
          ? [
              {
                labelKey: `${P}.waitsSummary.mostly`,
                value: null,
                text: {
                  key: `${P}.waitsSummary.mostlyText`,
                  values: { pct: Math.round(top.share * 100), wait: top.wait },
                },
              },
            ]
          : []),
      ],
    },
    {
      id: 'by-statement',
      title: `${P}.waitsStatements.title`,
      kind: 'statements',
      span: 2,
      state: stmts.length ? 'ok' : 'empty',
      shareOf: 'waits',
      full: false,
      total: stmts.length,
      rows: statementRows(
        E,
        stmts
          .filter((x) => x.id !== 'other')
          .slice(0, 10)
          .map((x) => x.id),
        stats,
        facts,
        senders,
        owners,
        scans,
        share,
      ),
    },
    {
      id: 'by-client',
      title: `${P}.waitsClients.title`,
      kind: 'bars',
      span: 2,
      unit: 'count',
      state: clients.length ? 'ok' : 'empty',
      note: { key: `${P}.waitsClients.note` },
      items: clients.slice(0, 15).map((x) => ({
        label: `${clientOf(owners, x.addr).name}${x.wait && x.wait !== 'cpu' ? ` · ${x.wait}` : ''}`,
        value: Math.round(x.sessions * 100) / 100,
        ...(x.wait === 'lock' ? { severity: 'critical' as Severity } : {}),
      })),
    },
  ];
}

// ------------------------------------------------------------------------- one statement

export async function statementPage(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const id = ctx.params?.statement ?? '';
  const sel = `${one(ctx.row.id)}, digest="${escapeLabelValue(id)}"`;
  const w = RATE;
  const [
    stats,
    owners,
    clients,
    mean,
    calls,
    sent,
    examined,
    noIndex,
    tmpDisk,
    errors,
    waits,
    scans,
  ] = await Promise.all([
    statementStats(ctx, E),
    ownersOf(ctx),
    clientsOfStatement(ctx, E, id),
    range(
      ctx,
      `sum(rate(watchlog_mysql_statement_seconds_total{${sel}}[${w}])) / sum(rate(watchlog_mysql_statement_calls_total{${sel}}[${w}]))`,
    ),
    range(ctx, `sum(rate(watchlog_mysql_statement_calls_total{${sel}}[${w}]))`),
    range(ctx, `sum(rate(watchlog_mysql_statement_rows_sent_total{${sel}}[${w}]))`),
    range(ctx, `sum(rate(watchlog_mysql_statement_rows_examined_total{${sel}}[${w}]))`),
    range(ctx, `sum(rate(watchlog_mysql_statement_no_index_total{${sel}}[${w}]))`),
    range(ctx, `sum(rate(watchlog_mysql_statement_tmp_disk_total{${sel}}[${w}]))`),
    range(ctx, `sum(rate(watchlog_mysql_statement_errors_total{${sel}}[${w}]))`),
    range(
      ctx,
      `sum by (wait) (avg_over_time(watchlog_mysql_statement_active_sessions{${sel}}[${w}]))`,
    ),
    fullScans(ctx),
  ]);
  const st = stats.get(id);
  const f = statementFacts(ctx, E).get(id);
  const since = st?.slower && st.usual ? await slowerSince(ctx, E, id, st.usual) : null;
  const idx = missingIndex(E, f, scans);
  const tables = f ? tablesIn(f.text) : [];
  const byWait = new Map(waits.map((x) => [x.labels.wait ?? '', x]));
  return [
    {
      id: 'facts',
      title: `${P}.statement.facts`,
      kind: 'facts',
      span: 2,
      state: st || f ? 'ok' : 'empty',
      rows: [
        { labelKey: `${P}.statement.text`, value: f?.text ?? `digest ${id}` },
        { labelKey: `${P}.statement.calls`, value: st?.calls ?? null, unit: 'per_second' },
        { labelKey: `${P}.statement.mean`, value: st?.mean ?? null, unit: 'seconds' },
        { labelKey: `${P}.statement.usual`, value: st?.usual ?? null, unit: 'seconds' },
        { labelKey: `${P}.statement.share`, value: st?.share ?? null, unit: 'ratio' },
        {
          labelKey: `${P}.statement.examinedPerRow`,
          value: f && f.sent ? Math.round((f.examined ?? 0) / Math.max(f.sent, 1)) : null,
          unit: 'count',
        },
        ...(st?.slower
          ? [
              {
                labelKey: `${P}.statement.changed`,
                value: null,
                text: {
                  key: since ? `${P}.statement.slowerSince` : `${P}.statement.slower`,
                  values: { x: Math.round(st.slower), at: since },
                },
              },
            ]
          : []),
        ...(idx
          ? [
              {
                labelKey: `${P}.statement.hint`,
                value: null,
                text: { key: `${P}.hint.index`, values: { table: idx.table } },
              },
            ]
          : []),
      ],
    },
    {
      id: 'mean',
      title: `${P}.statement.meanOverTime`,
      kind: 'line',
      span: 1,
      unit: 'seconds',
      state: mean.length ? 'ok' : 'empty',
      ...(since
        ? {
            markers: [
              {
                at: since,
                text: { key: `${P}.marker.slower`, values: { x: Math.round(st!.slower!) } },
                severity: 'warning' as Severity,
              },
            ],
          }
        : {}),
      series: [
        { nameKey: `${P}.series.mean`, points: pointsOf(mean[0]) },
        ...(st?.usual
          ? [
              {
                nameKey: `${P}.series.usual`,
                points: pointsOf(mean[0]).map(([t]) => [t, st.usual] as [number, number]),
                dashed: true,
              },
            ]
          : []),
      ],
    },
    {
      id: 'calls',
      title: `${P}.statement.callsOverTime`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: calls.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.calls`, points: pointsOf(calls[0]) },
        { nameKey: `${P}.series.rowsSent`, points: pointsOf(sent[0]) },
      ],
    },
    {
      id: 'reads',
      title: `${P}.statement.examined`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: examined.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.rowsExamined`, points: pointsOf(examined[0]) },
        { nameKey: `${P}.series.rowsSent`, points: pointsOf(sent[0]) },
      ],
    },
    {
      id: 'problems',
      title: `${P}.statement.problems`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: noIndex.length || tmpDisk.length || errors.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.noIndex`, points: pointsOf(noIndex[0]), severity: 'warning' },
        { nameKey: `${P}.series.tmpDisk`, points: pointsOf(tmpDisk[0]) },
        { nameKey: `${P}.series.errors`, points: pointsOf(errors[0]), severity: 'critical' },
      ],
    },
    {
      id: 'waits',
      title: `${P}.statement.waits`,
      kind: 'stack',
      span: 1,
      unit: 'count',
      state: waits.length ? 'ok' : 'empty',
      series: WAITS.map((wc) => ({ nameKey: `${P}.wait.${wc}`, points: pointsOf(byWait.get(wc)) })),
    },
    {
      id: 'senders',
      title: `${P}.statement.senders`,
      kind: 'bars',
      span: 1,
      unit: 'ratio',
      state: clients.length ? 'ok' : 'empty',
      note: { key: `${P}.statement.sendersNoteMysql` },
      items: clients
        .slice(0, 10)
        .map((x) => ({ label: clientOf(owners, x.addr).name, value: x.share })),
    },
    {
      id: 'tables',
      title: `${P}.statement.tables`,
      kind: 'facts',
      span: 2,
      state: tables.length ? 'ok' : 'empty',
      rows: tables.map((t) => ({
        labelKey: `${P}.statement.table`,
        value: t,
        text: {
          key: `${P}.statement.fullScanRows`,
          values: { n: Math.round(scans.get(t.toLowerCase().split('.').pop()!) ?? 0) },
        },
      })),
    },
    await scopedAlerts(ctx, E, { statement: id }, [
      {
        key: 'slower',
        nameKey: `${P}.presets.slower`,
        metric: 'mysql.statement.slower',
        op: '>',
        value: 3,
        forSeconds: 600,
        severity: 'warning',
      },
      {
        key: 'mean',
        nameKey: `${P}.presets.mean`,
        metric: 'mysql.statement.mean',
        op: '>',
        value: 1,
        forSeconds: 300,
        severity: 'warning',
      },
    ]),
  ];
}

// ------------------------------------------------------------------------- one table, Tables

export async function tablePage(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const [db, table] = (ctx.params?.table ?? '').split('/', 2) as [string, string | undefined];
  const sel = `${one(ctx.row.id)}, db="${escapeLabelValue(db)}", table="${escapeLabelValue(table ?? '')}"`;
  const [size, rows, growth, scans] = await Promise.all([
    range(ctx, `max(watchlog_mysql_table_size_bytes_estimate{${sel}})`),
    instant(ctx, `max(watchlog_mysql_table_rows_estimate{${sel}})`),
    instant(ctx, `max(deriv(watchlog_mysql_table_size_bytes_estimate{${sel}}[24h])) * 86400`),
    range(ctx, `sum(rate(watchlog_mysql_table_full_scan_rows_total{${sel}}[1h]))`),
  ]);
  const extra =
    (ctx.row.status_details as { extra?: Record<string, Record<string, unknown>[]> }).extra ?? {};
  const unused = (extra.unused_indexes ?? []).filter((x) => x.db === db && x.table === table);
  const noPK = (extra.no_primary_key ?? []).some((x) => x.db === db && x.table === table);
  return [
    {
      id: 'facts',
      title: `${P}.table.facts`,
      kind: 'facts',
      span: 2,
      state: size.length || unused.length || noPK ? 'ok' : 'empty',
      note: { key: `${P}.table.estimate` },
      rows: [
        { labelKey: `${P}.table.name`, value: `${db}.${table ?? ''}` },
        { labelKey: `${P}.table.size`, value: size[0]?.points.at(-1)?.[1] ?? null, unit: 'bytes' },
        {
          labelKey: `${P}.table.growth`,
          value: valueOf(growth),
          unit: 'bytes',
          text:
            valueOf(growth) !== null
              ? { key: `${P}.flow.perDay`, values: { size: bytes(Math.abs(valueOf(growth)!)) } }
              : undefined,
        },
        { labelKey: `${P}.table.rows`, value: valueOf(rows), unit: 'count' },
        ...(noPK
          ? [
              {
                labelKey: `${P}.table.primaryKey`,
                value: null,
                text: { key: `${P}.table.noPrimaryKey` },
              },
            ]
          : []),
      ],
    },
    {
      id: 'size',
      title: `${P}.table.sizeOverTime`,
      kind: 'line',
      span: 1,
      unit: 'bytes',
      state: size.length ? 'ok' : 'empty',
      series: [{ nameKey: `${P}.series.size`, points: pointsOf(size[0]) }],
    },
    {
      id: 'scans',
      title: `${P}.table.fullScans`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: scans.length ? 'ok' : 'empty',
      note: { key: `${P}.table.fullScansNote` },
      series: [
        { nameKey: `${P}.series.fullScanRows`, points: pointsOf(scans[0]), severity: 'warning' },
      ],
    },
    {
      id: 'indexes',
      title: `${P}.table.indexes`,
      kind: 'table',
      span: 2,
      state: unused.length ? 'ok' : 'empty',
      note: { key: `${P}.table.indexesNoteMysql` },
      columns: [`${P}.cols.index`, `${P}.cols.finding`],
      rows: unused.map((x) => ({ cells: [String(x.index), 'unused'] })),
    },
    await scopedAlerts(ctx, E, { table: `${db}/${table ?? ''}` }, [
      {
        key: 'size',
        nameKey: `${P}.presets.tableSize`,
        metric: 'mysql.table.size',
        op: '>',
        value: 100 * 2 ** 30,
        forSeconds: 0,
        severity: 'warning',
      },
    ]),
  ];
}

export async function tablesTab(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [largest, growing, scans] = await Promise.all([
    instant(ctx, `topk(15, max by (db, table) (watchlog_mysql_table_size_bytes_estimate{${s}}))`),
    instant(
      ctx,
      `topk(10, max by (db, table) (deriv(watchlog_mysql_table_size_bytes_estimate{${s}}[24h])) * 86400 > 0)`,
    ),
    instant(
      ctx,
      `topk(10, sum by (db, table) (increase(watchlog_mysql_table_full_scan_rows_total{${s}}[6h])) > 0)`,
    ),
  ]);
  const extra =
    (ctx.row.status_details as { extra?: Record<string, Record<string, unknown>[]> }).extra ?? {};
  const unused = extra.unused_indexes ?? [];
  const noPK = extra.no_primary_key ?? [];
  const row = (x: (typeof largest)[number], v: string) => ({
    cells: [`${x.labels.db}.${x.labels.table}`, v],
    link: tableLink(x.labels.db ?? '', x.labels.table ?? ''),
  });
  return [
    {
      id: 'largest',
      title: `${P}.tables.largest`,
      kind: 'table',
      span: 1,
      state: largest.length ? 'ok' : 'empty',
      note: { key: `${P}.table.estimate` },
      columns: [`${P}.cols.table`, `${P}.cols.size`],
      rows: largest
        .sort((a, b) => (b.points[0]?.[1] ?? 0) - (a.points[0]?.[1] ?? 0))
        .map((x) => row(x, bytes(x.points[0]?.[1] ?? 0))),
    },
    {
      id: 'growing',
      title: `${P}.tables.growing`,
      kind: 'table',
      span: 1,
      state: growing.length ? 'ok' : 'empty',
      columns: [`${P}.cols.table`, `${P}.cols.perDay`],
      rows: growing
        .sort((a, b) => (b.points[0]?.[1] ?? 0) - (a.points[0]?.[1] ?? 0))
        .map((x) => row(x, bytes(x.points[0]?.[1] ?? 0))),
    },
    {
      id: 'full-scans',
      title: `${P}.tables.fullScans`,
      kind: 'table',
      span: 1,
      state: scans.length ? 'ok' : 'empty',
      note: { key: `${P}.tables.fullScansNote` },
      columns: [`${P}.cols.table`, `${P}.cols.rows6h`],
      rows: scans
        .sort((a, b) => (b.points[0]?.[1] ?? 0) - (a.points[0]?.[1] ?? 0))
        .map((x) => row(x, `${Math.round(x.points[0]?.[1] ?? 0).toLocaleString('en')}`)),
    },
    {
      id: 'unused',
      title: `${P}.tables.unused`,
      kind: 'table',
      span: 1,
      state: unused.length ? 'ok' : 'empty',
      note: { key: `${P}.tables.unusedNoteMysql` },
      columns: [`${P}.cols.index`, `${P}.cols.table`],
      rows: unused.map((x) => ({
        cells: [String(x.index), `${x.db}.${x.table}`],
        link: tableLink(String(x.db), String(x.table)),
      })),
    },
    {
      id: 'no-pk',
      title: `${P}.tables.noPrimaryKey`,
      kind: 'table',
      span: 2,
      state: noPK.length ? 'ok' : 'empty',
      note: { key: `${P}.tables.noPrimaryKeyNote` },
      columns: [`${P}.cols.table`],
      rows: noPK.map((x) => ({
        cells: [`${x.db}.${x.table}`],
        link: tableLink(String(x.db), String(x.table)),
      })),
    },
  ];
}

// ------------------------------------------------------------------------- Locks, Connections

interface DeadlockTxn {
  at: number;
  n: number;
  host: string;
  user: string;
  query: string;
  victim: boolean;
}

export async function locksDeep(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [owners, history] = await Promise.all([
    ownersOf(ctx),
    range(ctx, `max(watchlog_mysql_history_list_length{${s}})`),
  ]);
  const extra = (ctx.row.status_details as { extra?: { deadlock?: DeadlockTxn[] } }).extra ?? {};
  const dl = extra.deadlock ?? [];
  return [
    treePanel(E, treeSessions(ctx), owners),
    transactionsTable(ctx, owners),
    {
      id: 'history',
      title: `${P}.history.title`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: history.length ? 'ok' : 'empty',
      note: { key: `${P}.history.note` },
      series: [{ nameKey: `${P}.series.historyList`, points: pointsOf(history[0]) }],
    },
    {
      id: 'deadlock',
      title: `${P}.deadlock.title`,
      kind: 'table',
      span: 1,
      state: dl.length ? 'ok' : 'empty',
      note: dl.length
        ? { key: `${P}.deadlock.at`, values: { at: dl[0]!.at } }
        : { key: `${P}.deadlock.none` },
      columns: [`${P}.cols.client`, `${P}.cols.query`, `${P}.cols.outcome`],
      rows: dl.map((t) => ({
        cells: [
          t.host && t.host !== 'localhost'
            ? clientOf(owners, t.host, t.user).name
            : `${t.user}@${t.host || 'localhost'}`,
          t.query || '–',
          t.victim ? 'rolled back' : 'went on',
        ],
        ...(t.victim ? { severity: 'warning' as Severity } : {}),
      })),
    },
  ];
}

function transactionsTable(ctx: PageContext, owners: Map<string, Owner>): Panel {
  const txns = transactionsOf(ctx);
  return {
    id: 'transactions',
    title: `${P}.transactions.title`,
    kind: 'table',
    span: 2,
    state: txns.length ? 'ok' : 'empty',
    note: { key: `${P}.transactions.noteMysql` },
    columns: [`${P}.cols.client`, `${P}.cols.open`, `${P}.cols.state`, `${P}.cols.blocks`],
    rows: txns.map((t) => ({
      cells: [
        clientOf(owners, t.addr, t.app).name,
        duration(t.age),
        t.idle ? `sleeping for ${duration(t.idleFor)}` : 'running',
        t.blocks,
      ],
      severity: t.age > 1800 || (t.idle && t.blocks > 0) ? ('warning' as Severity) : undefined,
    })),
  };
}

export async function connectionsDeep(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [users, maxUser, errors, owners] = await Promise.all([
    instant(ctx, `topk(15, max by (user) (watchlog_mysql_user_connections{${s}}))`),
    instant(ctx, `max(watchlog_mysql_setting{${s}, name="max_user_connections"})`),
    instant(ctx, `topk(10, max by (addr) (watchlog_mysql_host_connect_errors_total{${s}}))`),
    ownersOf(ctx),
  ]);
  const mu = valueOf(maxUser) ?? 0;
  return [
    {
      id: 'clients-table',
      title: `${P}.clients.title`,
      kind: 'table',
      span: 2,
      state: clientsOf(ctx).length ? 'ok' : 'empty',
      columns: [
        `${P}.cols.client`,
        `${P}.cols.connections`,
        `${P}.cols.running`,
        `${P}.cols.sleeping`,
        `${P}.cols.noStatementFor`,
      ],
      rows: clientTable(owners, clientsOf(ctx))
        .slice(0, 25)
        .map((x) => ({
          cells: [
            x.name,
            x.n,
            x.n - x.sleeping,
            x.sleeping,
            x.sleeping && x.idleMin !== null ? duration(x.idleMin) : '–',
          ],
          ...(x.n >= 20 && x.sleeping === x.n && (x.idleMin ?? 0) >= 300
            ? { severity: 'critical' as Severity }
            : {}),
          ...(x.link ? { link: x.link } : {}),
        })),
    },
    {
      id: 'users',
      title: `${P}.users.title`,
      kind: mu > 0 ? 'gauge' : 'bars',
      span: 1,
      state: users.length ? 'ok' : 'empty',
      note: mu > 0 ? { key: `${P}.users.limit`, values: { n: mu } } : { key: `${P}.users.noLimit` },
      ...(mu > 0
        ? {
            items: users.map((x) => ({
              label: x.labels.user ?? '',
              value: x.points[0]?.[1] ?? 0,
              max: mu,
              unit: 'count' as const,
              warnAt: 0.8,
            })),
          }
        : {
            unit: 'count' as const,
            items: users.map((x) => ({ label: x.labels.user ?? '', value: x.points[0]?.[1] ?? 0 })),
          }),
    } as Panel,
    {
      id: 'handshake-errors',
      title: `${P}.users.errors`,
      kind: 'bars',
      span: 1,
      unit: 'count',
      state: errors.length ? 'ok' : 'empty',
      note: { key: `${P}.users.errorsNote` },
      items: errors.map((x) => ({
        label: clientOf(owners, x.labels.addr ?? '').name,
        value: x.points[0]?.[1] ?? 0,
      })),
    },
  ];
}

// ------------------------------------------------------------------------- InnoDB, Replication

export async function innodbDeep(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [inUse, capacity, history] = await Promise.all([
    instant(ctx, `max(watchlog_mysql_redo_in_use_bytes{${s}})`),
    instant(ctx, `max(watchlog_mysql_redo_capacity_bytes{${s}})`),
    instant(ctx, `max(watchlog_mysql_history_list_length{${s}})`),
  ]);
  const cap = valueOf(capacity);
  return [
    {
      id: 'redo-use',
      title: `${P}.redoUse.title`,
      kind: 'gauge',
      span: 1,
      state: cap ? 'ok' : 'empty',
      note: cap ? { key: `${P}.redoUse.note` } : { key: `${P}.redoUse.unavailable` },
      items: cap
        ? [
            {
              labelKey: `${P}.redoUse.label`,
              value: valueOf(inUse) ?? 0,
              max: cap,
              unit: 'bytes',
              warnAt: 0.75,
            },
          ]
        : [],
    },
    {
      id: 'history-now',
      title: `${P}.history.now`,
      kind: 'facts',
      span: 1,
      state: valueOf(history) !== null ? 'ok' : 'empty',
      rows: [{ labelKey: `${P}.history.length`, value: valueOf(history), unit: 'count' }],
    },
  ];
}

export async function replicationDeep(
  ctx: PageContext,
  volume: { used: number; capacity: number } | null,
): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [binlog, growth, expire, heartbeat] = await Promise.all([
    instant(ctx, `max(watchlog_mysql_binlog_bytes{${s}})`),
    instant(ctx, `max(deriv(watchlog_mysql_binlog_bytes{${s}}[1h]))`),
    instant(ctx, `max(watchlog_mysql_setting{${s}, name="binlog_expire_logs_seconds"})`),
    instant(ctx, `max by (channel) (watchlog_mysql_replica_heartbeat_age_seconds{${s}})`),
  ]);
  const channels =
    (ctx.row.status_details as { extra?: { channels?: Record<string, unknown>[] } }).extra
      ?.channels ?? [];
  const b = valueOf(binlog);
  const g = valueOf(growth) ?? 0;
  const free = volume ? volume.capacity - volume.used : null;
  const eta = free !== null && g > 0 ? free / g : null;
  const hb = new Map(heartbeat.map((x) => [x.labels.channel ?? '', x.points[0]?.[1] ?? null]));
  return [
    {
      id: 'channels',
      title: `${P}.channels.title`,
      kind: 'table',
      span: 2,
      state: channels.length ? 'ok' : 'empty',
      note: { key: `${P}.channels.note` },
      columns: [
        `${P}.cols.channel`,
        `${P}.cols.worker`,
        `${P}.cols.receiver`,
        `${P}.cols.applier`,
        `${P}.cols.heartbeat`,
        `${P}.cols.error`,
      ],
      rows: channels.map((x) => ({
        cells: [
          String(x.channel ?? ''),
          x.worker !== undefined ? String(x.worker) : '–',
          String(x.receiver ?? '–'),
          String(x.applier ?? '–'),
          hb.get(String(x.channel ?? '')) !== undefined && hb.get(String(x.channel ?? '')) !== null
            ? duration(hb.get(String(x.channel ?? ''))!)
            : '–',
          String(x.error || '–'),
        ],
        ...(x.error ? { severity: 'critical' as Severity } : {}),
      })),
    },
    {
      id: 'binlog',
      title: `${P}.binlog.title`,
      kind: 'facts',
      span: 1,
      state: b !== null ? 'ok' : 'empty',
      note: b === null ? { key: `${P}.binlog.off` } : undefined,
      rows: [
        { labelKey: `${P}.binlog.size`, value: b, unit: 'bytes' },
        {
          labelKey: `${P}.binlog.growth`,
          value: g > 0 ? g * 3600 : 0,
          unit: 'bytes',
          text: { key: `${P}.binlog.perHour`, values: { size: bytes(Math.max(g, 0) * 3600) } },
        },
        {
          labelKey: `${P}.binlog.expire`,
          value: valueOf(expire) ? duration(valueOf(expire)!) : '–',
        },
        { labelKey: `${P}.binlog.fillsIn`, value: eta !== null ? duration(eta) : '–' },
      ],
    },
  ];
}

export { dominantWait, waitsOver, ago, type Text };
