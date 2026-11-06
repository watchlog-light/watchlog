// SPDX-License-Identifier: AGPL-3.0-only
// Clusters and their tokens, always scoped to the caller's org (ADR-035).
import type { Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { Clusters, ClusterTokens } from '../../db/types.js';
import { newId } from '../../lib/ids.js';
import type { Plan } from '../auth/sessions.js';
import type { IngestFailure } from '../ingest/errors.js';

/** A cluster is "active" while an agent reported within this window (SPEC §4.7). */
export const CLUSTER_STALE_MS = 3 * 60 * 1000;

export type ClusterKind = 'kubernetes' | 'docker';
export type ClusterStatus = 'pending' | 'active' | 'inactive';

/** Community edition: one cluster or Docker fleet (SPEC §3.2, ADR-039). */
export const COMMUNITY_CLUSTER_LIMIT = 1;
/** Active tokens per cluster; enough for overlapping rotations. */
export const MAX_ACTIVE_TOKENS = 5;

export interface ClusterView {
  id: string;
  name: string;
  kind: ClusterKind;
  status: ClusterStatus;
  nodeCount: number;
  agentVersion: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  ingestFailure: IngestFailure | null;
}

export interface TokenView {
  id: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Status is derived from the last heartbeat rather than stored. */
export function clusterStatus(lastSeenAt: Date | null, now = Date.now()): ClusterStatus {
  if (!lastSeenAt) return 'pending';
  return now - lastSeenAt.getTime() > CLUSTER_STALE_MS ? 'inactive' : 'active';
}

export function toClusterView(
  row: Selectable<Clusters>,
  ingestFailure: IngestFailure | null = null,
): ClusterView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ClusterKind,
    status: clusterStatus(row.last_seen_at),
    nodeCount: row.node_count,
    agentVersion: row.agent_version,
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    createdAt: row.created_at.toISOString(),
    ingestFailure,
  };
}

export function toTokenView(row: Selectable<ClusterTokens>): TokenView {
  return {
    id: row.id,
    prefix: row.prefix,
    createdAt: row.created_at.toISOString(),
    revokedAt: iso(row.revoked_at),
  };
}

export function listClusters(db: Database, orgId: string) {
  return db
    .selectFrom('clusters')
    .selectAll()
    .where('org_id', '=', orgId)
    .orderBy('created_at')
    .execute();
}

export function findCluster(db: Database, orgId: string, clusterId: string) {
  return db
    .selectFrom('clusters')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('id', '=', clusterId)
    .executeTakeFirst();
}

export function listTokens(db: Database, clusterId: string) {
  return db
    .selectFrom('cluster_tokens')
    .selectAll()
    .where('cluster_id', '=', clusterId)
    .orderBy('created_at', 'desc')
    .execute();
}

export async function countActiveTokens(db: Database, clusterId: string): Promise<number> {
  const row = await db
    .selectFrom('cluster_tokens')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('cluster_id', '=', clusterId)
    .where('revoked_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function clusterLimitReached(db: Database, orgId: string, plan: Plan) {
  if (plan !== 'community') return false;
  const row = await db
    .selectFrom('clusters')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('org_id', '=', orgId)
    .executeTakeFirstOrThrow();
  return Number(row.n) >= COMMUNITY_CLUSTER_LIMIT;
}

export function insertCluster(db: Database, orgId: string, name: string, kind: ClusterKind) {
  return db
    .insertInto('clusters')
    .values({ id: newId(), org_id: orgId, name, kind })
    .returningAll()
    .executeTakeFirstOrThrow();
}
