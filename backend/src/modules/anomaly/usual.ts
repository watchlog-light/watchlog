// SPDX-License-Identifier: AGPL-3.0-only
// The usual band of any series, with What changed's own statistics (ADR-196): the median and
// MAD of each hour of the week over the last 14 days, the band median ± 2 spreads. Modules ask
// for it through the host (ADR-234): an access point that usually has clients at this hour, a
// recorder's usual write rate. Pure: the caller gives the points.
import type { Unit } from '../query/catalog.js';
import {
  bucketOf,
  HOUR_MS,
  DAY_MS,
  LEARNING_DAYS,
  MIN_BUCKET_MINUTES,
  medianAndMad,
  usualRange,
  WINDOW_DAYS,
} from './stats.js';

/** An hour's usual band. `learning` until the series has 7 days behind it. */
export interface UsualBand {
  /** The hour's start (ms). */
  t: number;
  median: number;
  low: number;
  high: number;
  learning: boolean;
}

/**
 * The window to read for bands up to `to`: the 14 days before `to`'s hour. The hour `to` is in
 * isn't part of its own baseline, so an outage now doesn't lower what is usual.
 */
export function usualWindow(to: number): { start: number; end: number } {
  const end = Math.floor(to / HOUR_MS) * HOUR_MS;
  return { start: end - WINDOW_DAYS * DAY_MS, end };
}

/**
 * Each hour's band from `from` to `to` (hour starts), from points `[t ms, value]` of the
 * window (`usualWindow(to)`), several series summed per time. Hours whose bucket has too few
 * minutes behind it are left out; `stepS` is the points' step.
 */
export function usualBands(
  points: Array<[number, number]>,
  from: number,
  to: number,
  unit: Unit,
  stepS: number,
): UsualBand[] {
  const { start, end } = usualWindow(to);
  const sums = new Map<number, number>();
  let first = Infinity;
  for (const [t, v] of points) {
    if (t < start || t >= end || !Number.isFinite(v)) continue;
    sums.set(t, (sums.get(t) ?? 0) + v);
    if (t < first) first = t;
  }
  const byBucket = new Map<number, number[]>();
  for (const [t, v] of sums) {
    const b = bucketOf(t);
    let list = byBucket.get(b);
    if (!list) byBucket.set(b, (list = []));
    list.push(v);
  }
  const learning = !(end - first >= LEARNING_DAYS * DAY_MS);
  const enough = Math.ceil((MIN_BUCKET_MINUTES * 60) / Math.max(stepS, 1));
  const out: UsualBand[] = [];
  for (let t = Math.floor(from / HOUR_MS) * HOUR_MS; t <= to; t += HOUR_MS) {
    const values = byBucket.get(bucketOf(t));
    if (!values || values.length < enough) continue;
    const { median, mad } = medianAndMad(values);
    out.push({ t, median, ...usualRange(median, mad, unit), learning });
  }
  return out;
}
