// SPDX-License-Identifier: AGPL-3.0-only
// The PostgreSQL page's 1.2 parts (ADR-245), after the notes' design/applications/AppPostgres:
// the Overview (finding, query flow, six tiles, two charts, health checks, the queries that
// cost the most, the process), the Waits tab, a statement's page and a table's page, and the
// deeper panels of Connections, Locks, Replication, Tables and Vacuum. One instant per page
// (aligned): a number shown twice is read once.
import { escapeLabelValue } from '../../query/catalog.js';
import { aligned } from './rabbitmq-tabs.js';
import {
  byLabel,
  clientOf,
  clientsByWaits,
  clientsOfStatement,
  dominantWait,
  missingIndex,
  ownersOf,
  periodOf,
  PG,
  resourcePanels,
  scopedAlerts,
  sentBy,
  slowerSince as slowerSinceOf,
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
import { ago, bytes } from './owners.js';
import { instant, one, pointsOf, range, valueOf } from './query.js';
import type { ChecksPanel, FlowPanel, Link, PageContext, Panel, Severity, Text } from './types.js';

const E = PG;
const P = 'integrations.db.panels';
const RATE = '2m';

const connsOf = (s: string) =>
  `(sum(watchlog_postgres_backends{${s}, db=""}) or 0 * max(watchlog_postgres_setting{${s}, name="max_connections"}))`;

export const duration = (s: number) =>
  s >= 3600
    ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
    : s >= 90
      ? `${Math.round(s / 60)} min`
      : `${Math.round(s)} s`;

/** Full sequential-scan rows per table over 6 h (catalog every 10 min), lower-case keys. */
async function fullScans(ctx: PageContext): Promise<Map<string, number>> {
  const r = await instant(
    ctx,
    `sum by (table) (increase(watchlog_postgres_table_seq_rows_read_total{${one(ctx.row.id)}}[6h]))`,
  );
  return new Map(r.map((x) => [(x.labels.table ?? '').toLowerCase(), x.points[0]?.[1] ?? 0]));
}

// ------------------------------------------------------------------------- Overview

export async function overview(
  input: PageContext,
  volume: { used: number; capacity: number; perDay: number | null } | null,
): Promise<Panel[]> {
  const ctx = aligned(input);
  const s = one(ctx.row.id);
  const [
    conns,
    maxConn,
    blocked,
    longestBlock,
    active,
    idleTx,
    idle,
    commits,
    rollbacks,
    longest,
    blksRead,
    hit,
    read15,
    size,
    growth,
    lag,
    replay,
    replicas,
    slots,
    xid,
    stmtsOn,
    settings,
    pending,
    commitSeries,
    rollbackSeries,
    blockedSeries,
    activeSeries,
    idleTxSeries,
    owners,
    stats,
    senders,
    scans,
  ] = await Promise.all([
    instant(ctx, connsOf(s)),
    instant(ctx, `max(watchlog_postgres_setting{${s}, name="max_connections"})`),
    instant(ctx, `sum(watchlog_postgres_blocked_sessions{${s}})`),
    instant(ctx, `max(watchlog_postgres_longest_block_seconds{${s}})`),
    instant(ctx, `sum(watchlog_postgres_active_sessions{${s}})`),
    instant(ctx, `sum(watchlog_postgres_backends{${s}, db="", state=~"idle in transaction.*"})`),
    instant(ctx, `sum(watchlog_postgres_backends{${s}, db="", state="idle"})`),
    instant(ctx, `sum(rate(watchlog_postgres_xact_commit_total{${s}}[${RATE}]))`),
    instant(ctx, `sum(rate(watchlog_postgres_xact_rollback_total{${s}}[${RATE}]))`),
    instant(ctx, `max(watchlog_postgres_backend_max_seconds{${s}, kind="active"})`),
    instant(ctx, `sum(rate(watchlog_postgres_blks_read_total{${s}}[${RATE}]))`),
    instant(ctx, `sum(rate(watchlog_postgres_blks_hit_total{${s}}[15m]))`),
    instant(ctx, `sum(rate(watchlog_postgres_blks_read_total{${s}}[15m]))`),
    instant(ctx, `sum(max by (db) (watchlog_postgres_database_size_bytes{${s}}))`),
    instant(
      ctx,
      `sum(max by (db) (deriv(watchlog_postgres_database_size_bytes{${s}}[7d]) and last_over_time(watchlog_postgres_database_size_bytes{${s}}[1h] offset 1d))) * 86400`,
    ),
    instant(ctx, `max(watchlog_postgres_replica_lag_seconds{${s}})`),
    instant(ctx, `max(watchlog_postgres_replay_lag_seconds{${s}})`),
    instant(ctx, `max(watchlog_postgres_replicas{${s}})`),
    instant(ctx, `max by (slot) (watchlog_postgres_slot_active{${s}})`),
    instant(ctx, `max(watchlog_postgres_xid_age{${s}})`),
    instant(ctx, `count(watchlog_postgres_statement_calls_total{${s}})`),
    instant(
      ctx,
      `max by (name) (watchlog_postgres_setting{${s}, name=~"fsync|full_page_writes|autovacuum|track_counts"})`,
    ),
    instant(ctx, `max(watchlog_postgres_pending_restart{${s}})`),
    range(ctx, `sum(rate(watchlog_postgres_xact_commit_total{${s}}[${RATE}]))`),
    range(ctx, `sum(rate(watchlog_postgres_xact_rollback_total{${s}}[${RATE}]))`),
    range(ctx, `sum(watchlog_postgres_blocked_sessions{${s}})`),
    range(ctx, `sum(watchlog_postgres_active_sessions{${s}})`),
    range(ctx, `sum(watchlog_postgres_backends{${s}, db="", state=~"idle in transaction.*"})`),
    ownersOf(ctx),
    statementStats(ctx, E),
    sentBy(ctx, E),
    fullScans(ctx),
  ]);
  const c = valueOf(conns);
  const m = valueOf(maxConn);
  const pct = c !== null && m ? c / m : null;
  const nBlocked = valueOf(blocked) ?? 0;
  const longBlock = valueOf(longestBlock) ?? 0;
  const tps = (valueOf(commits) ?? 0) + (valueOf(rollbacks) ?? 0);
  const rbShare = tps > 0 ? (valueOf(rollbacks) ?? 0) / tps : null;
  // The cache hit over 15 minutes (hits and reads alike); the flow's read rate is now (2 min).
  const h = valueOf(hit) ?? 0;
  const rd = valueOf(blksRead) ?? 0;
  const r15 = valueOf(read15) ?? 0;
  const cache = h + r15 > 0 ? h / (h + r15) : null;
  const lagS = valueOf(lag) ?? valueOf(replay);
  const nReplicas = valueOf(replicas) ?? 0;
  const days =
    volume && volume.perDay && volume.perDay > 0
      ? Math.floor((volume.capacity - volume.used) / volume.perDay)
      : null;
  const facts = statementFacts(ctx, E);
  const tree = treeSessions(ctx);
  const roots = new Set(
    tree
      .filter((t) => !t.blockedBy.length && tree.some((o) => o.blockedBy.includes(t.id)))
      .map((t) => t.addr),
  );
  const txns = transactionsOf(ctx);
  const idleLong = txns.filter((t) => t.idle && t.idleFor > 300);

  // Clients: the top three by connections; the one holding a lock others wait on, said.
  const clientRows = new Map<string, { name: string; link?: Link; n: number; holds: boolean }>();
  const extraClients =
    (
      ctx.row.status_details as {
        extra?: { clients?: { addr: string; app: string; connections: number }[] };
      }
    ).extra?.clients ?? [];
  for (const x of extraClients) {
    const who = clientOf(owners, x.addr, x.app);
    const cur = clientRows.get(who.name) ?? { ...who, n: 0, holds: false };
    cur.n += x.connections;
    cur.holds ||= roots.has(x.addr);
    clientRows.set(who.name, cur);
  }
  const clients = [...clientRows.values()].sort(
    (a, b) => Number(b.holds) - Number(a.holds) || b.n - a.n,
  );
  const statementsMean = (() => {
    let calls = 0;
    let secs = 0;
    for (const st of stats.values()) {
      calls += st.calls;
      secs += st.seconds;
    }
    return calls > 0 ? secs / calls : null;
  })();
  const slower = [...stats.values()].some((x) => x.slower);
  const flow: FlowPanel = {
    id: 'flow',
    title: `${P}.flow.title`,
    kind: 'flow',
    span: 2,
    state: c === null ? 'empty' : 'ok',
    note: { key: `${P}.flow.note` },
    columns: [
      {
        id: 'clients',
        title: { key: `${P}.flow.clients`, values: { n: clientRows.size } },
        value: c,
        unit: 'count',
        valueKey: `${P}.flow.connections`,
        rows: clients.slice(0, 3).map((x) => ({
          name: x.name,
          value: x.n,
          unit: 'count' as const,
          ...(x.link ? { link: x.link } : {}),
          ...(x.holds
            ? {
                text: { key: `${P}.flow.holdsLock`, values: { n: x.n } },
                severity: 'critical' as Severity,
              }
            : {}),
        })),
        nextText: m ? { key: `${P}.flow.ofMax`, values: { n: c ?? 0, max: m } } : undefined,
      },
      {
        id: 'sessions',
        title: { key: `${P}.flow.sessions` },
        value: valueOf(active),
        unit: 'count',
        valueKey: `${P}.flow.active`,
        ...(nBlocked > 0 ? { severity: 'critical' as Severity } : {}),
        rows: [
          {
            name: '',
            nameKey: `${P}.flow.waitingLock`,
            value: nBlocked,
            unit: 'count' as const,
            ...(nBlocked > 0 ? { severity: 'critical' as Severity } : {}),
          },
          {
            name: '',
            nameKey: `${P}.flow.idleInTx`,
            value: valueOf(idleTx) ?? 0,
            unit: 'count' as const,
            ...((valueOf(idleTx) ?? 0) > 0 ? { severity: 'warning' as Severity } : {}),
          },
          {
            name: '',
            nameKey: `${P}.flow.idle`,
            value: valueOf(idle) ?? 0,
            unit: 'count' as const,
          },
        ],
        next: tps,
      },
      {
        id: 'queries',
        title: { key: `${P}.flow.queries` },
        value: tps,
        unit: 'per_second',
        valueKey: `${P}.flow.txPerSecond`,
        rows: [
          {
            name: '',
            nameKey: `${P}.flow.statementMean`,
            value: statementsMean,
            unit: 'seconds' as const,
            ...(slower ? { severity: 'warning' as Severity } : {}),
          },
          {
            name: '',
            nameKey: `${P}.flow.longest`,
            value: valueOf(longest),
            unit: 'seconds' as const,
            ...((valueOf(longest) ?? 0) > 300 ? { severity: 'critical' as Severity } : {}),
          },
          {
            name: '',
            nameKey: `${P}.flow.rollbacks`,
            value: rbShare,
            unit: 'ratio' as const,
          },
        ],
        nextText: { key: `${P}.flow.readPerSecond`, values: { size: bytes(rd * 8192) } },
      },
      {
        id: 'storage',
        title: { key: `${P}.flow.storage` },
        value: valueOf(size),
        unit: 'bytes',
        rows: [
          ...(valueOf(growth) !== null
            ? [
                {
                  name: '',
                  nameKey: `${P}.flow.grows`,
                  value: null,
                  unit: 'bytes' as const,
                  text: {
                    key: `${P}.flow.perDay`,
                    values: { size: bytes(Math.abs(valueOf(growth)!)) },
                  },
                },
              ]
            : []),
          ...(days !== null
            ? [
                {
                  name: '',
                  nameKey: `${P}.flow.fullIn`,
                  value: null,
                  unit: 'count' as const,
                  text: { key: `${P}.flow.days`, values: { n: days } },
                  ...(days < 14 ? { severity: 'warning' as Severity } : {}),
                },
              ]
            : []),
          { name: '', nameKey: `${P}.flow.cacheHit`, value: cache, unit: 'ratio' as const },
        ],
      },
    ],
  };

  const settingOff = settings
    .filter((x) => (x.points[0]?.[1] ?? 1) === 0)
    .map((x) => x.labels.name ?? '');
  const inactive = slots.filter((x) => (x.points[0]?.[1] ?? 1) === 0).length;
  const xidAge = valueOf(xid) ?? 0;
  const checks: ChecksPanel = {
    id: 'checks',
    title: `${P}.checks.title`,
    kind: 'checks',
    span: 1,
    layout: 'side',
    state: c === null ? 'empty' : 'ok',
    items: [
      {
        id: 'lock_waits',
        labelKey: `${P}.checks.lockWaits`,
        state: longBlock > 60 ? 'fail' : nBlocked > 0 ? 'warn' : 'pass',
        value: { key: `${P}.checks.sessions`, values: { n: nBlocked } },
        link: { kind: 'tab', tab: 'locks', name: 'locks' },
      },
      {
        id: 'idle_tx',
        labelKey: `${P}.checks.idleTx`,
        state: idleLong.length ? 'warn' : 'pass',
        value: idleLong.length
          ? {
              key: `${P}.checks.idleTxWho`,
              values: {
                n: idleLong.length,
                who: clientOf(owners, idleLong[0]!.addr, idleLong[0]!.app).name,
              },
            }
          : { key: `${P}.checks.none` },
      },
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
        id: 'replicas',
        labelKey: `${P}.checks.replicas`,
        state: lagS !== null && lagS > 30 ? 'warn' : 'pass',
        value:
          lagS === null
            ? { key: `${P}.checks.noReplicas` }
            : { key: `${P}.checks.lag`, values: { lag: duration(lagS) } },
      },
      {
        id: 'slots',
        labelKey: `${P}.checks.slots`,
        state: inactive ? 'warn' : 'pass',
        value: slots.length
          ? {
              key: `${P}.checks.ofActive`,
              values: { n: slots.length - inactive, of: slots.length },
            }
          : { key: `${P}.checks.noSlots` },
      },
      {
        id: 'xid',
        labelKey: `${P}.checks.xid`,
        state: xidAge > 1.5e9 ? 'fail' : xidAge > 1e9 ? 'warn' : 'pass',
        value: { key: `${P}.checks.xidOf`, values: { n: Math.round(xidAge / 1e6) } },
      },
      {
        id: 'settings',
        labelKey: `${P}.checks.settings`,
        state: settingOff.length ? 'fail' : (valueOf(pending) ?? 0) > 0 ? 'warn' : 'pass',
        value: settingOff.length
          ? { key: `${P}.checks.settingOff`, values: { names: settingOff.join(', ') } }
          : (valueOf(pending) ?? 0) > 0
            ? { key: `${P}.checks.pendingRestart`, values: { n: valueOf(pending) } }
            : { key: `${P}.checks.settingsOk` },
      },
      {
        id: 'statements',
        labelKey: `${P}.checks.statementsOn`,
        state: (valueOf(stmtsOn) ?? 0) > 0 ? 'pass' : 'warn',
        value: { key: (valueOf(stmtsOn) ?? 0) > 0 ? `${P}.checks.yes` : `${P}.checks.no` },
      },
    ],
  };

  const costly = [...stats.values()].sort((a, b) => (b.share ?? 0) - (a.share ?? 0)).slice(0, 5);
  const rootMarker = tree
    .filter((t) => !t.blockedBy.length && tree.some((o) => o.blockedBy.includes(t.id)) && t.xact)
    .map((t) => ({
      at: Math.floor(ctx.now / 1000) - (t.xact ?? 0),
      text: {
        key: `${P}.marker.lockTaken`,
        values: { name: clientOf(owners, t.addr, t.app).name },
      } as Text,
      severity: 'critical' as Severity,
    }))
    .slice(0, 1);
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
          ...(pct !== null && pct > 0.9 ? { severity: 'warning' as Severity } : {}),
        },
        {
          id: 'transactions',
          labelKey: `${P}.tiles.transactions`,
          value: tps,
          unit: 'per_second',
          sub:
            rbShare !== null
              ? { key: `${P}.tiles.rollbacks`, values: { pct: Math.round(rbShare * 1000) / 10 } }
              : undefined,
        },
        {
          id: 'lock_waits',
          labelKey: `${P}.tiles.lockWaits`,
          value: nBlocked,
          unit: 'count',
          sub:
            nBlocked > 0
              ? { key: `${P}.tiles.longest`, values: { d: duration(longBlock) } }
              : { key: `${P}.tiles.none` },
          ...(nBlocked > 0
            ? { severity: longBlock > 60 ? ('critical' as Severity) : ('warning' as Severity) }
            : {}),
        },
        {
          id: 'lag',
          labelKey: `${P}.tiles.lag`,
          value: lagS,
          unit: 'seconds',
          sub:
            lagS === null
              ? { key: `${P}.tiles.noReplicas` }
              : { key: `${P}.tiles.streaming`, values: { n: nReplicas } },
          ...(lagS !== null && lagS > 30 ? { severity: 'warning' as Severity } : {}),
        },
        {
          id: 'cache',
          labelKey: `${P}.tiles.cacheHit`,
          value: cache,
          unit: 'ratio',
          sub: { key: `${P}.tiles.healthyAbove`, values: { pct: 99 } },
          ...(cache !== null && cache < 0.9 ? { severity: 'warning' as Severity } : {}),
        },
        {
          id: 'disk',
          labelKey: `${P}.tiles.disk`,
          value: days,
          unit: 'count',
          sub: days !== null ? { key: `${P}.tiles.daysLeft` } : { key: `${P}.tiles.notGrowing` },
          ...(days !== null && days < 14 ? { severity: 'warning' as Severity } : {}),
        },
      ],
    },
    {
      id: 'transactions',
      title: `${P}.charts.transactions`,
      kind: 'stack',
      span: 1,
      unit: 'per_second',
      state: commitSeries.length ? 'ok' : 'empty',
      ...(rootMarker.length ? { markers: rootMarker } : {}),
      series: [
        { nameKey: `${P}.series.commits`, points: pointsOf(commitSeries[0]) },
        {
          nameKey: `${P}.series.rollbacks`,
          points: pointsOf(rollbackSeries[0]),
          severity: 'warning',
        },
      ],
    },
    {
      id: 'sessions',
      title: `${P}.charts.sessions`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: activeSeries.length ? 'ok' : 'empty',
      ...(rootMarker.length ? { markers: rootMarker } : {}),
      series: [
        {
          nameKey: `${P}.series.waitingLock`,
          points: pointsOf(blockedSeries[0]),
          severity: 'critical',
        },
        { nameKey: `${P}.series.active`, points: pointsOf(activeSeries[0]) },
        { nameKey: `${P}.series.idleInTx`, points: pointsOf(idleTxSeries[0]), severity: 'warning' },
      ],
    },
    checks,
    {
      id: 'slowest',
      title: `${P}.costly.title`,
      kind: 'statements',
      span: 1,
      layout: 'main',
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
        scans,
      ),
    },
    ...(await resourcePanels(ctx, E)),
  ];
}

