// SPDX-License-Identifier: AGPL-3.0-only
// get_node (ADR-128): a Kubernetes node, or a host of a Docker fleet.
import { Type } from 'typebox';
import { clusterField, resolveCluster } from '../clusters.js';
import { message, name, text, ToolError } from '../output.js';
import {
  ClusterArg,
  defineTool,
  describe,
  eventField,
  NameArg,
  notFound,
  round,
  summary,
  type ApiEvent,
} from './common.js';
import type { ApiContainer } from './pods.js';

const TOP = 5;
const MAX_EVENTS = 10;

interface NodeDetail {
  node: {
    name: string;
    status: string;
    roles: string[];
    unschedulable: boolean;
    taints: string[];
    kubeletVersion: string | null;
    osImage: string | null;
    kernelVersion: string | null;
    containerRuntime: string | null;
    cpu: {
      usageCores: number | null;
      requestsCores: number | null;
      allocatableCores: number | null;
    };
    memory: {
      usageBytes: number | null;
      requestsBytes: number | null;
      allocatableBytes: number | null;
    };
    diskUtilization: number | null;
    pods: { count: number; capacity: number | null };
    conditions: {
      type: string;
      status: string;
      reason: string | null;
      message: string | null;
      since: string | null;
      bad: boolean;
    }[];
    agent: { status: string; version: string | null; lastSeenAt: string | null };
  };
  pods: {
    namespace: string;
    name: string;
    restarts: number;
    failing: string | null;
    cpuCores: number | null;
    memoryBytes: number | null;
  }[];
  events: ApiEvent[];
}

interface ApiHost {
  name: string;
  status: string;
  lastSeenAt: string | null;
  agentVersion: string | null;
  dockerVersion: string | null;
  os: string | null;
  arch: string | null;
  kernelVersion: string | null;
  containers: { total: number; running: number; stopped: number; unhealthy: number };
  cpuUtilization: number | null;
  memoryUtilization: number | null;
  diskUtilization: number | null;
  load1: number | null;
  cpu: { usageCores: number | null; cores: number | null };
  memory: { usageBytes: number | null; totalBytes: number | null };
  disks: {
    mount: string;
    utilization?: number | null;
    usedBytes?: number | null;
    totalBytes?: number | null;
  }[];
}

/** The `TOP` heaviest by a measure, without the ones that don't report it. */
function top<T>(items: T[], by: (t: T) => number | null) {
  return items
    .filter((t) => by(t) !== null)
    .sort((a, b) => by(b)! - by(a)!)
    .slice(0, TOP);
}

