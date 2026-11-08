// SPDX-License-Identifier: AGPL-3.0-only
// What a token's scope allows (ADR-125). `read` is the only scope in v0.2. It is an
// allowlist: the routes tagged `public` (ADR-126), read with GET or HEAD, the chart query
// sent as POST, the public spec itself and the MCP server. A new route is closed to tokens
// until it is tagged; test/api-tokens-scope.test.ts walks every route and pins the set.
import { isPublic } from '../../openapi/public.js';
import type { ApiTokenScope } from './tokens.js';

const READ_METHODS = new Set(['GET', 'HEAD']);

/** The MCP server (ADR-127, v0.2 slice 4). Reserved here: every method, read scope. */
export const MCP_PATH = '/mcp';

/** Public routes a read token may call with POST: reads that send a body. */
export const TOKEN_READ_POSTS: readonly { method: string; url: string; why: string }[] = [
  { method: 'POST', url: '/api/v1/query/range', why: 'a read: chart queries are POSTed' },
];

/** Readable with a token though not in the spec: the spec itself. */
export const TOKEN_ALSO_READS: readonly string[] = ['/api/v1/openapi.json'];

const under = (url: string, prefix: string) => url === prefix || url.startsWith(`${prefix}/`);

/** A route as the scope guard sees it: its method, its pattern and its schema's tags. */
export interface ScopedRoute {
  method: string;
  url: string;
  tags?: readonly string[];
}

/** Whether a token with this scope may call this route. */
export function tokenAllows(scope: ApiTokenScope, route: ScopedRoute): boolean {
  if (scope !== 'read') return false;
  const { method, url } = route;
  if (under(url, MCP_PATH)) return true;
  // The REST API only: /ingest and anything else stays closed, tagged or not.
  if (!url.startsWith('/api/v1/')) return false;
  if (READ_METHODS.has(method) && TOKEN_ALSO_READS.includes(url)) return true;
  if (!isPublic(route.tags)) return false;
  if (READ_METHODS.has(method)) return true;
  return TOKEN_READ_POSTS.some((p) => p.method === method && p.url === url);
}

/** URLs where a bearer token is taken as an API token (the agents' /ingest has its own). */
export function isTokenPath(url: string): boolean {
  return url.startsWith('/api/') || under(url.split('?')[0]!, MCP_PATH);
}
