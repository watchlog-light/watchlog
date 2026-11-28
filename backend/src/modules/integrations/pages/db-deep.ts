// SPDX-License-Identifier: AGPL-3.0-only
// What PostgreSQL and MySQL pages share since 1.2 (ADR-245): what the database waits on,
// which statement is responsible and which service sends it, what changed, who blocks whom.
// One engine description per database; every number that appears in two places on a page
// comes from one function here, read once.
import { sql } from 'kysely';
import { escapeLabelValue } from '../../query/catalog.js';
import type { QuerySeries } from '../../../lib/victoria.js';
import { ipOwners, type Owner } from './owners.js';
import { instant, one, pointsOf, range, valueOf, windowOf } from './query.js';
import type {
  Link,
  PageContext,
  Panel,
  ScopedAlertsPanel,
  Severity,
  StatementRow,
  Text,
  TreePanel,
} from './types.js';

export interface Engine {
  type: 'postgres' | 'mysql';
  /** The series' prefix. */
  m: 'watchlog_postgres' | 'watchlog_mysql';
  /** The label naming a statement. */
  stmt: 'queryid' | 'digest';
  /** The i18n prefix of the deep panels. */
  P: string;
}
export const PG: Engine = {
  type: 'postgres',
  m: 'watchlog_postgres',
  stmt: 'queryid',
  P: 'integrations.db.panels',
};
export const MY: Engine = {
  type: 'mysql',
  m: 'watchlog_mysql',
  stmt: 'digest',
  P: 'integrations.db.panels',
};

/** The five classes of "active sessions by wait" (the collectors' WaitClasses). */
export const WAITS = ['cpu', 'io', 'lock', 'client', 'other'] as const;
export type WaitClass = (typeof WAITS)[number];
export const WAIT_SEVERITY: Record<WaitClass, Severity | undefined> = {
  cpu: undefined,
  io: undefined,
  lock: 'critical',
  client: undefined,
  other: undefined,
};

/** A rate's window: at least two scrapes and two chart steps (as RabbitMQ's, 1.1.1). */
export const rateWindow = (ctx: PageContext) =>
  `${Math.max(120, 2 * windowOf(ctx.range, ctx.now).step)}s`;

/** An instant query at a given unix second (the Waits tab's chosen period ends there). */
async function at(ctx: PageContext, expr: string, unix: number): Promise<QuerySeries[]> {
  if (!ctx.vm) return [];
  return ctx.vm.query(ctx.scope, expr, unix);
}

const num = (s: QuerySeries | undefined) => s?.points[0]?.[1] ?? null;

// ------------------------------------------------------------------------- clients

export interface ClientName {
  name: string;
  link?: Link;
}
/** A client by its workload or container (with a link), else its address or application. */
export function clientOf(owners: Map<string, Owner>, addr: string, app?: string): ClientName {
  const o = addr ? owners.get(addr) : undefined;
  if (o)
    return {
      name: o.name,
      ...(o.id ? { link: { kind: o.kind, id: o.id, name: o.name } as Link } : {}),
    };
  if (addr && addr !== 'local') return { name: addr };
  return { name: app || 'local' };
}

export const ownersOf = (ctx: PageContext) => ipOwners(ctx.db, ctx.row.cluster_id);

// ------------------------------------------------------------------------- waits

/** The period the Waits tab looks at: the one chosen on its chart, else the page's range. */
export function periodOf(ctx: PageContext): { end: number; dur: number } {
  const now = Math.floor(ctx.now / 1000);
  const from = Number(ctx.params?.from);
  const to = Number(ctx.params?.to);
  if (Number.isFinite(from) && Number.isFinite(to) && to > from && to <= now + 60) {
    return { end: Math.floor(to), dur: Math.max(60, Math.floor(to - from)) };
  }
  return { end: now, dur: ctx.range };
}

/**
 * The average active sessions by wait class over a period (the samples' mean): the one
 * number behind "the database spent 71% of the last 15 minutes waiting on locks", the
 * Waits tab's summary and the Overview's finding.
 */
export async function waitsOver(
  ctx: PageContext,
  e: Engine,
  end: number,
  dur: number,
): Promise<{ by: Record<WaitClass, number>; total: number }> {
  const r = await at(
    ctx,
    `sum by (wait) (avg_over_time(${e.m}_active_sessions{${one(ctx.row.id)}}[${dur}s]))`,
    end,
  );
  const by = Object.fromEntries(WAITS.map((w) => [w, 0])) as Record<WaitClass, number>;
  for (const s of r) {
    const w = s.labels.wait as WaitClass;
    if (w in by) by[w] = s.points[0]?.[1] ?? 0;
  }
  return { by, total: WAITS.reduce((a, w) => a + by[w], 0) };
}

