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

const INVALID_CREDENTIALS = 'Invalid email or password';

export const authRoutes: FastifyPluginAsyncTypebox<{ db: Database }> = async (app, { db }) => {
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
        response: { 200: UserEnvelope, 401: ProblemSchema, 429: ProblemSchema },
      },
    },
    async (request, reply) => {
      const email = request.body.email.trim().toLowerCase();
      const user = await db
        .selectFrom('users')
        .select(['id', 'password_hash'])
        .where('email', '=', email)
        .executeTakeFirst();
      if (!user) {
        await verifyDummyPassword(request.body.password);
        return sendProblem(reply, 401, INVALID_CREDENTIALS);
      }
      if (!(await verifyPassword(user.password_hash, request.body.password))) {
        return sendProblem(reply, 401, INVALID_CREDENTIALS);
      }

      const { token, expiresAt } = await createSession(db, user.id);
      const current = await findSessionUser(db, token);
      if (!current) {
        // A user without a membership cannot sign in; this indicates broken data.
        request.log.error({ userId: user.id }, 'user has no org membership');
        await deleteSession(db, token);
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
      if (token) await deleteSession(db, token);
      clearSessionCookie(request, reply);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/me',
    {
      preHandler: requireUser(db),
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
