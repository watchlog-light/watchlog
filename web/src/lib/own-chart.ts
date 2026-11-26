// SPDX-License-Identifier: AGPL-3.0-only
// The option of an own-metric chart (1.0.0, ADR-237), apart from the component so it can be
// tested: a smooth line with a soft gradient under a single series, a faint dashed grid, the
// last point marked, the usual range as a soft band; or bars, or stacked areas for a split.
import { breakGaps } from '@/lib/chart-gaps';
import { niceStep } from '@/lib/units';
import { chartPer, writtenText, type Per, type Showing } from '@/lib/own-metrics';

export type OwnShape = 'line' | 'area' | 'bars';

export interface OwnLine {
  name: string;
  points: (number | null)[][];
  /** A design token instead of the palette's colour (the "other" line is muted). */
  colorToken?: string;
}

/** The usual range over time: [unix seconds, low, high]. */
export type OwnBand = (number | null)[][];

export interface OwnMarker {
  ts: number;
  label: string;
}

export interface OwnChartInput {
  lines: OwnLine[];
  showing: Showing;
  shape: OwnShape;
  window: [number, number];
  band?: OwnBand;
  bandName?: string;
  markers?: OwnMarker[];
  /** Small charts (a widget of 3 columns) drop the axis labels' room. */
  compact?: boolean;
}

export interface OwnColors {
  palette: string[];
  token(name: string): string;
}

const lastPoint = (points: (number | null)[][]): [number, number] | null => {
  for (let i = points.length - 1; i >= 0; i--) {
    const [t, v] = points[i]!;
    if (v !== null && v !== undefined && t !== null && t !== undefined) return [t, v];
  }
  return null;
};

/** Bars of a long range are thinned to about 60, each the mean of its bucket. */
export function thin(points: (number | null)[][], max = 60): (number | null)[][] {
  if (points.length <= max) return points;
  const size = Math.ceil(points.length / max);
  const out: (number | null)[][] = [];
  for (let i = 0; i < points.length; i += size) {
    const bucket = points.slice(i, i + size);
    const values = bucket
      .map((p) => p[1])
      .filter((v): v is number => v !== null && v !== undefined);
    out.push([
      bucket[0]![0] ?? 0,
      values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    ]);
  }
  return out;
}