/** The wait class with the largest share, when it is most of the time and not CPU. */
export function dominantWait(w: { by: Record<WaitClass, number>; total: number }) {
  if (w.total <= 0) return null;
  const top = [...WAITS].sort((a, b) => w.by[b] - w.by[a])[0]!;
  const share = w.by[top] / w.total;
  return { wait: top, share };
}

/** Active sessions by wait over the page's range: a stacked chart a period can be chosen on. */
export async function waitsChart(ctx: PageContext, e: Engine, select = true): Promise<Panel> {
  const series = await range(
    ctx,
    `sum by (wait) (avg_over_time(${e.m}_active_sessions{${one(ctx.row.id)}}[${rateWindow(ctx)}]))`,
  );
  const by = new Map(series.map((s) => [s.labels.wait ?? '', s]));
  return {
    id: 'waits',
    title: `${e.P}.waits`,
    kind: 'stack',
    span: 2,
    unit: 'count',
    state: series.length ? 'ok' : 'empty',
    note: { key: `${e.P}.waitsNote` },
    ...(select ? { select: true } : {}),
    series: WAITS.map((w) => ({
      nameKey: `${e.P}.wait.${w}`,
      points: pointsOf(by.get(w)),
      ...(WAIT_SEVERITY[w] ? { severity: WAIT_SEVERITY[w] } : {}),
    })),
  };
}

// ------------------------------------------------------------------------- statements

export interface StatementStats {
  id: string;
  /** Calls a second, seconds a second, rows a second (15 min). */
  calls: number;
  seconds: number;
  rows: number;
  /** Mean seconds now (15 min) and as usual (the 6 h before). */
  mean: number | null;
  usual: number | null;
  /** Its share of the time all top statements took (15 min). */
  share: number | null;
  /** How many times slower than usual, when it is far slower with no rise in calls. */
  slower: number | null;
}

/** "Far slower than its usual": the rule of the finding, the alert and the row's hint. */
export function slowerOf(
  mean: number | null,
  usual: number | null,
  calls: number,
  callsUsual: number,
): number | null {
  if (mean === null || usual === null || usual <= 0) return null;
  const factor = mean / usual;
  // At least 3× and 5 ms slower, with at least 20 calls in the 15 minutes, and not because
  // the statement runs much more often (then it is load, not a regression).
  if (factor < 3 || mean - usual < 0.005) return null;
  if (calls * 900 < 20 || callsUsual <= 0 || calls > 1.5 * callsUsual) return null;
  return factor;
}

/** Every top statement's numbers, read once for the page (15 min against the 6 h before). */
export async function statementStats(
  ctx: PageContext,
  e: Engine,
): Promise<Map<string, StatementStats>> {
  const s = one(ctx.row.id);
  const by = e.stmt;
  const rowsMetric =
    e.type === 'postgres' ? `${e.m}_statement_rows_total` : `${e.m}_statement_rows_sent_total`;
  const q = (metric: string, w: string, off = '') =>
    instant(ctx, `sum by (${by}) (rate(${metric}{${s}}[${w}]${off}))`);
  const [calls, secs, rows, callsU, secsU] = await Promise.all([
    q(`${e.m}_statement_calls_total`, '15m'),
    q(`${e.m}_statement_seconds_total`, '15m'),
    q(rowsMetric, '15m'),
    q(`${e.m}_statement_calls_total`, '6h', ' offset 15m'),
    q(`${e.m}_statement_seconds_total`, '6h', ' offset 15m'),
  ]);
  const map = (r: QuerySeries[]) => new Map(r.map((x) => [x.labels[by] ?? '', num(x) ?? 0]));
  const [c, sec, rw, cu, su] = [calls, secs, rows, callsU, secsU].map(map);
  const total = [...sec!.values()].reduce((a, b) => a + b, 0);
  const out = new Map<string, StatementStats>();
  for (const [id, n] of c!) {
    const t = sec!.get(id) ?? 0;
    const mean = n > 0 ? t / n : null;
    const nu = cu!.get(id) ?? 0;
    const usual = nu > 0 ? (su!.get(id) ?? 0) / nu : null;
    out.set(id, {
      id,
      calls: n,
      seconds: t,
      rows: rw!.get(id) ?? 0,
      mean,
      usual,
      share: total > 0 ? t / total : null,
      slower: slowerOf(mean, usual, n, nu),
    });
  }
  return out;
}

