// SPDX-License-Identifier: AGPL-3.0-only
// Your metrics, read (1.0.0, ADR-236): the list with each metric's value now, one metric's page
// (its labels, where it is used), its line over a range split by at most one label, the type
// and unit corrections, and the metrics pinned to a workload's or a server's page (6 a page).
// Reads are everyone's and a token's; corrections and pins are Owners' and Admins'.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from 'typebox';
import { isUniqueViolation, type Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { sendProblem } from '../../lib/problem.js';
import type { VictoriaQueryClient } from '../../lib/victoria.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { clusterForOrg } from '../clusters/service.js';
import { OWN_PINS_PER_PAGE } from '../entitlements/own-metrics.js';
import { chooseStep } from '../query/catalog.js';
import { LABEL_NAME, OWN_TYPES, OWN_UNITS } from './naming.js';
import { labelFacts, listMetrics, metricSeries, valuesNow, type MetricInfo } from './read.js';
import type { Owner, OwnMetrics } from './service.js';

const Params = Type.Object({ id: Type.String({ format: 'uuid' }) });
const MetricParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  metricId: Type.String({ format: 'uuid' }),
});
const N = Type.Union([Type.Number(), Type.Null()]);
const TAGS = [PUBLIC_TAG, 'own-metrics'];
const PANEL = ['own-metrics'];
const lits = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((v) => Type.Literal(v))) as unknown as ReturnType<
    typeof Type.Unsafe<T[number]>
  >;

const TypeS = lits(OWN_TYPES);
const UnitS = lits(OWN_UNITS);
const ShownS = lits(['rate', 'p95', 'as_is', 'time_since'] as const);
const OwnerS = Type.Object({
  kind: lits(['', 'workload', 'server'] as const),
  namespace: Type.String(),
  workloadKind: Type.String(),
  name: Type.String(),
});

const MetricS = Type.Object({
  id: Type.String(),
  name: Type.String(),
  words: Type.String({ description: 'A few words made from the name' }),
  type: TypeS,
  detectedType: TypeS,
  unit: UnitS,
  detectedUnit: UnitS,
  shown: ShownS,
  help: Type.String(),
  hidden: Type.Boolean({ description: 'Off the default list (Go, process and scrape internals)' }),
  labels: Type.Array(Type.String()),
  refused: Type.Union([Type.Object({ label: Type.String() }), Type.Null()]),
  firstSeenAt: Type.Number(),
  lastSeenAt: Type.Number(),
  series: Type.Number(),
  sources: Type.Array(
    Type.Object({
      id: Type.String(),
      label: Type.String(),
      kind: lits(['scrape_pod', 'scrape_address', 'remote_write', 'push'] as const),
    }),
  ),
  owners: Type.Array(OwnerS),
  ownerCount: Type.Number(),
  untied: Type.Boolean(),
  pushed: Type.Boolean(),
  value: N,
});

/** What a page's owner is, in a query string. */
const OwnerQuery = {
  ownerKind: Type.Optional(lits(['workload', 'server'] as const)),
  namespace: Type.Optional(Type.String({ maxLength: 253 })),
  workloadKind: Type.Optional(Type.String({ maxLength: 64 })),
  owner: Type.Optional(
    Type.String({ maxLength: 253, description: "The workload's or the server's name" }),
  ),
};
type OwnerQueryT = {
  ownerKind?: 'workload' | 'server';
  namespace?: string;
  workloadKind?: string;
  owner?: string;
};

function ownerOf(q: OwnerQueryT): Owner | undefined | null {
  if (!q.ownerKind) return undefined;
  if (!q.owner) return null;
  if (q.ownerKind === 'server')
    return { kind: 'server', namespace: '', workloadKind: '', name: q.owner };
  if (!q.namespace || !q.workloadKind) return null;
  return { kind: 'workload', namespace: q.namespace, workloadKind: q.workloadKind, name: q.owner };
}

// [unix seconds, value]; a tuple schema does not serialize with fast-json-stringify.
const PointsS = Type.Array(Type.Array(N, { minItems: 2, maxItems: 2 }));

const PinS = Type.Object({
  id: Type.String(),
  metric: MetricS,
  spark: PointsS,
});

export interface OwnMetricRoutesOptions {
  db: Database;
  own: OwnMetrics;
  victoria: VictoriaQueryClient | null | undefined;
}

const RESERVED_SPLIT = new Set(['le', 'quantile', 'cluster_id', 'tenant_id', '__name__']);
const NOT_FOUND = 'Cluster or fleet not found';

