// SPDX-License-Identifier: AGPL-3.0-only
// Formatting for metric values (units from the query catalog, ADR-028).
import { formatBytes, formatSeconds } from '@watchlog/cause-words';

export type Unit =
  'ratio' | 'bytes' | 'bytes_per_second' | 'cores' | 'load' | 'count' | 'seconds' | 'per_second';

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

// One formatting of bytes and seconds for the whole dashboard and the notifications (ADR-157).
export { formatBytes };

// Axis step for byte values: 1, 2 or 5 × a power of ten within one binary unit
// (KiB, MiB, …), so ticks read 0, 2 MiB, 4 MiB rather than ECharts' decimal 4.8 MiB.
export function byteAxisStep(max: number, ticks = 4): number {
  if (!(max > 0)) return 1;
  const raw = max / ticks;
  let base = 1;
  while (raw / base >= 1024 && base < 1024 ** (BYTE_UNITS.length - 1)) base *= 1024;
  const r = raw / base;
  const mag = 10 ** Math.floor(Math.log10(r));
  const f = r / mag;
  const nice = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  if (nice > 512) return 1024 * base;
  return Math.max(1, nice * base);
}

/**
 * A step for counts (members, connections, keys): a whole number, at least 1, so an axis
 * up to 2 reads 0, 1, 2 rather than 0, 0.5, 1, 1.5, 2 printed as "0 1 1 2 2".
 */
export function integerStep(max: number, ticks = 4): number {
  return Math.max(1, Math.round(niceStep(max, ticks)));
}

/** A decimal axis step: 1, 2 or 5 × a power of ten, about `ticks` steps up to `max`. */
export function niceStep(max: number, ticks = 4): number {
  if (!(max > 0)) return 1;
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}

/**
 * Rates such as connections per second: two significant digits below 1, so small
 * axis ticks stay distinct (0.01/s, 0.02/s, not "0" five times).
 */
export function formatRate(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0/s';
  const n =
    a >= 100 ? Math.round(v) : a >= 10 ? +v.toFixed(1) : a >= 1 ? +v.toFixed(2) : +v.toPrecision(2);
  return `${n}/s`;
}

export function formatValue(v: number | null | undefined, unit: Unit): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  switch (unit) {
    case 'ratio':
      // Enough decimals that neighbouring axis ticks (0.05% apart) stay distinct.
      if (v === 0) return '0%';
      return `${(v * 100).toFixed(v < 0.01 ? 2 : v < 0.1 ? 1 : 0)}%`;
    case 'bytes':
      return formatBytes(v);
    case 'bytes_per_second':
      return `${formatBytes(v)}/s`;
    case 'cores':
      // Plain decimals: a bare "m" (millicores) reads like minutes next to uptimes.
      // Large totals drop the decimals ("16004", not "16004.00").
      return v.toFixed(Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2);
    case 'load':
      return v.toFixed(2);
    case 'count':
      return String(Math.round(v));
    case 'per_second':
      return formatRate(v);
    case 'seconds':
      // Connect latencies: milliseconds below a second.
      return formatSeconds(v);
  }
}
