// SPDX-License-Identifier: AGPL-3.0-only
// Ingest errors per cluster and endpoint (ADR-117). A request the backend answers with
// an error loses or holds back data: the namespace-marker 500 once held back every pod
// change for days, visible only in the cluster-agent's log. Each error is recorded with
// when the failure began (the first error after the last success); a success clears it.
// The overview and Settings show "Data delayed", and the default rule fires after 5 min.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

export type IngestEndpoint = 'write' | 'heartbeat' | 'objects' | 'events';
export const INGEST_ENDPOINTS: readonly IngestEndpoint[] = [
  'write',
  'heartbeat',
  'objects',
  'events',
];

/**
 * Whether an answer to an authenticated agent loses or holds back data: server errors,
 * bodies too large or refused. 429 is backpressure the agent waits out; 401 has no
 * cluster to record it on; 402 (Cloud, ADR-177) is a node over the plan, shown by the plan
 * banner, not "data delayed" for the nodes still sending (and never a write per refusal).
 */
export function isIngestError(status: number): boolean {
  return status >= 400 && status !== 429 && status !== 401 && status !== 402;
}

/** Failing means an error within this window: an agent that stopped sending is "not reporting", not failing. */
export const INGEST_ERROR_FRESH_MS = 10 * 60_000;

/** How long a success is trusted to mean "nothing to clear" before checking again. */
const CLEAR_RECHECK_MS = 60_000;

export class IngestErrorRecorder {
  /** Keys this instance cleared or found clear, and when. */
  private readonly clear = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async failure(clusterId: string, endpoint: IngestEndpoint, status: number, message: string) {
    this.clear.delete(`${clusterId}:${endpoint}`);
    const at = new Date(this.now());
    const text = message.slice(0, 500);
    await this.db
      .insertInto('ingest_errors')
      .values({
        cluster_id: clusterId,
        endpoint,
        failing_since: at,
        last_error_at: at,
        last_status: status,
        last_message: text,
        failures: 1,
      })
      .onConflict((oc) =>
        oc.columns(['cluster_id', 'endpoint']).doUpdateSet({
          failing_since: sql`coalesce(ingest_errors.failing_since, excluded.failing_since)`,
          last_error_at: at,
          last_status: status,
          last_message: text,
          failures: sql`ingest_errors.failures + 1`,
        }),
      )
      .execute();
  }

  /** A delivered request ends the endpoint's failure. Cheap: one conditional update a minute at most. */
  async success(clusterId: string, endpoint: IngestEndpoint) {
    const key = `${clusterId}:${endpoint}`;
    const checked = this.clear.get(key);
    if (checked !== undefined && this.now() - checked < CLEAR_RECHECK_MS) return;
    await this.db
      .updateTable('ingest_errors')
      .set({ failing_since: null, last_success_at: new Date(this.now()) })
      .where('cluster_id', '=', clusterId)
      .where('endpoint', '=', endpoint)
      .where('failing_since', 'is not', null)
      .execute();
    this.clear.set(key, this.now());
  }
}

export interface IngestFailure {
  /** When the oldest failing endpoint began failing. */
  since: string;
  lastErrorAt: string;
  endpoints: { endpoint: IngestEndpoint; status: number; message: string; failures: number }[];
}

/** Clusters whose ingest is failing now, by cluster id. */
export async function ingestFailures(
  db: Database,
  clusterIds: string[],
  now = Date.now(),
): Promise<Map<string, IngestFailure>> {
  const out = new Map<string, IngestFailure>();
  if (clusterIds.length === 0) return out;
  const rows = await db
    .selectFrom('ingest_errors')
    .select([
      'cluster_id',
      'endpoint',
      'failing_since',
      'last_error_at',
      'last_status',
      'last_message',
      'failures',
    ])
    .where('cluster_id', 'in', clusterIds)
    .where('failing_since', 'is not', null)
    .where('last_error_at', '>', new Date(now - INGEST_ERROR_FRESH_MS))
    .orderBy('endpoint')
    .execute();
  for (const r of rows) {
    const since = new Date(r.failing_since!).toISOString();
    const last = new Date(r.last_error_at).toISOString();
    const f = out.get(r.cluster_id) ?? { since, lastErrorAt: last, endpoints: [] };
    if (since < f.since) f.since = since;
    if (last > f.lastErrorAt) f.lastErrorAt = last;
    f.endpoints.push({
      endpoint: r.endpoint as IngestEndpoint,
      status: r.last_status,
      message: r.last_message,
      failures: Number(r.failures),
    });
    out.set(r.cluster_id, f);
  }
  return out;
}