export const ownMetricReadRoutes: FastifyPluginAsyncTypebox<OwnMetricRoutesOptions> = async (
  app,
  { db, own, victoria },
) => {
  const read = [requireUser(), requireRole('owner', 'admin', 'viewer')];
  const write = [requireUser(), requireRole('owner', 'admin')];

  const noStorage = (reply: Parameters<typeof sendProblem>[0]) =>
    sendProblem(reply, 503, 'Metrics storage is not configured');

  const withValues = async (
    scope: Parameters<typeof valuesNow>[1],
    metrics: MetricInfo[],
    owner?: Owner,
  ) => {
    const values = victoria
      ? await valuesNow(victoria, scope, metrics, owner).catch((err: unknown) => {
          // The list is still worth showing without its values.
          app.log.warn({ err: (err as Error).message }, 'own metrics: reading values failed');
          return new Map<string, number | null>();
        })
      : new Map<string, number | null>();
    return metrics.map((m) => ({ ...m, value: values.get(m.id) ?? null }));
  };

  app.get(
    '/clusters/:id/own-metrics/metrics',
    {
      preHandler: read,
      schema: {
        summary: 'Your metrics: each with its type, where it comes from and its value now',
        description:
          "A counter's value is its rate per second, a histogram's its p95, a timestamp's the seconds since it; a gauge is as it is. `all=true` adds the Go, process and scrape internals.",
        tags: TAGS,
        params: Params,
        querystring: Type.Object({
          all: Type.Optional(Type.Boolean()),
          ...OwnerQuery,
        }),
        response: {
          200: Type.Object({
            metrics: Type.Array(MetricS),
            hidden: Type.Number({ description: 'Metrics left off without all=true' }),
          }),
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const owner = ownerOf(request.query);
      if (owner === null) return sendProblem(reply, 400, 'Name the workload or the server');
      await own.flush();
      const every = await listMetrics(db, cluster.id, owner ? { owner } : {});
      const shown = request.query.all ? every : every.filter((m) => !m.hidden);
      return {
        metrics: await withValues(cluster.scope, shown, owner),
        hidden: every.length - shown.length,
      };
    },
  );

  app.get(
    '/clusters/:id/own-metrics/metrics/:metricId',
    {
      preHandler: read,
      schema: {
        summary: 'One of your metrics: its value now, its labels and where it is used',
        tags: TAGS,
        params: MetricParams,
        response: {
          200: Type.Object({
            metric: MetricS,
            /** A histogram's other quantiles now. */
            p50: N,
            p99: N,
            labels: Type.Array(
              Type.Object({
                name: Type.String(),
                values: Type.Number(),
                top: Type.Array(Type.String()),
              }),
            ),
            usedIn: Type.Object({
              pins: Type.Array(Type.Object({ id: Type.String(), owner: OwnerS })),
            }),
          }),
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      await own.flush();
      const [m] = await listMetrics(db, cluster.id, { ids: [request.params.metricId] });
      if (!m) return sendProblem(reply, 404, 'Metric not found');
      const [[metric], labels, pins, quantiles] = await Promise.all([
        withValues(cluster.scope, [m]),
        labelFacts(db, cluster.id, m.id),
        db
          .selectFrom('own_pins')
          .select(['id', 'owner_kind', 'owner_namespace', 'owner_workload_kind', 'owner_name'])
          .where('cluster_id', '=', cluster.id)
          .where('metric_id', '=', m.id)
          .orderBy('created_at')
          .execute(),
        m.type === 'histogram' && victoria
          ? Promise.all(
              (['p50', 'p99'] as const).map((stat) =>
                metricSeries(victoria, cluster.scope, m, {
                  from: Math.floor(Date.now() / 1000),
                  to: Math.floor(Date.now() / 1000),
                  step: 15,
                  stat,
                })
                  .then((a) => a.lines[0]?.points.at(-1)?.[1] ?? null)
                  .catch(() => null),
              ),
            )
          : Promise.resolve([null, null]),
      ]);
      return {
        metric: metric!,
        p50: quantiles[0] ?? null,
        p99: quantiles[1] ?? null,
        labels,
        usedIn: {
          pins: pins.map((p) => ({
            id: p.id,
            owner: {
              kind: p.owner_kind as 'workload',
              namespace: p.owner_namespace,
              workloadKind: p.owner_workload_kind,
              name: p.owner_name,
            },
          })),
        },
      };
    },
  );

  const SeriesQuery = Type.Object({
    from: Type.Number({ description: 'Unix seconds' }),
    to: Type.Number({ description: 'Unix seconds' }),
    step: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400 })),
    by: Type.Optional(Type.String({ maxLength: 200, description: 'One label to split by' })),
    stat: Type.Optional(lits(['p50', 'p95', 'p99'] as const)),
    ...OwnerQuery,
  });

  app.get(
    '/clusters/:id/own-metrics/metrics/:metricId/series',
    {
      preHandler: read,
      schema: {
        summary:
          'A metric over a range, as it is shown; split by one label: the top 5 and the rest',
        tags: TAGS,
        params: MetricParams,
        querystring: SeriesQuery,
        response: {
          200: Type.Object({
            step: Type.Number(),
            unit: UnitS,
            shown: ShownS,
            values: Type.Number({ description: "The split label's values in the range" }),
            lines: Type.Array(
              Type.Object({
                value: Type.Union([Type.String(), Type.Null()]),
                other: Type.Boolean(),
                points: PointsS,
              }),
            ),
          }),
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          503: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const q = request.query as Static<typeof SeriesQuery>;
      const from = Math.floor(q.from);
      const to = Math.floor(q.to);
      if (!(to > from)) return sendProblem(reply, 400, '`to` must be after `from`');
      if (
        q.by !== undefined &&
        (!LABEL_NAME.test(q.by) || RESERVED_SPLIT.has(q.by) || q.by.startsWith('wl_'))
      )
        return sendProblem(reply, 400, `Not a label to split by: ${q.by}`);
      const owner = ownerOf(q);
      if (owner === null) return sendProblem(reply, 400, 'Name the workload or the server');
      if (!victoria) return noStorage(reply);
      const [m] = await listMetrics(db, cluster.id, { ids: [request.params.metricId] });
      if (!m) return sendProblem(reply, 404, 'Metric not found');
      return metricSeries(victoria, cluster.scope, m, {
        from,
        to,
        step: chooseStep(to - from, q.step),
        by: q.by,
        owner,
        stat: q.stat,
      });
    },
  );

  app.patch(
    '/clusters/:id/own-metrics/metrics/:metricId',
    {
      preHandler: write,
      schema: {
        summary: "Correct a metric's type or unit, or check a refused metric again",
        description:
          '`type` or `unit` as null goes back to what the name and the TYPE line say. `checkAgain` lifts a refusal for a label with too many values: if the label still has them, the metric is refused again at its next report.',
        tags: PANEL,
        params: MetricParams,
        body: Type.Object({
          type: Type.Optional(Type.Union([TypeS, Type.Null()])),
          unit: Type.Optional(Type.Union([UnitS, Type.Null()])),
          checkAgain: Type.Optional(Type.Literal(true)),
        }),
        response: {
          200: Type.Object({ metric: MetricS }),
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      // What is in memory is written first, then let go: the next report reads the correction.
      await own.forget(cluster.id);
      const body = request.body;
      const set: Record<string, unknown> = {};
      if (body.type !== undefined) set.type_override = body.type;
      if (body.unit !== undefined) set.unit_override = body.unit;
      if (body.checkAgain) set.refused = null;
      if (Object.keys(set).length) {
        const done = await db
          .updateTable('own_metrics')
          .set(set)
          .where('cluster_id', '=', cluster.id)
          .where('id', '=', request.params.metricId)
          .returning('id')
          .executeTakeFirst();
        if (!done) return sendProblem(reply, 404, 'Metric not found');
      }
      const [m] = await listMetrics(db, cluster.id, { ids: [request.params.metricId] });
      if (!m) return sendProblem(reply, 404, 'Metric not found');
      const [metric] = await withValues(cluster.scope, [m]);
      return { metric: metric! };
    },
  );

  // ------------------------------------------------------------------------------ pins

  app.get(
    '/clusters/:id/own-metrics/pins',
    {
      preHandler: read,
      schema: {
        summary:
          "The metrics pinned to a workload's or a server's page, with the last hour of each",
        tags: TAGS,
        params: Params,
        querystring: Type.Object({
          ...OwnerQuery,
          ownerKind: lits(['workload', 'server'] as const),
        }),
        response: {
          200: Type.Object({
            pins: Type.Array(PinS),
            max: Type.Number(),
            metrics: Type.Number({ description: 'Metrics this workload or server has' }),
          }),
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const owner = ownerOf(request.query);
      if (!owner) return sendProblem(reply, 400, 'Name the workload or the server');
      const rows = await db
        .selectFrom('own_pins')
        .select(['id', 'metric_id'])
        .where('cluster_id', '=', cluster.id)
        .where('owner_kind', '=', owner.kind)
        .where('owner_namespace', '=', owner.namespace)
        .where('owner_workload_kind', '=', owner.workloadKind)
        .where('owner_name', '=', owner.name)
        .orderBy('position')
        .orderBy('created_at')
        .execute();
      const [pinned, has] = await Promise.all([
        listMetrics(db, cluster.id, { ids: rows.map((r) => r.metric_id) }),
        listMetrics(db, cluster.id, { owner }),
      ]);
      const metrics = await withValues(cluster.scope, pinned, owner);
      const to = Math.floor(Date.now() / 1000);
      const sparks = await Promise.all(
        pinned.map((m) =>
          victoria
            ? metricSeries(victoria, cluster.scope, m, { from: to - 3600, to, step: 60, owner })
                .then((a) => a.lines[0]?.points ?? [])
                .catch(() => [])
            : Promise.resolve([]),
        ),
      );
      const byId = new Map(metrics.map((m, i) => [m.id, { metric: m, spark: sparks[i]! }]));
      return {
        pins: rows.flatMap((r) => {
          const hit = byId.get(r.metric_id);
          return hit ? [{ id: r.id, ...hit }] : [];
        }),
        max: OWN_PINS_PER_PAGE,
        metrics: has.filter((m) => !m.hidden).length,
      };
    },
  );

  app.post(
    '/clusters/:id/own-metrics/pins',
    {
      preHandler: write,
      schema: {
        summary: 'Pin a metric to the page of the workload or server it belongs to',
        tags: PANEL,
        params: Params,
        body: Type.Object({
          metricId: Type.String({ format: 'uuid' }),
          owner: Type.Object({
            kind: lits(['workload', 'server'] as const),
            namespace: Type.Optional(Type.String({ maxLength: 253 })),
            workloadKind: Type.Optional(Type.String({ maxLength: 64 })),
            name: Type.String({ minLength: 1, maxLength: 253 }),
          }),
        }),
        response: {
          201: Type.Object({ id: Type.String() }),
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const o = request.body.owner;
      const owner: Owner =
        o.kind === 'server'
          ? { kind: 'server', namespace: '', workloadKind: '', name: o.name }
          : {
              kind: 'workload',
              namespace: o.namespace ?? '',
              workloadKind: o.workloadKind ?? '',
              name: o.name,
            };
      if (owner.kind === 'workload' && (!owner.namespace || !owner.workloadKind))
        return sendProblem(reply, 400, 'A workload is named by its namespace, kind and name');
      await own.flush();
      const [m] = await listMetrics(db, cluster.id, {
        ids: [request.body.metricId],
        owner,
      });
      if (!m) {
        return sendProblem(
          reply,
          404,
          'This metric has no series that belong there: a metric is pinned to the workload or server it belongs to',
        );
      }
      const page = await db
        .selectFrom('own_pins')
        .select(['id', 'metric_id', 'position'])
        .where('cluster_id', '=', cluster.id)
        .where('owner_kind', '=', owner.kind)
        .where('owner_namespace', '=', owner.namespace)
        .where('owner_workload_kind', '=', owner.workloadKind)
        .where('owner_name', '=', owner.name)
        .execute();
      if (page.some((p) => p.metric_id === m.id))
        return sendProblem(reply, 409, 'This metric is already pinned there');
      if (page.length >= OWN_PINS_PER_PAGE) {
        return sendProblem(
          reply,
          409,
          `A page shows at most ${OWN_PINS_PER_PAGE} of its own metrics: unpin one first`,
        );
      }
      const id = newId();
      try {
        await db
          .insertInto('own_pins')
          .values({
            id,
            cluster_id: cluster.id,
            metric_id: m.id,
            owner_kind: owner.kind,
            owner_namespace: owner.namespace,
            owner_workload_kind: owner.workloadKind,
            owner_name: owner.name,
            position: Math.max(-1, ...page.map((p) => p.position)) + 1,
            created_by: request.user!.id,
          })
          .execute();
      } catch (err) {
        if (isUniqueViolation(err))
          return sendProblem(reply, 409, 'This metric is already pinned there');
        throw err;
      }
      return reply.code(201).send({ id });
    },
  );

  app.delete(
    '/clusters/:id/own-metrics/pins/:pinId',
    {
      preHandler: write,
      schema: {
        summary: 'Unpin a metric from a page',
        tags: PANEL,
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          pinId: Type.String({ format: 'uuid' }),
        }),
        response: { 204: Type.Null(), 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const gone = await db
        .deleteFrom('own_pins')
        .where('cluster_id', '=', cluster.id)
        .where('id', '=', request.params.pinId)
        .returning('id')
        .executeTakeFirst();
      if (!gone) return sendProblem(reply, 404, 'Pin not found');
      return reply.code(204).send(null);
    },
  );
};