// ------------------------------------------------------------------------- Queries

/** Every top statement by its share of the time, with who sends it (the Queries tab). */
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
    note: { key: `${P}.statements.note` },
    shareOf: 'time',
    full: true,
    total: ids.length,
    rows: statementRows(E, ids, stats, facts, senders, owners, scans),
  };
}

// ------------------------------------------------------------------------- Waits

/** Active sessions by wait over the range; the statements and clients of the chosen period. */
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
  const old = (Number((ctx.row.version ?? '').split('.')[0]) || 99) < 14;
  return [
    chart,
    {
      id: 'summary',
      title: `${P}.waitsSummary.title`,
      kind: 'facts',
      span: 2,
      state: over.total > 0 ? 'ok' : 'empty',
      note: { key: `${P}.waitsSummary.period`, values: { from: end - dur, to: end } },
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
      ...(old ? { note: { key: `${P}.waitsStatements.pg13` } } : {}),
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
  const sel = `${one(ctx.row.id)}, queryid="${escapeLabelValue(id)}"`;
  const w = RATE;
  const [stats, owners, clients, mean, calls, rowsS, blocks, temp, waits, scans] =
    await Promise.all([
      statementStats(ctx, E),
      ownersOf(ctx),
      clientsOfStatement(ctx, E, id),
      range(
        ctx,
        `sum(rate(watchlog_postgres_statement_seconds_total{${sel}}[${w}])) / sum(rate(watchlog_postgres_statement_calls_total{${sel}}[${w}]))`,
      ),
      range(ctx, `sum(rate(watchlog_postgres_statement_calls_total{${sel}}[${w}]))`),
      range(ctx, `sum(rate(watchlog_postgres_statement_rows_total{${sel}}[${w}]))`),
      range(ctx, `sum by (kind) (rate(watchlog_postgres_statement_blocks_total{${sel}}[${w}]))`),
      range(ctx, `sum(rate(watchlog_postgres_statement_temp_blocks_total{${sel}}[${w}]))`),
      range(
        ctx,
        `sum by (wait) (avg_over_time(watchlog_postgres_statement_active_sessions{${sel}}[${w}]))`,
      ),
      fullScans(ctx),
    ]);
  const st = stats.get(id);
  const f = statementFacts(ctx, E).get(id);
  const since = st?.slower && st.usual ? await slowerSinceOf(ctx, E, id, st.usual) : null;
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
        { labelKey: `${P}.statement.text`, value: f?.text ?? `queryid ${id}` },
        { labelKey: `${P}.statement.calls`, value: st?.calls ?? null, unit: 'per_second' },
        { labelKey: `${P}.statement.mean`, value: st?.mean ?? null, unit: 'seconds' },
        { labelKey: `${P}.statement.usual`, value: st?.usual ?? null, unit: 'seconds' },
        {
          labelKey: `${P}.statement.share`,
          value: st?.share ?? null,
          unit: 'ratio',
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
        { nameKey: `${P}.series.rows`, points: pointsOf(rowsS[0]) },
      ],
    },
    {
      id: 'reads',
      title: `${P}.statement.reads`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: blocks.length ? 'ok' : 'empty',
      note: { key: `${P}.statement.blocksNote` },
      series: [
        ...blocks.map((x) => ({
          nameKey: `${P}.series.blocks.${x.labels.kind ?? 'read'}`,
          points: pointsOf(x),
        })),
        {
          nameKey: `${P}.series.tempBlocks`,
          points: pointsOf(temp[0]),
          severity: 'warning' as Severity,
        },
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
      note: { key: `${P}.statement.sendersNote` },
      items: clients
        .slice(0, 10)
        .map((x) => ({ label: clientOf(owners, x.addr).name, value: x.share })),
    },
    {
      id: 'tables',
      title: `${P}.statement.tables`,
      kind: 'facts',
      span: 1,
      state: tables.length ? 'ok' : 'empty',
      rows: tables.map((t) => ({
        labelKey: `${P}.statement.table`,
        value: t,
        text: {
          key: `${P}.statement.fullScans`,
          values: { n: Math.round(scans.get(t.toLowerCase()) ?? 0) },
        },
      })),
    },
    await scopedAlerts(ctx, E, { statement: id }, [
      {
        key: 'slower',
        nameKey: `${P}.presets.slower`,
        metric: 'postgres.statement.slower',
        op: '>',
        value: 3,
        forSeconds: 600,
        severity: 'warning',
      },
      {
        key: 'mean',
        nameKey: `${P}.presets.mean`,
        metric: 'postgres.statement.mean',
        op: '>',
        value: 1,
        forSeconds: 300,
        severity: 'warning',
      },
    ]),
  ];
}

