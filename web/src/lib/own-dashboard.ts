// SPDX-License-Identifier: AGPL-3.0-only
// A dashboard of own metrics while it is edited (1.0.0, ADR-237): widgets in order on a
// 12-column grid, moved earlier or later, resized to one of five widths. Pure: no I/O.
import type { OwnMetric, OwnWidget, OwnWidgetInput } from '@watchlog/api-types';
import type { OwnShape } from '@/lib/own-chart';

export type WidgetShape = OwnWidget['shape'];
export type WidgetWidth = OwnWidget['w'];

export const SHAPES: WidgetShape[] = ['number', 'line', 'area', 'bars'];
/** The widths a widget may take, of 12 columns. */
export const WIDTHS: WidgetWidth[] = [3, 4, 6, 8, 12];
/** The three sizes the editor names; 4 and 8 are "a third" and "two thirds" (8 beside a 4). */
export const SIZES: { key: 'small' | 'third' | 'medium' | 'twoThirds' | 'wide'; w: WidgetWidth }[] =
  [
    { key: 'small', w: 3 },
    { key: 'third', w: 4 },
    { key: 'medium', w: 6 },
    { key: 'twoThirds', w: 8 },
    { key: 'wide', w: 12 },
  ];

/** A new widget's id: short, unique within a dashboard. */
export function newWidgetId(taken: readonly { id: string }[] = []): string {
  for (;;) {
    const id = `w${Math.random().toString(36).slice(2, 10)}`;
    if (!taken.some((w) => w.id === id)) return id;
  }
}

/** A widget for a metric, as the editor starts it: a line, medium, titled by the metric's words. */
export function widgetFor(
  metric: Pick<
    OwnMetric,
    'id' | 'name' | 'words' | 'type' | 'unit' | 'shown' | 'labels' | 'refused' | 'series' | 'value'
  >,
  clusterId: string,
  clusterName: string,
  taken: readonly { id: string }[] = [],
): OwnWidget {
  return {
    id: newWidgetId(taken),
    clusterId,
    clusterName,
    metric: metric.name,
    title: metric.words,
    shape: metric.shown === 'time_since' ? 'number' : 'line',
    by: null,
    w: metric.shown === 'time_since' ? 3 : 6,
    resolved: {
      id: metric.id,
      name: metric.name,
      words: metric.words,
      type: metric.type,
      unit: metric.unit,
      shown: metric.shown,
      labels: metric.labels,
      refused: metric.refused,
      series: metric.series,
      value: metric.value,
    },
  };
}

/** Moves a widget one place earlier (-1) or later (+1); the same list when it can't move. */
export function moveBy<T extends { id: string }>(list: readonly T[], id: string, by: -1 | 1): T[] {
  const i = list.findIndex((w) => w.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** Moves a widget to the place of another (a drag over it). */
export function moveOnto<T extends { id: string }>(
  list: readonly T[],
  id: string,
  onto: string,
): T[] {
  const from = list.findIndex((w) => w.id === id);
  const to = list.findIndex((w) => w.id === onto);
  if (from < 0 || to < 0 || from === to) return [...list];
  const out = [...list];
  const [w] = out.splice(from, 1);
  out.splice(to, 0, w!);
  return out;
}

/** The width nearest to a share of the grid's width (a corner dragged to there). */
export function snapWidth(share: number): WidgetWidth {
  const cols = Math.max(0, Math.min(1, share)) * 12;
  let best = WIDTHS[0]!;
  for (const w of WIDTHS) if (Math.abs(w - cols) < Math.abs(best - cols)) best = w;
  return best;
}

/** The next width up or down (the keyboard's and the buttons' resize). */
export function stepWidth(w: WidgetWidth, by: -1 | 1): WidgetWidth {
  const i = WIDTHS.indexOf(w) + by;
  return WIDTHS[Math.max(0, Math.min(WIDTHS.length - 1, i))]!;
}

/** What is sent when a dashboard is saved: the widget without what the server resolved. */
export function toInput(w: OwnWidget): OwnWidgetInput {
  return {
    id: w.id,
    clusterId: w.clusterId,
    metric: w.metric,
    title: w.title,
    shape: w.shape,
    by: w.by,
    w: w.w,
  };
}

/** Whether the draft differs from what is saved (order, sizes, titles, anything sent). */
export function changed(saved: readonly OwnWidget[], draft: readonly OwnWidget[]): boolean {
  return JSON.stringify(saved.map(toInput)) !== JSON.stringify(draft.map(toInput));
}

/** The chart shape of a widget's shape; a number has none. */
export function chartShape(shape: WidgetShape): OwnShape {
  return shape === 'area' ? 'area' : shape === 'bars' ? 'bars' : 'line';
}

/** What a widget can't show, in the order it is checked. */
export type WidgetProblem = 'gone' | 'refused' | 'cluster' | null;
export function problemOf(w: OwnWidget): WidgetProblem {
  if (w.clusterName === null) return 'cluster';
  if (!w.resolved) return 'gone';
  if (w.resolved.refused && w.resolved.series === 0) return 'refused';
  return null;
}

/** The last value of each line, highest first: a split shown as ranked bars. */
export function ranked(
  lines: readonly { name: string; points: (number | null)[][]; other?: boolean }[],
): { name: string; value: number | null; share: number; other: boolean }[] {
  const rows = lines.map((l) => {
    let value: number | null = null;
    for (let i = l.points.length - 1; i >= 0; i--) {
      const v = l.points[i]![1];
      if (v !== null && v !== undefined) {
        value = v;
        break;
      }
    }
    return { name: l.name, value, other: !!l.other };
  });
  const max = Math.max(0, ...rows.map((r) => r.value ?? 0));
  return rows
    .sort((a, b) => Number(a.other) - Number(b.other) || (b.value ?? -1) - (a.value ?? -1))
    .map((r) => ({ ...r, share: max > 0 ? Math.max(0, r.value ?? 0) / max : 0 }));
}
