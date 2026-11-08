// SPDX-License-Identifier: AGPL-3.0-only
// get_workload (ADR-128): a Deployment, StatefulSet, DaemonSet, Job or CronJob on
// Kubernetes; a Compose service on Docker. The facts are shared with explain_alert.
import { Type } from 'typebox';
import { clusterField, resolveCluster, type ClusterRef } from '../clusters.js';
import { message, name, text, ToolError, type ToolAnswer } from '../output.js';
import type { ApiReader } from '../reader.js';
import {
  ClusterArg,
  defineTool,
  describe,
  eventField,
  NameArg,
  NamespaceArg,
  summary,
  terminationField,
  usage,
  type ApiEvent,
  type Termination,
} from './common.js';
import { containerEvents, containerField, type ApiContainer } from './pods.js';

const MAX_PODS = 20;
const MAX_EVENTS = 5;
const MAX_IMAGES = 5;

interface ApiWorkload {
  kind: string;
  namespace: string;
  name: string;
  desired: number | null;
  ready: number | null;
  updated: number | null;
  health: string;
  pods: number;
  restarts: number;
  restartsInRange: number | null;
  images: string[];
  createdAt: string | null;
  lastRolloutAt: string | null;
  schedule: string | null;
  lastScheduleAt: string | null;
  cpuRequestCores: number | null;
  cpuLimitCores: number | null;
  memoryRequestBytes: number | null;
  memoryLimitBytes: number | null;
  cpuCores: number | null;
  memoryBytes: number | null;
  problem: { severity: string; reason: string; alertId: string | null } | null;
  podStates: ('ready' | 'starting' | 'failing')[];
}

interface ApiPod {
  namespace: string;
  name: string;
  node: string | null;
  phase: string;
  ready: boolean;
  restarts: number;
  failing: string | null;
  lastTermination: Termination | null;
}

const newestFirst = (a: ApiEvent, b: ApiEvent) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen);

/** A Kubernetes workload: its state, its pods (all of them) and its events, newest first. */
export async function workloadFacts(
  api: ApiReader,
  cluster: ClusterRef,
  ns: string,
  workload: string,
  kind?: string,
) {
  const { workloads } = await api.get<{ workloads: ApiWorkload[] }>(
    `/clusters/${cluster.id}/workloads`,
    { namespaces: ns, range: 3600 },
  );
  const matches = workloads.filter(
    (w) =>
      w.namespace === ns &&
      w.name === workload &&
      (!kind || w.kind.toLowerCase() === kind.toLowerCase()),
  );
  if (matches.length === 0) {
    throw new ToolError(
      'No workload with this name in this namespace.',
      "Take the namespace and name from get_problems, or from get_pod's `workload`.",
      { namespace: name(ns), name: name(workload), ...(kind ? { kind: text(kind, 32) } : {}) },
    );
  }
  if (matches.length > 1) {
    throw new ToolError(
      'Several workloads have this name: say which with `kind`.',
      'Pass one of the kinds listed.',
      { kinds: matches.map((w) => w.kind) },
    );
  }
  const w = matches[0]!;
  const [{ pods }, { events }] = await Promise.all([
    api.get<{ pods: ApiPod[] }>(`/clusters/${cluster.id}/pods`, {
      namespaces: ns,
      workload: w.name,
      workloadKind: w.kind,
    }),
    api.get<{ events: ApiEvent[] }>(`/clusters/${cluster.id}/events`, {
      namespaces: ns,
      q: w.name,
      limit: 100,
    }),
  ]);
  // The workload's own events and its pods' and ReplicaSets' (named after it).
  const own = events
    .filter((e) => e.involvedName === w.name || e.involvedName?.startsWith(`${w.name}-`))
    .sort(newestFirst);
  return {
    workload: {
      kind: w.kind,
      namespace: name(w.namespace),
      name: name(w.name),
      health: w.health,
      replicas: { desired: w.desired, ready: w.ready, updated: w.updated },
      podStates: {
        ready: w.podStates.filter((s) => s === 'ready').length,
        starting: w.podStates.filter((s) => s === 'starting').length,
        failing: w.podStates.filter((s) => s === 'failing').length,
      },
      restarts: w.restarts,
      restartsLastHour: w.restartsInRange,
      images: w.images.slice(0, MAX_IMAGES).map(name),
      problem: w.problem
        ? {
            severity: w.problem.severity,
            detail: message(w.problem.reason),
            alertId: w.problem.alertId,
          }
        : null,
      createdAt: w.createdAt,
      lastRolloutAt: w.lastRolloutAt,
      ...(w.schedule ? { schedule: text(w.schedule, 64), lastScheduleAt: w.lastScheduleAt } : {}),
      usage: usage(w),
    },
    pods: pods.map((p) => ({
      name: name(p.name),
      node: name(p.node),
      phase: p.phase,
      ready: p.ready,
      restarts: p.restarts,
      failing: text(p.failing, 128),
      lastTermination: terminationField(p.lastTermination),
    })),
    events: own,
  };
}

