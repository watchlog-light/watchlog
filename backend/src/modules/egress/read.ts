// SPDX-License-Identifier: AGPL-3.0-only
// The Egress page's read (ADR-188, ADR-189): the inventory's rows of one cluster or fleet,
// grouped per destination and port with the sources that talk to it, and the traffic of the
// range from the flow series (bytes each way, connections, the failed share). First and last
// seen come from the inventory (ADR-185); the numbers follow the metrics retention. Time comes
// from the caller (an injectable clock), so "New" (24 hours) is tested without waiting.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import type { ClusterScope, QuerySeries, VictoriaQueryClient } from '../../lib/victoria.js';
import { escapeLabelValue } from '../query/catalog.js';
import { bestExpectation, loadExpectations } from './expected.js';
import { egressLearningMs, learningStart } from './learning.js';
import {
  sourceOf,
  type ClusterKind,
  type DestinationClass,
  type SourceIdentity,
} from './inventory.js';

/** "New": first seen from its source in the last 24 hours (ADR-188). */
export const EGRESS_NEW_MS = 24 * 3_600_000;
/**
 * The classes that can be "New" (ADR-188's slice 4 note): the ones that raise "New external
 * destination". Private networks and local names are listed but never New, as the alert
 * skips them (ADR-185, ADR-187 slice 1 notes); "Internet" names nothing. The session lead's
 * reversible default for the owner: add 'local_name' and 'private_network' here to undo it.
 */
export const EGRESS_NEW_CLASSES: ReadonlySet<string> = new Set(['name', 'public_network']);
/** At most this many rows; `truncated` and `total` say how many matched (ADR-189). */
export const EGRESS_MAX_ROWS = 500;
/** The longest range the page offers (ADR-188). */
export const EGRESS_MAX_RANGE_S = 30 * 86_400;
/** "Failing": at least 5 % of the range's connections failed (ADR-106's threshold)... */
export const EGRESS_FAILING_RATIO = 0.05;
/** ...out of at least 3 connections, so one refused connection isn't "failing". */
export const EGRESS_FAILING_MIN_CONNECTIONS = 3;

const DAY_MS = 86_400_000;
const EXTERNAL = 'dst_kind=~"external|internet"';
const SOURCE_LABELS = {
  kubernetes: 'namespace, workload_kind, workload',
  server: 'host, container, compose_project, compose_service',
} as const;

export type EgressBadge = 'new' | 'raw_ip' | 'failing' | 'expected';
export const EGRESS_BADGES = ['new', 'raw_ip', 'failing', 'expected', 'not_expected'] as const;
export type EgressBadgeFilter = (typeof EGRESS_BADGES)[number];

export interface EgressFilters {
  namespace?: string;
  kind?: string;
  workload?: string;
  host?: string;
  project?: string;
  service?: string;
  container?: string;
  badge?: EgressBadgeFilter;
  q?: string;
  /** Unix seconds: only edges first seen at or after it, not "before" (the MCP tool's "new"). */
  firstSeenAfter?: number;
}

/** A source in its platform's vocabulary (ADR-124). */
export interface EgressSource {
  namespace?: string;
  workloadKind?: string;
  workload?: string;
  composeProject?: string;
  composeService?: string;
  host?: string;
  container?: string;
  firstSeen: string;
  lastSeen: string;
  new: boolean;
}

export interface EgressRow {
  destination: string;
  port: number;
  kind: 'name' | 'network' | 'internet';
  class: DestinationClass;
  private: boolean;
  sources: EgressSource[];
  firstSeen: string;
  firstSeenBefore: boolean;
  lastSeen: string;
  sent: number | null;
  received: number | null;
  connections: number | null;
  failed: number | null;
  failedRatio: number | null;
  badges: EgressBadge[];
  expected: {
    pattern: string;
    at: string | null;
    /** Who marked it (their name), when they are still a user. */
    by: string | null;
    /** The expectations that cover this row's sources: removing them all is "Undo". */
    ids: string[];
  } | null;
  alertId: string | null;
}

export interface EgressAnswer {
  cluster: { id: string; kind: ClusterKind };
  range: { from: string; to: string };
  learning: {
    since: string;
    until: string;
    learning: boolean;
    days: number;
    firstSeenPending: boolean;
  };
  traffic: boolean;
  summary: { destinations: number; sources: number; new: number; rawIp: number; failing: number };
  rows: EgressRow[];
  total: number;
  truncated: boolean;
}

