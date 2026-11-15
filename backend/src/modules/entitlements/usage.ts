// SPDX-License-Identifier: AGPL-3.0-only
// Usage for the bill (ADR-177, SPEC §3.3): every hour, each org's distinct sending
// Kubernetes nodes and Docker hosts. Measured first: `agent_instances` has one row per
// cluster and agent (node, cluster or docker mode), and each heartbeat (every 15 s) moves
// its `last_seen_at`; there is no history. So the job counts, for the current hour, the
// instances whose last heartbeat is in it: that count only grows during the hour (an agent
// that stopped keeps its last time), so the job runs every few minutes and keeps the
// highest count. An hour the worker missed has no row and counts as 0.
//
// SR-8 (ADR-194): heartbeats are what the agent says about itself, so a changed header or
// heartbeat, or none, lowered that count. Ingest also records the nodes and Docker hosts
// the written series name (node_sightings, node-sightings.ts; on Kubernetes that includes
// every Node the API lists). Each hour keeps both counts (`reported_*`, `observed_*`) and
// bills the higher (`nodes`, `docker_hosts`), never less than either.
//
// The alert worker runs it across orgs: it lists the orgs with agents seen in the hour on
// the owner's connection (systemDb), then writes each org's row inside `withOrg` on the
// app connection, under Row-Level Security (ADR-174).
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { withOrg } from '../../db/org-context.js';
import { percentile95 } from './plans.js';

export const USAGE_EVERY_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;

export function hourOf(ms: number): Date {
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS);
}

export interface UsageJobDeps {
  /** The owner's connection: the list across orgs. */
  systemDb: Database;
  /** The app connection: each org's row, written under its org. */
  db: Database;
}

/** Sightings are kept two days: the job counts the current hour only. */
const SIGHTINGS_KEPT_MS = 48 * HOUR_MS;

interface Counts {
  nodes: number;
  docker_hosts: number;
}

/** Records the current hour's counts for every org with an agent or a sighting in it. */
export async function recordUsage(deps: UsageJobDeps, nowMs: number): Promise<number> {
  const hour = hourOf(nowMs);
  const reported = await deps.systemDb
    .selectFrom('agent_instances')
    .select([
      'org_id',
      sql<number>`count(*) filter (where mode = 'node')::int`.as('nodes'),
      sql<number>`count(*) filter (where mode = 'docker')::int`.as('docker_hosts'),
    ])
    .where('last_seen_at', '>=', hour)
    .where('mode', '<>', 'cluster')
    .groupBy('org_id')
    .execute();
  // A node is one per cluster (the primary key); the cluster's kind says which it is.
  const observed = await deps.systemDb
    .selectFrom('node_sightings as s')
    .innerJoin('clusters as c', 'c.id', 's.cluster_id')
    .select([
      's.org_id',
      sql<number>`count(*) filter (where c.kind = 'kubernetes')::int`.as('nodes'),
      sql<number>`count(*) filter (where c.kind = 'docker')::int`.as('docker_hosts'),
    ])
    .where('s.hour', '=', hour)
    .groupBy('s.org_id')
    .execute();
  const zero: Counts = { nodes: 0, docker_hosts: 0 };
  const orgs = new Map<string, { reported: Counts; observed: Counts }>();
  for (const r of reported) orgs.set(r.org_id, { reported: r, observed: zero });
  for (const o of observed) {
    const row = orgs.get(o.org_id);
    if (row) row.observed = o;
    else orgs.set(o.org_id, { reported: zero, observed: o });
  }
  const higher = (col: string) =>
    sql<number>`greatest(usage_hourly.${sql.ref(col)}, excluded.${sql.ref(col)})`;
  for (const [orgId, { reported: r, observed: o }] of orgs) {
    await withOrg(orgId, () =>
      deps.db
        .insertInto('usage_hourly')
        .values({
          org_id: orgId,
          hour,
          nodes: Math.max(r.nodes, o.nodes),
          docker_hosts: Math.max(r.docker_hosts, o.docker_hosts),
          reported_nodes: r.nodes,
          reported_docker_hosts: r.docker_hosts,
          observed_nodes: o.nodes,
          observed_docker_hosts: o.docker_hosts,
        })
        .onConflict((oc) =>
          oc.columns(['org_id', 'hour']).doUpdateSet({
            nodes: higher('nodes'),
            docker_hosts: higher('docker_hosts'),
            reported_nodes: higher('reported_nodes'),
            reported_docker_hosts: higher('reported_docker_hosts'),
            observed_nodes: higher('observed_nodes'),
            observed_docker_hosts: higher('observed_docker_hosts'),
            updated_at: sql`now()`,
          }),
        )
        .execute(),
    );
  }
  await deps.systemDb
    .deleteFrom('node_sightings')
    .where('hour', '<', new Date(hour.getTime() - SIGHTINGS_KEPT_MS))
    .execute();
  return orgs.size;
}

export interface UsageHour {
  hour: string;
  nodes: number;
  dockerHosts: number;
  total: number;
}

export interface UsageReport {
  from: string;
  to: string;
  /** Recorded hours, oldest first (hours without a row had no agent). */
  hours: UsageHour[];
  /** Whole hours from `from` to `to` (or now, if earlier): the percentile's population. */
  hoursInPeriod: number;
  /** The 95th percentile of the hourly totals, hours without a row counted as 0. */
  p95: number;
  peak: number;
}

/**
 * An org's hourly counts and their 95th percentile from `from` up to `to` (or now). The
 * caller binds the org (the plan page) or passes the owner's connection (internal API).
 */
export async function usageReport(
  db: Database,
  orgId: string,
  from: Date,
  to: Date,
  nowMs: number = Date.now(),
): Promise<UsageReport> {
  const end = new Date(Math.min(to.getTime(), hourOf(nowMs).getTime() + HOUR_MS));
  const start = hourOf(from.getTime());
  const rows =
    end > start
      ? await db
          .selectFrom('usage_hourly')
          .select(['hour', 'nodes', 'docker_hosts'])
          .where('org_id', '=', orgId)
          .where('hour', '>=', start)
          .where('hour', '<', end)
          .orderBy('hour')
          .execute()
      : [];
  const hours = rows.map((r) => ({
    hour: new Date(r.hour).toISOString(),
    nodes: r.nodes,
    dockerHosts: r.docker_hosts,
    total: r.nodes + r.docker_hosts,
  }));
  const hoursInPeriod = Math.max(0, Math.ceil((end.getTime() - start.getTime()) / HOUR_MS));
  const totals = hours.map((h) => h.total);
  const zeros = Math.max(0, hoursInPeriod - totals.length);
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    hours,
    hoursInPeriod,
    p95: percentile95([...totals, ...new Array<number>(zeros).fill(0)]),
    peak: totals.reduce((a, b) => Math.max(a, b), 0),
  };
}
