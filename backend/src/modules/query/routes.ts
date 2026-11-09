// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { VictoriaError, type VictoriaQueryClient } from '../../lib/victoria.js';
import { requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { findCluster } from '../clusters/service.js';
import { buildQuery, chooseStep, METRIC_KEYS, type MetricKey } from './catalog.js';
import { PUBLIC_TAG } from '../../openapi/public.js';

const MAX_RANGE_S = 31 * 86400;
const ScopeValue = Type.String({ minLength: 1, maxLength: 253 });

export const RangeResponse = Type.Object({
  metric: Type.String(),
  unit: Type.String(),
  step: Type.Integer(),
  series: Type.Array(
    Type.Object({
      labels: Type.Record(Type.String(), Type.String()),
      // [unix seconds, value]; value is null for NaN/Inf. A tuple schema does not
      // serialize with fast-json-stringify (measured), hence a plain array.
      points: Type.Array(
        Type.Array(Type.Union([Type.Number(), Type.Null()]), { minItems: 2, maxItems: 2 }),
      ),
    }),
  ),
});

export const queryRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  victoria?: VictoriaQueryClient;
}> = async (app, { db, victoria }) => {
  app.post(
    '/query/range',
    {
      preHandler: requireUser(db),
      schema: {
        summary: 'Curated metric query over a time range (no raw MetricsQL)',
        tags: ['query', PUBLIC_TAG],
        body: Type.Object({
          clusterId: Type.String({ format: 'uuid' }),
          metric: Type.Union(METRIC_KEYS.map((k) => Type.Literal(k))),
          scope: Type.Optional(
            Type.Object(
              {
                host: Type.Optional(ScopeValue),
                container: Type.Optional(ScopeValue),
                composeProject: Type.Optional(ScopeValue),
                node: Type.Optional(ScopeValue),
                namespace: Type.Optional(ScopeValue),
                namespaces: Type.Optional(Type.Array(ScopeValue, { minItems: 1, maxItems: 50 })),
                pod: Type.Optional(ScopeValue),
                workloadKind: Type.Optional(ScopeValue),
                workload: Type.Optional(ScopeValue),
                /** A monitored service's id (GET /applications), for service.* metrics. */
                service: Type.Optional(Type.String({ format: 'uuid' })),
              },
              { additionalProperties: false },
            ),
          ),
          agg: Type.Optional(
            Type.Union([
              Type.Literal('sum'),
              Type.Literal('avg'),
              Type.Literal('max'),
              Type.Literal('min'),
            ]),
          ),
          step: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400 })),
          from: Type.Number({ description: 'Unix seconds' }),
          to: Type.Number({ description: 'Unix seconds' }),
        }),
        response: {
          200: RangeResponse,
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
          503: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const { clusterId, metric, scope = {}, agg, from, to } = request.body;
      if (!(to > from) || to - from > MAX_RANGE_S) {
        return sendProblem(reply, 400, 'The range must be positive and at most 31 days');
      }
      const cluster = await findCluster(db, request.user!.org.id, clusterId);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      if (!victoria) return sendProblem(reply, 503, 'Metrics storage is not configured');

      const step = chooseStep(to - from, request.body.step);
      const q = buildQuery(metric as MetricKey, scope, step, agg);
      try {
        const series = await victoria.queryRange({ clusterId: cluster.id }, q.expr, from, to, step);
        return { metric, unit: q.unit, step, series };
      } catch (err) {
        request.log.error({ err: (err as Error).message, metric }, 'range query failed');
        if (err instanceof VictoriaError && err.status >= 400 && err.status < 500) {
          return sendProblem(reply, 400, 'The query could not be run');
        }
        return sendProblem(reply, 503, 'Metrics storage temporarily unavailable');
      }
    },
  );
};