/**
 * When a statement became slower: the first 5-minute mean of the last 6 hours, after the last
 * one at most twice its usual, that is above it. Unix seconds, or null.
 */
export async function slowerSince(
  ctx: PageContext,
  e: Engine,
  id: string,
  usual: number,
): Promise<number | null> {
  if (!ctx.vm) return null;
  const sel = `${one(ctx.row.id)}, ${e.stmt}="${escapeLabelValue(id)}"`;
  const end = Math.floor(ctx.now / 1000 / 300) * 300;
  const r = await ctx.vm.queryRange(
    ctx.scope,
    `sum(rate(${e.m}_statement_seconds_total{${sel}}[5m])) / sum(rate(${e.m}_statement_calls_total{${sel}}[5m]))`,
    end - 6 * 3600,
    end,
    300,
  );
  const pts = (r[0]?.points ?? []).filter((p): p is [number, number] => p[1] !== null);
  let since: number | null = null;
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i]![1] <= 2 * usual) break;
    since = pts[i]![0];
  }
  return since;
}

export interface SentBy {
  addr: string;
  share: number;
  sightings: number;
}
/**
 * Who sends each statement (1 h): the client holding at least 70% of the sightings, with at
 * least 10 of them; otherwise nobody clearly does and the page says nothing.
 */
export async function sentBy(ctx: PageContext, e: Engine): Promise<Map<string, SentBy>> {
  const r = await instant(
    ctx,
    `sum by (${e.stmt}, addr) (sum_over_time(${e.m}_statement_client_sessions{${one(ctx.row.id)}}[1h]))`,
  );
  const per = new Map<string, { addr: string; n: number }[]>();
  for (const x of r) {
    const id = x.labels[e.stmt] ?? '';
    const list = per.get(id) ?? [];
    list.push({ addr: x.labels.addr ?? '', n: num(x) ?? 0 });
    per.set(id, list);
  }
  const out = new Map<string, SentBy>();
  for (const [id, list] of per) {
    const total = list.reduce((a, b) => a + b.n, 0);
    const top = list.sort((a, b) => b.n - a.n)[0];
    if (top && total >= 10 && top.n / total >= 0.7)
      out.set(id, { addr: top.addr, share: top.n / total, sightings: total });
  }
  return out;
}

/** Every client of a statement (1 h), largest share first: the statement page's list. */
export async function clientsOfStatement(ctx: PageContext, e: Engine, id: string) {
  const r = await instant(
    ctx,
    `sum by (addr) (sum_over_time(${e.m}_statement_client_sessions{${one(ctx.row.id)}, ${e.stmt}="${escapeLabelValue(id)}"}[1h]))`,
  );
  const total = r.reduce((a, x) => a + (num(x) ?? 0), 0);
  return r
    .map((x) => ({ addr: x.labels.addr ?? '', share: total > 0 ? (num(x) ?? 0) / total : 0 }))
    .sort((a, b) => b.share - a.share);
}

