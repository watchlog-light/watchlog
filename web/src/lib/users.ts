// SPDX-License-Identifier: AGPL-3.0-only
// Users (ADR-140): how long ago someone was active, in words.

/** "Active now", "2 hours ago", "Yesterday", or the date for anything older than a week. */
export function relativeTime(
  iso: string,
  t: (key: string, values?: Record<string, unknown>) => string,
  now = Date.now(),
): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 300) return t('users.activeNow');
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86_400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 7 * 86_400) return rtf.format(-Math.round(s / 86_400), 'day');
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
