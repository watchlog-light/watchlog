// SPDX-License-Identifier: AGPL-3.0-only

/** Formats an ISO timestamp for display, e.g. "Oct 31, 2026, 14:05". */
export function formatDateTime(iso: string, locale = 'en'): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

/** "21:42" for today, "Oct 31, 21:42" for another day: never a raw ISO timestamp. */
export function formatWhen(iso: string, now = Date.now(), locale = 'en'): string {
  const d = new Date(iso);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}
