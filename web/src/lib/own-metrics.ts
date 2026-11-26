// SPDX-License-Identifier: AGPL-3.0-only
// Your metrics (1.0.0, ADR-236) in words and numbers: how a value is written for its type and
// unit, what a metric belongs to, the list's filters, and the snippets of "Add a source".
// Pure: no I/O, no components.
import type { OwnMetric, OwnOwner, OwnSource } from '@watchlog/api-types';
import type { RouteLocationRaw } from 'vue-router';
import { formatBytes } from '@/lib/units';

export type OwnUnit = OwnMetric['unit'];
export type OwnShown = OwnMetric['shown'];
export type OwnType = OwnMetric['type'];

export const OWN_TYPES: OwnType[] = ['counter', 'gauge', 'histogram', 'summary', 'timestamp'];
export const OWN_UNITS: OwnUnit[] = ['count', 'seconds', 'bytes', 'ratio', 'percent', 'celsius'];

/** How a value is shown: the metric's, or a chart's own. */
export interface Showing {
  unit: OwnUnit;
  shown: OwnShown;
}

export type Per = 's' | 'min' | 'h';
const PER_FACTOR: Record<Per, number> = { s: 1, min: 60, h: 3600 };

/** A rate's readable scale: per second from 1 up, else per minute, else per hour. */
export function ratePer(perSecond: number | null | undefined): Per {
  const a = Math.abs(perSecond ?? 0);
  if (a === 0 || a >= 1) return 's';
  return a * 60 >= 1 ? 'min' : 'h';
}

/** A number in few digits: "4.2", "380", "12,400", "0.034". */
export function num(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return Math.round(v).toLocaleString('en-US');
  if (a >= 100) return String(Math.round(v));
  if (a >= 10) return String(+v.toFixed(1));
  if (a >= 1) return String(+v.toFixed(2));
  return String(+v.toPrecision(2));
}

