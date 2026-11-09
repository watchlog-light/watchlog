// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { Email, NewPassword, ProblemSchema, UserEnvelope } from '../auth/schemas.js';
import { createSession, findSessionUser, setSessionCookie } from '../auth/sessions.js';
import { createAdmin, SetupAlreadyCompleteError, type SetupState } from './service.js';

export const setupRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  setup: SetupState;
  /** Runs once the org exists (Helm cluster bootstrap, ADR-069); errors are logged. */
  afterSetup?: () => Promise<void>;
  /** Read-only demo (ADR-122): setup is never offered, the web shows the demo entry. */
  demoMode?: boolean;
  /** The demo's public MCP token (ADR-130), offered on Settings → API tokens. */
  demoMcpToken?: string;
  /** Whether email is set up: "Forgot your password?" emails a link, else shows the command (ADR-140). */
  smtpConfigured?: () => Promise<boolean>;
}> = async (app, { db, setup, afterSetup, demoMode = false, demoMcpToken, smtpConfigured }) => {
  app.get(
    '/setup',
    {
      schema: {
        summary: 'Whether first-run setup is still required, and whether this is a read-only demo',
        tags: ['setup'],
        response: {
          200: Type.Object({
            required: Type.Boolean(),
            demoMode: Type.Boolean({
              description: 'A read-only demo: sign in with POST /demo/session; changes answer 403',
            }),
            demoMcpToken: Type.Union([Type.String(), Type.Null()], {
              description: "The live demo's public, read-only MCP token; null elsewhere",
            }),
            smtp: Type.Boolean({
              description: 'Email is set up: "Forgot your password?" emails a reset link',
            }),
          }),
        },
      },
    },
    async () => ({
      required: !demoMode && (await setup.isRequired(db)),
      demoMode,
      demoMcpToken: demoMode ? (demoMcpToken ?? null) : null,
      smtp: !demoMode && !!(await smtpConfigured?.().catch(() => false)),
    }),
  );

  app.post(
    '/setup',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        summary: 'Create the admin account using the setup code from the backend log',
        tags: ['setup'],
        body: Type.Object({
          code: Type.String({ minLength: 1, maxLength: 32 }),
          name: Type.String({ minLength: 1, maxLength: 100 }),
          email: Email,
          password: NewPassword,
        }),
        response: { 201: UserEnvelope, 403: ProblemSchema, 409: ProblemSchema, 429: ProblemSchema },
      },
    },
    async (request, reply) => {
      if (!(await setup.isRequired(db))) {
        return sendProblem(reply, 409, 'Setup is already complete');
      }
      if (!setup.verifyCode(request.body.code)) {
        return sendProblem(reply, 403, 'Invalid setup code. It is printed in the backend log.');
      }

      let userId: string;
      try {
        userId = await createAdmin(db, {
          email: request.body.email.trim().toLowerCase(),
          name: request.body.name.trim(),
          password: request.body.password,
        });
      } catch (err) {
        if (err instanceof SetupAlreadyCompleteError) {
          return sendProblem(reply, 409, err.message);
        }
        throw err;
      }
      setup.markComplete();
      request.log.info({ userId }, 'first-run setup complete');
      await afterSetup?.().catch((err: Error) =>
        request.log.error({ err: err.message }, 'post-setup bootstrap failed'),
      );

      const { token, expiresAt } = await createSession(db, userId);
      const user = await findSessionUser(db, token);
      setSessionCookie(request, reply, token, expiresAt);
      return reply.code(201).send({ user: user! });
    },
  );
};
