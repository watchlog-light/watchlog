// SPDX-License-Identifier: AGPL-3.0-only
// The usual band of a series for modules (ADR-234): What changed's hour-of-week statistics over
// the 14 days before the hour asked, summed across series, learning under 7 days.
import { describe, expect, it } from 'vitest';
import { usualBands, usualWindow } from '../src/modules/anomaly/usual.js';
import { DAY_MS, HOUR_MS } from '../src/modules/anomaly/stats.js';

const STEP = 300;
/** Five-minute points from `days` days before `to`'s hour, the value given by the hour. */
function points(to: number, days: number, value: (t: number) => number) {
  const { end } = usualWindow(to);
  const out: Array<[number, number]> = [];
  for (let t = end - days * DAY_MS; t < end; t += STEP * 1000) out.push([t, value(t)]);
  return out;
}
const at = Date.UTC(2026, 10, 24, 10, 30); // a Tuesday, 10:30 UTC

describe('usualBands', () => {
  it('gives the hour-of-week median and band, not counting the hour asked', () => {
    // 20 clients at 10:00 on weekdays, 2 at night.
    const series = points(at, 14, (t) => (new Date(t).getUTCHours() === 10 ? 20 : 2));
    // The current hour drops to 0: it isn't in its own baseline.
    series.push([Date.UTC(2026, 10, 24, 10, 0), 0]);
    const [band] = usualBands(series, at, at, 'count', STEP);
    expect(band).toMatchObject({ t: Date.UTC(2026, 10, 24, 10), median: 20, learning: false });
    expect(band!.low).toBeGreaterThan(0);
    expect(band!.high).toBeGreaterThanOrEqual(20);
  });

  it('sums several series per time', () => {
    const a = points(at, 14, () => 3);
    const b = points(at, 14, () => 4);
    const [band] = usualBands([...a, ...b], at, at, 'count', STEP);
    expect(band!.median).toBe(7);
  });

  it('has no band while learning, and leaves out hours with too little behind them', () => {
    // 3 days: this hour of the week hasn't come round yet.
    expect(
      usualBands(
        points(at, 3, () => 5),
        at,
        at,
        'count',
        STEP,
      ),
    ).toEqual([]);
    // Only 10 minutes of the bucket: under the 30 a bucket needs.
    const thin: Array<[number, number]> = [
      [Date.UTC(2026, 10, 17, 10, 0), 5],
      [Date.UTC(2026, 10, 17, 10, 5), 5],
    ];
    expect(usualBands(thin, at, at, 'count', STEP)).toEqual([]);
  });

  it('gives one band per hour over a range', () => {
    const series = points(at, 14, (t) => new Date(t).getUTCHours());
    const bands = usualBands(series, at - 5 * HOUR_MS, at, 'count', STEP);
    expect(bands.map((b) => b.median)).toEqual([5, 6, 7, 8, 9, 10]);
  });
});
