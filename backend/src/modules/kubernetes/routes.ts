// SPDX-License-Identifier: AGPL-3.0-only
// Kubernetes read API (SPEC §4.1–§4.3, §4.6, §8.1): overview, nodes, workloads, pods,
// events, change markers and namespaces, from the cluster-agent's objects and events
// and the agents' series.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { sql, type Selectable } from 'kysely';
import { Type, type Static } from 'typebox';
import type { Database } from '../../db/index.js';
import type { K8sEvents } from '../../db/types.js';
import { sendProblem } from '../../lib/problem.js';
import type { ClusterScope, QuerySeries, VictoriaQueryClient } from '../../lib/victoria.js';
import { requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { CLUSTER_STALE_MS, clusterForOrg } from '../clusters/service.js';
import { firingAlerts } from '../overview/problems.js';
import { sparkStep } from '../overview/step.js';
import { anyOf, buildQuery, type QueryScope } from '../query/catalog.js';
import { watchlogComponents } from '../servicemap/graph.js';
import { systemNamespaces, type SettingsService } from '../settings/service.js';
import { eventSummary, eventWhere, isClusterScoped, type EventFilter } from './events.js';
import { lastRuns, workloadKey, workloadProblems } from './workload-problems.js';
import {
  ContainerSchema,
  EventSchema,
  MarkerSchema,
  NodeSchema,
  NodeRowSchema,
  PodSchema,
  WorkloadRowSchema,
} from './schemas.js';
import {
  containerResources,
  containerViews,
  nodeView,
  podFailing,
  podIsActive,
  podView,
  workloadView,
  WORKLOAD_KINDS,
  type AgentInfo,
  type ObjectRow,
  type PodSpec,
  type PodStatus,
  type Usage,
} from './views.js';
import { PUBLIC_TAG } from '../../openapi/public.js';

const Params = Type.Object({ id: Type.String({ format: 'uuid' }) });
const Name = Type.String({ minLength: 1, maxLength: 253 });
/** Comma-separated namespaces (the top bar's filter). */
const Namespaces = Type.Optional(
  Type.String({ maxLength: 4096, pattern: '^[a-z0-9]([-a-z0-9,]*[a-z0-9])?$' }),
);
const Errors = { 401: ProblemSchema, 404: ProblemSchema };

const EVENTS_PAGE = 100;
const MAX_EVENTS_PAGE = 500;
const MARKERS_LIMIT = 1000;
const MAX_RANGE_MS = 31 * 86400_000;

function splitNamespaces(v: string | undefined): string[] | undefined {
  const list = v
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list?.length ? [...new Set(list)].slice(0, 50) : undefined;
}

const key = (...parts: string[]) => parts.join('\u0000');

interface HeatPod {
  namespace: string;
  name: string;
  cpu: number | null;
  cpuRequest: number | null;
  cpuRatio: number | null;
  failing: string | null;
}

/** Latest value per label tuple of an instant query. */
function byLabels(series: QuerySeries[], ...labels: string[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const s of series)
    out.set(key(...labels.map((l) => s.labels[l] ?? '')), s.points[0]?.[1] ?? null);
  return out;
}

/**
 * One disk figure per node: the root filesystem, else /var (kind nodes run on an
 * overlay root the agent skips; /var holds the kubelet's data), else the fullest mount.
 */
function nodeDisk(series: QuerySeries[]): Map<string, number | null> {
  const mounts = new Map<string, Map<string, number>>();
  for (const s of series) {
    const v = s.points[0]?.[1];
    if (v == null || !s.labels.node || !s.labels.mount) continue;
    const m = mounts.get(s.labels.node) ?? new Map<string, number>();
    m.set(s.labels.mount, v);
    mounts.set(s.labels.node, m);
  }
  const out = new Map<string, number | null>();
  for (const [node, m] of mounts) {
    out.set(node, m.get('/') ?? m.get('/var') ?? Math.max(...m.values()));
  }
  return out;
}

function eventView(e: Selectable<K8sEvents>) {
  return {
    type: e.type,
    reason: e.reason,
    message: e.message,
    count: e.count,
    firstSeen: e.first_ts.toISOString(),
    lastSeen: e.last_ts.toISOString(),
    // Cluster-scoped objects (nodes) have no namespace, whatever the event's own says.
    namespace: isClusterScoped(e.involved_kind) ? null : e.namespace || null,
    host: e.host || null,
    involvedKind: e.involved_kind,
    involvedName: e.involved_name,
    reportingController: e.reporting_controller || null,
  };
}

function encodeCursor(e: Selectable<K8sEvents>): string {
  return Buffer.from(JSON.stringify([e.last_ts.toISOString(), e.involved_key, e.reason])).toString(
    'base64url',
  );
}

function decodeCursor(c: string): [string, string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(v) &&
      v.length === 3 &&
      v.every((x) => typeof x === 'string') &&
      !Number.isNaN(Date.parse(v[0] as string))
    ) {
      return v as [string, string, string];
    }
  } catch {
    // fall through
  }
  return null;
}

