// SPDX-License-Identifier: AGPL-3.0-only
// Settings → License (ADR-232), self-hosted only: every route here answers 404 in Cloud
// (`communityOnly`, ADR-174), where entitlements decide and keys are ignored.
//   GET    /license          the licence, its state and units (Owner)
//   PUT    /license          paste a key: checked at once, saved when it works (Owner)
//   DELETE /license          remove the pasted key (Owner)
//   GET    /license/summary  what every member's dashboard needs: the edition, whether Pro
//                            features are on, when they ended; the customer and the banners
//                            for Owners only
// A key from the environment wins over the pasted one, and the page says so. The key itself
// is never returned, to anyone.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { FROM_ENVIRONMENT } from '../settings/routes.js';
import { actorOf, audit } from '../users/service.js';
import { proAccess } from './pro.js';
import type { LicenseService } from './service.js';
import { bannersOf, editionOf, licenseView, type LicenseView } from './status.js';
import { countUnits } from './units.js';

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) =>
  Type.Union([t, Type.Null()]);
const State = Type.Union([
  Type.Literal('valid'),
  Type.Literal('expiring'),
  Type.Literal('grace'),
  Type.Literal('expired'),
  Type.Literal('invalid'),
  Type.Literal('none'),
]);
const BannerSchema = Type.Union([
  Type.Object({ kind: Type.Literal('invalid'), reason: Type.String() }),
  Type.Object({ kind: Type.Literal('ended'), endedOn: Type.String() }),
  Type.Object({ kind: Type.Literal('grace'), endedOn: Type.String(), stopsOn: Type.String() }),
  Type.Object({ kind: Type.Literal('expiring'), endsOn: Type.String(), days: Type.Integer() }),
  Type.Object({
    kind: Type.Literal('over'),
    used: Type.Integer(),
    limit: Type.Integer(),
    closedSince: Nullable(Type.String()),
  }),
]);
export const LicenseViewSchema = Type.Object({
  source: Type.Union([
    Type.Literal('env'),
    Type.Literal('file'),
    Type.Literal('setting'),
    Type.Literal('none'),
  ]),
  shadowed: Type.Boolean({ description: 'A pasted key is set, but the environment wins' }),
  fileError: Nullable(Type.String()),
  state: State,
  reason: Type.String(),
  license: Nullable(
    Type.Object({
      id: Type.String(),
      customer: Type.String(),
      edition: Type.Literal('enterprise'),
      units: Type.Integer(),
      features: Type.Array(Type.String()),
      issuedAt: Type.String({ format: 'date-time' }),
      expiresAt: Type.String({ format: 'date-time' }),
      graceEndsAt: Type.String({ format: 'date-time' }),
    }),
  ),
  units: Nullable(
    Type.Object({
      used: Type.Integer({ description: 'The highest daily count of the last 7 days' }),
      limit: Type.Integer(),
      over: Type.Boolean(),
      overSince: Nullable(Type.String()),
      overDays: Type.Integer(),
      closedSince: Nullable(
        Type.String({ description: 'After 30 days over: no new places from this day' }),
      ),
      parts: Type.Record(Type.String(), Type.Integer()),
    }),
  ),
  banners: Type.Array(BannerSchema),
});
const SummarySchema = Type.Object({
  edition: Type.Union([Type.Literal('community'), Type.Literal('enterprise')]),
  licensed: Type.Boolean({
    description: 'A licence is set and works now (valid, expiring, grace)',
  }),
  pro: Type.Boolean({ description: 'Pro features are on for this installation' }),
  features: Type.Array(Type.String(), {
    description: "The working licence's features (pro, network); empty without one",
  }),
  endedOn: Nullable(Type.String({ description: 'The licence with pro ended on this day' })),
  customer: Nullable(Type.String({ description: 'Owners only; null for everyone else' })),
  banners: Type.Array(BannerSchema, { description: 'Owners only; empty for everyone else' }),
});

