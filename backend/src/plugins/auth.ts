// SPDX-License-Identifier: AGPL-3.0-only
// Session authentication for /api/v1 routes (ADR-033).
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Database } from '../db/index.js';
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
}

/** preHandler that rejects requests without a valid session with 401. */
export function requireUser(db: Database): preHandlerAsyncHookHandler {
  return async function (this: unknown, request: FastifyRequest, reply: FastifyReply) {
    // Already signed in by a demo cookie (ADR-122).
    if (request.user) return;
    const token = request.cookies[SESSION_COOKIE];
    const user = token ? await findSessionUser(db, token) : null;
    if (!user) {
      if (token) clearSessionCookie(request, reply);
      return sendProblem(reply, 401, 'Sign in to continue');
    }
    request.user = user;
  };
}

/** preHandler (after requireUser) that allows only the given roles; others get 403. */
export function requireRole(...roles: Role[]): preHandlerAsyncHookHandler {
  return async function (this: unknown, request: FastifyRequest, reply: FastifyReply) {
    if (!request.user || !roles.includes(request.user.role)) {
      return sendProblem(reply, 403, 'Your role does not allow this action');
    }
  };
}
