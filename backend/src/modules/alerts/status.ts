// SPDX-License-Identifier: AGPL-3.0-only
// Whether alerting runs (ADR-088) and a cluster's health from its firing alerts (ADR-078).
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { STALE_MS } from './worker.js';

export interface AlertingStatus {
  /** A worker completed a cycle within the last 2 minutes. */
  running: boolean;
  lastCycleAt: string | null;
  workers: number;
}

export async function alertingStatus(db: Database, now = Date.now()): Promise<AlertingStatus> {
  const row = await db
    .selectFrom('alert_worker_heartbeats')
    .select([
      (eb) => eb.fn.max('last_cycle_at').as('last'),
      (eb) =>
        eb.fn
          .count<string>('worker_id')
          .filterWhere('updated_at', '>', new Date(now - STALE_MS))
          .as('workers'),
    ])
    .executeTakeFirst();
  const last = row?.last ? new Date(row.last) : null;
  return {
    running: !!last && now - last.getTime() < STALE_MS,
    lastCycleAt: last?.toISOString() ?? null,
    workers: Number(row?.workers ?? 0),
  };
}

export type Health = 'healthy' | 'degraded' | 'critical' | 'unknown';

export interface ClusterAlertHealth {
  health: Health;
  firing: number;
  critical: number;
  silenced: number;
}

/**
 * Critical with a firing critical alert, degraded with a firing warning, else healthy;
 * silenced alerts do not count (ADR-078). While alerting is not running nothing can be
 * called healthy: the result is unknown unless an alert already says worse (ADR-088).
 */
export async function clusterAlertHealth(
  db: Database,
  clusterId: string,
  running: boolean,
): Promise<ClusterAlertHealth> {
  const rows = await db
    .selectFrom('alert_states')
    .select(['severity', 'silenced', (eb) => eb.fn.countAll<string>().as('n')])
    .where('cluster_id', '=', clusterId)
    .where('state', '=', 'firing')
    .where('held', '=', false)
    .groupBy(['severity', 'silenced'])
    .execute();
  let firing = 0;
  let critical = 0;
  let silenced = 0;
  for (const r of rows) {
    const n = Number(r.n);
    if (r.silenced) silenced += n;
    else {
      firing += n;
      if (r.severity === 'critical') critical += n;
    }
  }
  let health: Health = critical > 0 ? 'critical' : firing > 0 ? 'degraded' : 'healthy';
  if (!running && health === 'healthy') health = 'unknown';
  return { health, firing, critical, silenced };
}

/** Firing alert counts per cluster of an org, for lists. */
export async function firingByCluster(db: Database, orgId: string) {
  const rows = await sql<{ cluster_id: string; n: string }>`
    SELECT cluster_id, count(*) AS n FROM alert_states
     WHERE org_id = ${orgId} AND state = 'firing' AND NOT silenced
     GROUP BY cluster_id`.execute(db);
  return new Map(rows.rows.map((r) => [r.cluster_id, Number(r.n)]));
}
