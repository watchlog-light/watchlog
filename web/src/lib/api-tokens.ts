// SPDX-License-Identifier: AGPL-3.0-only
// Settings → API tokens (ADR-125): what the list, the detail and the reveal show.
import type { ApiToken, ApiTokenDetail, ApiTokenEvent } from '@watchlog/api-types';

/** The expiry choices when creating a token, in days; null: never. */
export const EXPIRY_CHOICES = [30, 90, 365, null] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];
export const DEFAULT_EXPIRY: ExpiryChoice = 90;

const DAY = 86_400_000;

/** The date a token created now expires on, or null when it never does. */
export function expiryDate(days: ExpiryChoice, now = Date.now()): Date | null {
  return days === null ? null : new Date(now + days * DAY);
}

/** "Jan 31, 2027". */
export function formatDay(date: Date | string, locale = 'en'): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(date));
}

/** Whole days until a timestamp, rounded up: a token expiring in 2 hours has 1 day left. */
export function daysUntil(iso: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / DAY));
}

/** A token can be revoked while it can still be used. */
export const canRevoke = (t: ApiToken) => t.status !== 'expired' && t.status !== 'revoked';

/** Expired and revoked tokens are listed dimmed. */
export const isDone = (t: ApiToken) => !canRevoke(t);

/** The line under the expiry date, as an i18n key and its values. */
export function expiryNote(
  t: ApiToken,
  now = Date.now(),
  locale = 'en',
): { key: string; values?: Record<string, unknown>; warn: boolean } {
  if (t.status === 'revoked' && t.revokedAt) {
    return {
      key: 'apiTokens.note.revoked',
      values: { date: formatDay(t.revokedAt, locale) },
      warn: false,
    };
  }
  if (t.status === 'expired') return { key: 'apiTokens.note.expired', warn: false };
  if (!t.expiresAt) return { key: 'apiTokens.note.never', warn: true };
  const n = daysUntil(t.expiresAt, now);
  return { key: 'apiTokens.note.inDays', values: { n }, warn: t.status === 'expires_soon' };
}

/** "2 minutes ago", "yesterday", "Oct 28": when a token was last used. */
export function lastUsedLabel(iso: string, now = Date.now(), locale = 'en'): string {
  const diff = now - new Date(iso).getTime();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (diff < 60_000) return rtf.format(0, 'second');
  if (diff < 3_600_000) return rtf.format(-Math.floor(diff / 60_000), 'minute');
  if (diff < DAY) return rtf.format(-Math.floor(diff / 3_600_000), 'hour');
  if (diff < 2 * DAY) return rtf.format(-1, 'day');
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(iso));
}

/** "203.0.113.42 · DE": the address and its country when known. */
export function lastPlace(t: { lastUsedIp: string | null; lastUsedCountry: string | null }) {
  if (!t.lastUsedIp) return '';
  return t.lastUsedCountry ? `${t.lastUsedIp} · ${t.lastUsedCountry}` : t.lastUsedIp;
}

/** The calls column: MCP calls of the last 30 days, "REST only", or nothing yet. */
export function callsLabel(t: ApiToken): { key: string; n?: number } {
  if (t.mcpCalls30d > 0) return { key: 'apiTokens.calls.mcp', n: t.mcpCalls30d };
  if (t.usedRest) return { key: 'apiTokens.calls.restOnly' };
  return { key: 'apiTokens.calls.none' };
}

/** The colour of a history event's dot. */
export const EVENT_DOT: Record<ApiTokenEvent['kind'], string> = {
  created: 'bg-text-muted',
  first_use: 'bg-ok',
  new_ip: 'bg-warning',
  expired: 'bg-text-subtle',
  revoked: 'bg-critical',
  reminder_sent: 'bg-info',
};

/**
 * One MCP tool call in a token's activity (v0.2 slice 4 fills it): never the output,
 * only what was asked, how it went and how big the answer was.
 */
export interface McpCall {
  at: string;
  tool: string;
  /** A short summary of the arguments, e.g. "prod-eu · shop/api". */
  args: string;
  status: 'ok' | 'truncated' | 'rate_limited' | 'error';
  durationMs: number;
  bytes: number;
}

export const CALL_TONE: Record<McpCall['status'], string> = {
  ok: 'text-ok',
  truncated: 'text-warning',
  rate_limited: 'text-critical',
  error: 'text-critical',
};

/** The detail's activity rows; the schema is open until slice 4 fixes it. */
export const mcpCalls = (d: ApiTokenDetail) => d.activity as unknown as McpCall[];

export type SnippetTab = 'code' | 'desktop' | 'cursor' | 'rest';
export const SNIPPET_TABS: SnippetTab[] = ['code', 'desktop', 'cursor', 'rest'];

/** WatchLog's address for the snippets: the public URL, else this browser's origin. */
export function baseUrl(publicUrl: string | null | undefined, origin: string): string {
  return (publicUrl || origin).replace(/\/+$/, '');
}

/** What to paste into each app, with the token and WatchLog's address filled in. */
export function snippet(tab: SnippetTab, url: string, token: string, name = 'watchlog'): string {
  const mcp = `${url}/mcp`;
  switch (tab) {
    case 'code':
      return `claude mcp add --transport http ${name} ${mcp} \\\n  --header "Authorization: Bearer ${token}"`;
    case 'desktop':
      return JSON.stringify(
        {
          mcpServers: {
            [name]: {
              command: 'npx',
              args: [
                '-y',
                'mcp-remote',
                mcp,
                '--header',
                'Authorization: Bearer ${WATCHLOG_TOKEN}',
              ],
              env: { WATCHLOG_TOKEN: token },
            },
          },
        },
        null,
        2,
      );
    case 'cursor':
      return JSON.stringify(
        { mcpServers: { [name]: { url: mcp, headers: { Authorization: `Bearer ${token}` } } } },
        null,
        2,
      );
    case 'rest':
      return `curl -H "Authorization: Bearer ${token}" \\\n  ${url}/api/v1/clusters`;
  }
}
