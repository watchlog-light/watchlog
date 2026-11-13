// SPDX-License-Identifier: AGPL-3.0-only
// The internal API (ADR-177, ADR-178), Cloud only: what the billing service and staff call
// to set an org's entitlements and read its usage. It is its own Fastify app on its own
// listener (WATCHLOG_INTERNAL_HOST:WATCHLOG_INTERNAL_PORT), which the Cloud kit keeps on
// the Compose network, never behind the public nginx; the public listener has no
// /internal routes at all (404). Every request needs `Authorization: Bearer
// <WATCHLOG_INTERNAL_TOKEN>` (or the previous token during a rotation), compared in
// constant time. It works across orgs, so it runs on the owner's connection (systemDb,
// ADR-174's allow-list).
import { createHash, timingSafeEqual } from 'node:crypto';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { Type } from 'typebox';
import type { InternalApiConfig } from '../../config.js';
import type { Database } from '../../db/index.js';
import { registerProblemHandlers, sendProblem } from '../../lib/problem.js';
import { ProblemSchema } from '../auth/schemas.js';
import type { Entitlement } from '../entitlements/plans.js';
import type { EntitlementsService } from '../entitlements/service.js';
import { usageReport } from '../entitlements/usage.js';

export interface InternalAppDeps {
  systemDb: Database;
  entitlements: EntitlementsService;
  logLevel?: string;
  /** Test hooks. */
  logStream?: { write(line: string): void };
  onRoute?: (route: RouteOptions) => void;
  now?: () => number;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** True when `given` is the token or the previous one; both are compared every time. */
export function internalTokenMatches(
  given: string,
  cfg: Pick<InternalApiConfig, 'token' | 'previousToken'>,
): boolean {
  const g = digest(given);
  const current = timingSafeEqual(g, digest(cfg.token));
  const previous = timingSafeEqual(g, digest(cfg.previousToken ?? `\u0000${cfg.token}`));
  return given.length > 0 && (current || (cfg.previousToken !== undefined && previous));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Limit = Type.Union([Type.Integer({ minimum: 0, maximum: 1_000_000 }), Type.Null()]);
const PlanLiteral = Type.Union([
  Type.Literal('free'),
  Type.Literal('pro'),
  Type.Literal('enterprise'),
]);

export const EntitlementView = Type.Object({
  orgId: Type.String(),
  plan: PlanLiteral,
  source: Type.String(),
  clusters: Limit,
  nodes: Limit,
  users: Limit,
  retentionDays: Type.Integer(),
  proFeatures: Type.Boolean(),
  betaUntil: Type.Union([Type.String(), Type.Null()]),
  graceUntil: Type.Union([Type.String(), Type.Null()]),
  previousRetentionDays: Type.Union([Type.Integer(), Type.Null()]),
  retentionChangedAt: Type.Union([Type.String(), Type.Null()]),
  stored: Type.Boolean(),
});

export const EntitlementBody = Type.Object(
  {
    plan: PlanLiteral,
    /** Who sets it: the beta switch, billing (Stripe), or staff. Signup's is the product's. */
    source: Type.Union([Type.Literal('beta'), Type.Literal('billing'), Type.Literal('staff')]),
    clusters: Type.Optional(Limit),
    nodes: Type.Optional(Limit),
    users: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1, maximum: 1_000_000 }), Type.Null()]),
    ),
    retentionDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3660 })),
    proFeatures: Type.Optional(Type.Boolean()),
    betaUntil: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
  },
  { additionalProperties: false },
);

export const UsageView = Type.Object({
  orgId: Type.String(),
  from: Type.String(),
  to: Type.String(),
  hoursInPeriod: Type.Integer(),
  p95: Type.Integer(),
  peak: Type.Integer(),
  hours: Type.Array(
    Type.Object({
      hour: Type.String(),
      nodes: Type.Integer(),
      dockerHosts: Type.Integer(),
      total: Type.Integer(),
    }),
  ),
});