export interface EgressCluster {
  id: string;
  kind: ClusterKind;
  scope: ClusterScope;
  egress_learning_since: Date | null;
  /** When the first-seen look-back ran (ADR-185); null until it has. */
  egress_backfilled_at: Date | null;
  first_seen_at: Date | null;
  created_at: Date;
}

interface InventoryRow {
  source: SourceIdentity;
  destination: string;
  dst_kind: string;
  port: number;
  destination_class: string;
  first_seen: Date;
  first_seen_before: boolean;
  last_seen: Date;
  pattern: string | null;
  approved_at: Date | null;
  approved_by: string | null;
}

/** A source's key whatever its key order (jsonb reorders keys: shorter ones first). */
const sourceKey = (s: SourceIdentity) =>
  JSON.stringify(
    Object.keys(s)
      .sort()
      .map((k) => [k, s[k]]),
  );
const groupKey = (destination: string, port: number) => `${destination}\u0000${port}`;
const edgeKey = (s: SourceIdentity, destination: string, port: number) =>
  `${sourceKey(s)}\u0000${destination}\u0000${port}`;

/** The source as the API shows it, in the cluster's vocabulary. */
export function sourceView(
  s: SourceIdentity,
): Omit<EgressSource, 'firstSeen' | 'lastSeen' | 'new'> {
  if (s.namespace !== undefined) {
    return { namespace: s.namespace, workloadKind: s.workload_kind, workload: s.workload };
  }
  if (s.compose_project !== undefined) {
    return { composeProject: s.compose_project, composeService: s.compose_service };
  }
  return { host: s.host, container: s.container };
}

/** A source's words for the search: its namespace and workload, project and service, … */
const sourceWords = (s: SourceIdentity) => Object.values(s).join(' ').toLowerCase();

/** Does an inventory source pass the page's source filters? (`host` is handled apart.) */
export function sourceMatches(kind: ClusterKind, s: SourceIdentity, f: EgressFilters): boolean {
  if (kind === 'kubernetes') {
    if (f.namespace && s.namespace !== f.namespace) return false;
    if (f.kind && s.workload_kind !== f.kind) return false;
    if (f.workload && s.workload !== f.workload) return false;
    return true;
  }
  if (f.project && s.compose_project !== f.project) return false;
  if (f.service && s.compose_service !== f.service) return false;
  // A Compose container's rows are its service's (ADR-188): with project and service the
  // container only narrows the traffic.
  if (f.container && !(f.project && f.service) && s.container !== f.container) return false;
  return true;
}

/** Label matchers that narrow the flow series to the filters (values escaped). */
function seriesMatchers(kind: ClusterKind, f: EgressFilters): string {
  const m: string[] = [EXTERNAL];
  const eq = (label: string, v: string | undefined) => {
    if (v) m.push(`${label}="${escapeLabelValue(v)}"`);
  };
  if (kind === 'kubernetes') {
    eq('namespace', f.namespace);
    eq('workload_kind', f.kind);
    eq('workload', f.workload);
  } else {
    eq('host', f.host);
    eq('container', f.container);
    eq('compose_project', f.project);
    eq('compose_service', f.service);
  }
  return m.join(', ');
}

/** The range's three queries: connections, failed connects, bytes by direction. */
export function trafficQueries(kind: ClusterKind, f: EgressFilters, rangeS: number) {
  const sel = seriesMatchers(kind, f);
  const by = `${SOURCE_LABELS[kind]}, dst_kind, dst, dst_port`;
  const w = `[${Math.max(60, Math.round(rangeS))}s]`;
  return {
    connections: `sum by (${by}) (increase(watchlog_flow_connections_total{${sel}}${w}))`,
    failed: `sum by (${by}) (increase(watchlog_flow_connect_failed_total{${sel}}${w}))`,
    bytes: `sum by (${by}, dir) (increase(watchlog_flow_bytes_total{${sel}}${w}))`,
  };
}

interface Traffic {
  sent: number;
  received: number;
  connections: number;
  failed: number;
}

