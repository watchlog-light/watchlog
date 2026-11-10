// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
// Applications API (SPEC §4.12, ADR-132, ADR-135): monitored services, discovered ones,
// the collectors, Monitor and remove. Credentials and the connect flow are slice 4.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from 'typebox';
import { isUniqueViolation, type Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { sendProblem } from '../../lib/problem.js';
import { VictoriaError, type VictoriaQueryClient } from '../../lib/victoria.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import {
  dockerCollectorCommand,
  integrationsImage,
  type installTarget,
} from '../clusters/install.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { INTEGRATION_TYPES, type IntegrationTarget } from './collector-config.js';
import { alertDefaultsFor, createServiceRules, deleteServiceRules } from './alert-defaults.js';
import { adoptProbe, placementOf } from './connect.js';
import { recordEvent } from './credentials.js';
import { DockerName, Name, TargetSchema } from './schemas.js';

export { TargetSchema };
import { discover, listIgnored, targetKey } from './discovery.js';
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
  /** What answers when it isn't the type's own server: "valkey" for a Redis-compatible Valkey. */
  product: Type.Union([Type.String(), Type.Null()]),
  cluster: ClusterRef,
  where: Type.Object({
    group: Type.Union([Type.String(), Type.Null()]),
    host: Type.Union([Type.String(), Type.Null()]),
    address: Type.Union([Type.String(), Type.Null()]),
  }),
  /** What the collector connects to: a workload, a Compose service, a container or an address. */
  target: TargetSchema,
  /** The worst of reachability and the active findings (critical, then warning). */
  health: Health,
  reason: Reason,
  /** The most severe active finding when it decides the health ("What WatchLog sees"). */
  finding: Type.Optional(Type.Union([ReasonSchema, Type.Null()])),
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
  /** "valkey" for a Valkey image (the Redis integration reads it), else null. */
  product: Type.Union([Type.String(), Type.Null()]),
  port: Type.Integer(),
  confidence: Type.Union([Type.Literal('image'), Type.Literal('port')]),
  members: Type.Integer(),
  host: Type.Union([Type.String(), Type.Null()]),
  group: Type.String(),
  target: TargetSchema,
});

const IgnoredSchema = Type.Object({
  id: Type.String(),
  cluster: ClusterRef,
  scope: Type.Union([Type.Literal('service'), Type.Literal('group')]),
  label: Type.String(),
  createdAt: Type.String(),
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
    /** The connect drawer's tested access (ADR-134); its credential moves to the service. */
    probeId: Type.Optional(Type.String({ format: 'uuid' })),
    /** Collect query text (ADR-138); on by default. */
    queryText: Type.Optional(Type.Boolean()),
    /** The default alert rules to turn on (GET /applications/alert-defaults); the rest are created off. */
    defaultAlerts: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
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
    product: (row.status_details as { product?: string }).product ?? null,
    cluster: {
      id: row.cluster_id,
      name: row.cluster_name,
      kind: row.cluster_kind as 'kubernetes' | 'docker',
    },
    where: whereOf(row.target),
    target: row.target,
    health,
    reason,
    finding: null,
    members: { up: members.filter((m) => m.up).length, total: members.length },
    monitoredSince: row.monitored_since.toISOString(),
    lastReportAt: row.last_report_at?.toISOString() ?? null,
  };
}

const ORDER: Record<string, number> = { critical: 0, warning: 1, unknown: 2, ok: 3 };

/**
 * A service's health from reachability and its active findings: a critical finding makes
 * it critical, a warning one at least warning. The list, the page, the REST API and MCP
 * all get it from here, so the badge never says healthy beside a red finding.
 */
export function withFindings(view: ApplicationView, own: Reason[]): ApplicationView {
  const worst =
    own.find((r) => r.severity === 'critical') ?? own.find((r) => r.severity === 'warning');
  if (!worst) return { ...view, finding: null };
  const sev = worst.severity as 'critical' | 'warning';
  const health = ORDER[sev]! < ORDER[view.health]! ? sev : view.health;
  return { ...view, health, finding: worst };
}
const PAGE_CACHE_MS = 15_000;

