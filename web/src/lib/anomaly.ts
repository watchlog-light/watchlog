// SPDX-License-Identifier: AGPL-3.0-only
// An anomaly alert's page (ADR-200, the screen Anomaly): the hour of the week it is unusual
// for (UTC, as the messages say), and the hero chart's geometry: the series of the last hours
// against each hour's usual band, the part since it became unusual drawn apart, and the hour
// labels. Pure functions; the component draws them.
import type { AnomalyAlert } from '@watchlog/api-types';
import { hhmm } from './what-changed';

export const ANOMALY_RULE_KEY = 'anomaly.unusual';
export const isAnomalyAlert = (a: { rule: { key: string | null } }) =>
  a.rule.key === ANOMALY_RULE_KEY;

/** A Sunday (2026-11-15) at 00:00 UTC: bucket 0. */
const SUNDAY = Date.UTC(2026, 10, 15);

/** "Tuesday", "14:00": the hour-of-week bucket in UTC words, in the locale's day name. */
export function bucketWords(bucket: number, locale = 'en'): { day: string; hour: string } {
  const b = ((Math.trunc(bucket) % 168) + 168) % 168;
  const day = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(SUNDAY + Math.floor(b / 24) * 86_400_000),
  );
  return { day, hour: `${String(b % 24).padStart(2, '0')}:00` };
}

export interface HeroGeometry {
  /** The band as one polygon: the highs left to right, then the lows back. */
  band: string;
  /** The series before it became unusual, and from then on. */
  before: string;
  after: string;
  /** The unusual stretch, as x and width. */
  unusual: { x: number; width: number } | null;
  /** Hour labels at their x share (0–1). */
  ticks: { at: number; label: string }[];
  empty: boolean;
}

/**
 * The hero chart in a `w` × `h` box: x from the chart's from to to, y from 0 to a little
 * above the highest value or band. The band is a step per hour (each hour has its own usual
 * range), so it reads as "usual for each hour".
 */
export function heroGeometry(
  a: Pick<AnomalyAlert, 'chart' | 'since'>,
  w: number,
  h: number,
  locale = 'en',
): HeroGeometry {
  const from = Date.parse(a.chart.from);
  const to = Date.parse(a.chart.to);
  const span = Math.max(1, to - from);
  const pts = a.chart.points.filter((p): p is [number, number] => p[1] !== null);
  const bands = a.chart.band.map((b) => {
    const s = Math.max(from, Date.parse(b.from));
    return { s, e: Math.min(to, Date.parse(b.from) + 3_600_000), low: b.low, high: b.high };
  });
  const max = Math.max(1e-9, ...pts.map((p) => p[1]), ...bands.map((b) => b.high)) * 1.08;
  const pad = 6;
  const x = (t: number) => ((t - from) / span) * w;
  const y = (v: number) => h - pad - (Math.max(0, v) / max) * (h - 2 * pad);
  const f = (n: number) => n.toFixed(1);
  const hi: string[] = [];
  const lo: string[] = [];
  for (const b of bands) {
    hi.push(`${f(x(b.s))},${f(y(b.high))}`, `${f(x(b.e))},${f(y(b.high))}`);
    lo.push(`${f(x(b.s))},${f(y(b.low))}`, `${f(x(b.e))},${f(y(b.low))}`);
  }
  const since = Date.parse(a.since);
  const line = (list: [number, number][]) =>
    list.map(([t, v]) => `${f(x(t * 1000))},${f(y(v))}`).join(' ');
  const before = pts.filter(([t]) => t * 1000 <= since);
  // The unusual part starts at the last point before it, so the two lines join.
  const after = pts.filter(([t]) => t * 1000 >= since);
  if (before.length && after.length && after[0]![0] * 1000 > since) after.unshift(before.at(-1)!);
  const sx = x(Math.max(from, Math.min(to, since)));
  const ticks: HeroGeometry['ticks'] = [];
  const stepH = span > 8 * 3_600_000 ? 4 : 2;
  const first = Math.ceil(from / (stepH * 3_600_000)) * stepH * 3_600_000;
  for (let t = first; t <= to; t += stepH * 3_600_000) {
    ticks.push({ at: (t - from) / span, label: hhmm(new Date(t).toISOString(), locale) });
  }
  return {
    band: hi.length ? [...hi, ...lo.reverse()].join(' ') : '',
    before: line(before),
    after: line(after),
    unusual: since < to ? { x: sx, width: Math.max(2, w - sx) } : null,
    ticks,
    empty: pts.length === 0 && bands.length === 0,
  };
}