/** A Compose service on a Docker fleet: its containers (all of them) and their events. */
export async function composeServiceFacts(
  api: ApiReader,
  cluster: ClusterRef,
  project: string | undefined,
  service: string,
) {
  const { containers } = await api.get<{ containers: ApiContainer[] }>(
    `/clusters/${cluster.id}/docker/containers`,
  );
  const matches = containers.filter(
    (c) => c.composeService === service && (!project || c.composeProject === project),
  );
  if (matches.length === 0) {
    if (!project && containers.some((c) => c.name === service)) {
      throw new ToolError(
        'This is a container that belongs to no Compose service.',
        'Use get_pod with this container name.',
        { name: name(service) },
      );
    }
    throw new ToolError(
      'No Compose service with this name.',
      "Take the project and service from get_pod's `compose`, or from get_problems.",
      { name: name(service), ...(project ? { project: name(project) } : {}) },
    );
  }
  const projects = [...new Set(matches.map((c) => c.composeProject))];
  if (projects.length > 1) {
    throw new ToolError(
      'Compose services with this name run in several projects: say which with `project`.',
      'Pass one of the projects listed.',
      { name: name(service), projects: projects.slice(0, 20).map(name) },
    );
  }
  // Events of the containers that have a problem first, at most three of them.
  const sorted = [...matches].sort((a, b) => Number(!!b.problem) - Number(!!a.problem));
  const events = (
    await Promise.all(sorted.slice(0, 3).map((c) => containerEvents(api, cluster, c, 20)))
  )
    .flat()
    .sort(newestFirst);
  return {
    service: {
      project: name(projects[0]),
      name: name(service),
      containers: matches.length,
      running: matches.filter((c) => c.state === 'running').length,
      withProblems: matches.filter((c) => c.problem).length,
      restarts: matches.reduce((n, c) => n + c.restartCount, 0),
      images: [...new Set(matches.map((c) => c.image))].slice(0, MAX_IMAGES).map(name),
      hosts: [...new Set(matches.map((c) => c.host))].slice(0, 20).map(name),
    },
    containers: sorted,
    events,
  };
}

export const getWorkloadTool = defineTool({
  name: 'get_workload',
  title: 'Get a workload or a Compose service',
  description: describe(
    'One workload with its replicas, pods and recent events: a Deployment, StatefulSet, DaemonSet, Job or CronJob on Kubernetes; a Compose service on a Docker fleet.',
    `Kubernetes: pass \`namespace\` and the workload \`name\` (and \`kind\` when several kinds share the name). Returns health, desired, ready and updated replicas, pod states, restarts (all time and the last hour), images, the problem WatchLog sees, the last rollout, CPU and memory against requests and limits, up to ${MAX_PODS} pods with their last termination, and the ${MAX_EVENTS} newest events.`,
    `Docker: pass the Compose service \`name\` (and \`project\` when several projects have it). Returns its containers (state, health, restarts, exit code, OOM kill), images, hosts and the ${MAX_EVENTS} newest events of its failing containers.`,
    'Use get_pod for one pod or container, get_service_map for its connections.',
    'Example question: "Is the checkout deployment healthy after this morning\'s rollout?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      name: NameArg('The workload name (Kubernetes) or the Compose service name (Docker).'),
      namespace: NamespaceArg("Kubernetes: the workload's namespace (required there)."),
      kind: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 32,
          description:
            'Kubernetes: Deployment, StatefulSet, DaemonSet, Job or CronJob, when several kinds share the name.',
        }),
      ),
      project: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 253,
          description: 'Docker: the Compose project, when several projects have the service.',
        }),
      ),
    },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.cluster, a.namespace ?? a.project, a.kind, a.name),
  async run(args, { api }): Promise<ToolAnswer> {
    const cluster = await resolveCluster(api, args.cluster);
    if (cluster.kind === 'kubernetes') {
      if (!args.namespace) {
        throw new ToolError(
          'A Kubernetes workload needs its `namespace`.',
          'Take the namespace and name from get_problems.',
          { name: name(args.name) },
        );
      }
      const f = await workloadFacts(api, cluster, args.namespace, args.name, args.kind);
      return {
        body: {
          cluster: clusterField(cluster),
          workload: f.workload,
          events: f.events.slice(0, MAX_EVENTS).map(eventField),
        },
        list: {
          key: 'pods',
          items: f.pods.slice(0, MAX_PODS),
          total: f.pods.length,
          noun: 'pods',
          narrow: 'Use get_pod for one pod.',
        },
      };
    }
    if (args.namespace || args.kind) {
      throw new ToolError(
        'Namespaces and workload kinds are Kubernetes notions; this cluster is a Docker fleet.',
        'Pass the Compose service `name`, and `project` if needed.',
        { cluster: clusterField(cluster) },
      );
    }
    const f = await composeServiceFacts(api, cluster, args.project, args.name);
    return {
      body: {
        cluster: clusterField(cluster),
        service: f.service,
        events: f.events.slice(0, MAX_EVENTS).map(eventField),
      },
      list: {
        key: 'containers',
        items: f.containers.slice(0, MAX_PODS).map(containerField),
        total: f.containers.length,
        noun: 'containers',
        narrow: 'Use get_pod for one container.',
      },
    };
  },
});
