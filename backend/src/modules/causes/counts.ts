// SPDX-License-Identifier: AGPL-3.0-only
// Counting over the counted hour (evidence.ts, EvMetrics): a counter's increase from its range
// points, and the runs of a memory series between restarts (its trend). Pure, so the rules'
// numbers ("4 restarts in the last hour", "grows about 50 MiB a minute") are tested on their
// own. Slice 0 measured why the API's own numbers don't do: Docker events are aggregated per
// container and reason since the container's first one, and `restartsInRange` always covers
// the hour before now, whatever the window.
import type { EvCount } from './evidence.js';

export type Point = [number, number | null];

/**
 * The increase of a counter over its points: every rise, and the value after a reset (a
 * re-created container starts again from 0). The first point is the baseline, unless it is
 * the first of an object created at `bornAt` (unix s) inside the range: its restarts all
 * happened there. (A Docker series is keyed by the container's name, so its first points
 * may be an earlier container's of the same name: those stay the baseline.)
 */
export function increase(points: Point[], bornAt: number | null = null, step = 15): EvCount {
  const pts = points.filter((p): p is [number, number] => p[1] !== null && Number.isFinite(p[1]));
  let n = 0;
  let first: number | null = null;
  let last: number | null = null;
  const rise = (t: number, by: number) => {
    if (by <= 0) return;
    n += by;
    first ??= t;
    last = t;
  };
  if (pts.length && bornAt !== null && pts[0]![0] >= bornAt - 2 * step)
    rise(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) {
    const [t, v] = pts[i]!;
    const prev = pts[i - 1]![1];
    rise(t, v >= prev ? v - prev : v);
  }
  return { n: Math.round(n), first, last };
}

/** Adds counts of several series (a workload's pods, a Compose service's containers). */
export function sumCounts(counts: EvCount[]): EvCount {
  const firsts = counts.map((c) => c.first).filter((t): t is number => t !== null);
  const lasts = counts.map((c) => c.last).filter((t): t is number => t !== null);
  return {
    n: counts.reduce((n, c) => n + c.n, 0),
    first: firsts.length ? Math.min(...firsts) : null,
    last: lasts.length ? Math.max(...lasts) : null,
  };
}

/** One run of a container between two restarts, as its memory series shows it. */
export interface Run {
  start: number;
  end: number;
  /** Working set at the run's first and highest point (bytes). */
  low: number;
  peak: number;
  points: number;
  /** The run ended with a drop (a kill or restart), not with the range. */
  ended: boolean;
}

/** A drop to below this share of the previous point is a restart, not memory freed. */
const DROP_RATIO = 0.5;

/** The runs of a working-set series: split where it drops by half or more, or has a gap. */
export function runsOf(points: [number, number][], step: number): Run[] {
  const runs: Run[] = [];
  let cur: Run | null = null;
  let prevT = 0;
  let prevV = 0;
  for (const [t, v] of points) {
    const gap = cur && t - prevT > 3 * step;
    if (cur && (gap || v < prevV * DROP_RATIO)) {
      cur.ended = true;
      runs.push(cur);
      cur = null;
    }
    if (!cur) cur = { start: t, end: t, low: v, peak: v, points: 0, ended: false };
    cur.end = t;
    cur.points++;
    cur.peak = Math.max(cur.peak, v);
    prevT = t;
    prevV = v;
  }
  if (cur) runs.push(cur);
  return runs;
}

export interface Trend {
  /** Growth after each start, bytes a minute (the median of the runs). */
  perMinute: number;
  /** Minutes from a start to the limit at that growth, at least 1. */
  minutes: number;
  /** The runs it is drawn from. */
  runs: number;
}

/** Runs needed before a trend is said: one run is one data point, not a pattern. */
export const MIN_TREND_RUNS = 2;
/** A run's peak must come this close to the limit (scrapes every 15 s miss the very top). */
const NEAR_LIMIT = 0.6;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * How fast memory climbs to the limit after each start, when the data shows it: at least
 * two runs that ended with a drop, each with three points or more, climbing from well below
 * the limit to near it, at growth rates within a factor of two of each other. Else null:
 * the rule says "limit reached" from the termination reason and never invents a number.
 */
export function memoryTrend(points: [number, number][], limit: number, step: number): Trend | null {
  if (!(limit > 0)) return null;
  const climbs = runsOf(points, step).filter(
    (r) =>
      r.ended &&
      r.points >= 3 &&
      r.peak >= NEAR_LIMIT * limit &&
      r.peak - r.low >= 0.3 * limit &&
      r.end > r.start,
  );
  if (climbs.length < MIN_TREND_RUNS) return null;
  const rates = climbs.map((r) => ((r.peak - r.low) / (r.end - r.start)) * 60);
  const lo = Math.min(...rates);
  const hi = Math.max(...rates);
  if (!(lo > 0) || hi > 2 * lo) return null;
  const perMinute = median(rates);
  const low = median(climbs.map((r) => r.low));
  return {
    perMinute,
    minutes: Math.max(1, Math.round((limit - low) / perMinute)),
    runs: climbs.length,
  };
}

/** Seconds between restarts, when there are enough of them to say "about every …". */
export function interval(c: EvCount | null): number | null {
  if (!c || c.n < 3 || c.first === null || c.last === null || c.last <= c.first) return null;
  return Math.round((c.last - c.first) / (c.n - 1));
}