// ------------------------------------------------------------------------- one table

export async function tablePage(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const [db, table] = (ctx.params?.table ?? '').split('/', 2) as [string, string | undefined];
  const sel = `${one(ctx.row.id)}, db="${escapeLabelValue(db)}", table="${escapeLabelValue(table ?? '')}"`;
  const [size, dead, live, seq, idx, growth] = await Promise.all([
    range(ctx, `max(watchlog_postgres_table_size_bytes{${sel}})`),
    range(ctx, `max(watchlog_postgres_table_dead_rows{${sel}})`),
    instant(ctx, `max(watchlog_postgres_table_live_rows{${sel}})`),
    range(ctx, `sum(rate(watchlog_postgres_table_seq_scans_total{${sel}}[1h]))`),
    range(ctx, `sum(rate(watchlog_postgres_table_index_scans_total{${sel}}[1h]))`),
    instant(ctx, `max(deriv(watchlog_postgres_table_size_bytes{${sel}}[24h])) * 86400`),
  ]);
  const extra =
    (ctx.row.status_details as { extra?: Record<string, Record<string, unknown>[]> }).extra ?? {};
  const vac = (extra.vacuum ?? []).find((x) => x.db === db && x.table === table);
  const indexes = [
    ...(extra.unused_indexes ?? [])
      .filter((x) => x.db === db && x.table === table)
      .map((x) => ({ name: String(x.index), what: 'unused', size: Number(x.size ?? 0) })),
    ...(extra.duplicate_indexes ?? [])
      .filter((x) => x.db === db && x.table === table)
      .map((x) => ({ name: String(x.indexes), what: 'duplicate', size: Number(x.size ?? 0) })),
    ...(extra.invalid_indexes ?? [])
      .filter((x) => x.db === db && x.table === table)
      .map((x) => ({ name: String(x.index), what: 'invalid', size: 0 })),
  ];
  const noPK = (extra.no_primary_key ?? []).some((x) => x.db === db && x.table === table);
  return [
    {
      id: 'facts',
      title: `${P}.table.facts`,
      kind: 'facts',
      span: 2,
      state: size.length ? 'ok' : 'empty',
      rows: [
        { labelKey: `${P}.table.name`, value: `${db}: ${table ?? ''}` },
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
        { labelKey: `${P}.table.live`, value: valueOf(live), unit: 'count' },
        { labelKey: `${P}.table.dead`, value: dead[0]?.points.at(-1)?.[1] ?? null, unit: 'count' },
        {
          labelKey: `${P}.table.lastAutovacuum`,
          value: vac?.last_autovacuum ? ago(Number(vac.last_autovacuum), ctx.now) : '–',
        },
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
      id: 'dead',
      title: `${P}.table.deadOverTime`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: dead.length ? 'ok' : 'empty',
      series: [{ nameKey: `${P}.series.deadRows`, points: pointsOf(dead[0]), severity: 'warning' }],
    },
    {
      id: 'scans',
      title: `${P}.table.scans`,
      kind: 'line',
      span: 2,
      unit: 'per_second',
      state: seq.length || idx.length ? 'ok' : 'empty',
      note: { key: `${P}.table.scansNote` },
      series: [
        { nameKey: `${P}.series.seqScans`, points: pointsOf(seq[0]), severity: 'warning' },
        { nameKey: `${P}.series.indexScans`, points: pointsOf(idx[0]) },
      ],
    },
    {
      id: 'indexes',
      title: `${P}.table.indexes`,
      kind: 'table',
      span: 2,
      state: indexes.length ? 'ok' : 'empty',
      note: { key: `${P}.table.indexesNote` },
      columns: [`${P}.cols.index`, `${P}.cols.finding`, `${P}.cols.size`],
      rows: indexes.map((x) => ({
        cells: [x.name, x.what, x.size ? bytes(x.size) : '–'],
        severity: x.what === 'invalid' ? ('warning' as Severity) : undefined,
      })),
    },
    await scopedAlerts(ctx, E, { table: `${db}/${table ?? ''}` }, [
      {
        key: 'dead',
        nameKey: `${P}.presets.deadRows`,
        metric: 'postgres.table.dead_rows',
        op: '>',
        value: 1_000_000,
        forSeconds: 3600,
        severity: 'warning',
      },
      {
        key: 'size',
        nameKey: `${P}.presets.tableSize`,
        metric: 'postgres.table.size',
        op: '>',
        value: 100 * 2 ** 30,
        forSeconds: 0,
        severity: 'warning',
      },
    ]),
  ];
}

// ------------------------------------------------------------------------- Connections, Locks

/** Sessions per database and role, the clients with their idle connections, transactions. */
export async function connectionsDeep(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [byRole, owners] = await Promise.all([
    instant(ctx, `topk(15, max by (db, role) (watchlog_postgres_sessions{${s}}))`),
    ownersOf(ctx),
  ]);
  const clients =
    (ctx.row.status_details as { extra?: { clients?: Record<string, unknown>[] } }).extra
      ?.clients ?? [];
  const txns = transactionsOf(ctx);
  return [
    {
      id: 'by-role',
      title: `${P}.connections.byRole`,
      kind: 'bars',
      span: 1,
      unit: 'count',
      state: byRole.length ? 'ok' : 'empty',
      items: byRole
        .map((x) => ({ label: `${x.labels.db}: ${x.labels.role}`, value: x.points[0]?.[1] ?? 0 }))
        .sort((a, b) => b.value - a.value),
    },
    {
      id: 'clients',
      title: `${P}.connections.clients`,
      kind: 'table',
      span: 1,
      state: clients.length ? 'ok' : 'empty',
      note: { key: `${P}.connections.pgbouncer` },
      columns: [
        `${P}.cols.client`,
        `${P}.cols.connections`,
        `${P}.cols.idle`,
        `${P}.cols.idleInTx`,
        `${P}.cols.oldestIdle`,
      ],
      rows: clients.slice(0, 20).map((x) => {
        const name = clientOf(owners, String(x.addr ?? ''), String(x.app ?? '')).name;
        const pool = /pgbouncer|pgpool|odyssey/i.test(`${name} ${x.app ?? ''}`);
        return {
          cells: [
            pool ? `${name} (connection pool)` : name,
            Number(x.connections ?? 0),
            Number(x.idle ?? 0),
            Number(x.idle_in_xact ?? 0),
            Number(x.idle ?? 0) > 0 ? duration(Number(x.idle_min ?? 0)) : '–',
          ],
          severity: Number(x.idle_in_xact ?? 0) > 0 ? ('warning' as Severity) : undefined,
        };
      }),
    },
    transactionsTable(ctx, txns, owners),
  ];
}

function transactionsTable(
  ctx: PageContext,
  txns: ReturnType<typeof transactionsOf>,
  owners: Map<string, import('./owners.js').Owner>,
): Panel {
  return {
    id: 'transactions',
    title: `${P}.transactions.title`,
    kind: 'table',
    span: 2,
    state: txns.length ? 'ok' : 'empty',
    note: { key: `${P}.transactions.note` },
    columns: [
      `${P}.cols.client`,
      `${P}.cols.open`,
      `${P}.cols.state`,
      `${P}.cols.blocks`,
      `${P}.cols.holdsXmin`,
      `${P}.cols.query`,
    ],
    rows: txns.map((t) => ({
      cells: [
        clientOf(owners, t.addr, t.app).name,
        duration(t.age),
        t.idle ? `idle for ${duration(t.idleFor)}` : 'active',
        t.blocks,
        t.holdsXmin === null ? '–' : t.holdsXmin ? 'yes' : 'no',
        t.query ?? '–',
      ],
      severity: t.age > 1800 || (t.idle && t.blocks > 0) ? ('warning' as Severity) : undefined,
    })),
  };
}

export async function locksDeep(ctx: PageContext): Promise<Panel[]> {
  const owners = await ownersOf(ctx);
  return [
    treePanel(E, treeSessions(ctx), owners),
    transactionsTable(ctx, transactionsOf(ctx), owners),
  ];
}

// ------------------------------------------------------------------------- Replication

/** Slots (WAL kept, its state, how long until it fills the disk), archiving, checkpoints. */
export async function replicationDeep(
  ctx: PageContext,
  volume: { used: number; capacity: number } | null,
): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [retained, growth, archived, failed, lastOk, lastFail, archMode, ckpt, ckptTime, written] =
    await Promise.all([
      instant(ctx, `max by (slot) (watchlog_postgres_slot_retained_bytes{${s}})`),
      instant(ctx, `max by (slot) (deriv(watchlog_postgres_slot_retained_bytes{${s}}[1h]))`),
      instant(ctx, `sum(increase(watchlog_postgres_archived_total{${s}}[1h]))`),
      instant(ctx, `sum(increase(watchlog_postgres_archive_failed_total{${s}}[1h]))`),
      instant(ctx, `max(watchlog_postgres_archive_last_seconds{${s}, result="archived"})`),
      instant(ctx, `max(watchlog_postgres_archive_last_seconds{${s}, result="failed"})`),
      instant(ctx, `max(watchlog_postgres_archive_mode{${s}})`),
      range(ctx, `sum by (kind) (increase(watchlog_postgres_checkpoints_total{${s}}[1h]))`),
      range(
        ctx,
        `sum by (phase) (rate(watchlog_postgres_checkpoint_seconds_total{${s}}[${RATE}]))`,
      ),
      range(ctx, `sum by (by) (rate(watchlog_postgres_buffers_written_total{${s}}[${RATE}]))`),
    ]);
  const slots =
    (ctx.row.status_details as { extra?: { slots?: Record<string, unknown>[] } }).extra?.slots ??
    [];
  const grow = byLabel(growth, 'slot');
  const free = volume ? volume.capacity - volume.used : null;
  const fillIn = (slot: string) => {
    const g = grow.get(slot) ?? 0;
    return free !== null && g > 0 ? free / g : null;
  };
  return [
    {
      id: 'slots',
      title: `${P}.slots.title`,
      kind: 'table',
      span: 2,
      state: slots.length ? 'ok' : 'empty',
      note: { key: `${P}.slots.note` },
      columns: [
        `${P}.cols.slot`,
        `${P}.cols.active`,
        `${P}.cols.retained`,
        `${P}.cols.walStatus`,
        `${P}.cols.safe`,
        `${P}.cols.fillsDiskIn`,
      ],
      rows: slots.map((x) => {
        const name = String(x.slot ?? '');
        const ret = byLabel(retained, 'slot').get(name) ?? Number(x.retained ?? 0);
        const eta = fillIn(name);
        return {
          cells: [
            name,
            x.active
              ? 'active'
              : x.inactive_since
                ? `inactive since ${ago(Number(x.inactive_since), ctx.now)}`
                : 'inactive',
            bytes(ret),
            String(x.wal_status || '–'),
            x.safe !== undefined ? bytes(Number(x.safe)) : '–',
            eta !== null ? duration(eta) : '–',
          ],
          severity:
            eta !== null && eta < 86400
              ? ('critical' as Severity)
              : !x.active
                ? ('warning' as Severity)
                : undefined,
        };
      }),
    },
    {
      id: 'archiving',
      title: `${P}.archiving.title`,
      kind: 'facts',
      span: 1,
      state: valueOf(archMode) !== null ? 'ok' : 'empty',
      rows:
        valueOf(archMode) === 0
          ? [{ labelKey: `${P}.archiving.mode`, value: null, text: { key: `${P}.archiving.off` } }]
          : [
              {
                labelKey: `${P}.archiving.archived`,
                value: Math.round(valueOf(archived) ?? 0),
                unit: 'count',
              },
              {
                labelKey: `${P}.archiving.failed`,
                value: Math.round(valueOf(failed) ?? 0),
                unit: 'count',
              },
              {
                labelKey: `${P}.archiving.last`,
                value: valueOf(lastOk) ? ago(valueOf(lastOk)!, ctx.now) : '–',
              },
              {
                labelKey: `${P}.archiving.lastFailure`,
                value: valueOf(lastFail) ? ago(valueOf(lastFail)!, ctx.now) : '–',
              },
            ],
    },
    {
      id: 'checkpoints',
      title: `${P}.checkpoints.title`,
      kind: 'stack',
      span: 1,
      unit: 'count',
      state: ckpt.length ? 'ok' : 'empty',
      note: { key: `${P}.checkpoints.note` },
      series: ckpt.map((x) => ({
        nameKey: `${P}.checkpoints.${x.labels.kind ?? 'timed'}`,
        points: pointsOf(x),
        ...(x.labels.kind === 'requested' ? { severity: 'warning' as Severity } : {}),
      })),
    },
    {
      id: 'checkpoint-time',
      title: `${P}.checkpoints.time`,
      kind: 'stack',
      span: 1,
      unit: 'seconds',
      state: ckptTime.length ? 'ok' : 'empty',
      series: ckptTime.map((x) => ({
        nameKey: `${P}.checkpoints.${x.labels.phase ?? 'write'}`,
        points: pointsOf(x),
      })),
    },
    {
      id: 'written',
      title: `${P}.checkpoints.written`,
      kind: 'stack',
      span: 1,
      unit: 'per_second',
      state: written.length ? 'ok' : 'empty',
      note: { key: `${P}.checkpoints.writtenNote` },
      series: written.map((x) => ({
        nameKey: `${P}.checkpoints.by.${x.labels.by ?? 'checkpointer'}`,
        points: pointsOf(x),
        ...(x.labels.by === 'backend' ? { severity: 'warning' as Severity } : {}),
      })),
    },
  ];
}

