// SPDX-License-Identifier: AGPL-3.0-only
// Server fleets (ADR-207): the servers, one server with its workloads, and one workload
// (a systemd service, a process group or a container). Read-only and bounded: every query
// is scoped to the cluster, and to the server where one is named.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import type { ClusterScope, QuerySeries, VictoriaQueryClient } from '../../lib/victoria.js';
import { requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { CLUSTER_STALE_MS, clusterForOrg } from '../clusters/service.js';
import { firingAlerts } from '../overview/problems.js';
import { buildQuery, escapeLabelValue } from '../query/catalog.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import {
  CRASH_LOOP,
  assembleWorkloads,
  parseWorkloadId,
  type ContainerRow,
  type Workload,
  type WorkloadSeries,
} from './workloads.js';

const N = Type.Union([Type.Number(), Type.Null()]);
const S = Type.Union([Type.String(), Type.Null()]);
const Params = Type.Object({ id: Type.String({ format: 'uuid' }) });
const ServerParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  server: Type.String({ minLength: 1, maxLength: 253 }),
});

const ProblemS = Type.Union([
  Type.Object({
    kind: Type.Union([
      Type.Literal('failed'),
      Type.Literal('crash_looping'),
      Type.Literal('oom_killed'),
      Type.Literal('unhealthy'),
      Type.Literal('exited'),
      Type.Literal('restarting'),
    ]),
    severity: Type.Union([Type.Literal('critical'), Type.Literal('warning')]),
    code: N,
  }),
  Type.Null(),
]);

const WorkloadS = Type.Object({
  id: Type.String({ description: '`service:<unit>`, `process:<group>` or `container:<name>`' }),
  source: Type.Union([Type.Literal('service'), Type.Literal('process'), Type.Literal('container')]),
  name: Type.String(),
  unit: S,
  note: S,
  state: Type.String(),
  problem: ProblemS,
  cpuCores: N,
  memoryBytes: N,
  memoryLimitBytes: N,
  instances: N,
  ports: Type.Array(Type.Integer()),
  restarts24h: N,
  lastExitCode: N,
  system: Type.Boolean(),
});

const ServerS = Type.Object({
  name: Type.String(),
  status: Type.Union([Type.Literal('active'), Type.Literal('inactive')]),
  lastSeenAt: S,
  agentVersion: S,
  /** Services and process groups need the 0.9 agent; an older one sends containers only. */
  servicesAvailable: Type.Boolean(),
  os: S,
  kernel: S,
  systemd: S,
  docker: S,
  cores: N,
  memoryBytes: N,
  bootTime: N,
  cpuUtilization: N,
  memoryUtilization: N,
  diskUtilization: N,
  workloads: Type.Object({
    services: Type.Integer(),
    processes: Type.Integer(),
    containers: Type.Integer(),
  }),
  /** Its workloads with a problem, worst first (at most 3). */
  problems: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      source: Type.String(),
      kind: Type.String(),
      severity: Type.String(),
    }),
  ),
  /** How many of its workloads have a problem. */
  problemCount: Type.Integer(),
});

const EdgeS = Type.Object({
  /** The workload on this server that opens the connections. */
  from: Type.String(),
  fromKind: S,
  /** Where to: a workload, a service or an address; with its port. */
  to: Type.String(),
  toKind: Type.String(),
  port: N,
  /** New connections per second. */
  rate: Type.Number(),
  /** Failed connects per second. */
  failed: Type.Number(),
});

type Server = Static<typeof ServerS>;

const WINDOW_24H = '24h';

