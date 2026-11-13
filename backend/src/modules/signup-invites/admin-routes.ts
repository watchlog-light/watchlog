// SPDX-License-Identifier: AGPL-3.0-only
// The Cloud admin's side of invite waves (ADR-173), on the internal admin API: the signup
// mode, and signup invites issued for one address each. Registered inside the admin
// routes, so each call needs the internal token and X-WatchLog-Staff.
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { ProblemSchema } from '../auth/schemas.js';
import {
  getSignupMode,
  issueSignupInvite,
  listSignupInvites,
  setSignupMode,
  SIGNUP_INVITE_TTL_MS,
} from './service.js';

const Iso = Type.String({ format: 'date-time' });
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) =>
  Type.Union([t, Type.Null()]);
const Mode = Type.Union([Type.Literal('invite'), Type.Literal('public')]);
const ModeView = Type.Object({
  mode: Mode,
  changedAt: Nullable(Iso),
  changedBy: Nullable(Type.String()),
});
const InviteView = Type.Object({
  id: Type.String(),
  email: Type.String(),
  createdAt: Iso,
  createdBy: Type.String(),
  expiresAt: Iso,
  usedAt: Nullable(Iso),
  revokedAt: Nullable(Iso),
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('used'),
    Type.Literal('expired'),
    Type.Literal('revoked'),
  ]),
});
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/;

export function signupAdminRoutes(
  base: FastifyInstance,
  deps: {
    systemDb: Database;
    now: () => Date;
    /** The product's public address, for the invite's link (null: none in the answer). */
    publicUrl: () => Promise<string | null>;
  },
) {
  const app = base.withTypeProvider<TypeBoxTypeProvider>();
  const { systemDb } = deps;

  app.get(
    '/internal/admin/signup-mode',
    {
      schema: {
        summary: 'How Cloud signup is open: invite (waves) or public',
        response: { 200: ModeView, 400: ProblemSchema, 401: ProblemSchema },
      },
    },
    async () => getSignupMode(systemDb),
  );

  app.put(
    '/internal/admin/signup-mode',
    {
      schema: {
        summary: 'Switch Cloud signup between invite (waves) and public',
        body: Type.Object({ mode: Mode }, { additionalProperties: false }),
        response: { 200: ModeView, 400: ProblemSchema, 401: ProblemSchema },
      },
    },
    async (request) => {
      const before = await getSignupMode(systemDb);
      const saved = await setSignupMode(systemDb, request.body.mode, request.staffEmail!);
      request.log.info(
        { from: before.mode, to: saved.mode, staff: request.staffEmail },
        'signup mode set by staff',
      );
      return saved;
    },
  );

  app.post(
    '/internal/admin/signup-invites',
    {
      schema: {
        summary:
          'Issue a signup invite for one address (single use, 14 days); an earlier unused one stops working',
        body: Type.Object(
          { email: Type.String({ minLength: 3, maxLength: 254 }) },
          { additionalProperties: false },
        ),
        response: {
          201: Type.Object({
            invite: InviteView,
            /** Shown once; only its hash is stored. */
            code: Type.String(),
            /** `<public URL>/signup?invite=<code>`, or null without WATCHLOG_PUBLIC_URL. */
            url: Nullable(Type.String()),
          }),
          400: ProblemSchema,
          401: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const email = request.body.email.trim().toLowerCase();
      if (!EMAIL.test(email)) {
        return sendProblem(reply, 400, 'Not an email address');
      }
      const { invite, code } = await issueSignupInvite(systemDb, {
        email,
        staffEmail: request.staffEmail!,
        now: deps.now(),
      });
      const site = (await deps.publicUrl())?.replace(/\/+$/, '');
      request.log.info(
        { invite: invite.id, staff: request.staffEmail, days: SIGNUP_INVITE_TTL_MS / 86_400_000 },
        'signup invite issued',
      );
      return reply.code(201).send({
        invite,
        code,
        url: site ? `${site}/signup?invite=${encodeURIComponent(code)}` : null,
      });
    },
  );

  app.get(
    '/internal/admin/signup-invites',
    {
      schema: {
        summary: 'Signup invites, newest first, with their state (pending, used, expired, revoked)',
        querystring: Type.Object({
          email: Type.Optional(Type.String({ maxLength: 254 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 200 })),
        }),
        response: {
          200: Type.Object({ invites: Type.Array(InviteView) }),
          400: ProblemSchema,
          401: ProblemSchema,
        },
      },
    },
    async (request) => ({
      invites: await listSignupInvites(systemDb, {
        email: request.query.email?.trim() || undefined,
        limit: request.query.limit ?? 200,
        now: deps.now().getTime(),
      }),
    }),
  );
}
