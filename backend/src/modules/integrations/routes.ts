// SPDX-License-Identifier: AGPL-3.0-only
// Applications API (SPEC §4.12, ADR-132, ADR-135): monitored services, discovered ones,
// the collectors, Monitor and remove. Credentials and the connect flow are slice 4.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from 'typebox';
import { isUniqueViolation, type Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { sendProblem } from '../../lib/problem.js';
import { VictoriaError, type VictoriaQueryClient } from '../../lib/victoria.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { INTEGRATION_TYPES, type IntegrationTarget } from './collector-config.js';
import { discover, SERVICE_KINDS, targetKey } from './discovery.js';
import type { ConfigNotifier } from './notifier.js';
import {
  connectedTo,
  pageOf,
  PAGE_RANGES,
  sortReasons,
  statusReasons,
  type ConnectedResult,
  type PageContext,
  type Reason,
  type RowMetrics,
} from './pages/index.js';
import {
  ConnectedSchema,
  PanelSchema,
  ReasonSchema,
  RowMetricsSchema,
  TabSchema,
} from './pages/schema.js';
import {
  collectorOf,
  COLLECTOR_STALE_MS,
  healthOf,
  listApplicationRows,
  listCollectors,
  whereOf,
  type ApplicationRow,
  type CollectorRow,
} from './service.js';

const Name = Type.String({ minLength: 1, maxLength: 253 });
const K8sName = Type.String({
  minLength: 1,
  maxLength: 253,
  pattern: '^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$',
});
const DockerName = Type.String({
  minLength: 1,
  maxLength: 253,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$',
});
const Port = Type.Integer({ minimum: 1, maximum: 65535 });

export const TargetSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('workload'),
      namespace: K8sName,
      workload_kind: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z]+$' }),
      workload: K8sName,
      port: Port,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('compose'),
      host: DockerName,
      compose_project: DockerName,
      compose_service: DockerName,
      port: Port,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('container'), host: DockerName, container: DockerName, port: Port },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('address'),
      // host:port, a name or an IPv4 address, or [IPv6]:port.
      address: Type.String({
        maxLength: 260,
        pattern: '^(\\[[0-9a-fA-F:.]+\\]|[A-Za-z0-9][A-Za-z0-9.-]*):[0-9]{1,5}$',
      }),
    },
    { additionalProperties: false },
  ),
]);

const Health = Type.Union([
  Type.Literal('ok'),
  Type.Literal('warning'),
  Type.Literal('critical'),
  Type.Literal('unknown'),
]);
const Reason = Type.Object({
  code: Type.String(),
  facts: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Null()])),
});
const ClusterRef = Type.Object({
  id: Type.String(),
  name: Type.String(),
  kind: Type.Union([Type.Literal('kubernetes'), Type.Literal('docker')]),
});
export const ApplicationSchema = Type.Object({
  id: Type.String(),
  type: Type.String(),
  name: Type.String(),
  version: Type.Union([Type.String(), Type.Null()]),
  cluster: ClusterRef,
  where: Type.Object({
    group: Type.Union([Type.String(), Type.Null()]),
    host: Type.Union([Type.String(), Type.Null()]),
    address: Type.Union([Type.String(), Type.Null()]),
  }),
  /** What the collector connects to: a workload, a Compose service, a container or an address. */
  target: TargetSchema,
  health: Health,
  reason: Reason,
  members: Type.Object({ up: Type.Integer(), total: Type.Integer() }),
  monitoredSince: Type.String(),
  lastReportAt: Type.Union([Type.String(), Type.Null()]),
});
export type ApplicationView = Static<typeof ApplicationSchema>;

const DiscoveredSchema = Type.Object({
  key: Type.String(),
  cluster: ClusterRef,
  type: Type.String(),
  name: Type.String(),
  image: Type.Union([Type.String(), Type.Null()]),
  version: Type.Union([Type.String(), Type.Null()]),
  port: Type.Integer(),
  confidence: Type.Union([Type.Literal('image'), Type.Literal('port')]),
  members: Type.Integer(),
  host: Type.Union([Type.String(), Type.Null()]),
  group: Type.String(),
  target: TargetSchema,
});

const CollectorSchema = Type.Object({
  cluster: ClusterRef,
  host: Type.Union([Type.String(), Type.Null()]),
  version: Type.String(),
  lastSeenAt: Type.String(),
  reporting: Type.Boolean(),
});

const CreateBody = Type.Object(
  {
    clusterId: Type.String({ format: 'uuid' }),
    type: Type.Union(INTEGRATION_TYPES.map((t) => Type.Literal(t))),
    target: TargetSchema,
    /** Docker, an address added by hand: which host's collector reaches it. */
    collectorHost: Type.Optional(DockerName),
    name: Type.Optional(Name),
  },
  { additionalProperties: false },
);

