// SPDX-License-Identifier: AGPL-3.0-only
// GET /api/v1/plan (Cloud only, ADR-177): the org's plan, its limits and what it uses now,
// for the plan strip, the banners and Settings › Plan & billing. Every count runs on the
// request's connection, under the org (ADR-174).
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { sql } from 'kysely';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { graceOver } from './node-gate.js';
import { SEEN_WINDOW_MS, daysLeft } from './plans.js';
import type { EntitlementsService } from './service.js';
import { usageReport } from './usage.js';

const Limit = Type.Union([Type.Integer(), Type.Null()]);

export const PlanSchema = Type.Object({
  plan: Type.Union([Type.Literal('free'), Type.Literal('pro'), Type.Literal('enterprise')]),
  source: Type.String(),
  betaUntil: Type.Union([Type.String(), Type.Null()]),
  proFeatures: Type.Boolean(),
  limits: Type.Object({
    clusters: Limit,
    nodes: Limit,
    users: Limit,
    retentionDays: Type.Integer(),
  }),
  usage: Type.Object({
    clusters: Type.Integer(),
    /** Kubernetes nodes and Docker hosts seen in the last 24 hours (what the limit counts). */
    nodes: Type.Integer(),
    kubernetesNodes: Type.Integer(),
    dockerHosts: Type.Integer(),
    users: Type.Integer(),
  }),
  /** This calendar month (UTC) so far: the bill's 95th percentile and the peak hour. */
  period: Type.Object({
    from: Type.String(),
    to: Type.String(),
    p95: Type.Integer(),
    peak: Type.Integer(),
  }),
  /** Agent instances refused (402) in the last 24 hours, while the org is at its limit. */
  refusedNodes: Type.Integer(),
  /** After a downgrade: what still sends until `graceUntil`, and how many are over. */
  downgrade: Type.Union([
    Type.Object({
      graceUntil: Type.String(),
      daysLeft: Type.Integer(),
      ended: Type.Boolean(),
      nodesOver: Type.Integer(),
      clustersOver: Type.Integer(),
    }),
    Type.Null(),
  ]),
});

export interface PlanRouteOptions {
  db: Database;
  entitlements: EntitlementsService;
}

export const planRoutes: FastifyPluginAsyncTypebox<PlanRouteOptions> = async (app, opts) => {
  const { db, entitlements } = opts;
  app.get(
    '/plan',
    {
      preHandler: requireUser(),
      schema: {
        summary: "Cloud: the org's plan, limits, usage, refused nodes and downgrade grace",
        tags: ['cloud'],
        response: { 200: PlanSchema, 401: ProblemSchema },
      },
    },
    async (request) => {
      const orgId = request.user!.org.id;
      const nowMs = Date.now();
      const now = new Date(nowMs);
      const ent = await entitlements.get(orgId);
      const seenSince = new Date(nowMs - SEEN_WINDOW_MS);
      const counts = await db
        .selectNoFrom([
          sql<number>`(select count(*) from clusters where org_id = ${orgId})::int`.as('clusters'),
          sql<number>`(select count(*) from agent_instances where org_id = ${orgId}
            and mode = 'node' and last_seen_at > ${seenSince})::int`.as('k8s'),
          sql<number>`(select count(*) from agent_instances where org_id = ${orgId}
            and mode = 'docker' and last_seen_at > ${seenSince})::int`.as('docker'),
          sql<number>`(select count(*) from memberships where org_id = ${orgId})::int`.as('users'),
          sql<number>`(select count(distinct subject) from plan_limit_hits where org_id = ${orgId}
            and kind = 'nodes' and last_at > ${seenSince})::int`.as('refused'),
        ])
        .executeTakeFirstOrThrow();
      const nodes = counts.k8s + counts.docker;
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const usage = await usageReport(db, orgId, monthStart, monthEnd, nowMs);
      const atNodeLimit = ent.nodes !== null && nodes >= ent.nodes;
      const nodesOver = ent.nodes === null ? 0 : Math.max(0, nodes - ent.nodes);
      const clustersOver = ent.clusters === null ? 0 : Math.max(0, counts.clusters - ent.clusters);
      const inDowngrade =
        ent.graceUntil !== null &&
        (ent.graceUntil > now ? nodesOver + clustersOver > 0 : nodesOver > 0);
      return {
        plan: ent.plan,
        source: ent.source,
        betaUntil: ent.betaUntil?.toISOString() ?? null,
        proFeatures: ent.proFeatures,
        limits: {
          clusters: ent.clusters,
          nodes: ent.nodes,
          users: ent.users,
          retentionDays: ent.retentionDays,
        },
        usage: {
          clusters: counts.clusters,
          nodes,
          kubernetesNodes: counts.k8s,
          dockerHosts: counts.docker,
          users: counts.users,
        },
        period: {
          from: monthStart.toISOString(),
          to: monthEnd.toISOString(),
          p95: usage.p95,
          peak: usage.peak,
        },
        refusedNodes: atNodeLimit ? counts.refused : 0,
        downgrade: inDowngrade
          ? {
              graceUntil: ent.graceUntil!.toISOString(),
              daysLeft: daysLeft(ent.graceUntil!, now),
              ended: graceOver(ent, nowMs),
              nodesOver,
              clustersOver,
            }
          : null,
      };
    },
  );
};
