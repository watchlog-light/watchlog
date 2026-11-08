// SPDX-License-Identifier: AGPL-3.0-only
// get_pod (ADR-128): a pod on Kubernetes, a container on Docker. The facts are shared with
// explain_alert, which shows the object an alert is about.
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
  notFound,
  summary,
  terminationField,
  usage,
  type ApiEvent,
  type Termination,
} from './common.js';

export const MAX_CONTAINERS = 10;
export const MAX_EVENTS = 10;

interface PodDetail {
  pod: {
    namespace: string;
    name: string;
    node: string | null;
    phase: string;
    status: string;
    ready: boolean;
    readyContainers: number;
    totalContainers: number;
    restarts: number;
    qosClass: string | null;
    workloadKind: string | null;
    workload: string | null;
    createdAt: string | null;
    startedAt: string | null;
    lastTermination: Termination | null;
    failing: string | null;
    cpuRequestCores: number | null;
    cpuLimitCores: number | null;
    memoryRequestBytes: number | null;
    memoryLimitBytes: number | null;
    cpuCores: number | null;
    memoryBytes: number | null;
  };
  containers: {
    name: string;
    init: boolean;
    image: string;
    ready: boolean;
    state: string;
    reason: string | null;
    message: string | null;
    exitCode: number | null;
    restartCount: number;
    startedAt: string | null;
    lastTermination: Termination | null;
    cpuRequestCores: number | null;
    cpuLimitCores: number | null;
    memoryRequestBytes: number | null;
    memoryLimitBytes: number | null;
    cpuCores: number | null;
    memoryBytes: number | null;
  }[];
  message: string | null;
  events: ApiEvent[];
}

export interface ApiContainer {
  name: string;
  host: string;
  image: string;
  state: string;
  status: string;
  health: string | null;
  restartCount: number;
  restartsInRange: number | null;
  exitCode: number | null;
  oomKilled: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  composeProject: string | null;
  composeService: string | null;
  cpuCores: number | null;
  cpuLimitCores: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  restarting: boolean;
  stateError: string | null;
  healthDetail: { status: string; failingStreak: number; since: string | null } | null;
  problem: { severity: string; kind: string; reason: string | null; alertId: string | null } | null;
}

/** A pod's facts: the pod, its containers, and its events newest first (all of them). */
export async function podFacts(api: ApiReader, cluster: ClusterRef, ns: string, pod: string) {
  const d = await api
    .get<PodDetail>(
      `/clusters/${cluster.id}/pods/${encodeURIComponent(ns)}/${encodeURIComponent(pod)}`,
    )
    .catch((err: unknown) =>
      notFound(
        err,
        'No pod with this name in this namespace.',
        'Take the namespace and pod name from get_problems.',
        { namespace: name(ns), name: name(pod) },
      ),
    );
  const p = d.pod;
  return {
    pod: {
      namespace: name(p.namespace),
      name: name(p.name),
      node: name(p.node),
      phase: p.phase,
      status: text(p.status, 128),
      ready: p.ready,
      readyContainers: p.readyContainers,
      totalContainers: p.totalContainers,
      restarts: p.restarts,
      failing: text(p.failing, 128),
      workload: p.workload ? { kind: p.workloadKind, name: name(p.workload) } : null,
      qosClass: p.qosClass,
      createdAt: p.createdAt,
      startedAt: p.startedAt,
      lastTermination: terminationField(p.lastTermination),
      usage: usage(p),
      message: message(d.message),
    },
    containers: d.containers.slice(0, MAX_CONTAINERS).map((c) => ({
      name: name(c.name),
      init: c.init,
      image: name(c.image),
      ready: c.ready,
      state: c.state,
      reason: text(c.reason, 128),
      message: message(c.message),
      exitCode: c.exitCode,
      restartCount: c.restartCount,
      startedAt: c.startedAt,
      lastTermination: terminationField(c.lastTermination),
      usage: usage(c),
    })),
    containersTotal: d.containers.length,
    // The API lists a pod's events newest first.
    events: d.events,
  };
}

/** One container of a Docker fleet, found by name (and host when the name runs on several). */
export async function findContainer(
  api: ApiReader,
  cluster: ClusterRef,
  container: string,
  host: string | undefined,
): Promise<ApiContainer> {
  const { containers } = await api.get<{ containers: ApiContainer[] }>(
    `/clusters/${cluster.id}/docker/containers`,
    { host },
  );
  const matches = containers.filter((c) => c.name === container);
  if (matches.length === 0) {
    throw new ToolError(
      host ? 'No container with this name on this host.' : 'No container with this name.',
      'Take the container name (and host) from get_problems.',
      { name: name(container), ...(host ? { host: name(host) } : {}) },
    );
  }
  if (matches.length > 1) {
    throw new ToolError(
      'Containers with this name run on several hosts: say which with `host`.',
      'Pass one of the hosts listed.',
      { name: name(container), hosts: matches.slice(0, 20).map((c) => name(c.host)) },
    );
  }
  return matches[0]!;
}

