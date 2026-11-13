// SPDX-License-Identifier: AGPL-3.0-only
// The alert worker's reads (ADR-157). The worker has no HTTP server of its own for the API,
// so it builds the app in-process (buildApp with `serviceReads`) and reads the public API
// through app.inject, as probable cause and MCP do in the backend. Such a read names the org
// it is for and carries the in-process mark (lib/internal-call.ts: a secret made at start
// that never leaves the process); it then acts as a viewer of that org with an API token's
// read scope: the public routes, read with GET (and the chart query sent as POST), never a
// change, never another org. Only the worker's own app registers this hook: the backend
// that serves the API ignores the header, so nothing outside the worker process can use it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../db/index.js';
import { bindOrg } from '../db/org-context.js';
import { isInternalCall } from '../lib/internal-call.js';
import { sendProblem } from '../lib/problem.js';
import { tokenAllows } from '../modules/api-tokens/scope.js';
import type { CurrentUser, Plan } from '../modules/auth/sessions.js';

export const SERVICE_ORG_HEADER = 'x-watchlog-service-org';
/** Who the worker's reads are, in logs and wherever a route names its caller. */
export const SERVICE_USER_ID = 'service:alert-worker';

/** `systemDb`: the org is looked up before the request is bound to it (ADR-174). */
export function registerServiceIdentity(app: FastifyInstance, systemDb: Database): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const orgId = request.headers[SERVICE_ORG_HEADER];
    if (orgId === undefined) return;
    if (typeof orgId !== 'string' || !isInternalCall(request)) {
      return sendProblem(reply, 403, 'Service reads are made in-process only');
    }
    const route = request.routeOptions.url;
    const tags = (request.routeOptions.schema as { tags?: string[] } | undefined)?.tags;
    // No route: the 404 handler answers.
    if (route !== undefined && !tokenAllows('read', { method: request.method, url: route, tags }))
      return sendProblem(reply, 403, 'Service reads cover the public read API only');
    const org = await systemDb
      .selectFrom('orgs')
      .select(['id', 'name', 'slug', 'plan'])
      .where('id', '=', orgId)
      .executeTakeFirst()
      .catch(() => undefined);
    if (!org) return sendProblem(reply, 403, 'Unknown organization');
    const user: CurrentUser = {
      id: SERVICE_USER_ID,
      email: '',
      name: 'WatchLog alert worker',
      locale: 'en',
      role: 'viewer',
      org: { id: org.id, name: org.name, slug: org.slug, plan: org.plan as Plan },
    };
    request.user = user;
    bindOrg(org.id);
  });
}
