// SPDX-License-Identifier: AGPL-3.0-only
// The service page's panels (ADR-135): the backend fills them, these helpers draw them.
import type { Panel } from '@watchlog/api-types';

export type Severity = 'ok' | 'info' | 'warning' | 'critical';
/** The panel of a kind ('line' and 'stack' share one shape). */
export type PanelOf<K extends Panel['kind']> = Panel extends infer P
  ? P extends { kind: infer PK }
    ? K extends PK
      ? P
      : never
    : never
  : never;

/** The page's own time ranges (the mock-up's 1h, 6h, 24h, 7d), in seconds. */
export const PAGE_RANGES = [
  { label: '1h', seconds: 3600 },
  { label: '6h', seconds: 21600 },
  { label: '24h', seconds: 86400 },
  { label: '7d', seconds: 604800 },
] as const;
export type PageRange = (typeof PAGE_RANGES)[number]['seconds'];

export function rangeOf(v: unknown): PageRange {
  const n = Number(v);
  return (PAGE_RANGES.find((r) => r.seconds === n)?.seconds ?? 3600) as PageRange;
}

/** A status colour token; text stays in text tokens beside it. */
export const SEVERITY_TOKEN: Record<Severity, string> = {
  ok: '--ok',
  info: '--info',
  warning: '--warning',
  critical: '--critical',
};

/** Text classes for a value whose severity matters (stat tiles, table cells). */
export const SEVERITY_TEXT: Record<Severity, string> = {
  ok: 'text-text',
  info: 'text-text',
  warning: 'text-warning',
  critical: 'text-critical',
};

/** Categorical identity, in the fixed token order (never cycled past 8). */
export const chartToken = (i: number) => `--chart-${(i % 8) + 1}`;

/**
 * An hour × weekday grid from hourly points (unix seconds): the mean of each local
 * weekday and hour, Monday first, and the largest value for the colour scale.
 */
export function heatGrid(
  points: (number | null)[][],
  tz?: string,
): { cells: (number | null)[][]; max: number } {
  const sum = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const n = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const fmt = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone: tz,
  });
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (const [t, v] of points) {
    if (t === null || t === undefined || v === null || v === undefined) continue;
    const parts = fmt.formatToParts(new Date(t * 1000));
    const day = DAYS.indexOf(parts.find((p) => p.type === 'weekday')?.value ?? '');
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    if (day < 0 || !(hour >= 0 && hour < 24)) continue;
    sum[day]![hour]! += v;
    n[day]![hour]! += 1;
  }
  let max = 0;
  const cells = sum.map((row, d) =>
    row.map((s, h) => {
      const c = n[d]![h]!;
      if (!c) return null;
      const mean = s / c;
      max = Math.max(max, mean);
      return mean;
    }),
  );
  return { cells, max };
}

/** A gauge's fill and its severity from where it turns. */
export function gaugeLevel(value: number, max: number, warnAt = 0.8) {
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const severity: Severity = share >= 0.95 ? 'critical' : share >= warnAt ? 'warning' : 'ok';
  return { share, severity };
}
