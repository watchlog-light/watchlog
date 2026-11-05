// SPDX-License-Identifier: AGPL-3.0-only
// The Nodes page's rules (ADR-111): the capacity tiles,
// the fullest disk, condition chips and the default layout.
import type { DockerHost, KubeNode, KubeNodeList } from '@watchlog/api-types';
import type { RouteLocationRaw } from 'vue-router';

/**
 * What the node cards, tiles and table show: a Kubernetes node, or a Docker host mapped
 * into the same shape (Docker parity: the Hosts page is the Nodes page's design).
 */
export type NodeModel = Pick<
  KubeNode,
  | 'name'
  | 'status'
  | 'roles'
  | 'unschedulable'
  | 'kubeletVersion'
  | 'osImage'
  | 'kernelVersion'
  | 'createdAt'
  | 'cpu'
  | 'memory'
  | 'diskUtilization'
  | 'pods'
  | 'conditions'
  | 'agent'
  | 'readySince'
  | 'disks'
  | 'cpuSeries'
  | 'memorySeries'
  | 'heat'
> & {
  /** node (Kubernetes) or host (Docker). */
  kind: 'node' | 'host';
  bootTime: number | null;
  link: RouteLocationRaw;
};

export const nodeModel = (n: KubeNode): NodeModel => ({
  ...n,
  kind: 'node',
  bootTime: n.bootTime ?? null,
  link: { name: 'node', params: { name: n.name } },
});

/** A Docker host as a node: its Docker version stands for the kubelet's, its running
 * containers for pods; hosts have no requests or pressure conditions. */
export const hostModel = (h: DockerHost): NodeModel => ({
  kind: 'host',
  name: h.name,
  status: h.status === 'active' ? 'Ready' : 'NotReady',
  roles: [],
  unschedulable: false,
  kubeletVersion: h.dockerVersion ? `Docker ${h.dockerVersion}` : null,
  osImage: h.os ? [h.os, h.arch].filter(Boolean).join('/') : null,
  kernelVersion: h.kernelVersion,
  createdAt: null,
  cpu: { usageCores: h.cpu.usageCores, requestsCores: 0, allocatableCores: h.cpu.cores },
  memory: {
    usageBytes: h.memory.usageBytes,
    requestsBytes: 0,
    allocatableBytes: h.memory.totalBytes,
  },
  diskUtilization: h.diskUtilization,
  pods: { count: h.containers.running, capacity: h.containers.total },
  conditions: [],
  agent: {
    status: h.status === 'active' ? 'active' : 'inactive',
    version: h.agentVersion,
    kubeletTls: null,
    lastSeenAt: h.lastSeenAt,
  },
  readySince: null,
  bootTime: h.bootTime,
  disks: h.disks,
  cpuSeries: h.cpuSeries,
  memorySeries: h.memorySeries,
  heat: h.heat?.map((c) => ({ ...c, namespace: c.namespace })),
  link: { name: 'docker-host', params: { host: h.name } },
});

/** Cards up to this many nodes, a table beyond. */
export const CARDS_MAX = 12;
export const defaultLayout = (nodes: number) => (nodes > CARDS_MAX ? 'table' : 'cards');

export interface Capacity {
  used: number | null;
  requested: number;
  allocatable: number;
}

const sum = (xs: (number | null)[]) =>
  xs.some((x) => x !== null) ? xs.reduce<number>((s, x) => s + (x ?? 0), 0) : null;

/** Cluster totals for the tiles: CPU and memory used, requested and allocatable; pods. */
export function capacity(nodes: NodeModel[]) {
  return {
    cpu: {
      used: sum(nodes.map((n) => n.cpu.usageCores)),
      requested: nodes.reduce((s, n) => s + n.cpu.requestsCores, 0),
      allocatable: nodes.reduce((s, n) => s + (n.cpu.allocatableCores ?? 0), 0),
    } satisfies Capacity,
    memory: {
      used: sum(nodes.map((n) => n.memory.usageBytes)),
      requested: nodes.reduce((s, n) => s + n.memory.requestsBytes, 0),
      allocatable: nodes.reduce((s, n) => s + (n.memory.allocatableBytes ?? 0), 0),
    } satisfies Capacity,
    pods: {
      count: nodes.reduce((s, n) => s + n.pods.count, 0),
      capacity: nodes.reduce((s, n) => s + (n.pods.capacity ?? 0), 0),
    },
  };
}

export interface FullestDisk {
  mount: string;
  utilization: number;
  /** Nodes where this mount is as full (within a percentage point). */
  nodes: string[];
  /** The firing disk alert about it, if any. */
  alertId: string | null;
}

/** The fullest mount in the cluster, the nodes it is that full on, and its alert. */
export function fullestDisk(
  nodes: NodeModel[],
  alerts: KubeNodeList['diskAlerts'],
): FullestDisk | null {
  let top: { node: string; mount: string; utilization: number } | null = null;
  for (const n of nodes)
    for (const d of n.disks)
      if (!top || d.utilization > top.utilization)
        top = { node: n.name, mount: d.mount, utilization: d.utilization };
  if (!top) return null;
  const { mount, utilization } = top;
  const same = nodes
    .filter((n) => n.disks.some((d) => d.mount === mount && utilization - d.utilization < 0.01))
    .map((n) => n.name);
  const alert = alerts.find(
    (a) => same.includes(a.node) && (a.mount === null || a.mount === mount),
  );
  return { mount, utilization, nodes: same, alertId: alert?.alertId ?? null };
}

/** Disk tone: amber from 80 %, red from 90 %. */
export const diskTone = (u: number) => (u >= 0.9 ? 'critical' : u >= 0.8 ? 'warning' : 'ok');

const CHIPS: [string, string][] = [
  ['MemoryPressure', 'memory'],
  ['DiskPressure', 'disk'],
  ['PIDPressure', 'pid'],
  ['NetworkUnavailable', 'network'],
];

/** The node's pressure conditions as chips: Memory, Disk, PID, Network, each ok or not. */
export function conditionChips(n: NodeModel): { key: string; ok: boolean; title: string }[] {
  return CHIPS.flatMap(([type, key]) => {
    const c = n.conditions.find((x) => x.type === type);
    return c ? [{ key, ok: !c.bad, title: c.message ?? c.reason ?? type }] : [];
  });
}