export const serverRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  victoria?: VictoriaQueryClient;
}> = async (app, { db, victoria }) => {
  const signedIn = requireUser();

  /** Instant queries; a null expression (not for this source) and storage errors give []. */
  async function instant(scope: ClusterScope, exprs: (string | null)[]): Promise<QuerySeries[][]> {
    return Promise.all(
      exprs.map((e) =>
        !victoria || e === null
          ? Promise.resolve([] as QuerySeries[])
          : victoria.query(scope, e).catch((err: Error) => {
              app.log.warn({ err: err.message }, 'instant query failed');
              return [] as QuerySeries[];
            }),
      ),
    );
  }

  async function ranged(
    scope: ClusterScope,
    exprs: string[],
    start: number,
    end: number,
    step: number,
  ): Promise<QuerySeries[][]> {
    if (!victoria) return exprs.map(() => []);
    return Promise.all(
      exprs.map((e) =>
        victoria.queryRange(scope, e, start, end, step).catch((err: Error) => {
          app.log.warn({ err: err.message }, 'range query failed');
          return [] as QuerySeries[];
        }),
      ),
    );
  }

  /** Every workload of the fleet, or of one server. */
  async function workloads(
    clusterId: string,
    scope: ClusterScope,
    server?: string,
  ): Promise<Map<string, Workload[]>> {
    const sc = server ? { host: server } : {};
    const sel = (...extra: string[]) =>
      `{${[...extra, ...(server ? [`host="${escapeLabelValue(server)}"`] : [])].join(',')}}`;
    const q = (k: Parameters<typeof buildQuery>[0]) => buildQuery(k, sc, 60).expr;
    const results = await instant(scope, [
      `max by (host, unit, state, sub) (last_over_time(watchlog_service_state${sel()}[2m]))`,
      q('unit.cpu.usage'),
      q('unit.memory.working_set'),
      q('unit.memory.limit'),
      q('unit.restarts.increase'),
      `max by (host, unit) (increase(watchlog_service_restarts_total${sel()}[${WINDOW_24H}]))`,
      q('unit.exits.failed.increase'),
      q('unit.oom_kills.increase'),
      `max by (host, unit) (last_over_time(watchlog_service_last_exit_code${sel()}[2m]))`,
      `max by (host, unit, group, by) (last_over_time(watchlog_process_group_instances${sel()}[2m]))`,
      `sum by (host, group) (rate(watchlog_process_group_cpu_seconds_total${sel()}[2m]))`,
      `sum by (host, group) (last_over_time(watchlog_process_group_memory_rss_bytes${sel()}[2m]))`,
      `sum by (host, group) (increase(watchlog_process_group_exits_total${sel('exit=~"error|signal"')}[10m]))`,
      `sum by (host, group) (increase(watchlog_process_group_exits_total${sel('exit=~"error|signal"')}[${WINDOW_24H}]))`,
      `sum by (host, group) (increase(watchlog_process_group_oom_kills_total${sel()}[10m]))`,
      `max by (host, source, workload, port) (last_over_time(watchlog_listen_info${sel()}[2m]))`,
      q('container.cpu.usage'),
      `max by (host, container) (increase(watchlog_container_restarts_total${sel()}[${WINDOW_24H}]))`,
      q('container.memory.working_set'),
      q('container.memory.limit'),
    ]);
    const [
      serviceState,
      serviceCpu,
      serviceMemory,
      serviceMemoryLimit,
      serviceRestarts10m,
      serviceRestarts24h,
      serviceFailedExits10m,
      serviceOom10m,
      serviceLastExit,
      groupInstances,
      groupCpu,
      groupMemory,
      groupFailedExits10m,
      groupFailedExits24h,
      groupOom10m,
      listen,
      containerCpu,
      containerRestarts24h,
      cMem,
      cLimit,
    ] = results as QuerySeries[][];
    const series: WorkloadSeries = {
      serviceState: serviceState!,
      serviceCpu: serviceCpu!,
      serviceMemory: serviceMemory!,
      serviceMemoryLimit: serviceMemoryLimit!,
      serviceRestarts10m: serviceRestarts10m!,
      serviceRestarts24h: serviceRestarts24h!,
      serviceFailedExits10m: serviceFailedExits10m!,
      serviceOom10m: serviceOom10m!,
      serviceLastExit: serviceLastExit!,
      groupInstances: groupInstances!,
      groupCpu: groupCpu!,
      groupMemory: groupMemory!,
      groupFailedExits10m: groupFailedExits10m!,
      groupFailedExits24h: groupFailedExits24h!,
      groupOom10m: groupOom10m!,
      listen: listen!,
      containerCpu: containerCpu!,
      containerRestarts24h: containerRestarts24h!,
    };
    const memBy = new Map(cMem!.map((s) => [`${s.labels.host}\u0000${s.labels.container}`, s]));
    const limBy = new Map(cLimit!.map((s) => [`${s.labels.host}\u0000${s.labels.container}`, s]));
    let rows = db
      .selectFrom('objects')
      .select(['node', 'name', 'namespace', 'status_summary', 'spec_summary'])
      .where('cluster_id', '=', clusterId)
      .where('kind', '=', 'DockerContainer')
      .where('deleted_at', 'is', null);
    if (server) rows = rows.where('node', '=', server);
    const containers: ContainerRow[] = (await rows.execute()).map((r) => {
      const k = `${r.node}\u0000${r.name}`;
      const spec = (r.spec_summary ?? {}) as {
        ports?: { public_port: number; private_port: number }[];
      };
      return {
        node: r.node,
        name: r.name,
        status: (r.status_summary ?? {}) as ContainerRow['status'],
        memoryBytes: memBy.get(k)?.points[0]?.[1] ?? null,
        memoryLimitBytes: limBy.get(k)?.points[0]?.[1] ?? null,
        ports: [...new Set((spec.ports ?? []).map((p) => p.public_port || p.private_port))].filter(
          (p) => p > 0,
        ),
        compose: r.namespace && r.namespace !== 'default' ? r.namespace : null,
      };
    });
    return assembleWorkloads(series, containers);
  }

  /** The servers of a fleet with their header facts and usage. */
  async function servers(
    cluster: { id: string; scope: ClusterScope },
    byServer: Map<string, Workload[]>,
    only?: string,
  ): Promise<Server[]> {
    const sc = only ? { host: only } : {};
    const sel = only ? `{host="${escapeLabelValue(only)}"}` : '';
    let agentsQ = db.selectFrom('agent_instances').selectAll().where('cluster_id', '=', cluster.id);
    let hostsQ = db
      .selectFrom('objects')
      .select(['node', 'spec_summary'])
      .where('cluster_id', '=', cluster.id)
      .where('kind', '=', 'DockerHost')
      .where('deleted_at', 'is', null);
    if (only) {
      agentsQ = agentsQ.where('node', '=', only);
      hostsQ = hostsQ.where('node', '=', only);
    }
    const [agents, hostObjects, [cpu, mem, disk, cores, memTotal, boot, info]] = await Promise.all([
      agentsQ.execute(),
      hostsQ.execute(),
      instant(cluster.scope, [
        buildQuery('host.cpu.utilization', sc, 60).expr,
        buildQuery('host.memory.utilization', sc, 60).expr,
        buildQuery('host.root_filesystem.utilization', sc, 60).expr,
        `max by (host) (watchlog_node_cpu_count${sel})`,
        `sum by (host) (watchlog_node_memory_bytes{${[only ? `host="${escapeLabelValue(only)}"` : '', 'state="total"'].filter(Boolean).join(',')}})`,
        `max by (host) (watchlog_node_boot_time_seconds${sel})`,
        `max by (host, os, kernel, systemd) (last_over_time(watchlog_server_info${sel}[10m]))`,
      ]),
    ]);
    const by = (r: QuerySeries[] | undefined) =>
      new Map((r ?? []).map((s) => [s.labels.host ?? '', s.points[0]?.[1] ?? null] as const));
    const cpuBy = by(cpu);
    const memBy = by(mem);
    const diskBy = by(disk);
    const coresBy = by(cores);
    const totalBy = by(memTotal);
    const bootBy = by(boot);
    const infoBy = new Map((info ?? []).map((s) => [s.labels.host ?? '', s.labels] as const));
    const now = Date.now();
    const names = new Set<string>([
      ...agents.filter((a) => a.mode === 'docker').map((a) => a.node),
      ...hostObjects.map((h) => h.node).filter((n): n is string => !!n),
      ...infoBy.keys(),
      ...byServer.keys(),
    ]);
    names.delete('');
    if (only) for (const n of [...names]) if (n !== only) names.delete(n);
    return [...names].map((name) => {
      const agent = agents.find((a) => a.node === name);
      const host = hostObjects.find((h) => h.node === name)?.spec_summary as
        Record<string, string> | undefined;
      const inf = infoBy.get(name);
      const list = byServer.get(name) ?? [];
      const problems = list.filter((w) => w.problem);
      const lastSeen = agent?.last_seen_at ?? null;
      return {
        name,
        status:
          lastSeen && now - lastSeen.getTime() <= CLUSTER_STALE_MS
            ? ('active' as const)
            : ('inactive' as const),
        lastSeenAt: lastSeen?.toISOString() ?? null,
        agentVersion: agent?.agent_version ?? null,
        servicesAvailable: !!inf,
        os: inf?.os || host?.os || null,
        kernel: inf?.kernel || host?.kernel_version || null,
        systemd: inf?.systemd || null,
        docker: host?.docker_version ?? null,
        cores: coresBy.get(name) ?? null,
        memoryBytes: totalBy.get(name) ?? null,
        bootTime: bootBy.get(name) ?? null,
        cpuUtilization: cpuBy.get(name) ?? null,
        memoryUtilization: memBy.get(name) ?? null,
        diskUtilization: diskBy.get(name) ?? null,
        workloads: {
          services: list.filter((w) => w.source === 'service').length,
          processes: list.filter((w) => w.source === 'process').length,
          containers: list.filter((w) => w.source === 'container').length,
        },
        problems: problems.slice(0, 3).map((w) => ({
          id: w.id,
          name: w.name,
          source: w.source,
          kind: w.problem!.kind,
          severity: w.problem!.severity,
        })),
        problemCount: problems.length,
      };
    });
  }

  app.get(
    '/clusters/:id/servers',
    {
      preHandler: signedIn,
      schema: {
        summary: "A Server fleet's servers: header facts, usage, workload counts and problems",
        tags: ['servers', PUBLIC_TAG],
        params: Params,
        response: {
          200: Type.Object({
            servers: Type.Array(ServerS),
            totals: Type.Object({
              servers: Type.Integer(),
              needAttention: Type.Integer(),
              services: Type.Integer(),
              servicesFailed: Type.Integer(),
              processes: Type.Integer(),
              crashLooping: Type.Integer(),
              containers: Type.Integer(),
            }),
          }),
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const byServer =
        cluster.kind === 'server' ? await workloads(cluster.id, cluster.scope) : new Map();
      const list = cluster.kind === 'server' ? await servers(cluster, byServer) : [];
      // Problems first, then by name (the canvas: "Problems first").
      list.sort((a, b) => b.problemCount - a.problemCount || a.name.localeCompare(b.name));
      const all = [...byServer.values()].flat();
      return {
        servers: list,
        totals: {
          servers: list.length,
          needAttention: list.filter((s) => s.problemCount > 0).length,
          services: all.filter((w) => w.source === 'service' && !w.system).length,
          servicesFailed: all.filter((w) => w.source === 'service' && w.problem?.kind === 'failed')
            .length,
          processes: all.filter((w) => w.source === 'process').length,
          crashLooping: all.filter((w) => w.problem?.kind === 'crash_looping').length,
          containers: all.filter((w) => w.source === 'container').length,
        },
      };
    },
  );

  app.get(
    '/clusters/:id/servers/:server',
    {
      preHandler: signedIn,
      schema: {
        summary: 'One server: its facts, usage tiles, recent events and who it talks to',
        tags: ['servers', PUBLIC_TAG],
        params: ServerParams,
        response: {
          200: Type.Object({
            server: ServerS,
            usage: Type.Object({
              cpuCores: N,
              memoryUsedBytes: N,
              diskUsedBytes: N,
              diskSizeBytes: N,
              networkInBytes: N,
              networkOutBytes: N,
            }),
            events: Type.Array(
              Type.Object({
                workloadId: S,
                kind: Type.String(),
                text: Type.String(),
                count: Type.Number(),
                alertId: S,
              }),
            ),
            talksTo: Type.Array(EdgeS),
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
      const name = request.params.server;
      const byServer = await workloads(cluster.id, cluster.scope, name);
      const [server] = await servers(cluster, byServer, name);
      if (!server) return sendProblem(reply, 404, 'Server not found');
      const h = `host="${escapeLabelValue(name)}"`;
      const [[used, memUsed, dUsed, dSize, net, svcEv, grpEv, rel], alerts, edges] =
        await Promise.all([
          instant(cluster.scope, [
            `sum by (host) (rate(watchlog_node_cpu_seconds_total{${h},mode!="idle"}[2m]))`,
            buildQuery('host.memory.used', { host: name }, 60).expr,
            `sum(watchlog_node_filesystem_bytes{${h},mount="/",state="size"}) - sum(watchlog_node_filesystem_bytes{${h},mount="/",state="avail"})`,
            `sum(watchlog_node_filesystem_bytes{${h},mount="/",state="size"})`,
            buildQuery('host.network.bytes', { host: name }, 60).expr,
            `sum by (unit, exit) (increase(watchlog_service_exits_total{${h},exit=~"error|signal"}[1h])) > 0`,
            `sum by (group, exit) (increase(watchlog_process_group_exits_total{${h},exit=~"error|signal"}[1h])) > 0`,
            `sum by (group) (increase(watchlog_process_group_releases_total{${h}}[1h])) > 0`,
          ]),
          firingAlerts(db, cluster.id),
          talksTo(cluster.scope, h),
        ]);
      const one = (r: QuerySeries[] | undefined) => r?.[0]?.points[0]?.[1] ?? null;
      const dir = (d: string) => net!.find((s) => s.labels.dir === d)?.points[0]?.[1] ?? null;
      const events: {
        workloadId: string | null;
        kind: string;
        text: string;
        count: number;
        alertId: string | null;
      }[] = [];
      for (const a of alerts) {
        if (a.silenced || (a.labels.node ?? a.labels.host) !== name) continue;
        events.push({
          workloadId: null,
          kind: 'alert',
          text: a.ruleName,
          count: 1,
          alertId: a.id,
        });
      }
      for (const w of byServer.get(name) ?? []) {
        if (w.problem?.kind === 'failed' || w.problem?.kind === 'oom_killed')
          events.push({
            workloadId: w.id,
            kind: w.problem.kind,
            text: w.name,
            count: 1,
            alertId: null,
          });
      }
      const count = (s: QuerySeries) => Math.round(s.points[0]?.[1] ?? 0);
      for (const s of svcEv!)
        events.push({
          workloadId: `service:${s.labels.unit}`,
          kind: s.labels.exit === 'signal' ? 'killed' : 'exited',
          text: s.labels.unit ?? '',
          count: count(s),
          alertId: null,
        });
      for (const s of grpEv!)
        events.push({
          workloadId: `process:${s.labels.group}`,
          kind: s.labels.exit === 'signal' ? 'killed' : 'exited',
          text: s.labels.group ?? '',
          count: count(s),
          alertId: null,
        });
      for (const s of rel!)
        events.push({
          workloadId: `process:${s.labels.group}`,
          kind: 'release',
          text: s.labels.group ?? '',
          count: count(s),
          alertId: null,
        });
      return {
        server,
        usage: {
          cpuCores: one(used),
          memoryUsedBytes: one(memUsed),
          diskUsedBytes: one(dUsed),
          diskSizeBytes: one(dSize),
          networkInBytes: dir('rx'),
          networkOutBytes: dir('tx'),
        },
        events: events.slice(0, 20),
        talksTo: edges,
      };
    },
  );

  /** The server's connections from eBPF (ADR-208), busiest first, at most 15. */
  async function talksTo(scope: ClusterScope, matcher: string) {
    const by =
      'workload_kind, workload, container, dst_kind, dst, dst_workload, dst_service, dst_port';
    const [conns, failed] = await instant(scope, [
      `topk(15, sum by (${by}) (rate(watchlog_flow_connections_total{${matcher}}[15m])))`,
      `sum by (${by}) (rate(watchlog_flow_connect_failed_total{${matcher}}[15m]))`,
    ]);
    const k = (l: Record<string, string>) =>
      [l.workload, l.container, l.dst_kind, l.dst, l.dst_workload, l.dst_service, l.dst_port].join(
        '\u0000',
      );
    const failedBy = new Map(failed!.map((s) => [k(s.labels), s.points[0]?.[1] ?? 0]));
    return conns!
      .map((s) => {
        const l = s.labels;
        return {
          from: l.workload || l.container || 'other processes',
          fromKind: l.workload_kind || (l.container ? 'Container' : null),
          to: l.dst_workload || l.dst_service || l.dst || l.dst_kind || 'unknown',
          toKind: l.dst_kind ?? 'external',
          port: l.dst_port ? Number(l.dst_port) : null,
          rate: s.points[0]?.[1] ?? 0,
          failed: failedBy.get(k(l)) ?? 0,
        };
      })
      .filter((e) => e.rate > 0)
      .sort((a, b) => b.rate - a.rate);
  }

  app.get(
    '/clusters/:id/servers/:server/workloads',
    {
      preHandler: signedIn,
      schema: {
        summary: "A server's workloads: systemd services, process groups and containers",
        tags: ['servers', PUBLIC_TAG],
        params: ServerParams,
        response: {
          200: Type.Object({ workloads: Type.Array(WorkloadS) }),
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster || cluster.kind !== 'server')
        return sendProblem(reply, 404, 'Cluster not found');
      const byServer = await workloads(cluster.id, cluster.scope, request.params.server);
      const list = byServer.get(request.params.server);
      if (!list) {
        const [s] = await servers(cluster, byServer, request.params.server);
        if (!s) return sendProblem(reply, 404, 'Server not found');
      }
      return { workloads: list ?? [] };
    },
  );

  app.get(
    '/clusters/:id/servers/:server/workloads/:workload',
    {
      preHandler: signedIn,
      schema: {
        summary:
          'One workload on a server: usage, the last hour of exits and restarts, connections',
        tags: ['servers', PUBLIC_TAG],
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          server: Type.String({ minLength: 1, maxLength: 253 }),
          workload: Type.String({ minLength: 3, maxLength: 300 }),
        }),
        response: {
          200: Type.Object({
            workload: WorkloadS,
            server: Type.String(),
            /** Process groups inside this service (pm2's apps), or the service a group runs in. */
            related: Type.Array(WorkloadS),
            usage: Type.Object({
              threads: N,
              openFiles: N,
              tasks: N,
              startedAt: N,
              cpuLimitCores: N,
            }),
            timeline: Type.Object({
              start: Type.Integer(),
              end: Type.Integer(),
              step: Type.Integer(),
              /** [t, failed exits (error), killed (signal), restarts, OOM kills] per step. */
              points: Type.Array(Type.Array(Type.Number())),
              /** When the executable changed on disk (a release), Unix seconds. */
              releases: Type.Array(Type.Integer()),
            }),
            /** Unix seconds the current crash loop began; null when not crash-looping. */
            crashLoopSince: N,
            connections: Type.Array(EdgeS),
          }),
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster || cluster.kind !== 'server')
        return sendProblem(reply, 404, 'Cluster not found');
      const ref = parseWorkloadId(request.params.workload);
      if (!ref)
        return sendProblem(
          reply,
          400,
          'The workload is service:<unit>, process:<group> or container:<name>',
        );
      const name = request.params.server;
      const list = (await workloads(cluster.id, cluster.scope, name)).get(name) ?? [];
      const workload = list.find((w) => w.id === request.params.workload);
      if (!workload) return sendProblem(reply, 404, 'Workload not found');

      const h = `host="${escapeLabelValue(name)}"`;
      const step = 60;
      const end = Math.floor(Date.now() / 1000 / step) * step;
      const start = end - 3600;
      const n = escapeLabelValue(ref.name);
      const sel =
        ref.source === 'service'
          ? `${h},unit="${n}"`
          : ref.source === 'process'
            ? `${h},group="${n}"`
            : `${h},container="${n}"`;
      const w = `[${step}s]`;
      const ranges =
        ref.source === 'service'
          ? [
              `sum(increase(watchlog_service_exits_total{${sel},exit="error"}${w}))`,
              `sum(increase(watchlog_service_exits_total{${sel},exit="signal"}${w}))`,
              `sum(increase(watchlog_service_restarts_total{${sel}}${w}))`,
              `sum(increase(watchlog_service_oom_kills_total{${sel}}${w}))`,
              'vector(0)',
            ]
          : ref.source === 'process'
            ? [
                `sum(increase(watchlog_process_group_exits_total{${sel},exit="error"}${w}))`,
                `sum(increase(watchlog_process_group_exits_total{${sel},exit="signal"}${w}))`,
                `sum(increase(watchlog_process_group_starts_total{${sel}}${w}))`,
                `sum(increase(watchlog_process_group_oom_kills_total{${sel}}${w}))`,
                `sum(increase(watchlog_process_group_releases_total{${sel}}${w}))`,
              ]
            : [
                'vector(0)',
                'vector(0)',
                `sum(increase(watchlog_container_restarts_total{${sel}}${w}))`,
                `sum(increase(watchlog_container_oom_events_total{${sel}}${w}))`,
                'vector(0)',
              ];
      const instants =
        ref.source === 'service'
          ? [
              null,
              null,
              `max(last_over_time(watchlog_service_tasks{${sel}}[2m]))`,
              `max(last_over_time(watchlog_service_start_time_seconds{${sel}}[2m]))`,
              `max(last_over_time(watchlog_service_cpu_limit_cores{${sel}}[2m]))`,
            ]
          : ref.source === 'process'
            ? [
                `sum(last_over_time(watchlog_process_group_threads{${sel}}[2m]))`,
                `sum(last_over_time(watchlog_process_group_open_files{${sel}}[2m]))`,
                null,
                null,
                null,
              ]
            : [
                null,
                null,
                null,
                null,
                `max(last_over_time(watchlog_container_cpu_limit_cores{${sel}}[2m]))`,
              ];
      const flowSel =
        ref.source === 'container'
          ? `${h},container="${n}"`
          : `${h},workload_kind="${ref.source === 'service' ? 'Service' : 'ProcessGroup'}",workload="${n}"`;
      const [series, [threads, files, tasks, started, cpuLimit], connections] = await Promise.all([
        ranged(cluster.scope, ranges, start, end, step),
        instant(cluster.scope, instants),
        talksTo(cluster.scope, flowSel),
      ]);
      const at = (r: QuerySeries[] | undefined) => {
        const m = new Map<number, number>();
        for (const [t, v] of r?.[0]?.points ?? []) if (v != null) m.set(t, v);
        return m;
      };
      const [err, sig, rst, oom, rel] = series.map(at);
      const points: number[][] = [];
      for (let t = start + step; t <= end; t += step) {
        points.push([
          t,
          Math.round(err!.get(t) ?? 0),
          Math.round(sig!.get(t) ?? 0),
          Math.round(rst!.get(t) ?? 0),
          Math.round(oom!.get(t) ?? 0),
        ]);
      }
      const releases = [...rel!.entries()].filter(([, v]) => v >= 0.5).map(([t]) => t);
      const one = (r: QuerySeries[] | undefined) => r?.[0]?.points[0]?.[1] ?? null;
      const related =
        ref.source === 'service'
          ? list.filter((x) => x.source === 'process' && x.unit === ref.name)
          : ref.source === 'process' && workload.unit
            ? list.filter((x) => x.id === `service:${workload.unit}`)
            : [];
      return {
        workload,
        server: name,
        related,
        usage: {
          threads: one(threads),
          openFiles: one(files),
          tasks: one(tasks),
          startedAt: (() => {
            const v = one(started);
            return v ? Math.round(v / 1e6) : null; // systemd's ActiveEnterTimestamp is in µs
          })(),
          cpuLimitCores: one(cpuLimit),
        },
        timeline: { start, end, step, points, releases },
        crashLoopSince: workload.problem?.kind === 'crash_looping' ? crashLoopSince(points) : null,
        connections,
      };
    },
  );
};

/**
 * When the crash loop that is still going began: the first minute of the last run of
 * minutes whose trailing 10 minutes hold at least CRASH_LOOP crashes or restarts.
 */
export function crashLoopSince(points: number[][]): number | null {
  const crashes = points.map((p) => Math.max((p[1] ?? 0) + (p[2] ?? 0), p[3] ?? 0));
  let since: number | null = null;
  for (let i = 0; i < points.length; i++) {
    let sum = 0;
    for (let j = Math.max(0, i - 9); j <= i; j++) sum += crashes[j]!;
    if (sum >= CRASH_LOOP) {
      if (since === null) {
        // The loop began at the first crash of this window.
        let first = Math.max(0, i - 9);
        while (first < i && crashes[first] === 0) first++;
        since = points[first]![0]!;
      }
    } else since = null;
  }
  return since;
}
