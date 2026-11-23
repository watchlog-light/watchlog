// SPDX-License-Identifier: AGPL-3.0-only
// The units an Enterprise licence counts (ADR-232): Kubernetes nodes plus servers, from the
// hourly usage rows (usage_hourly, which the alert-worker records on a licensed install as
// Cloud does for its bill), as the highest daily count of the last 7 days. A day's count is
// its busiest hour. The network module (next release) adds its devices through
// `registerUnitSource`, access points free, so the one count stays here.
//
// Over the limit: Owners see it at once; core monitoring never stops. After 30 days in a row
// over the limit, licensed features take on no new places (and no new devices); everything
// they already cover keeps working. A day at or under the limit ends the run.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

const DAY_MS = 86_400_000;
/** The window the licence's count is the highest daily count of. */
export const UNIT_WINDOW_DAYS = 7;
/** Days over the limit, in a row, before licensed features stop taking on new places. */
export const OVER_LIMIT_DAYS = 30;
/** Days of history read: enough to see a run of 30 days, and a little more. */
const HISTORY_DAYS = OVER_LIMIT_DAYS + UNIT_WINDOW_DAYS + 3;

export interface DayCount {
  /** The UTC day, YYYY-MM-DD. */
  day: string;
  units: number;
  /** What made the units: nodes, servers, and each extra source by name. */
  parts: Record<string, number>;
}

/** More units from outside the core: network devices (ee/, next release). */
export interface UnitSource {
  name: string;
  /** Each UTC day's count in [fromMs, toMs), keyed YYYY-MM-DD. */
  daily(db: Database, fromMs: number, toMs: number): Promise<Map<string, number>>;
}

const sources: UnitSource[] = [];
export function registerUnitSource(s: UnitSource): void {
  if (!sources.some((x) => x.name === s.name)) sources.push(s);
}
/** Tests only. */
export function clearUnitSources(): void {
  sources.length = 0;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Every UTC day's count in the history window, oldest first; days without data count 0. */
export async function dailyUnits(db: Database, nowMs: number): Promise<DayCount[]> {
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const from = today - (HISTORY_DAYS - 1) * DAY_MS;
  const to = today + DAY_MS;
  // The installation's busiest hour each day, across its orgs (a licence covers them all).
  const rows = await db
    .selectFrom('usage_hourly')
    .select([
      'hour',
      sql<number>`sum(nodes)::int`.as('nodes'),
      sql<number>`sum(docker_hosts)::int`.as('servers'),
    ])
    .where('hour', '>=', new Date(from))
    .where('hour', '<', new Date(to))
    .groupBy('hour')
    .execute();
  const best = new Map<string, { nodes: number; servers: number }>();
  for (const r of rows) {
    const d = dayOf(new Date(r.hour).getTime());
    const b = best.get(d);
    if (!b || r.nodes + r.servers > b.nodes + b.servers) {
      best.set(d, { nodes: r.nodes, servers: r.servers });
    }
  }
  const extra = await Promise.all(
    sources.map(async (s) => [s.name, await s.daily(db, from, to)] as const),
  );
  const out: DayCount[] = [];
  for (let t = from; t < to; t += DAY_MS) {
    const d = dayOf(t);
    const b = best.get(d) ?? { nodes: 0, servers: 0 };
    const parts: Record<string, number> = { nodes: b.nodes, servers: b.servers };
    for (const [name, m] of extra) parts[name] = m.get(d) ?? 0;
    out.push({ day: d, units: Object.values(parts).reduce((a, n) => a + n, 0), parts });
  }
  return out;
}

export interface UnitsState {
  /** The licence's count: the highest daily count of the last 7 days. */
  used: number;
  /** The day it was reached, and what it was made of. */
  peak: DayCount | null;
  limit: number;
  over: boolean;
  /** The first day of the current run of days over the limit; null when not over. */
  overSince: string | null;
  /** Days in that run (today included). */
  overDays: number;
  /** 30 days in a row over: no new places for licensed features, from this moment. */
  closedSince: string | null;
}

/**
 * The count and the over-limit rule, on given days (oldest first, ending today). Pure, so the
 * 30-day rule is tested on generated days. A day is over when its count is above the limit;
 * the run counts back from today (or yesterday, as today is still being counted) until a day
 * at or under the limit.
 */
export function unitsState(days: DayCount[], limit: number): UnitsState {
  const recent = days.slice(-UNIT_WINDOW_DAYS);
  let peak: DayCount | null = null;
  for (const d of recent) if (!peak || d.units > peak.units) peak = d;
  const used = peak?.units ?? 0;
  // Today's count is still growing: a today under the limit doesn't end yesterday's run.
  let i = days.length - 1;
  if (i >= 0 && days[i]!.units <= limit) i--;
  let run = 0;
  while (i - run >= 0 && days[i - run]!.units > limit) run++;
  const overSince = run > 0 ? days[i - run + 1]!.day : null;
  const over = used > limit;
  const closedSince =
    run >= OVER_LIMIT_DAYS && overSince
      ? new Date(Date.parse(`${overSince}T00:00:00Z`) + OVER_LIMIT_DAYS * DAY_MS)
          .toISOString()
          .slice(0, 10)
      : null;
  return {
    used,
    peak,
    limit,
    over,
    overSince: over ? overSince : null,
    overDays: over ? run : 0,
    closedSince,
  };
}

/** The installation's count and the rule now. */
export async function countUnits(db: Database, nowMs: number, limit: number): Promise<UnitsState> {
  return unitsState(await dailyUnits(db, nowMs), limit);
}
