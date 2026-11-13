// SPDX-License-Identifier: AGPL-3.0-only
// `day7_active` (SPEC §10.4), a daily job in the alert worker (Cloud): a cluster or Docker
// fleet still sending 7 days after its first heartbeat. Listed across orgs on the owner's
// connection; each event is written inside its org (FunnelRecorder uses withOrg). Once per
// cluster: the unique key in funnel_events, so a second worker or a restart adds nothing.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import type { FunnelRecorder } from './recorder.js';

export const DAY7_EVERY_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;

/** Records day7_active for each cluster that qualifies; returns how many were new. */
export async function recordDay7Active(
  deps: { systemDb: Database; funnel: FunnelRecorder },
  nowMs: number,
): Promise<number> {
  const now = new Date(nowMs);
  const rows = await deps.systemDb
    .selectFrom('clusters as c')
    .select(['c.id', 'c.org_id', 'c.kind', 'c.first_seen_at'])
    // First heartbeat at least 7 days ago, and a heartbeat in the last day.
    .where('c.first_seen_at', '<=', new Date(nowMs - 7 * DAY_MS))
    .where('c.last_seen_at', '>=', new Date(nowMs - DAY_MS))
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('funnel_events as f')
            .select('f.id')
            .whereRef('f.org_id', '=', 'c.org_id')
            .where('f.name', '=', 'day7_active')
            .where(sql<boolean>`f.once_key = 'cluster:' || c.id::text`),
        ),
      ),
    )
    .execute();
  let added = 0;
  for (const r of rows) {
    const days = r.first_seen_at
      ? Math.floor((now.getTime() - r.first_seen_at.getTime()) / DAY_MS)
      : 7;
    if (
      await deps.funnel.record({
        name: 'day7_active',
        orgId: r.org_id,
        clusterId: r.id,
        props: { kind: r.kind, days: String(days) },
        at: now,
      })
    ) {
      added++;
    }
  }
  return added;
}
