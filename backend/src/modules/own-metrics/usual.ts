// SPDX-License-Identifier: AGPL-3.0-only
// The usual range of a watched own metric (1.0.0, ADR-238): What changed's own statistics
// (the median and spread of each hour of the week over 14 days, learning for the first 7;
// ADR-196, ADR-204) on the metric's own expression. The 14-day window is read once an hour per
// expression and kept in memory; nothing is stored.
import type { ClusterScope, VictoriaQueryClient } from '../../lib/victoria.js';
import { usualBands, usualWindow, type UsualBand } from '../anomaly/usual.js';
import type { Unit } from '../query/catalog.js';

/** Five-minute points: 4,032 per series over the 14 days. */
const STEP_S = 300;
const CACHE_MAX = 500;

/** A metric's usual range for this hour as the pages show it. */
export interface UsualNow {
  low: number | null;
  high: number | null;
  /** Its first week isn't over: nothing is "usual" yet. */
  learning: boolean;
}

export class OwnUsual {
  private readonly cache = new Map<string, { at: number; points: Array<[number, number]> }>();

  constructor(private readonly victoria: VictoriaQueryClient | null | undefined) {}

  /** Each hour's band from `from` to `to` (ms); empty while there isn't enough behind it. */
  async bands(
    scope: ClusterScope,
    clusterId: string,
    expr: string,
    from: number,
    to: number,
    unit: Unit,
  ): Promise<UsualBand[]> {
    if (!this.victoria) return [];
    const { start, end } = usualWindow(to);
    const key = `${clusterId}|${expr}`;
    let hit = this.cache.get(key);
    if (!hit || hit.at !== end) {
      const series = await this.victoria.queryRange(scope, expr, start / 1000, end / 1000, STEP_S);
      const points: Array<[number, number]> = [];
      for (const s of series)
        for (const [t, v] of s.points) if (v !== null) points.push([t * 1000, v]);
      hit = { at: end, points };
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, hit);
    }
    return usualBands(hit.points, from, to, unit, STEP_S);
  }

  /** The range of the hour `at` is in, as a page shows it; learning while there is none. */
  async shown(
    scope: ClusterScope,
    clusterId: string,
    expr: string,
    at: number,
    unit: Unit,
  ): Promise<UsualNow> {
    const band = await this.now(scope, clusterId, expr, at, unit).catch(() => null);
    return band && !band.learning
      ? { low: band.low, high: band.high, learning: false }
      : { low: null, high: null, learning: true };
  }

  /** The band of the hour `at` is in, or null (still learning counts: `learning` says so). */
  async now(
    scope: ClusterScope,
    clusterId: string,
    expr: string,
    at: number,
    unit: Unit,
  ): Promise<UsualBand | null> {
    const bands = await this.bands(scope, clusterId, expr, at, at, unit);
    return bands.at(-1) ?? null;
  }
}
