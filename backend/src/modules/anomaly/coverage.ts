// SPDX-License-Identifier: AGPL-3.0-only
// When What changed is ready (ADR-196's "7 days of data", made exact in ADR-217): the one
// rule, as pure functions, that the anomaly-worker uses to start scoring a series and that
// the page, the alert card, the sidebar, the email, the API and the MCP tool report. No
// clock arithmetic of their own anywhere else.
//
// The week has 168 hours ("slots": the hour-of-week buckets of ADR-196). The worker learns
// one slot with each hourly recompute. A cluster's coverage records, per slot:
//   - `hours`: how many series have a baseline for it (0: nothing learned there);
//   - `lookedAt`: the start of the hour the worker last recomputed for it;
//   - `looks`: how many different hours it has recomputed for it, up to 2.
// A slot is settled once it has a baseline, or once the worker looked at it twice and found
// no data either time (a fleet that is off every night must not learn forever; two looks are
// ADR-196's two occurrences in 14 days).
//   - The cluster is ready when every slot is settled. A week without gaps is exactly 7
//     days; an hour when the org was not on Pro, the worker was not running or the agents
//     sent nothing is not learned, and is made up when that hour of the week comes round.
//   - A series is scored once its cluster is ready, the worker has looked at every slot since
//     the series was first seen, and 7 days have passed since then: exactly 7 days for one
//     that joins a running cluster, as before 0.9.6, and longer only by the gaps.
// What was learned before a gap still counts for as long as the baselines are kept (30 days
// after a downgrade, ADR-198), because the worker really scores with them.
import { BUCKETS, DAY_MS, HOUR_MS, LEARNING_DAYS, WEEK_MS, bucketOf } from './stats.js';

/** Looks without data after which a slot is taken as silent, not as unseen. */
export const SILENT_LOOKS = 2;
/**
 * How long after an hour ends its recompute is done: the worker waits 5 minutes for late
 * samples (worker.ts) and ticks once a minute. Used for "ready about <time>".
 */
export const RECOMPUTE_LAG_MS = 6 * 60_000;
/** A recompute this late didn't happen (the org was off Pro, or the worker was down). */
const MISSED_AFTER_MS = 3 * 60_000;

export interface Coverage {
  hours: number[];
  lookedAt: (number | null)[];
  looks: number[];
  /**
   * When the cluster is ready: every slot settled, and 7 days since its first series. Null
   * while learning; it can be some minutes ahead right after the last slot was learned.
   */
  readyAt: number | null;
  /** The hour learning went on after at least one missed hour; null if it never stopped. */
  resumedAt: number | null;
  /** The cluster's earliest series. */
  firstSeen: number | null;
}

export const emptyCoverage = (): Coverage => ({
  hours: Array<number>(BUCKETS).fill(0),
  lookedAt: Array<number | null>(BUCKETS).fill(null),
  looks: Array<number>(BUCKETS).fill(0),
  readyAt: null,
  resumedAt: null,
  firstSeen: null,
});

export const floorHour = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS;

export const slotLearned = (c: Coverage, slot: number): boolean => (c.hours[slot] ?? 0) > 0;
export const slotSettled = (c: Coverage, slot: number): boolean =>
  slotLearned(c, slot) || (c.looks[slot] ?? 0) >= SILENT_LOOKS;

/** Hours of the week that have a baseline. */
export function learnedHours(c: Coverage): number {
  let n = 0;
  for (let s = 0; s < BUCKETS; s++) if (slotLearned(c, s)) n++;
  return n;
}

/** Whether the cluster's list is on at `nowMs`. */
export const clusterReady = (c: Coverage, nowMs: number): boolean =>
  c.readyAt !== null && c.readyAt <= nowMs;

/** The earliest a series first seen then can be scored: 7 days later (ADR-196). */
const sevenDaysAfter = (firstSeenMs: number): number => firstSeenMs + LEARNING_DAYS * DAY_MS;

export function allSettled(c: Coverage): boolean {
  for (let s = 0; s < BUCKETS; s++) if (!slotSettled(c, s)) return false;
  return true;
}

/** The day of learning, 1 to 7: a day for every 24 hours of the week learned. */
export const learningDay = (c: Coverage): number =>
  Math.min(LEARNING_DAYS, Math.floor(learnedHours(c) / 24) + 1);

/**
 * One recompute of the hour starting at `hourMs`: `withData` series got a baseline for its
 * slot (null: the worker read nothing at all, so what the slot has stays). Recomputing the
 * same hour again changes nothing (the hourly job is idempotent). Returns a new coverage; if
 * this settled the last slot, it is ready from `nowMs`, or from 7 days after its first series
 * if that is still some minutes away.
 */
export function recordLook(
  c: Coverage,
  hourMs: number,
  withData: number | null,
  nowMs: number,
): Coverage {
  const slot = bucketOf(hourMs);
  const next: Coverage = {
    ...c,
    hours: c.hours.slice(),
    lookedAt: c.lookedAt.slice(),
    looks: c.looks.slice(),
  };
  let latest: number | null = null;
  for (const t of c.lookedAt) if (t !== null && (latest === null || t > latest)) latest = t;
  // Going on after a gap (not the demo's look-back, which walks backwards).
  if (latest !== null && hourMs - latest > HOUR_MS && c.readyAt === null) next.resumedAt = hourMs;
  if (withData !== null) next.hours[slot] = withData;
  const before = c.lookedAt[slot] ?? null;
  if (before !== hourMs) next.looks[slot] = Math.min(SILENT_LOOKS, (c.looks[slot] ?? 0) + 1);
  if (before === null || hourMs > before) next.lookedAt[slot] = hourMs;
  if (next.readyAt === null && allSettled(next)) {
    next.readyAt = Math.max(
      nowMs,
      next.firstSeen === null ? nowMs : sevenDaysAfter(next.firstSeen),
    );
  }
  return next;
}

