// SPDX-License-Identifier: AGPL-3.0-only
// Write-only tokens for own metrics and change events (1.0.0, ADR-236): `wl_mt_` + 256 random
// bits, stored as SHA-256 with an 8-character prefix, like a cluster token (ADR-025). A token
// belongs to one cluster or fleet. It can send own metrics there (remote write, pushes) and
// change events (ADR-238), and can read nothing: no API route and no agent route accepts it.
import { timingSafeEqual } from 'node:crypto';
import type { Database } from '../../db/index.js';
import { isUniqueViolation } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { OWN_TOKENS_PER_CLUSTER, OWN_TOKENS_PER_ORG } from '../entitlements/own-metrics.js';
import { randomToken, sha256 } from '../../lib/tokens.js';

export const METRIC_TOKEN_PREFIX = 'wl_mt_';
const TOKEN_LENGTH = METRIC_TOKEN_PREFIX.length + 43;
const PREFIX_LENGTH = 8;
/** Active tokens one cluster or fleet may have, and one org over all of them. */
export const MAX_METRIC_TOKENS = OWN_TOKENS_PER_CLUSTER;
export const MAX_ORG_METRIC_TOKENS = OWN_TOKENS_PER_ORG;

export interface MetricTokenOwner {
  clusterId: string;
  orgId: string;
  tokenId: string;
  /** The token's name, shown as where a push or an event came from. */
  name: string;
}

const prefixOf = (token: string) =>
  token.slice(METRIC_TOKEN_PREFIX.length, METRIC_TOKEN_PREFIX.length + PREFIX_LENGTH);

export const isMetricToken = (token: string): boolean => token.startsWith(METRIC_TOKEN_PREFIX);

/** Creates a token; its value is returned once and never stored. */
export async function issueMetricToken(
  db: Database,
  clusterId: string,
  name: string,
  userId: string | null,
): Promise<{ id: string; prefix: string; value: string; createdAt: Date }> {
  for (let attempt = 0; ; attempt++) {
    const value = `${METRIC_TOKEN_PREFIX}${randomToken()}`;
    const row = {
      id: newId(),
      cluster_id: clusterId,
      name,
      token_hash: sha256(value),
      prefix: prefixOf(value),
      created_by: userId,
    };
    try {
      const inserted = await db
        .insertInto('own_metric_tokens')
        .values(row)
        .returning('created_at')
        .executeTakeFirstOrThrow();
      return { id: row.id, prefix: row.prefix, value, createdAt: inserted.created_at };
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= 2) throw err;
    }
  }
}

/** Resolves a bearer token to its cluster, or null if unknown or revoked. */
export async function verifyMetricToken(
  db: Database,
  token: string,
): Promise<MetricTokenOwner | null> {
  if (token.length !== TOKEN_LENGTH || !isMetricToken(token)) return null;
  const row = await db
    .selectFrom('own_metric_tokens as t')
    .innerJoin('clusters as c', 'c.id', 't.cluster_id')
    .select(['t.id', 't.token_hash', 't.cluster_id', 't.name', 'c.org_id'])
    .where('t.prefix', '=', prefixOf(token))
    .where('t.revoked_at', 'is', null)
    .executeTakeFirst();
  if (!row || !timingSafeEqual(row.token_hash, sha256(token))) return null;
  return { clusterId: row.cluster_id, orgId: row.org_id, tokenId: row.id, name: row.name };
}

export async function listMetricTokens(db: Database, clusterId: string) {
  return db
    .selectFrom('own_metric_tokens')
    .select(['id', 'name', 'prefix', 'created_at', 'last_used_at'])
    .where('cluster_id', '=', clusterId)
    .where('revoked_at', 'is', null)
    .orderBy('created_at')
    .execute();
}

/** The org's active tokens, in every cluster and fleet. */
export async function countOrgMetricTokens(db: Database, orgId: string): Promise<number> {
  const row = await db
    .selectFrom('own_metric_tokens')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('org_id', '=', orgId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** Revokes a token; its sources (and their series) go with it. */
export async function revokeMetricToken(
  db: Database,
  clusterId: string,
  id: string,
): Promise<boolean> {
  const r = await db
    .updateTable('own_metric_tokens')
    .set({ revoked_at: new Date() })
    .where('cluster_id', '=', clusterId)
    .where('id', '=', id)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (!r.numUpdatedRows) return false;
  await db
    .deleteFrom('own_sources')
    .where('cluster_id', '=', clusterId)
    .where('token_id', '=', id)
    .execute();
  return true;
}
