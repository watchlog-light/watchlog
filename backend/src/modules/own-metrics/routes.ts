// SPDX-License-Identifier: AGPL-3.0-only
// "Your metrics" in the panel (1.0.0, ADR-236), per cluster or fleet: what the org uses of its
// allowance, the sources with what each dropped and why, the write-only tokens, the cluster's
// Prometheus-annotations switch, and "Find endpoints for me". Everyone reads; Owners and Admins
// add and remove. The demo refuses every change like any other (ADR-122).
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type, type Static } from 'typebox';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { sendProblem } from '../../lib/problem.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { ProblemSchema } from '../auth/schemas.js';
import { clusterForOrg } from '../clusters/service.js';
import { sendPlanLimit } from '../entitlements/limits.js';
import type { TokenCache } from '../ingest/token-cache.js';
import type { ConfigNotifier } from '../integrations/notifier.js';
import type { Belonging } from './belonging.js';
import type { AddressTest, Probes } from './probes.js';
import type { Dropped, OwnMetrics } from './service.js';
import { normaliseAddress, podSourceKey, type PanelPod, type Targets } from './targets.js';
import {
  countOrgMetricTokens,
  issueMetricToken,
  listMetricTokens,
  MAX_METRIC_TOKENS,
  MAX_ORG_METRIC_TOKENS,
  revokeMetricToken,
} from './tokens.js';

const Params = Type.Object({ id: Type.String({ format: 'uuid' }) });
const N = Type.Union([Type.Number(), Type.Null()]);
const S = Type.Union([Type.String(), Type.Null()]);
/** Reads are part of the public API (a token may read them); changes are the panel's. */
const TAGS = [PUBLIC_TAG, 'own-metrics'];
const PANEL = ['own-metrics'];

const OwnerS = Type.Object({
  kind: Type.Union([Type.Literal(''), Type.Literal('workload'), Type.Literal('server')]),
  namespace: Type.String(),
  workloadKind: Type.String(),
  name: Type.String(),
});

const LimitsS = Type.Object({
  series: Type.Number(),
  seriesPerSource: Type.Number(),
  sources: N,
  dashboards: Type.Number(),
  widgetsPerDashboard: Type.Number(),
  alerts: Type.Union([Type.Literal('none'), Type.Literal('threshold'), Type.Literal('all')]),
  usualRange: Type.Boolean(),
  watched: Type.Number(),
});

const SourceS = Type.Object({
  id: Type.String(),
  kind: Type.Union([
    Type.Literal('scrape_pod'),
    Type.Literal('scrape_address'),
    Type.Literal('remote_write'),
    Type.Literal('push'),
  ]),
  label: Type.String(),
  owner: OwnerS,
  /** Where its series belong when they don't all share one owner (a token's): up to 5. */
  owners: Type.Array(OwnerS),
  series: Type.Number(),
  lastReportedAt: N,
  error: S,
  /** Over the plan's number of sources: nothing of it is stored. */
  refused: Type.Boolean(),
  dropped: Type.Object({
    reserved: Type.Number(),
    invalid: Type.Number(),
    cardinality: Type.Array(Type.Object({ metric: Type.String(), label: Type.String() })),
    sourceCap: Type.Number(),
    orgCap: Type.Number(),
    sources: Type.Boolean(),
  }),
  /** Whether it can be removed here (an annotated pod is removed by its annotation). */
  removable: Type.Boolean(),
  /** How it was asked for: an annotation, the panel, a token. */
  by: Type.String(),
});