/** Sums the series per inventory edge (Docker folds into the Compose service). */
function trafficByEdge(
  kind: ClusterKind,
  r: { connections: QuerySeries[]; failed: QuerySeries[]; bytes: QuerySeries[] },
) {
  const out = new Map<string, Traffic>();
  /** Compose sources seen on each host in the range (a Compose identity has no host). */
  const hostsOf = new Map<string, Set<string>>();
  const add = (
    series: QuerySeries[],
    field: (l: Record<string, string>) => keyof Traffic | null,
  ) => {
    for (const s of series) {
      const v = s.points[0]?.[1];
      if (v === null || v === undefined || !(v > 0)) continue;
      const l = s.labels;
      const source = sourceOf(kind, l);
      const f = field(l);
      if (!source || !f || !l.dst) continue;
      const internet = l.dst_kind === 'internet';
      const k = edgeKey(
        source,
        internet ? 'Internet' : l.dst,
        internet ? 0 : Number(l.dst_port ?? 0),
      );
      const t = out.get(k) ?? { sent: 0, received: 0, connections: 0, failed: 0 };
      t[f] += v;
      out.set(k, t);
      if (kind === 'server' && l.host) {
        const sk = sourceKey(source);
        if (!hostsOf.has(sk)) hostsOf.set(sk, new Set());
        hostsOf.get(sk)!.add(l.host);
      }
    }
  };
  add(r.connections, () => 'connections');
  add(r.failed, () => 'failed');
  add(r.bytes, (l) => (l.dir === 'sent' ? 'sent' : l.dir === 'received' ? 'received' : null));
  return { byEdge: out, hostsOf };
}

const kindOf = (cls: string): EgressRow['kind'] =>
  cls === 'internet'
    ? 'internet'
    : cls === 'public_network' || cls === 'private_network'
      ? 'network'
      : 'name';

/**
 * The learning state (ADR-187): from the upgrade for existing clusters, else first report.
 * `firstSeenPending` until the first-seen look-back has run for the cluster (ADR-185; up to
 * the worker's look-back interval after an upgrade or a first report): until then a
 * destination in use before the upgrade looks first seen at the upgrade, so nothing is New.
 */
export function learningOf(c: EgressCluster, oldestFirstSeen: Date | null, nowMs: number) {
  const since = learningStart(c);
  const until = new Date(since.getTime() + egressLearningMs());
  const from = Math.min(since.getTime(), oldestFirstSeen?.getTime() ?? Infinity);
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    learning: nowMs < until.getTime(),
    days: Math.max(0, Math.floor((nowMs - from) / DAY_MS)),
    firstSeenPending: !c.egress_backfilled_at,
  };
}

const ORDER: EgressBadge[] = ['new', 'raw_ip', 'failing'];
const rank = (r: EgressRow) => {
  const i = ORDER.findIndex((b) => r.badges.includes(b));
  return i < 0 ? ORDER.length : i;
};

/**
 * The page's answer. Rows are destinations used in the range (last seen at or after `from`),
 * one per destination and port, with every source that used it. A source is "new" when its
 * row was first seen in the last 24 hours (and not only "before" the oldest retained sample);
 * a destination is New when one of its sources is. "Internet" (beyond the agent's cap) names
 * nothing, so it is never New (ADR-185). Nothing is New until the cluster's first-seen
 * look-back has run (`egress_backfilled_at`), as the alert rules wait for it: before that, a
 * destination in use before the upgrade looks first seen at the upgrade.
 */