function toView(
  row: ApplicationRow,
  collectors: CollectorRow[],
  now = Date.now(),
): ApplicationView {
  const { health, reason } = healthOf(row, collectorOf(row, collectors), now);
  const members = (row.status_details as { members?: { up: boolean }[] }).members ?? [];
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    version: row.version,
    cluster: {
      id: row.cluster_id,
      name: row.cluster_name,
      kind: row.cluster_kind as 'kubernetes' | 'docker',
    },
    where: whereOf(row.target),
    target: row.target,
    health,
    reason,
    members: { up: members.filter((m) => m.up).length, total: members.length },
    monitoredSince: row.monitored_since.toISOString(),
    lastReportAt: row.last_report_at?.toISOString() ?? null,
  };
}

const ORDER: Record<string, number> = { critical: 0, warning: 1, unknown: 2, ok: 3 };
const PAGE_CACHE_MS = 15_000;

const RangeQuery = Type.Integer({ description: 'Seconds back from now: 1h, 6h, 24h or 7d' });
// Query strings arrive as text; coerce, then check against the four ranges.
const RangeParam = Type.Optional(Type.Integer({ minimum: 3600, maximum: 604800 }));
const rangeOf = (v: number | undefined): number | null =>
  v === undefined ? 3600 : (PAGE_RANGES as readonly number[]).includes(v) ? v : null;

