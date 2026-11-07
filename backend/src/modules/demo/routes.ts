// SPDX-License-Identifier: AGPL-3.0-only
// POST /demo/session: a read-only session without a password, in demo mode only (ADR-122).
// The session is a signed cookie; nothing is stored per visitor.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { setDemoCookie } from '../../plugins/demo.js';
import { ProblemSchema, UserEnvelope } from '../auth/schemas.js';
import { DEMO_USER_EMAIL } from './constants.js';
import { ensureDemoUser, findDemoUser, type DemoSessions } from './service.js';

export const demoRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  demoMode: boolean;
  sessions: DemoSessions;
}> = async (app, { db, demoMode, sessions }) => {
  app.post(
    '/demo/session',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
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
      let user = await findDemoUser(db);
      if (!user) {
        await ensureDemoUser(db);
        user = await findDemoUser(db);
      }
      if (!user) return sendProblem(reply, 503, 'The demo is not ready; try again shortly');
      const { token, expiresAt } = sessions.issue();
      setDemoCookie(request, reply, token, expiresAt);
      return { user };
    },
  );
};
