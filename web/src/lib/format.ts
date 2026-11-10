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

/** "just now", "3 min ago", "2 h ago", "4 d ago": how long ago, short. */
export function agoShort(unixSeconds: number, now = Date.now()): string {
  const s = Math.max(0, now / 1000 - unixSeconds);
  if (s < 60) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172_800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** "09:58 (3 min ago)": a moment in the reader's time, and how long ago. */
export function whenAndAgo(unixSeconds: number, now = Date.now()): string {
  return `${formatWhen(new Date(unixSeconds * 1000).toISOString(), now)} (${agoShort(unixSeconds, now)})`;
}
