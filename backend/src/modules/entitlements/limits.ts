// SPDX-License-Identifier: AGPL-3.0-only
// The plan's limits where the request path meets them (ADR-177), Cloud only: a cluster or
// an invite over the plan answers 409 `plan-limit` with the way out, and the hit is
// recorded once a day for the banner and the Owners' email. Community never calls these.
import { sql } from 'kysely';
import type { FastifyReply } from 'fastify';
import type { Database } from '../../db/index.js';
import { PROBLEM_CONTENT_TYPE, ProblemType, problem } from '../../lib/problem.js';
import { recordLimitHit } from './node-gate.js';
import { atLimit, type LimitKind } from './plans.js';
import type { EntitlementsService } from './service.js';

/** Where the way out is: Settings › Plan & billing. */
export const BILLING_PATH = '/settings?tab=billing';

export function sendPlanLimit(
  reply: FastifyReply,
  status: 402 | 409,
  limit: LimitKind | 'series',
  max: number | null,
  detail: string,
): FastifyReply {
  return reply
    .code(status)
    .type(PROBLEM_CONTENT_TYPE)
    .send({
      ...problem(status, detail, reply.request.url, ProblemType.planLimit),
      code: 'plan-limit',
      limit,
      ...(max === null ? {} : { max }),
    });
}

const PLAN_NAME = { free: 'Cloud Free', pro: 'Cloud Pro', enterprise: 'Your plan' } as const;

/**
 * Refuses a new cluster or Docker fleet over the plan: true when it answered 409. The
 * count runs on the request's connection, under the org (ADR-174).
 */
export async function refuseCluster(
  db: Database,
  entitlements: EntitlementsService,
  orgId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const ent = await entitlements.get(orgId);
  if (ent.clusters === null) return false;
  const { n } = await db
    .selectFrom('clusters')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('org_id', '=', orgId)
    .executeTakeFirstOrThrow();
  if (!atLimit(ent.clusters, n)) return false;
  await recordLimitHit(db, orgId, 'clusters', '', new Date());
  sendPlanLimit(
    reply,
    409,
    'clusters',
    ent.clusters,
    `${PLAN_NAME[ent.plan]} has ${ent.clusters} cluster or Docker fleet. Try Pro for unlimited clusters: ${BILLING_PATH}`,
  );
  return true;
}

/** Refuses an invite over the plan's users (members and open invites): true when it answered 409. */
export async function refuseInvite(
  db: Database,
  entitlements: EntitlementsService,
  orgId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const ent = await entitlements.get(orgId);
  if (ent.users === null) return false;
  const { n } = await db
    .selectNoFrom(
      sql<number>`(select count(*) from memberships where org_id = ${orgId})::int
        + (select count(*) from invites where org_id = ${orgId} and accepted_at is null
           and revoked_at is null and expires_at > now())::int`.as('n'),
    )
    .executeTakeFirstOrThrow();
  if (!atLimit(ent.users, n)) return false;
  await recordLimitHit(db, orgId, 'users', '', new Date());
  sendPlanLimit(
    reply,
    409,
    'users',
    ent.users,
    ent.users === 1
      ? `${PLAN_NAME[ent.plan]} has one user. Try Pro to invite your team: ${BILLING_PATH}`
      : `${PLAN_NAME[ent.plan]} has ${ent.users} users, counting open invites. Remove one, or ask about Enterprise.`,
  );
  return true;
}
