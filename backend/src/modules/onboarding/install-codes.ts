// SPDX-License-Identifier: AGPL-3.0-only
// Install codes (ADR-176): `kubectl apply -f <ingest>/install.yaml?code=wl_ic_…` fetches the
// manifest with the cluster token in it, so the token itself never goes into a URL (URLs
// end up in logs and shell history). A code is 256 random bits, stored as its SHA-256, for
// one cluster and 24 hours. The token it hands out is stored encrypted with a key derived
// from the code, which only the person holding the code has: the database alone can't give
// the token back. Issuing or revoking a cluster token deletes the cluster's codes.
import { hkdfSync } from 'node:crypto';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { decryptSecret, encryptSecret } from '../../lib/secrets.js';
import { randomToken, sha256 } from '../../lib/tokens.js';

export const INSTALL_CODE_PREFIX = 'wl_ic_';
export const INSTALL_CODE_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_LENGTH = INSTALL_CODE_PREFIX.length + 43;

const keyOf = (code: string, clusterId: string) =>
  Buffer.from(hkdfSync('sha256', code, 'watchlog-install-code', clusterId, 32));

export interface IssuedInstallCode {
  code: string;
  expiresAt: Date;
}

/** A new code for a cluster token that was just issued (its plaintext is in hand once). */
export async function issueInstallCode(
  db: Database,
  opts: { orgId: string; clusterId: string; tokenId: string; token: string; now?: Date },
): Promise<IssuedInstallCode> {
  const code = `${INSTALL_CODE_PREFIX}${randomToken()}`;
  const id = newId();
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + INSTALL_CODE_TTL_MS);
  // The cluster's expired codes go when a new one is made.
  await db
    .deleteFrom('install_codes')
    .where('cluster_id', '=', opts.clusterId)
    .where('expires_at', '<=', now)
    .execute();
  await db
    .insertInto('install_codes')
    .values({
      id,
      org_id: opts.orgId,
      cluster_id: opts.clusterId,
      token_id: opts.tokenId,
      code_hash: sha256(code),
      token_ciphertext: encryptSecret(keyOf(code, opts.clusterId), opts.token, id),
      expires_at: expiresAt,
    })
    .execute();
  return { code, expiresAt };
}

/**
 * The token and cluster a code stands for, or null when it is unknown, expired, or its
 * token was revoked. Runs before any org is known: give it the owner's connection.
 */
export async function resolveInstallCode(
  systemDb: Database,
  code: string,
  now = new Date(),
): Promise<{ token: string; clusterId: string; orgId: string } | null> {
  if (code.length !== CODE_LENGTH || !code.startsWith(INSTALL_CODE_PREFIX)) return null;
  const row = await systemDb
    .selectFrom('install_codes as i')
    .innerJoin('cluster_tokens as t', 't.id', 'i.token_id')
    .select(['i.id', 'i.cluster_id', 'i.org_id', 'i.token_ciphertext'])
    .where('i.code_hash', '=', sha256(code))
    .where('i.expires_at', '>', now)
    .where('t.revoked_at', 'is', null)
    .executeTakeFirst();
  if (!row) return null;
  try {
    const token = decryptSecret(keyOf(code, row.cluster_id), row.token_ciphertext, row.id);
    return { token, clusterId: row.cluster_id, orgId: row.org_id };
  } catch {
    return null;
  }
}

/** Every code of a cluster: its tokens rotated (ADR-176). */
export async function revokeInstallCodes(db: Database, clusterId: string): Promise<void> {
  await db.deleteFrom('install_codes').where('cluster_id', '=', clusterId).execute();
}
