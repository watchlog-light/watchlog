// SPDX-License-Identifier: AGPL-3.0-only
// GET /clusters/:id/overview (SPEC §4.1, ADR-110): the whole
// overview page in one response, from database and metric queries run in parallel.
// Kubernetes clusters and Docker fleets get the same shape with their own numbers.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import type { QuerySeries, VictoriaQueryClient } from '../../lib/victoria.js';
import { requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { alertingStatus } from '../alerts/status.js';
import { CLUSTER_STALE_MS, findCluster } from '../clusters/service.js';
import { ingestFailures } from '../ingest/errors.js';
import {
  containerResources,
  needsAttention,
  nodeCapacity,
  nodeStatus,
  podFailing,
  podIsActive,
  type ObjectRow,
  type PodSpec,
  type PodStatus,
} from '../kubernetes/views.js';
import { anyOf, buildQuery, type QueryScope } from '../query/catalog.js';
import { watchlogComponents } from '../servicemap/graph.js';
import { systemNamespaces, type SettingsService } from '../settings/service.js';
import { sparkStep } from './step.js';
import { groupEvents } from './events.js';
import { FAILING, dockerProblem, dockerProblems } from './docker-problems.js';
import { hostBoots, stoppedWithHost } from '../docker/host-restart.js';
import { buildProblems, firingAlerts, type Problems } from './problems.js';
import { OverviewSchema } from './schemas.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { causeReader, problemSubject, wantsCause, type CausesService } from '../causes/likely.js';

/** The alert rule of an agent that stopped reporting (alerts/defaults.ts). */
const NOT_REPORTING = 'agent.not_reporting';

const MAX_RANGE_S = 7 * 86400;
const CHANGES_WINDOW_MS = 7 * 86400_000;
const TOP = 5;
const HEAT_MAX = 2000;

/**
 * The pods the heatmap draws, at most HEAT_MAX: every failing pod, then the same share
 * of each node's pods, so a large cluster shows a few pods per node rather than every
 * pod of the first nodes. Each node's full count is in `nodes[].pods`.
 */
export function heatPods<T extends { node: string | null }>(
  pods: T[],
  failing: (p: T) => boolean,
  nodes = new Set(pods.map((p) => p.node)).size,
): T[] {
  if (pods.length <= HEAT_MAX) return pods;
  const perNode = Math.max(1, Math.floor(HEAT_MAX / Math.max(1, nodes)));
  const taken = new Map<string | null, number>();
  const out = pods.filter(failing);
  for (const p of pods) {
    if (out.length >= HEAT_MAX) break;
    if (failing(p)) continue;
    const n = taken.get(p.node) ?? 0;
    if (n >= perNode) continue;
    taken.set(p.node, n + 1);
    out.push(p);
  }
  return out;
}

type Points = [number, number | null][];
const key = (...parts: (string | null | undefined)[]) => parts.map((p) => p ?? '').join('\u0000');

/** Latest value per label tuple of an instant query. */
function byLabels(series: QuerySeries[], ...labels: string[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const s of series) out.set(key(...labels.map((l) => s.labels[l])), s.points[0]?.[1] ?? null);
  return out;
}
const first = (r: QuerySeries[] | undefined) => r?.[0]?.points[0]?.[1] ?? null;
const points = (r: QuerySeries[] | undefined): Points => r?.[0]?.points ?? [];

/** The top items by usage plus the top non-system ones, so the page can hide system ones. */
function topWithSystem<T extends { usage: number; system: boolean }>(items: T[]): T[] {
  const sorted = items.sort((a, b) => b.usage - a.usage);
  const keep = new Set([...sorted.slice(0, TOP), ...sorted.filter((i) => !i.system).slice(0, TOP)]);
  return sorted.filter((i) => keep.has(i));
}

export const overviewRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  victoria?: VictoriaQueryClient;
  settings: SettingsService;
  /** Each problem's likely cause (ADR-148, ADR-155); left out without it. */
  causes?: CausesService;
}> = async (app, { db, victoria, settings, causes }) => {
  const signedIn = requireUser(db);

  /** Metric queries are optional: a storage error gives no values, never a failed page. */
  function instant(clusterId: string, exprs: string[]): Promise<QuerySeries[][]> {
    return Promise.all(
      exprs.map((e) =>
        victoria
          ? victoria.query({ clusterId }, e).catch((err: Error) => {
              app.log.warn({ err: err.message }, 'overview query failed');
              return [] as QuerySeries[];
            })
          : Promise.resolve([] as QuerySeries[]),
      ),
    );
  }
  function ranged(clusterId: string, exprs: string[], start: number, end: number, step: number) {
    return Promise.all(
      exprs.map((e) =>
        victoria
          ? victoria.queryRange({ clusterId }, e, start, end, step).catch((err: Error) => {
              app.log.warn({ err: err.message }, 'overview range query failed');
              return [] as QuerySeries[];
            })
          : Promise.resolve([] as QuerySeries[]),
      ),
    );
  }

  function agentRows(clusterId: string) {
    return db
      .selectFrom('agent_instances')
      .select(['node', 'mode', 'capabilities', 'last_seen_at'])
      .where('cluster_id', '=', clusterId)
      .execute();
  }

  function markers(clusterId: string, from: Date, to: Date, namespaces?: string[], limit = 200) {
    let q = db
      .selectFrom('change_markers')
      .select(['kind', 'target', 'namespace', 'details', 'ts'])
      .where('cluster_id', '=', clusterId)
      .where('ts', '>=', from)
      .where('ts', '<=', to);
    if (namespaces)
      q = q.where((eb) => eb.or([eb('namespace', 'in', namespaces), eb('kind', '=', 'node')]));
    return q
      .orderBy('ts', 'desc')
      .limit(limit)
      .execute()
      .then((rows) =>
        rows.map((m) => ({
          kind: m.kind,
          target: m.target,
          namespace: m.namespace || null,
          details: m.details as Record<string, unknown>,
          ts: m.ts.toISOString(),
        })),
      );
  }

  function ebpfOf(agents: { mode: string; capabilities: unknown; last_seen_at: Date }[]) {
    // Agents that stopped reporting (a removed host) do not make eBPF "partial".
    const all = agents.filter((a) => a.mode === 'node' || a.mode === 'docker');
    const live = all.filter((a) => Date.now() - a.last_seen_at.getTime() <= CLUSTER_STALE_MS);
    const nodeAgents = live.length ? live : all;
    const on = nodeAgents.filter(
      (a) => (a.capabilities as { ebpf?: string })?.ebpf === 'enabled',
    ).length;
    return on === 0
      ? ('off' as const)
      : on === nodeAgents.length
        ? ('on' as const)
        : ('partial' as const);
  }

  function health(p: Problems, running: boolean) {
    if (p.critical > 0) return 'critical' as const;
    if (p.warning > 0) return 'degraded' as const;
    return running ? ('healthy' as const) : ('unknown' as const);
  }

  app.get(
    '/clusters/:id/overview',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Overview: status, KPIs, resources, problems, changes, events, nodes (SPEC §4.1)',
        tags: ['overview', PUBLIC_TAG],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        querystring: Type.Object({
          /** Seconds; the KPIs compare with the period before. */
          range: Type.Optional(Type.Integer({ minimum: 300, maximum: MAX_RANGE_S })),
          namespaces: Type.Optional(
            Type.String({ maxLength: 4096, pattern: '^[a-z0-9]([-a-z0-9,]*[a-z0-9])?$' }),
          ),
        }),
        response: { 200: OverviewSchema, 401: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const cluster = await findCluster(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const range = request.query.range ?? 3600;
      const step = sparkStep(range);
      const nowMs = Date.now();
      const end = Math.floor(nowMs / 1000 / step) * step;
      const start = end - range;
      const namespaces = request.query.namespaces?.split(',').filter(Boolean).slice(0, 50);
      const failing = (await ingestFailures(db, [cluster.id], nowMs)).get(cluster.id) ?? null;
      const base = {
        cluster: { id: cluster.id, name: cluster.name, ingestFailure: failing },
        range,
        step,
      };
      const answer =
        cluster.kind === 'docker'
          ? { ...base, ...(await docker(cluster.id, cluster.name, range, step, start, end, nowMs)) }
          : {
              ...base,
              ...(await kubernetes(
                cluster.id,
                cluster.name,
                range,
                step,
                start,
                end,
                nowMs,
                namespaces,
              )),
            };
      if (causes && wantsCause(request)) {
        const ref = {
          id: cluster.id,
          name: cluster.name,
          kind: cluster.kind as 'kubernetes' | 'docker',
        };
        const items = answer.problems.items;
        const jobs = items.flatMap((p, i) => {
          // An agent that stopped reporting is where it starts: no cause line (ADR-159).
          if (p.ruleKey === NOT_REPORTING) return [];
          const subject = problemSubject(p, ref.kind);
          return subject ? [{ i, job: { cluster: ref, subject } }] : [];
        });
        const found = await causes.summaries(
          causeReader(app, request),
          request.user!.org.id,
          jobs.map((j) => j.job),
        );
        // The likely cause (ADR-155), else the state and the possible ones for the
        // Needs-attention line (ADR-156).
        jobs.forEach(({ i }, n) => {
          const s = found[n];
          if (!s) return;
          items[i] = {
            ...items[i]!,
            causeState: s.state,
            ...(s.likely ? { likelyCause: s.likely } : {}),
            ...(s.possible.length ? { possibleCauses: s.possible } : {}),
          };
        });
      }
      return answer;
    },
  );

  async function kubernetes(
    clusterId: string,
    clusterName: string,
    range: number,
    step: number,
    start: number,
    end: number,
    nowMs: number,
    namespaces: string[] | undefined,
  ) {
    const scope: QueryScope = namespaces ? { namespaces } : {};
    const ns = namespaces ? `namespace=~"${anyOf(namespaces)}"` : '';
    const sel = (...m: string[]) => `{${[...m, ns].filter(Boolean).join(',')}}`;
    const win = `${Math.max(60, 2 * step)}s`;
    const objects = (kinds: string[], filterNs = true) => {
      let q = db
        .selectFrom('objects')
        .select(['kind', 'namespace', 'name', 'node', 'spec_summary', 'status_summary'])
        .where('cluster_id', '=', clusterId)
        .where('source', '=', 'kubernetes')
        .where('kind', 'in', kinds)
        .where('deleted_at', 'is', null);
      if (filterNs && namespaces) q = q.where('namespace', 'in', namespaces);
      return q.execute() as Promise<ObjectRow[]>;
    };
    const usageCpu = namespaces
      ? `sum(${buildQuery('namespace.cpu.usage', scope, step).expr})`
      : `sum(${buildQuery('node.cpu.usage', {}, step).expr})`;
    const usageMem = namespaces
      ? `sum(${buildQuery('namespace.memory.working_set', scope, step).expr})`
      : `sum(${buildQuery('node.memory.used', {}, step).expr})`;
    const restarts = `watchlog_kube_pod_container_restarts_total${sel()}`;
    const flows = `watchlog_flow_connections_total${sel()}`;

    const [
      [nodes, pods, workloads, agents, alerting, alerts, inRange, recent, eventRows],
      instantR,
      rangeR,
    ] = await Promise.all([
      Promise.all([
        objects(['Node'], false),
        objects(['Pod']),
        objects(['Deployment', 'StatefulSet', 'DaemonSet'], false),
        agentRows(clusterId),
        alertingStatus(db, nowMs),
        firingAlerts(db, clusterId),
        markers(clusterId, new Date(start * 1000), new Date(end * 1000), namespaces),
        markers(clusterId, new Date(nowMs - CHANGES_WINDOW_MS), new Date(nowMs), namespaces, 8),
        (() => {
          let q = db
            .selectFrom('k8s_events')
            .select([
              'involved_kind',
              'namespace',
              'involved_name',
              'reason',
              'message',
              'count',
              'last_ts',
            ])
            .where('cluster_id', '=', clusterId)
            .where('type', '=', 'Warning')
            .where('last_ts', '>=', new Date(nowMs - range * 1000));
          if (namespaces) q = q.where('namespace', 'in', namespaces);
          return q.orderBy('last_ts', 'desc').limit(500).execute();
        })(),
      ] as const),
      instant(clusterId, [
        usageCpu,
        usageMem,
        `sum(increase(${restarts}[${range}s]))`,
        `sum(increase(${restarts}[${range}s] offset ${range}s))`,
        buildQuery('pvc.utilization', scope, 15).expr,
        buildQuery('node.cpu.usage', {}, 15).expr,
        buildQuery('node.memory.used', {}, 15).expr,
        buildQuery('pod.cpu.usage', scope, 15).expr,
        buildQuery('workload.cpu.usage', scope, 15).expr,
        buildQuery('workload.memory.working_set', scope, 15).expr,
        `sum(rate(${flows}[5m]))`,
        `sum(rate(watchlog_flow_connect_failed_total${sel()}[5m]))`,
        `histogram_quantile(0.95, sum by (le) (rate(watchlog_flow_connect_latency_seconds_bucket${sel()}[5m])))`,
        `sum(increase(${flows}[${range}s] offset ${range}s)) / ${range}`,
      ]),
      ranged(
        clusterId,
        [
          `sum(watchlog_kube_node_condition{condition="Ready",status="true"})`,
          `sum(watchlog_kube_pod_status_phase${sel('phase="Running"')})`,
          `sum(increase(${restarts}[${step}s]))`,
          `sum(rate(${flows}[${win}]))`,
          usageCpu,
          usageMem,
          `sum(rate(watchlog_node_network_bytes_total{dir="rx"}[${win}]))`,
          `sum(rate(watchlog_node_network_bytes_total{dir="tx"}[${win}]))`,
        ],
        start,
        end,
        step,
      ),
    ]);
    const [
      cpuNow,
      memNow,
      restartsNow,
      restartsPrev,
      pvc,
      nodeCpu,
      nodeMem,
      podCpu,
      wlCpu,
      wlMem,
      conns,
      failed,
      p95,
      connsPrev,
    ] = instantR;
    const [readySeries, runningSeries, restartSeries, trafficSeries, cpuSeries, memSeries, rx, tx] =
      rangeR;

    // Pods, requests and the pod → workload map.
    const podCounts = { running: 0, pending: 0, failed: 0, total: pods.length };
    let requestsCores = 0;
    let requestsBytes = 0;
    const podWorkload = new Map<string, string>();
    const podsPerNode = new Map<string, number>();
    const requestOf = new Map<string, { cpu: number; mem: number }>();
    for (const p of pods) {
      const st = p.status_summary as PodStatus;
      const spec = p.spec_summary as PodSpec & { workload?: { kind: string; name: string } };
      if (st.phase === 'Running') podCounts.running++;
      else if (st.phase === 'Pending') podCounts.pending++;
      else if (st.phase === 'Failed') podCounts.failed++;
      if (spec.workload?.name) podWorkload.set(`${p.namespace}/${p.name}`, spec.workload.name);
      if (!podIsActive(st)) continue;
      if (p.node) podsPerNode.set(p.node, (podsPerNode.get(p.node) ?? 0) + 1);
      const r = containerResources(spec.containers);
      requestsCores += r.cpuRequestCores;
      requestsBytes += r.memoryRequestBytes;
      requestOf.set(`${p.namespace}/${p.name}`, {
        cpu: r.cpuRequestCores,
        mem: r.memoryRequestBytes,
      });
    }
    let allocCores = 0;
    let allocBytes = 0;
    let ready = 0;
    let version: string | null = null;
    const nodeCpuBy = byLabels(nodeCpu!, 'node');
    const nodeMemBy = byLabels(nodeMem!, 'node');
    const nodeCaps = new Map(
      agents.filter((a) => a.mode === 'node').map((a) => [a.node, a.capabilities] as const),
    );
    const nodeCards = nodes
      .map((n) => {
        const st = n.status_summary as Record<string, unknown>;
        const capacity = nodeCapacity(
          st.allocatable as Record<string, string> | undefined,
          nodeCaps.get(n.name),
        );
        const cores = capacity.cores ?? 0;
        const bytes = capacity.bytes ?? 0;
        allocCores += cores;
        allocBytes += bytes;
        const isReady = nodeStatus(st) === 'Ready';
        if (isReady) ready++;
        version ??= (st.info as Record<string, string> | undefined)?.kubelet_version ?? null;
        const cpu = nodeCpuBy.get(key(n.name)) ?? null;
        const mem = nodeMemBy.get(key(n.name)) ?? null;
        return {
          name: n.name,
          ready: isReady,
          roles: ((n.spec_summary as { roles?: string[] | null }).roles ?? []) as string[],
          pods: podsPerNode.get(n.name) ?? 0,
          cpuRatio: cpu !== null && cores > 0 ? cpu / cores : null,
          memoryRatio: mem !== null && bytes > 0 ? mem / bytes : null,
        };
      })
      .sort((a, b) => Number(a.ready) - Number(b.ready) || a.name.localeCompare(b.name));

    // WatchLog's own workloads, to hide their events and mark them in tops.
    const own = watchlogComponents(
      workloads.map((w) => ({
        id: `w:${w.namespace}/${w.kind}/${w.name}`,
        group: w.namespace ?? '',
        name: w.name,
        images: ((w.spec_summary as { containers?: { image?: string }[] }).containers ?? []).map(
          (c) => c.image ?? '',
        ),
      })),
    );
    const ownWorkloads = new Set(
      workloads
        .filter((w) => own.has(`w:${w.namespace}/${w.kind}/${w.name}`))
        .map((w) => `${w.namespace}/${w.name}`),
    );
    const systemNs = systemNamespaces(
      await settings.namespaces(),
      [...ownWorkloads].map((k) => k.split('/')[0]!),
    );

    // Problems: one source for the strip and the list.
    const attention = needsAttention(
      nodes,
      pods,
      pvc!.flatMap((s) =>
        s.points[0]?.[1] == null
          ? []
          : [
              {
                namespace: s.labels.namespace ?? '',
                name: s.labels.persistentvolumeclaim ?? '',
                ratio: s.points[0][1],
              },
            ],
      ),
      nowMs,
      Number.POSITIVE_INFINITY,
    ).items;
    const problems = buildProblems({ alerts, attention, podWorkload, clusterName, now: nowMs });

    // Events: grouped; covered and WatchLog's own flagged for the page to hide.
    const coverage = {
      pods: new Set<string>(),
      workloads: new Set<string>(),
      nodes: new Set<string>(),
      podWorkload,
      ownWorkloads,
    };
    for (const a of alerts) {
      const l = a.labels;
      if (l.pod) coverage.pods.add(`${l.namespace}/${l.pod}`);
      if (l.workload) coverage.workloads.add(`${l.namespace}/${l.workload}`);
      if (l.node && !l.pod && !l.workload) coverage.nodes.add(l.node);
    }
    for (const p of problems.items) {
      const o = p.object;
      if (!o) continue;
      if (o.kind === 'Pod') {
        coverage.pods.add(`${o.namespace}/${o.name}`);
        const w = podWorkload.get(`${o.namespace}/${o.name}`);
        if (w) coverage.workloads.add(`${o.namespace}/${w}`);
      } else if (o.kind === 'Node') coverage.nodes.add(o.name);
    }
    const events = groupEvents(
      eventRows.map((e) => ({
        involvedKind: e.involved_kind,
        namespace: e.namespace,
        name: e.involved_name,
        reason: e.reason,
        message: e.message,
        count: e.count,
        lastSeen: e.last_ts,
      })),
      coverage,
    );

    // Top workloads by usage, with their request (sum over the workload's pods).
    const wlRequest = new Map<string, { cpu: number; mem: number }>();
    for (const [podKey, req] of requestOf) {
      const [podNs] = podKey.split('/');
      const w = podWorkload.get(podKey);
      if (!w) continue;
      const k = `${podNs}/${w}`;
      const cur = wlRequest.get(k) ?? { cpu: 0, mem: 0 };
      wlRequest.set(k, { cpu: cur.cpu + req.cpu, mem: cur.mem + req.mem });
    }
    const tops = (series: QuerySeries[], which: 'cpu' | 'mem') =>
      topWithSystem(
        series.flatMap((s) => {
          const v = s.points[0]?.[1];
          if (v == null || !s.labels.workload) return [];
          const k = `${s.labels.namespace}/${s.labels.workload}`;
          const req = wlRequest.get(k)?.[which];
          return [
            {
              kind: s.labels.workload_kind ?? 'Workload',
              namespace: s.labels.namespace ?? null,
              name: s.labels.workload,
              usage: v,
              request: req ? req : null,
              watchlog: ownWorkloads.has(k),
              system: systemNs.has(s.labels.namespace ?? ''),
            },
          ];
        }),
      );

    // Pod heatmap: CPU as a share of the pod's request; crash-looping marked.
    const podCpuBy = byLabels(podCpu!, 'namespace', 'pod');
    const heat = heatPods(
      pods.filter(
        (p) =>
          podIsActive(p.status_summary as PodStatus) ||
          (p.status_summary as PodStatus).phase === 'Running',
      ),
      (p) => !!podFailing(p.status_summary as PodStatus, nowMs),
    ).map((p) => {
      const st = p.status_summary as PodStatus;
      const cpu = podCpuBy.get(key(p.namespace, p.name)) ?? null;
      const req = requestOf.get(`${p.namespace}/${p.name}`)?.cpu ?? 0;
      const w = podWorkload.get(`${p.namespace}/${p.name}`);
      return {
        namespace: p.namespace,
        name: p.name,
        node: p.node,
        cpu,
        cpuRequest: req > 0 ? req : null,
        cpuRatio: cpu !== null && req > 0 ? cpu / req : null,
        failing: podFailing(st, nowMs),
        watchlog: !!w && ownWorkloads.has(`${p.namespace}/${w}`),
      };
    });

    const reporting = agents.filter(
      (a) => a.mode === 'node' && nowMs - a.last_seen_at.getTime() <= CLUSTER_STALE_MS,
    ).length;
    const ca = agents
      .filter((a) => a.mode === 'cluster')
      .sort((a, b) => b.last_seen_at.getTime() - a.last_seen_at.getTime())[0];
    const connsNow = first(conns);
    const traffic =
      ebpfOf(agents) === 'off'
        ? null
        : {
            connectionsPerSecond: connsNow ?? 0,
            previous: first(connsPrev),
            failedRatio: connsNow ? Math.min(1, (first(failed) ?? 0) / connsNow) : null,
            p95Seconds: first(p95),
            series: points(trafficSeries),
          };
    return {
      kind: 'kubernetes' as const,
      facts: {
        kubernetesVersion: version,
        dockerVersions: [],
        nodes: nodes.length,
        agents: { reporting, expected: nodes.length },
        clusterAgent: !ca
          ? ('missing' as const)
          : nowMs - ca.last_seen_at.getTime() <= CLUSTER_STALE_MS
            ? ('active' as const)
            : ('inactive' as const),
        ebpf: ebpfOf(agents),
        alertingRunning: alerting.running,
      },
      health: health(problems, alerting.running),
      problems,
      kpis: {
        nodes: { ready, total: nodes.length, series: points(readySeries) },
        pods: { ...podCounts, series: points(runningSeries) },
        restarts: {
          total: first(restartsNow),
          previous: first(restartsPrev),
          series: points(restartSeries),
        },
        traffic,
        cpu: { usage: first(cpuNow), requests: requestsCores, allocatable: allocCores },
        memory: { usage: first(memNow), requests: requestsBytes, allocatable: allocBytes },
      },
      resources: {
        cpu: { usage: points(cpuSeries), requests: requestsCores, allocatable: allocCores },
        memory: { usage: points(memSeries), requests: requestsBytes, allocatable: allocBytes },
        network: { received: points(rx), sent: points(tx) },
      },
      markers: inRange.reverse(),
      changes: recent,
      top: { cpu: tops(wlCpu!, 'cpu'), memory: tops(wlMem!, 'mem') },
      events,
      nodes: nodeCards,
      pods: heat,
    };
  }

  async function docker(
    clusterId: string,
    clusterName: string,
    range: number,
    step: number,
    start: number,
    end: number,
    nowMs: number,
  ) {
    const win = `${Math.max(60, 2 * step)}s`;
    const restarts = `watchlog_container_restarts_total`;
    const flows = `watchlog_flow_connections_total`;
    const cpuUsed = `sum(rate(watchlog_node_cpu_seconds_total{mode!="idle"}[${win}]))`;
    const memUsed = `sum(watchlog_node_memory_bytes{state="total"}) - sum(watchlog_node_memory_bytes{state="available"})`;
    const [
      [agents, alerting, alerts, containers, hostRows, inRange, recent, eventRows],
      instantR,
      rangeR,
      boots,
    ] = await Promise.all([
      Promise.all([
        agentRows(clusterId),
        alertingStatus(db, nowMs),
        firingAlerts(db, clusterId),
        db
          .selectFrom('objects')
          .select(['node', 'name', 'namespace', 'spec_summary', 'status_summary'])
          .where('cluster_id', '=', clusterId)
          .where('kind', '=', 'DockerContainer')
          .where('deleted_at', 'is', null)
          .execute(),
        db
          .selectFrom('objects')
          .select(['name', 'spec_summary'])
          .where('cluster_id', '=', clusterId)
          .where('kind', '=', 'DockerHost')
          .where('deleted_at', 'is', null)
          .execute(),
        markers(clusterId, new Date(start * 1000), new Date(end * 1000)),
        markers(clusterId, new Date(nowMs - CHANGES_WINDOW_MS), new Date(nowMs), undefined, 8),
        db
          .selectFrom('k8s_events')
          .select([
            'involved_kind',
            'namespace',
            'involved_name',
            'reason',
            'message',
            'count',
            'last_ts',
          ])
          .where('cluster_id', '=', clusterId)
          .where('type', '=', 'Warning')
          .where('last_ts', '>=', new Date(nowMs - range * 1000))
          .orderBy('last_ts', 'desc')
          .limit(500)
          .execute(),
      ] as const),
      instant(clusterId, [
        `sum(rate(watchlog_node_cpu_seconds_total{mode!="idle"}[2m]))`,
        memUsed,
        // Each host reports its CPU count (its CPU-time series are not per CPU).
        `sum(max by (host) (watchlog_node_cpu_count))`,
        `sum(watchlog_node_memory_bytes{state="total"})`,
        `sum(increase(${restarts}[${range}s]))`,
        `sum(increase(${restarts}[${range}s] offset ${range}s))`,
        buildQuery('host.cpu.utilization', {}, 15).expr,
        buildQuery('host.memory.utilization', {}, 15).expr,
        buildQuery('container.cpu.usage', {}, 15).expr,
        buildQuery('container.memory.working_set', {}, 15).expr,
        `sum(rate(${flows}[5m]))`,
        `sum(rate(watchlog_flow_connect_failed_total[5m]))`,
        `histogram_quantile(0.95, sum by (le) (rate(watchlog_flow_connect_latency_seconds_bucket[5m])))`,
        `sum(increase(${flows}[${range}s] offset ${range}s)) / ${range}`,
        buildQuery('container.cpu.limit', {}, 15).expr,
      ]),
      ranged(
        clusterId,
        [
          `count(count by (host) (watchlog_node_cpu_seconds_total))`,
          `count(watchlog_container_state{state="running"} == 1)`,
          `sum(increase(${restarts}[${step}s]))`,
          `sum(rate(${flows}[${win}]))`,
          cpuUsed,
          memUsed,
          `sum(rate(watchlog_node_network_bytes_total{dir="rx"}[${win}]))`,
          `sum(rate(watchlog_node_network_bytes_total{dir="tx"}[${win}]))`,
        ],
        start,
        end,
        step,
      ),
      hostBoots((e) => instant(clusterId, [e]).then((r) => r[0] ?? []), nowMs / 1000),
    ]);
    const [
      cpuNow,
      memNow,
      cores,
      memTotal,
      restartsNow,
      restartsPrev,
      hostCpu,
      hostMem,
      cCpu,
      cMem,
      conns,
      failed,
      p95,
      connsPrev,
      cLimit,
    ] = instantR;
    const [hostsSeries, runningSeries, restartSeries, trafficSeries, cpuSeries, memSeries, rx, tx] =
      rangeR;

    const hostAgents = agents.filter((a) => a.mode === 'docker');
    const hosts = [
      ...new Set([...hostAgents.map((a) => a.node), ...containers.map((c) => c.node)]),
    ].sort();
    const liveHosts = new Set(
      hostAgents
        .filter((a) => nowMs - a.last_seen_at.getTime() <= CLUSTER_STALE_MS)
        .map((a) => a.node),
    );
    const reporting = liveHosts.size;
    // Containers their host's reboot or their daemon's restart stopped (ADR-159).
    const withHost = stoppedWithHost(containers, boots);
    // Docker: running, stopped (as "pending") and unhealthy (as "failed").
    const counts = { running: 0, pending: 0, failed: 0, total: containers.length };
    const perHost = new Map<string, number>();
    const own = watchlogComponents(
      containers.map((c) => ({
        id: `c:${c.name}`,
        group: c.node,
        name: c.name,
        images: [(c.spec_summary as { image?: string }).image ?? ''],
      })),
    );
    for (const c of containers) {
      const st = c.status_summary as { state?: string; health?: string };
      if (st.state === 'running' || st.state === 'restarting') {
        counts.running++;
        perHost.set(c.node, (perHost.get(c.node) ?? 0) + 1);
      } else counts.pending++;
      if (st.health === 'unhealthy') counts.failed++;
    }
    const problems = buildProblems({
      alerts,
      attention: [],
      podWorkload: new Map(),
      clusterName,
      now: nowMs,
      objects: dockerProblems(
        containers,
        alerts,
        clusterName,
        nowMs,
        undefined,
        liveHosts,
        withHost,
      ),
    });
    // Warning events, grouped; covered (a problem names the container) and WatchLog's own
    // containers flagged, as for Kubernetes.
    const covered = new Set(
      problems.items.flatMap((p) =>
        p.object?.kind === 'Container'
          ? [p.object.name]
          : alerts.filter((a) => a.id === p.alertId).map((a) => a.labels.container ?? ''),
      ),
    );
    const events = groupEvents(
      eventRows.map((e) => ({
        involvedKind: e.involved_kind,
        namespace: e.namespace,
        name: e.involved_name,
        reason: e.reason,
        message: e.message,
        count: e.count,
        lastSeen: e.last_ts,
      })),
      {
        pods: new Set(),
        workloads: new Set(),
        nodes: new Set(),
        podWorkload: new Map(),
        ownWorkloads: new Set(),
      },
    ).map((g) => ({
      ...g,
      covered: g.kind === 'Container' && covered.has(g.name),
      watchlog: g.kind === 'Container' && own.has(`c:${g.name}`),
    }));
    const cpuBy = byLabels(hostCpu!, 'host');
    const memBy = byLabels(hostMem!, 'host');
    const limitBy = byLabels(cLimit!, 'host', 'container');
    const hideOwn = (await settings.namespaces()).watchlog;
    const tops = (series: QuerySeries[], limits?: Map<string, number | null>) =>
      topWithSystem(
        series.flatMap((s) => {
          const v = s.points[0]?.[1];
          if (v == null || !s.labels.container) return [];
          return [
            {
              kind: 'Container',
              namespace: s.labels.host ?? null,
              name: s.labels.container,
              usage: v,
              request: limits?.get(key(s.labels.host, s.labels.container)) ?? null,
              watchlog: own.has(`c:${s.labels.container}`),
              system: hideOwn && own.has(`c:${s.labels.container}`),
            },
          ];
        }),
      );
    const cCpuBy = byLabels(cCpu!, 'host', 'container');
    const failingOf = (c: (typeof containers)[number]) => {
      const p = dockerProblem(
        c.status_summary as Parameters<typeof dockerProblem>[0],
        nowMs,
        undefined,
        withHost.get(`${c.node}\u0000${c.name}`),
      );
      return p ? (FAILING[p.ruleKey] ?? null) : null;
    };
    const connsNow = first(conns);
    return {
      kind: 'docker' as const,
      facts: {
        kubernetesVersion: null,
        dockerVersions: [
          ...new Set(
            hostRows
              .map((h) => (h.spec_summary as { docker_version?: string }).docker_version)
              .filter((v): v is string => !!v),
          ),
        ].sort(),
        nodes: hosts.length,
        agents: { reporting, expected: hosts.length },
        clusterAgent: 'none' as const,
        ebpf: ebpfOf(agents),
        alertingRunning: alerting.running,
      },
      health: health(problems, alerting.running),
      problems,
      kpis: {
        nodes: { ready: reporting, total: hosts.length, series: points(hostsSeries) },
        pods: { ...counts, series: points(runningSeries) },
        restarts: {
          total: first(restartsNow),
          previous: first(restartsPrev),
          series: points(restartSeries),
        },
        traffic:
          ebpfOf(agents) === 'off'
            ? null
            : {
                connectionsPerSecond: connsNow ?? 0,
                previous: first(connsPrev),
                failedRatio: connsNow ? Math.min(1, (first(failed) ?? 0) / connsNow) : null,
                p95Seconds: first(p95),
                series: points(trafficSeries),
              },
        cpu: { usage: first(cpuNow), requests: null, allocatable: first(cores) },
        memory: { usage: first(memNow), requests: null, allocatable: first(memTotal) },
      },
      resources: {
        cpu: { usage: points(cpuSeries), requests: null, allocatable: first(cores) },
        memory: { usage: points(memSeries), requests: null, allocatable: first(memTotal) },
        network: { received: points(rx), sent: points(tx) },
      },
      markers: inRange.reverse(),
      changes: recent,
      top: { cpu: tops(cCpu!, limitBy), memory: tops(cMem!) },
      events,
      nodes: hosts.map((h) => ({
        name: h,
        ready: hostAgents.some(
          (a) => a.node === h && nowMs - a.last_seen_at.getTime() <= CLUSTER_STALE_MS,
        ),
        roles: ['docker'],
        pods: perHost.get(h) ?? 0,
        cpuRatio: cpuBy.get(key(h)) ?? null,
        memoryRatio: memBy.get(key(h)) ?? null,
      })),
      // Running containers; colour = CPU against the limit, or one core without one.
      pods: heatPods(
        containers.filter((c) => {
          const st = c.status_summary as { state?: string };
          return st.state === 'running' || st.state === 'restarting' || !!failingOf(c);
        }),
        (c) => !!failingOf(c),
      ).map((c) => {
        const cpu = cCpuBy.get(key(c.node, c.name)) ?? null;
        const lim = limitBy.get(key(c.node, c.name)) ?? null;
        return {
          namespace: c.node,
          name: c.name,
          node: c.node,
          cpu,
          cpuRequest: lim,
          cpuRatio: cpu !== null ? cpu / (lim || 1) : null,
          failing: failingOf(c),
          watchlog: own.has(`c:${c.name}`),
        };
      }),
    };
  }
};
