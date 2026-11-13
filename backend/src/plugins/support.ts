// SPDX-License-Identifier: AGPL-3.0-only
// Support mode (ADR-179), Cloud only: a `wl_support` cookie signs a staff member in as a
// viewer of one org, read-only, for at most an hour. Three layers keep it from writing:
//   1. this hook refuses every request that isn't a read (GET/HEAD/OPTIONS) with 403
//      `support-read-only`, except the chart queries POSTed for their body and leaving
//      support mode; GETs with side effects are refused like in the demo (ADR-122);
//   2. the support user is a viewer, so every role guard of a change refuses it too;
//   3. the request's database scope is read-only: the pool sets
//      `default_transaction_read_only` on every connection it checks out for the request
//      (db/index.ts), so PostgreSQL itself refuses any INSERT, UPDATE or DELETE it makes.
// The cookie is checked before the session cookie, so a staff member's own session in the
// same browser is ignored while support mode is on. Every API path it opens is recorded for
// the org's Owners, and tokens read are recorded as accessed by WatchLog staff.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../db/index.js';
import { bindOrg, markReadOnly } from '../db/org-context.js';
import { PROBLEM_CONTENT_TYPE, problem } from '../lib/problem.js';
import {
  findSupportUser,
  recordSupportView,
  recordTokenAccess,
  SUPPORT_COOKIE,
} from '../modules/support/service.js';
import { DEMO_BLOCKED_READS } from './demo.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The only other requests a support session may make, by route pattern. */
export const SUPPORT_ALLOWED: readonly { method: string; url: string; why: string }[] = [
  {
    method: 'POST',
    url: '/api/v1/query/range',
    why: 'a read: chart queries are POSTed for their JSON body',
  },
  { method: 'DELETE', url: '/api/v1/support/session', why: 'leaves support mode' },
];

export const SUPPORT_READ_ONLY_CODE = 'support-read-only';

/**
 * Reads support mode refuses: the demo's GETs with side effects; container logs (they can
 * hold anything a program printed, and each read is an audit write); and the signed-in
 * account's own pages, since a support session is no account.
 */
export const SUPPORT_BLOCKED_READS: readonly string[] = [
  ...DEMO_BLOCKED_READS,
  '/api/v1/clusters/:id/pods/:namespace/:name/logs',
  '/api/v1/clusters/:id/docker/hosts/:host/containers/:name/logs',
  '/api/v1/auth/account',
  '/api/v1/auth/sessions',
];

/** Whether support mode refuses this request (route pattern, not the raw URL). */
export function isSupportBlocked(method: string, routeUrl: string | undefined): boolean {
  if (routeUrl === undefined) return false; // the 404 handler answers
  if (SAFE_METHODS.has(method)) return SUPPORT_BLOCKED_READS.includes(routeUrl);
  return !SUPPORT_ALLOWED.some((a) => a.method === method && a.url === routeUrl);
}

/** Reads whose answer shows tokens (ADR-179: "accessed by WatchLog staff"). */
const TOKEN_READS: Record<string, 'cluster' | 'api'> = {
  'GET /api/v1/clusters/:id': 'cluster',
  'GET /api/v1/users': 'api',
  'GET /api/v1/api-tokens': 'api',
  'GET /api/v1/api-tokens/:id': 'api',
};

/** What every page asks on load: not worth listing as "opened" for the Owners. */
const NOT_LISTED = new Set([
  '/api/v1/auth/config',
  '/api/v1/setup',
  '/api/v1/me',
  '/api/v1/orgs',
  '/api/v1/plan',
  '/api/v1/alerting/status',
  '/api/v1/health',
  '/api/v1/clusters',
]);

export function clearSupportCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(SUPPORT_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    // Always Secure: Cloud runs on https, and browsers keep it on http://localhost too.
    secure: true,
  });
}

export function registerSupportMode(app: FastifyInstance, opts: { systemDb: Database }): void {
  const { systemDb } = opts;
  app.addHook('onRequest', async (request, reply) => {
    const token = request.cookies[SUPPORT_COOKIE];
    if (!token || request.user) return;
    const user = await findSupportUser(systemDb, token);
    if (!user) {
      clearSupportCookie(request, reply);
      return;
    }
    request.user = user;
    bindOrg(user.org.id);
    markReadOnly();
    if (isSupportBlocked(request.method, request.routeOptions.url)) {
      const msg = 'Support mode is read-only: nothing can be changed in this session.';
      return reply
        .code(403)
        .type(PROBLEM_CONTENT_TYPE)
        .send(
          JSON.stringify({
            ...problem(403, msg, request.url),
            type: `urn:watchlog:problem:${SUPPORT_READ_ONLY_CODE}`,
            code: SUPPORT_READ_ONLY_CODE,
          }),
        );
    }
  });

  // What was opened, for the Owners (Settings › Security), and tokens read.
  app.addHook('onResponse', async (request, reply) => {
    const s = request.user?.support;
    if (!s || request.method !== 'GET' || reply.statusCode >= 400) return;
    const route = request.routeOptions.url ?? '';
    if (!route.startsWith('/api/v1/') || route.startsWith('/api/v1/support/')) return;
    if (NOT_LISTED.has(route)) return;
    const orgId = request.user!.org.id;
    try {
      const path = request.url.split('?')[0]!;
      const first = await recordSupportView(systemDb, { sessionId: s.sessionId, orgId }, path);
      const tokens = TOKEN_READS[`GET ${route}`];
      if (first && tokens) {
        await recordTokenAccess(
          systemDb,
          { ...s, orgId },
          tokens === 'cluster'
            ? { clusterId: (request.params as { id: string }).id }
            : { apiTokens: true },
        );
      }
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, 'support view not recorded');
    }
  });
}