function view(e: Entitlement) {
  return {
    orgId: e.orgId,
    plan: e.plan,
    source: e.source,
    clusters: e.clusters,
    nodes: e.nodes,
    users: e.users,
    retentionDays: e.retentionDays,
    proFeatures: e.proFeatures,
    betaUntil: e.betaUntil?.toISOString() ?? null,
    graceUntil: e.graceUntil?.toISOString() ?? null,
    previousRetentionDays: e.previousRetentionDays,
    retentionChangedAt: e.retentionChangedAt?.toISOString() ?? null,
    stored: e.stored,
  };
}

/** Longest usage period one call returns (a year and a month). */
const MAX_USAGE_MS = 400 * 86_400_000;

export async function buildInternalApp(
  cfg: InternalApiConfig,
  deps: InternalAppDeps,
): Promise<FastifyInstance> {
  const { systemDb, entitlements } = deps;
  const app = Fastify({
    logger: {
      level: deps.logLevel ?? 'info',
      redact: ['req.headers.authorization'],
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
  }).withTypeProvider<TypeBoxTypeProvider>();
  if (deps.onRoute) app.addHook('onRoute', deps.onRoute);
  registerProblemHandlers(app);
  app.removeContentTypeParser('text/plain');

  // Every request, also to an unknown path: the token first.
  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!internalTokenMatches(given, cfg)) {
      return sendProblem(reply, 401, 'Missing or invalid internal token');
    }
  });

  const orgExists = async (id: string) =>
    UUID.test(id) &&
    !!(await systemDb.selectFrom('orgs').select('id').where('id', '=', id).executeTakeFirst());
  const Params = Type.Object({ id: Type.String({ maxLength: 64 }) });

  app.get(
    '/internal/orgs/:id/entitlements',
    {
      schema: {
        summary: "An org's entitlements (Free's defaults when it has no row)",
        params: Params,
        response: { 200: EntitlementView, 401: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      if (!(await orgExists(request.params.id))) return sendProblem(reply, 404, 'No such org');
      return view(await entitlements.get(request.params.id));
    },
  );

  app.put(
    '/internal/orgs/:id/entitlements',
    {
      schema: {
        summary:
          "Sets an org's entitlements: the plan's defaults, with any limit given overriding them",
        params: Params,
        body: EntitlementBody,
        response: {
          200: EntitlementView,
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await orgExists(id))) return sendProblem(reply, 404, 'No such org');
      const b = request.body;
      const saved = await entitlements.put(id, {
        plan: b.plan,
        source: b.source,
        clusters: b.clusters,
        nodes: b.nodes,
        users: b.users,
        retentionDays: b.retentionDays,
        proFeatures: b.proFeatures,
        betaUntil: b.betaUntil ? new Date(b.betaUntil) : null,
      });
      request.log.info(
        { orgId: id, plan: saved.plan, source: saved.source, graceUntil: saved.graceUntil },
        'entitlements set',
      );
      return view(saved);
    },
  );

  app.get(
    '/internal/orgs/:id/usage',
    {
      schema: {
        summary:
          "An org's hourly node and Docker host counts and their 95th percentile from `from` to `to`",
        params: Params,
        querystring: Type.Object({
          from: Type.String({ format: 'date-time' }),
          to: Type.String({ format: 'date-time' }),
        }),
        response: {
          200: UsageView,
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const from = new Date(request.query.from);
      const to = new Date(request.query.to);
      if (!(to > from) || to.getTime() - from.getTime() > MAX_USAGE_MS) {
        return sendProblem(reply, 400, '`to` must be after `from`, at most 400 days later');
      }
      if (!(await orgExists(id))) return sendProblem(reply, 404, 'No such org');
      const report = await usageReport(systemDb, id, from, to, (deps.now ?? Date.now)());
      return { orgId: id, ...report };
    },
  );

  return app;
}
