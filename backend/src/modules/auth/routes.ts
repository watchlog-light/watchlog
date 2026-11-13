// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { MAX_PASSWORD_LENGTH, verifyDummyPassword, verifyPassword } from '../../lib/passwords.js';
import { sendProblem } from '../../lib/problem.js';
import { requireUser } from '../../plugins/auth.js';
import { Email, MeResponse, ProblemSchema, UserEnvelope } from './schemas.js';
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  findSessionUser,
  SESSION_COOKIE,
  setSessionCookie,
} from './sessions.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { startMfaSession } from '../accounts/routes.js';

const INVALID_CREDENTIALS = 'Invalid email or password';

export const authRoutes: FastifyPluginAsyncTypebox<{
  /** Sign-in runs before the org is known: the owner's connection (ADR-174). */
  systemDb: Database;
}> = async (app, { systemDb }) => {
  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          hook: 'preHandler',
          keyGenerator: (request) => {
            const email = (request.body as { email?: unknown } | undefined)?.email;
            return `login:${request.clientIp}:${typeof email === 'string' ? email.toLowerCase() : ''}`;
          },
        },
      },
      schema: {
        summary: 'Sign in with email and password',
        tags: ['auth'],
        body: Type.Object({
          email: Email,
          password: Type.String({ minLength: 1, maxLength: MAX_PASSWORD_LENGTH }),
        }),
        response: {
          200: UserEnvelope,
          // Cloud, with TOTP on (ADR-175): the code goes to POST /auth/2fa/verify next.
          202: Type.Object({ mfaRequired: Type.Literal(true) }),
          401: ProblemSchema,
          429: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const email = request.body.email.trim().toLowerCase();
      const cloud = request.server.accounts;
      // Cloud: password attempts per account too, from any address (ADR-175).
      if (cloud && !cloud.loginsPerAccount.hit(email)) {
        return sendProblem(reply, 429, 'Too many attempts. Try again in 15 minutes.');
      }
      const user = await systemDb
        .selectFrom('users')
        .select(['id', 'password_hash', 'totp_enabled_at', 'disabled_at'])
        .where('email', '=', email)
        // Accounts made with GitHub or Google have no password (Cloud).
        .where('password_hash', 'is not', null)
        .executeTakeFirst();
      if (!user) {
        await verifyDummyPassword(request.body.password);
        return sendProblem(reply, 401, INVALID_CREDENTIALS);
      }
      if (!(await verifyPassword(user.password_hash!, request.body.password)) || user.disabled_at) {
        return sendProblem(reply, 401, INVALID_CREDENTIALS);
      }
      if (cloud) {
        // Sessions rotate at sign-in: the one this browser had ends.
        const old = request.cookies[SESSION_COOKIE];
        if (old) await deleteSession(systemDb, old);
        if (user.totp_enabled_at) {
          await startMfaSession(systemDb, request, reply, user.id);
          return reply.code(202).send({ mfaRequired: true as const });
        }
      }

      const { token, expiresAt } = await createSession(
        systemDb,
        user.id,
        cloud ? { ip: request.clientIp, userAgent: request.headers['user-agent'] ?? null } : {},
      );
      const current = await findSessionUser(systemDb, token);
      if (!current) {
        // A user without a membership cannot sign in; this indicates broken data.
        request.log.error({ userId: user.id }, 'user has no org membership');
        await deleteSession(systemDb, token);
        return sendProblem(reply, 401, INVALID_CREDENTIALS);
      }
      setSessionCookie(request, reply, token, expiresAt);
      return { user: current };
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        summary: 'Sign out and end the current session',
        tags: ['auth'],
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      if (token) await deleteSession(systemDb, token);
      clearSessionCookie(request, reply);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/me',
    {
      // Cloud: a session that must first verify or set up 2FA still learns who it is; the
      // page then sends it to that step (ADR-175).
      preHandler: requireUser({ allowRestricted: true }),
      schema: {
        summary: 'The signed-in user and their organisation, and the API token used',
        tags: ['auth', PUBLIC_TAG],
        response: { 200: MeResponse, 401: ProblemSchema },
      },
    },
    async (request) => {
      const t = request.apiToken;
      return {
        user: request.user!,
        token: t
          ? {
              name: t.name,
              prefix: t.prefix,
              scope: t.scope,
              expiresAt: t.expiresAt?.toISOString() ?? null,
            }
          : null,
      };
    },
  );
};
