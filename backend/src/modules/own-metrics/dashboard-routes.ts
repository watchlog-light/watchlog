// SPDX-License-Identifier: AGPL-3.0-only
// Dashboards of a user's own metrics (1.0.0, ADR-237): the org's, built by Owners and Admins,
// read by everyone. A widget is a metric, a shape (number, line, area, bars), at most one label
// to split by and a width on a 12-column grid, with a title that can be renamed. There is no
// query language, no variable and no formula, and WatchLog's own metrics are never on one:
// a widget names an own metric by its cluster and name, nothing else.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from 'typebox';
import { isUniqueViolation, type Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { sendProblem } from '../../lib/problem.js';
import type { VictoriaQueryClient } from '../../lib/victoria.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { clustersForOrg } from '../clusters/service.js';
import { sendPlanLimit } from '../entitlements/limits.js';
import { LABEL_NAME, METRIC_NAME, wordsOf } from './naming.js';
import { exprFor } from './expr.js';
import { exprMetric, listMetrics, valuesNow, type MetricInfo } from './read.js';
import type { OwnUsual, UsualNow } from './usual.js';
import { statUnit } from './words.js';
import type { OwnMetrics } from './service.js';

export const SHAPES = ['number', 'line', 'area', 'bars'] as const;
/** Columns of 12 a widget may take: small, a third, medium, two thirds, wide. */
export const WIDTHS = [3, 4, 6, 8, 12] as const;

const lits = <T extends readonly (string | number)[]>(values: T) =>
  Type.Union(values.map((v) => Type.Literal(v))) as unknown as ReturnType<
    typeof Type.Unsafe<T[number]>
  >;

const WidgetS = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 40, pattern: '^[A-Za-z0-9_-]+$' }),
  clusterId: Type.String({ format: 'uuid' }),
  metric: Type.String({ minLength: 1, maxLength: 200 }),
  title: Type.String({ maxLength: 80 }),
  shape: lits(SHAPES),
  by: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  w: lits(WIDTHS),
});
export type Widget = Static<typeof WidgetS>;

const N = Type.Union([Type.Number(), Type.Null()]);
/** What a widget's metric is now; null when it no longer reports (the widget says so). */
const ResolvedS = Type.Union([
  Type.Object({
    id: Type.String(),
    name: Type.String(),
    words: Type.String(),
    type: Type.String(),
    unit: Type.String(),
    shown: Type.String(),
    labels: Type.Array(Type.String()),
    refused: Type.Union([Type.Object({ label: Type.String() }), Type.Null()]),
    series: Type.Number(),
    value: N,
    /** A watched metric's usual range for this hour (Pro). */
    usual: Type.Optional(
      Type.Union([Type.Object({ low: N, high: N, learning: Type.Boolean() }), Type.Null()]),
    ),
  }),
  Type.Null(),
]);

const ShownWidgetS = Type.Object({
  ...WidgetS.properties,
  resolved: ResolvedS,
  /** The cluster's or fleet's name; null when it is gone. */
  clusterName: Type.Union([Type.String(), Type.Null()]),
});

const DashboardS = Type.Object({
  id: Type.String(),
  name: Type.String(),
  widgets: Type.Array(ShownWidgetS),
  updatedAt: Type.Number(),
});

const LimitsS = Type.Object({ dashboards: Type.Number(), widgetsPerDashboard: Type.Number() });
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
const TAGS = [PUBLIC_TAG, 'own-metrics'];
const PANEL = ['own-metrics'];
const Name = Type.String({ minLength: 1, maxLength: 80 });

export interface DashboardRoutesOptions {
  db: Database;
  own: OwnMetrics;
  usual: OwnUsual;
  victoria: VictoriaQueryClient | null | undefined;
}

