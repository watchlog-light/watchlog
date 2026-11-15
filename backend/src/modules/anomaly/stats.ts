// SPDX-License-Identifier: AGPL-3.0-only
// What changed's statistics (ADR-196): the median and MAD of each hour of the week (UTC),
// the score `|value − median| / max(1.4826 × MAD, floor)`, the floor per metric kind, and
// the 10-minute rule. Pure functions: no clock, no I/O.
import type { Unit } from '../query/catalog.js';

/** Hour-of-week buckets: Sunday 00:00 UTC is 0, Saturday 23:00 UTC is 167. */
export const BUCKETS = 168;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
/** The window a baseline covers: two occurrences of each hour of the week (ADR-196). */
export const WINDOW_DAYS = 14;
/** A series is scored only after this much data; until then it is learning (ADR-196). */
export const LEARNING_DAYS = 7;
/** A bucket needs this many minutes behind it to be scored (slice 1's spreads used 30). */
export const MIN_BUCKET_MINUTES = 30;
/** MAD to a normal distribution's standard deviation. */
export const MAD_SCALE = 1.4826;
/** The share of the median a floor is at least (ADR-196). */
export const FLOOR_SHARE = 0.05;

/**
 * The absolute floor per metric kind, measured in slice 1 (ADR-196's as-built): cores 0.05,
 * bytes 32 MiB, ratios 0.02, bytes a second 100 KiB/s, rates 0.5 a second, seconds 0.05,
 * counts 2. `load` is not scored; it gets a floor anyway so no unit divides by zero.
 */
export const DEFAULT_FLOORS: Record<Unit, number> = {
  cores: 0.05,
  bytes: 32 * 2 ** 20,
  ratio: 0.02,
  bytes_per_second: 100 * 2 ** 10,
  per_second: 0.5,
  seconds: 0.05,
  count: 2,
  load: 0.5,
};

/** The rule's two numbers: past `score` for `minutes` consecutive minutes (ADR-196). */
export interface Rule {
  score: number;
  minutes: number;
  floors: Record<Unit, number>;
}

export const DEFAULT_RULE: Rule = { score: 4, minutes: 10, floors: DEFAULT_FLOORS };

/** The hour-of-week bucket of a time (UTC). */
export function bucketOf(ms: number): number {
  const d = new Date(ms);
  return d.getUTCDay() * 24 + d.getUTCHours();
}

/** The median of the values (sorts a copy). NaN for none. */
export function median(values: ArrayLike<number>): number {
  if (!values.length) return Number.NaN;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The median and the median absolute deviation of a bucket's minute values. */
export function medianAndMad(values: ArrayLike<number>): { median: number; mad: number } {
  const med = median(values);
  const dev = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) dev[i] = Math.abs(values[i]! - med);
  return { median: med, mad: median(dev) };
}

/** The score's denominator: the spread, or the floor when the series is flatter than it. */
export function spreadOf(med: number, mad: number, unit: Unit, rule: Rule = DEFAULT_RULE): number {
  const floor = Math.max(rule.floors[unit] ?? 0, FLOOR_SHARE * Math.abs(med));
  return Math.max(MAD_SCALE * mad, floor);
}

/** How unusual a value is for its bucket (ADR-196). */
export function scoreOf(
  value: number,
  med: number,
  mad: number,
  unit: Unit,
  rule: Rule = DEFAULT_RULE,
): number {
  return Math.abs(value - med) / spreadOf(med, mad, unit, rule);
}

/**
 * The usual range shown on the page, in alerts and in the API: median ± 2 spreads, the
 * spread being the score's denominator, so a value inside it scores 2 or less. Every scored
 * unit is non-negative, so the low end is clipped at 0.
 */
export function usualRange(
  med: number,
  mad: number,
  unit: Unit,
  rule: Rule = DEFAULT_RULE,
): { low: number; high: number } {
  const s = spreadOf(med, mad, unit, rule);
  return { low: Math.max(0, med - 2 * s), high: med + 2 * s };
}

/** One minute's score, or null when the series had no value or no usable baseline then. */
export interface Minute {
  t: number;
  value: number | null;
  score: number | null;
}

/** What the minute's window says about a series' unusual period. */
export type Verdict =
  { kind: 'open'; startedAt: number } | { kind: 'end'; endedAt: number } | { kind: 'none' };

/**
 * The 10-minute rule over the last minutes, oldest first (ADR-196): a run of `rule.minutes`
 * scores past `rule.score` ending at the newest minute opens a period (started at the run's
 * first minute); `rule.minutes` minutes with none past it end an open one (at the first of
 * them). A missing minute breaks a run and counts as not unusual: a series that stops
 * reporting ends its period.
 */
export function verdict(minutes: Minute[], open: boolean, rule: Rule = DEFAULT_RULE): Verdict {
  const last = minutes.slice(-rule.minutes);
  if (last.length < rule.minutes) return { kind: 'none' };
  const past = (m: Minute) => m.score !== null && m.score > rule.score;
  if (!open && last.every(past)) {
    // The run may have begun before the window: walk back while it holds.
    let i = minutes.length - rule.minutes;
    while (i > 0 && past(minutes[i - 1]!)) i--;
    return { kind: 'open', startedAt: minutes[i]!.t };
  }
  if (open && !last.some(past)) return { kind: 'end', endedAt: last[0]!.t };
  return { kind: 'none' };
}
