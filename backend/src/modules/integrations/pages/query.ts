// SPDX-License-Identifier: AGPL-3.0-only
// Small helpers the service pages share to read an integration's series (ADR-135).
import { sparkStep } from '../../overview/step.js';
import { anyOf, escapeLabelValue } from '../../query/catalog.js';
import type { QuerySeries } from '../../../lib/victoria.js';
import type { PageContext, Point } from './types.js';

/** The time ranges the service page offers (1h, 6h, 24h, 7d). */
export const PAGE_RANGES = [3600, 21600, 86400, 604800] as const;
/** The list's sparkline covers 6 hours. */
export const SPARK_RANGE = 21600;

/** A matcher for one service's series: the collector labels them service=<integration id>. */
export const one = (id: string) => `service="${escapeLabelValue(id)}"`;
/** A matcher for several services' series. */
export const some = (ids: string[]) => `service=~"${anyOf(ids)}"`;

export interface Window {
  start: number;
  end: number;
  step: number;
}

/** The page's window: aligned to its step so neighbouring reloads share points. */
export function windowOf(range: number, now: number): Window {
  const step = sparkStep(range);
  const end = Math.floor(now / 1000 / step) * step;
  return { start: end - range, end, step };
}

/** A range query, or nothing when VictoriaMetrics isn't configured. */
export async function range(ctx: PageContext, expr: string): Promise<QuerySeries[]> {
  if (!ctx.vm) return [];
  const w = windowOf(ctx.range, ctx.now);
  return ctx.vm.queryRange(ctx.scope, expr, w.start, w.end, w.step);
}

/** An instant query at now. */
export async function instant(ctx: PageContext, expr: string): Promise<QuerySeries[]> {
  if (!ctx.vm) return [];
  return ctx.vm.query(ctx.scope, expr, Math.floor(ctx.now / 1000));
}

/** The single value of an instant query, or null. */
export const valueOf = (series: QuerySeries[]): number | null => series[0]?.points[0]?.[1] ?? null;

/** Points as the page sends them. */
export const pointsOf = (s: QuerySeries | undefined): Point[] => (s ? s.points : []);
