// SPDX-License-Identifier: AGPL-3.0-only
import type { TimeRange } from '@/stores/ui';

export const RANGE_SECONDS: Record<TimeRange, number> = {
  '15m': 15 * 60,
  '1h': 3600,
  '6h': 6 * 3600,
  '24h': 24 * 3600,
  '7d': 7 * 86400,
};

/** [from, to] in unix seconds for a relative range ending now. */
export function rangeWindow(range: TimeRange, now = Date.now()): [number, number] {
  const to = Math.floor(now / 1000);
  return [to - RANGE_SECONDS[range], to];
}

/** Compact duration since an ISO timestamp, e.g. "3d 4h", "5h 12m", "42m", "35s". */
export function since(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Clock time of an ISO timestamp, e.g. "14:05:09". */
export function clockTime(iso: string, locale = 'en'): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}
