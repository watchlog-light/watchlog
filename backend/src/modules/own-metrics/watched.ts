// SPDX-License-Identifier: AGPL-3.0-only
// Watched own metrics as What changed reads them (1.0.0, ADR-238): one more query per watched
// metric of a cluster, a line for each workload or server it belongs to, with the labels What
// changed's other series carry (namespace, workload and its kind; host). From there they are
// scored, listed, told in the story and learnt for a week like every other series (ADR-196,
// ADR-204). A metric tied to nothing has its usual range on its own page, and no row here:
// What changed is about the things WatchLog knows.
import type { Database } from '../../db/index.js';
import { ownKey, type KeyQuery, type ScoredKey } from '../anomaly/keys.js';
import { exprFor } from './expr.js';
import { exprMetric, listMetrics } from './read.js';
import { statUnit } from './words.js';

/** `anomaly_baselines.metric` holds 100 characters; the key's prefix and unit take up to 22. */
export const WATCHED_NAME_MAX = 78;
/** What changed reads at a 60-second step. */
const STEP_S = 60;

export async function watchedQueries(db: Database, clusterId: string): Promise<KeyQuery[]> {
  const watched = await db
    .selectFrom('own_metrics')
    .select('id')
    .where('cluster_id', '=', clusterId)
    .where('watched_at', 'is not', null)
    .limit(1)
    .executeTakeFirst();
  // Almost every cluster has none: one small read, nothing more.
  if (!watched) return [];
  const [cluster, metrics] = await Promise.all([
    db.selectFrom('clusters').select('kind').where('id', '=', clusterId).executeTakeFirst(),
    listMetrics(db, clusterId),
  ]);
  const server = cluster?.kind === 'server';
  const out: KeyQuery[] = [];
  for (const m of metrics) {
    if (!m.watched || m.type === 'timestamp' || m.name.length > WATCHED_NAME_MAX) continue;
    const expr = exprFor(exprMetric(m), {
      perOwner: true,
      owned: server ? 'server' : 'workload',
      step: STEP_S,
    });
    out.push({
      key: ownKey(statUnit(m), m.name) as ScoredKey,
      unit: statUnit(m),
      // Its owner under the names every other series uses.
      expr: server
        ? `label_move(${expr}, "wl_server", "host")`
        : `label_move(${expr}, "wl_ns", "namespace", "wl_workload", "workload", "wl_wkind", "workload_kind")`,
    });
  }
  return out;
}
