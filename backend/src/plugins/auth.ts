// SPDX-License-Identifier: AGPL-3.0-only
// Session authentication for /api/v1 routes (ADR-033).
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Database } from '../db/index.js';
import { bindOrg } from '../db/org-context.js';
import { sendProblem } from '../lib/problem.js';
import {
  clearSessionCookie,
  findSessionUser,
  SESSION_COOKIE,
  type CurrentUser,
  type Role,
} from '../modules/auth/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: CurrentUser | null;
  }
  interface FastifyInstance {
    /**
     * The owner's connection (ADR-174): only for what must work before the org is known,
     * such as the session lookup here. A test allow-lists the files that use it.
     */
    systemDb: Database;
  }
}

/**
 * preHandler that rejects requests without a valid session with 401, and binds the
 * request to the user's org (ADR-174).
 */
export function requireUser(): preHandlerAsyncHookHandler {
  return async function (this: unknown, request: FastifyRequest, reply: FastifyReply) {
    // Already signed in by a demo cookie (ADR-122), an API token or the service identity.
    if (request.user) {
      bindOrg(request.user.org.id);
      return;
    }
    const token = request.cookies[SESSION_COOKIE];
    // Before the org is known: the owner's connection.
    const user = token ? await findSessionUser(request.server.systemDb, token) : null;
    if (!user) {
      if (token) clearSessionCookie(request, reply);
      return sendProblem(reply, 401, 'Sign in to continue');
    }
    request.user = user;
    bindOrg(user.org.id);
  };
}

/** Marks a role guard, so the route walk (ADR-140) can tell a route declared its roles. */
export const ROLE_GUARD = Symbol.for('watchlog.roleGuard');

/** The roles a route's preHandlers allow, or undefined when none declares them. */
export function declaredRoles(preHandler: unknown): Role[] | undefined {
  for (const h of [preHandler].flat(3)) {
    const roles = (h as { [ROLE_GUARD]?: Role[] } | undefined)?.[ROLE_GUARD];
    if (roles) return roles;
  }
  return undefined;
}

/**
 * preHandler (after requireUser) that allows only the given roles; others get 403 with
 * the words the dashboard shows on locked controls (ADR-140).
 */
export function requireRole(...roles: Role[]): preHandlerAsyncHookHandler {
  const guard = async function (this: unknown, request: FastifyRequest, reply: FastifyReply) {
    if (!request.user || !roles.includes(request.user.role)) {
      return sendProblem(
        reply,
        403,
        request.user?.role === 'viewer'
          ? "Viewers can't change this. Ask an Admin."
          : 'Your role does not allow this action',
      );
    }
  };
  Object.defineProperty(guard, ROLE_GUARD, { value: roles });
  return guard;
}
