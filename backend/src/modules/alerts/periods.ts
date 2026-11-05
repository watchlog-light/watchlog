// SPDX-License-Identifier: AGPL-3.0-only
// When alerting ran (alert detail page): every evaluated cycle extends the latest
// period in `alerting_periods`, or starts a new one after more than STALE_MS without a
// cycle — the same 2 minutes after which the "Alerting is not running" banner shows
// (ADR-088). The gaps between periods explain an alert that fired long after its
// condition started: "Alerting was not running 21:45–02:19".
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';

/** Same threshold as the worker's staleness (ADR-088); kept here to avoid an import cycle. */
export const PERIOD_GAP_MS = 2 * 60_000;

export interface AlertingGap {
  from: Date;
  /** Null while alerting is still not running. */
  to: Date | null;
}

/** Records an evaluated cycle at `now`. Two workers may both extend the same period. */
export async function recordCycle(db: Database, now: Date): Promise<void> {
  const since = new Date(now.getTime() - PERIOD_GAP_MS);
  await sql`
    WITH extended AS (
      UPDATE alerting_periods SET ended_at = GREATEST(ended_at, ${now})
       WHERE id = (SELECT id FROM alerting_periods WHERE ended_at >= ${since}
                    ORDER BY ended_at DESC LIMIT 1)
      RETURNING id)
    INSERT INTO alerting_periods (id, started_at, ended_at)
    SELECT ${newId()}, ${now}, ${now} WHERE NOT EXISTS (SELECT 1 FROM extended)`.execute(db);
}

/**
 * The times alerting was not running that overlap [from, to]. Only gaps with a known
 * start count: before the first recorded period nothing is claimed. A gap still open
 * at `now` ends with null.
 */
export async function alertingGaps(
  db: Database,
  from: Date,
  to: Date,
  now = Date.now(),
): Promise<AlertingGap[]> {
  // The last period before the window and the first after it bound the gaps at its edges.
  const [before, rows, after] = await Promise.all([
    db
      .selectFrom('alerting_periods')
      .select(['started_at', 'ended_at'])
      .where('ended_at', '<', from)
      .orderBy('ended_at', 'desc')
      .limit(1)
      .execute(),
    db
      .selectFrom('alerting_periods')
      .select(['started_at', 'ended_at'])
      .where('ended_at', '>=', from)
      .where('started_at', '<=', to)
      .orderBy('started_at')
      .execute(),
    db
      .selectFrom('alerting_periods')
      .select(['started_at', 'ended_at'])
      .where('started_at', '>', to)
      .orderBy('started_at')
      .limit(1)
      .execute(),
  ]);
  // Merge periods that overlap or follow each other within the threshold.
  const merged: { start: number; end: number }[] = [];
  for (const p of [...before, ...rows, ...after].sort((a, b) => +a.started_at - +b.started_at)) {
    const start = +p.started_at;
    const end = +p.ended_at;
    const last = merged.at(-1);
    if (last && start - last.end <= PERIOD_GAP_MS) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }
  const gaps: AlertingGap[] = [];
  for (let i = 0; i < merged.length; i++) {
    const end = merged[i]!.end;
    const next = merged[i + 1]?.start;
    if (next !== undefined) {
      if (next - end > PERIOD_GAP_MS) gaps.push({ from: new Date(end), to: new Date(next) });
    } else if (now - end > PERIOD_GAP_MS) {
      gaps.push({ from: new Date(end), to: null });
    }
  }
  return gaps.filter((g) => +g.from <= +to && (g.to === null || +g.to >= +from));
}

export async function prunePeriods(db: Database, cutoff: Date): Promise<void> {
  await db.deleteFrom('alerting_periods').where('ended_at', '<', cutoff).execute();
}
