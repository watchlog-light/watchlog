// SPDX-License-Identifier: AGPL-3.0-only
// Session authentication for /api/v1 routes (ADR-033).
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Edition } from '../config.js';
import type { Database } from '../db/index.js';
import { bindOrg } from '../db/org-context.js';
import { sendProblem } from '../lib/problem.js';
import {
  clearSessionCookie,
  findSessionUser,
  SESSION_COOKIE,
  restrictionOf,
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
    /** WATCHLOG_EDITION (ADR-173), for the few checks that differ in Cloud. */
    edition: Edition;
  }
}

const RESTRICTED: Record<string, string> = {
  'mfa-setup-required':
    'Set up two-factor authentication first: it is required for Owners of a paid organization.',
  'email-verification-required': 'Verify your email address to keep using WatchLog.',
};

/**
 * preHandler that rejects requests without a valid session with 401, and binds the
 * request to the user's org (ADR-174).
 */
export function requireUser(
  opts: {
    /**
     * Cloud: the route also serves a session that must first verify its email or set up
     * 2FA (ADR-175), such as those two steps themselves. Others answer 403 with the step.
     */
    allowRestricted?: boolean;
  } = {},
): preHandlerAsyncHookHandler {
  return async function (this: unknown, request: FastifyRequest, reply: FastifyReply) {
    // Already signed in by a demo cookie (ADR-122), an API token or the service identity.
    if (request.user) {
      bindOrg(request.user.org.id);
      if (request.server.orgLimits?.refuse(request, reply, request.user.org.id)) return reply;
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
    // Cloud: the org's share of the backend (SR-9).
    if (request.server.orgLimits?.refuse(request, reply, user.org.id)) return reply;
    if (request.server.edition === 'cloud' && !opts.allowRestricted) {
      const restriction = restrictionOf(user);
      if (restriction) {
        return reply
          .code(403)
          .type('application/problem+json')
          .send({
            type: `urn:watchlog:problem:${restriction}`,
            title: 'Forbidden',
            status: 403,
            detail: RESTRICTED[restriction],
            instance: request.url,
            code: restriction,
          });
      }
    }
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
