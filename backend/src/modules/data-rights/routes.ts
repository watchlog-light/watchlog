// SPDX-License-Identifier: AGPL-3.0-only
// Cloud's data rights (ADR-181), under /api/v1, Cloud only:
//   - GET    /org/status                the banners' facts (any member)
//   - GET    /org/export                the configuration as JSON (Owner)
//   - GET    /clusters/:id/export       a cluster's metrics in a range, JSON lines (Owner)
//   - POST   /org/deletion {confirm}    ask for the deletion: 7 days to undo (Owner)
//   - DELETE /org/deletion              undo it (Owner)
//   - POST   /org/reactivate            lift a suspension for inactivity (Owner)
// Exports are rate-limited per org and audited; the cluster comes from clusterForOrg.
import { Readable } from 'node:stream';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { ProblemType, sendProblem } from '../../lib/problem.js';
import type { VictoriaClient } from '../../lib/victoria.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { WindowLimiter } from '../accounts/checks.js';
import { ProblemSchema } from '../auth/schemas.js';
import { clusterForOrg } from '../clusters/service.js';
import type { EntitlementsService } from '../entitlements/service.js';
import { actorOf, audit } from '../users/service.js';
import {
  DELETION_UNDO_MS,
  buildExport,
  mailOwners,
  notices,
  orgStatus,
  type MailDeps,
} from './service.js';

const Iso = Type.String({ format: 'date-time' });
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) =>
  Type.Union([t, Type.Null()]);

export const OrgStatusSchema = Type.Object({
  deletion: Nullable(
    Type.Object({ requestedAt: Iso, dueAt: Iso, requestedBy: Nullable(Type.String()) }),
  ),
  suspension: Nullable(
    Type.Object({
      at: Iso,
      kind: Type.Union([Type.Literal('staff'), Type.Literal('inactive')]),
      reason: Nullable(Type.String()),
    }),
  ),
  inactivity: Nullable(Type.Object({ warnedAt: Iso, suspendsAt: Iso })),
  lastDataAt: Nullable(Iso),
});

/** At most this many configuration exports per org per hour … */
export const CONFIG_EXPORTS_PER_HOUR = 10;
/** … and this many metrics exports (each reads a cluster's series from both tiers). */
export const METRICS_EXPORTS_PER_HOUR = 30;
/** The longest metrics range one export covers (the longest retention, and a day). */
export const MAX_EXPORT_RANGE_S = 31 * 86_400;

export interface DataRightsOptions {
  db: Database;
  victoria?: VictoriaClient;
  entitlements: EntitlementsService;
  mail: MailDeps;
  now?: () => number;
}

const fileSafe = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'cluster';

