// SPDX-License-Identifier: AGPL-3.0-only
// A Server fleet's own process-group rules (ADR-207, ADR-208): read by everyone in the org,
// replaced as one ordered list by Owners and Admins, fetched by the fleet's agents every
// minute with an ETag. The agent evaluates them on the server (command lines never leave it).
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import type { VictoriaQueryClient } from '../../lib/victoria.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { clusterForOrg } from '../clusters/service.js';
import { PUBLIC_TAG } from '../../openapi/public.js';

export const MAX_RULES = 50;

const RuleS = Type.Object({
  exe: Type.Optional(
    Type.String({ maxLength: 100, description: "A glob over the executable's base name" }),
  ),
  unit: Type.Optional(Type.String({ maxLength: 200, description: 'A glob over the systemd unit' })),
  args: Type.Optional(
    Type.String({
      maxLength: 300,
      description: 'A pattern (RE2) over the arguments joined by spaces; its captures fill $1…$9',
    }),
  ),
  name: Type.String({ minLength: 1, maxLength: 63, description: "The group's name: a template" }),
});
type Rule = Static<typeof RuleS>;

const Params = Type.Object({ id: Type.String({ format: 'uuid' }) });

/** Why a rule can't be used, or null. RE2 (the agent's) has no lookaround or backreferences. */
export function ruleError(r: Rule): string | null {
  if (!r.exe && !r.unit && !r.args)
    return 'A rule matches on the executable, the unit or the arguments';
  if (!r.name.trim()) return 'A rule needs a name';
  let captures = 0;
  if (r.args) {
    if (/\(\?<?[=!]|\\[1-9]/.test(r.args)) {
      return 'The pattern uses lookaround or a backreference, which the agent (RE2) does not support';
    }
    try {
      captures = new RegExp(`${r.args}|`).exec('')!.length - 1;
    } catch {
      return 'The pattern is not a valid regular expression';
    }
  }
  for (const m of r.name.matchAll(/\$(\d)/g)) {
    if (Number(m[1]) > captures)
      return `The name uses $${m[1]}, but the pattern has ${captures} capture(s)`;
  }
  return null;
}

async function listRules(db: Database, clusterId: string): Promise<Rule[]> {
  const rows = await db
    .selectFrom('process_rules')
    .select(['exe', 'unit', 'args', 'name'])
    .where('cluster_id', '=', clusterId)
    .orderBy('position')
    .execute();
  return rows.map((r) => ({
    ...(r.exe ? { exe: r.exe } : {}),
    ...(r.unit ? { unit: r.unit } : {}),
    ...(r.args ? { args: r.args } : {}),
    name: r.name,
  }));
}

export const processRuleRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  victoria?: VictoriaQueryClient;
}> = async (app, { db, victoria }) => {
  const signedIn = requireUser();

  app.get(
    '/clusters/:id/process-rules',
    {
      preHandler: signedIn,
      schema: {
        summary: "A Server fleet's own process-group rules, and the groups they name now",
        tags: ['servers', PUBLIC_TAG],
        params: Params,
        response: {
          200: Type.Object({
            rules: Type.Array(RuleS),
            /** Groups the agents named by a user rule at their last scrape. */
            matches: Type.Array(
              Type.Object({
                group: Type.String(),
                servers: Type.Array(Type.String()),
                instances: Type.Number(),
              }),
            ),
          }),
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster || cluster.kind !== 'server')
        return sendProblem(reply, 404, 'Cluster not found');
      const rules = await listRules(db, cluster.id);
      const series = victoria
        ? await victoria
            .query(
              cluster.scope,
              'max by (host, group) (last_over_time(watchlog_process_group_instances{by="rule"}[2m]))',
            )
            .catch(() => [])
        : [];
      const byGroup = new Map<string, { servers: Set<string>; instances: number }>();
      for (const s of series) {
        const g = s.labels.group;
        if (!g) continue;
        const e = byGroup.get(g) ?? { servers: new Set<string>(), instances: 0 };
        if (s.labels.host) e.servers.add(s.labels.host);
        e.instances += s.points[0]?.[1] ?? 0;
        byGroup.set(g, e);
      }
      return {
        rules,
        matches: [...byGroup.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([group, e]) => ({ group, servers: [...e.servers].sort(), instances: e.instances })),
      };
    },
  );

  app.put(
    '/clusters/:id/process-rules',
    {
      preHandler: [signedIn, requireRole('owner', 'admin')],
      schema: {
        summary: "Replace a Server fleet's process-group rules (in order; at most 50)",
        tags: ['servers'],
        params: Params,
        body: Type.Object({ rules: Type.Array(RuleS, { maxItems: MAX_RULES }) }),
        response: {
          200: Type.Object({ rules: Type.Array(RuleS) }),
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster || cluster.kind !== 'server')
        return sendProblem(reply, 404, 'Cluster not found');
      const rules = request.body.rules.map((r) => ({
        exe: r.exe?.trim() || undefined,
        unit: r.unit?.trim() || undefined,
        args: r.args || undefined,
        name: r.name.trim(),
      }));
      for (const [i, r] of rules.entries()) {
        const err = ruleError(r);
        if (err) return sendProblem(reply, 400, `Rule ${i + 1}: ${err}`);
      }
      await db.transaction().execute(async (tx) => {
        await tx.deleteFrom('process_rules').where('cluster_id', '=', cluster.id).execute();
        if (rules.length) {
          await tx
            .insertInto('process_rules')
            .values(
              rules.map((r, position) => ({
                cluster_id: cluster.id,
                org_id: cluster.org_id,
                position,
                exe: r.exe ?? null,
                unit: r.unit ?? null,
                args: r.args ?? null,
                name: r.name,
                created_by: request.user!.id,
              })),
            )
            .execute();
        }
      });
      return { rules: await listRules(db, cluster.id) };
    },
  );
};

/** The agents' side: `GET /ingest/v1/process-rules`, with an ETag (304 when unchanged). */
export function registerProcessRulesIngest(app: FastifyInstance, db: Database): void {
  app.get(
    '/process-rules',
    {
      schema: {
        summary: "The fleet's process-group rules for its server agents",
        tags: ['ingest'],
        hide: true,
        response: { 200: Type.Unknown(), 304: Type.Null(), 401: ProblemSchema, 429: ProblemSchema },
      },
    },
    async (request, reply) => {
      const rules = await listRules(db, request.ingestOwner!.clusterId);
      const body = { rules };
      const tag = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
      const known = (request.headers['if-none-match'] ?? '').replace(/^W\/|"/g, '');
      reply.header('etag', `"${tag}"`).header('cache-control', 'no-store');
      if (known === tag) return reply.code(304).send(null);
      return reply.send(body);
    },
  );
}