// ------------------------------------------------------------------------- Tables, Vacuum

/** Schema findings (every 10 min) and the fastest-growing tables, each linking its page. */
export async function tablesDeep(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const growing = await instant(
    ctx,
    `topk(10, max by (db, table) (deriv(watchlog_postgres_table_size_bytes{${s}}[24h])) * 86400 > 0)`,
  );
  const extra =
    (ctx.row.status_details as { extra?: Record<string, Record<string, unknown>[]> }).extra ?? {};
  const dup = extra.duplicate_indexes ?? [];
  const noPK = extra.no_primary_key ?? [];
  const invalid = extra.invalid_indexes ?? [];
  const seqs = (extra.sequences ?? []).filter((x) => typeof x.used === 'number');
  return [
    {
      id: 'growing',
      title: `${P}.tables.growing`,
      kind: 'table',
      span: 1,
      state: growing.length ? 'ok' : 'empty',
      columns: [`${P}.cols.table`, `${P}.cols.db`, `${P}.cols.perDay`],
      rows: growing
        .sort((a, b) => (b.points[0]?.[1] ?? 0) - (a.points[0]?.[1] ?? 0))
        .map((x) => ({
          cells: [x.labels.table ?? '', x.labels.db ?? '', bytes(x.points[0]?.[1] ?? 0)],
          link: tableLink(x.labels.db ?? '', x.labels.table ?? ''),
        })),
    },
    {
      id: 'sequences',
      title: `${P}.tables.sequences`,
      kind: 'gauge',
      span: 1,
      state: seqs.length ? 'ok' : 'empty',
      note: { key: `${P}.tables.sequencesNote` },
      items: seqs.slice(0, 8).map((x) => ({
        label: `${x.db}: ${x.sequence}`,
        value: Number(x.used),
        max: 1,
        unit: 'ratio' as const,
        warnAt: 0.7,
      })),
    },
    {
      id: 'duplicates',
      title: `${P}.tables.duplicates`,
      kind: 'table',
      span: 1,
      state: dup.length ? 'ok' : 'empty',
      columns: [`${P}.cols.table`, `${P}.cols.indexes`, `${P}.cols.size`],
      rows: dup.map((x) => ({
        cells: [`${x.db}: ${x.table}`, String(x.indexes), bytes(Number(x.size ?? 0))],
      })),
    },
    {
      id: 'no-pk',
      title: `${P}.tables.noPrimaryKey`,
      kind: 'table',
      span: 1,
      state: noPK.length ? 'ok' : 'empty',
      note: { key: `${P}.tables.noPrimaryKeyNote` },
      columns: [`${P}.cols.table`, `${P}.cols.size`],
      rows: noPK.map((x) => ({
        cells: [`${x.db}: ${x.table}`, bytes(Number(x.size ?? 0))],
        link: tableLink(String(x.db), String(x.table)),
      })),
    },
    ...(invalid.length
      ? [
          {
            id: 'invalid',
            title: `${P}.tables.invalid`,
            kind: 'table' as const,
            span: 2 as const,
            state: 'ok' as const,
            columns: [`${P}.cols.index`, `${P}.cols.table`],
            rows: invalid.map((x) => ({
              cells: [String(x.index), `${x.db}: ${x.table}`],
              severity: 'warning' as Severity,
            })),
          },
        ]
      : []),
  ];
}

