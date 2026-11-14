// SPDX-License-Identifier: AGPL-3.0-only
// The heartbeat's writes (SPEC §4.7, ADR-180's load test). Every agent sends one every
// 15 s; writing each one moved `agent_instances.last_seen_at` (a non-HOT update: the
// column is in two indexes) and the cluster's row, which made almost all of PostgreSQL's
// WAL at 1,000 nodes. So the times are written at most once a minute per agent and per
// cluster, and a change of state is written at once: a new agent, a changed mode, version
// or capabilities, an agent back after being silent, a cluster not yet active. Readers
// keep their 3-minute windows: a stored time is at most a minute (plus one heartbeat)
// behind, so a reporting agent never looks silent.
//
// The state is read from the database on every heartbeat (one indexed read, no WAL), not
// kept in memory, so several backend processes and anything that changes the rows stay
// right.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';

/** A heartbeat's time is written when the stored one is at least this old. */
export const LAST_SEEN_WRITE_MS = 60_000;
/** An agent silent this long counts again in the cluster's node count when it comes back. */
const AGENT_STALE_MS = 3 * 60_000;
const HOUR_MS = 3_600_000;

export interface Heartbeat {
  agent_version: string;
  mode: 'node' | 'cluster' | 'docker';
  node: string;
  capabilities: Record<string, unknown>;
  series: number;
}

export interface HeartbeatOwner {
  clusterId: string;
  orgId: string;
}

/** What a heartbeat wrote: nothing, the agent's row, the cluster's row, or both. */
export interface HeartbeatWrite {
  agent: 'inserted' | 'updated' | null;
  cluster: boolean;
}

/** JSON with sorted keys, so stored jsonb and a request body compare equal. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const due = (stored: Date | null, now: Date) =>
  !stored ||
  now.getTime() - stored.getTime() >= LAST_SEEN_WRITE_MS ||
  // usage_hourly counts the agents whose last time is in the hour (entitlements/usage.ts):
  // the first heartbeat of an hour is written, so an hour an agent sent in always counts.
  Math.floor(now.getTime() / HOUR_MS) !== Math.floor(stored.getTime() / HOUR_MS);

/** Records one heartbeat, writing only what is due. */
export async function recordHeartbeat(
  db: Database,
  owner: HeartbeatOwner,
  hb: Heartbeat,
  now = new Date(),
): Promise<HeartbeatWrite> {
  const state = await db
    .selectFrom('clusters as c')
    .leftJoin('agent_instances as a', (j) =>
      j.onRef('a.cluster_id', '=', 'c.id').on('a.node', '=', hb.node),
    )
    .select([
      'c.status',
      'c.last_seen_at as clusterSeen',
      'a.id as agentId',
      'a.mode',
      'a.agent_version',
      'a.capabilities',
      'a.last_seen_at as agentSeen',
    ])
    .where('c.id', '=', owner.clusterId)
    .executeTakeFirst();
  // A cluster deleted since its token was checked: nothing to record.
  if (!state) return { agent: null, cluster: false };

  const capabilities = stableJson(hb.capabilities);
  const isNew = !state.agentId;
  const changed =
    isNew ||
    state.mode !== hb.mode ||
    state.agent_version !== hb.agent_version ||
    stableJson(state.capabilities) !== capabilities;
  const back = !!state.agentSeen && now.getTime() - state.agentSeen.getTime() >= AGENT_STALE_MS;
  const agentDue = changed || due(state.agentSeen, now);
  const clusterDue =
    isNew ||
    back ||
    state.mode !== hb.mode ||
    state.agent_version !== hb.agent_version ||
    state.status !== 'active' ||
    due(state.clusterSeen, now);
  if (!agentDue && !clusterDue) return { agent: null, cluster: false };

  await db.transaction().execute(async (trx) => {
    if (agentDue)
      await trx
        .insertInto('agent_instances')
        .values({
          id: newId(),
          cluster_id: owner.clusterId,
          org_id: owner.orgId,
          node: hb.node,
          mode: hb.mode,
          agent_version: hb.agent_version,
          capabilities,
          series: hb.series,
          last_seen_at: now,
        })
        .onConflict((oc) =>
          oc.columns(['cluster_id', 'node']).doUpdateSet({
            mode: hb.mode,
            agent_version: hb.agent_version,
            capabilities,
            series: hb.series,
            last_seen_at: now,
          }),
        )
        .execute();
    if (clusterDue) {
      const staleBefore = new Date(now.getTime() - AGENT_STALE_MS);
      await trx
        .updateTable('clusters')
        .set({
          last_seen_at: now,
          first_seen_at: sql`coalesce(first_seen_at, ${now})`,
          agent_version: hb.agent_version,
          status: 'active',
          // Hosts or nodes: the cluster-agent is not one.
          node_count: sql`(select count(*) from agent_instances
            where cluster_id = ${owner.clusterId} and last_seen_at > ${staleBefore}
            and mode <> 'cluster')`,
        })
        .where('id', '=', owner.clusterId)
        .execute();
    }
  });
  return { agent: agentDue ? (isNew ? 'inserted' : 'updated') : null, cluster: clusterDue };
}
