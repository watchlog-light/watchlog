// SPDX-License-Identifier: AGPL-3.0-only
// Applications (SPEC §4.12): monitored services with their health, and what the
// collectors report. Health is a code with facts; the web writes the sentence.
import type { Database } from '../../db/index.js';
import type { IntegrationTarget, IntegrationType } from './collector-config.js';

/** A collector that hasn't posted its status for this long is silent (SPEC §4.7's 3 min). */
export const COLLECTOR_STALE_MS = 3 * 60 * 1000;

export type Health = 'ok' | 'warning' | 'critical' | 'unknown';

/** Why a service has its health; reasons from the integrations join in slice 3 (ADR-137). */
export interface HealthReason {
  code:
    | 'waiting' // monitored, no report yet
    | 'collector_missing' // no collector has ever reported for it
    | 'collector_silent' // its collector stopped reporting
    | 'unreachable' // the collector can't connect
    | 'connected' // the collector connects; the integration's pages come with it
    | 'paused';
  facts: Record<string, string | number | null>;
}

export interface ApplicationRow {
  id: string;
  type: IntegrationType;
  name: string;
  version: string | null;
  status: string;
  status_details: unknown;
  target: IntegrationTarget;
  collector_host: string;
  monitored_since: Date;
  last_report_at: Date | null;
  cluster_id: string;
  cluster_name: string;
  cluster_kind: string;
}

export interface CollectorRow {
  cluster_id: string;
  host: string;
  mode: string;
  version: string;
  last_seen_at: Date;
}

export async function listApplicationRows(
  db: Database,
  orgId: string,
  filter: { clusterId?: string; id?: string } = {},
): Promise<ApplicationRow[]> {
  let q = db
    .selectFrom('integrations as i')
    .innerJoin('clusters as c', 'c.id', 'i.cluster_id')
    .select([
      'i.id',
      'i.type',
      'i.name',
      'i.version',
      'i.status',
      'i.status_details',
      'i.target',
      'i.collector_host',
      'i.monitored_since',
      'i.last_report_at',
      'i.cluster_id',
      'c.name as cluster_name',
      'c.kind as cluster_kind',
    ])
    .where('i.org_id', '=', orgId);
  if (filter.clusterId) q = q.where('i.cluster_id', '=', filter.clusterId);
  if (filter.id) q = q.where('i.id', '=', filter.id);
  const rows = await q.orderBy('i.name').execute();
  return rows.map((r) => ({
    ...r,
    type: r.type as IntegrationType,
    target: r.target as IntegrationTarget,
  }));
}

export async function listCollectors(db: Database, clusterIds: string[]): Promise<CollectorRow[]> {
  if (clusterIds.length === 0) return [];
  return db
    .selectFrom('integration_collectors')
    .select(['cluster_id', 'host', 'mode', 'version', 'last_seen_at'])
    .where('cluster_id', 'in', clusterIds)
    .execute();
}

/** The collector that reaches this service, if any has reported. */
export function collectorOf(
  row: Pick<ApplicationRow, 'cluster_id' | 'collector_host'>,
  collectors: CollectorRow[],
): CollectorRow | undefined {
  return collectors.find((c) => c.cluster_id === row.cluster_id && c.host === row.collector_host);
}

/** A service's health from its collector's reports (the integration's own reasons come later). */
export function healthOf(
  row: ApplicationRow,
  collector: CollectorRow | undefined,
  now = Date.now(),
): { health: Health; reason: HealthReason } {
  if (row.status === 'paused') return { health: 'unknown', reason: { code: 'paused', facts: {} } };
  if (!collector) {
    return {
      health: 'unknown',
      reason: { code: 'collector_missing', facts: { host: row.collector_host || null } },
    };
  }
  if (now - collector.last_seen_at.getTime() > COLLECTOR_STALE_MS) {
    return {
      health: 'critical',
      reason: {
        code: 'collector_silent',
        facts: { since: collector.last_seen_at.toISOString(), host: row.collector_host || null },
      },
    };
  }
  if (!row.last_report_at || row.status === 'pending' || row.status === 'connecting') {
    return { health: 'unknown', reason: { code: 'waiting', facts: {} } };
  }
  const details = (row.status_details ?? {}) as {
    error?: string;
    members?: { up: boolean }[];
  };
  const members = details.members ?? [];
  const up = members.filter((m) => m.up).length;
  if (row.status === 'error') {
    return {
      health: 'critical',
      reason: {
        code: 'unreachable',
        facts: { error: details.error ?? null, up, members: members.length },
      },
    };
  }
  return {
    health: up < members.length ? 'warning' : 'ok',
    reason: { code: 'connected', facts: { up, members: members.length } },
  };
}

/** Where the service runs, in its cluster's words. */
export function whereOf(target: IntegrationTarget): {
  group: string | null;
  host: string | null;
  address: string | null;
} {
  switch (target.kind) {
    case 'workload':
      return { group: target.namespace, host: null, address: null };
    case 'compose':
      return { group: target.compose_project, host: target.host, address: null };
    case 'container':
      return { group: null, host: target.host, address: null };
    case 'address':
      return { group: null, host: null, address: target.address };
  }
}
