// SPDX-License-Identifier: AGPL-3.0-only
// The own-metric chart's axis (1.0.1): a split drawn as stacked areas or stacked bars reaches
// the sum of its series, so the axis is scaled to that sum. Scaled to the largest series, as
// 1.0.0 did, the series above it were drawn outside the chart ("Orders by payment method" on
// the demo's dashboard showed card and a blue band cut off at the top).
import { describe, expect, it } from 'vitest';
import { ownChartOption, type OwnChartInput } from '@/lib/own-chart';

const colors = { palette: ['a', 'b', 'c'], token: (name: string) => name };
const gauge = { unit: 'count', shown: 'as_is' } as OwnChartInput['showing'];
const at = (values: number[]) => values.map((v, i) => [1_700_000_000 + i * 60, v]);
const three = [
  { name: 'card', points: at([20, 21, 22, 21]) },
  { name: 'paypal', points: at([8, 9, 8, 9]) },
  { name: 'cash', points: at([4, 4, 5, 4]) },
];
const input = (over: Partial<OwnChartInput>): OwnChartInput => ({
  lines: three,
  showing: gauge,
  shape: 'area',
  window: [1_700_000_000, 1_700_000_180],
  ...over,
});
const axis = (o: Record<string, unknown>) =>
  o.yAxis as { max: number; interval: number; min: number };
const stacks = (o: Record<string, unknown>) =>
  (o.series as { name: string; stack?: string }[])
    .filter((s) => !s.name.startsWith('__'))
    .map((s) => s.stack ?? null);

describe('the own-metric chart’s axis', () => {
  it('stacked areas: the axis holds the sum at its highest moment, not the largest series', () => {
    const o = ownChartOption(input({ shape: 'area' }), colors);
    expect(stacks(o)).toEqual(['total', 'total', 'total']);
    // 22 + 8 + 5 = 35 at the third point; the largest series alone is 22.
    expect(axis(o).max).toBeGreaterThanOrEqual(35);
    expect(axis(o).max).toBeLessThan(35 * 1.5);
    expect(axis(o).max % axis(o).interval).toBe(0);
    expect(axis(o).min).toBe(0);
  });

  it('stacked bars: the same', () => {
    const o = ownChartOption(input({ shape: 'bars' }), colors);
    expect(stacks(o)).toEqual(['total', 'total', 'total']);
    expect(axis(o).max).toBeGreaterThanOrEqual(35);
  });

  it('lines are not stacked: the axis follows the largest series', () => {
    const o = ownChartOption(input({ shape: 'line' }), colors);
    expect(stacks(o)).toEqual([null, null, null]);
    expect(axis(o).max).toBeGreaterThanOrEqual(22);
    expect(axis(o).max).toBeLessThan(35);
  });

  it('one series: its own highest point, and the usual range when it is higher', () => {
    const one = [three[0]!];
    expect(axis(ownChartOption(input({ lines: one }), colors)).max).toBeLessThan(35);
    const band = at([0, 0, 0, 0]).map(([t]) => [t!, 10, 60]);
    expect(
      axis(ownChartOption(input({ lines: one, band, bandName: 'usual' }), colors)).max,
    ).toBeGreaterThanOrEqual(60);
  });

  it('a series with gaps adds only what it has at each moment', () => {
    const gappy = [
      { name: 'a', points: at([10, 10, 10, 10]) },
      {
        name: 'b',
        points: [
          [1_700_000_000, 5],
          [1_700_000_060, null],
          [1_700_000_120, 30],
        ],
      },
    ];
    const o = ownChartOption(input({ lines: gappy }), colors);
    expect(axis(o).max).toBeGreaterThanOrEqual(40);
  });
});