/**
 * The worker's decision for one series at `nowMs`: its cluster is ready, every hour of the
 * week has been recomputed since the hour the series was first seen, and that was at least
 * 7 days ago.
 */
export function seriesReady(c: Coverage, firstSeenMs: number, nowMs: number): boolean {
  if (!clusterReady(c, nowMs) || nowMs < sevenDaysAfter(firstSeenMs)) return false;
  const from = floorHour(firstSeenMs);
  for (let s = 0; s < BUCKETS; s++) {
    const t = c.lookedAt[s] ?? null;
    if (t === null || t < from) return false;
  }
  return true;
}

/** The next hour of a slot the worker hasn't recomputed yet, at or after the last ended hour. */
function nextLook(c: Coverage, slot: number, nowMs: number): number {
  const prev = floorHour(nowMs) - HOUR_MS;
  let h = prev + ((slot - bucketOf(prev) + BUCKETS) % BUCKETS) * HOUR_MS;
  const looked = c.lookedAt[slot] ?? null;
  if (looked !== null && looked >= h) h += WEEK_MS;
  // Its recompute is overdue: it was missed, and the slot comes round in a week.
  else if (h + HOUR_MS + RECOMPUTE_LAG_MS + MISSED_AFTER_MS < nowMs) h += WEEK_MS;
  return h;
}

/**
 * When the cluster will be ready if learning goes on from now without another gap: the
 * recompute of the last slot that isn't settled. The moment it became ready, once it is.
 */
export function estimateReady(c: Coverage, nowMs: number): number {
  if (c.readyAt !== null) return c.readyAt;
  let last = c.firstSeen === null ? nowMs : Math.max(nowMs, sevenDaysAfter(c.firstSeen));
  for (let s = 0; s < BUCKETS; s++) {
    if (slotSettled(c, s)) continue;
    last = Math.max(last, nextLook(c, s, nowMs) + HOUR_MS + RECOMPUTE_LAG_MS);
  }
  return last;
}

/** The same for one series first seen at `firstSeenMs` (a server that joined later). */
export function estimateSeriesReady(c: Coverage, firstSeenMs: number, nowMs: number): number {
  let last = Math.max(estimateReady(c, nowMs), sevenDaysAfter(firstSeenMs));
  const from = floorHour(firstSeenMs);
  for (let s = 0; s < BUCKETS; s++) {
    const t = c.lookedAt[s] ?? null;
    if (t !== null && t >= from) continue;
    last = Math.max(last, nextLook(c, s, nowMs) + HOUR_MS + RECOMPUTE_LAG_MS);
  }
  return last;
}

/**
 * The coverage of a cluster whose baselines were learned before the coverage was recorded
 * (0.8.0 to 0.9.5), from the slots its baselines have:
 *   - first seen less than 7 days ago: each learned slot was learned in its one hour since
 *     then, and nothing else was, so gaps show as they were;
 *   - first seen 7 days ago or more: it was ready under the rule of those versions (7 days
 *     from the first sighting) and stays ready, every slot as looked at within the last week.
 */
export function coverageFromBaselines(
  hours: readonly number[],
  firstSeenMs: number | null,
  nowMs: number,
): Coverage {
  const c = emptyCoverage();
  for (let s = 0; s < BUCKETS; s++) c.hours[s] = hours[s] ?? 0;
  c.firstSeen = firstSeenMs;
  if (firstSeenMs === null) return c;
  const lastEnded = floorHour(nowMs) - HOUR_MS;
  const latestOf = (slot: number) =>
    lastEnded - ((bucketOf(lastEnded) - slot + BUCKETS) % BUCKETS) * HOUR_MS;
  if (nowMs - firstSeenMs >= LEARNING_DAYS * DAY_MS) {
    for (let s = 0; s < BUCKETS; s++) {
      c.lookedAt[s] = latestOf(s);
      c.looks[s] = SILENT_LOOKS;
    }
    c.readyAt = firstSeenMs + LEARNING_DAYS * DAY_MS;
    return c;
  }
  for (let s = 0; s < BUCKETS; s++) {
    if (!slotLearned(c, s)) continue;
    c.lookedAt[s] = Math.max(latestOf(s), floorHour(firstSeenMs));
    c.looks[s] = 1;
  }
  return c;
}

/**
 * The week as 168 characters, UTC, Sunday 00:00 first: `1` learned, `2` looked at twice with
 * no data (nothing to learn there), `0` not seen yet.
 */
export function weekString(c: Coverage): string {
  let out = '';
  for (let s = 0; s < BUCKETS; s++) {
    out += slotLearned(c, s) ? '1' : (c.looks[s] ?? 0) >= SILENT_LOOKS ? '2' : '0';
  }
  return out;
}
