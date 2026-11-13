// SPDX-License-Identifier: AGPL-3.0-only
// Docker hosts and containers for a Docker fleet (SPEC §4.4, §8.1).
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import type { ClusterScope, QuerySeries, VictoriaQueryClient } from '../../lib/victoria.js';
import { requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { CLUSTER_STALE_MS, clusterForOrg } from '../clusters/service.js';
import { alertText } from '../alerts/text.js';
import { FAILING, dockerProblem } from '../overview/docker-problems.js';
import { hostBoots, stoppedWithHost, type HostBoot } from './host-restart.js';
import { watchlogComponents } from '../servicemap/graph.js';
import { firingAlerts } from '../overview/problems.js';
import { sparkStep } from '../overview/step.js';
import { buildQuery } from '../query/catalog.js';
import { PUBLIC_TAG } from '../../openapi/public.js';

const Nullable = <T extends ReturnType<typeof Type.Number>>(t: T) => Type.Union([t, Type.Null()]);
const NullableString = Type.Union([Type.String(), Type.Null()]);
/** States in which a container reports its metrics. */
const RUNS = new Set(['running', 'restarting', 'paused']);
/** How far back a stopped container's last memory limit is looked for. */
const STOPPED_LIMIT_WINDOW = '1d';

const HostSchema = Type.Object({
  name: Type.String(),
  status: Type.Union([Type.Literal('active'), Type.Literal('inactive')]),
  lastSeenAt: NullableString,
  agentVersion: NullableString,
  dockerVersion: NullableString,
  os: NullableString,
  arch: NullableString,
  kernelVersion: NullableString,
  containers: Type.Object({
    total: Type.Integer(),
    running: Type.Integer(),
    stopped: Type.Integer(),
    unhealthy: Type.Integer(),
  }),
  cpuUtilization: Nullable(Type.Number()),
  memoryUtilization: Nullable(Type.Number()),
  diskUtilization: Nullable(Type.Number()),
  load1: Nullable(Type.Number()),
  // The Hosts page (Nodes design, Docker parity).
  cpu: Type.Object({ usageCores: Nullable(Type.Number()), cores: Nullable(Type.Number()) }),
  memory: Type.Object({
    usageBytes: Nullable(Type.Number()),
    totalBytes: Nullable(Type.Number()),
  }),
  /** When the host booted (Unix seconds), from agents that report it. */
  bootTime: Nullable(Type.Number()),
  /** Every mounted filesystem, fullest first. */
  disks: Type.Array(
    Type.Object({
      mount: Type.String(),
      utilization: Type.Number(),
      sizeBytes: Nullable(Type.Number()),
    }),
  ),
  cpuSeries: Type.Array(Type.Array(Nullable(Type.Number()))),
  memorySeries: Type.Array(Type.Array(Nullable(Type.Number()))),
  /** Its containers for the heatmap (only with ?heat=1). */
  heat: Type.Optional(
    Type.Array(
      Type.Object({
        namespace: Type.String(),
        name: Type.String(),
        cpu: Nullable(Type.Number()),
        cpuRequest: Nullable(Type.Number()),
        cpuRatio: Nullable(Type.Number()),
        failing: NullableString,
      }),
    ),
  ),
});

const ContainerSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  host: Type.String(),
  image: Type.String(),
  state: Type.String(),
  status: Type.String(),
  health: NullableString,
  restartCount: Type.Integer(),
  exitCode: Type.Integer(),
  oomKilled: Type.Boolean(),
  createdAt: Type.Integer(),
  startedAt: NullableString,
  ports: Type.Array(
    Type.Object({
      ip: Type.Optional(Type.String()),
      publicPort: Type.Integer(),
      privatePort: Type.Integer(),
      protocol: Type.String(),
    }),
  ),
  composeProject: NullableString,
  composeService: NullableString,
  sizeRw: Nullable(Type.Number()),
  cpuCores: Nullable(Type.Number()),
  cpuLimitCores: Nullable(Type.Number()),
  memoryBytes: Nullable(Type.Number()),
  memoryLimitBytes: Nullable(Type.Number()),
  restarting: Type.Boolean(),
  /** Daemon error message (State.Error), redacted by the agent. */
  stateError: NullableString,
  finishedAt: NullableString,
  /**
   * Stopped by its host's reboot (`host`, `at` the boot) or its Docker daemon's restart
   * (`docker`, `at` the stop), not by its own process (ADR-159); absent otherwise.
   */
  stoppedWith: Type.Optional(
    Type.Object({
      how: Type.Union([Type.Literal('host'), Type.Literal('docker')]),
      at: Type.String(),
    }),
  ),
  /** Why the health status is what it is (ADR-047); null without a health check. */
  healthDetail: Type.Union([
    Type.Object({
      status: Type.String(),
      failingStreak: Type.Integer(),
      /** When the current status began; `sinceEstimated` when derived from the probe log. */
      since: NullableString,
      sinceEstimated: Type.Boolean(),
      probes: Type.Array(
        Type.Object({
          start: Type.String(),
          end: Type.String(),
          exitCode: Type.Integer(),
          /** Null when the agent runs with WATCHLOG_HEALTH_OUTPUT=false. */
          output: NullableString,
        }),
      ),
      check: Type.Union([
        Type.Object({
          command: Type.String(),
          shell: Type.Boolean(),
          intervalS: Type.Number(),
          timeoutS: Type.Number(),
          startPeriodS: Type.Number(),
          retries: Type.Integer(),
        }),
        Type.Null(),
      ]),
    }),
    Type.Null(),
  ]),
  // The Containers page (Workloads design, Docker parity).
  /** What is wrong, worded as the alert texts; null when fine. */
  problem: Type.Union([
    Type.Object({
      severity: Type.Union([Type.Literal('critical'), Type.Literal('warning')]),
      /** OOMKilled, Restarting, Unhealthy, Exited. */
      kind: Type.String(),
      title: Type.String(),
      reason: NullableString,
      alertId: NullableString,
    }),
    Type.Null(),
  ]),
  /** Restarts within the selected range (from metrics). */
  restartsInRange: Nullable(Type.Number()),
  /** CPU in cores over the selected range, for the sparkline. */
  cpuSeries: Type.Array(Type.Array(Nullable(Type.Number()))),
  /** One of WatchLog's own containers. */
  watchlog: Type.Boolean(),
});

