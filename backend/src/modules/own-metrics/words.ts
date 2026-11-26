// SPDX-License-Identifier: AGPL-3.0-only
// An own metric's value in words, for alerts and their previews (1.0.0, ADR-236): the same
// reading as the page's (web/src/lib/own-metrics.ts), kept here so a notification says what
// the page says. Pure.
import type { Unit } from '../query/catalog.js';
import type { OwnUnit, Shown } from './naming.js';

export type Per = 's' | 'min' | 'h';
const PER_FACTOR: Record<Per, number> = { s: 1, min: 60, h: 3600 };

export function ratePer(perSecond: number | null | undefined): Per {
  const a = Math.abs(perSecond ?? 0);
  if (a === 0 || a >= 1) return 's';
  return a * 60 >= 1 ? 'min' : 'h';
}

export function num(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return Math.round(v).toLocaleString('en-US');
  if (a >= 100) return String(Math.round(v));
  if (a >= 10) return String(+v.toFixed(1));
  if (a >= 1) return String(+v.toFixed(2));
  return String(+v.toPrecision(2));
}

/** "45 s", "12 min", "3 h", "4 d". */
export function durationWords(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

const BYTES = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
function bytes(v: number): string {
  let i = 0;
  let x = Math.abs(v);
  while (x >= 1024 && i < BYTES.length - 1) {
    x /= 1024;
    i++;
  }
  return `${v < 0 ? '-' : ''}${num(x)} ${BYTES[i]}`;
}

export interface Showing {
  unit: OwnUnit;
  shown: Shown;
}

/** "4.2 /min", "380 ms", "85 °C", "70%", "3 h": a value as the page writes it. */
export function writtenText(v: number | null | undefined, s: Showing, per?: Per): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  if (s.shown === 'time_since') return durationWords(v);
  if (s.shown === 'rate') {
    const p = per ?? ratePer(v);
    const scaled = v * PER_FACTOR[p];
    if (s.unit === 'bytes') return `${bytes(scaled)} /${p}`;
    if (s.unit === 'seconds') return `${num(scaled)} s/${p}`;
    return `${num(scaled)} /${p}`;
  }
  switch (s.unit) {
    case 'seconds': {
      const a = Math.abs(v);
      if (a === 0) return '0 ms';
      if (a < 1) return `${num(v * 1000)} ms`;
      if (a < 120) return `${num(v)} s`;
      if (a < 2 * 3600) return `${num(v / 60)} min`;
      return `${num(v / 3600)} h`;
    }
    case 'bytes':
      return bytes(v);
    case 'celsius':
      return `${num(v)} °C`;
    case 'ratio':
      return `${num(v * 100)}%`;
    case 'percent':
      return `${num(v)}%`;
    default:
      return num(v);
  }
}

/** The unit What changed's statistics take for an own metric (its floors and rounding). */
export function statUnit(s: Showing): Unit {
  if (s.shown === 'rate') return s.unit === 'bytes' ? 'bytes_per_second' : 'per_second';
  if (s.shown === 'time_since' || s.unit === 'seconds') return 'seconds';
  if (s.unit === 'bytes') return 'bytes';
  if (s.unit === 'ratio') return 'ratio';
  return 'count';
}
