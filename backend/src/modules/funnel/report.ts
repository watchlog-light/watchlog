// SPDX-License-Identifier: AGPL-3.0-only
// The funnel by week for the Cloud admin (SPEC §10.4, ADR-179): orgs grouped by the week
// (Monday, UTC) of their first signup, and how many of them reached each step at any time
// since, with the conversion from the step before. Across orgs: the caller passes the
// owner's connection (the internal admin API).
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { FUNNEL_STEPS } from './events.js';

export interface FunnelWeek {
  /** The week's Monday, YYYY-MM-DD (UTC). */
  week: string;
  steps: { name: string; orgs: number; conversion: number | null }[];
}

export async function funnelByWeek(
  db: Database,
  weeks: number,
  nowMs = Date.now(),
): Promise<{ steps: string[]; weeks: FunnelWeek[] }> {
  const since = new Date(nowMs - weeks * 7 * 86_400_000);
  const rows = await sql<{ week: string; name: string; orgs: number }>`
    WITH cohort AS (
      SELECT org_id, to_char(date_trunc('week', min(ts) AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week
      FROM funnel_events WHERE name = 'signup_completed'
      GROUP BY org_id HAVING min(ts) >= ${since}
    )
    SELECT c.week, f.name, count(DISTINCT c.org_id)::int AS orgs
    FROM cohort c JOIN funnel_events f ON f.org_id = c.org_id
    WHERE f.name IN (${sql.join(FUNNEL_STEPS.map((s) => sql.lit(s)))})
    GROUP BY c.week, f.name
    ORDER BY c.week DESC`.execute(db);
  const byWeek = new Map<string, Map<string, number>>();
  for (const r of rows.rows) {
    const m = byWeek.get(r.week) ?? new Map<string, number>();
    m.set(r.name, r.orgs);
    byWeek.set(r.week, m);
  }
  return {
    steps: [...FUNNEL_STEPS],
    weeks: [...byWeek].map(([week, counts]) => ({
      week,
      steps: FUNNEL_STEPS.map((name, i) => {
        const orgs = counts.get(name) ?? 0;
        const prev = i === 0 ? null : (counts.get(FUNNEL_STEPS[i - 1]!) ?? 0);
        return {
          name,
          orgs,
          conversion: prev === null || prev === 0 ? null : Math.round((orgs / prev) * 1000) / 1000,
        };
      }),
    })),
  };
}
