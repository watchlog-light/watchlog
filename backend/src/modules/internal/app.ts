// SPDX-License-Identifier: AGPL-3.0-only
// The internal API (ADR-177, ADR-178), Cloud only: what the billing service and staff call
// to set an org's entitlements, read its usage and reach its Owners (the billing emails).
// It is its own Fastify app on its own listener (WATCHLOG_INTERNAL_HOST:
// WATCHLOG_INTERNAL_PORT), which the Cloud kit keeps on
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
import type { EntitlementsService } from '../entitlements/service.js';
import { usageReport } from '../entitlements/usage.js';
import type { FunnelRecorder } from '../funnel/recorder.js';
import type { AlertingSettings } from '../settings/service.js';
import { adminRoutes } from './admin.js';
import { EntitlementView, entitlementView, Limit, PlanLiteral, UsageView } from './views.js';

export interface InternalAppDeps {
  systemDb: Database;
  entitlements: EntitlementsService;
  /** Cloud's funnel (ADR-179): `pro_started` when billing or staff first set Pro. */
  funnel?: FunnelRecorder | null;
  /** The email server and public address: support links and the Owners' email (ADR-179). */
  settings?: () => Promise<Pick<AlertingSettings, 'smtp' | 'publicUrl'>>;
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

  // Every request, also to an unknown path: the token first. Each caller has its own
  // (SR-5): /internal/admin/* takes only the Cloud admin's token, everything else only the
  // billing service's, so a leak from one service reaches only its own routes.
  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const path = request.url.split('?')[0]!;
    const admin = path === '/internal/admin' || path.startsWith('/internal/admin/');
    const ok = admin
      ? cfg.adminToken !== undefined &&
        internalTokenMatches(given, {
          token: cfg.adminToken,
          previousToken: cfg.previousAdminToken,
        })
      : internalTokenMatches(given, cfg);
    if (!ok) return sendProblem(reply, 401, 'Missing or invalid internal token');
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
      return entitlementView(await entitlements.get(request.params.id));
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
      // The funnel (ADR-179): the first Pro, once per org (the beta's comes from the product).
      if (saved.plan === 'pro' && deps.funnel) {
        await deps.funnel.record({ name: 'pro_started', orgId: id, props: { source: b.source } });
      }
      return entitlementView(saved);
    },
  );

  app.get(
    '/internal/orgs/:id/owners',
    {
      schema: {
        summary: "An org's Owners, for the billing service's emails (dunning, the beta's notice)",
        params: Params,
        response: {
          200: Type.Object({
            owners: Type.Array(
              Type.Object({ email: Type.String(), name: Type.Union([Type.String(), Type.Null()]) }),
            ),
          }),
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await orgExists(id))) return sendProblem(reply, 404, 'No such org');
      const rows = await systemDb
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select(['u.email', 'u.name'])
        .where('m.org_id', '=', id)
        .where('m.role', '=', 'owner')
        .orderBy('m.created_at')
        .execute();
      return { owners: rows.map((r) => ({ email: r.email, name: r.name || null })) };
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

  app.post(
    '/internal/orgs/:id/beta-notice',
    {
      schema: {
        summary:
          "Billing asks for the beta-to-billing notice (ADR-179): the lifecycle job emails the org's Owners once",
        params: Params,
        body: Type.Object(
          { billingStartsAt: Type.String({ format: 'date-time' }) },
          { additionalProperties: false },
        ),
        response: { 202: Type.Null(), 400: ProblemSchema, 401: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await orgExists(id))) return sendProblem(reply, 404, 'No such org');
      const startsAt = new Date(request.body.billingStartsAt);
      await systemDb
        .insertInto('beta_notices')
        .values({ org_id: id, billing_starts_at: startsAt })
        .onConflict((oc) => oc.column('org_id').doUpdateSet({ billing_starts_at: startsAt }))
        .execute();
      return reply.code(202).send(null);
    },
  );

  // The Cloud admin's API (ADR-179): the staff member named in X-WatchLog-Staff.
  await app.register(adminRoutes, {
    systemDb,
    entitlements,
    funnel: deps.funnel,
    settings: deps.settings,
    now: deps.now,
    staffEmails: cfg.staffEmails,
  });

  return app;
}