const SummaryS = Type.Object({
  usage: Type.Object({ series: Type.Number(), sources: Type.Number() }),
  limits: LimitsS,
  sources: Type.Array(SourceS),
  tokens: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      prefix: Type.String(),
      createdAt: Type.Number(),
      lastUsedAt: N,
    }),
  ),
  metrics: Type.Number({ description: 'Metrics on the default list' }),
  hidden: Type.Number({ description: 'Metrics behind "Show all"' }),
  settings: Type.Object({ prometheusAnnotations: Type.Boolean() }),
  kind: Type.Union([Type.Literal('kubernetes'), Type.Literal('server')]),
  /** A fleet's servers, for "an address on one server". */
  servers: Type.Array(Type.String()),
  /** Kubernetes: the workloads a push or a scraped port can belong to (the page's picker). */
  workloads: Type.Array(
    Type.Object({ namespace: Type.String(), kind: Type.String(), name: Type.String() }),
  ),
  /** Where remote write and pushes are sent: this server's address as senders reach it. */
  endpoint: Type.String(),
});

const NewSource = Type.Union([
  Type.Object({
    server: Type.String({ minLength: 1, maxLength: 253 }),
    address: Type.String({ minLength: 1, maxLength: 300 }),
  }),
  Type.Object({
    namespace: Type.String({ minLength: 1, maxLength: 253 }),
    workloadKind: Type.String({ minLength: 1, maxLength: 64 }),
    workload: Type.String({ minLength: 1, maxLength: 253 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    path: Type.Optional(Type.String({ pattern: '^/', maxLength: 256 })),
  }),
]);

const FoundS = Type.Object({
  id: Type.String(),
  done: Type.Boolean(),
  asked: Type.Number({ description: 'Candidates tried' }),
  tried: Type.Object({
    ports: Type.Array(Type.Number(), { description: 'Ports asked for /metrics' }),
    skipped: Type.Array(Type.Number(), {
      description: 'Ports left out because they never serve metrics (SSH, databases)',
    }),
    scraped: Type.Number({ description: 'Ports left out because they are scraped already' }),
    workloads: Type.Number({ description: 'Kubernetes: workloads whose ports were tried' }),
  }),
  found: Type.Array(
    Type.Object({
      series: Type.Number(),
      names: Type.Array(Type.String()),
      add: Type.Union([
        Type.Object({
          kind: Type.Literal('pod'),
          namespace: Type.String(),
          workloadKind: Type.String(),
          workload: Type.String(),
          port: Type.Number(),
        }),
        Type.Object({
          kind: Type.Literal('address'),
          server: Type.String(),
          address: Type.String(),
          workload: Type.String(),
        }),
      ]),
    }),
  ),
});

/** The name of the value "Send a test value for me" sends: plainly a test, and a gauge. */
export const TEST_METRIC = 'my_first_test_value';

const TestS = Type.Object({
  id: Type.String(),
  done: Type.Boolean(),
  address: Type.String({ description: 'The address as it was read' }),
  outcome: Type.Optional(
    Type.String({
      description:
        'answered, or why not: refused, no_host, slow, big, auth, status, html, not_metrics, redirect, tls, address, other, silent (the collector did not answer the test)',
    }),
  ),
  series: Type.Optional(Type.Number()),
  names: Type.Optional(Type.Array(Type.String())),
  kept: Type.Optional(
    Type.Number({ description: 'Series that would be kept within the caps, when fewer than read' }),
  ),
  cap: Type.Optional(Type.Union([Type.Literal('source'), Type.Literal('plan')])),
  detail: Type.Optional(Type.String()),
});

const ReceivedS = Type.Object({
  /** The server's clock, for the next `since` (the page's own clock may differ). */
  now: Type.Number(),
  received: Type.Union([
    Type.Null(),
    Type.Object({
      at: Type.Number(),
      way: Type.Union([Type.Literal('push'), Type.Literal('remote_write')]),
      metricId: Type.String(),
      name: Type.String(),
      owner: OwnerS,
      value: N,
      series: Type.Number({ description: 'Series this token sent since then' }),
      metrics: Type.Number({ description: 'Metrics this token sent since then' }),
    }),
  ]),
});

const TestValueS = Type.Object({
  name: Type.String(),
  value: Type.Number(),
  stored: Type.Boolean(),
  /** Why it wasn't stored: the plan's sources or series are in use. */
  refused: Type.Optional(Type.Union([Type.Literal('sources'), Type.Literal('series')])),
});

export interface OwnRoutesOptions {
  db: Database;
  own: OwnMetrics;
  targets: Targets;
  probes: Probes;
  tokens: TokenCache;
  notifier: ConfigNotifier;
  /** Where agents push to (the ingest or Public URL, else the request's own address). */
  endpointFor: (request: FastifyRequest) => Promise<string>;
  belonging: Belonging;
  now?: () => number;
}

const noDrops: Dropped = {
  reserved: 0,
  invalid: 0,
  cardinality: [],
  sourceCap: 0,
  orgCap: 0,
  sources: false,
};

export const ownMetricsRoutes: FastifyPluginAsyncTypebox<OwnRoutesOptions> = async (
  app,
  { db, own, targets, probes, tokens, notifier, endpointFor, belonging, now = Date.now },
) => {
  const read = [requireUser(), requireRole('owner', 'admin', 'viewer')];
  const write = [requireUser(), requireRole('owner', 'admin')];
  const NOT_FOUND = 'Cluster or fleet not found';

  app.get(
    '/clusters/:id/own-metrics',
    {
      preHandler: read,
      schema: {
        summary: 'Your metrics: what is used, the sources and what each dropped, the tokens',
        tags: TAGS,
        params: Params,
        response: { 200: SummaryS, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      // What is in memory is newer than the rows: write it first.
      await own.flush();
      const [usage, sources, tokenRows, counts, owners, servers, workloads] = await Promise.all([
        own.usage(cluster.org_id),
        db
          .selectFrom('own_sources')
          .selectAll()
          .where('cluster_id', '=', cluster.id)
          .orderBy('created_at')
          .execute(),
        listMetricTokens(db, cluster.id),
        db
          .selectFrom('own_metrics')
          .select(['hidden', (eb) => eb.fn.countAll<string>().as('n')])
          .where('cluster_id', '=', cluster.id)
          .groupBy('hidden')
          .execute(),
        db
          .selectFrom('own_series')
          .select([
            'source_id',
            'owner_kind',
            'owner_namespace',
            'owner_workload_kind',
            'owner_name',
          ])
          .distinct()
          .where('cluster_id', '=', cluster.id)
          .where('owner_kind', '<>', '')
          .limit(2000)
          .execute(),
        cluster.kind === 'server'
          ? db
              .selectFrom('agent_instances')
              .select('node')
              .distinct()
              .where('cluster_id', '=', cluster.id)
              .where('mode', '=', 'docker')
              .orderBy('node')
              .execute()
          : Promise.resolve([]),
        cluster.kind === 'server'
          ? Promise.resolve([])
          : db
              .selectFrom('objects')
              .select(['namespace', 'kind', 'name'])
              .where('cluster_id', '=', cluster.id)
              .where('kind', 'in', ['Deployment', 'StatefulSet', 'DaemonSet'])
              .where('deleted_at', 'is', null)
              .orderBy('namespace')
              .orderBy('name')
              .limit(2000)
              .execute(),
      ]);
      const ownersOf = new Map<string, (typeof owners)[number][]>();
      for (const o of owners) ownersOf.set(o.source_id, [...(ownersOf.get(o.source_id) ?? []), o]);
      const { limits } = usage;
      return {
        usage: { series: usage.series, sources: usage.sources },
        limits: {
          series: limits.series,
          seriesPerSource: limits.seriesPerSource,
          sources: limits.sources,
          dashboards: limits.dashboards,
          widgetsPerDashboard: limits.widgetsPerDashboard,
          alerts: limits.alerts,
          usualRange: limits.usualRange,
          watched: limits.watched,
        },
        sources: sources.map((s) => {
          const by =
            s.kind === 'scrape_pod'
              ? ((s.config as { by?: string }).by ?? 'watchlog')
              : s.kind === 'scrape_address'
                ? 'panel'
                : 'token';
          return {
            id: s.id,
            kind: s.kind as 'scrape_pod',
            label: s.label,
            owner: {
              kind: '' as const,
              namespace: '',
              workloadKind: '',
              name: '',
              ...(s.owner as object),
            },
            owners: (ownersOf.get(s.id) ?? []).slice(0, 5).map((o) => ({
              kind: o.owner_kind as 'workload',
              namespace: o.owner_namespace,
              workloadKind: o.owner_workload_kind,
              name: o.owner_name,
            })),
            series: s.series,
            lastReportedAt: s.last_reported_at ? s.last_reported_at.getTime() : null,
            error: s.error,
            refused: s.refused,
            dropped: { ...noDrops, ...(s.dropped as Partial<Dropped>) },
            removable: by === 'panel',
            by,
          };
        }),
        tokens: tokenRows.map((t) => ({
          id: t.id,
          name: t.name,
          prefix: t.prefix,
          createdAt: t.created_at.getTime(),
          lastUsedAt: t.last_used_at ? t.last_used_at.getTime() : null,
        })),
        metrics: Number(counts.find((c) => !c.hidden)?.n ?? 0),
        hidden: Number(counts.find((c) => c.hidden)?.n ?? 0),
        settings: { prometheusAnnotations: cluster.own_metrics_prometheus_annotations },
        kind: cluster.kind === 'server' ? ('server' as const) : ('kubernetes' as const),
        servers: servers.map((s) => s.node),
        workloads: workloads.map((w) => ({
          namespace: w.namespace ?? '',
          kind: w.kind,
          name: w.name,
        })),
        endpoint: await endpointFor(request),
      };
    },
  );

  app.post(
    '/clusters/:id/own-metrics/tokens',
    {
      preHandler: write,
      schema: {
        summary: 'Create a write-only token for remote write, pushes and change events',
        description: 'Its value is returned once.',
        tags: PANEL,
        params: Params,
        body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }) }),
        response: {
          201: Type.Object({
            id: Type.String(),
            name: Type.String(),
            prefix: Type.String(),
            value: Type.String(),
          }),
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
      const name = request.body.name.trim();
      if (!name) return sendProblem(reply, 400, 'Give the token a name');
      const existing = await listMetricTokens(db, cluster.id);
      if (existing.length >= MAX_METRIC_TOKENS) {
        return sendProblem(
          reply,
          409,
          `A cluster or fleet can have ${MAX_METRIC_TOKENS} own-metrics tokens; revoke one first`,
        );
      }
      if (existing.some((t) => t.name === name)) {
        return sendProblem(reply, 409, 'A token with this name exists; pick another name');
      }
      // And the org over all its clusters and fleets (1.0.3).
      if ((await countOrgMetricTokens(db, request.user!.org.id)) >= MAX_ORG_METRIC_TOKENS) {
        return sendProblem(
          reply,
          409,
          `An organization can have ${MAX_ORG_METRIC_TOKENS} own-metrics tokens over all its clusters and fleets; revoke one first`,
        );
      }
      const t = await issueMetricToken(db, cluster.id, name, request.user!.id);
      return reply.code(201).send({ id: t.id, name, prefix: t.prefix, value: t.value });
    },
  );

  app.delete(
    '/clusters/:id/own-metrics/tokens/:tokenId',
    {
      preHandler: write,
      schema: {
        summary: 'Revoke an own-metrics token; what it sent ages out with the retention',
        tags: PANEL,
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          tokenId: Type.String({ format: 'uuid' }),
        }),
        response: { 204: Type.Null(), 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      await own.forget(cluster.id);
      if (!(await revokeMetricToken(db, cluster.id, request.params.tokenId))) {
        return sendProblem(reply, 404, 'Token not found');
      }
      tokens.invalidateMetricToken(request.params.tokenId);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/clusters/:id/own-metrics/sources',
    {
      preHandler: write,
      schema: {
        summary: "Scrape an address on one server, or a workload's port (no annotation needed)",
        tags: PANEL,
        params: Params,
        body: NewSource,
        response: {
          201: Type.Object({ id: Type.String() }),
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
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const body = request.body;
      const usage = await own.usage(cluster.org_id);
      if (usage.limits.sources !== null && usage.sources >= usage.limits.sources) {
        return sendPlanLimit(
          reply,
          402,
          'own-sources',
          usage.limits.sources,
          `Your plan has ${usage.limits.sources} sources of your own metrics, and all are in use. Remove one, or upgrade to Pro for more.`,
        );
      }
      let row: { key: string; label: string; kind: string; owner: object; config: object };
      if ('server' in body) {
        if (cluster.kind !== 'server') {
          return sendProblem(reply, 400, 'An address is scraped on a server of a Server fleet');
        }
        const url = normaliseAddress(body.address);
        if (!url) {
          return sendProblem(
            reply,
            400,
            'Give an address like localhost:9400/metrics (http or https, no user or password)',
          );
        }
        const server = await db
          .selectFrom('agent_instances')
          .select('node')
          .where('cluster_id', '=', cluster.id)
          .where('node', '=', body.server)
          .executeTakeFirst();
        if (!server) return sendProblem(reply, 400, `No server named ${body.server} in this fleet`);
        const shown = url.replace(/^https?:\/\//, '');
        row = {
          kind: 'scrape_address',
          key: `addr:${body.server}:${url}`,
          label: `${body.server} ${shown.replace(/^(localhost|127\.0\.0\.1)/, '')}`,
          owner: { kind: 'server', namespace: '', workloadKind: '', name: body.server },
          config: { server: body.server, url, address: body.address.trim() },
        };
      } else {
        if (cluster.kind === 'server') {
          return sendProblem(reply, 400, 'A workload endpoint is scraped in a Kubernetes cluster');
        }
        const c: PanelPod = {
          by: 'panel',
          namespace: body.namespace,
          workloadKind: body.workloadKind,
          workload: body.workload,
          port: body.port,
          path: body.path ?? '/metrics',
        };
        row = {
          kind: 'scrape_pod',
          key: podSourceKey(c),
          label: `${c.workload} :${c.port}${c.path}`,
          owner: {
            kind: 'workload',
            namespace: c.namespace,
            workloadKind: c.workloadKind,
            name: c.workload,
          },
          config: c,
        };
      }
      const id = newId();
      const inserted = await db
        .insertInto('own_sources')
        .values({
          id,
          cluster_id: cluster.id,
          kind: row.kind,
          key: row.key,
          label: row.label,
          owner: JSON.stringify(row.owner),
          config: JSON.stringify(row.config),
        })
        .onConflict((oc) => oc.columns(['cluster_id', 'key']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!inserted) return sendProblem(reply, 409, 'This endpoint is already scraped');
      await own.forget(cluster.id);
      targets.forget(cluster.id);
      notifier.notify(cluster.id);
      return reply.code(201).send({ id });
    },
  );

  app.delete(
    '/clusters/:id/own-metrics/sources/:sourceId',
    {
      preHandler: write,
      schema: {
        summary: 'Stop scraping an endpoint added in the panel',
        tags: PANEL,
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          sourceId: Type.String({ format: 'uuid' }),
        }),
        response: {
          204: Type.Null(),
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
      const s = await db
        .selectFrom('own_sources')
        .select(['id', 'kind', 'config'])
        .where('cluster_id', '=', cluster.id)
        .where('id', '=', request.params.sourceId)
        .executeTakeFirst();
      if (!s) return sendProblem(reply, 404, 'Source not found');
      const by = (s.config as { by?: string }).by;
      if (s.kind === 'remote_write' || s.kind === 'push') {
        return sendProblem(reply, 400, "A token's source goes when the token is revoked");
      }
      if (s.kind === 'scrape_pod' && by !== 'panel') {
        return sendProblem(
          reply,
          400,
          'This endpoint is scraped because of its annotation: remove the annotation from the pod',
        );
      }
      await own.forget(cluster.id);
      await db.deleteFrom('own_sources').where('id', '=', s.id).execute();
      targets.forget(cluster.id);
      notifier.notify(cluster.id);
      return reply.code(204).send(null);
    },
  );

  app.put(
    '/clusters/:id/own-metrics/settings',
    {
      preHandler: write,
      schema: {
        summary: 'Also scrape pods annotated prometheus.io/scrape (off by default)',
        tags: PANEL,
        params: Params,
        body: Type.Object({ prometheusAnnotations: Type.Boolean() }),
        response: {
          200: Type.Object({ prometheusAnnotations: Type.Boolean() }),
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
      if (cluster.kind === 'server') {
        return sendProblem(reply, 400, "Annotations are a Kubernetes cluster's; a fleet has none");
      }
      await db
        .updateTable('clusters')
        .set({ own_metrics_prometheus_annotations: request.body.prometheusAnnotations })
        .where('id', '=', cluster.id)
        .execute();
      targets.forget(cluster.id);
      notifier.notify(cluster.id);
      return { prometheusAnnotations: request.body.prometheusAnnotations };
    },
  );

  const foundOf = (p: NonNullable<ReturnType<Probes['current']>>) => ({
    id: p.id,
    done: probes.done(p),
    asked: p.candidates.length,
    tried: p.tried,
    found: p.found.map((f) => ({ series: f.series, names: f.names, add: f.candidate.add })),
  });

  app.post(
    '/clusters/:id/own-metrics/find',
    {
      preHandler: write,
      schema: {
        summary: 'Find endpoints for me: ask the collectors which ports answer on /metrics',
        tags: PANEL,
        params: Params,
        response: { 202: FoundS, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const p = await probes.start(cluster.id);
      notifier.notify(cluster.id);
      return reply.code(202).send(foundOf(p));
    },
  );

  app.get(
    '/clusters/:id/own-metrics/find',
    {
      preHandler: read,
      schema: {
        summary: 'What "Find endpoints for me" has found so far',
        tags: PANEL,
        params: Params,
        response: { 200: FoundS, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const p = probes.current(cluster.id);
      if (!p) return sendProblem(reply, 404, 'No search is running; start one');
      return foundOf(p);
    },
  );
  // ------------------------------------------------------------- "Test" before "Scrape it"

  /** A test's answer in the page's terms: what was read, and what the caps would keep of it. */
  const testOf = async (orgId: string, t: AddressTest): Promise<Static<typeof TestS>> => {
    const base = { id: t.id, done: probes.testDone(t), address: t.shown };
    if (!t.result) return base.done ? { ...base, outcome: 'silent' } : base;
    if (!t.result.ok) {
      return {
        ...base,
        outcome: t.result.reason,
        ...(t.result.detail ? { detail: t.result.detail } : {}),
      };
    }
    const { series, names } = t.result;
    const usage = await own.usage(orgId);
    const room = Math.max(0, usage.limits.series - usage.series);
    const kept = Math.min(series, usage.limits.seriesPerSource, room);
    return {
      ...base,
      outcome: 'answered',
      series,
      names,
      ...(kept < series
        ? {
            kept,
            cap: usage.limits.seriesPerSource <= room ? ('source' as const) : ('plan' as const),
          }
        : {}),
    };
  };

  app.post(
    '/clusters/:id/own-metrics/test',
    {
      preHandler: write,
      schema: {
        summary:
          'Test an address before scraping it: its collector reads it once and says what it found',
        tags: PANEL,
        params: Params,
        body: NewSource,
        response: {
          202: TestS,
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
      const body = request.body;
      let test: AddressTest;
      if ('server' in body) {
        if (cluster.kind !== 'server') {
          return sendProblem(reply, 400, 'An address is tested on a server of a Server fleet');
        }
        const url = normaliseAddress(body.address);
        if (!url) {
          return sendProblem(
            reply,
            400,
            'Give an address like localhost:9400/metrics (http or https, no user or password)',
          );
        }
        const server = await db
          .selectFrom('agent_instances')
          .select('node')
          .where('cluster_id', '=', cluster.id)
          .where('node', '=', body.server)
          .executeTakeFirst();
        if (!server) return sendProblem(reply, 400, `No server named ${body.server} in this fleet`);
        test = probes.startTest(cluster.id, {
          host: body.server,
          url,
          shown: url.replace(/^http:\/\//, ''),
        });
      } else {
        if (cluster.kind === 'server') {
          return sendProblem(reply, 400, "A workload's port is tested in a Kubernetes cluster");
        }
        // One running pod of the workload answers for all of them, as "Find endpoints" does.
        const pods = await db
          .selectFrom('objects')
          .select(['name', 'spec_summary', 'status_summary'])
          .where('cluster_id', '=', cluster.id)
          .where('kind', '=', 'Pod')
          .where('namespace', '=', body.namespace)
          .where('deleted_at', 'is', null)
          .orderBy('name')
          .execute();
        const pod = pods.find((p) => {
          const w = (p.spec_summary as { workload?: { kind?: string; name?: string } }).workload;
          const st = p.status_summary as { phase?: string; pod_ip?: string };
          return (
            (w?.name || p.name) === body.workload &&
            (w?.kind || 'Pod') === body.workloadKind &&
            st.phase === 'Running' &&
            !!st.pod_ip
          );
        });
        if (!pod) {
          return sendProblem(
            reply,
            400,
            `No running pod of ${body.namespace}/${body.workload} to read`,
          );
        }
        const raw = (pod.status_summary as { pod_ip: string }).pod_ip;
        const ip = raw.includes(':') ? `[${raw}]` : raw;
        const path = body.path ?? '/metrics';
        test = probes.startTest(cluster.id, {
          host: '',
          url: `http://${ip}:${body.port}${path}`,
          shown: `${body.namespace}/${body.workload} :${body.port}${path}`,
        });
      }
      notifier.notify(cluster.id);
      return reply.code(202).send(await testOf(cluster.org_id, test));
    },
  );

  app.get(
    '/clusters/:id/own-metrics/test',
    {
      preHandler: read,
      schema: {
        summary: 'What the test of an address found',
        tags: PANEL,
        params: Params,
        response: { 200: TestS, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const t = probes.currentTest(cluster.id);
      if (!t) return sendProblem(reply, 404, 'No test is running; start one');
      return testOf(cluster.org_id, t);
    },
  );

  // ------------------------------------------------------------- the first value of a token

  app.get(
    '/clusters/:id/own-metrics/tokens/:tokenId/received',
    {
      preHandler: read,
      schema: {
        summary: 'What a token has sent since a moment: the page waits on it for the first value',
        tags: PANEL,
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          tokenId: Type.String({ format: 'uuid' }),
        }),
        querystring: Type.Object({ since: Type.Optional(Type.Integer({ minimum: 0 })) }),
        response: { 200: ReceivedS, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const { tokenId } = request.params;
      const token = (await listMetricTokens(db, cluster.id)).find((t) => t.id === tokenId);
      if (!token) return sendProblem(reply, 404, 'Token not found');
      // What is in memory is newer than the rows: write it first.
      await own.flush();
      const since = new Date(request.query.since ?? 0);
      const rows = await db
        .selectFrom('own_series as s')
        .innerJoin('own_sources as src', 'src.id', 's.source_id')
        .innerJoin('own_metrics as m', 'm.id', 's.metric_id')
        .select([
          'm.id as metricId',
          'm.name',
          'src.kind',
          's.owner_kind',
          's.owner_namespace',
          's.owner_workload_kind',
          's.owner_name',
          's.last_seen',
        ])
        .where('s.cluster_id', '=', cluster.id)
        .where('src.key', 'in', [`token:${tokenId}:push`, `token:${tokenId}:remote_write`])
        .where('s.last_seen', '>=', since)
        .orderBy('s.last_seen', 'desc')
        .orderBy('m.name')
        .limit(2000)
        .execute();
      const first = rows[0];
      if (!first) return { now: now(), received: null };
      const last = own.lastPushed(tokenId);
      return {
        now: now(),
        received: {
          at: first.last_seen.getTime(),
          way: first.kind === 'push' ? ('push' as const) : ('remote_write' as const),
          metricId: first.metricId,
          name: first.name,
          owner: {
            kind: first.owner_kind as 'server',
            namespace: first.owner_namespace,
            workloadKind: first.owner_workload_kind,
            name: first.owner_name,
          },
          value: last && last.name === first.name ? last.value : null,
          series: rows.length,
          metrics: new Set(rows.map((r) => r.metricId)).size,
        },
      };
    },
  );

  // ------------------------------------------------------------- "Send a test value for me"

  app.post(
    '/clusters/:id/own-metrics/test-value',
    {
      preHandler: write,
      schema: {
        summary:
          'Send a test value for me: one value sent as a push of this token would be, without a terminal',
        tags: PANEL,
        params: Params,
        body: Type.Object({
          tokenId: Type.String({ format: 'uuid' }),
          server: Type.Optional(Type.String({ maxLength: 253 })),
          workload: Type.Optional(Type.String({ maxLength: 400 })),
        }),
        response: {
          200: TestValueS,
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
      const { tokenId, server, workload } = request.body;
      const token = (await listMetricTokens(db, cluster.id)).find((t) => t.id === tokenId);
      if (!token) return sendProblem(reply, 404, 'Token not found');
      const known = await belonging.known(cluster.id);
      const value = 1;
      try {
        // The same way in as a push with this token: its source, its caps, its owner.
        const result = await own.ingest({
          orgId: cluster.org_id,
          clusterId: cluster.id,
          source: {
            kind: 'push',
            key: `token:${tokenId}:push`,
            label: `token "${token.name}"`,
            owner: { kind: '', namespace: '', workloadKind: '', name: '' },
            tokenId,
          },
          series: [
            {
              name: TEST_METRIC,
              labels: {},
              samples: [[now(), value]],
              add: false,
              owner: belonging.fromPush(known, { workload, server }),
            },
          ],
          types: new Map(),
        });
        const stored = result.stored > 0;
        if (stored) own.notePushed(tokenId, TEST_METRIC, value);
        return {
          name: TEST_METRIC,
          value,
          stored,
          ...(stored
            ? {}
            : { refused: result.dropped.sources ? ('sources' as const) : ('series' as const) }),
        };
      } catch (err) {
        request.log.error({ err: (err as Error).message }, 'metrics storage unavailable');
        reply.header('retry-after', '30');
        return sendProblem(reply, 503, 'Metrics storage temporarily unavailable');
      }
    },
  );

  app.delete(
    '/clusters/:id/own-metrics/test-value',
    {
      preHandler: write,
      schema: {
        summary: 'Remove the test value: its metric leaves the list and its series no longer count',
        tags: PANEL,
        params: Params,
        response: { 204: Type.Null(), 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      // Memory first (it holds the series' rows), then the metric; its series go with it.
      await own.forget(cluster.id);
      await db
        .deleteFrom('own_metrics')
        .where('cluster_id', '=', cluster.id)
        .where('name', '=', TEST_METRIC)
        .execute();
      return reply.code(204).send(null);
    },
  );
};
