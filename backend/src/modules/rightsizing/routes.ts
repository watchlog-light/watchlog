// SPDX-License-Identifier: AGPL-3.0-only
// GET /clusters/:id/right-sizing (ADR-168, SPEC §8.1): requests and limits against the use
// over the window, as codes and facts (ADR-147). The use is kept an hour per cluster.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { clusterForOrg } from '../clusters/service.js';
import type { RightSizingService } from './service.js';

const Nullable = <T extends ReturnType<typeof Type.String> | ReturnType<typeof Type.Number>>(
  t: T,
) => Type.Union([t, Type.Null()]);

const ObjectSchema = Type.Object({
  kind: Type.String({ description: 'Deployment, StatefulSet, DaemonSet, or `container` (Docker)' }),
  name: Type.String(),
  namespace: Type.Optional(Type.String()),
  host: Type.Optional(Type.String()),
  composeProject: Type.Optional(Type.String()),
  composeService: Type.Optional(Type.String()),
});

const HintSchema = Type.Object({
  object: ObjectSchema,
  container: Nullable(Type.String({ description: 'The container in the pod (Kubernetes)' })),
  resource: Type.Union([Type.Literal('cpu'), Type.Literal('memory')]),
  code: Type.String({
    description:
      'memory_limit_oom, memory_limit_tight, cpu_limit_throttled, memory_request_low, cpu_request_low, memory_reservation_low, cpu_request_high, memory_request_high, memory_reservation_high, cpu_no_request, memory_no_request, memory_no_limit',
  }),
  facts: Type.Record(
    Type.String(),
    Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
  ),
  suggestion: Nullable(
    Type.Number({ description: 'What would cover the use: cores (cpu) or bytes (memory)' }),
  ),
  giveBack: Type.Number({
    description: 'Cores or bytes all replicas would give back (the *_high hints); 0 otherwise',
  }),
  basedOn: Type.Object({
    windowHours: Type.Integer(),
    from: Nullable(Type.String({ format: 'date-time' })),
    to: Type.String({ format: 'date-time' }),
    samples: Type.Integer({ description: 'Five-minute samples of history' }),
    hours: Type.Number(),
  }),
});

export const RightSizingSchema = Type.Object({
  window: Type.Object({ hours: Type.Integer(), minHistoryHours: Type.Number() }),
  computedAt: Type.String({ format: 'date-time' }),
  hints: Type.Array(HintSchema),
  notEnoughHistory: Type.Array(
    Type.Object({
      object: ObjectSchema,
      container: Nullable(Type.String()),
      hours: Type.Number(),
      needed: Type.Number(),
    }),
  ),
  summary: Type.Object({
    objects: Type.Integer(),
    giveBackObjects: Type.Integer(),
    giveBack: Type.Object({ cores: Type.Number(), bytes: Type.Number() }),
    oomRisk: Type.Integer(),
  }),
});

const Str = (description: string) =>
  Type.Optional(Type.String({ minLength: 1, maxLength: 253, description }));

export const rightSizingRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  rightSizing: RightSizingService;
}> = async (app, { db, rightSizing }) => {
  const signedIn = requireUser();

  app.get(
    '/clusters/:id/right-sizing',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Right-sizing hints',
        description:
          'CPU and memory requests and limits compared with the use over the last 7 days (ADR-168): per workload container on Kubernetes (its busiest pod), per container on Docker. Codes and facts, never a score; OOM risk first. Containers with less than 24 hours of history are listed in `notEnoughHistory`. The use is kept an hour per cluster.',
        tags: ['right-sizing', PUBLIC_TAG],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        querystring: Type.Object({
          namespace: Str('Kubernetes: one namespace'),
          kind: Str('Kubernetes: the workload kind (Deployment, StatefulSet, DaemonSet)'),
          workload: Str('Kubernetes: the workload name'),
          host: Str('Docker: the host'),
          container: Str('The container (in the pod on Kubernetes)'),
          project: Str('Docker: the Compose project'),
          service: Str('Docker: the Compose service'),
          system: Type.Optional(
            Type.Boolean({
              description: "Include system namespaces and WatchLog's own containers",
            }),
          ),
        }),
        response: {
          200: RightSizingSchema,
          401: ProblemSchema,
          404: ProblemSchema,
          503: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const row = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!row) return sendProblem(reply, 404, 'Cluster not found');
      if (!rightSizing.configured) {
        return sendProblem(reply, 503, 'Metrics storage is not configured');
      }
      try {
        return await rightSizing.answer(
          { id: row.id, kind: row.kind as 'kubernetes' | 'docker', scope: row.scope },
          request.query,
        );
      } catch (err) {
        // A failed read is not kept (the next request asks again).
        request.log.warn({ err: (err as Error).message }, 'right-sizing query failed');
        return sendProblem(reply, 503, 'Metrics storage temporarily unavailable');
      }
    },
  );
};
