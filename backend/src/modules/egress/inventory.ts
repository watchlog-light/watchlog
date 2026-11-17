// SPDX-License-Identifier: AGPL-3.0-only
// Egress watch's inventory (ADR-185), three jobs in the alert worker:
//   - every minute, per cluster: the sources' external destinations used in the last
//     2 minutes (connections or bytes above 0) become rows, or move their `last_seen`;
//   - once per cluster, off the minute loop: first seen from the retained flow series, one
//     day per query, at most 30 days back (slice 1's measurements);
//   - daily: rows and sources last seen more than 90 days ago are forgotten.
// Each org's work runs inside withOrg (Cloud: watchlog_app under RLS, ADR-174, ADR-192), and
// the metrics through clusterForOrg's scope. Every upsert is idempotent, so a second worker
// or a repeated minute changes nothing. Time comes from the caller (an injectable clock).
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { withOrg } from '../../db/org-context.js';
import type { ClusterScope, QuerySeries, VictoriaQueryClient } from '../../lib/victoria.js';
import { clusterForOrg, listClusters } from '../clusters/service.js';
import { bestExpectation, copyOf, loadExpectations } from './expected.js';

export const EGRESS_MINUTE_EVERY_MS = 60_000;
export const EGRESS_BACKFILL_EVERY_MS = 5 * 60_000;
export const EGRESS_FORGET_EVERY_MS = 24 * 3_600_000;
/** Rows and sources not used for this long are deleted (ADR-185). */
export const EGRESS_FORGET_AFTER_DAYS = 90;
/** The first-seen look-back reads at most this far back, one day per query (ADR-185). */
export const EGRESS_LOOKBACK_DAYS = 30;
/** The minute query's window: two minutes every minute, so no minute is missed. */
export const EGRESS_WINDOW = '2m';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const EXTERNAL = 'dst_kind=~"external|internet"';
const CONNECTIONS = `watchlog_flow_connections_total{${EXTERNAL}}`;
const BYTES = `watchlog_flow_bytes_total{${EXTERNAL}}`;
const DEST = 'dst_kind, dst, dst_port';
/** The source labels each platform's flow series carry (slice 1: `node` is summed away). */
export const SOURCE_LABELS = {
  kubernetes: 'namespace, workload_kind, workload',
  server: 'host, container, compose_project, compose_service, workload_kind, workload',
} as const;
const UPSERT_CHUNK = 500;

export type ClusterKind = keyof typeof SOURCE_LABELS;
export type DestinationClass =
  'name' | 'local_name' | 'public_network' | 'private_network' | 'internet';

/** A source's identity labels, in a fixed key order (ADR-185). */
export type SourceIdentity = Record<string, string>;

export interface EgressLogger {
  warn(obj: object, msg: string): void;
}

export interface EgressDeps {
  /** The app connection; each org's work runs inside withOrg. */
  db: Database;
  victoria: Pick<VictoriaQueryClient, 'query'>;
  /** The orgs this worker looks after (the alert worker's buckets). */
  orgs: () => Promise<string[]>;
  log: EgressLogger;
}

export interface EgressReport {
  clusters: number;
  rows: number;
  errors: string[];
}

// ------------------------------------------------------------------------------ classes

/**
 * Private, shared, loopback and link-local ranges (ADR-185): raw networks in them are listed
 * but never "Raw IP", and don't raise "New external destination" (slice 1).
 */
const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addSubnet('fe80::', 10, 'ipv6');
PRIVATE.addSubnet('::', 96, 'ipv6');

/** What a flow series' destination is: a name, a local name, a raw network or "Internet". */
export function classifyDestination(dstKind: string, dst: string): DestinationClass {
  if (dstKind === 'internet') return 'internet';
  const slash = dst.lastIndexOf('/');
  const addr = slash > 0 ? dst.slice(0, slash) : dst;
  if (isIPv4(addr)) return PRIVATE.check(addr, 'ipv4') ? 'private_network' : 'public_network';
  if (isIPv6(addr)) return PRIVATE.check(addr, 'ipv6') ? 'private_network' : 'public_network';
  return dst.includes('.') ? 'name' : 'local_name';
}

/**
 * The source of a series in its platform's vocabulary, or null when the labels name none.
 * Servers: the Compose project and service when the container has them, else the container
 * on its server, else the service or process group on its server (ADR-212's sources).
 */