export const applicationRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  notifier: ConfigNotifier;
  victoria?: VictoriaQueryClient;
}> = async (app, { db, notifier, victoria }) => {
  const signedIn = requireUser(db);
  const canManage = [signedIn, requireRole('owner', 'admin')];
  const pageCache = new Map<
    string,
    { at: number; own: Reason[]; connected: ConnectedResult | null }
  >();

  /** One service the caller's organization monitors, with what its page needs. */
  async function contextOf(orgId: string, id: string, range: number) {
    const [row] = await listApplicationRows(db, orgId, { id });
    if (!row) return null;
    const collectors = await listCollectors(db, [row.cluster_id]);
    const ctx: PageContext = {
      db,
      vm: victoria,
      row,
      collector: collectorOf(row, collectors),
      range,
      now: Date.now(),
    };
    return { ctx, view: toView(row, collectors, ctx.now) };
  }

  app.get(
    '/applications',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Monitored services, problems first',
        tags: ['applications', PUBLIC_TAG],
        querystring: Type.Object({ cluster: Type.Optional(Type.String({ format: 'uuid' })) }),
        response: {
          200: Type.Object({ applications: Type.Array(ApplicationSchema) }),
          401: ProblemSchema,
        },
      },
    },
    async (request) => {
      const rows = await listApplicationRows(db, request.user!.org.id, {
        clusterId: request.query.cluster,
      });
      const collectors = await listCollectors(db, [...new Set(rows.map((r) => r.cluster_id))]);
      const now = Date.now();
      const applications = rows.map((r) => toView(r, collectors, now));
      applications.sort(
        (a, b) => ORDER[a.health]! - ORDER[b.health]! || a.name.localeCompare(b.name),
      );
      return { applications };
    },
  );

  app.get(
    '/applications/discovered',
    {
      preHandler: signedIn,
      schema: {
        summary: "Services the agents see that aren't monitored yet (ADR-132)",
        tags: ['applications', PUBLIC_TAG],
        querystring: Type.Object({ cluster: Type.Optional(Type.String({ format: 'uuid' })) }),
        response: {
          200: Type.Object({ discovered: Type.Array(DiscoveredSchema) }),
          401: ProblemSchema,
        },
      },
    },
    async (request) => {
      const found = await discover(db, request.user!.org.id, request.query.cluster);
      return {
        discovered: found.map((d) => ({
          key: d.key,
          cluster: { id: d.clusterId, name: d.clusterName, kind: d.clusterKind },
          type: d.type,
          name: d.name,
          image: d.image,
          version: d.version,
          port: d.port,
          confidence: d.confidence,
          members: d.members,
          host: d.host,
          group: d.group,
          target: d.target,
        })),
      };
    },
  );

  app.get(
    '/applications/collectors',
    {
      preHandler: signedIn,
      schema: {
        summary: 'The integrations collectors and whether they report (ADR-131)',
        tags: ['applications', PUBLIC_TAG],
        response: {
          200: Type.Object({ collectors: Type.Array(CollectorSchema) }),
          401: ProblemSchema,
        },
      },
    },
    async (request) => {
      const clusters = await db
        .selectFrom('clusters')
        .select(['id', 'name', 'kind'])
        .where('org_id', '=', request.user!.org.id)
        .execute();
      const byId = new Map(clusters.map((c) => [c.id, c]));
      const rows = await listCollectors(
        db,
        clusters.map((c) => c.id),
      );
      const now = Date.now();
      return {
        collectors: rows.map((r) => {
          const c = byId.get(r.cluster_id)!;
          return {
            cluster: { id: c.id, name: c.name, kind: c.kind as 'kubernetes' | 'docker' },
            host: r.host || null,
            version: r.version,
            lastSeenAt: r.last_seen_at.toISOString(),
            reporting: now - r.last_seen_at.getTime() <= COLLECTOR_STALE_MS,
          };
        }),
      };
    },
  );

  app.get(
    '/applications/metrics',
    {
      preHandler: signedIn,
      schema: {
        summary: "The list rows' key numbers and 6-hour sparklines",
        tags: ['applications'],
        querystring: Type.Object({ cluster: Type.Optional(Type.String({ format: 'uuid' })) }),
        response: {
          200: Type.Object({ metrics: Type.Record(Type.String(), RowMetricsSchema) }),
          401: ProblemSchema,
          502: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const rows = await listApplicationRows(db, request.user!.org.id, {
        clusterId: request.query.cluster,
      });
      if (!victoria || rows.length === 0) return { metrics: {} };
      // One batch per cluster and page: a few queries for the whole list.
      const groups = new Map<
        string,
        { page: ReturnType<typeof pageOf>; clusterId: string; ids: string[] }
      >();
      for (const r of rows) {
        const page = pageOf(r.type);
        const key = `${r.cluster_id}\u0000${page.id}\u0000${r.type}`;
        const g = groups.get(key) ?? { page, clusterId: r.cluster_id, ids: [] };
        g.ids.push(r.id);
        groups.set(key, g);
      }
      const now = Date.now();
      try {
        const maps = await Promise.all(
          [...groups.values()].map((g) =>
            g.page.listMetrics({ vm: victoria, clusterId: g.clusterId, ids: g.ids, now }),
          ),
        );
        const metrics: Record<string, RowMetrics> = {};
        for (const m of maps) for (const [id, v] of m) metrics[id] = v;
        return { metrics };
      } catch (err) {
        if (err instanceof VictoriaError) return sendProblem(reply, 502, 'Metrics are unavailable');
        throw err;
      }
    },
  );

  app.get(
    '/applications/:id',
    {
      preHandler: signedIn,
      schema: {
        summary: 'One monitored service: its health, what WatchLog sees, who connects to it',
        tags: ['applications', PUBLIC_TAG],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        querystring: Type.Object({ range: RangeParam }),
        response: {
          200: Type.Object({
            application: ApplicationSchema,
            reasons: Type.Array(ReasonSchema),
            connected: Type.Union([ConnectedSchema, Type.Null()], {
              description: 'Null when the metrics store is unavailable',
            }),
            page: Type.Object({
              id: Type.String({ description: "'generic' until the type's own pages land" }),
              tabs: Type.Array(TabSchema),
            }),
            range: RangeQuery,
          }),
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const range = rangeOf(request.query.range);
      if (range === null)
        return sendProblem(reply, 400, 'range is one of 3600, 21600, 86400, 604800');
      const found = await contextOf(request.user!.org.id, request.params.id, range);
      if (!found) return sendProblem(reply, 404, 'Service not found');
      const { ctx, view } = found;
      const page = pageOf(ctx.row.type);
      const soft = <T>(p: Promise<T>, fallback: T) =>
        p.catch((err: Error) => {
          request.log.warn({ err: err.message }, 'service page query failed');
          return fallback;
        });
      // The metric-backed parts are cached for 15 s (after the organization check above).
      const key = `${ctx.row.id}:${range}:${view.reason.code}`;
      let cached = pageCache.get(key);
      if (!cached || ctx.now - cached.at > PAGE_CACHE_MS) {
        const [own, connected] = await Promise.all([
          view.reason.code === 'connected' ? soft(page.reasons(ctx), []) : Promise.resolve([]),
          soft(connectedTo(ctx), null),
        ]);
        cached = { at: ctx.now, own, connected };
        pageCache.set(key, cached);
        if (pageCache.size > 500) {
          for (const [k, v] of pageCache) if (ctx.now - v.at > PAGE_CACHE_MS) pageCache.delete(k);
        }
      }
      const { own, connected } = cached;
      const reasons = sortReasons([
        ...statusReasons(view.health, view.reason, ctx.row.status_details, ctx.row.target),
        ...own,
      ]);
      return {
        application: view,
        reasons,
        connected,
        page: { id: page.id, tabs: page.tabs.map((t) => ({ id: t.id, title: t.title })) },
        range,
      };
    },
  );

  app.get(
    '/applications/:id/panels',
    {
      preHandler: signedIn,
      schema: {
        summary: "One tab of a service's page: its panels, filled",
        tags: ['applications'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        querystring: Type.Object({
          tab: Type.Optional(Type.String({ maxLength: 64 })),
          range: RangeParam,
        }),
        response: {
          200: Type.Object({
            tab: Type.String(),
            range: RangeQuery,
            panels: Type.Array(PanelSchema),
          }),
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
          502: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const range = rangeOf(request.query.range);
      if (range === null)
        return sendProblem(reply, 400, 'range is one of 3600, 21600, 86400, 604800');
      const found = await contextOf(request.user!.org.id, request.params.id, range);
      if (!found) return sendProblem(reply, 404, 'Service not found');
      const page = pageOf(found.ctx.row.type);
      const tab = request.query.tab
        ? page.tabs.find((t) => t.id === request.query.tab)
        : page.tabs[0];
      if (!tab) return sendProblem(reply, 404, 'No such tab');
      try {
        const panels = await tab.panels(found.ctx);
        return { tab: tab.id, range, panels };
      } catch (err) {
        if (err instanceof VictoriaError) return sendProblem(reply, 502, 'Metrics are unavailable');
        throw err;
      }
    },
  );

  app.post(
    '/applications',
    {
      preHandler: canManage,
      schema: {
        summary: 'Monitor a service (Monitor, or Add manually)',
        tags: ['applications'],
        body: CreateBody,
        response: {
          201: Type.Object({ application: ApplicationSchema }),
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const orgId = request.user!.org.id;
      const cluster = await db
        .selectFrom('clusters')
        .select(['id', 'kind'])
        .where('id', '=', body.clusterId)
        .where('org_id', '=', orgId)
        .executeTakeFirst();
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const kind = SERVICE_KINDS.find((k) => k.type === body.type)!;
      if (!kind.available) {
        return sendProblem(
          reply,
          400,
          `${body.type} monitoring isn't available in this version yet`,
        );
      }
      const target = body.target as IntegrationTarget;
      const k8sTarget = target.kind === 'workload';
      const dockerTarget = target.kind === 'compose' || target.kind === 'container';
      if (
        (k8sTarget && cluster.kind !== 'kubernetes') ||
        (dockerTarget && cluster.kind !== 'docker')
      ) {
        return sendProblem(
          reply,
          400,
          `A ${target.kind} target doesn't belong to a ${cluster.kind} cluster`,
        );
      }
      let collectorHost = '';
      if (dockerTarget) collectorHost = target.host;
      if (target.kind === 'address' && cluster.kind === 'docker') {
        if (!body.collectorHost) {
          return sendProblem(
            reply,
            400,
            'Name the Docker host whose collector reaches this address',
          );
        }
        collectorHost = body.collectorHost;
      }
      const existing = await db
        .selectFrom('integrations')
        .select(['type', 'target', 'cluster_id'])
        .where('cluster_id', '=', cluster.id)
        .execute();
      const key = targetKey(cluster.id, body.type, target);
      if (
        existing.some((e) => targetKey(e.cluster_id, e.type, e.target as IntegrationTarget) === key)
      ) {
        return sendProblem(reply, 409, 'This service is already monitored');
      }
      const name =
        body.name ??
        (target.kind === 'workload'
          ? `${target.namespace}/${target.workload}`
          : target.kind === 'compose'
            ? `${target.compose_project}/${target.compose_service}`
            : target.kind === 'container'
              ? target.container
              : target.address);
      const id = newId();
      try {
        await db
          .insertInto('integrations')
          .values({
            id,
            org_id: orgId,
            cluster_id: cluster.id,
            type: body.type,
            name,
            target: JSON.stringify(target),
            collector_host: collectorHost,
            created_by: request.user!.id,
          })
          .execute();
      } catch (err) {
        if (isUniqueViolation(err)) {
          return sendProblem(
            reply,
            409,
            `A ${body.type} service named ${name} is already monitored`,
          );
        }
        throw err;
      }
      notifier.notify(cluster.id);
      const [row] = await listApplicationRows(db, orgId, { id });
      const collectors = await listCollectors(db, [cluster.id]);
      return reply.code(201).send({ application: toView(row!, collectors) });
    },
  );

  app.delete(
    '/applications/:id',
    {
      preHandler: canManage,
      schema: {
        summary: 'Stop monitoring a service',
        tags: ['applications'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 204: Type.Null(), 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const row = await db
        .deleteFrom('integrations')
        .where('id', '=', request.params.id)
        .where('org_id', '=', request.user!.org.id)
        .returning('cluster_id')
        .executeTakeFirst();
      if (!row) return sendProblem(reply, 404, 'Service not found');
      notifier.notify(row.cluster_id);
      return reply.code(204).send(null);
    },
  );
};
