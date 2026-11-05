// SPDX-License-Identifier: AGPL-3.0-only
// Kubernetes cluster from the Helm chart (ADR-069): the chart generates a cluster token
// into a Secret and passes it to the backend, which creates the cluster with exactly
// that token, so `helm install` needs no step in the UI.
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { sha256 } from '../../lib/tokens.js';
import { insertCluster } from './service.js';
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
  const hash = sha256(token);
  const [known, retired] = await Promise.all([
    db.selectFrom('cluster_tokens').select('id').where('token_hash', '=', hash).executeTakeFirst(),
    db
      .selectFrom('retired_cluster_tokens')
      .select('token_hash')
      .where('token_hash', '=', hash)
      .executeTakeFirst(),
  ]);
  if (retired) return 'deleted';
  if (known) return 'revoked';
  const org = await db.selectFrom('orgs').select('id').orderBy('created_at').executeTakeFirst();
  if (!org) return 'no-org';
  await db.transaction().execute(async (trx) => {
    const cluster =
      (await trx
        .selectFrom('clusters')
        .selectAll()
        .where('org_id', '=', org.id)
        .where('name', '=', name)
        .executeTakeFirst()) ?? (await insertCluster(trx, org.id, name, 'kubernetes'));
    await trx
      .insertInto('cluster_tokens')
      .values({
        id: newId(),
        cluster_id: cluster.id,
        token_hash: hash,
        prefix: tokenPrefix(token),
      })
      .execute();
  });
  return 'created';
}
