// SPDX-License-Identifier: AGPL-3.0-only
// Daily partitions of k8s_events (ADR-061): created a few days ahead, dropped once
// they fall out of the retention period.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

const DAY_MS = 86_400_000;
/** Partitions kept ahead of today (UTC). */
export const DAYS_AHEAD = 3;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const partitionName = (day: string) => `k8s_events_${day.replaceAll('-', '')}`;

/** UTC day of a timestamp, as YYYY-MM-DD. */
export function utcDay(t: Date): string {
  return iso(t);
}

export async function ensureEventPartitions(
  db: Database,
  retentionDays: number,
  now = new Date(),
): Promise<{ created: string[]; dropped: string[] }> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const created: string[] = [];
  // From the oldest retained day: events may arrive late (agent buffer, restarts).
  for (let d = -retentionDays; d <= DAYS_AHEAD; d++) {
    const from = iso(new Date(today + d * DAY_MS));
    const to = iso(new Date(today + (d + 1) * DAY_MS));
    const name = partitionName(from);
    const exists = await sql<{
      n: number;
    }>`select 1 as n from pg_class where relname = ${name}`.execute(db);
    if (exists.rows.length > 0) continue;
    await sql`create table if not exists ${sql.table(name)} partition of k8s_events for values from (${sql.lit(from)}) to (${sql.lit(to)})`.execute(
      db,
    );
    created.push(name);
  }
  const oldest = partitionName(iso(new Date(today - retentionDays * DAY_MS)));
  const parts = await sql<{ name: string }>`
    select c.relname as name from pg_inherits i
    join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent
    where p.relname = 'k8s_events'`.execute(db);
  const dropped: string[] = [];
  for (const { name } of parts.rows) {
    // Names sort by date (k8s_events_YYYYMMDD).
    if (/^k8s_events_\d{8}$/.test(name) && name < oldest) {
      await sql`drop table if exists ${sql.table(name)}`.execute(db);
      dropped.push(name);
    }
  }
  return { created, dropped };
}

/** Oldest and newest day (UTC) that have partitions under the retention policy. */
export function retainedDays(
  retentionDays: number,
  now = new Date(),
): { oldest: string; newest: string } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    oldest: iso(new Date(today - retentionDays * DAY_MS)),
    newest: iso(new Date(today + DAYS_AHEAD * DAY_MS)),
  };
}
