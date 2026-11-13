// SPDX-License-Identifier: AGPL-3.0-only
// Support mode's public routes (ADR-179), Cloud only:
//   - GET /support/enter?code=wl_sc_…: the sign-in link the Cloud admin opens. Trades the
//     one-time code for the `wl_support` cookie (HttpOnly, Secure, SameSite=Strict, until
//     the session ends) and sends the browser to the dashboard;
//   - GET /support/current: the banner's facts while in support mode (404 otherwise);
//   - DELETE /support/session: leave support mode (ends the session, clears the cookie);
//   - GET /support-sessions: the org's sessions for its Owners (Settings › Security).
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { clearSupportCookie } from '../../plugins/support.js';
import { ProblemSchema } from '../auth/schemas.js';
import {
  endSupportSession,
  enterSupportSession,
  listSupportSessions,
  SUPPORT_COOKIE,
} from './service.js';

const Iso = Type.String({ format: 'date-time' });
export const SupportSessionSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  staffEmail: Type.String(),
  reason: Type.String(),
  startedAt: Iso,
  expiresAt: Iso,
  enteredAt: Type.Union([Iso, Type.Null()]),
  endedAt: Type.Union([Iso, Type.Null()]),
  opened: Type.Array(Type.Object({ path: Type.String(), count: Type.Integer(), at: Iso })),
});

export const supportRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  systemDb: Database;
}> = async (app, { db, systemDb }) => {
  app.get(
    '/support/enter',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        summary: 'Cloud: opens a support session in this browser from its one-time link',
        tags: ['cloud'],
        hide: true,
        querystring: Type.Object({ code: Type.String({ maxLength: 80 }) }),
        response: { 302: Type.Null(), 400: ProblemSchema },
      },
    },
    async (request, reply) => {
      // Before any org: the code names the session (the owner's connection).
      const entered = await enterSupportSession(systemDb, request.query.code);
      if (!entered) {
        return sendProblem(reply, 400, 'This support link has expired or was already used.');
      }
      reply.setCookie(SUPPORT_COOKIE, entered.token, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: true,
        expires: entered.expiresAt,
      });
      request.log.info(
        { supportSession: entered.sessionId, orgId: entered.orgId },
        'support session entered',
      );
      reply.header('cache-control', 'no-store');
      return reply.redirect('/', 302);
    },
  );

  app.get(
    '/support/current',
    {
      preHandler: requireUser(),
      schema: {
        summary: 'Cloud: the support session this browser is in (the dashboard’s banner)',
        tags: ['cloud'],
        response: {
          200: Type.Object({
            sessionId: Type.String({ format: 'uuid' }),
            staffEmail: Type.String(),
            reason: Type.String(),
            expiresAt: Iso,
            org: Type.Object({ id: Type.String(), name: Type.String() }),
          }),
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const s = request.user!.support;
      if (!s) return sendProblem(reply, 404, 'Not in support mode');
      return {
        sessionId: s.sessionId,
        staffEmail: s.staffEmail,
        reason: s.reason,
        expiresAt: s.expiresAt.toISOString(),
        org: { id: request.user!.org.id, name: request.user!.org.name },
      };
    },
  );

  app.delete(
    '/support/session',
    {
      preHandler: requireUser(),
      schema: {
        summary: 'Cloud: leaves support mode (ends the session)',
        tags: ['cloud'],
        response: { 204: Type.Null(), 401: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const s = request.user!.support;
      if (!s) return sendProblem(reply, 404, 'Not in support mode');
      await endSupportSession(systemDb, s.sessionId, request.user!.org.id, {
        staffEmail: s.staffEmail,
        ip: request.ip,
      });
      clearSupportCookie(request, reply);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/support-sessions',
    {
      preHandler: [requireUser(), requireRole('owner')],
      schema: {
        summary: "Cloud: WatchLog staff's support sessions in this organization (Owners)",
        tags: ['cloud'],
        response: {
          200: Type.Object({ sessions: Type.Array(SupportSessionSchema) }),
          401: ProblemSchema,
          403: ProblemSchema,
        },
      },
    },
    async (request) => ({ sessions: await listSupportSessions(db, request.user!.org.id) }),
  );
};
