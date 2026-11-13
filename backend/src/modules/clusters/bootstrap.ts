// SPDX-License-Identifier: AGPL-3.0-only
// Kubernetes cluster from the Helm chart (ADR-069): the chart generates a cluster token
// into a Secret and passes it to the backend, which creates the cluster with exactly
// that token, so `helm install` needs no step in the UI.
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { sha256 } from '../../lib/tokens.js';
import { insertCluster } from './service.js';
import type { ClusterKind } from './service.js';
import { tokenPrefix, verifyClusterToken } from './tokens.js';

/**
 * exists: the token works; created: cluster and token added; no-org: before first-run
 * setup; revoked: the user revoked the token; deleted: the user deleted its cluster.
 */
export type BootstrapResult = 'exists' | 'created' | 'no-org' | 'revoked' | 'deleted';

/**
 * Ensures a Kubernetes cluster named `name` exists in the (first) org and accepts
 * `token`. Idempotent; returns 'no-org' before first-run setup has created the org.
 * A token the user revoked, or whose cluster the user deleted, is never brought back
 * (ADR-069): the user's choice outlives the chart's environment variable.
 */
export async function ensureBootstrapCluster(
  db: Database,
  name: string,
  token: string,
): Promise<BootstrapResult> {
  if (await verifyClusterToken(db, token)) return 'exists';
  const result = await ensureTokenCluster(db, {
    name,
    kind: 'kubernetes',
    hash: sha256(token),
    prefix: tokenPrefix(token),
    anyKind: true,
  });
  return result === 'kind-mismatch' ? 'exists' : result; // never with anyKind
}

/**
 * The same for a token known only by its SHA-256 and prefix (a seeded cluster, ADR-170:
 * the seed never holds the token itself). 'exists' when that token is registered and
 * not revoked; a cluster of the name but another kind is left alone ('kind-mismatch').
 */
export async function ensureTokenCluster(
  db: Database,
  t: { name: string; kind: ClusterKind; hash: Buffer; prefix: string; anyKind?: boolean },
): Promise<BootstrapResult | 'kind-mismatch'> {
  const [known, retired] = await Promise.all([
    db
      .selectFrom('cluster_tokens')
      .select(['id', 'revoked_at'])
      .where('token_hash', '=', t.hash)
      .executeTakeFirst(),
    db
      .selectFrom('retired_cluster_tokens')
      .select('token_hash')
      .where('token_hash', '=', t.hash)
      .executeTakeFirst(),
  ]);
  if (retired) return 'deleted';
  if (known) return known.revoked_at ? 'revoked' : 'exists';
  const org = await db.selectFrom('orgs').select('id').orderBy('created_at').executeTakeFirst();
  if (!org) return 'no-org';
  return db.transaction().execute(async (trx) => {
    const found = await trx
      .selectFrom('clusters')
      .selectAll()
      .where('org_id', '=', org.id)
      .where('name', '=', t.name)
      .executeTakeFirst();
    if (found && found.kind !== t.kind && !t.anyKind) return 'kind-mismatch' as const;
    const cluster = found ?? (await insertCluster(trx, org.id, t.name, t.kind));
    await trx
      .insertInto('cluster_tokens')
      .values({ id: newId(), cluster_id: cluster.id, token_hash: t.hash, prefix: t.prefix })
      .execute();
    return 'created' as const;
  });
}