export async function readEgress(
  db: Database,
  victoria: Pick<VictoriaQueryClient, 'query'> | null,
  orgId: string,
  cluster: EgressCluster,
  f: EgressFilters,
  range: { fromMs: number; toMs: number },
  nowMs: number,
): Promise<EgressAnswer> {
  const kind = cluster.kind;
  let q = db
    .selectFrom('egress_destinations')
    .select([
      'source',
      'destination',
      'dst_kind',
      'port',
      'destination_class',
      'first_seen',
      'first_seen_before',
      'last_seen',
      'pattern',
      'approved_at',
      'approved_by',
    ])
    .where('org_id', '=', orgId)
    .where('cluster_id', '=', cluster.id)
    .where('last_seen', '>=', new Date(range.fromMs))
    .where('first_seen', '<=', new Date(range.toMs));
  // The jsonb identity's labels narrow the read in SQL; the rest is checked below.
  const label = (k: string, v: string | undefined) => {
    if (v) q = q.where(sql<string>`source->>${k}`, '=', v);
  };
  if (kind === 'kubernetes') {
    label('namespace', f.namespace);
    label('workload_kind', f.kind);
    label('workload', f.workload);
  } else {
    label('compose_project', f.project);
    label('compose_service', f.service);
  }
  if (f.firstSeenAfter !== undefined) {
    q = q
      .where('first_seen', '>=', new Date(f.firstSeenAfter * 1000))
      .where('first_seen_before', '=', false);
  }
  const [rows, oldest, expectations] = await Promise.all([
    q.execute() as Promise<InventoryRow[]>,
    db
      .selectFrom('egress_sources')
      .select((eb) => eb.fn.min('first_seen').as('first'))
      .where('org_id', '=', orgId)
      .where('cluster_id', '=', cluster.id)
      .executeTakeFirst(),
    loadExpectations(db, orgId, cluster.id),
  ]);
  // Who marked the rows' expectations, by name (the copy keeps the user's id).
  const markers = [...new Set(rows.map((r) => r.approved_by).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (markers.length) {
    for (const u of await db
      .selectFrom('users')
      .select(['id', 'name', 'email'])
      .where('id', 'in', markers)
      .execute())
      names.set(u.id, u.name || u.email);
  }

  let traffic: ReturnType<typeof trafficByEdge> | null = null;
  if (victoria) {
    const qs = trafficQueries(kind, f, (range.toMs - range.fromMs) / 1000);
    const at = range.toMs / 1000;
    const [connections, failed, bytes] = await Promise.all([
      victoria.query(cluster.scope, qs.connections, at),
      victoria.query(cluster.scope, qs.failed, at),
      victoria.query(cluster.scope, qs.bytes, at),
    ]);
    traffic = trafficByEdge(kind, { connections, failed, bytes });
  }
  const groups = new Map<string, InventoryRow[]>();
  for (const r of rows) {
    const s = (typeof r.source === 'string' ? JSON.parse(r.source) : r.source) as SourceIdentity;
    r.source = s;
    if (!sourceMatches(kind, s, f)) continue;
    if (kind === 'server' && f.host && !(f.project && f.service)) {
      // A plain container names its host; a Compose service is on the hosts its series came from.
      const onHost =
        s.host !== undefined
          ? s.host === f.host
          : !!traffic?.hostsOf.get(sourceKey(s))?.has(f.host);
      if (!onHost) continue;
    }
    const k = groupKey(r.destination, r.port);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  // The open egress alerts (ADR-187), for each row's "View alert": the newest that fired for
  // this destination and port, from any of its sources.
  const firingAlerts = await db
    .selectFrom('alert_states as s')
    .innerJoin('alert_rules as r', 'r.id', 's.rule_id')
    .select([
      's.id',
      sql<string>`s.labels->>'destination'`.as('destination'),
      sql<string>`s.labels->>'port'`.as('port'),
    ])
    .where('s.org_id', '=', orgId)
    .where('s.cluster_id', '=', cluster.id)
    .where('s.state', '=', 'firing')
    .where('r.rule_key', 'like', 'egress.%')
    .orderBy('s.fired_at', 'asc')
    .execute();
  const alertOf = new Map(firingAlerts.map((a) => [groupKey(a.destination, Number(a.port)), a.id]));

  const lookedBack = !!cluster.egress_backfilled_at;
  const all: EgressRow[] = [];
  for (const members of groups.values()) {
    const head = members[0]!;
    const cls = head.destination_class as DestinationClass;
    const t: Traffic | null = traffic ? { sent: 0, received: 0, connections: 0, failed: 0 } : null;
    const sources: EgressSource[] = [];
    let first = head.first_seen;
    let last = head.last_seen;
    for (const m of members) {
      const isNew =
        lookedBack &&
        EGRESS_NEW_CLASSES.has(cls) &&
        !m.first_seen_before &&
        nowMs - m.first_seen.getTime() < EGRESS_NEW_MS;
      sources.push({
        ...sourceView(m.source),
        firstSeen: m.first_seen.toISOString(),
        lastSeen: m.last_seen.toISOString(),
        new: isNew,
      });
      if (m.first_seen < first) first = m.first_seen;
      if (m.last_seen > last) last = m.last_seen;
      const e = traffic?.byEdge.get(edgeKey(m.source, m.destination, m.port));
      if (t && e) {
        t.sent += e.sent;
        t.received += e.received;
        t.connections += e.connections;
        t.failed += e.failed;
      }
    }
    const before = members.some(
      (m) => m.first_seen_before && m.first_seen.getTime() === first.getTime(),
    );
    const connections = t ? Math.round(t.connections) : null;
    const failed = t ? Math.round(t.failed) : null;
    const failedRatio = connections && failed !== null ? Math.min(1, failed / connections) : null;
    const badges: EgressBadge[] = [];
    if (sources.some((s) => s.new)) badges.push('new');
    if (cls === 'public_network') badges.push('raw_ip');
    if (
      connections !== null &&
      connections >= EGRESS_FAILING_MIN_CONNECTIONS &&
      (failedRatio ?? 0) >= EGRESS_FAILING_RATIO
    )
      badges.push('failing');
    // Expected once every source's row is covered (ADR-186: the copy the matcher keeps).
    const covered = members.every((m) => m.pattern);
    if (covered) badges.push('expected');
    const ids = covered
      ? [
          ...new Set(
            members
              .map((m) => bestExpectation(expectations, m)?.id)
              .filter((x): x is string => !!x),
          ),
        ]
      : [];
    sources.sort((a, b) => Number(b.new) - Number(a.new) || b.lastSeen.localeCompare(a.lastSeen));
    all.push({
      destination: head.destination,
      port: head.port,
      kind: kindOf(cls),
      class: cls,
      private: cls === 'private_network',
      sources,
      firstSeen: first.toISOString(),
      firstSeenBefore: before,
      lastSeen: last.toISOString(),
      sent: t ? Math.round(t.sent) : null,
      received: t ? Math.round(t.received) : null,
      connections,
      failed,
      failedRatio,
      badges,
      expected: covered
        ? {
            pattern: head.pattern!,
            at: head.approved_at ? head.approved_at.toISOString() : null,
            by: head.approved_by ? (names.get(head.approved_by) ?? null) : null,
            ids,
          }
        : null,
      alertId: alertOf.get(groupKey(head.destination, head.port)) ?? null,
    });
  }

  // The header counts the source filters' rows, before the badge and the search.
  const distinctSources = new Set<string>();
  for (const r of all)
    for (const s of r.sources) distinctSources.add(JSON.stringify(s, sourceFields));
  const summary = {
    destinations: all.length,
    sources: distinctSources.size,
    new: all.filter((r) => r.badges.includes('new')).length,
    rawIp: all.filter((r) => r.badges.includes('raw_ip')).length,
    failing: all.filter((r) => r.badges.includes('failing')).length,
  };

  const term = f.q?.trim().toLowerCase();
  const shown = all.filter((r) => {
    if (
      f.badge === 'not_expected'
        ? r.badges.includes('expected')
        : f.badge && !r.badges.includes(f.badge)
    )
      return false;
    if (!term) return true;
    return (
      r.destination.toLowerCase().includes(term) ||
      members(groups, r).some((m) => sourceWords(m.source).includes(term))
    );
  });
  shown.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.lastSeen.localeCompare(a.lastSeen) ||
      a.destination.localeCompare(b.destination) ||
      a.port - b.port,
  );

  return {
    cluster: { id: cluster.id, kind },
    range: { from: new Date(range.fromMs).toISOString(), to: new Date(range.toMs).toISOString() },
    learning: learningOf(cluster, oldest?.first ? new Date(oldest.first as Date) : null, nowMs),
    traffic: !!traffic,
    summary,
    rows: shown.slice(0, EGRESS_MAX_ROWS),
    total: shown.length,
    truncated: shown.length > EGRESS_MAX_ROWS,
  };
}

const sourceFields = [
  'namespace',
  'workloadKind',
  'workload',
  'composeProject',
  'composeService',
  'host',
  'container',
];
const members = (groups: Map<string, InventoryRow[]>, r: EgressRow) =>
  groups.get(groupKey(r.destination, r.port)) ?? [];