export const kubernetesRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  victoria?: VictoriaQueryClient;
  settings: SettingsService;
}> = async (app, { db, victoria, settings }) => {
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

  /** The system namespaces: the setting, plus the namespaces WatchLog's workloads run in. */
  async function systemNs(workloads: ObjectRow[]): Promise<Set<string>> {
    const own = watchlogComponents(
      workloads.map((w) => ({
        id: `${w.namespace}/${w.kind}/${w.name}`,
        group: w.namespace,
        name: w.name,
        images: ((w.spec_summary as { containers?: { image?: string }[] }).containers ?? []).map(
          (c) => c.image ?? '',
        ),
      })),
    );
    return systemNamespaces(
      await settings.namespaces(),
      [...own].map((id) => id.split('/')[0]!),
    );
  }

  /** Instant queries; metrics are optional, so storage errors return no values. */
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

  function objects(clusterId: string, kinds: string[], namespaces?: string[]) {
    let q = db
      .selectFrom('objects')
      .select(['kind', 'namespace', 'name', 'node', 'spec_summary', 'status_summary'])
      .where('cluster_id', '=', clusterId)
      .where('source', '=', 'kubernetes')
      .where('kind', 'in', kinds)
      .where('deleted_at', 'is', null);
    if (namespaces) q = q.where('namespace', 'in', namespaces);
    return q.orderBy('namespace').orderBy('name').execute() as Promise<ObjectRow[]>;
  }

  async function nodeAgents(clusterId: string): Promise<Map<string, AgentInfo>> {
    const rows = await db
      .selectFrom('agent_instances')
      .selectAll()
      .where('cluster_id', '=', clusterId)
      .where('mode', '=', 'node')
      .execute();
    const now = Date.now();
    return new Map(
      rows.map((a) => [
        a.node,
        {
          version: a.agent_version,
          capabilities: a.capabilities,
          lastSeenAt: a.last_seen_at,
          active: now - a.last_seen_at.getTime() <= CLUSTER_STALE_MS,
        },
      ]),
    );
  }

  async function podUsage(cluster: ClusterScope, scope: QueryScope): Promise<Map<string, Usage>> {
    const [cpu, mem] = await instant(cluster, [
      buildQuery('pod.cpu.usage', scope, 15).expr,
      buildQuery('pod.memory.working_set', scope, 15).expr,
    ]);
    const cpuBy = byLabels(cpu!, 'namespace', 'pod');
    const memBy = byLabels(mem!, 'namespace', 'pod');
    const out = new Map<string, Usage>();
    for (const k of new Set([...cpuBy.keys(), ...memBy.keys()])) {
      out.set(k, { cpuCores: cpuBy.get(k) ?? null, memoryBytes: memBy.get(k) ?? null });
    }
    return out;
  }

  async function nodeMetrics(cluster: ClusterScope, scope: QueryScope) {
    const [cpu, mem, disk] = await instant(cluster, [
      buildQuery('node.cpu.usage', scope, 15).expr,
      buildQuery('node.memory.used', scope, 15).expr,
      buildQuery('node.filesystem.utilization', scope, 15).expr,
    ]);
    const cpuBy = byLabels(cpu!, 'node');
    const memBy = byLabels(mem!, 'node');
    const diskBy = nodeDisk(disk!);
    return (name: string) => ({
      cpuCores: cpuBy.get(name) ?? null,
      memoryBytes: memBy.get(name) ?? null,
      diskUtilization: diskBy.get(name) ?? null,
    });
  }

  function recentEvents(
    clusterId: string,
    filter: { namespaces?: string[]; type?: string; kind?: string; name?: string; since?: Date },
    limit: number,
  ) {
    let q = db.selectFrom('k8s_events').selectAll().where('cluster_id', '=', clusterId);
    if (filter.since) q = q.where('last_ts', '>=', filter.since);
    if (filter.namespaces) q = q.where('namespace', 'in', filter.namespaces);
    if (filter.type) q = q.where('type', '=', filter.type);
    if (filter.kind) q = q.where('involved_kind', '=', filter.kind);
    if (filter.name) q = q.where('involved_name', '=', filter.name);
    return q.orderBy('last_ts', 'desc').limit(limit).execute();
  }

  app.get(
    '/clusters/:id/nodes',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Nodes with status, usage, requests, allocatable, disks and trends (SPEC §4.2)',
        tags: ['kubernetes', PUBLIC_TAG],
        params: Params,
        querystring: Type.Object({
          /** Seconds of history for the CPU and memory sparklines (default 1 h). */
          range: Type.Optional(Type.Integer({ minimum: 300, maximum: 7 * 86400 })),
          /** Include each node's pods for the heatmap. */
          heat: Type.Optional(Type.Literal('1')),
        }),
        response: {
          200: Type.Object({
            nodes: Type.Array(NodeRowSchema),
            range: Type.Integer(),
            step: Type.Integer(),
            /** Firing disk alerts, so the fullest disk can link to its alert. */
            diskAlerts: Type.Array(
              Type.Object({
                node: Type.String(),
                mount: Type.Union([Type.String(), Type.Null()]),
                alertId: Type.String(),
              }),
            ),
          }),
          ...Errors,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const range = request.query.range ?? 3600;
      const heat = request.query.heat === '1';
      const step = sparkStep(range);
      const now = Date.now();
      const end = Math.floor(now / 1000 / step) * step;
      const [nodes, pods, agents, alerts, [cpu, mem, disk, size, boot, podCpu], [cpuR, memR]] =
        await Promise.all([
          objects(cluster.id, ['Node']),
          objects(cluster.id, ['Pod']),
          nodeAgents(cluster.id),
          firingAlerts(db, cluster.id),
          instant(cluster.scope, [
            buildQuery('node.cpu.usage', {}, 15).expr,
            buildQuery('node.memory.used', {}, 15).expr,
            buildQuery('node.filesystem.utilization', {}, 15).expr,
            'sum by (node, mount) (watchlog_node_filesystem_bytes{state="size"})',
            'max by (node) (watchlog_node_boot_time_seconds)',
            ...(heat ? [buildQuery('pod.cpu.usage', {}, 15).expr] : []),
          ]),
          ranged(
            cluster.scope,
            [
              buildQuery('node.cpu.usage', {}, step).expr,
              buildQuery('node.memory.used', {}, step).expr,
            ],
            end - range,
            end,
            step,
          ),
        ]);
      const cpuBy = byLabels(cpu!, 'node');
      const memBy = byLabels(mem!, 'node');
      const diskBy = nodeDisk(disk!);
      const sizeBy = byLabels(size!, 'node', 'mount');
      const bootBy = byLabels(boot!, 'node');
      const mounts = new Map<
        string,
        { mount: string; utilization: number; sizeBytes: number | null }[]
      >();
      for (const s of disk!) {
        const v = s.points[0]?.[1];
        const node = s.labels.node;
        const mount = s.labels.mount;
        if (v == null || !node || !mount) continue;
        const list = mounts.get(node) ?? [];
        list.push({ mount, utilization: v, sizeBytes: sizeBy.get(key(node, mount)) ?? null });
        mounts.set(node, list);
      }
      const seriesBy = (r: QuerySeries[]) =>
        new Map(r.map((s) => [s.labels.node ?? '', s.points] as const));
      const cpuSeries = seriesBy(cpuR!);
      const memSeries = seriesBy(memR!);
      const podCpuBy = heat ? byLabels(podCpu!, 'namespace', 'pod') : new Map();
      const heatBy = new Map<string, HeatPod[]>();
      if (heat)
        for (const p of pods) {
          const st = p.status_summary as PodStatus;
          if (!p.node || !podIsActive(st)) continue;
          const c = podCpuBy.get(key(p.namespace, p.name)) ?? null;
          const req = containerResources((p.spec_summary as PodSpec).containers).cpuRequestCores;
          const list = heatBy.get(p.node) ?? [];
          list.push({
            namespace: p.namespace,
            name: p.name,
            cpu: c,
            cpuRequest: req > 0 ? req : null,
            cpuRatio: c !== null && req > 0 ? c / req : null,
            failing: podFailing(st, now),
          });
          heatBy.set(p.node, list);
        }
      return {
        range,
        step,
        diskAlerts: alerts
          .filter((a) => !a.silenced && a.ruleKey === 'node.disk.usage' && a.labels.node)
          .map((a) => ({ node: a.labels.node!, mount: a.labels.mount ?? null, alertId: a.id })),
        nodes: nodes.map((n) => {
          const view = nodeView(
            n,
            pods,
            {
              cpuCores: cpuBy.get(key(n.name)) ?? null,
              memoryBytes: memBy.get(key(n.name)) ?? null,
              diskUtilization: diskBy.get(n.name) ?? null,
            },
            agents.get(n.name),
          );
          return {
            ...view,
            readySince: view.conditions.find((c) => c.type === 'Ready')?.since ?? null,
            bootTime: bootBy.get(key(n.name)) ?? null,
            disks: (mounts.get(n.name) ?? []).sort((a, b) => b.utilization - a.utilization),
            cpuSeries: cpuSeries.get(n.name) ?? [],
            memorySeries: memSeries.get(n.name) ?? [],
            ...(heat ? { heat: heatBy.get(n.name) ?? [] } : {}),
          };
        }),
      };
    },
  );

  app.get(
    '/clusters/:id/nodes/:name',
    {
      preHandler: signedIn,
      schema: {
        summary: 'One node with its pods and events (SPEC §4.2)',
        tags: ['kubernetes', PUBLIC_TAG],
        params: Type.Object({ id: Type.String({ format: 'uuid' }), name: Name }),
        response: {
          200: Type.Object({
            node: NodeSchema,
            labels: Type.Record(Type.String(), Type.String()),
            pods: Type.Array(PodSchema),
            events: Type.Array(EventSchema),
          }),
          ...Errors,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const { name } = request.params;
      const [node] = (await objects(cluster.id, ['Node'])).filter((n) => n.name === name);
      if (!node) return sendProblem(reply, 404, 'Node not found');
      const podRows = (await db
        .selectFrom('objects')
        .select(['kind', 'namespace', 'name', 'node', 'spec_summary', 'status_summary'])
        .where('cluster_id', '=', cluster.id)
        .where('kind', '=', 'Pod')
        .where('node', '=', name)
        .where('deleted_at', 'is', null)
        .orderBy('namespace')
        .orderBy('name')
        .execute()) as ObjectRow[];
      const [agents, metrics, usage, events] = await Promise.all([
        nodeAgents(cluster.id),
        nodeMetrics(cluster.scope, { node: name }),
        podUsage(cluster.scope, { node: name }),
        recentEvents(cluster.id, { kind: 'Node', name }, 50),
      ]);
      return {
        node: nodeView(node, podRows, metrics(name), agents.get(name)),
        labels:
          ((node.spec_summary as Record<string, unknown>).labels as Record<string, string>) ?? {},
        pods: podRows.map((p) => podView(p, usage.get(key(p.namespace, p.name)))),
        events: events.map(eventView),
      };
    },
  );

  app.get(
    '/clusters/:id/workloads',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Deployments, StatefulSets, DaemonSets, Jobs and CronJobs (SPEC §4.3)',
        tags: ['kubernetes', PUBLIC_TAG],
        params: Params,
        querystring: Type.Object({
          namespaces: Namespaces,
          kind: Type.Optional(Type.Union(WORKLOAD_KINDS.map((k) => Type.Literal(k)))),
          /** Seconds of history for the CPU sparkline and restarts (default 1 h). */
          range: Type.Optional(Type.Integer({ minimum: 300, maximum: 7 * 86400 })),
        }),
        response: {
          200: Type.Object({
            workloads: Type.Array(WorkloadRowSchema),
            range: Type.Integer(),
            step: Type.Integer(),
            systemNamespaces: Type.Array(Type.String()),
          }),
          ...Errors,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const namespaces = splitNamespaces(request.query.namespaces);
      const kinds = request.query.kind ? [request.query.kind] : [...WORKLOAD_KINDS];
      const scope: QueryScope = namespaces ? { namespaces } : {};
      const range = request.query.range ?? 3600;
      const step = sparkStep(range);
      const now = Date.now();
      const end = Math.floor(now / 1000 / step) * step;
      const ns = namespaces ? `{namespace=~"${anyOf(namespaces)}"}` : '';
      const by = 'namespace, workload_kind, workload';
      const [rows, podRows, jobRows, hpaRows, rollouts, alerts, hpaEvents, [cpu, mem, restarts]] =
        await Promise.all([
          objects(cluster.id, kinds, namespaces),
          objects(cluster.id, ['Pod'], namespaces),
          objects(cluster.id, ['Job'], namespaces),
          objects(cluster.id, ['HorizontalPodAutoscaler'], namespaces),
          db
            .selectFrom('change_markers')
            .select(['target', sql<Date>`max(ts)`.as('ts')])
            .where('cluster_id', '=', cluster.id)
            .where('kind', 'in', ['rollout', 'image'])
            .groupBy('target')
            .execute(),
          firingAlerts(db, cluster.id),
          recentEvents(
            cluster.id,
            {
              ...(namespaces ? { namespaces } : {}),
              type: 'Warning',
              kind: 'HorizontalPodAutoscaler',
              since: new Date(now - 3600_000),
            },
            500,
          ),
          instant(cluster.scope, [
            buildQuery('workload.cpu.usage', scope, 15).expr,
            buildQuery('workload.memory.working_set', scope, 15).expr,
            `sum by (${by}) (increase(watchlog_kube_pod_container_restarts_total${ns}[${range}s]))`,
          ]),
        ]);
      const [[cpuRange], system] = await Promise.all([
        ranged(
          cluster.scope,
          [buildQuery('workload.cpu.usage', scope, step).expr],
          end - range,
          end,
          step,
        ),
        systemNs(rows),
      ]);
      const cpuBy = byLabels(cpu!, 'namespace', 'workload_kind', 'workload');
      const memBy = byLabels(mem!, 'namespace', 'workload_kind', 'workload');
      const restartsBy = byLabels(restarts!, 'namespace', 'workload_kind', 'workload');
      const seriesBy = new Map(
        cpuRange!.map((s) => [
          key(s.labels.namespace ?? '', s.labels.workload_kind ?? '', s.labels.workload ?? ''),
          s.points,
        ]),
      );
      const rolloutBy = new Map(rollouts.map((r) => [r.target, new Date(r.ts).toISOString()]));
      const podsBy = new Map<string, ObjectRow[]>();
      for (const p of podRows) {
        const w = (p.spec_summary as PodSpec).workload;
        if (!w) continue;
        const k = key(p.namespace, w.kind, w.name);
        const list = podsBy.get(k);
        if (list) list.push(p);
        else podsBy.set(k, [p]);
      }
      // Jobs a CronJob started are shown as its last run, not as rows of their own.
      const listed = rows.filter(
        (r) => r.kind !== 'Job' || !(r.spec_summary as { cronjob?: string }).cronjob,
      );
      const views = listed.map((r) => {
        const k = key(r.namespace, r.kind, r.name);
        return workloadView(
          r,
          (podsBy.get(k) ?? []).map((p) => podView(p, undefined, now)),
          { cpuCores: cpuBy.get(k) ?? null, memoryBytes: memBy.get(k) ?? null },
          rolloutBy.get(`${r.kind}/${r.namespace}/${r.name}`) ?? null,
        );
      });
      const runs = lastRuns(jobRows);
      const problems = workloadProblems({
        alerts,
        workloads: views,
        pods: podRows,
        hpas: hpaRows,
        hpaEvents: hpaEvents.map((e) => ({
          namespace: e.namespace,
          name: e.involved_name,
          reason: e.reason,
        })),
        runs,
        clusterName: cluster.name,
        now,
      });
      const ORDER = { ready: 0, starting: 1, failing: 2 } as const;
      return {
        range,
        step,
        systemNamespaces: [...system].sort(),
        workloads: views.map((w) => {
          const k = key(w.namespace, w.kind, w.name);
          const wk = workloadKey(w.namespace, w.kind, w.name);
          const restartsNow = restartsBy.get(k);
          return {
            ...w,
            problem: problems.get(wk) ?? null,
            podStates: (podsBy.get(k) ?? [])
              .filter((p) => podIsActive(p.status_summary as PodStatus))
              .map((p) => {
                const st = p.status_summary as PodStatus;
                return podFailing(st, now) ? 'failing' : st.ready ? 'ready' : 'starting';
              })
              .sort((a, b) => ORDER[a] - ORDER[b]),
            restartsInRange: restartsNow == null ? null : Math.round(restartsNow),
            cpuSeries: seriesBy.get(k) ?? [],
            system: system.has(w.namespace),
            lastRun: w.kind === 'CronJob' ? (runs.get(wk) ?? null) : null,
          };
        }),
      };
    },
  );

  app.get(
    '/clusters/:id/pods',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Pods with status, last termination and usage (SPEC §4.3)',
        tags: ['kubernetes', PUBLIC_TAG],
        params: Params,
        querystring: Type.Object({
          namespaces: Namespaces,
          node: Type.Optional(Name),
          workloadKind: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
          workload: Type.Optional(Name),
        }),
        response: {
          200: Type.Object({
            pods: Type.Array(PodSchema),
            systemNamespaces: Type.Array(Type.String()),
          }),
          ...Errors,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const { node, workloadKind, workload } = request.query;
      const namespaces = splitNamespaces(request.query.namespaces);
      const scope: QueryScope = {
        ...(namespaces ? { namespaces } : {}),
        ...(node ? { node } : {}),
        ...(workloadKind ? { workloadKind } : {}),
        ...(workload ? { workload } : {}),
      };
      const now = Date.now();
      const [rows, usage, system] = await Promise.all([
        objects(cluster.id, ['Pod'], namespaces),
        podUsage(cluster.scope, scope),
        objects(cluster.id, [...WORKLOAD_KINDS], namespaces).then(systemNs),
      ]);
      const pods = rows
        .filter((p) => !node || p.node === node)
        .filter((p) => {
          const w = (p.spec_summary as PodSpec).workload;
          return (!workloadKind || w?.kind === workloadKind) && (!workload || w?.name === workload);
        })
        .map((p) => podView(p, usage.get(key(p.namespace, p.name)), now));
      return { pods, systemNamespaces: [...system].sort() };
    },
  );

  app.get(
    '/clusters/:id/pods/:namespace/:name',
    {
      preHandler: signedIn,
      schema: {
        summary: 'One pod with containers, termination reasons and events (SPEC §4.3)',
        tags: ['kubernetes', PUBLIC_TAG],
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          namespace: Type.String({ minLength: 1, maxLength: 63 }),
          name: Name,
        }),
        response: {
          200: Type.Object({
            pod: PodSchema,
            labels: Type.Record(Type.String(), Type.String()),
            pvcs: Type.Array(Type.String()),
            containers: Type.Array(ContainerSchema),
            message: Type.Union([Type.String(), Type.Null()]),
            events: Type.Array(EventSchema),
          }),
          ...Errors,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const { namespace, name } = request.params;
      const row = (await db
        .selectFrom('objects')
        .select(['kind', 'namespace', 'name', 'node', 'spec_summary', 'status_summary'])
        .where('cluster_id', '=', cluster.id)
        .where('kind', '=', 'Pod')
        .where('namespace', '=', namespace)
        .where('name', '=', name)
        .where('deleted_at', 'is', null)
        .executeTakeFirst()) as ObjectRow | undefined;
      if (!row) return sendProblem(reply, 404, 'Pod not found');
      const scope = { namespace, pod: name };
      const [usage, [cpu, mem], events] = await Promise.all([
        podUsage(cluster.scope, scope),
        instant(cluster.scope, [
          buildQuery('pod.container.cpu.usage', scope, 15).expr,
          buildQuery('pod.container.memory.working_set', scope, 15).expr,
        ]),
        recentEvents(cluster.id, { namespaces: [namespace], kind: 'Pod', name }, 100),
      ]);
      const cpuBy = byLabels(cpu!, 'container');
      const memBy = byLabels(mem!, 'container');
      const spec = row.spec_summary as PodSpec;
      const st = row.status_summary as PodStatus;
      const running = podIsActive(st);
      return {
        pod: podView(row, usage.get(key(namespace, name))),
        labels: spec.labels ?? {},
        pvcs: spec.pvcs ?? [],
        containers: containerViews(spec, st).map((c) => ({
          ...c,
          cpuCores: running && !c.init ? (cpuBy.get(c.name) ?? null) : null,
          memoryBytes: running && !c.init ? (memBy.get(c.name) ?? null) : null,
        })),
        message: st.message ?? null,
        events: events.map(eventView),
      };
    },
  );

  // Filters shared by the event list and its summary: comma-separated lists.
  const List = Type.Optional(Type.String({ maxLength: 2048 }));
  const EventQuery = {
    namespaces: Namespaces,
    types: List,
    kinds: List,
    reasons: List,
    /** The page's namespace (Docker: Compose project) facet; "-" stands for the rest. */
    ns: List,
    /** Docker hosts. */
    hosts: List,
    name: Type.Optional(Name),
    q: Type.Optional(Type.String({ maxLength: 200 })),
    from: Type.Optional(Type.Number({ description: 'Unix seconds' })),
    to: Type.Optional(Type.Number({ description: 'Unix seconds' })),
    // Single values, as before the lists.
    type: Type.Optional(Type.Union([Type.Literal('Normal'), Type.Literal('Warning')])),
    kind: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  };
  const list = (v: string | undefined, single?: string) => {
    const xs = [...(v ?? '').split(','), single ?? '']
      .map((x) => x.trim())
      .filter((x) => x && x.length <= 253);
    return xs.length ? [...new Set(xs)].slice(0, 50) : undefined;
  };
  function eventFilter(clusterId: string, q: Static<Type.TObject<typeof EventQuery>>): EventFilter {
    return {
      clusterId,
      namespaces: splitNamespaces(q.namespaces),
      types: list(q.types, q.type),
      kinds: list(q.kinds, q.kind),
      reasons: list(q.reasons, q.reason),
      ns: list(q.ns),
      hosts: list(q.hosts),
      name: q.name,
      q: q.q?.trim() || undefined,
      from: q.from,
      to: q.to,
    };
  }

  app.get(
    '/clusters/:id/events',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Kubernetes events, newest first, paged and filterable (SPEC §4.6)',
        tags: ['kubernetes', PUBLIC_TAG],
        params: Params,
        querystring: Type.Object({
          ...EventQuery,
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_EVENTS_PAGE })),
          cursor: Type.Optional(Type.String({ maxLength: 2048 })),
        }),
        response: {
          200: Type.Object({
            events: Type.Array(EventSchema),
            nextCursor: Type.Union([Type.String(), Type.Null()]),
          }),
          400: ProblemSchema,
          ...Errors,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const { cursor } = request.query;
      const limit = request.query.limit ?? EVENTS_PAGE;
      const after = cursor ? decodeCursor(cursor) : undefined;
      if (after === null) return sendProblem(reply, 400, 'Invalid cursor');

      let q = db
        .selectFrom('k8s_events')
        .selectAll()
        .where(eventWhere(eventFilter(cluster.id, request.query)));
      if (after) {
        q = q.where(
          sql<boolean>`(last_ts, involved_key, reason) < (${new Date(after[0])}, ${after[1]}, ${after[2]})`,
        );
      }
      const rows = await q
        .orderBy('last_ts', 'desc')
        .orderBy('involved_key', 'desc')
        .orderBy('reason', 'desc')
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit);
      return {
        events: page.map(eventView),
        nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null,
      };
    },
  );

  app.get(
    '/clusters/:id/events/summary',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Events per bucket, facet counts and notable events for the Events page',
        tags: ['kubernetes', PUBLIC_TAG],
        params: Params,
        querystring: Type.Object(EventQuery),
        response: {
          200: Type.Object({
            from: Type.Number(),
            to: Type.Number(),
            bucket: Type.Integer(),
            histogram: Type.Array(
              Type.Object({ ts: Type.Number(), warning: Type.Integer(), normal: Type.Integer() }),
            ),
            facets: Type.Object({
              kinds: Type.Array(Type.Object({ value: Type.String(), count: Type.Integer() })),
              namespaces: Type.Array(Type.Object({ value: Type.String(), count: Type.Integer() })),
              reasons: Type.Array(
                Type.Object({ value: Type.String(), type: Type.String(), count: Type.Integer() }),
              ),
              hosts: Type.Array(Type.Object({ value: Type.String(), count: Type.Integer() })),
            }),
            markers: Type.Array(
              Type.Object({
                ts: Type.Number(),
                reason: Type.String(),
                kind: Type.String(),
                objects: Type.Integer(),
              }),
            ),
            total: Type.Integer(),
          }),
          400: ProblemSchema,
          ...Errors,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const to = Math.floor(request.query.to ?? Date.now() / 1000);
      const from = Math.floor(request.query.from ?? to - 86400);
      if (from >= to || (to - from) * 1000 > MAX_RANGE_MS)
        return sendProblem(reply, 400, 'from must be before to, at most 31 days apart');
      return eventSummary(db, { ...eventFilter(cluster.id, request.query), from, to });
    },
  );

  app.get(
    '/clusters/:id/change-markers',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Rollouts, image changes, scaling and node changes for charts (SPEC §4.6)',
        tags: ['kubernetes', PUBLIC_TAG],
        params: Params,
        querystring: Type.Object({
          from: Type.Number({ description: 'Unix seconds' }),
          to: Type.Number({ description: 'Unix seconds' }),
          namespaces: Namespaces,
          /** Kind/namespace/name or Node/name, as in the markers. */
          target: Type.Optional(Type.String({ minLength: 1, maxLength: 600 })),
        }),
        response: {
          200: Type.Object({ markers: Type.Array(MarkerSchema), truncated: Type.Boolean() }),
          400: ProblemSchema,
          ...Errors,
        },
      },
    },
    async (request, reply) => {
      const { from, to, target } = request.query;
      if (!(to > from) || (to - from) * 1000 > MAX_RANGE_MS) {
        return sendProblem(reply, 400, 'The range must be positive and at most 31 days');
      }
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const namespaces = splitNamespaces(request.query.namespaces);
      let q = db
        .selectFrom('change_markers')
        .select(['kind', 'target', 'namespace', 'details', 'ts'])
        .where('cluster_id', '=', cluster.id)
        .where('ts', '>=', new Date(from * 1000))
        .where('ts', '<=', new Date(to * 1000));
      // Node markers belong to every namespace view.
      if (namespaces) {
        q = q.where((eb) => eb.or([eb('namespace', 'in', namespaces), eb('kind', '=', 'node')]));
      }
      if (target) q = q.where('target', '=', target);
      const rows = await q
        .orderBy('ts')
        .limit(MARKERS_LIMIT + 1)
        .execute();
      return {
        markers: rows.slice(0, MARKERS_LIMIT).map((m) => ({
          kind: m.kind,
          target: m.target,
          namespace: m.namespace || null,
          details: m.details as Record<string, unknown>,
          ts: m.ts.toISOString(),
        })),
        truncated: rows.length > MARKERS_LIMIT,
      };
    },
  );

  app.get(
    '/clusters/:id/namespaces',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Namespaces with pod counts, for the namespace filter',
        tags: ['kubernetes', PUBLIC_TAG],
        params: Params,
        response: {
          200: Type.Object({
            namespaces: Type.Array(
              Type.Object({ name: Type.String(), phase: Type.String(), pods: Type.Integer() }),
            ),
          }),
          ...Errors,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const [rows, counts] = await Promise.all([
        objects(cluster.id, ['Namespace']),
        db
          .selectFrom('objects')
          .select(['namespace', sql<number>`count(*)::int`.as('pods')])
          .where('cluster_id', '=', cluster.id)
          .where('kind', '=', 'Pod')
          .where('deleted_at', 'is', null)
          .groupBy('namespace')
          .execute(),
      ]);
      const podsBy = new Map(counts.map((c) => [c.namespace, c.pods]));
      return {
        namespaces: rows.map((n) => ({
          name: n.name,
          phase: ((n.status_summary as Record<string, unknown>).phase as string) ?? 'Active',
          pods: podsBy.get(n.name) ?? 0,
        })),
      };
    },
  );
};
