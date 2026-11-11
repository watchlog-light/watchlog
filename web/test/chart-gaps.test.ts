// SPDX-License-Identifier: AGPL-3.0-only
// A chart breaks its line where there is no data (ADR-159): the e2e VM was down from 08:41
// to 08:51 and the CPU line ran straight across, reading as a slow rise.
import { describe, expect, it } from 'vitest';
import { breakGaps, GAP_STEPS, stepOf } from '../src/lib/chart-gaps';

const series = (times: number[]) => times.map((t, i) => [t, i + 1]);

describe('breakGaps', () => {
  it('finds the step: the most common distance between points', () => {
    expect(stepOf(series([0, 60, 120, 180, 900, 960]))).toBe(60);
    expect(stepOf(series([0]))).toBeNull();
  });

  it('puts a null after each gap longer than two steps', () => {
    const pts = series([0, 60, 120, 180, 780, 840, 900]);
    expect(breakGaps(pts)).toEqual([
      [0, 1],
      [60, 2],
      [120, 3],
      [180, 4],
      [240, null],
      [780, 5],
      [840, 6],
      [900, 7],
    ]);
  });

  it('leaves a missed scrape or two alone', () => {
    const pts = series([0, 60, 120, 120 + GAP_STEPS * 60, 360]);
    expect(breakGaps(pts)).toEqual(pts);
  });

  it('keeps nulls the query sent, and short series as they are', () => {
    const pts = [
      [0, 1],
      [60, null],
      [120, 3],
    ];
    expect(breakGaps(pts)).toEqual(pts);
    expect(breakGaps([[0, 1]])).toEqual([[0, 1]]);
  });
});
