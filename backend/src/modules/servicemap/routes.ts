// SPDX-License-Identifier: AGPL-3.0-only
// Service map API (SPEC §4.5, Phase 4). With eBPF on at least one agent the map shows
// traffic; otherwise it falls back to "topology only": Services and the workloads
// behind them, from the cluster-agent's objects, clearly labelled (ADR-102).
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { Type } from 'typebox';
import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import type { QuerySeries, VictoriaQueryClient } from '../../lib/victoria.js';
import { requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { installTarget } from '../clusters/install.js';
import { findCluster } from '../clusters/service.js';
import type { SettingsService } from '../settings/service.js';
import { agentContainer, agentEbpf, type AgentCapabilities } from './ebpf-fix.js';
import { chooseStep, escapeLabelValue, anyOf } from '../query/catalog.js';
import {
  EDGE_LABELS,
  buildGraph,
  dnsRows,
  edgeMatchers,
  watchlogComponents,
  type MapEdge,
  type MapNode,
} from './graph.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import type { IntegrationTarget } from '../integrations/collector-config.js';
import { urlHost } from '../integrations/pages/traefik.js';
import { backendIndex, resolveTraefikService } from '../integrations/traefik-backends.js';
import { addProxies, type ProxyTarget } from './proxies.js';

export interface ServiceMapDeps {
  db: Database;
  victoria?: VictoriaQueryClient;
  config: Config;
  settings: SettingsService;
}

/** Edge rates are over the last 5 minutes, whatever range is selected. */
const RATE_WINDOW = '5m';
const MAX_RANGE_S = 7 * 86_400;

const Params = Type.Object({ id: Type.String({ format: 'uuid' }) });
const N = Type.Union([Type.Number(), Type.Null()]);
const NodeSchema = Type.Object({
  id: Type.String(),
  kind: Type.String(),
  name: Type.String(),
  namespace: Type.Union([Type.String(), Type.Null()]),
  workloadKind: Type.Union([Type.String(), Type.Null()]),
  /** WatchLog's own components (agents, backend, its databases): hidden by default. */
  watchlog: Type.Boolean(),
});
const EdgeSchema = Type.Object({
  id: Type.String(),
  source: Type.String(),
  target: Type.String(),
  port: N,
  service: Type.Union([Type.String(), Type.Null()]),
  connectionsPerSecond: Type.Number(),
  failedPerSecond: Type.Number(),
  failedRatio: N,
  latencyMeanSeconds: N,
  latencyP95Seconds: N,
  bytesSentPerSecond: N,
  bytesReceivedPerSecond: N,
  retransmitsPerSecond: Type.Number(),
  /** Failed connects in the last minute: health counts failures only while there are some (ADR-116). */
  failedLastMinute: Type.Optional(Type.Number()),
  /** HTTP/1.x on this edge (ADR-139): headers only, from a 16-byte peek; null when none. */
  http: Type.Union([
    Type.Object({
      requestsPerSecond: Type.Number(),
      clientErrorsPerSecond: Type.Number(),
      serverErrorsPerSecond: Type.Number(),
      serverErrorRatio: N,
      p50Seconds: N,
      p95Seconds: N,
      p99Seconds: N,
    }),
    Type.Null(),
  ]),
  /** Where `http` comes from on a proxy's edge (ADR-165): eBPF first, else Traefik's own. */
  httpSource: Type.Optional(
    Type.Union([Type.Literal('ebpf'), Type.Literal('traefik'), Type.Null()]),
  ),
  /** Requests the proxy answered itself on this edge, with no connection made (ADR-165). */
  answeredByProxy: Type.Optional(
    Type.Union([
      Type.Object({
        perSecond: Type.Number(),
        reason: Type.Literal('no_server_up'),
        proxy: Type.String(),
        shared: Type.Boolean(),
      }),
      Type.Null(),
    ]),
  ),
  health: Type.String(),
});
const ServiceMapSchema = Type.Object({
  /** flows: traffic from eBPF; topology: Services and their workloads only. */
  mode: Type.Union([Type.Literal('flows'), Type.Literal('topology')]),
  /** eBPF per agent; for agents without flows, why and the command that fixes it (ADR-107). */
  agents: Type.Array(
    Type.Object({
      node: Type.String(),
      ebpf: Type.String(),
      reason: Type.Union([Type.String(), Type.Null()]),
      cause: Type.Union([
        Type.Literal('config'),
        Type.Literal('kernel'),
        Type.Literal('permission'),
        Type.Literal('load'),
        Type.Literal('outdated'),
        Type.Null(),
      ]),
      fix: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
  nodes: Type.Array(NodeSchema),
  edges: Type.Array(EdgeSchema),
  /**
   * DNS outcomes per source over the last 5 minutes (header rcodes and timeouts).
   * Search-path misses (ADR-113) are not lookups or errors; they have their own rate.
   */
  dns: Type.Array(
    Type.Object({
      node: Type.String(),
      requestsPerSecond: Type.Number(),
      nxdomainPerSecond: Type.Number(),
      servfailPerSecond: Type.Number(),
      timeoutPerSecond: Type.Number(),
      searchMissPerSecond: Type.Number(),
      errorRatio: Type.Number(),
    }),
  ),
  /**
   * Proxies with their own metrics (Traefik, ADR-165): requests per entrypoint, TLS
   * included, and the requests they answered themselves (no server up).
   */
  proxies: Type.Array(
    Type.Object({
      node: Type.String(),
      integrationId: Type.String(),
      entrypoints: Type.Array(
        Type.Object({
          name: Type.String(),
          requestsPerSecond: Type.Number(),
          serverErrorsPerSecond: Type.Number(),
          tlsRequestsPerSecond: Type.Number(),
        }),
      ),
      answeredPerSecond: Type.Number(),
    }),
  ),
});
const EdgeSeriesSchema = Type.Object({
  step: Type.Integer(),
  connections: Type.Array(Type.Array(N)),
  failed: Type.Array(Type.Array(N)),
  latencyP95: Type.Array(Type.Array(N)),
  bytesSent: Type.Array(Type.Array(N)),
  bytesReceived: Type.Array(Type.Array(N)),
  /** HTTP/1.x (ADR-139): requests/s, 4xx/s and 5xx/s, p50 and p95; empty without HTTP. */
  httpRequests: Type.Array(Type.Array(N)),
  http4xx: Type.Array(Type.Array(N)),
  http5xx: Type.Array(Type.Array(N)),
  httpP50: Type.Array(Type.Array(N)),
  httpP95: Type.Array(Type.Array(N)),
  /** What explains the edge's health: the target's ready pods and the related alert. */
  context: Type.Object({
    target: Type.Union([
      Type.Object({
        ready: Type.Integer(),
        desired: Type.Integer(),
        /** When the target's status last changed. */
        changedAt: Type.String({ format: 'date-time' }),
      }),
      Type.Null(),
    ]),
    alert: Type.Union([
      Type.Object({ id: Type.String(), since: Type.String({ format: 'date-time' }) }),
      Type.Null(),
    ]),
  }),
});

export const serviceMapRoutes: FastifyPluginAsyncTypebox<ServiceMapDeps> = async (
  app,
  { db, victoria, config, settings },
) => {
  const signedIn = requireUser(db);
  const install = installTarget(config, settings);

  async function agentStates(clusterId: string, request: FastifyRequest) {
    const rows = await db
      .selectFrom('agent_instances')
      .select(['node', 'mode', 'capabilities'])
      .where('cluster_id', '=', clusterId)
      .where('mode', 'in', ['node', 'docker'])
      .orderBy('node')
      .execute();
    const docker = {
      endpoint: await install.endpointFor(request),
      image: install.image,
      version: install.version,
    };
    const containers = rows.some((r) => r.mode === 'docker')
      ? await db
          .selectFrom('objects')
          .select(['node', 'uid', 'name', sql<string>`spec_summary->>'image'`.as('image')])
          .where('cluster_id', '=', clusterId)
          .where('source', '=', 'docker')
          .where('kind', '=', 'DockerContainer')
          .where('deleted_at', 'is', null)
          .execute()
      : [];
    return rows.map((r) => {
      const caps = (r.capabilities ?? {}) as AgentCapabilities;
      const name =
        r.mode === 'docker'
          ? agentContainer(
              containers.filter((c) => c.node === r.node),
              caps.container_id,
            )
          : undefined;
      return agentEbpf(r.node, r.mode, caps, { ...docker, name });
    });
  }

  /** The target's ready pods and the firing failed-connections alert of an edge. */
  async function edgeContext(clusterId: string, target: string, m: Record<string, string>) {
    let ready: { ready: number; desired: number; changedAt: string } | null = null;
    if (target.startsWith('w:')) {
      const [ns, kind, ...name] = target.slice(2).split('/');
      const row = await db
        .selectFrom('objects')
        .select(['spec_summary', 'status_summary', 'updated_at'])
        .where('cluster_id', '=', clusterId)
        .where('source', '=', 'kubernetes')
        .where('namespace', '=', ns ?? '')
        .where('kind', '=', kind ?? '')
        .where('name', '=', name.join('/'))
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (row) {
        const spec = (row.spec_summary ?? {}) as { replicas?: number };
        const st = (row.status_summary ?? {}) as {
          ready?: number;
          desired?: number;
          number_ready?: number;
          desired_number_scheduled?: number;
        };
        ready = {
          ready: st.ready ?? st.number_ready ?? 0,
          desired: spec.replicas ?? st.desired ?? st.desired_number_scheduled ?? 0,
          changedAt: new Date(row.updated_at).toISOString(),
        };
      }
    }
    // The rule's labels are the edge's, without the port.
    const labels = Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'dst_port'));
    const alert = await db
      .selectFrom('alert_states')
      .innerJoin('alert_rules', 'alert_rules.id', 'alert_states.rule_id')
      .select(['alert_states.id', 'alert_states.fired_at', 'alert_states.started_at'])
      .where('alert_states.cluster_id', '=', clusterId)
      .where('alert_states.state', '=', 'firing')
      .where('alert_rules.rule_key', '=', 'network.connections.failed')
      .where(sql<boolean>`alert_states.labels @> ${JSON.stringify(labels)}::jsonb`)
      .orderBy('alert_states.started_at', 'desc')
      .executeTakeFirst();
    return {
      target: ready,
      alert: alert
        ? { id: alert.id, since: new Date(alert.fired_at ?? alert.started_at).toISOString() }
        : null,
    };
  }

  /** Marks WatchLog's own workloads and containers among the map's nodes. */
  async function markComponents<T extends { nodes: MapNode[] }>(clusterId: string, graph: T) {
    const rows = await db
      .selectFrom('objects')
      .select(['kind', 'namespace', 'name', 'node', 'spec_summary'])
      .where('cluster_id', '=', clusterId)
      .where('deleted_at', 'is', null)
      .where('kind', 'in', ['Deployment', 'StatefulSet', 'DaemonSet', 'DockerContainer'])
      .execute();
    const own = watchlogComponents(
      rows.map((r) => {
        const spec = (r.spec_summary ?? {}) as {
          image?: string;
          containers?: { image?: string }[];
        };
        const docker = r.kind === 'DockerContainer';
        return {
          id: docker ? `c:${r.name}` : `w:${r.namespace}/${r.kind}/${r.name}`,
          group: docker ? r.node : r.namespace,
          name: r.name,
          images: docker ? [spec.image ?? ''] : (spec.containers ?? []).map((c) => c.image ?? ''),
        };
      }),
    );
    return { ...graph, nodes: graph.nodes.map((n) => ({ ...n, watchlog: own.has(n.id) })) };
  }

  /**
   * Docker without eBPF: the user-defined networks (Compose networks) and the running
   * containers on them, as Kubernetes topology draws Services and their workloads.
   */
  async function dockerTopology(clusterId: string) {
    const rows = await db
      .selectFrom('objects')
      .select(['node', 'name', 'namespace', 'spec_summary', 'status_summary'])
      .where('cluster_id', '=', clusterId)
      .where('kind', '=', 'DockerContainer')
      .where('deleted_at', 'is', null)
      .execute();
    const nodes = new Map<string, MapNode>();
    const edges: MapEdge[] = [];
    for (const r of rows) {
      const spec = r.spec_summary as { networks?: string[]; compose_service?: string };
      if ((r.status_summary as { state?: string }).state !== 'running') continue;
      const c: MapNode = {
        id: `c:${r.name}`,
        kind: 'container',
        name: spec.compose_service || r.name,
        namespace: r.namespace || null,
        workloadKind: null,
      };
      nodes.set(c.id, c);
      for (const net of spec.networks ?? []) {
        // Compose names its networks <project>_<name>.
        const project = r.namespace && net.startsWith(`${r.namespace}_`) ? r.namespace : null;
        const n: MapNode = {
          id: `s:${r.node}/${net}`,
          kind: 'service',
          name: net,
          namespace: project,
          workloadKind: null,
        };
        nodes.set(n.id, n);
        edges.push({
          id: `${n.id}>${c.id}:`,
          source: n.id,
          target: c.id,
          port: null,
          service: net,
          connectionsPerSecond: 0,
          failedPerSecond: 0,
          failedRatio: null,
          latencyMeanSeconds: null,
          latencyP95Seconds: null,
          bytesSentPerSecond: null,
          bytesReceivedPerSecond: null,
          retransmitsPerSecond: 0,
          http: null,
          health: 'unknown',
        });
      }
    }
    return { nodes: [...nodes.values()], edges };
  }

  async function topology(clusterId: string, namespaces?: string[]) {
    let q = db
      .selectFrom('objects')
      .select(['namespace', 'name', 'status_summary'])
      .where('cluster_id', '=', clusterId)
      .where('kind', '=', 'Service')
      .where('deleted_at', 'is', null);
    if (namespaces) q = q.where('namespace', 'in', namespaces);
    const nodes = new Map<string, MapNode>();
    const edges: MapEdge[] = [];
    for (const s of await q.execute()) {
      const ws =
        (s.status_summary as { workloads?: { kind: string; name: string }[] }).workloads ?? [];
      if (!ws.length) continue;
      const svc: MapNode = {
        id: `s:${s.namespace}/${s.name}`,
        kind: 'service',
        name: s.name,
        namespace: s.namespace,
        workloadKind: null,
      };
      nodes.set(svc.id, svc);
      for (const w of ws) {
        const wn: MapNode = {
          id: `w:${s.namespace}/${w.kind}/${w.name}`,
          kind: 'workload',
          name: w.name,
          namespace: s.namespace,
          workloadKind: w.kind,
        };
        nodes.set(wn.id, wn);
        edges.push({
          id: `${svc.id}>${wn.id}:`,
          source: svc.id,
          target: wn.id,
          port: null,
          service: s.name,
          connectionsPerSecond: 0,
          failedPerSecond: 0,
          failedRatio: null,
          latencyMeanSeconds: null,
          latencyP95Seconds: null,
          bytesSentPerSecond: null,
          bytesReceivedPerSecond: null,
          retransmitsPerSecond: 0,
          http: null,
          health: 'unknown',
        });
      }
    }
    return { nodes: [...nodes.values()], edges };
  }

  /** The cluster's Traefik integrations and their nodes on the map (ADR-165). */
  async function proxyTargets(clusterId: string): Promise<ProxyTarget[]> {
    const rows = await db
      .selectFrom('integrations')
      .select(['id', 'target'])
      .where('cluster_id', '=', clusterId)
      .where('type', '=', 'traefik')
      .execute();
    if (!rows.length) return [];
    const docker = rows.some((r) => (r.target as IntegrationTarget).kind === 'compose');
    const containers = docker
      ? await db
          .selectFrom('objects')
          .select(['node', 'namespace', 'name', 'spec_summary', 'status_summary'])
          .where('cluster_id', '=', clusterId)
          .where('kind', '=', 'DockerContainer')
          .where('deleted_at', 'is', null)
          .orderBy('name')
          .execute()
      : [];
    const out: ProxyTarget[] = [];
    for (const r of rows) {
      const t = r.target as IntegrationTarget;
      if (t.kind === 'workload') {
        out.push({
          integrationId: r.id,
          node: {
            id: `w:${t.namespace}/${t.workload_kind}/${t.workload}`,
            kind: 'workload',
            name: t.workload,
            namespace: t.namespace,
            workloadKind: t.workload_kind,
          },
        });
      } else if (t.kind === 'container') {
        out.push({
          integrationId: r.id,
          node: {
            id: `c:${t.container}`,
            kind: 'container',
            name: t.container,
            namespace: null,
            workloadKind: null,
          },
        });
      } else if (t.kind === 'compose') {
        // The service's first running container (a Compose Traefik has one).
        const c = containers.find(
          (x) =>
            x.node === t.host &&
            x.namespace === t.compose_project &&
            (x.spec_summary as { compose_service?: string }).compose_service ===
              t.compose_service &&
            (x.status_summary as { state?: string }).state === 'running',
        );
        if (c) {
          out.push({
            integrationId: r.id,
            node: {
              id: `c:${c.name}`,
              kind: 'container',
              name: t.compose_service,
              namespace: t.compose_project,
              workloadKind: null,
            },
          });
        }
      }
    }
    return out;
  }

  app.get(
    '/clusters/:id/service-map',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Service map: workloads and the TCP connections between them (SPEC §4.5)',
        tags: ['service map', PUBLIC_TAG],
        params: Params,
        querystring: Type.Object({
          namespaces: Type.Optional(
            Type.String({ maxLength: 4096, pattern: '^[a-z0-9]([-a-z0-9,]*[a-z0-9])?$' }),
          ),
          /** Seconds: edges with any connection in this range are shown. */
          range: Type.Optional(Type.Integer({ minimum: 300, maximum: MAX_RANGE_S })),
        }),
        response: {
          200: ServiceMapSchema,
          401: ProblemSchema,
          404: ProblemSchema,
          502: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await findCluster(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const namespaces = request.query.namespaces?.split(',').filter(Boolean).slice(0, 50);
      const agents = await agentStates(cluster.id, request);
      if (!victoria || !agents.some((a) => a.ebpf === 'enabled')) {
        return {
          mode: 'topology' as const,
          agents,
          dns: [],
          proxies: [],
          ...(await markComponents(
            cluster.id,
            cluster.kind === 'docker'
              ? await dockerTopology(cluster.id)
              : await topology(cluster.id, namespaces),
          )),
        };
      }
      const ns = namespaces?.length ? anyOf(namespaces) : undefined;
      // An edge is shown when its source or its destination is in the selected
      // namespaces (ADR-106 as accepted); `or` keeps one copy of an edge inside both.
      const flow = (fn: string, metric: string, window: string) =>
        ns
          ? `(${fn}(${metric}{namespace=~"${ns}"}[${window}]) or ${fn}(${metric}{dst_namespace=~"${ns}"}[${window}]))`
          : `(${fn}(${metric}[${window}]))`;
      const by = EDGE_LABELS.join(', ');
      const range = request.query.range ?? 3600;
      const exprs = [
        // Seen in the range: new connections, or bytes on connections opened earlier
        // (keep-alive, adopted after an agent restart, ADR-108).
        `(sum by (${by}) ${flow('increase', 'watchlog_flow_connections_total', `${range}s`)} > 0) or (sum by (${by}) ${flow('increase', 'watchlog_flow_bytes_total', `${range}s`)} > 0)`,
        `sum by (${by}) ${flow('rate', 'watchlog_flow_connections_total', RATE_WINDOW)}`,
        `sum by (${by}) ${flow('rate', 'watchlog_flow_connect_failed_total', RATE_WINDOW)}`,
        `sum by (${by}) ${flow('rate', 'watchlog_flow_connect_latency_seconds_sum', RATE_WINDOW)}`,
        `sum by (${by}) ${flow('rate', 'watchlog_flow_connect_latency_seconds_count', RATE_WINDOW)}`,
        `histogram_quantile(0.95, sum by (${by}, le) ${flow('rate', 'watchlog_flow_connect_latency_seconds_bucket', RATE_WINDOW)})`,
        `sum by (${by}, dir) ${flow('rate', 'watchlog_flow_bytes_total', RATE_WINDOW)}`,
        `sum by (${by}) ${flow('rate', 'watchlog_flow_retransmits_total', RATE_WINDOW)}`,
        // Failures now, for health (ADR-116); the failed share stays over 5 minutes.
        `sum by (${by}) ${flow('increase', 'watchlog_flow_connect_failed_total', '1m')}`,
        // HTTP/1.x per edge (ADR-139): by status class, and latency quantiles.
        `sum by (${by}, class) ${flow('rate', 'watchlog_http_requests_total', RATE_WINDOW)}`,
        ...[0.5, 0.95, 0.99].map(
          (q) =>
            `histogram_quantile(${q}, sum by (${by}, le) ${flow('rate', 'watchlog_http_request_duration_seconds_bucket', RATE_WINDOW)})`,
        ),
        // DNS errors belong to the workload that looked up.
        `sum by (namespace, workload_kind, workload, container, compose_project, compose_service, rcode) (rate(watchlog_dns_requests_total${ns ? `{namespace=~"${ns}"}` : ''}[${RATE_WINDOW}]))`,
      ];
      // Traefik's own metrics (ADR-165), only for clusters that monitor a Traefik.
      const targets = await proxyTargets(cluster.id);
      const px = targets.length ? `{service=~"${anyOf(targets.map((t) => t.integrationId))}"}` : '';
      const proxyExprs = targets.length
        ? [
            `sum by (service, traefik_service, code) (rate(traefik_service_requests_total${px}[${RATE_WINDOW}]))`,
            ...[0.5, 0.95, 0.99].map(
              (q) =>
                `histogram_quantile(${q}, sum by (service, traefik_service, le) (rate(traefik_service_request_duration_seconds_bucket${px}[${RATE_WINDOW}])))`,
            ),
            `sum by (service, entrypoint, code) (rate(traefik_entrypoint_requests_total${px}[${RATE_WINDOW}]))`,
            `sum by (service, entrypoint) (rate(traefik_entrypoint_requests_tls_total${px}[${RATE_WINDOW}]))`,
            `sum by (service, traefik_service) (increase(traefik_service_requests_total${px}[1h])) > 0`,
            `max by (service, traefik_service) (traefik_service_server_up${px})`,
            // Server addresses, to tell a label-named Docker service's container apart.
            `max by (traefik_service, url) (traefik_service_server_up${px})`,
          ]
        : [];
      let r: QuerySeries[][];
      let pr: QuerySeries[][];
      try {
        [r, pr] = await Promise.all([
          Promise.all(exprs.map((e) => victoria.query({ clusterId: cluster.id }, e))),
          Promise.all(proxyExprs.map((e) => victoria.query({ clusterId: cluster.id }, e))),
        ]);
      } catch (err) {
        request.log.warn({ err: (err as Error).message }, 'service map query failed');
        return sendProblem(reply, 502, 'Metrics could not be queried');
      }
      const [
        seen,
        connections,
        failed,
        latencySum,
        latencyCount,
        latencyP95,
        bytes,
        retransmits,
        failedLastMinute,
        httpByClass,
        httpP50,
        httpP95,
        httpP99,
        dns,
      ] = r.map((x) => x ?? []);
      const graph = buildGraph({
        seen: seen!,
        connections: connections!,
        failed: failed!,
        latencySum: latencySum!,
        latencyCount: latencyCount!,
        latencyP95: latencyP95!,
        bytes: bytes!,
        retransmits: retransmits!,
        failedLastMinute: failedLastMinute!,
        http: { byClass: httpByClass!, p50: httpP50!, p95: httpP95!, p99: httpP99! },
      });
      let withProxies: ReturnType<typeof addProxies> = { ...graph, proxies: [] };
      if (targets.length) {
        const [
          serviceByCode,
          p50,
          p95,
          p99,
          entrypointByCode,
          entrypointTls,
          seenTraefik,
          serverUp,
          serverUrls,
        ] = pr.map((x) => x ?? []);
        const idx = await backendIndex(db, cluster.id);
        const ipsOf = new Map<string, string[]>();
        for (const x of serverUrls!) {
          const n = x.labels.traefik_service ?? '';
          const ip = urlHost(x.labels.url ?? '');
          if (ip) ipsOf.set(n, [...(ipsOf.get(n) ?? []), ip]);
        }
        const projects = targets.map((t) =>
          t.node.kind === 'container' ? t.node.namespace : null,
        );
        withProxies = addProxies(
          graph,
          targets,
          {
            serviceByCode: serviceByCode!,
            p50: p50!,
            p95: p95!,
            p99: p99!,
            entrypointByCode: entrypointByCode!,
            entrypointTls: entrypointTls!,
            seen: seenTraefik!,
            serverUp: serverUp!,
          },
          (name) => resolveTraefikService(name, idx, { ips: ipsOf.get(name), projects }),
          namespaces,
        );
      }
      const { proxies, ...nodesAndEdges } = withProxies;
      return {
        mode: 'flows' as const,
        agents,
        ...(await markComponents(cluster.id, nodesAndEdges)),
        dns: dnsRows(dns!),
        proxies,
      };
    },
  );

  app.get(
    '/clusters/:id/service-map/edge',
    {
      preHandler: signedIn,
      schema: {
        summary:
          "One edge's time series: connections, failures, p95 connect latency, bytes, HTTP requests, errors and latency",
        tags: ['service map', PUBLIC_TAG],
        params: Params,
        querystring: Type.Object({
          source: Type.String({ minLength: 3, maxLength: 600 }),
          target: Type.String({ minLength: 3, maxLength: 600 }),
          port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
          range: Type.Optional(Type.Integer({ minimum: 300, maximum: MAX_RANGE_S })),
        }),
        response: {
          200: EdgeSeriesSchema,
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
          502: ProblemSchema,
          503: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await findCluster(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const q = request.query;
      const m = edgeMatchers(q.source, q.target, q.port ?? null);
      if (!m) return sendProblem(reply, 400, 'Unknown edge');
      if (!victoria) return sendProblem(reply, 503, 'Metrics are not available');
      const range = q.range ?? 3600;
      const end = Math.floor(Date.now() / 1000);
      const step = chooseStep(range);
      const win = `${Math.max(60, 2 * step)}s`;
      const s = `{${Object.entries(m)
        .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
        .join(',')}}`;
      const run = (e: string) =>
        victoria
          .queryRange({ clusterId: cluster.id }, e, end - range, end, step)
          .then((r) => r[0]?.points ?? []);
      try {
        const httpRate = (cls?: string) =>
          `sum(rate(watchlog_http_requests_total${cls ? s.replace('}', `,class="${cls}"}`) : s}[${win}]))`;
        const httpQ = (q: number) =>
          `histogram_quantile(${q}, sum by (le) (rate(watchlog_http_request_duration_seconds_bucket${s}[${win}])))`;
        const [
          connections,
          failed,
          latencyP95,
          bytesSent,
          bytesReceived,
          httpRequests,
          http4xx,
          http5xx,
          httpP50,
          httpP95,
        ] = await Promise.all([
          run(`sum(rate(watchlog_flow_connections_total${s}[${win}]))`),
          run(`sum(rate(watchlog_flow_connect_failed_total${s}[${win}]))`),
          run(
            `histogram_quantile(0.95, sum by (le) (rate(watchlog_flow_connect_latency_seconds_bucket${s}[${win}])))`,
          ),
          run(`sum(rate(watchlog_flow_bytes_total${s.replace('}', ',dir="sent"}')}[${win}]))`),
          run(`sum(rate(watchlog_flow_bytes_total${s.replace('}', ',dir="received"}')}[${win}]))`),
          run(httpRate()),
          run(httpRate('4xx')),
          run(httpRate('5xx')),
          run(httpQ(0.5)),
          run(httpQ(0.95)),
        ]);
        return {
          step,
          connections,
          failed,
          latencyP95,
          bytesSent,
          bytesReceived,
          httpRequests,
          http4xx,
          http5xx,
          httpP50,
          httpP95,
          context: await edgeContext(cluster.id, q.target, m),
        };
      } catch (err) {
        request.log.warn({ err: (err as Error).message }, 'service map edge query failed');
        return sendProblem(reply, 502, 'Metrics could not be queried');
      }
    },
  );
};