/** "45 s", "12 min", "3 h", "4 d": how long ago, in one unit. */
export function sinceWords(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

export interface Written {
  /** The number: "4.2", "380", "3 h". */
  value: string;
  /** What follows it: "/min", "ms", "°C", "%"; "ago" comes from the page's own words. */
  unit: string;
  /** A timestamp: the page adds "ago". */
  ago: boolean;
}

const NOTHING: Written = { value: '–', unit: '', ago: false };

function seconds(v: number): Written {
  if (v === 0) return { value: '0', unit: 'ms', ago: false };
  const a = Math.abs(v);
  if (a < 1) return { value: num(v * 1000), unit: 'ms', ago: false };
  if (a < 120) return { value: num(v), unit: 's', ago: false };
  if (a < 2 * 3600) return { value: num(v / 60), unit: 'min', ago: false };
  return { value: num(v / 3600), unit: 'h', ago: false };
}

/**
 * A value as the page writes it. A rate takes `per` (the chart's one scale) or the scale that
 * reads best for this value.
 */
export function written(v: number | null | undefined, s: Showing, per?: Per): Written {
  if (v === null || v === undefined || !Number.isFinite(v)) return NOTHING;
  if (s.shown === 'time_since') return { value: sinceWords(v), unit: '', ago: true };
  if (s.shown === 'rate') {
    const p = per ?? ratePer(v);
    const scaled = v * PER_FACTOR[p];
    if (s.unit === 'bytes') return { value: formatBytes(scaled), unit: `/${p}`, ago: false };
    if (s.unit === 'seconds') return { value: num(scaled), unit: `s/${p}`, ago: false };
    return { value: num(scaled), unit: `/${p}`, ago: false };
  }
  switch (s.unit) {
    case 'seconds':
      return seconds(v);
    case 'bytes': {
      const [n, u] = formatBytes(v).split(' ');
      return { value: n ?? '0', unit: u ?? 'B', ago: false };
    }
    case 'celsius':
      return { value: num(v), unit: '°C', ago: false };
    case 'ratio':
      return { value: num(v * 100), unit: '%', ago: false };
    case 'percent':
      return { value: num(v), unit: '%', ago: false };
    default:
      return { value: num(v), unit: '', ago: false };
  }
}

/** A value in one string, for axes, tooltips and tables: "4.2 /min", "380 ms", "3 h". */
export function writtenText(v: number | null | undefined, s: Showing, per?: Per): string {
  const w = written(v, s, per);
  if (!w.unit) return w.value;
  // "%" and a rate on bytes sit against the number; the rest after a space.
  return w.unit === '%' ? `${w.value}%` : `${w.value} ${w.unit}`;
}

/** The scale a whole chart is written in: the one its highest point reads best in. */
export function chartPer(lines: { points: (number | null)[][] }[]): Per {
  let max = 0;
  for (const l of lines) for (const p of l.points) if ((p[1] ?? 0) > max) max = p[1] ?? 0;
  return ratePer(max);
}

/** A watched metric's usual range for this hour, as the API gives it. */
export interface Usual {
  low: number | null;
  high: number | null;
  learning: boolean;
}

/** "3.6 – 5.1 /min": the range in the value's own scale; null while it is learnt. */
export function usualText(u: Usual | null | undefined, s: Showing, per?: Per): string | null {
  if (!u || u.learning || u.low === null || u.high === null) return null;
  const p = s.shown === 'rate' ? (per ?? ratePer(u.high)) : undefined;
  const low = written(u.low, s, p);
  const high = written(u.high, s, p);
  const unit = high.unit === '%' ? '%' : high.unit ? ` ${high.unit}` : '';
  return `${low.value} – ${high.value}${unit}`;
}

/** Whether a value is outside its usual range now. */
export function outside(v: number | null | undefined, u: Usual | null | undefined): boolean {
  if (v === null || v === undefined || !u || u.learning || u.low === null || u.high === null)
    return false;
  return v < u.low || v > u.high;
}

// ------------------------------------------------------------------- what it belongs to

/** "shop/orders", "server gpu-1"; null when it is tied to nothing. */
export function ownerText(o: OwnOwner): string | null {
  if (o.kind === 'workload') return `${o.namespace}/${o.name}`;
  if (o.kind === 'server') return o.name;
  return null;
}

/** The page of the workload or server a metric belongs to. */
export function ownerLink(o: OwnOwner, cluster: string): RouteLocationRaw | null {
  if (o.kind === 'workload') {
    return {
      name: 'workloads',
      query: { cluster, view: 'pods', wkind: o.workloadKind, wname: o.name, wns: o.namespace },
    };
  }
  if (o.kind === 'server')
    return { name: 'server', params: { server: o.name }, query: { cluster } };
  return null;
}

/** The owner as a pins or metrics query. */
export function ownerQuery(o: OwnOwner): string {
  const q = new URLSearchParams({ ownerKind: o.kind, owner: o.name });
  if (o.kind === 'workload') {
    q.set('namespace', o.namespace);
    q.set('workloadKind', o.workloadKind);
  }
  return q.toString();
}

// ------------------------------------------------------------------- the list's filters

export interface Chip {
  /** 'all', 'ns:<namespace>', 'server:<name>', 'pushed', 'untied'. */
  key: string;
  /** A namespace's or a server's name; empty for the three fixed chips (the page words them). */
  label: string;
  count: number;
}

const inChip = (m: OwnMetric, key: string): boolean => {
  if (key === 'all') return true;
  if (key === 'pushed') return m.pushed;
  if (key === 'untied') return m.untied;
  if (key.startsWith('ns:'))
    return m.owners.some((o) => o.kind === 'workload' && o.namespace === key.slice(3));
  if (key.startsWith('server:'))
    return m.owners.some((o) => o.kind === 'server' && o.name === key.slice(7));
  return false;
};

/** The filter chips a list offers: All, each namespace or server (up to 6), Pushed, Not tied. */
export function chipsOf(metrics: readonly OwnMetric[]): Chip[] {
  const places = new Map<string, string>();
  for (const m of metrics)
    for (const o of m.owners) {
      if (o.kind === 'workload') places.set(`ns:${o.namespace}`, o.namespace);
      else if (o.kind === 'server') places.set(`server:${o.name}`, o.name);
    }
  const count = (key: string) => metrics.filter((m) => inChip(m, key)).length;
  const chips: Chip[] = [{ key: 'all', label: '', count: metrics.length }];
  const sorted = [...places]
    .map(([key, label]) => ({ key, label, count: count(key) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  chips.push(...sorted.slice(0, 6));
  for (const key of ['pushed', 'untied']) {
    const n = count(key);
    if (n > 0) chips.push({ key, label: '', count: n });
  }
  return chips;
}

/** The list after the chip and the search box (the name, its words, where it comes from). */
export function filterMetrics(metrics: readonly OwnMetric[], q: string, chip: string): OwnMetric[] {
  const needle = q.trim().toLowerCase();
  return metrics.filter((m) => {
    if (!inChip(m, chip)) return false;
    if (!needle) return true;
    return (
      m.name.toLowerCase().includes(needle) ||
      m.words.toLowerCase().includes(needle) ||
      m.sources.some((s) => s.label.toLowerCase().includes(needle)) ||
      m.owners.some((o) => (ownerText(o) ?? '').toLowerCase().includes(needle))
    );
  });
}

// ------------------------------------------------------------------- sources

export type Way = 'scrape' | 'prometheus' | 'push';

/** How a source arrives, as the sources table groups it. */
export function wayOf(kind: OwnSource['kind']): Way {
  if (kind === 'remote_write') return 'prometheus';
  return kind === 'push' ? 'push' : 'scrape';
}

/** Series a source had dropped, all reasons together. */
export function droppedCount(d: OwnSource['dropped']): number {
  return d.reserved + d.invalid + d.sourceCap + d.orgCap;
}
