// SPDX-License-Identifier: AGPL-3.0-only
// GET /overview/all (ADR-226): every cluster and fleet of the org on one page. Pro only,
// through the shared gate: Cloud orgs without `pro_features` get 403 `pro-feature`; Community
// answers 404, as if the route weren't there (as What changed, ADR-202).
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import { ProblemType, sendProblem } from '../../lib/problem.js';
import type { VictoriaQueryClient } from '../../lib/victoria.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { causeReader, problemSubject, wantsCause, type CausesService } from '../causes/likely.js';
import { allClustersExists, hasAllClusters, maxRangeOf } from './gate.js';
import { AllClustersSchema } from './schemas.js';
import { buildSummary, filterKind, NOT_REPORTING, RANGES, type Kind } from './service.js';

/** Rows whose likely cause is worked out, as the cluster Overview's first 20. */
const MAX_CAUSES = 20;

export const allClustersRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  victoria?: VictoriaQueryClient;
  config: Pick<Config, 'edition' | 'demoMode' | 'version'>;
  causes?: CausesService;
  /** Test hook: the clock. */
  now?: () => number;
}> = async (app, { db, victoria, config, causes, now = Date.now }) => {
  app.get(
    '/overview/all',
    {
      preHandler: requireUser(),
      schema: {
        summary: 'All clusters and fleets: what needs attention anywhere (ADR-226)',
        description:
          "Every Kubernetes cluster and Server fleet of the org in one answer: each one's status, reporting agents, CPU over the range and memory now, open problems, What changed in the last 24 hours and alerts sent; every open problem in one list (the same alert rule on the same workload name in two places, started within 30 minutes of each other, is one row with both places), critical first; What changed's top rows across all of them; and housekeeping (old agents, failing alert channels, clusters with no channel, eBPF off). `range` in seconds: 3600, 21600, 86400 (default), 604800 or 2592000, within the org's retention. `kind`: all (default), kubernetes or server. Pro: 403 `pro-feature` for Cloud orgs without it; a self-hosted Community install answers 404.",
        tags: ['overview', PUBLIC_TAG],
        querystring: Type.Object({
          range: Type.Optional(
            Type.Union(
              RANGES.map((r) => Type.Literal(r)),
              { description: 'Seconds: 1 h, 6 h, 24 h, 7 d or 30 d' },
            ),
          ),
          kind: Type.Optional(
            Type.Union([Type.Literal('all'), Type.Literal('kubernetes'), Type.Literal('server')]),
          ),
        }),
        response: {
          200: AllClustersSchema,
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      if (!allClustersExists(config)) return sendProblem(reply, 404, 'Not Found');
      const orgId = request.user!.org.id;
      if (!(await hasAllClusters(config, app.entitlements, orgId))) {
        return sendProblem(
          reply,
          403,
          'All clusters and fleets is part of Pro',
          ProblemType.proFeature,
        );
      }
      const range = Number(request.query.range ?? 86_400);
      const maxRange = await maxRangeOf(config, app.entitlements, orgId);
      if (range > maxRange) {
        return sendProblem(reply, 400, `The range is beyond this plan's retention`);
      }
      const kind = (request.query.kind ?? 'all') as Kind;
      const summary = await buildSummary({
        db,
        victoria,
        orgId,
        range,
        kind,
        nowMs: now(),
        version: config.version,
        maxRange,
        log: request.log,
      });
      const answer = filterKind(summary, kind);
      if (causes && wantsCause(request)) {
        const jobs = answer.problems.slice(0, MAX_CAUSES).flatMap((p, i) => {
          // An agent that stopped reporting is where it starts: no cause line (ADR-159).
          if (p.ruleKey === NOT_REPORTING) return [];
          const place = p.places[0]!;
          const subject = problemSubject(
            { alertId: place.alertId, object: p.object },
            place.cluster.kind,
          );
          return subject ? [{ i, job: { cluster: place.cluster, subject } }] : [];
        });
        try {
          const found = await causes.summaries(
            causeReader(app, request),
            orgId,
            jobs.map((j) => j.job),
          );
          jobs.forEach(({ i }, n) => {
            const s = found[n];
            if (!s) return;
            answer.problems[i] = {
              ...answer.problems[i]!,
              causeState: s.state,
              ...(s.likely ? { likelyCause: s.likely } : {}),
              ...(s.possible.length ? { possibleCauses: s.possible } : {}),
            };
          });
        } catch (err) {
          // The rows stand on their own: a failed cause leaves them without the line.
          request.log.warn({ err: (err as Error).message }, 'all-clusters causes failed');
        }
      }
      return answer;
    },
  );
};
