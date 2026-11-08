// SPDX-License-Identifier: AGPL-3.0-only
// What a token's scope allows (ADR-125). `read` is the only scope in v0.2: reads under
// /api/v1, the chart query sent as POST, and the MCP server. The guard goes by route
// pattern, so a new route is covered without anyone having to remember it: a new change
// is refused, and test/api-tokens-scope.test.ts pins the reads a token may make.
import type { ApiTokenScope } from './tokens.js';

const READ_METHODS = new Set(['GET', 'HEAD']);

/** The MCP server (ADR-127, v0.2 slice 4). Reserved here: every method, read scope. */
export const MCP_PATH = '/mcp';

/** Changes a read token may make: none, but reads sent as POST. */
export const TOKEN_READ_POSTS: readonly { method: string; url: string; why: string }[] = [
  { method: 'POST', url: '/api/v1/query/range', why: 'a read: chart queries are POSTed' },
];

/**
 * Never with a token, not even GET. Each prefix covers the path itself and everything
 * below it.
 */
export const TOKEN_DENIED_PREFIXES: readonly { prefix: string; why: string }[] = [
  { prefix: '/api/v1/api-tokens', why: 'tokens are managed with a session only' },
  { prefix: '/api/v1/auth', why: 'sign-in and sign-out are for browsers' },
  { prefix: '/api/v1/setup', why: 'first-run setup' },
  { prefix: '/api/v1/demo', why: 'demo sessions' },
  {
    prefix: '/api/v1/settings',
    why: 'server settings: SMTP and Telegram proxy details; reachability calls Telegram',
  },
  {
    prefix: '/api/v1/alert-channels',
    why: 'channel targets: recipients, URLs, bot and chat names, secret endings',
  },
];

const under = (url: string, prefix: string) => url === prefix || url.startsWith(`${prefix}/`);

/** Whether a token with this scope may call this route (by its pattern). */
export function tokenAllows(scope: ApiTokenScope, method: string, routeUrl: string): boolean {
  if (scope !== 'read') return false;
  if (under(routeUrl, MCP_PATH)) return true;
  if (!routeUrl.startsWith('/api/v1/')) return false;
  if (TOKEN_DENIED_PREFIXES.some((d) => under(routeUrl, d.prefix))) return false;
  if (READ_METHODS.has(method)) return true;
  return TOKEN_READ_POSTS.some((p) => p.method === method && p.url === routeUrl);
}

/** URLs where a bearer token is taken as an API token (the agents' /ingest has its own). */
export function isTokenPath(url: string): boolean {
  return url.startsWith('/api/') || under(url.split('?')[0]!, MCP_PATH);
}