export function ownChartOption(input: OwnChartInput, colors: OwnColors): Record<string, unknown> {
  const { lines, showing, shape, window } = input;
  const muted = colors.token('--text-muted');
  const border = colors.token('--border');
  const surface = colors.token('--surface-1');
  const per: Per | undefined = showing.shown === 'rate' ? chartPer(lines) : undefined;
  const fmt = (v: unknown) => writtenText(typeof v === 'number' ? v : null, showing, per);
  const single = lines.length === 1;
  const stacked = shape === 'area' && !single;
  const colorOf = (l: OwnLine, i: number) =>
    l.colorToken ? colors.token(l.colorToken) : colors.palette[i % colors.palette.length]!;

  // The top of the axis. Stacked series (a split drawn as areas or as bars) reach the sum of
  // the series at each moment, not the largest one: scaled to the largest, everything above it
  // was drawn outside the chart (1.0.1).
  let top = 0;
  if ((shape === 'area' || shape === 'bars') && !single) {
    const sums = new Map<number, number>();
    for (const l of lines)
      for (const [t, v] of shape === 'bars' ? thin(l.points) : l.points)
        if (t !== null && t !== undefined && v !== null && v !== undefined)
          sums.set(t, (sums.get(t) ?? 0) + v);
    for (const v of sums.values()) top = Math.max(top, v);
  } else {
    for (const l of lines) for (const p of l.points) top = Math.max(top, p[1] ?? 0);
  }
  for (const b of input.band ?? []) top = Math.max(top, b[2] ?? 0);
  const step = niceStep(top || 1, 3);

  const band =
    input.band && input.band.length && single && shape !== 'bars'
      ? [
          {
            name: '__band_low',
            type: 'line',
            stack: 'band',
            silent: true,
            symbol: 'none',
            smooth: true,
            lineStyle: { opacity: 0 },
            tooltip: { show: false },
            data: input.band.map(([t, lo]) => [(t ?? 0) * 1000, lo]),
          },
          {
            name: input.bandName ?? '',
            type: 'line',
            stack: 'band',
            silent: true,
            symbol: 'none',
            smooth: true,
            lineStyle: { opacity: 0 },
            areaStyle: { color: colors.token('--text-subtle'), opacity: 0.14 },
            tooltip: { show: false },
            data: input.band.map(([t, lo, hi]) => [
              (t ?? 0) * 1000,
              lo === null || hi === null || lo === undefined || hi === undefined ? null : hi - lo,
            ]),
          },
        ]
      : [];

  const markLine = input.markers?.length
    ? {
        markLine: {
          symbol: 'none',
          animation: false,
          data: input.markers
            .filter((m) => m.ts >= window[0] && m.ts <= window[1])
            .map((m) => ({
              xAxis: m.ts * 1000,
              name: m.label,
              lineStyle: { color: colors.token('--text-subtle'), type: 'dashed', width: 1 },
              label: { show: false },
              emphasis: { label: { show: true, formatter: '{b}', color: muted, fontSize: 12 } },
            })),
        },
      }
    : {};

  const series = lines.map((l, i) => {
    const color = colorOf(l, i);
    const data = (shape === 'bars' ? thin(l.points) : breakGaps(l.points)).map(([t, v]) => [
      (t ?? 0) * 1000,
      v,
    ]);
    if (shape === 'bars') {
      return {
        name: l.name,
        type: 'bar',
        ...(single ? {} : { stack: 'total' }),
        itemStyle: { color, borderRadius: single ? [2, 2, 0, 0] : 0 },
        barMaxWidth: 14,
        data,
        ...(i === 0 ? markLine : {}),
      };
    }
    const last = single ? lastPoint(l.points) : null;
    const filled = single || shape === 'area';
    return {
      name: l.name,
      type: 'line',
      smooth: 0.35,
      smoothMonotone: 'x',
      connectNulls: false,
      showSymbol: l.points.filter((p) => p[1] !== null).length <= 2,
      symbolSize: 6,
      color,
      lineStyle: { width: 2 },
      ...(stacked ? { stack: 'total' } : {}),
      ...(filled
        ? {
            areaStyle: {
              opacity: stacked ? 0.3 : 0.22,
              // Fades into the card: the series' colour at the line, the surface at the axis.
              color: stacked
                ? color
                : {
                    type: 'linear',
                    x: 0,
                    y: 0,
                    x2: 0,
                    y2: 1,
                    colorStops: [
                      { offset: 0, color },
                      { offset: 1, color: surface },
                    ],
                  },
            },
          }
        : {}),
      // The last value, marked: where the number above the chart comes from.
      ...(last
        ? {
            markPoint: {
              silent: true,
              animation: false,
              symbol: 'circle',
              symbolSize: 9,
              itemStyle: { color, borderColor: surface, borderWidth: 2 },
              label: { show: false },
              data: [{ coord: [last[0] * 1000, last[1]] }],
            },
          }
        : {}),
      data,
      ...(i === 0 ? markLine : {}),
    };
  });

  return {
    color: colors.palette,
    animation: false,
    grid: {
      left: 4,
      right: input.compact ? 8 : 14,
      top: single ? 10 : 28,
      bottom: 4,
      containLabel: true,
    },
    legend: {
      show: !single,
      top: 0,
      left: 0,
      // The band's lower edge is scaffolding, not a series.
      data: lines.map((l) => l.name),
      textStyle: { color: muted, fontSize: 12 },
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 3,
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: colors.token('--surface-2'),
      borderColor: border,
      textStyle: { color: colors.token('--text'), fontSize: 12 },
      valueFormatter: fmt,
    },
    xAxis: {
      type: 'time',
      min: window[0] * 1000,
      max: window[1] * 1000,
      axisLine: { lineStyle: { color: border } },
      axisTick: { show: false },
      axisLabel: { color: muted, fontSize: 11, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 0,
      interval: step,
      max: Math.max(step, Math.ceil((top || 1) / step) * step),
      splitNumber: 3,
      axisLabel: { color: muted, fontSize: 11, formatter: fmt },
      // A faint dashed grid: the line is the subject.
      splitLine: { lineStyle: { color: border, type: 'dashed', opacity: 0.7 } },
    },
    series: [...band, ...series],
  };
}

/** What a chart says to someone who can't see it: each line's last value. */
export function chartSummary(lines: OwnLine[], showing: Showing): string {
  const per = showing.shown === 'rate' ? chartPer(lines) : undefined;
  return lines
    .map((l) => {
      const last = lastPoint(l.points);
      const v = writtenText(last ? last[1] : null, showing, per);
      return l.name ? `${l.name}: ${v}` : v;
    })
    .join('; ');
}