export const licenseRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  license: LicenseService;
  config: { edition: 'community' | 'cloud'; demoMode: boolean };
  now?: () => number;
}> = async (app, { db, license, config, now = Date.now }) => {
  app.addHook('onRoute', (route) => {
    route.config = { ...(route.config ?? {}), communityOnly: true };
  });
  const owner = [requireUser(), requireRole('owner')];

  async function view(): Promise<LicenseView & { banners: ReturnType<typeof bannersOf> }> {
    const cur = await license.current();
    const p = cur.check?.payload;
    const units = p ? await countUnits(db, now(), p.units) : null;
    const v = licenseView(cur, units);
    return { ...v, banners: bannersOf(v, now()) };
  }

  app.get(
    '/license',
    {
      preHandler: owner,
      schema: {
        summary: "This installation's Enterprise licence: who it is for, its state and units",
        tags: ['license'],
        response: { 200: LicenseViewSchema, 401: ProblemSchema, 403: ProblemSchema },
      },
    },
    view,
  );

  app.put(
    '/license',
    {
      preHandler: owner,
      schema: {
        summary: 'Paste a licence key: checked offline at once, kept when it works',
        tags: ['license'],
        body: Type.Object(
          { key: Type.String({ minLength: 1, maxLength: 8192 }) },
          { additionalProperties: false },
        ),
        response: {
          200: LicenseViewSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          409: ProblemSchema,
          422: Type.Object({
            type: Type.String(),
            title: Type.String(),
            status: Type.Integer(),
            detail: Type.String(),
            state: State,
          }),
        },
      },
    },
    async (request, reply) => {
      const cur = await license.current();
      if (cur.source === 'env' || cur.source === 'file') {
        return sendProblem(reply, 409, FROM_ENVIRONMENT);
      }
      const check = license.test(request.body.key);
      if (check.state === 'invalid' || check.state === 'expired') {
        return reply
          .code(422)
          .type('application/problem+json')
          .send({
            type: 'about:blank',
            title: 'Unprocessable Content',
            status: 422,
            detail:
              check.state === 'expired'
                ? `This key ${check.reason}; it can't turn licensed features on.`
                : `This isn't a working licence key: ${check.reason}.`,
            state: check.state,
          });
      }
      await license.save(request.body.key, request.user!.id);
      await audit(db, {
        orgId: request.user!.org.id,
        action: 'license_set',
        actor: actorOf(request),
        details: {
          id: check.payload!.id,
          customer: check.payload!.customer,
          expiresAt: check.payload!.expiresAt,
        },
      });
      return view();
    },
  );

  app.delete(
    '/license',
    {
      preHandler: owner,
      schema: {
        summary: 'Remove the pasted licence key: licensed features turn off, nothing is deleted',
        tags: ['license'],
        response: {
          200: LicenseViewSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cur = await license.current();
      if (cur.source === 'env' || cur.source === 'file') {
        return sendProblem(reply, 409, FROM_ENVIRONMENT);
      }
      const id = cur.check?.payload?.id ?? null;
      if (await license.remove()) {
        await audit(db, {
          orgId: request.user!.org.id,
          action: 'license_removed',
          actor: actorOf(request),
          details: { id },
        });
      }
      return view();
    },
  );

  app.get(
    '/license/summary',
    {
      preHandler: requireUser(),
      schema: {
        summary: 'The edition and whether Pro features are on, for the dashboard',
        tags: ['license'],
        response: { 200: SummarySchema, 401: ProblemSchema },
      },
    },
    async (request) => {
      const cur = await license.current();
      const access = await proAccess(config, license, request.user!.org.id);
      const isOwner = request.user!.role === 'owner';
      const v = isOwner ? await view() : null;
      return {
        edition:
          editionOf(config, cur) === 'enterprise'
            ? ('enterprise' as const)
            : ('community' as const),
        licensed: !!cur.check?.payload && ['valid', 'expiring', 'grace'].includes(cur.check.state),
        pro: access.ok,
        features:
          cur.check?.payload && ['valid', 'expiring', 'grace'].includes(cur.check.state)
            ? cur.check.payload.features
            : [],
        endedOn:
          !access.ok && access.status === 403 && access.type === 'license-ended'
            ? access.endedOn
            : null,
        customer: isOwner ? (cur.check?.payload?.customer ?? null) : null,
        banners: v?.banners ?? [],
      };
    },
  );
};