/** A widget as it is stored: checked again on the way out, so a hand-edited row can't break a page. */
function stored(raw: unknown): Widget[] {
  if (!Array.isArray(raw)) return [];
  const out: Widget[] = [];
  for (const w of raw as Partial<Widget>[]) {
    if (!w || typeof w !== 'object' || typeof w.id !== 'string') continue;
    if (typeof w.clusterId !== 'string' || typeof w.metric !== 'string') continue;
    out.push({
      id: w.id,
      clusterId: w.clusterId,
      metric: w.metric,
      title: typeof w.title === 'string' ? w.title : '',
      shape: (SHAPES as readonly string[]).includes(w.shape as string) ? w.shape! : 'line',
      by: typeof w.by === 'string' && w.by ? w.by : null,
      w: (WIDTHS as readonly number[]).includes(w.w as number) ? w.w! : 6,
    });
  }
  return out;
}

export const ownDashboardRoutes: FastifyPluginAsyncTypebox<DashboardRoutesOptions> = async (
  app,
  { db, own, usual, victoria },
) => {
  const read = [requireUser(), requireRole('owner', 'admin', 'viewer')];
  const write = [requireUser(), requireRole('owner', 'admin')];

  /** Checks what an editor sent: real clusters of the org, metric and label names, unique ids. */
  async function checked(
    orgId: string,
    widgets: Widget[],
    max: number,
    had: number,
  ): Promise<{ ok: true; widgets: Widget[] } | { ok: false; status: 400 | 402; detail: string }> {
    // A downgrade keeps what a dashboard has; it can't grow past the plan's number.
    if (widgets.length > Math.max(max, had)) {
      return {
        ok: false,
        status: 402,
        detail: `A dashboard has at most ${max} widgets on your plan. Remove one, or upgrade to Pro for 24.`,
      };
    }
    const clusters = new Set((await clustersForOrg(db, orgId)).rows.map((c) => c.id));
    const ids = new Set<string>();
    for (const w of widgets) {
      if (ids.has(w.id))
        return { ok: false, status: 400, detail: `Two widgets share the id ${w.id}` };
      ids.add(w.id);
      if (!clusters.has(w.clusterId))
        return {
          ok: false,
          status: 400,
          detail: 'A widget names a cluster or fleet that is not yours',
        };
      if (!METRIC_NAME.test(w.metric) || w.metric.startsWith('watchlog_'))
        return { ok: false, status: 400, detail: `Not one of your metrics: ${w.metric}` };
      if (w.by !== null && (!LABEL_NAME.test(w.by) || w.by.startsWith('wl_')))
        return { ok: false, status: 400, detail: `Not a label to split by: ${w.by}` };
    }
    return {
      ok: true,
      widgets: widgets.map((w) => ({ ...w, title: w.title.trim() || wordsOf(w.metric) })),
    };
  }

  /** Each widget with what its metric is now, read per cluster (its value for a number). */
  async function shown(orgId: string, widgets: Widget[]) {
    const clusters = await clustersForOrg(db, orgId);
    const nameOf = new Map(clusters.rows.map((c) => [c.id, c.name]));
    const byCluster = new Map<string, Set<string>>();
    for (const w of widgets) {
      if (!nameOf.has(w.clusterId)) continue;
      byCluster.set(w.clusterId, (byCluster.get(w.clusterId) ?? new Set()).add(w.metric));
    }
    const found = new Map<string, MetricInfo & { value: number | null; usual: UsualNow | null }>();
    const pro = (await own.usage(orgId)).limits.usualRange;
    await Promise.all(
      [...byCluster].map(async ([clusterId, names]) => {
        const metrics = await listMetrics(db, clusterId, { names: [...names] });
        const scope = clusters.scopeOf(clusterId);
        const values =
          victoria && scope
            ? await valuesNow(victoria, scope, metrics).catch((err: unknown) => {
                app.log.warn({ err: (err as Error).message }, 'dashboards: reading values failed');
                return new Map<string, number | null>();
              })
            : new Map<string, number | null>();
        for (const m of metrics) {
          const range =
            pro && m.watched && victoria && scope
              ? await usual.shown(
                  scope,
                  clusterId,
                  exprFor(exprMetric(m), { step: 300 }),
                  Date.now(),
                  statUnit(m),
                )
              : null;
          found.set(`${clusterId}|${m.name}`, {
            ...m,
            value: values.get(m.id) ?? null,
            usual: range,
          });
        }
      }),
    );
    return widgets.map((w) => {
      const m = found.get(`${w.clusterId}|${w.metric}`);
      return {
        ...w,
        clusterName: nameOf.get(w.clusterId) ?? null,
        resolved: m
          ? {
              id: m.id,
              name: m.name,
              words: m.words,
              type: m.type,
              unit: m.unit,
              shown: m.shown,
              labels: m.labels,
              refused: m.refused,
              series: m.series,
              value: m.value,
              usual: m.usual,
            }
          : null,
      };
    });
  }

  app.get(
    '/own-dashboards',
    {
      preHandler: read,
      schema: {
        summary: 'The dashboards of your own metrics, and how many your plan has',
        tags: TAGS,
        response: {
          200: Type.Object({
            dashboards: Type.Array(
              Type.Object({ id: Type.String(), name: Type.String(), widgets: Type.Number() }),
            ),
            limits: LimitsS,
          }),
          401: ProblemSchema,
          403: ProblemSchema,
        },
      },
    },
    async (request) => {
      const orgId = request.user!.org.id;
      const [rows, usage] = await Promise.all([
        db
          .selectFrom('own_dashboards')
          .select(['id', 'name', 'widgets'])
          .where('org_id', '=', orgId)
          .orderBy('created_at')
          .execute(),
        own.usage(orgId),
      ]);
      return {
        dashboards: rows.map((r) => ({
          id: r.id,
          name: r.name,
          widgets: stored(r.widgets).length,
        })),
        limits: {
          dashboards: usage.limits.dashboards,
          widgetsPerDashboard: usage.limits.widgetsPerDashboard,
        },
      };
    },
  );

  app.get(
    '/own-dashboards/:id',
    {
      preHandler: read,
      schema: {
        summary: 'One dashboard: its widgets in order, each with what its metric is now',
        description:
          "A widget whose metric no longer reports has `resolved: null`. Lines come from the metric's own series route.",
        tags: TAGS,
        params: IdParams,
        response: { 200: DashboardS, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const row = await db
        .selectFrom('own_dashboards')
        .selectAll()
        .where('org_id', '=', orgId)
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!row) return sendProblem(reply, 404, 'Dashboard not found');
      await own.flush();
      return {
        id: row.id,
        name: row.name,
        widgets: await shown(orgId, stored(row.widgets)),
        updatedAt: row.updated_at.getTime(),
      };
    },
  );

  app.post(
    '/own-dashboards',
    {
      preHandler: write,
      schema: {
        summary: 'Create a dashboard, empty or as a copy of another',
        tags: PANEL,
        body: Type.Object({
          name: Name,
          copyOf: Type.Optional(Type.String({ format: 'uuid' })),
        }),
        response: {
          201: Type.Object({ id: Type.String(), name: Type.String() }),
          400: ProblemSchema,
          401: ProblemSchema,
          402: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const name = request.body.name.trim();
      if (!name) return sendProblem(reply, 400, 'Give the dashboard a name');
      const [existing, usage] = await Promise.all([
        db
          .selectFrom('own_dashboards')
          .select(['id', 'widgets'])
          .where('org_id', '=', orgId)
          .execute(),
        own.usage(orgId),
      ]);
      const max = usage.limits.dashboards;
      if (existing.length >= max) {
        return sendPlanLimit(
          reply,
          402,
          'own-dashboards',
          max,
          max === 1
            ? 'Your plan has one dashboard. Upgrade to Pro for 50.'
            : `Your plan has ${max} dashboards, and all exist. Delete one first.`,
        );
      }
      let widgets: Widget[] = [];
      if (request.body.copyOf) {
        const from = existing.find((d) => d.id === request.body.copyOf);
        if (!from) return sendProblem(reply, 404, 'The dashboard to copy was not found');
        widgets = stored(from.widgets).map((w) => ({ ...w, id: newId().slice(-12) }));
      }
      const id = newId();
      try {
        await db
          .insertInto('own_dashboards')
          .values({
            id,
            org_id: orgId,
            name,
            widgets: JSON.stringify(widgets),
            created_by: request.user!.id,
          })
          .execute();
      } catch (err) {
        if (isUniqueViolation(err))
          return sendProblem(reply, 409, 'A dashboard with this name exists; pick another name');
        throw err;
      }
      return reply.code(201).send({ id, name });
    },
  );

  app.put(
    '/own-dashboards/:id',
    {
      preHandler: write,
      schema: {
        summary: 'Save a dashboard: its name and its widgets, in order',
        tags: PANEL,
        params: IdParams,
        body: Type.Object({
          name: Type.Optional(Name),
          widgets: Type.Optional(Type.Array(WidgetS, { maxItems: 100 })),
        }),
        response: {
          200: DashboardS,
          400: ProblemSchema,
          401: ProblemSchema,
          402: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const row = await db
        .selectFrom('own_dashboards')
        .selectAll()
        .where('org_id', '=', orgId)
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!row) return sendProblem(reply, 404, 'Dashboard not found');
      const set: { name?: string; widgets?: string } = {};
      if (request.body.name !== undefined) {
        const name = request.body.name.trim();
        if (!name) return sendProblem(reply, 400, 'Give the dashboard a name');
        set.name = name;
      }
      let widgets = stored(row.widgets);
      if (request.body.widgets) {
        const usage = await own.usage(orgId);
        const c = await checked(
          orgId,
          request.body.widgets,
          usage.limits.widgetsPerDashboard,
          widgets.length,
        );
        if (!c.ok) {
          return c.status === 402
            ? sendPlanLimit(reply, 402, 'own-widgets', usage.limits.widgetsPerDashboard, c.detail)
            : sendProblem(reply, 400, c.detail);
        }
        widgets = c.widgets;
        set.widgets = JSON.stringify(widgets);
      }
      let updatedAt = row.updated_at;
      if (Object.keys(set).length) {
        try {
          const done = await db
            .updateTable('own_dashboards')
            .set(set)
            .where('id', '=', row.id)
            .returning('updated_at')
            .executeTakeFirstOrThrow();
          updatedAt = done.updated_at;
        } catch (err) {
          if (isUniqueViolation(err))
            return sendProblem(reply, 409, 'A dashboard with this name exists; pick another name');
          throw err;
        }
      }
      await own.flush();
      return {
        id: row.id,
        name: set.name ?? row.name,
        widgets: await shown(orgId, widgets),
        updatedAt: updatedAt.getTime(),
      };
    },
  );

  app.delete(
    '/own-dashboards/:id',
    {
      preHandler: write,
      schema: {
        summary: 'Delete a dashboard (its metrics stay)',
        tags: PANEL,
        params: IdParams,
        response: { 204: Type.Null(), 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const gone = await db
        .deleteFrom('own_dashboards')
        .where('org_id', '=', request.user!.org.id)
        .where('id', '=', request.params.id)
        .returning('id')
        .executeTakeFirst();
      if (!gone) return sendProblem(reply, 404, 'Dashboard not found');
      return reply.code(204).send(null);
    },
  );
};

/** The dashboards a metric is on, for its page's "Used in". */
export async function dashboardsOf(
  db: Database,
  orgId: string,
  clusterId: string,
  metric: string,
): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .selectFrom('own_dashboards')
    .select(['id', 'name', 'widgets'])
    .where('org_id', '=', orgId)
    .orderBy('created_at')
    .execute();
  return rows
    .filter((r) => stored(r.widgets).some((w) => w.clusterId === clusterId && w.metric === metric))
    .map((r) => ({ id: r.id, name: r.name }));
}