export const containerField = (c: ApiContainer) => ({
  name: name(c.name),
  host: name(c.host),
  image: name(c.image),
  state: c.state,
  status: text(c.status, 128),
  restarting: c.restarting,
  // Never the probe output: it is the workload's own command output.
  health: c.healthDetail
    ? {
        status: c.healthDetail.status,
        failingStreak: c.healthDetail.failingStreak,
        since: c.healthDetail.since,
      }
    : c.health,
  restartCount: c.restartCount,
  restartsInRange: c.restartsInRange,
  exitCode: c.exitCode,
  oomKilled: c.oomKilled,
  stateError: message(c.stateError),
  startedAt: c.startedAt,
  finishedAt: c.finishedAt,
  compose: c.composeProject
    ? { project: name(c.composeProject), service: name(c.composeService) }
    : null,
  problem: c.problem
    ? { severity: c.problem.severity, kind: c.problem.kind, detail: message(c.problem.reason) }
    : null,
  usage: usage(c),
});

/** A container's events, newest first. */
export async function containerEvents(
  api: ApiReader,
  cluster: ClusterRef,
  c: { host: string; name: string },
  limit = 50,
): Promise<ApiEvent[]> {
  return (
    await api.get<{ events: ApiEvent[] }>(`/clusters/${cluster.id}/events`, {
      hosts: c.host,
      name: c.name,
      limit,
    })
  ).events;
}

const eventsList = (events: ApiEvent[]): NonNullable<ToolAnswer['list']> => ({
  key: 'events',
  items: events.slice(0, MAX_EVENTS).map(eventField),
  total: events.length,
  noun: 'events',
  narrow: 'The newest come first; get_events shows more.',
});

export const getPodTool = defineTool({
  name: 'get_pod',
  title: 'Get a pod or a container',
  description: describe(
    'One pod on a Kubernetes cluster, or one container on a Docker fleet, with why it is failing.',
    `Kubernetes: pass \`namespace\` and the pod \`name\` (from get_problems). Returns phase, node, workload, restarts, the last termination (reason such as OOMKilled or Error, exit code, when), up to ${MAX_CONTAINERS} containers with state, reason, exit code, restart count and CPU and memory against requests and limits, and the pod's last ${MAX_EVENTS} events.`,
    `Docker: pass the container \`name\`, and \`host\` when the same name runs on several hosts. Returns state, health check, restarts, exit code, whether it was OOM-killed, image, Compose project and service, CPU and memory against limits, and its last ${MAX_EVENTS} events.`,
    'Example question: "Why does the cart pod keep restarting?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      name: NameArg('The pod name (Kubernetes) or the container name (Docker).'),
      namespace: NamespaceArg("Kubernetes: the pod's namespace (required there)."),
      host: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 253,
          description: "Docker: the container's host, when its name runs on several hosts.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.cluster, a.namespace ?? a.host, a.name),
  async run(args, { api }) {
    const cluster = await resolveCluster(api, args.cluster);
    if (cluster.kind === 'kubernetes') {
      if (!args.namespace) {
        throw new ToolError(
          'A Kubernetes pod needs its `namespace`.',
          'Take the namespace and pod name from get_problems.',
          { name: name(args.name) },
        );
      }
      const f = await podFacts(api, cluster, args.namespace, args.name);
      return {
        body: {
          cluster: clusterField(cluster),
          pod: f.pod,
          containers: f.containers,
          ...(f.containersTotal > MAX_CONTAINERS
            ? { containersShown: MAX_CONTAINERS, containersTotal: f.containersTotal }
            : {}),
        },
        list: eventsList(f.events),
      };
    }
    if (args.namespace) {
      throw new ToolError(
        'Namespaces are a Kubernetes notion; this cluster is a Docker fleet.',
        'Pass the container `name`, and `host` if needed, without `namespace`.',
        { cluster: clusterField(cluster) },
      );
    }
    const c = await findContainer(api, cluster, args.name, args.host);
    return {
      body: { cluster: clusterField(cluster), container: containerField(c) },
      list: eventsList(await containerEvents(api, cluster, c)),
    };
  },
});