export const dataRightsRoutes: FastifyPluginAsyncTypebox<DataRightsOptions> = async (app, opts) => {
  const { db, victoria, entitlements } = opts;
  const now = opts.now ?? Date.now;
  const owner = [requireUser(), requireRole('owner')];
  const configLimit = new WindowLimiter(CONFIG_EXPORTS_PER_HOUR, 3_600_000);
  const metricsLimit = new WindowLimiter(METRICS_EXPORTS_PER_HOUR, 3_600_000);

  app.get(
    '/org/status',
    {
      preHandler: requireUser(),
      schema: {
        summary: "Cloud: the org's deletion, suspension and inactivity state (the banners)",
        tags: ['cloud'],
        response: { 200: OrgStatusSchema, 401: ProblemSchema },
      },
    },
    async (request) => orgStatus(db, request.user!.org.id),
  );

  app.get(
    '/org/export',
    {
      preHandler: owner,
      schema: {
        summary: "Cloud: the org's configuration as JSON, without secrets (Owners)",
        tags: ['cloud'],
        response: { 401: ProblemSchema, 403: ProblemSchema, 429: ProblemSchema },
      },
    },
    async (request, reply) => {
      const org = request.user!.org;
      if (!configLimit.hit(org.id, now())) {
        reply.header('retry-after', '3600');
        return sendProblem(reply, 429, 'Too many exports this hour; try again later.');
      }
      const body = await buildExport(db, org.id, new Date(now()));
      await audit(db, {
        orgId: org.id,
        action: 'org_exported',
        actor: actorOf(request),
        details: { what: 'configuration' },
      });
      const date = new Date(now()).toISOString().slice(0, 10);
      return reply
        .header('cache-control', 'no-store')
        .header(
          'content-disposition',
          `attachment; filename="watchlog-${fileSafe(org.slug)}-${date}.json"`,
        )
        .type('application/json; charset=utf-8')
        .send(JSON.stringify(body, null, 2) as never);
    },
  );

  app.get(
    '/clusters/:id/export',
    {
      preHandler: owner,
      schema: {
        summary:
          "Cloud: a cluster's metrics in a range, as VictoriaMetrics' JSON lines (Owners; both tiers)",
        tags: ['cloud'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        querystring: Type.Object({
          from: Type.Optional(Type.Integer({ minimum: 0 })),
          to: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
        response: {
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          429: ProblemSchema,
          503: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const org = request.user!.org;
      const cluster = await clusterForOrg(db, org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const nowS = Math.floor(now() / 1000);
      const to = Math.min(request.query.to ?? nowS, nowS);
      const from = request.query.from ?? to - 86_400;
      if (from >= to) return sendProblem(reply, 400, '`from` must be before `to`.');
      if (to - from > MAX_EXPORT_RANGE_S) {
        return sendProblem(reply, 400, 'One export covers at most 31 days; ask for less.');
      }
      if (!victoria) return sendProblem(reply, 503, 'Metrics are not available right now.');
      if (!metricsLimit.hit(org.id, now())) {
        reply.header('retry-after', '3600');
        return sendProblem(reply, 429, 'Too many exports this hour; try again later.');
      }
      let parts: Response[];
      try {
        parts = await victoria.exportSeries(cluster.scope, from, to);
      } catch (err) {
        request.log.warn({ err: (err as Error).message }, 'metrics export failed');
        return sendProblem(reply, 503, 'Metrics are not available right now.');
      }
      await audit(db, {
        orgId: org.id,
        action: 'org_exported',
        actor: actorOf(request),
        details: { what: 'metrics', clusterId: cluster.id, from, to },
      });
      // One JSON object per line and series; with two tiers, the 30-day one's lines first.
      async function* lines() {
        for (const res of parts) {
          if (!res.body) continue;
          for await (const chunk of Readable.fromWeb(
            res.body as import('node:stream/web').ReadableStream,
          )) {
            yield chunk as Buffer;
          }
        }
      }
      const name = `watchlog-${fileSafe(cluster.name)}-metrics-${from}-${to}.jsonl`;
      return reply
        .header('cache-control', 'no-store')
        .header('content-disposition', `attachment; filename="${name}"`)
        .type('application/x-ndjson')
        .send(Readable.from(lines()) as never);
    },
  );

  app.post(
    '/org/deletion',
    {
      preHandler: owner,
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      schema: {
        summary:
          'Cloud: delete the org after 7 days (Owners): its ingest stops now, Owners can undo',
        tags: ['cloud'],
        body: Type.Object(
          { confirm: Type.String({ minLength: 1, maxLength: 200 }) },
          { additionalProperties: false },
        ),
        response: {
          202: OrgStatusSchema,
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const org = await db
        .selectFrom('orgs')
        .select(['id', 'name', 'deletion_requested_at'])
        .where('id', '=', user.org.id)
        .executeTakeFirstOrThrow();
      if (request.body.confirm.trim() !== org.name.trim()) {
        return sendProblem(
          reply,
          400,
          "Type the organization's name exactly to confirm.",
          ProblemType.confirmMismatch,
        );
      }
      if (org.deletion_requested_at) {
        return sendProblem(reply, 409, 'This organization is already scheduled for deletion.');
      }
      const at = new Date(now());
      const due = new Date(at.getTime() + DELETION_UNDO_MS);
      await db
        .updateTable('orgs')
        .set({
          deletion_requested_at: at,
          deletion_due_at: due,
          deletion_requested_by: user.id,
        })
        .where('id', '=', org.id)
        .execute();
      entitlements.invalidate(org.id);
      await audit(db, {
        orgId: org.id,
        action: 'org_deletion_requested',
        actor: actorOf(request),
        details: { dueAt: due.toISOString() },
      });
      await mailOwners(
        opts.mail,
        org.id,
        notices.deletionRequested(org.name, due, user.name || user.email),
      );
      return reply.code(202).send(await orgStatus(db, org.id));
    },
  );

  app.delete(
    '/org/deletion',
    {
      preHandler: owner,
      schema: {
        summary: "Cloud: undo the org's deletion within its 7 days (Owners)",
        tags: ['cloud'],
        response: {
          200: OrgStatusSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const undone = await db
        .updateTable('orgs')
        .set({ deletion_requested_at: null, deletion_due_at: null, deletion_requested_by: null })
        .where('id', '=', orgId)
        .where('deletion_requested_at', 'is not', null)
        .returning('id')
        .executeTakeFirst();
      if (!undone)
        return sendProblem(reply, 409, 'This organization is not scheduled for deletion.');
      entitlements.invalidate(orgId);
      await audit(db, { orgId, action: 'org_deletion_cancelled', actor: actorOf(request) });
      return orgStatus(db, orgId);
    },
  );

  app.post(
    '/org/reactivate',
    {
      preHandler: owner,
      schema: {
        summary: 'Cloud: lift a suspension for inactivity, so agents send again (Owners)',
        tags: ['cloud'],
        response: {
          200: OrgStatusSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const lifted = await db
        .updateTable('orgs')
        .set({
          suspended_at: null,
          suspended_reason: null,
          suspension_kind: null,
          inactive_warned_at: null,
          inactivity_reset_at: new Date(now()),
        })
        .where('id', '=', orgId)
        .where('suspension_kind', '=', 'inactive')
        .returning('id')
        .executeTakeFirst();
      if (!lifted) {
        return sendProblem(reply, 409, 'Only a suspension for inactivity can be lifted here.');
      }
      entitlements.invalidate(orgId);
      await audit(db, { orgId, action: 'org_reactivated', actor: actorOf(request) });
      return orgStatus(db, orgId);
    },
  );
};