export const getNodeTool = defineTool({
  name: 'get_node',
  title: 'Get a node or a Docker host',
  description: describe(
    'One machine: a node of a Kubernetes cluster, or a host of a Docker fleet.',
    `Kubernetes: pass the node \`name\`. Returns status, roles, whether it is cordoned, taints, versions, CPU and memory use against requests and allocatable, disk use, pods against capacity, its conditions (pressure, readiness), the WatchLog agent's state, the ${TOP} pods using the most CPU and memory, and its last ${MAX_EVENTS} events.`,
    `Docker: pass the host \`name\`. Returns whether it reports, Docker and kernel versions, container counts (running, stopped, unhealthy), CPU, memory and disk use, load, the fullest disks, and the ${TOP} containers using the most CPU and memory.`,
    'Example question: "Is node worker-2 under memory pressure?"',
  ),
  input: Type.Object(
    { cluster: ClusterArg, name: NameArg('The node name (Kubernetes) or the host name (Docker).') },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.cluster, a.name),
  async run(args, { api }) {
    const cluster = await resolveCluster(api, args.cluster);
    if (cluster.kind === 'kubernetes') {
      const d = await api
        .get<NodeDetail>(`/clusters/${cluster.id}/nodes/${encodeURIComponent(args.name)}`)
        .catch((err: unknown) =>
          notFound(
            err,
            'No node with this name.',
            'Take the node name from get_pod or get_problems.',
            {
              name: name(args.name),
            },
          ),
        );
      const n = d.node;
      const pod = (p: NodeDetail['pods'][number]) => ({
        namespace: name(p.namespace),
        name: name(p.name),
        cpuCores: round(p.cpuCores),
        memoryBytes: p.memoryBytes === null ? null : Math.round(p.memoryBytes),
        restarts: p.restarts,
        failing: text(p.failing, 128),
      });
      return {
        body: {
          cluster: clusterField(cluster),
          node: {
            name: name(n.name),
            status: n.status,
            roles: n.roles.slice(0, 10).map((r) => text(r, 63)),
            unschedulable: n.unschedulable,
            taints: n.taints.slice(0, 10).map((t) => text(t, 253)),
            kubeletVersion: text(n.kubeletVersion, 64),
            osImage: text(n.osImage, 128),
            kernelVersion: text(n.kernelVersion, 128),
            containerRuntime: text(n.containerRuntime, 128),
            cpu: n.cpu,
            memory: n.memory,
            diskUtilization: round(n.diskUtilization),
            pods: n.pods,
            conditions: n.conditions.map((c) => ({
              type: text(c.type, 64),
              status: c.status,
              bad: c.bad,
              reason: text(c.reason, 128),
              message: message(c.message),
              since: c.since,
            })),
            agent: {
              status: n.agent.status,
              version: text(n.agent.version, 64),
              lastSeenAt: n.agent.lastSeenAt,
            },
          },
          topCpu: top(d.pods, (p) => p.cpuCores).map(pod),
          topMemory: top(d.pods, (p) => p.memoryBytes).map(pod),
          failingPods: d.pods
            .filter((p) => p.failing)
            .slice(0, 10)
            .map(pod),
        },
        list: {
          key: 'events',
          items: d.events.slice(0, MAX_EVENTS).map(eventField),
          total: d.events.length,
          noun: 'events',
          narrow: 'The newest come first; get_events shows more.',
        },
      };
    }
    const { hosts } = await api.get<{ hosts: ApiHost[] }>(`/clusters/${cluster.id}/docker/hosts`);
    const h = hosts.find((x) => x.name === args.name);
    if (!h) {
      throw new ToolError('No Docker host with this name.', 'Pass one of the hosts listed.', {
        name: name(args.name),
        hosts: hosts.slice(0, 20).map((x) => name(x.name)),
      });
    }
    const { containers } = await api.get<{ containers: ApiContainer[] }>(
      `/clusters/${cluster.id}/docker/containers`,
      { host: h.name },
    );
    const ctr = (c: ApiContainer) => ({
      name: name(c.name),
      state: c.state,
      cpuCores: round(c.cpuCores),
      memoryBytes: c.memoryBytes === null ? null : Math.round(c.memoryBytes),
    });
    return {
      body: {
        cluster: clusterField(cluster),
        host: {
          name: name(h.name),
          status: h.status,
          lastSeenAt: h.lastSeenAt,
          agentVersion: text(h.agentVersion, 64),
          dockerVersion: text(h.dockerVersion, 64),
          os: text(h.os, 64),
          arch: text(h.arch, 32),
          kernelVersion: text(h.kernelVersion, 128),
          containers: h.containers,
          cpuUtilization: round(h.cpuUtilization),
          memoryUtilization: round(h.memoryUtilization),
          diskUtilization: round(h.diskUtilization),
          load1: round(h.load1),
          cpu: h.cpu,
          memory: h.memory,
          disks: [...h.disks]
            .sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))
            .slice(0, TOP)
            .map((d) => ({
              mount: text(d.mount, 253),
              utilization: round(d.utilization),
              totalBytes: d.totalBytes ?? null,
            })),
        },
        topCpu: top(containers, (c) => c.cpuCores).map(ctr),
        topMemory: top(containers, (c) => c.memoryBytes).map(ctr),
        withProblems: containers
          .filter((c) => c.problem)
          .slice(0, 10)
          .map((c) => ({ ...ctr(c), problem: c.problem!.kind })),
      },
    };
  },
});