const RangeQuery = Type.Integer({ description: 'Seconds back from now: 1h, 6h, 24h or 7d' });
// Query strings arrive as text; coerce, then check against the four ranges.
const RangeParam = Type.Optional(Type.Integer({ minimum: 3600, maximum: 604800 }));
const rangeOf = (v: number | undefined): number | null =>
  v === undefined ? 3600 : (PAGE_RANGES as readonly number[]).includes(v) ? v : null;

export const applicationRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  notifier: ConfigNotifier;
  secretKey: Buffer;
  victoria?: VictoriaQueryClient;
  install?: ReturnType<typeof installTarget>;
}> = async (app, { db, notifier, secretKey, victoria, install }) => {
  const signedIn = requireUser(db);
  const canManage = [signedIn, requireRole('owner', 'admin')];
  const pageCache = new Map<
    string,
    { at: number; own: Reason[]; connected: ConnectedResult | null }
  >();

  // A service's own findings (its integration's reasons), shared by the list and the
  // page for 15 s; refreshed at once when the collector reports something new.
  const findingsCache = new Map<string, { at: number; own: Reason[] }>();
  const extraHash = (row: ApplicationRow) =>
    createHash('sha1')
      .update(JSON.stringify((row.status_details as { extra?: unknown } | null)?.extra ?? null))
      .digest('base64url')
      .slice(0, 12);
  async function findingsOf(
    row: ApplicationRow,
    view: ApplicationView,
    collectors: CollectorRow[],
    now: number,
    log?: { warn: (o: object, msg: string) => void },
  ): Promise<Reason[]> {
    if (!victoria || view.reason.code !== 'connected') return [];
    const key = `${row.id}:${extraHash(row)}`;
    const hit = findingsCache.get(key);
    if (hit && now - hit.at <= PAGE_CACHE_MS) return hit.own;
    const ctx: PageContext = {
      db,
      vm: victoria,
      row,
      collector: collectorOf(row, collectors),
      range: 3600,
      now,
    };
    const own = await pageOf(row.type)
      .reasons(ctx)
      .catch((err: Error) => {
        log?.warn({ err: err.message }, 'service findings failed');
        return [] as Reason[];
      });
    findingsCache.set(key, { at: now, own });
    if (findingsCache.size > 500) {
      for (const [k, v] of findingsCache) if (now - v.at > PAGE_CACHE_MS) findingsCache.delete(k);
    }
    return own;
  }

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
      // Each connected service's findings, four at a time (cached 15 s).
      const applications: ApplicationView[] = new Array(rows.length);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, rows.length) }, async () => {
          while (next < rows.length) {
            const i = next++;
            const view = toView(rows[i]!, collectors, now);
            applications[i] = withFindings(
              view,
              await findingsOf(rows[i]!, view, collectors, now, request.log),
            );
          }
        }),
      );
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
          200: Type.Object({
            discovered: Type.Array(DiscoveredSchema),
            /** What people chose to ignore (one service, or a namespace or project). */
            ignored: Type.Array(IgnoredSchema),
          }),
          401: ProblemSchema,
        },
      },
    },
    async (request) => {
      const [found, ignored] = await Promise.all([
        discover(db, request.user!.org.id, request.query.cluster),
        listIgnored(db, request.user!.org.id, request.query.cluster),
      ]);
      return {
        ignored: ignored.map((i) => ({
          id: i.id,
          cluster: { id: i.clusterId, name: i.clusterName, kind: i.clusterKind },
          scope: i.scope,
          label: i.label,
          createdAt: i.createdAt.toISOString(),
        })),
        discovered: found.map((d) => ({
          key: d.key,
          cluster: { id: d.clusterId, name: d.clusterName, kind: d.clusterKind },
          type: d.type,
          name: d.name,
          image: d.image,
          version: d.version,
          product: d.product,
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

  app.post(
    '/applications/discovered/ignore',
    {
      preHandler: canManage,
      schema: {
        summary: 'Ignore a discovered service, or every one in a namespace or Compose project',
        tags: ['applications'],
        body: Type.Object(
          {
            clusterId: Type.String({ format: 'uuid' }),
            /** One candidate's key, as GET /applications/discovered gives it. */
            key: Type.Optional(Type.String({ minLength: 1, maxLength: 600 })),
            /** A Kubernetes namespace or a Compose project. */
            group: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
          },
          { additionalProperties: false },
        ),
        response: {
          201: Type.Object({ ignored: IgnoredSchema }),
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const { clusterId, key, group } = request.body;
      if ((key === undefined) === (group === undefined)) {
        return sendProblem(
          reply,
          400,
          'Name one service (key) or one namespace or project (group)',
        );
      }
      const found = await discover(db, orgId, clusterId);
      const match = key ? found.find((d) => d.key === key) : found.find((d) => d.group === group);
      if (!match) return sendProblem(reply, 404, 'No discovered service matches');
      const what = match.clusterKind === 'kubernetes' ? 'namespace' : 'Compose project';
      const label = key ? `${match.type} ${match.name}` : `${what} ${group}`;
      const id = newId();
      const row = await db
        .insertInto('discovery_ignores')
        .values({
          id,
          org_id: orgId,
          cluster_id: clusterId,
          service_key: key ?? null,
          group_name: key ? null : group!,
          label,
          created_by: request.user!.id,
        })
        .onConflict((oc) => oc.doNothing())
        .returning(['id', 'created_at'])
        .executeTakeFirst();
      reply.code(201);
      return {
        ignored: {
          id: row?.id ?? id,
          cluster: { id: clusterId, name: match.clusterName, kind: match.clusterKind },
          scope: key ? ('service' as const) : ('group' as const),
          label,
          createdAt: (row?.created_at ?? new Date()).toISOString(),
        },
      };
    },
  );

  app.delete(
    '/applications/discovered/ignore/:id',
    {
      preHandler: canManage,
      schema: {
        summary: 'Show an ignored service, namespace or project in the discovered list again',
        tags: ['applications'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 204: Type.Null(), 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const r = await db
        .deleteFrom('discovery_ignores')
        .where('id', '=', request.params.id)
        .where('org_id', '=', request.user!.org.id)
        .executeTakeFirst();
      if (!r.numDeletedRows) return sendProblem(reply, 404, 'Not ignored');
      return reply.code(204).send(null);
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
    '/applications/alert-defaults',
    {
      preHandler: signedIn,
      schema: {
        summary: 'The default alert rules a service of this type gets',
        tags: ['applications'],
        querystring: Type.Object({
          type: Type.Union(INTEGRATION_TYPES.map((t) => Type.Literal(t))),
        }),
        response: {
          200: Type.Object({
            defaults: Type.Array(
              Type.Object({
                key: Type.String(),
                name: Type.String(),
                metric: Type.String(),
                condition: Type.Object({
                  op: Type.Union([Type.Literal('>'), Type.Literal('<')]),
                  value: Type.Number(),
                  critical: Type.Optional(Type.Number()),
                }),
                forSeconds: Type.Integer(),
              }),
            ),
          }),
          401: ProblemSchema,
        },
      },
    },
    async (request) => ({ defaults: alertDefaultsFor(request.query.type) }),
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
        { page: ReturnType<typeof pageOf>; clusterId: string; ids: string[]; rows: typeof rows }
      >();
      for (const r of rows) {
        const page = pageOf(r.type);
        const key = `${r.cluster_id}\u0000${page.id}\u0000${r.type}`;
        const g = groups.get(key) ?? { page, clusterId: r.cluster_id, ids: [], rows: [] };
        g.ids.push(r.id);
        g.rows.push(r);
        groups.set(key, g);
      }
      const now = Date.now();
      try {
        const maps = await Promise.all(
          [...groups.values()].map((g) =>
            g.page.listMetrics({
              vm: victoria,
              clusterId: g.clusterId,
              ids: g.ids,
              rows: g.rows,
              now,
            }),
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
            /** Docker, no collector on the service's host yet: the command that starts one. */
            collectorCommand: Type.Optional(Type.String()),
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
      // A new report of what the collector found (stub_status, metrics on) shows at once.
      const key = `${ctx.row.id}:${range}:${view.reason.code}:${extraHash(ctx.row)}`;
      let cached = pageCache.get(key);
      if (!cached || ctx.now - cached.at > PAGE_CACHE_MS) {
        cached = { at: ctx.now, own: [], connected: await soft(connectedTo(ctx), null) };
        pageCache.set(key, cached);
        if (pageCache.size > 500) {
          for (const [k, v] of pageCache) if (ctx.now - v.at > PAGE_CACHE_MS) pageCache.delete(k);
        }
      }
      const { connected } = cached;
      const own = await findingsOf(
        ctx.row,
        view,
        ctx.collector ? [ctx.collector] : [],
        ctx.now,
        request.log,
      );
      const reasons = sortReasons([
        ...statusReasons(view.health, view.reason, ctx.row.status_details, ctx.row.target),
        ...own,
      ]);
      return {
        application: withFindings(view, own),
        reasons,
        connected,
        page: { id: page.id, tabs: page.tabs.map((t) => ({ id: t.id, title: t.title })) },
        range,
        ...(install &&
        view.cluster.kind === 'docker' &&
        ctx.row.collector_host &&
        (view.reason.code === 'collector_missing' || view.reason.code === 'collector_silent')
          ? {
              collectorCommand: dockerCollectorCommand({
                fallback: await install.configuredEndpoint(),
                image: integrationsImage(install.image),
                host: ctx.row.collector_host,
              }),
            }
          : {}),
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
        // A tab the collector's user can't read (ADR-134): its panels say what is missing
        // and how to grant it, instead of showing empty charts. The other tabs still work.
        const missing = (
          (found.ctx.row.status_details as { permissions?: { tab: string; missing: string }[] })
            .permissions ?? []
        ).filter((p) => p.tab === tab.id || p.tab.startsWith(`${tab.id}/`));
        const panels = (await tab.panels(found.ctx)).map((p) => {
          // A whole tab ("memory"), or one panel of it ("memory/prefixes").
          const m = missing.find((x) => x.tab === tab.id || x.tab === `${tab.id}/${p.id}`);
          return m && p.state !== 'error'
            ? {
                ...p,
                state: 'needs_permission' as const,
                missing: {
                  key: `integrations.${found.ctx.row.type}.missing.${m.tab.replace('/', '.')}`,
                  values: { missing: m.missing },
                },
              }
            : p;
        });
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
      const target = body.target as IntegrationTarget;
      const placed = await placementOf(db, orgId, { ...body, target });
      if (!placed.ok) return sendProblem(reply, placed.status, placed.message);
      const cluster = { id: body.clusterId };
      const collectorHost = placed.collectorHost;
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
            ...(body.queryText === false
              ? { settings: JSON.stringify({ query_text: false }) }
              : {}),
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
      const who = {
        user: { id: request.user!.id, name: request.user!.name, email: request.user!.email },
        ip: request.ip,
      };
      await recordEvent(db, { orgId, integrationId: id, action: 'monitored', ...who });
      if (body.probeId) {
        const adopted = await adoptProbe(db, secretKey, {
          orgId,
          integrationId: id,
          probeId: body.probeId,
          userId: request.user!.id,
        });
        if (!adopted.ok) {
          await db.deleteFrom('integrations').where('id', '=', id).execute();
          return sendProblem(reply, adopted.status, adopted.message);
        }
        if (adopted.method !== 'none') {
          await recordEvent(db, {
            orgId,
            integrationId: id,
            action: 'credential_set',
            details: { method: adopted.method },
            ...who,
          });
        }
      }
      await createServiceRules(
        db,
        orgId,
        { id, clusterId: cluster.id, type: body.type },
        body.defaultAlerts ?? [],
      );
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
        .returning(['cluster_id', 'name', 'type'])
        .executeTakeFirst();
      if (!row) return sendProblem(reply, 404, 'Service not found');
      await deleteServiceRules(db, request.user!.org.id, request.params.id);
      await recordEvent(db, {
        orgId: request.user!.org.id,
        integrationId: request.params.id,
        action: 'removed',
        user: { id: request.user!.id, name: request.user!.name, email: request.user!.email },
        ip: request.ip,
        details: { name: row.name, type: row.type },
      });
      notifier.notify(row.cluster_id);
      return reply.code(204).send(null);
    },
  );
};
