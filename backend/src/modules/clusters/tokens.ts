// SPDX-License-Identifier: AGPL-3.0-only
// Cluster tokens: `wl_ct_` + 256-bit random value, stored as SHA-256 with an 8-character prefix (ADR-025).
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { isUniqueViolation } from '../../db/index.js';
import { randomToken, sha256 } from '../../lib/tokens.js';
import { timingSafeEqual } from 'node:crypto';

export const CLUSTER_TOKEN_PREFIX = 'wl_ct_';
const TOKEN_LENGTH = CLUSTER_TOKEN_PREFIX.length + 43;
const PREFIX_LENGTH = 8;

export interface IssuedToken {
  id: string;
  prefix: string;
  /** The plaintext token; returned once and never stored. */
  value: string;
  createdAt: Date;
}

export function tokenPrefix(token: string): string {
  return token.slice(CLUSTER_TOKEN_PREFIX.length, CLUSTER_TOKEN_PREFIX.length + PREFIX_LENGTH);
}

/** Creates a token for a cluster, retrying on the (unlikely) prefix collision. */
export async function issueClusterToken(db: Database, clusterId: string): Promise<IssuedToken> {
  for (let attempt = 0; ; attempt++) {
    const value = `${CLUSTER_TOKEN_PREFIX}${randomToken()}`;
    const row = {
      id: newId(),
      cluster_id: clusterId,
      token_hash: sha256(value),
      prefix: tokenPrefix(value),
    };
    try {
      const inserted = await db
        .insertInto('cluster_tokens')
        .values(row)
        .returning('created_at')
        .executeTakeFirstOrThrow();
      return { id: row.id, prefix: row.prefix, value, createdAt: inserted.created_at };
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= 2) throw err;
    }
  }
}

export interface TokenOwner {
  clusterId: string;
  orgId: string;
  tokenId: string;
}

/** Resolves an agent's bearer token to its cluster, or null if unknown or revoked. */
export async function verifyClusterToken(db: Database, token: string): Promise<TokenOwner | null> {
  if (token.length !== TOKEN_LENGTH || !token.startsWith(CLUSTER_TOKEN_PREFIX)) return null;
  const row = await db
    .selectFrom('cluster_tokens as t')
    .innerJoin('clusters as c', 'c.id', 't.cluster_id')
    .select(['t.id', 't.token_hash', 't.cluster_id', 'c.org_id'])
    .where('t.prefix', '=', tokenPrefix(token))
    .where('t.revoked_at', 'is', null)
    .executeTakeFirst();
  if (!row || !timingSafeEqual(row.token_hash, sha256(token))) return null;
  return { clusterId: row.cluster_id, orgId: row.org_id, tokenId: row.id };
}