/** Tables a statement names (FROM, JOIN, UPDATE, INTO), as they are written in it. */
export function tablesIn(text: string): string[] {
  const out: string[] = [];
  const re = /\b(?:from|join|update|into)\s+((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)/gi;
  for (const m of text.matchAll(re)) {
    const t = m[1]!.replace(/[`"]/g, '');
    if (!/^(select|lateral|unnest|generate_series)$/i.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Statement facts from the collector's status (the top 50 by total time). */
export interface StatementFact {
  id: string;
  text: string;
  /** MySQL: rows examined and sent, calls that used no index. PostgreSQL: blocks, rows. */
  examined?: number;
  sent?: number;
  noIndex?: number;
  blocks?: number;
  rows?: number;
  calls?: number;
}
export function statementFacts(ctx: PageContext, e: Engine): Map<string, StatementFact> {
  const extra = (ctx.row.status_details as { extra?: { statements?: Record<string, unknown>[] } })
    .extra;
  const out = new Map<string, StatementFact>();
  for (const s of extra?.statements ?? []) {
    const id = String(s[e.stmt] ?? '');
    if (!id) continue;
    out.set(id, {
      id,
      text: typeof s.query === 'string' && s.query ? s.query : `${e.stmt} ${id}`,
      ...(e.type === 'mysql'
        ? {
            examined: Number(s.rows_examined ?? 0),
            sent: Number(s.rows_sent ?? 0),
            noIndex: Number(s.no_index ?? 0),
          }
        : { blocks: Number(s.blocks ?? 0), rows: Number(s.rows ?? 0) }),
      calls: Number(s.calls ?? 0),
    });
  }
  return out;
}

/**
 * "Probably missing an index": a statement that reads far more than it returns. A hint, never
 * a certainty: MySQL says it used no index and examined 100 rows or more for each one sent;
 * PostgreSQL read 100 blocks or more for each row it returned, and one of its tables is read
 * mostly by sequential scans. The table named is the one of the statement's tables with the
 * most full-scan reads, else its first.
 */
export function missingIndex(
  e: Engine,
  f: StatementFact | undefined,
  fullScans: Map<string, number>,
): { table: string } | null {
  if (!f) return null;
  const tables = tablesIn(f.text);
  const pick = () => {
    const known = tables
      .map((t) => {
        // Keys are lower case: MySQL's digest writes some names in capitals (FROM EVENTS).
        const k = t.toLowerCase();
        return { t: k, n: fullScans.get(k) ?? fullScans.get(k.split('.').pop()!) ?? 0 };
      })
      .sort((a, b) => b.n - a.n);
    return known[0] && known[0].n > 0 ? known[0].t : null;
  };
  if (e.type === 'mysql') {
    if (!f.noIndex || (f.examined ?? 0) < 100 * Math.max(f.sent ?? 0, 1)) return null;
    const t = pick() ?? tables[0];
    return t ? { table: t } : null;
  }
  if ((f.blocks ?? 0) < 100 * Math.max(f.rows ?? 0, 1)) return null;
  const t = pick();
  return t ? { table: t } : null;
}

const statementLink = (id: string, text: string): Link => ({
  kind: 'statement',
  id,
  name: text.length > 60 ? `${text.slice(0, 60)}…` : text,
});

/** The statements panel's rows, in the order given. */
export function statementRows(
  e: Engine,
  ids: string[],
  stats: Map<string, StatementStats>,
  facts: Map<string, StatementFact>,
  senders: Map<string, SentBy>,
  owners: Map<string, Owner>,
  fullScans: Map<string, number>,
  share?: Map<string, number>,
): StatementRow[] {
  return ids.map((id) => {
    const st = stats.get(id);
    const f = facts.get(id);
    const text = f?.text ?? `${e.stmt} ${id}`;
    const sb = senders.get(id);
    const idx = missingIndex(e, f, fullScans);
    const hint: Text | undefined = st?.slower
      ? { key: `${e.P}.hint.slower`, values: { x: Math.round(st.slower) } }
      : idx
        ? { key: `${e.P}.hint.index`, values: { table: idx.table } }
        : undefined;
    return {
      id,
      text,
      calls: st ? st.calls : null,
      mean: st?.mean ?? null,
      usual: st?.usual ?? null,
      rows: st && st.calls > 0 ? st.rows / st.calls : null,
      share: share ? (share.get(id) ?? null) : (st?.share ?? null),
      sentBy: sb ? { ...clientOf(owners, sb.addr), share: sb.share } : null,
      ...(hint ? { hint } : {}),
      ...(st?.slower
        ? { severity: 'warning' as Severity }
        : idx
          ? { severity: 'info' as Severity }
          : {}),
    };
  });
}

export { statementLink };

/** The statements by their active sessions over a period (the Waits tab's list). */
export async function statementsByWaits(
  ctx: PageContext,
  e: Engine,
  end: number,
  dur: number,
): Promise<{ id: string; sessions: number; wait: WaitClass | null }[]> {
  const r = await at(
    ctx,
    `sum by (${e.stmt}, wait) (avg_over_time(${e.m}_statement_active_sessions{${one(ctx.row.id)}}[${dur}s]))`,
    end,
  );
  const per = new Map<string, { sessions: number; top: [WaitClass | null, number] }>();
  for (const x of r) {
    const id = x.labels[e.stmt] ?? '';
    const v = num(x) ?? 0;
    const cur = per.get(id) ?? { sessions: 0, top: [null, 0] };
    cur.sessions += v;
    if (v > cur.top[1]) cur.top = [(x.labels.wait as WaitClass) ?? null, v];
    per.set(id, cur);
  }
  return [...per.entries()]
    .map(([id, v]) => ({ id, sessions: v.sessions, wait: v.top[0] }))
    .filter((x) => x.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions);
}

/** The clients by their active sessions over a period. */
export async function clientsByWaits(ctx: PageContext, e: Engine, end: number, dur: number) {
  const r = await at(
    ctx,
    `sum by (addr, wait) (avg_over_time(${e.m}_client_active_sessions{${one(ctx.row.id)}}[${dur}s]))`,
    end,
  );
  const per = new Map<string, { sessions: number; top: [WaitClass | null, number] }>();
  for (const x of r) {
    const a = x.labels.addr ?? '';
    const v = num(x) ?? 0;
    const cur = per.get(a) ?? { sessions: 0, top: [null, 0] };
    cur.sessions += v;
    if (v > cur.top[1]) cur.top = [(x.labels.wait as WaitClass) ?? null, v];
    per.set(a, cur);
  }
  return [...per.entries()]
    .map(([addr, v]) => ({ addr, sessions: v.sessions, wait: v.top[0] }))
    .filter((x) => x.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions);
}

// ------------------------------------------------------------------------- the tree

export interface TreeSession {
  id: string;
  blockedBy: string[];
  addr: string;
  app: string;
  state: string;
  wait: string;
  seconds: number;
  xact: number | null;
  query: string | null;
}
/** The collector's lock_tree rows, whichever engine sent them. */
export function treeSessions(ctx: PageContext): TreeSession[] {
  const extra = (ctx.row.status_details as { extra?: { lock_tree?: Record<string, unknown>[] } })
    .extra;
  return (extra?.lock_tree ?? []).map((r) => ({
    id: String(r.pid ?? r.thread ?? ''),
    blockedBy: String(r.blocked_by ?? '')
      .split(',')
      .filter(Boolean),
    addr: String(r.addr ?? ''),
    app: String(r.app ?? r.user ?? ''),
    state: String(r.state ?? r.command ?? ''),
    wait: String(r.wait ?? ''),
    seconds: Number(r.seconds ?? 0),
    xact: r.xact !== undefined ? Number(r.xact) : null,
    query: typeof r.query === 'string' && r.query ? r.query : null,
  }));
}

/**
 * Pre-order: each root blocker (blocks others, waits on nobody) first, then the sessions it
 * blocks, each indented under its blocker. A session blocked by two appears under the first.
 */
export function buildTree(sessions: TreeSession[]): { s: TreeSession; depth: number }[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const children = new Map<string, TreeSession[]>();
  for (const s of sessions) {
    const parent = s.blockedBy.find((b) => byId.has(b));
    if (parent) children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const roots = sessions
    .filter((s) => !s.blockedBy.some((b) => byId.has(b)) && children.has(s.id))
    .sort((a, b) => (children.get(b.id)?.length ?? 0) - (children.get(a.id)?.length ?? 0));
  const out: { s: TreeSession; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (s: TreeSession, depth: number) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push({ s, depth });
    for (const c of (children.get(s.id) ?? []).sort((a, b) => b.seconds - a.seconds))
      walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  // A cycle (a deadlock in the making) has no root: its sessions still show.
  for (const s of sessions) if (!seen.has(s.id) && s.blockedBy.length) walk(s, 0);
  return out;
}

export function treePanel(
  e: Engine,
  sessions: TreeSession[],
  owners: Map<string, Owner>,
): TreePanel {
  const nodes = buildTree(sessions).map(({ s, depth }) => {
    const c = clientOf(owners, s.addr, s.app);
    const idle = /idle|sleep/i.test(s.state);
    const waiting = s.blockedBy.length > 0;
    return {
      id: s.id,
      depth,
      name: c.name,
      ...(c.link ? { link: c.link } : {}),
      state: {
        key: waiting ? `${e.P}.tree.waits` : idle ? `${e.P}.tree.idleHolds` : `${e.P}.tree.holds`,
        values: { wait: s.wait || null },
      },
      seconds: s.seconds,
      xact: s.xact,
      query: s.query,
      ...(depth === 0 && s.seconds >= 60 ? { severity: 'critical' as Severity } : {}),
    };
  });
  return {
    id: 'tree',
    title: `${e.P}.tree.title`,
    kind: 'tree',
    span: 2,
    state: nodes.length ? 'ok' : 'empty',
    note: { key: `${e.P}.tree.note` },
    nodes,
  };
}

// ------------------------------------------------------------------------- transactions

export interface Txn {
  id: string;
  addr: string;
  app: string;
  idle: boolean;
  age: number;
  idleFor: number;
  blocks: number;
  holdsXmin: boolean | null;
  query: string | null;
}
export function transactionsOf(ctx: PageContext): Txn[] {
  const extra = (ctx.row.status_details as { extra?: { transactions?: Record<string, unknown>[] } })
    .extra;
  return (extra?.transactions ?? [])
    .map((r) => ({
      id: String(r.pid ?? r.thread ?? ''),
      addr: String(r.addr ?? ''),
      app: String(r.app ?? r.user ?? ''),
      idle: String(r.state ?? '').startsWith('idle'),
      age: Number(r.age ?? 0),
      idleFor: Number(r.idle ?? 0),
      blocks: Number(r.blocks ?? 0),
      holdsXmin: typeof r.holds_xmin === 'boolean' ? r.holds_xmin : null,
      query: typeof r.query === 'string' && r.query ? r.query : null,
    }))
    .sort((a, b) => b.age - a.age);
}

/** A transaction worth a finding: open 30 minutes, or idle and blocking someone. */
export const longTxn = (t: Txn) => t.age >= 1800 || (t.idle && t.blocks > 0 && t.idleFor >= 60);

// ------------------------------------------------------------------------- scoped alerts

/** The alerts scoped to this statement or table, and the ones the page can add. */
export async function scopedAlerts(
  ctx: PageContext,
  e: Engine,
  scope: { statement?: string; table?: string },
  presets: ScopedAlertsPanel['presets'],
): Promise<ScopedAlertsPanel> {
  const key = scope.statement ? 'statement' : 'table';
  const value = scope.statement ?? scope.table ?? '';
  const rules = await ctx.db
    .selectFrom('alert_rules')
    .select(['id', 'name', 'enabled'])
    .where(sql<boolean>`scope->>'service' = ${ctx.row.id}`)
    .where(sql<boolean>`scope->>${key} = ${value}`)
    .orderBy('name')
    .execute();
  const firing = rules.length
    ? await ctx.db
        .selectFrom('alert_states')
        .select('rule_id')
        .where(
          'rule_id',
          'in',
          rules.map((r) => r.id),
        )
        .where('state', '=', 'firing')
        .execute()
    : [];
  const on = new Set(firing.map((f) => f.rule_id));
  return {
    id: 'alerts',
    title: `${e.P}.alerts.${key}`,
    kind: 'scoped_alerts',
    span: 2,
    state: 'ok',
    scope,
    rules: rules.map((r) => ({
      id: r.id,
      name: r.name,
      state: !r.enabled ? 'off' : on.has(r.id) ? 'firing' : 'quiet',
    })),
    presets,
  };
}

/** One number of an instant query by label value. */
export const byLabel = (r: QuerySeries[], label: string) =>
  new Map(r.map((x) => [x.labels[label] ?? '', num(x) ?? 0]));

export { valueOf };

// ------------------------------------------------------------------------- the process

/**
 * The database process's own resources (1.2, item 10), from the agents, no credentials: its
 * container or pods on Kubernetes and Docker, its systemd service or process group on a
 * server. Null for a service known only by its address.
 */
export function processOf(ctx: PageContext): {
  cpu: string;
  cpuLimit: string | null;
  mem: string;
  memLimit: string | null;
  io: string | null;
} | null {
  const t = ctx.row.target;
  const q = (v: string) => escapeLabelValue(v);
  if (t.kind === 'workload') {
    const s = `namespace="${q(t.namespace)}", workload_kind="${q(t.workload_kind)}", workload="${q(t.workload)}"`;
    return {
      cpu: `sum(rate(watchlog_container_cpu_seconds_total{${s}}[$w]))`,
      cpuLimit: `sum(watchlog_container_cpu_limit_cores{${s}})`,
      mem: `sum(watchlog_container_memory_working_set_bytes{${s}})`,
      memLimit: `sum(watchlog_container_memory_limit_bytes{${s}})`,
      io: `sum by (dir) (rate(watchlog_container_fs_io_bytes_total{${s}}[$w]))`,
    };
  }
  if (t.kind === 'compose' || t.kind === 'container') {
    const s =
      t.kind === 'compose'
        ? `host="${q(t.host)}", compose_project="${q(t.compose_project)}", compose_service="${q(t.compose_service)}"`
        : `host="${q(t.host)}", container="${q(t.container)}"`;
    return {
      cpu: `sum(rate(watchlog_container_cpu_seconds_total{${s}}[$w]))`,
      cpuLimit: `sum(watchlog_container_cpu_limit_cores{${s}})`,
      mem: `sum(watchlog_container_memory_working_set_bytes{${s}})`,
      memLimit: `sum(watchlog_container_memory_limit_bytes{${s}})`,
      io: `sum by (dir) (rate(watchlog_container_fs_io_bytes_total{${s}}[$w]))`,
    };
  }
  if (t.kind === 'native') {
    if (t.source === 'service') {
      const s = `host="${q(t.host)}", unit="${q(t.workload)}"`;
      return {
        cpu: `sum(rate(watchlog_service_cpu_seconds_total{${s}}[$w]))`,
        cpuLimit: `sum(watchlog_service_cpu_limit_cores{${s}})`,
        mem: `sum(watchlog_service_memory_working_set_bytes{${s}})`,
        memLimit: `sum(watchlog_service_memory_limit_bytes{${s}})`,
        io: `sum by (dir) (rate(watchlog_service_io_bytes_total{${s}}[$w]))`,
      };
    }
    const s = `host="${q(t.host)}", group="${q(t.workload)}"`;
    return {
      cpu: `sum(rate(watchlog_process_group_cpu_seconds_total{${s}}[$w]))`,
      cpuLimit: null,
      mem: `sum(watchlog_process_group_memory_rss_bytes{${s}})`,
      memLimit: null,
      io: null,
    };
  }
  return null;
}

/** The memory the process may use: its limit, for the "max_connections far above memory" check. */
export async function memoryLimit(ctx: PageContext): Promise<number | null> {
  const p = processOf(ctx);
  if (!p?.memLimit) return null;
  const v = valueOf(await instant(ctx, p.memLimit));
  return v && v > 0 && v < 2 ** 50 ? v : null;
}

/**
 * CPU, memory, disk I/O and I/O latency of the database process (item 10). I/O latency is the
 * database's own view (PostgreSQL's timed block reads and writes, with track_io_timing;
 * MySQL's data and redo files): the agent sees the process's bytes, not its waits.
 */
export async function resourcePanels(ctx: PageContext, e: Engine): Promise<Panel[]> {
  const p = processOf(ctx);
  const w = rateWindow(ctx);
  const s = one(ctx.row.id);
  // Seconds per operation: PostgreSQL's timed reads per block read, timed writes per buffer
  // written; MySQL's time per read and per write on the data files.
  const latency =
    e.type === 'postgres'
      ? `label_replace(sum(rate(watchlog_postgres_io_time_seconds_total{${s}, op="read"}[${w}])) / sum(rate(watchlog_postgres_blks_read_total{${s}}[${w}])), "op", "read", "", "") or label_replace(sum(rate(watchlog_postgres_io_time_seconds_total{${s}, op="write"}[${w}])) / sum(rate(watchlog_postgres_buffers_written_total{${s}}[${w}])), "op", "write", "", "")`
      : `sum by (op) (rate(watchlog_mysql_file_io_seconds_total{${s}, file="data"}[${w}])) / sum by (op) (rate(watchlog_mysql_file_io_total{${s}, file="data"}[${w}]))`;
  const [cpu, cpuLimit, mem, memLimit, io, lat] = await Promise.all([
    p ? range(ctx, p.cpu.replaceAll('$w', w)) : Promise.resolve([]),
    p?.cpuLimit ? range(ctx, p.cpuLimit) : Promise.resolve([]),
    p ? range(ctx, p.mem) : Promise.resolve([]),
    p?.memLimit ? range(ctx, p.memLimit) : Promise.resolve([]),
    p?.io ? range(ctx, p.io.replaceAll('$w', w)) : Promise.resolve([]),
    range(ctx, latency),
  ]);
  const noProcess = p ? undefined : { key: `${e.P}.process.byAddress` };
  const limitLine = (r: QuerySeries[], key: string) =>
    r[0] && (r[0].points.at(-1)?.[1] ?? 0) > 0 && (r[0].points.at(-1)?.[1] ?? 0) < 2 ** 50
      ? [{ nameKey: key, points: pointsOf(r[0]), dashed: true }]
      : [];
  return [
    {
      id: 'cpu',
      title: `${e.P}.process.cpu`,
      kind: 'line',
      span: 1,
      unit: 'cores',
      state: cpu.length ? 'ok' : 'empty',
      ...(noProcess ? { note: noProcess } : {}),
      series: [
        { nameKey: `${e.P}.process.used`, points: pointsOf(cpu[0]) },
        ...limitLine(cpuLimit, `${e.P}.process.limit`),
      ],
    },
    {
      id: 'memory',
      title: `${e.P}.process.memory`,
      kind: 'line',
      span: 1,
      unit: 'bytes',
      state: mem.length ? 'ok' : 'empty',
      ...(noProcess ? { note: noProcess } : {}),
      series: [
        { nameKey: `${e.P}.process.used`, points: pointsOf(mem[0]) },
        ...limitLine(memLimit, `${e.P}.process.limit`),
      ],
    },
    {
      id: 'disk',
      title: `${e.P}.process.disk`,
      kind: 'line',
      span: 1,
      unit: 'bytes_per_second',
      state: io.length ? 'ok' : 'empty',
      ...(p && !p.io
        ? { note: { key: `${e.P}.process.noIo` } }
        : noProcess
          ? { note: noProcess }
          : {}),
      series: io.map((x) => ({
        nameKey: `${e.P}.process.${x.labels.dir ?? 'read'}`,
        points: pointsOf(x),
      })),
    },
    {
      id: 'latency',
      title: `${e.P}.process.latency`,
      kind: 'line',
      span: 1,
      unit: 'seconds',
      state: lat.length ? 'ok' : 'empty',
      note: { key: `${e.P}.process.latencyNote.${e.type}` },
      series: lat.map((x) => ({
        nameKey: `${e.P}.process.${x.labels.op ?? 'read'}`,
        points: pointsOf(x),
      })),
    },
  ];
}

// ------------------------------------------------------------------------- capacity

/**
 * Capacity (1.2, item 9): the data volume and the connections against their limits, each
 * with the days left at its last 7 days' growth (once a day of history exists).
 */
export async function capacityPanel(
  ctx: PageContext,
  e: Engine,
  volume: { used: number; capacity: number; perDay: number | null; name: string } | null,
): Promise<Panel> {
  const s = one(ctx.row.id);
  const conns =
    e.type === 'postgres'
      ? `(sum(watchlog_postgres_backends{${s}, db=""}) or 0 * max(watchlog_postgres_setting{${s}, name="max_connections"}))`
      : `sum(watchlog_mysql_threads_connected{${s}})`;
  const [c, m, growth] = await Promise.all([
    instant(ctx, conns),
    instant(ctx, `max(${e.m}_setting{${s}, name="max_connections"})`),
    instant(
      ctx,
      `(deriv((${conns})[7d:1h]) and last_over_time((${conns})[1h:5m] offset 1d)) * 86400`,
    ),
  ]);
  const cv = valueOf(c);
  const mv = valueOf(m);
  const g = valueOf(growth);
  const connDays = cv !== null && mv && g && g > 0 ? Math.floor((mv - cv) / g) : null;
  const volDays =
    volume && volume.perDay && volume.perDay > 0
      ? Math.floor((volume.capacity - volume.used) / volume.perDay)
      : null;
  return {
    id: 'capacity',
    title: `${e.P}.capacity.title`,
    kind: 'gauge',
    span: 2,
    state: mv || volume ? 'ok' : 'empty',
    note: volume ? undefined : { key: `${e.P}.capacity.noVolume` },
    items: [
      ...(volume
        ? [
            {
              label: volume.name,
              value: volume.used,
              max: volume.capacity,
              unit: 'bytes' as const,
              warnAt: 0.85,
              note:
                volDays !== null
                  ? { key: `${e.P}.capacity.daysLeft`, values: { days: volDays } }
                  : volume.perDay === null
                    ? { key: `${e.P}.capacity.growthUnknown` }
                    : { key: `${e.P}.capacity.notGrowing` },
            },
          ]
        : []),
      ...(mv
        ? [
            {
              labelKey: `${e.P}.capacity.connections`,
              value: cv ?? 0,
              max: mv,
              unit: 'count' as const,
              warnAt: 0.9,
              note:
                connDays !== null
                  ? { key: `${e.P}.capacity.daysLeft`, values: { days: connDays } }
                  : { key: `${e.P}.capacity.notGrowing` },
            },
          ]
        : []),
    ],
  };
}