/** What holds the xmin horizon back, and prepared transactions left open. */
export async function vacuumDeep(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [prepared, oldestPrepared, owners] = await Promise.all([
    instant(ctx, `max(watchlog_postgres_prepared_xacts{${s}})`),
    instant(ctx, `max(watchlog_postgres_prepared_xact_oldest_seconds{${s}})`),
    ownersOf(ctx),
  ]);
  const holders =
    (ctx.row.status_details as { extra?: { xmin_holders?: Record<string, unknown>[] } }).extra
      ?.xmin_holders ?? [];
  return [
    {
      id: 'xmin',
      title: `${P}.xmin.title`,
      kind: 'table',
      span: 1,
      state: holders.length ? 'ok' : 'empty',
      note: { key: `${P}.xmin.note` },
      columns: [`${P}.cols.holder`, `${P}.cols.kind`, `${P}.cols.xminAge`],
      rows: holders
        .sort((a, b) => Number(b.age) - Number(a.age))
        .map((x) => ({
          cells: [
            x.kind === 'session' ? clientOf(owners, String(x.name)).name : String(x.name),
            String(x.kind),
            `${Math.round(Number(x.age) / 1000) / 1000} M`,
          ],
          severity: Number(x.age) > 1e8 ? ('warning' as Severity) : undefined,
        })),
    },
    {
      id: 'prepared',
      title: `${P}.prepared.title`,
      kind: 'facts',
      span: 1,
      state: 'ok',
      rows: [
        { labelKey: `${P}.prepared.open`, value: valueOf(prepared) ?? 0, unit: 'count' },
        {
          labelKey: `${P}.prepared.oldest`,
          value: (valueOf(prepared) ?? 0) > 0 ? duration(valueOf(oldestPrepared) ?? 0) : '–',
        },
      ],
    },
  ];
}

/** When a statement became slower (the finding's "since 14:00"). */
export const slowerSince = (ctx: PageContext, id: string, usual: number) =>
  slowerSinceOf(ctx, E, id, usual);

/** A table's page: "db/schema.table". */
export const tableLink = (db: string, table: string): Link => ({
  kind: 'table',
  id: `${db}/${table}`,
  name: `${db}: ${table}`,
});

export { dominantWait, waitsOver };
export const ownerLinkOf = clientOf;
export type { Link };