export function sourceOf(kind: ClusterKind, l: Record<string, string>): SourceIdentity | null {
  if (kind === 'kubernetes') {
    if (!l.namespace || !l.workload_kind || !l.workload) return null;
    return { namespace: l.namespace, workload_kind: l.workload_kind, workload: l.workload };
  }
  if (l.compose_project && l.compose_service) {
    return { compose_project: l.compose_project, compose_service: l.compose_service };
  }
  if (l.host && l.container) return { host: l.host, container: l.container };
  // A server's systemd service or process group (ADR-208): it names its server.
  if (
    l.host &&
    l.workload &&
    (l.workload_kind === 'Service' || l.workload_kind === 'ProcessGroup')
  ) {
    return { host: l.host, workload_kind: l.workload_kind, workload: l.workload };
  }
  return null;
}

/** One inventory row from a series' labels: "Internet" is port 0 (it has no `dst_port`). */
export function edgeOf(kind: ClusterKind, l: Record<string, string>) {
  const source = sourceOf(kind, l);
  if (!source || !l.dst || (l.dst_kind !== 'external' && l.dst_kind !== 'internet')) return null;
  const port = l.dst_kind === 'internet' ? 0 : Number(l.dst_port ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return {
    source,
    destination: l.dst_kind === 'internet' ? 'Internet' : l.dst,
    dst_kind: l.dst_kind,
    port,
    destination_class: classifyDestination(l.dst_kind, l.dst),
  };
}

type Edge = NonNullable<ReturnType<typeof edgeOf>>;
const sourceKey = (s: SourceIdentity) => JSON.stringify(s);
const edgeKey = (e: Edge) => `${sourceKey(e.source)}\u0000${e.destination}\u0000${e.port}`;

// ------------------------------------------------------------------------------ queries

/** The minute query: destinations with connections or bytes above 0 in the window. */
export function minuteQuery(kind: ClusterKind): string {
  const by = `${SOURCE_LABELS[kind]}, ${DEST}`;
  return (
    `(sum by (${by}) (increase(${CONNECTIONS}[${EGRESS_WINDOW}])) > 0) or ` +
    `(sum by (${by}) (increase(${BYTES}[${EGRESS_WINDOW}])) > 0)`
  );
}

/** The look-back's two queries for the day `daysAgo` days back (connections only). */
export function lookbackQueries(kind: ClusterKind, daysAgo: number) {
  const by = `${SOURCE_LABELS[kind]}, ${DEST}`;
  const window = `[1d]${daysAgo > 0 ? ` offset ${daysAgo}d` : ''}`;
  return {
    first: `min by (${by}) (tfirst_over_time(${CONNECTIONS}${window}))`,
    last: `max by (${by}) (tlast_change_over_time(${CONNECTIONS}${window}))`,
  };
}

// ------------------------------------------------------------------------------ writes

interface Upsert {
  edge: Edge;
  firstSeen: Date;
  lastSeen: Date;
  before?: boolean;
}

/**
 * Inserts rows or widens their first and last seen; sources the same. Idempotent. A new row
 * gets the copy of the expectation that covers it (ADR-186), so a pattern covers destinations
 * not seen when it was made; a row without one picks it up too. Changes to the expectations
 * themselves re-sync every row (expected.ts, syncExpected).
 */
async function upsert(db: Database, orgId: string, clusterId: string, rows: Upsert[]) {
  const expectations = await loadExpectations(db, orgId, clusterId);
  const sources = new Map<string, { source: SourceIdentity; first: Date; last: Date }>();
  for (const r of rows) {
    const k = sourceKey(r.edge.source);
    const s = sources.get(k);
    if (!s) sources.set(k, { source: r.edge.source, first: r.firstSeen, last: r.lastSeen });
    else {
      if (r.firstSeen < s.first) s.first = r.firstSeen;
      if (r.lastSeen > s.last) s.last = r.lastSeen;
    }
  }
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    await db
      .insertInto('egress_destinations')
      .values(
        rows.slice(i, i + UPSERT_CHUNK).map((r) => ({
          org_id: orgId,
          cluster_id: clusterId,
          source: JSON.stringify(r.edge.source),
          destination: r.edge.destination,
          dst_kind: r.edge.dst_kind,
          port: r.edge.port,
          destination_class: r.edge.destination_class,
          first_seen: r.firstSeen,
          first_seen_before: r.before ?? false,
          last_seen: r.lastSeen,
          ...copyOf(expectations.length ? bestExpectation(expectations, r.edge) : null),
        })),
      )
      .onConflict((oc) =>
        oc.constraint('egress_destinations_key').doUpdateSet({
          // An older first sample (the look-back) wins, with its "before" flag.
          first_seen_before: sql<boolean>`CASE WHEN excluded.first_seen < egress_destinations.first_seen THEN excluded.first_seen_before ELSE egress_destinations.first_seen_before END`,
          first_seen: sql<Date>`LEAST(egress_destinations.first_seen, excluded.first_seen)`,
          last_seen: sql<Date>`GREATEST(egress_destinations.last_seen, excluded.last_seen)`,
          // A row without an expectation's copy takes the one just matched; one with a copy
          // keeps it (only a change to the expectations moves it).
          approved_by: sql<
            string | null
          >`CASE WHEN egress_destinations.pattern IS NULL THEN excluded.approved_by ELSE egress_destinations.approved_by END`,
          approved_at: sql<Date | null>`CASE WHEN egress_destinations.pattern IS NULL THEN excluded.approved_at ELSE egress_destinations.approved_at END`,
          pattern: sql<string | null>`COALESCE(egress_destinations.pattern, excluded.pattern)`,
        }),
      )
      .execute();
  }
  const list = [...sources.values()];
  for (let i = 0; i < list.length; i += UPSERT_CHUNK) {
    await db
      .insertInto('egress_sources')
      .values(
        list.slice(i, i + UPSERT_CHUNK).map((s) => ({
          org_id: orgId,
          cluster_id: clusterId,
          source: JSON.stringify(s.source),
          first_seen: s.first,
          last_seen: s.last,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['cluster_id', 'source']).doUpdateSet({
          first_seen: sql<Date>`LEAST(egress_sources.first_seen, excluded.first_seen)`,
          last_seen: sql<Date>`GREATEST(egress_sources.last_seen, excluded.last_seen)`,
        }),
      )
      .execute();
  }
}

// ------------------------------------------------------------------------------ jobs

type ClusterRow = NonNullable<Awaited<ReturnType<typeof clusterForOrg>>>;

/** Runs `fn` for each cluster of each org, inside the org; one cluster's error is reported. */
async function eachCluster(
  deps: EgressDeps,
  job: string,
  fn: (orgId: string, cluster: ClusterRow & { kind: ClusterKind }) => Promise<number>,
): Promise<EgressReport> {
  const report: EgressReport = { clusters: 0, rows: 0, errors: [] };
  for (const orgId of await deps.orgs()) {
    await withOrg(orgId, async () => {
      for (const { id } of await listClusters(deps.db, orgId)) {
        const cluster = await clusterForOrg(deps.db, orgId, id);
        if (!cluster || !(cluster.kind in SOURCE_LABELS)) continue;
        try {
          report.rows += await fn(orgId, cluster as ClusterRow & { kind: ClusterKind });
          report.clusters++;
        } catch (err) {
          const msg = (err as Error).message;
          report.errors.push(`${id}: ${msg}`);
          deps.log.warn({ job, cluster: id, err: msg }, 'egress inventory failed for a cluster');
        }
      }
    });
  }
  return report;
}

/** Parses an instant query's rows into edges with their value, merged per edge. */
function edges(kind: ClusterKind, series: QuerySeries[], merge: (a: number, b: number) => number) {
  const out = new Map<string, { edge: Edge; value: number }>();
  for (const s of series) {
    const value = s.points[0]?.[1];
    if (value === null || value === undefined) continue;
    const edge = edgeOf(kind, s.labels);
    if (!edge) continue;
    const k = edgeKey(edge);
    const seen = out.get(k);
    out.set(k, { edge, value: seen ? merge(seen.value, value) : value });
  }
  return out;
}

/**
 * Every minute: destinations used in the last 2 minutes. `last_seen` moves only when the
 * increase of connections or bytes is above 0: an idle edge keeps sending its unchanged
 * counters for 10 minutes, so a sample's presence alone would be 10 minutes late (slice 1).
 */
export function runEgressMinute(deps: EgressDeps, nowMs: number): Promise<EgressReport> {
  const now = new Date(nowMs);
  return eachCluster(deps, 'minute', async (orgId, cluster) => {
    const series = await deps.victoria.query(
      cluster.scope,
      minuteQuery(cluster.kind),
      nowMs / 1000,
    );
    const used = edges(cluster.kind, series, (a, b) => a + b);
    const rows = [...used.values()]
      .filter((u) => u.value > 0)
      .map((u) => ({ edge: u.edge, firstSeen: now, lastSeen: now }));
    if (rows.length) await upsert(deps.db, orgId, cluster.id, rows);
    return rows.length;
  });
}

/**
 * Once per cluster: first seen from the flow series still retained, so destinations in use
 * before the upgrade aren't all "new" (ADR-185). Connections only, one day per query (a
 * single 30-day `tfirst_over_time` scans every sample), never further back than 30 days or
 * than a day before the cluster first reported. `last_seen` is the last change of the
 * counter (a use). A destination whose first sample is within an hour of the oldest one
 * retained, when the cluster is older than that, is marked "before".
 */
export function runEgressBackfill(deps: EgressDeps, nowMs: number): Promise<EgressReport> {
  return eachCluster(deps, 'backfill', async (orgId, cluster) => {
    if (cluster.egress_backfilled_at) return 0;
    const n = await backfillCluster(deps, orgId, cluster.id, cluster.kind, cluster.scope, {
      nowMs,
      firstReportMs: cluster.first_seen_at?.getTime() ?? null,
    });
    await deps.db
      .updateTable('clusters')
      .set({ egress_backfilled_at: new Date(nowMs) })
      .where('org_id', '=', orgId)
      .where('id', '=', cluster.id)
      .execute();
    return n;
  });
}

async function backfillCluster(
  deps: EgressDeps,
  orgId: string,
  clusterId: string,
  kind: ClusterKind,
  scope: ClusterScope,
  at: { nowMs: number; firstReportMs: number | null },
): Promise<number> {
  const found = new Map<string, { edge: Edge; first: number; last: number }>();
  const oldestDay = at.firstReportMs === null ? 0 : at.nowMs - at.firstReportMs + DAY_MS;
  for (let day = 0; day < EGRESS_LOOKBACK_DAYS; day++) {
    if (at.firstReportMs !== null && day * DAY_MS > oldestDay) break;
    const q = lookbackQueries(kind, day);
    const [first, last] = await Promise.all([
      deps.victoria.query(scope, q.first, at.nowMs / 1000),
      deps.victoria.query(scope, q.last, at.nowMs / 1000),
    ]);
    const lasts = edges(kind, last, Math.max);
    for (const [k, f] of edges(kind, first, Math.min)) {
      const firstMs = f.value * 1000;
      const lastMs = (lasts.get(k)?.value ?? f.value) * 1000;
      const seen = found.get(k);
      if (!seen) found.set(k, { edge: f.edge, first: firstMs, last: lastMs });
      else {
        seen.first = Math.min(seen.first, firstMs);
        seen.last = Math.max(seen.last, lastMs);
      }
    }
  }
  if (!found.size) return 0;
  const oldest = Math.min(...[...found.values()].map((f) => f.first));
  // Retention (or the 30-day bound) cut the history when the cluster reported before it.
  const cut = at.firstReportMs === null || oldest - at.firstReportMs > HOUR_MS;
  const rows = [...found.values()].map((f) => ({
    edge: f.edge,
    firstSeen: new Date(f.first),
    lastSeen: new Date(Math.max(f.first, f.last)),
    before: cut && f.first - oldest < HOUR_MS,
  }));
  await upsert(deps.db, orgId, clusterId, rows);
  return rows.length;
}

/**
 * Daily: destinations and sources last seen more than 90 days ago are deleted, in every
 * edition and plan. Expectations stay (ADR-186). A destination used again is new again.
 */
export function runEgressForget(deps: EgressDeps, nowMs: number): Promise<EgressReport> {
  const cutoff = new Date(nowMs - EGRESS_FORGET_AFTER_DAYS * DAY_MS);
  return eachForgettingOrg(deps, async (orgId) => {
    const rows = await deps.db
      .deleteFrom('egress_destinations')
      .where('org_id', '=', orgId)
      .where('last_seen', '<', cutoff)
      .executeTakeFirst();
    await deps.db
      .deleteFrom('egress_sources')
      .where('org_id', '=', orgId)
      .where('last_seen', '<', cutoff)
      .execute();
    return Number(rows.numDeletedRows);
  });
}

async function eachForgettingOrg(
  deps: EgressDeps,
  fn: (orgId: string) => Promise<number>,
): Promise<EgressReport> {
  const report: EgressReport = { clusters: 0, rows: 0, errors: [] };
  for (const orgId of await deps.orgs()) {
    try {
      report.rows += await withOrg(orgId, () => fn(orgId));
    } catch (err) {
      const msg = (err as Error).message;
      report.errors.push(`${orgId}: ${msg}`);
      deps.log.warn({ job: 'forget', org: orgId, err: msg }, 'egress forgetting failed');
    }
  }
  return report;
}
