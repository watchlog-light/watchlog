// SPDX-License-Identifier: AGPL-3.0-only
// POST /demo/session: a read-only session without a password, in demo mode only (ADR-122).
// The session is a signed cookie; nothing is stored per visitor.
// GET /demo/tour and /demo/tour/event/…: the guided tour's stories and its moments (1.3.0,
// ADR-246), in demo mode only.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { requireUser } from '../../plugins/auth.js';
import { setDemoCookie } from '../../plugins/demo.js';
import { Type } from 'typebox';
import { ProblemSchema, UserEnvelope } from '../auth/schemas.js';
import type { DemoTour } from '../seed/seed.js';
import { DEMO_SESSIONS_PER_MINUTE, DEMO_USER_EMAIL, TOUR_EVENTS } from './constants.js';
import { ensureDemoUser, findDemoUser, type DemoSessions } from './service.js';

export const demoRoutes: FastifyPluginAsyncTypebox<{
  /** The demo sign-in runs before the org is known: the owner's connection (ADR-174). */
  systemDb: Database;
  demoMode: boolean;
  sessions: DemoSessions;
  /** The seed's tour (ADR-246): the stories in the order the tour tries them. */
  tour?: DemoTour;
}> = async (app, { systemDb, demoMode, sessions, tour }) => {
  app.post(
    '/demo/session',
    {
      // Per visitor address; sessions are stateless and cost nothing to keep (ADR-122), so a
      // group behind one address (an office, a conference) can all come in (ADR-206).
      config: { rateLimit: { max: DEMO_SESSIONS_PER_MINUTE, timeWindow: '1 minute' } },
      schema: {
        summary: 'Start a read-only session as the demo viewer (demo mode only)',
        tags: ['auth'],
        response: { 200: UserEnvelope, 404: ProblemSchema, 429: ProblemSchema, 503: ProblemSchema },
      },
    },
    async (request, reply) => {
      if (!demoMode) return sendProblem(reply, 404, 'This server is not a demo');
      // A visitor whose demo cookie is still valid keeps it.
      if (request.user?.email === DEMO_USER_EMAIL) return { user: request.user };
      // Made at start; again here if the database was reset since.
      let user = await findDemoUser(systemDb);
      if (!user) {
        await ensureDemoUser(systemDb);
        user = await findDemoUser(systemDb);
      }
      if (!user) return sendProblem(reply, 503, 'The demo is not ready; try again shortly');
      const { token, expiresAt } = sessions.issue();
      setDemoCookie(request, reply, token, expiresAt);
      return { user };
    },
  );

  const signedIn = requireUser();

  // The tour's stories, in the order it tries them; none configured is an empty list (the
  // tour then stays away).
  app.get(
    '/demo/tour',
    {
      preHandler: signedIn,
      schema: {
        summary: "The live demo's guided tour: its stories in order (demo mode only)",
        tags: ['auth'],
        response: {
          200: Type.Object({
            stories: Type.Array(
              Type.Object({
                id: Type.String(),
                kind: Type.Union([Type.Literal('kubernetes'), Type.Literal('server')]),
                rules: Type.Array(Type.String()),
                labels: Type.Record(Type.String(), Type.String()),
                fallback: Type.Boolean(),
              }),
            ),
            another: Type.Array(Type.String()),
          }),
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (_request, reply) => {
      if (!demoMode) return sendProblem(reply, 404, 'This server is not a demo');
      return {
        stories: (tour?.stories ?? []).map((st) => ({
          id: st.id,
          kind: st.kind,
          rules: st.rules,
          labels: st.labels ?? {},
          fallback: st.fallback ?? false,
        })),
        another: tour?.another ?? [],
      };
    },
  );

  // One request per moment of the tour (shown, started, a step reached, finished, skipped,
  // Cloud or Install clicked, another story, replayed), answered with nothing. The demo's own
  // access log carries the path to the demo analytics, as it does every page (no query
  // string, no body, nothing about the visitor that the request didn't already carry).
  const event = async (_request: unknown, reply: FastifyReply) => {
    if (!demoMode) return sendProblem(reply, 404, 'This server is not a demo');
    reply.header('cache-control', 'no-store');
    return reply.code(204).send();
  };
  const EventName = Type.Union(TOUR_EVENTS.map((e) => Type.Literal(e)));
  const eventSchema = (withDetail: boolean) => ({
    preHandler: signedIn,
    schema: {
      summary: "A moment of the live demo's guided tour, for its analytics (demo mode only)",
      tags: ['auth'],
      params: Type.Object({
        name: EventName,
        ...(withDetail ? { detail: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,39}$' }) } : {}),
      }),
      response: { 204: Type.Null(), 400: ProblemSchema, 401: ProblemSchema, 404: ProblemSchema },
    },
  });
  app.get('/demo/tour/event/:name', eventSchema(false), event);
  app.get('/demo/tour/event/:name/:detail', eventSchema(true), event);
};