interface ContainerStatus {
  state?: string;
  status?: string;
  health?: string;
  restart_count?: number;
  exit_code?: number;
  oom_killed?: boolean;
  started_at?: string;
  size_rw?: number;
  restarting?: boolean;
  error?: string;
  finished_at?: string;
  health_detail?: {
    status: string;
    failing_streak: number;
    probes: { start: string; end: string; exit_code: number; output?: string }[];
    check?: {
      command: string;
      shell: boolean;
      interval_s: number;
      timeout_s: number;
      start_period_s: number;
      retries: number;
    };
  };
  health_since?: string;
  health_since_estimated?: boolean;
}
interface ContainerSpec {
  image?: string;
  created_at?: number;
  ports?: { ip?: string; public_port: number; private_port: number; protocol: string }[];
  compose_service?: string;
}

/** Latest value per label key from an instant query. */
function byLabels(series: QuerySeries[], ...keys: string[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const s of series)
    out.set(keys.map((k) => s.labels[k] ?? '').join('\u0000'), s.points[0]?.[1] ?? null);
  return out;
}

export const dockerRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  victoria?: VictoriaQueryClient;
}> = async (app, { db, victoria }) => {
  const signedIn = requireUser();

  /** Range queries, as optional as instant ones. */
  function ranged(scope: ClusterScope, exprs: string[], start: number, end: number, step: number) {
    return Promise.all(
      exprs.map((e) =>
        victoria
          ? victoria.queryRange(scope, e, start, end, step).catch((err: Error) => {
              app.log.warn({ err: err.message }, 'range query failed');
              return [] as QuerySeries[];
            })
          : Promise.resolve([] as QuerySeries[]),
      ),
    );
  }

  /** Runs instant queries; metrics are optional, so storage errors return no values. */
  async function instant(scope: ClusterScope, exprs: string[]): Promise<QuerySeries[][]> {
    if (!victoria) return exprs.map(() => []);
    return Promise.all(
      exprs.map((e) =>
        victoria.query(scope, e).catch((err: Error) => {
          app.log.warn({ err: err.message }, 'instant query failed');
          return [] as QuerySeries[];
        }),
      ),
    );
  }

  app.get(
    '/clusters/:id/docker/hosts',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Docker hosts of a fleet with container counts, usage, disks and trends',
        tags: ['docker', PUBLIC_TAG],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        querystring: Type.Object({
          /** Seconds of history for the sparklines (default 1 h). */
          range: Type.Optional(Type.Integer({ minimum: 300, maximum: 7 * 86400 })),
          /** Include each host's containers for the heatmap. */
          heat: Type.Optional(Type.Literal('1')),
        }),
        response: {
          200: Type.Object({
            hosts: Type.Array(HostSchema),
            range: Type.Integer(),
            step: Type.Integer(),
            /** Firing disk alerts, so the fullest disk can link to its alert. */
            diskAlerts: Type.Array(
              Type.Object({
                node: Type.String(),
                mount: NullableString,
                alertId: Type.String(),
              }),
            ),
          }),
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');

      const [agents, hostObjects, containerRows] = await Promise.all([
        db.selectFrom('agent_instances').selectAll().where('cluster_id', '=', cluster.id).execute(),
        db
          .selectFrom('objects')
          .selectAll()
          .where('cluster_id', '=', cluster.id)
          .where('kind', '=', 'DockerHost')
          .where('deleted_at', 'is', null)
          .execute(),
        db
          .selectFrom('objects')
          .select(['node', 'name', 'namespace', 'status_summary'])
          .where('cluster_id', '=', cluster.id)
          .where('kind', '=', 'DockerContainer')
          .where('deleted_at', 'is', null)
          .execute(),
      ]);
      const range = request.query.range ?? 3600;
      const heat = request.query.heat === '1';
      const step = sparkStep(range);
      const now = Date.now();
      const end = Math.floor(now / 1000 / step) * step;
      const [
        [cpu, mem, disk, load, used, cores, memUsed, memTotal, boot, mounts, sizes, cCpu, cLimit],
        [cpuR, memR],
        alerts,
        boots,
      ] = await Promise.all([
        instant(cluster.scope, [
          buildQuery('host.cpu.utilization', {}, 15).expr,
          buildQuery('host.memory.utilization', {}, 15).expr,
          buildQuery('host.root_filesystem.utilization', {}, 15).expr,
          buildQuery('host.load1', {}, 15).expr,
          'sum by (host) (rate(watchlog_node_cpu_seconds_total{mode!="idle"}[2m]))',
          'max by (host) (watchlog_node_cpu_count)',
          'sum by (host) (watchlog_node_memory_bytes{state="total"}) - sum by (host) (watchlog_node_memory_bytes{state="available"})',
          'sum by (host) (watchlog_node_memory_bytes{state="total"})',
          'max by (host) (watchlog_node_boot_time_seconds)',
          buildQuery('host.filesystem.utilization', {}, 15).expr,
          'sum by (host, mount) (watchlog_node_filesystem_bytes{state="size"})',
          ...(heat
            ? [
                buildQuery('container.cpu.usage', {}, 15).expr,
                buildQuery('container.cpu.limit', {}, 15).expr,
              ]
            : []),
        ]),
        ranged(
          cluster.scope,
          [
            buildQuery('host.cpu.utilization', {}, step).expr,
            buildQuery('host.memory.utilization', {}, step).expr,
          ],
          end - range,
          end,
          step,
        ),
        firingAlerts(db, cluster.id),
        heat
          ? hostBoots((e) => instant(cluster.scope, [e]).then((r) => r[0] ?? []), now / 1000)
          : new Map<string, HostBoot>(),
      ]);
      const withHost = stoppedWithHost(containerRows, boots);
      const cpuBy = byLabels(cpu!, 'host');
      const memBy = byLabels(mem!, 'host');
      const diskBy = byLabels(disk!, 'host');
      const loadBy = byLabels(load!, 'host');
      const usedBy = byLabels(used!, 'host');
      const coresBy = byLabels(cores!, 'host');
      const memUsedBy = byLabels(memUsed!, 'host');
      const memTotalBy = byLabels(memTotal!, 'host');
      const bootBy = byLabels(boot!, 'host');
      const sizeBy = byLabels(sizes!, 'host', 'mount');
      const disksBy = new Map<
        string,
        { mount: string; utilization: number; sizeBytes: number | null }[]
      >();
      for (const m of mounts!) {
        const v = m.points[0]?.[1];
        const h = m.labels.host;
        if (v == null || !h || !m.labels.mount) continue;
        const list = disksBy.get(h) ?? [];
        list.push({
          mount: m.labels.mount,
          utilization: v,
          sizeBytes: sizeBy.get(`${h}\u0000${m.labels.mount}`) ?? null,
        });
        disksBy.set(h, list);
      }
      const seriesBy = (r: QuerySeries[]) =>
        new Map(r.map((x) => [x.labels.host ?? '', x.points] as const));
      const cpuSeries = seriesBy(cpuR!);
      const memSeries = seriesBy(memR!);
      const cCpuBy = heat ? byLabels(cCpu!, 'host', 'container') : new Map<string, number | null>();
      const cLimitBy = heat
        ? byLabels(cLimit!, 'host', 'container')
        : new Map<string, number | null>();

      const names = new Set([
        ...agents.filter((a) => a.mode === 'docker').map((a) => a.node),
        ...hostObjects.map((h) => h.node),
      ]);
      const hosts = [...names].sort().map((name) => {
        const agent = agents.find((a) => a.node === name);
        const host = hostObjects.find((h) => h.node === name)?.spec_summary as
          Record<string, string> | undefined;
        const counts = { total: 0, running: 0, stopped: 0, unhealthy: 0 };
        for (const c of containerRows) {
          if (c.node !== name) continue;
          const st = c.status_summary as ContainerStatus;
          counts.total++;
          if (st.state === 'running' || st.state === 'restarting') counts.running++;
          else counts.stopped++;
          if (st.health === 'unhealthy') counts.unhealthy++;
        }
        const lastSeen = agent?.last_seen_at ?? null;
        return {
          name,
          status:
            lastSeen && now - lastSeen.getTime() <= CLUSTER_STALE_MS
              ? ('active' as const)
              : ('inactive' as const),
          lastSeenAt: lastSeen?.toISOString() ?? null,
          agentVersion: agent?.agent_version ?? null,
          dockerVersion: host?.docker_version ?? null,
          os: host?.os ?? null,
          arch: host?.arch ?? null,
          kernelVersion: host?.kernel_version ?? null,
          containers: counts,
          cpuUtilization: cpuBy.get(name) ?? null,
          memoryUtilization: memBy.get(name) ?? null,
          diskUtilization: diskBy.get(name) ?? null,
          load1: loadBy.get(name) ?? null,
          cpu: { usageCores: usedBy.get(name) ?? null, cores: coresBy.get(name) ?? null },
          memory: {
            usageBytes: memUsedBy.get(name) ?? null,
            totalBytes: memTotalBy.get(name) ?? null,
          },
          bootTime: bootBy.get(name) ?? null,
          disks: (disksBy.get(name) ?? []).sort((a, b) => b.utilization - a.utilization),
          cpuSeries: cpuSeries.get(name) ?? [],
          memorySeries: memSeries.get(name) ?? [],
          ...(heat
            ? {
                heat: containerRows
                  .filter((c) => {
                    const st = c.status_summary as ContainerStatus;
                    return (
                      c.node === name &&
                      (st.state === 'running' ||
                        st.state === 'restarting' ||
                        !!dockerProblem(
                          st as never,
                          now,
                          null,
                          withHost.get(`${name}\u0000${c.name}`),
                        ))
                    );
                  })
                  .map((c) => {
                    const k = `${name}\u0000${c.name}`;
                    const used = cCpuBy.get(k) ?? null;
                    const lim = cLimitBy.get(k) ?? null;
                    const p = dockerProblem(c.status_summary as never, now, null, withHost.get(k));
                    return {
                      namespace: c.namespace,
                      name: c.name,
                      cpu: used,
                      cpuRequest: lim,
                      cpuRatio: used !== null ? used / (lim || 1) : null,
                      failing: p ? (FAILING[p.ruleKey] ?? null) : null,
                    };
                  }),
              }
            : {}),
        };
      });
      return {
        hosts,
        range,
        step,
        diskAlerts: alerts
          .filter(
            (a) =>
              !a.silenced && a.ruleKey === 'node.disk.usage' && (a.labels.host ?? a.labels.node),
          )
          .map((a) => ({
            node: (a.labels.host ?? a.labels.node)!,
            mount: a.labels.mount ?? null,
            alertId: a.id,
          })),
      };
    },
  );

  app.get(
    '/clusters/:id/docker/containers',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Containers of a fleet (optionally one host) with current usage',
        tags: ['docker', PUBLIC_TAG],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        querystring: Type.Object({
          host: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
          /** Seconds of history for the CPU sparkline and restarts (default 1 h). */
          range: Type.Optional(Type.Integer({ minimum: 300, maximum: 7 * 86400 })),
        }),
        response: {
          200: Type.Object({
            containers: Type.Array(ContainerSchema),
            range: Type.Integer(),
            step: Type.Integer(),
          }),
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const host = request.query.host;
      let q = db
        .selectFrom('objects')
        .selectAll()
        .where('cluster_id', '=', cluster.id)
        .where('kind', '=', 'DockerContainer')
        .where('deleted_at', 'is', null);
      if (host) q = q.where('node', '=', host);
      const rows = await q.orderBy('node').orderBy('namespace').orderBy('name').execute();

      const scope = host ? { host } : {};
      const range = request.query.range ?? 3600;
      const step = sparkStep(range);
      const now = Date.now();
      const end = Math.floor(now / 1000 / step) * step;
      const sel = host ? `{host="${host.replace(/["\\]/g, '')}"}` : '';
      const [[cpu, mem, limit, cpuLimit, restarts, lastLimit], [cpuR], alerts, agentRows, boots] =
        await Promise.all([
          instant(cluster.scope, [
            buildQuery('container.cpu.usage', scope, 15).expr,
            buildQuery('container.memory.working_set', scope, 15).expr,
            buildQuery('container.memory.limit', scope, 15).expr,
            buildQuery('container.cpu.limit', scope, 15).expr,
            `sum by (host, container) (increase(watchlog_container_restarts_total${sel}[${range}s]))`,
            // A stopped container reports nothing: its limit is the last one seen (the
            // OOM-killed consumer's 384 MiB read as "no limit of its own", the v0.4 review).
            `max by (host, container) (last_over_time(watchlog_container_memory_limit_bytes${sel}[${STOPPED_LIMIT_WINDOW}]))`,
          ]),
          ranged(
            cluster.scope,
            [buildQuery('container.cpu.usage', scope, step).expr],
            end - range,
            end,
            step,
          ),
          firingAlerts(db, cluster.id),
          db
            .selectFrom('agent_instances')
            .select(['node', 'last_seen_at'])
            .where('cluster_id', '=', cluster.id)
            .where('mode', '=', 'docker')
            .execute(),
          hostBoots(
            (e) => instant(cluster.scope, [e]).then((r) => r[0] ?? []),
            now / 1000,
            host ? new Set([host]) : undefined,
          ),
        ]);
      // Containers on hosts that stopped reporting keep their last state, but no problem:
      // it is stale, and the host's "not reporting" alert says so.
      const live = new Set(
        agentRows
          .filter((a) => now - a.last_seen_at.getTime() <= CLUSTER_STALE_MS)
          .map((a) => a.node),
      );
      const restartsBy = byLabels(restarts!, 'host', 'container');
      const seriesBy = new Map<string, QuerySeries['points']>(
        cpuR!.map((x) => [`${x.labels.host}\u0000${x.labels.container}`, x.points]),
      );
      const own = watchlogComponents(
        rows.map((r) => ({
          id: r.uid,
          group: r.node,
          name: r.name,
          images: [(r.spec_summary as ContainerSpec).image ?? ''],
        })),
      );
      const memText = (b: number | null | undefined) =>
        b ? `${Math.round(b / 2 ** 20)} MiB` : null;
      const cpuLimitBy = byLabels(cpuLimit!, 'host', 'container');
      const cpuBy = byLabels(cpu!, 'host', 'container');
      const memBy = byLabels(mem!, 'host', 'container');
      const nowLimitBy = byLabels(limit!, 'host', 'container');
      const lastLimitBy = byLabels(lastLimit!, 'host', 'container');
      const stopped = new Set(
        rows
          .filter((r) => !RUNS.has((r.status_summary as ContainerStatus).state ?? ''))
          .map((r) => `${r.node}\u0000${r.name}`),
      );
      // Running: the limit now (none means none). Stopped: the last one it ran with.
      const limitBy = {
        get: (key: string) =>
          nowLimitBy.get(key) ?? (stopped.has(key) ? lastLimitBy.get(key) : undefined),
      };

      const withHost = stoppedWithHost(rows, boots);
      const containers = rows.map((r) => {
        const spec = r.spec_summary as ContainerSpec;
        const st = r.status_summary as ContainerStatus;
        const key = `${r.node}\u0000${r.name}`;
        const stoppedWith = withHost.get(key);
        const p = live.has(r.node)
          ? dockerProblem(st as never, now, memText(limitBy.get(key)), stoppedWith)
          : null;
        const alert = alerts.find(
          (a) =>
            !a.silenced &&
            a.labels.container === r.name &&
            (a.labels.node ?? a.labels.host) === r.node,
        );
        const text = (ruleKey: string, details: Record<string, unknown>) =>
          alertText({
            ruleKey,
            ruleName: ruleKey,
            labels: { container: r.name, node: r.node },
            details,
            cluster: { name: cluster.name },
            now,
          });
        const problem = alert
          ? {
              severity:
                alert.severity === 'critical' ? ('critical' as const) : ('warning' as const),
              kind: p ? (FAILING[p.ruleKey] ?? 'Alert') : 'Alert',
              ...(({ title, why }) => ({ title, reason: why }))(
                alertText({
                  ruleKey: alert.ruleKey,
                  ruleName: alert.ruleName,
                  labels: alert.labels,
                  details: alert.details,
                  cluster: { name: cluster.name },
                  now,
                }),
              ),
              alertId: alert.id,
            }
          : p
            ? {
                severity: p.severity,
                kind: FAILING[p.ruleKey] ?? 'Problem',
                ...(({ title, why }) => ({ title, reason: why }))(text(p.ruleKey, p.details)),
                alertId: null,
              }
            : null;
        const restartsNow = restartsBy.get(key);
        return {
          problem,
          restartsInRange: restartsNow == null ? null : Math.round(restartsNow),
          cpuSeries: seriesBy.get(key) ?? [],
          watchlog: own.has(r.uid),
          id: r.uid,
          name: r.name,
          host: r.node,
          image: spec.image ?? '',
          state: st.state ?? 'unknown',
          status: st.status ?? '',
          health: st.health ?? null,
          restartCount: st.restart_count ?? 0,
          exitCode: st.exit_code ?? 0,
          oomKilled: st.oom_killed ?? false,
          createdAt: spec.created_at ?? 0,
          startedAt: st.started_at ?? null,
          ports: (spec.ports ?? []).map((p) => ({
            ...(p.ip ? { ip: p.ip } : {}),
            publicPort: p.public_port,
            privatePort: p.private_port,
            protocol: p.protocol,
          })),
          composeProject: r.namespace || null,
          composeService: spec.compose_service ?? null,
          sizeRw: st.size_rw ?? null,
          cpuCores: st.state === 'running' ? (cpuBy.get(key) ?? null) : null,
          memoryBytes: st.state === 'running' ? (memBy.get(key) ?? null) : null,
          memoryLimitBytes: limitBy.get(key) ?? null,
          cpuLimitCores: cpuLimitBy.get(key) ?? null,
          restarting: st.restarting ?? st.state === 'restarting',
          stateError: st.error || null,
          finishedAt: st.finished_at ?? null,
          ...(stoppedWith ? { stoppedWith } : {}),
          healthDetail: st.health_detail
            ? {
                status: st.health_detail.status,
                failingStreak: st.health_detail.failing_streak,
                since: st.health_since ?? null,
                sinceEstimated: st.health_since_estimated ?? false,
                probes: st.health_detail.probes.map((p) => ({
                  start: p.start,
                  end: p.end,
                  exitCode: p.exit_code,
                  output: p.output ?? null,
                })),
                check: st.health_detail.check
                  ? {
                      command: st.health_detail.check.command,
                      shell: st.health_detail.check.shell,
                      intervalS: st.health_detail.check.interval_s,
                      timeoutS: st.health_detail.check.timeout_s,
                      startPeriodS: st.health_detail.check.start_period_s,
                      retries: st.health_detail.check.retries,
                    }
                  : null,
              }
            : null,
        };
      });
      return { containers, range, step };
    },
  );
};
