// SPDX-License-Identifier: AGPL-3.0-only
// Settings › Plan & billing's actions (ADR-178), Cloud only, through the billing service:
//   GET  /plan/billing   the org's billing state (any member: the page shows it);
//   POST /plan/beta      "Start Pro, free during beta" while billing is off (Owner);
//   POST /plan/checkout  "Upgrade": a Stripe Checkout URL once billing is live (Owner);
//   POST /plan/portal    "Manage billing": a Customer Portal URL (Owner).
// The org is always the session's; the billing service writes the entitlements back
// through the internal API, so the plan changes there, never here.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import { Type } from 'typebox';
import { PROBLEM_CONTENT_TYPE } from '../../lib/problem.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import type { EntitlementsService } from '../entitlements/service.js';
import {
  BillingRefused,
  BillingUnavailable,
  type BillingClient,
  type BillingState,
} from './client.js';

export interface BillingRouteOptions {
  billing: BillingClient | null;
  entitlements: EntitlementsService;
}

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) =>
  Type.Union([t, Type.Null()]);

export const BillingStateSchema = Type.Object({
  /** False: no billing service configured, or it can't be reached now. */
  available: Type.Boolean(),
  /** The live switch: false = "Pro free during beta", true = Checkout and the portal. */
  live: Type.Boolean(),
  customer: Type.Boolean(),
  subscription: Nullable(
    Type.Object({
      interval: Type.Union([Type.Literal('monthly'), Type.Literal('annual')]),
      status: Type.String(),
      committedNodes: Nullable(Type.Integer()),
      currentPeriodEnd: Nullable(Type.String()),
      cancelAtPeriodEnd: Type.Boolean(),
    }),
  ),
  beta: Nullable(Type.Object({ startedAt: Type.String(), betaUntil: Nullable(Type.String()) })),
  dunning: Nullable(
    Type.Object({ since: Type.String(), downgradeAt: Type.String(), downgraded: Type.Boolean() }),
  ),
});

const UNAVAILABLE = {
  available: false,
  live: false,
  customer: false,
  subscription: null,
  beta: null,
  dunning: null,
};

const view = (s: BillingState) => ({
  available: true,
  live: s.live,
  customer: s.customer,
  subscription: s.subscription,
  beta: s.beta,
  dunning: s.dunning,
});

function sendBillingProblem(reply: FastifyReply, status: number, code: string, detail: string) {
  return reply
    .code(status)
    .type(PROBLEM_CONTENT_TYPE)
    .send({
      type: `urn:watchlog:problem:${code}`,
      title: status >= 500 ? 'Service Unavailable' : 'Conflict',
      status,
      detail,
      instance: reply.request.url,
      code,
    });
}

const RedirectSchema = Type.Object({ url: Type.String() });
const errors = { 401: ProblemSchema, 403: ProblemSchema, 409: ProblemSchema, 503: ProblemSchema };

export const billingRoutes: FastifyPluginAsyncTypebox<BillingRouteOptions> = async (app, opts) => {
  const { billing, entitlements } = opts;
  const ownerOnly = [requireUser(), requireRole('owner')];

  /** Runs a billing call; the billing service's refusals and outages become problems. */
  async function through<T>(reply: FastifyReply, run: (b: BillingClient) => Promise<T>) {
    if (!billing) {
      return sendBillingProblem(reply, 503, 'billing-unavailable', 'Billing isn’t set up here');
    }
    try {
      return await run(billing);
    } catch (err) {
      if (err instanceof BillingRefused) {
        return sendBillingProblem(reply, err.status, err.code, err.code);
      }
      if (err instanceof BillingUnavailable) {
        reply.request.log.warn({ err: err.message }, 'billing service unavailable');
        return sendBillingProblem(reply, 503, 'billing-unavailable', 'Billing is unavailable');
      }
      throw err;
    }
  }

  app.get(
    '/plan/billing',
    {
      preHandler: requireUser(),
      schema: {
        summary: "Cloud: the org's billing state (beta, subscription, live switch)",
        tags: ['cloud'],
        response: { 200: BillingStateSchema, 401: ProblemSchema },
      },
    },
    async (request) => {
      if (!billing) return UNAVAILABLE;
      try {
        return view(await billing.state(request.user!.org.id));
      } catch (err) {
        request.log.warn({ err: (err as Error).message }, 'billing service unavailable');
        return UNAVAILABLE;
      }
    },
  );

  app.post(
    '/plan/beta',
    {
      preHandler: ownerOnly,
      schema: {
        summary: 'Cloud: start Pro, free during the beta (Owner; while billing is off)',
        tags: ['cloud'],
        response: { 200: BillingStateSchema, ...errors },
      },
    },
    async (request, reply) =>
      through(reply, async (b) => {
        const orgId = request.user!.org.id;
        const s = await b.startBeta(orgId);
        // The billing service wrote Pro through the internal API; read it fresh here too.
        entitlements.invalidate(orgId);
        return view(s);
      }),
  );

  app.post(
    '/plan/checkout',
    {
      preHandler: ownerOnly,
      schema: {
        summary: 'Cloud: a Stripe Checkout page for Pro (Owner; once billing is live)',
        tags: ['cloud'],
        body: Type.Object(
          {
            interval: Type.Union([Type.Literal('monthly'), Type.Literal('annual')]),
            /** Annual: the committed node count (the billing service makes it at least 10). */
            nodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: RedirectSchema, 400: ProblemSchema, ...errors },
      },
    },
    async (request, reply) =>
      through(reply, (b) =>
        b.checkout(request.user!.org.id, {
          interval: request.body.interval,
          ...(request.body.nodes ? { nodes: request.body.nodes } : {}),
          email: request.user!.email,
          orgName: request.user!.org.name,
        }),
      ),
  );

  app.post(
    '/plan/portal',
    {
      preHandler: ownerOnly,
      schema: {
        summary: "Cloud: a Stripe Customer Portal page for the org's billing (Owner)",
        tags: ['cloud'],
        response: { 200: RedirectSchema, ...errors },
      },
    },
    async (request, reply) => through(reply, (b) => b.portal(request.user!.org.id)),
  );
};
