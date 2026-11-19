// SPDX-License-Identifier: AGPL-3.0-only
// Dates and small words the emails share (ADR-220): UTC, written out, no locale guessing.

const WHEN = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});
const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "Thu 19 Nov, 14:02 UTC" */
export function when(d: Date | string): string {
  const p = Object.fromEntries(WHEN.formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute} UTC`;
}

/** "26 Nov 2026" */
export function day(d: Date | string): string {
  return DAY.format(new Date(d));
}

/** "14:02 UTC" */
export function hhmm(d: Date | string): string {
  return `${new Date(d).toISOString().slice(11, 16)} UTC`;
}

/** "29 minutes", "2 hours 5 minutes", "3 days" */
export function span(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  const n = (v: number, one: string) => `${v} ${one}${v === 1 ? '' : 's'}`;
  if (min < 60) return n(min, 'minute');
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${n(h, 'hour')} ${n(min % 60, 'minute')}` : n(h, 'hour');
  return n(Math.floor(h / 24), 'day');
}

/** The dashboard's address without a trailing slash, or null. */
export const base = (site: string | null | undefined) => (site ? site.replace(/\/+$/, '') : null);

/** A link on the dashboard, or null without one. */
export const at = (site: string | null | undefined, path: string) => {
  const b = base(site);
  return b ? `${b}${path}` : null;
};
