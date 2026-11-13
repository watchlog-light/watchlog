// SPDX-License-Identifier: AGPL-3.0-only
// Onboarding's Cloud-only routes (ADR-176), registered through registerCloudOnly:
//   - GET /install.yaml?code=wl_ic_…, at the root of the ingest address: the kubectl
//     manifest with the cluster token in it. The code is the only credential; the cluster
//     token never goes into a URL;
//   - GET /api/v1/onboarding/first-week and POST …/dismiss: the overview's first-week card,
//     each step read from the org's real state, dismissed per user;
//   - POST /api/v1/funnel: the few funnel events only the page sees (a copy, a click).
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { sql } from 'kysely';
import { Type } from 'typebox';
import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { requireUser } from '../../plugins/auth.js';
import {
  CLIENT_FUNNEL_EVENTS,
  recordFunnelEvent,
  type FunnelEventName,
} from '../accounts/service.js';
import { ProblemSchema } from '../auth/schemas.js';
import { installTarget } from '../clusters/install.js';
import type { SettingsService } from '../settings/service.js';
import { resolveInstallCode } from './install-codes.js';
import type { EntitlementsService } from '../entitlements/service.js';
import { installManifest } from './manifest.js';

/** GET /install.yaml, at the root (the ingest address serves it). */
export const installManifestRoutes: FastifyPluginAsyncTypebox<{
  systemDb: Database;
  config: Config;
  settings: SettingsService;
}> = async (app, { systemDb, config, settings }) => {
  const target = installTarget(config, settings);
  app.get(
    '/install.yaml',
    {
      // The code is a credential: the request log masks it (requestWithoutCodes, app.ts).
      schema: {
        summary: 'The agent manifest for `kubectl apply -f`, with the cluster token in it',
        tags: ['clusters'],
        hide: true,
        querystring: Type.Object({ code: Type.String({ maxLength: 128 }) }),
      },
    },
    async (request, reply) => {
      // Before any org is known: the code names its cluster (ADR-174's pre-org lookups).
      const found = await resolveInstallCode(systemDb, request.query.code);
      if (!found) {
        return sendProblem(
          reply,
          404,
          'This install code is unknown or expired (codes last 24 hours). Copy a new command from WatchLog.',
        );
      }
      request.log.info({ clusterId: found.clusterId }, 'install manifest served');
      const endpoint = await target.endpointFor(request);
      return reply
        .header('content-type', 'application/yaml; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .send(installManifest({ token: found.token, endpoint, image: target.image }));
    },
  );
};

export type FirstWeekStepId = 'channel' | 'teammate' | 'application' | 'mcp' | 'problem';
const STEP_IDS: FirstWeekStepId[] = ['channel', 'teammate', 'application', 'mcp', 'problem'];

const FirstWeekSchema = Type.Object({
  dismissed: Type.Boolean(),
  steps: Type.Array(
    Type.Object({
      id: Type.Union([
        Type.Literal('channel'),
        Type.Literal('teammate'),
        Type.Literal('application'),
        Type.Literal('mcp'),
        Type.Literal('problem'),
      ]),
      done: Type.Boolean(),
      /** The plan doesn't allow the step (Cloud Free has one user): `plan-limit`. */
      blocked: Type.Union([Type.Literal('plan-limit'), Type.Null()]),
    }),
  ),
});

/** Under /api/v1, Cloud only: the first-week card and the page's funnel events. */
export const onboardingCloudRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  entitlements: EntitlementsService;
}> = async (app, { db, entitlements }) => {
  const signedIn = requireUser();

  /** Whether each step is done, from the org's own rows (RLS scopes every read). */
  async function stepsOf(orgId: string) {
    const exists = (table: string, extra = sql``) =>
      sql<boolean>`exists (select 1 from ${sql.table(table)} where org_id = ${orgId} ${extra})`;
    const row = await db
      .selectNoFrom([
        exists('alert_channels').as('channel'),
        sql<boolean>`(select count(*) from memberships where org_id = ${orgId}) > 1
          or exists (select 1 from invites where org_id = ${orgId} and revoked_at is null)`.as(
          'teammate',
        ),
        exists('integrations').as('application'),
        exists('mcp_calls').as('mcp'),
        exists('alert_states', sql`and cause is not null`).as('problem'),
      ])
      .executeTakeFirstOrThrow();
    return {
      done: {
        channel: row.channel,
        teammate: row.teammate,
        application: row.application,
        mcp: row.mcp,
        problem: row.problem,
      } satisfies Record<FirstWeekStepId, boolean>,
      // A teammate needs a second user: Cloud Free has one (ADR-177).
      oneUser: (await entitlements.get(orgId)).users === 1,
    };
  }

  app.get(
    '/onboarding/first-week',
    {
      preHandler: signedIn,
      schema: {
        summary: "The overview's first-week checklist: each step from the org's real state",
        tags: ['onboarding'],
        response: { 200: FirstWeekSchema, 401: ProblemSchema },
      },
    },
    async (request) => {
      const { id: userId, org } = request.user!;
      const { done, oneUser } = await stepsOf(org.id);
      const state = await db
        .selectFrom('onboarding_states')
        .select(['dismissed_at', 'reported'])
        .where('org_id', '=', org.id)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      // Each step reaches the funnel once, the first time this user's card sees it done.
      const fresh = STEP_IDS.filter((id) => done[id] && !(state?.reported ?? []).includes(id));
      if (fresh.length) {
        const reported = [...(state?.reported ?? []), ...fresh];
        await db
          .insertInto('onboarding_states')
          .values({ org_id: org.id, user_id: userId, reported })
          .onConflict((oc) => oc.columns(['org_id', 'user_id']).doUpdateSet({ reported }))
          .execute();
        for (const id of fresh) {
          recordFunnelEvent(request.log, {
            name: `first_week_${id}`,
            userId,
            orgId: org.id,
          });
        }
      }
      return {
        dismissed: !!state?.dismissed_at,
        steps: STEP_IDS.map((id) => ({
          id,
          done: done[id],
          blocked: id === 'teammate' && !done.teammate && oneUser ? ('plan-limit' as const) : null,
        })),
      };
    },
  );

  app.post(
    '/onboarding/first-week/dismiss',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Hide the first-week checklist for the signed-in user',
        tags: ['onboarding'],
        response: { 204: Type.Null(), 401: ProblemSchema },
      },
    },
    async (request, reply) => {
      const { id: userId, org } = request.user!;
      const now = new Date();
      await db
        .insertInto('onboarding_states')
        .values({ org_id: org.id, user_id: userId, dismissed_at: now })
        .onConflict((oc) => oc.columns(['org_id', 'user_id']).doUpdateSet({ dismissed_at: now }))
        .execute();
      recordFunnelEvent(request.log, { name: 'first_week_dismissed', userId, orgId: org.id });
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/funnel',
    {
      preHandler: signedIn,
      schema: {
        summary: 'A funnel event only the page sees (SPEC §10.4): a copied command, a click',
        tags: ['onboarding'],
        body: Type.Object(
          {
            name: Type.Union([
              Type.Literal('install_command_copied'),
              Type.Literal('onboarding_dashboard_opened'),
              Type.Literal('onboarding_sample_opened'),
              Type.Literal('onboarding_help_opened'),
              Type.Literal('onboarding_troubleshooting_shown'),
            ] satisfies { const: (typeof CLIENT_FUNNEL_EVENTS)[number] }[]),
            props: Type.Optional(
              Type.Object(
                {
                  /** helm, kubectl, docker, compose: which command was copied. */
                  method: Type.Optional(Type.String({ pattern: '^[a-z]{1,16}$' })),
                  kind: Type.Optional(
                    Type.Union([Type.Literal('kubernetes'), Type.Literal('docker')]),
                  ),
                },
                { additionalProperties: false },
              ),
            ),
          },
          { additionalProperties: false },
        ),
        response: { 204: Type.Null(), 400: ProblemSchema, 401: ProblemSchema },
      },
    },
    async (request, reply) => {
      recordFunnelEvent(request.log, {
        name: request.body.name as FunnelEventName,
        userId: request.user!.id,
        orgId: request.user!.org.id,
        props: request.body.props ?? {},
      });
      return reply.code(204).send(null);
    },
  );
};
