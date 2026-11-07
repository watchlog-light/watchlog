// SPDX-License-Identifier: AGPL-3.0-only
// Views of the cluster-agent's object summaries (agent/internal/k8s/records.go,
// ADR-055) for the Kubernetes read API (SPEC §4.1–§4.3). Pure functions: the routes
// load rows and metrics, these shape them.

type Summary = Record<string, unknown>;

export interface ObjectRow {
  kind: string;
  namespace: string;
  name: string;
  node: string;
  spec_summary: unknown;
  status_summary: unknown;
}

interface ContainerSpec {
  name: string;
  image: string;
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}
interface Termination {
  reason: string;
  exit_code: number;
  finished_at?: string;
}
export interface ContainerStatus {
  name: string;
  init?: boolean;
  ready: boolean;
  restart_count: number;
  state: string;
  reason?: string;
  message?: string;
  exit_code?: number;
  started_at?: string;
  last_termination?: Termination;
}
export interface PodSpec {
  workload?: { kind: string; name: string };
  containers?: ContainerSpec[];
  init_containers?: ContainerSpec[];
  pvcs?: string[];
  labels?: Record<string, string>;
  mirror?: string;
  created_at?: string;
}
export interface PodStatus {
  phase?: string;
  qos_class?: string;
  ready?: boolean;
  containers?: ContainerStatus[];
  reason?: string;
  message?: string;
  pod_ip?: string;
  started_at?: string;
  deleting_since?: string;
}
export interface NodeCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  since?: string;
}

const UNITS: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

/** Parses a Kubernetes quantity ("100m", "70Mi", "6053276Ki", "1.5", "1e3"). */
export function parseQuantity(q: string | undefined): number | null {
  if (!q) return null;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]{0,2})$/.exec(q.trim());
  if (!m) return null;
  const mul = m[2] ? UNITS[m[2]] : 1;
  return mul === undefined ? null : Number(m[1]) * mul;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

// ---------------------------------------------------------------- pods

export interface Resources {
  cpuRequestCores: number;
  cpuLimitCores: number | null;
  memoryRequestBytes: number;
  memoryLimitBytes: number | null;
}

/** Sums requests and limits; a limit is null when any container has none. */
export function containerResources(containers: ContainerSpec[] | undefined): Resources {
  const r: Resources = {
    cpuRequestCores: 0,
    cpuLimitCores: 0,
    memoryRequestBytes: 0,
    memoryLimitBytes: 0,
  };
  for (const c of containers ?? []) {
    r.cpuRequestCores += parseQuantity(c.requests?.cpu) ?? 0;
    r.memoryRequestBytes += parseQuantity(c.requests?.memory) ?? 0;
    const cl = parseQuantity(c.limits?.cpu);
    const ml = parseQuantity(c.limits?.memory);
    r.cpuLimitCores = cl === null || r.cpuLimitCores === null ? null : r.cpuLimitCores + cl;
    r.memoryLimitBytes =
      ml === null || r.memoryLimitBytes === null ? null : r.memoryLimitBytes + ml;
  }
  if (!containers?.length) r.cpuLimitCores = r.memoryLimitBytes = null;
  return r;
}

/** True while a pod holds node resources (not Succeeded or Failed). */
export function podIsActive(status: PodStatus): boolean {
  return status.phase !== 'Succeeded' && status.phase !== 'Failed';
}

/**
 * The status column as `kubectl get pods` shows it: Terminating, a pod reason
 * (Evicted), an init container's problem (Init:CrashLoopBackOff), a container's
 * waiting or terminated reason (CrashLoopBackOff, OOMKilled, Completed), else the phase.
 */
export function podDisplayStatus(status: PodStatus): string {
  if (status.deleting_since) return 'Terminating';
  if (status.reason) return status.reason;
  const containers = status.containers ?? [];
  for (const c of containers) {
    if (!c.init) continue;
    if (c.state === 'terminated' && c.exit_code === 0) continue;
    if (c.state === 'waiting' && c.reason && c.reason !== 'PodInitializing') {
      return `Init:${c.reason}`;
    }
    if (c.state === 'terminated' && c.reason) return `Init:${c.reason}`;
  }
  let result = status.phase ?? 'Unknown';
  for (const c of containers) {
    if (c.init) continue;
    if (c.state === 'waiting' && c.reason) result = c.reason;
    else if (c.state === 'terminated' && c.reason) result = c.reason;
  }
  return result;
}

export interface LastTermination {
  container: string;
  reason: string;
  exitCode: number;
  finishedAt: string | null;
}

/**
 * The most relevant termination of a pod: a container terminated right now, else the
 * newest previous termination (OOMKilled, Error, Completed; SPEC §4.3).
 */
export function lastTermination(status: PodStatus): LastTermination | null {
  let best: LastTermination | null = null;
  for (const c of status.containers ?? []) {
    if (c.init) continue;
    if (c.state === 'terminated' && c.reason && c.exit_code !== undefined) {
      return { container: c.name, reason: c.reason, exitCode: c.exit_code, finishedAt: null };
    }
    const t = c.last_termination;
    if (t && (!best || (t.finished_at ?? '') > (best.finishedAt ?? ''))) {
      best = {
        container: c.name,
        reason: t.reason,
        exitCode: t.exit_code,
        finishedAt: t.finished_at ?? null,
      };
    }
  }
  return best;
}

export interface PodView extends Resources {
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
  ip: string | null;
  workloadKind: string | null;
  workload: string | null;
  createdAt: string | null;
  startedAt: string | null;
  lastTermination: LastTermination | null;
  failing: string | null;
  cpuCores: number | null;
  memoryBytes: number | null;
}

export interface Usage {
  cpuCores: number | null;
  memoryBytes: number | null;
}

export function podView(row: ObjectRow, usage?: Usage, now = Date.now()): PodView {
  const spec = row.spec_summary as PodSpec;
  const st = row.status_summary as PodStatus;
  const containers = (st.containers ?? []).filter((c) => !c.init);
  const active = podIsActive(st);
  return {
    namespace: row.namespace,
    name: row.name,
    node: row.node || null,
    phase: st.phase ?? 'Unknown',
    status: podDisplayStatus(st),
    ready: st.ready ?? false,
    readyContainers: containers.filter((c) => c.ready).length,
    totalContainers: spec.containers?.length ?? containers.length,
    restarts: containers.reduce((n, c) => n + (c.restart_count ?? 0), 0),
    qosClass: st.qos_class ?? null,
    ip: st.pod_ip ?? null,
    workloadKind: spec.workload?.kind ?? null,
    workload: spec.workload?.name ?? null,
    createdAt: spec.created_at ?? null,
    startedAt: st.started_at ?? null,
    lastTermination: lastTermination(st),
    failing: st.deleting_since ? null : podFailing(st, now),
    ...containerResources(spec.containers),
    cpuCores: active ? (usage?.cpuCores ?? null) : null,
    memoryBytes: active ? (usage?.memoryBytes ?? null) : null,
  };
}

export interface ContainerView {
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
  lastTermination: { reason: string; exitCode: number; finishedAt: string | null } | null;
  cpuRequestCores: number | null;
  cpuLimitCores: number | null;
  memoryRequestBytes: number | null;
  memoryLimitBytes: number | null;
}

/** Containers of a pod: spec (image, resources) joined with status by name. */
export function containerViews(spec: PodSpec, status: PodStatus): ContainerView[] {
  const statuses = new Map(
    (status.containers ?? []).map((c) => [`${c.init ? 'i' : 'c'}/${c.name}`, c]),
  );
  const out: ContainerView[] = [];
  for (const [init, list] of [
    [true, spec.init_containers ?? []],
    [false, spec.containers ?? []],
  ] as const) {
    for (const c of list) {
      const s = statuses.get(`${init ? 'i' : 'c'}/${c.name}`);
      out.push({
        name: c.name,
        init,
        image: c.image,
        ready: s?.ready ?? false,
        state: s?.state ?? 'waiting',
        reason: s?.reason ?? null,
        message: s?.message ?? null,
        exitCode: s?.exit_code ?? null,
        restartCount: s?.restart_count ?? 0,
        startedAt: s?.started_at ?? null,
        lastTermination: s?.last_termination
          ? {
              reason: s.last_termination.reason,
              exitCode: s.last_termination.exit_code,
              finishedAt: s.last_termination.finished_at ?? null,
            }
          : null,
        cpuRequestCores: parseQuantity(c.requests?.cpu),
        cpuLimitCores: parseQuantity(c.limits?.cpu),
        memoryRequestBytes: parseQuantity(c.requests?.memory),
        memoryLimitBytes: parseQuantity(c.limits?.memory),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- nodes

export type NodeStatus = 'Ready' | 'NotReady' | 'Unknown';

export function nodeStatus(status: Summary): NodeStatus {
  const ready = ((status.conditions as NodeCondition[] | undefined) ?? []).find(
    (c) => c.type === 'Ready',
  );
  if (!ready || ready.status === 'Unknown') return 'Unknown';
  return ready.status === 'True' ? 'Ready' : 'NotReady';
}

/** Conditions that signal a problem: pressure True, NetworkUnavailable True, Ready not True. */
export function conditionIsBad(c: NodeCondition): boolean {
  return c.type === 'Ready' ? c.status !== 'True' : c.status === 'True';
}

export interface NodeView {
  name: string;
  status: NodeStatus;
  roles: string[];
  unschedulable: boolean;
  taints: string[];
  kubeletVersion: string | null;
  osImage: string | null;
  kernelVersion: string | null;
  architecture: string | null;
  containerRuntime: string | null;
  internalIp: string | null;
  createdAt: string | null;
  cpu: { usageCores: number | null; requestsCores: number; allocatableCores: number | null };
  memory: { usageBytes: number | null; requestsBytes: number; allocatableBytes: number | null };
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
  agent: {
    status: 'active' | 'inactive' | 'missing';
    version: string | null;
    kubeletTls: string | null;
    lastSeenAt: string | null;
  };
}

export interface NodeMetrics {
  cpuCores: number | null;
  memoryBytes: number | null;
  diskUtilization: number | null;
}

export interface AgentInfo {
  version: string;
  capabilities: unknown;
  lastSeenAt: Date;
  active: boolean;
}

/**
 * A node's CPU and memory capacity. The Node object's allocatable, unless the node's
 * agent measures its node from its cgroup (`node_scope: cgroup`, ADR-121): nodes that are
 * containers on a shared kernel (kind, k3d) report the host's CPUs and memory to the API
 * server, so the agent's measurement of the node container's limits is used instead.
 */
export function nodeCapacity(
  allocatable: Record<string, string> | undefined,
  capabilities: unknown,
): { cores: number | null; bytes: number | null } {
  const alloc = allocatable ?? {};
  const caps = (capabilities ?? {}) as Record<string, unknown>;
  const measured = (v: unknown) =>
    caps.node_scope === 'cgroup' && typeof v === 'number' && v > 0 ? v : null;
  return {
    cores: measured(caps.node_cpu_cores) ?? parseQuantity(alloc.cpu),
    bytes: measured(caps.node_memory_bytes) ?? parseQuantity(alloc.memory),
  };
}

export function nodeView(
  row: ObjectRow,
  pods: ObjectRow[],
  metrics: NodeMetrics | undefined,
  agent: AgentInfo | undefined,
): NodeView {
  const spec = row.spec_summary as Summary;
  const st = row.status_summary as Summary;
  const info = (st.info as Record<string, string> | undefined) ?? {};
  const alloc = (st.allocatable as Record<string, string> | undefined) ?? {};
  let requestsCores = 0;
  let requestsBytes = 0;
  let count = 0;
  for (const p of pods) {
    if (p.node !== row.name || !podIsActive(p.status_summary as PodStatus)) continue;
    count++;
    const r = containerResources((p.spec_summary as PodSpec).containers);
    requestsCores += r.cpuRequestCores;
    requestsBytes += r.memoryRequestBytes;
  }
  const caps = (agent?.capabilities ?? {}) as Record<string, unknown>;
  const capacity = nodeCapacity(alloc, agent?.capabilities);
  return {
    name: row.name,
    status: nodeStatus(st),
    roles: (spec.roles as string[] | undefined) ?? [],
    unschedulable: spec.unschedulable === true,
    taints: (spec.taints as string[] | undefined) ?? [],
    kubeletVersion: str(info.kubelet_version),
    osImage: str(info.os_image),
    kernelVersion: str(info.kernel_version),
    architecture: str(info.architecture),
    containerRuntime: str(info.container_runtime),
    internalIp: str(st.internal_ip),
    createdAt: str(spec.created_at),
    cpu: {
      usageCores: metrics?.cpuCores ?? null,
      requestsCores,
      allocatableCores: capacity.cores,
    },
    memory: {
      usageBytes: metrics?.memoryBytes ?? null,
      requestsBytes,
      allocatableBytes: capacity.bytes,
    },
    diskUtilization: metrics?.diskUtilization ?? null,
    pods: { count, capacity: parseQuantity(alloc.pods) },
    conditions: ((st.conditions as NodeCondition[] | undefined) ?? []).map((c) => ({
      type: c.type,
      status: c.status,
      reason: c.reason || null,
      message: c.message || null,
      since: c.since ?? null,
      bad: conditionIsBad(c),
    })),
    agent: {
      status: agent ? (agent.active ? 'active' : 'inactive') : 'missing',
      version: agent?.version ?? null,
      kubeletTls: str(caps.kubelet_tls),
      lastSeenAt: agent?.lastSeenAt.toISOString() ?? null,
    },
  };
}

// ---------------------------------------------------------------- workloads

export const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'] as const;
export type WorkloadKind = (typeof WORKLOAD_KINDS)[number];

export type WorkloadHealth = 'healthy' | 'progressing' | 'degraded' | 'failed' | 'suspended';

export interface WorkloadView extends Resources {
  kind: WorkloadKind;
  namespace: string;
  name: string;
  /** Desired replicas (Job: completions; CronJob: null). */
  desired: number | null;
  /** Ready replicas (Job: succeeded; CronJob: active jobs). */
  ready: number | null;
  updated: number | null;
  health: WorkloadHealth;
  pods: number;
  restarts: number;
  images: string[];
  createdAt: string | null;
  lastRolloutAt: string | null;
  schedule: string | null;
  lastScheduleAt: string | null;
  cpuCores: number | null;
  memoryBytes: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function workloadHealth(kind: WorkloadKind, spec: Summary, st: Summary): WorkloadHealth {
  switch (kind) {
    case 'CronJob':
      return spec.suspend === true ? 'suspended' : 'healthy';
    case 'Job':
      if (st.state === 'failed') return 'failed';
      return st.state === 'complete' ? 'healthy' : 'progressing';
    default: {
      const desired = kind === 'DaemonSet' ? num(st.desired) : num(spec.replicas);
      const ready = num(st.ready) ?? 0;
      const updated = num(st.updated) ?? 0;
      if (desired === null || desired === 0) return 'healthy';
      if (ready === 0) return 'failed';
      if (ready < desired) return updated < desired ? 'progressing' : 'degraded';
      return updated < desired ? 'progressing' : 'healthy';
    }
  }
}

/**
 * One workload with its pods' totals. Requests and limits are the pod template's
 * (one replica), so charts can draw them as flat lines per pod (ADR-056).
 */
export function workloadView(
  row: ObjectRow,
  pods: PodView[],
  usage: Usage | undefined,
  lastRolloutAt: string | null,
): WorkloadView {
  const kind = row.kind as WorkloadKind;
  const spec = row.spec_summary as Summary;
  const st = row.status_summary as Summary;
  const containers = (spec.containers as ContainerSpec[] | undefined) ?? [];
  let desired: number | null = null;
  let ready: number | null = null;
  let updated: number | null = num(st.updated);
  switch (kind) {
    case 'Deployment':
    case 'StatefulSet':
      desired = num(spec.replicas);
      ready = num(st.ready) ?? 0;
      break;
    case 'DaemonSet':
      desired = num(st.desired);
      ready = num(st.ready) ?? 0;
      break;
    case 'Job':
      desired = num(spec.completions);
      ready = num(st.succeeded) ?? 0;
      break;
    case 'CronJob':
      ready = num(st.active) ?? 0;
      updated = null;
      break;
  }
  const active = pods.filter((p) => p.phase !== 'Succeeded' && p.phase !== 'Failed');
  return {
    kind,
    namespace: row.namespace,
    name: row.name,
    desired,
    ready,
    updated,
    health: workloadHealth(kind, spec, st),
    pods: active.length,
    restarts: pods.reduce((n, p) => n + p.restarts, 0),
    images: [...new Set(containers.map((c) => c.image))],
    createdAt: str(spec.created_at),
    lastRolloutAt,
    schedule: str(spec.schedule),
    lastScheduleAt: str(st.last_schedule),
    ...containerResources(containers),
    cpuCores: active.length ? (usage?.cpuCores ?? null) : null,
    memoryBytes: active.length ? (usage?.memoryBytes ?? null) : null,
  };
}

// ---------------------------------------------------------------- overview

export type Severity = 'critical' | 'warning';

export interface AttentionItem {
  severity: Severity;
  kind: 'CrashLoopBackOff' | 'NodeNotReady' | 'OOMKilled' | 'PendingPod' | 'PVCFull' | 'ImagePull';
  /** Object the item is about: Pod/<ns>/<name>, Node/<name>, PersistentVolumeClaim/<ns>/<name>. */
  objectKind: 'Pod' | 'Node' | 'PersistentVolumeClaim';
  namespace: string | null;
  name: string;
  detail: string;
  since: string | null;
}

/** An OOM kill counts as current for this long after the container finished. */
export const OOM_RECENT_MS = 60 * 60 * 1000;
export const PENDING_AFTER_MS = 5 * 60 * 1000;
/** A container that keeps failing counts as crash-looping for this long after a failure. */
export const CRASH_RECENT_MS = 10 * 60 * 1000;
const CRASH_RESTARTS = 3;

/**
 * Kubernetes shows CrashLoopBackOff only while the container waits for its next
 * start; between back-offs it is briefly running or terminated (measured on kind and
 * k3s: the crashloop test pod dropped out of the list). A container with three or more
 * restarts whose last run failed within ten minutes is crash-looping too.
 */
export function crashLooping(c: ContainerStatus, now: number): boolean {
  if (c.state === 'waiting' && c.reason === 'CrashLoopBackOff') return true;
  if (c.restart_count < CRASH_RESTARTS) return false;
  if (c.state === 'terminated') return !!c.reason && c.reason !== 'Completed';
  const t = c.last_termination;
  return !!t && t.reason !== 'Completed' && now - Date.parse(t.finished_at ?? '') < CRASH_RECENT_MS;
}

const PULL_ERRORS = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
]);

/**
 * Why a pod is failing right now, else null: crash-looping (named OOMKilled when that
 * was the last exit), a container that cannot start, or the pod failed. Heatmaps mark
 * these pods with ✕.
 */
export function podFailing(st: PodStatus, now: number): string | null {
  if (st.phase === 'Failed') return st.reason || 'Failed';
  for (const c of st.containers ?? []) {
    if (crashLooping(c, now)) {
      const last = c.state === 'terminated' ? c.reason : c.last_termination?.reason;
      return last === 'OOMKilled' ? 'OOMKilled' : 'CrashLoopBackOff';
    }
    if (c.state === 'waiting' && c.reason && PULL_ERRORS.has(c.reason)) return c.reason;
  }
  return null;
}
export const PVC_FULL_RATIO = 0.85;
const ATTENTION_LIMIT = 10;

const restarts = (n: number) => (n === 1 ? '1 restart' : `${n} restarts`);

const SEVERITY_ORDER: Record<AttentionItem['kind'], number> = {
  NodeNotReady: 0,
  CrashLoopBackOff: 1,
  OOMKilled: 2,
  ImagePull: 3,
  PendingPod: 4,
  PVCFull: 5,
};

/**
 * "Needs attention" (SPEC §4.1): NotReady nodes, CrashLoopBackOff pods, OOMKilled
 * containers (now or within the last hour), image pull failures, pods pending for
 * more than 5 minutes, PVCs above 85 %. Ordered by severity, at most 10.
 */
export function needsAttention(
  nodes: ObjectRow[],
  pods: ObjectRow[],
  pvcUtilization: { namespace: string; name: string; ratio: number }[],
  now = Date.now(),
  limit = ATTENTION_LIMIT,
): { items: AttentionItem[]; total: number } {
  const items: AttentionItem[] = [];
  for (const n of nodes) {
    const st = n.status_summary as Summary;
    if (nodeStatus(st) === 'Ready') continue;
    const ready = ((st.conditions as NodeCondition[] | undefined) ?? []).find(
      (c) => c.type === 'Ready',
    );
    items.push({
      severity: 'critical',
      kind: 'NodeNotReady',
      objectKind: 'Node',
      namespace: null,
      name: n.name,
      detail: ready?.reason || 'NotReady',
      since: ready?.since ?? null,
    });
  }
  for (const p of pods) {
    const st = p.status_summary as PodStatus;
    const spec = p.spec_summary as PodSpec;
    const base = { objectKind: 'Pod' as const, namespace: p.namespace, name: p.name };
    const containers = st.containers ?? [];
    const crash = containers.find((c) => !c.init && crashLooping(c, now));
    if (crash) {
      // The termination being restarted now, else the previous one.
      const t =
        crash.state === 'terminated' && crash.reason
          ? { reason: crash.reason, exit_code: crash.exit_code ?? 0, finished_at: undefined }
          : crash.last_termination;
      items.push({
        ...base,
        severity: 'critical',
        kind: 'CrashLoopBackOff',
        detail: t
          ? `${crash.name}: ${t.reason} (exit ${t.exit_code}), ${restarts(crash.restart_count)}`
          : `${crash.name}: ${restarts(crash.restart_count)}`,
        since: crash.last_termination?.finished_at ?? null,
      });
      continue;
    }
    const oom = containers.find(
      (c) =>
        (c.state === 'terminated' && c.reason === 'OOMKilled') ||
        (c.last_termination?.reason === 'OOMKilled' &&
          now - Date.parse(c.last_termination.finished_at ?? '') < OOM_RECENT_MS),
    );
    if (oom) {
      items.push({
        ...base,
        severity: 'warning',
        kind: 'OOMKilled',
        detail: `${oom.name}: OOMKilled (exit ${oom.exit_code ?? oom.last_termination?.exit_code ?? 137}), ${restarts(oom.restart_count)}`,
        since: oom.last_termination?.finished_at ?? null,
      });
      continue;
    }
    const pull = containers.find(
      (c) =>
        c.state === 'waiting' && (c.reason === 'ImagePullBackOff' || c.reason === 'ErrImagePull'),
    );
    if (pull) {
      items.push({
        ...base,
        severity: 'warning',
        kind: 'ImagePull',
        detail: `${pull.name}: ${pull.reason}`,
        since: null,
      });
      continue;
    }
    const created = Date.parse(spec.created_at ?? st.started_at ?? '');
    if (st.phase === 'Pending' && !st.deleting_since && now - created > PENDING_AFTER_MS) {
      items.push({
        ...base,
        severity: 'warning',
        kind: 'PendingPod',
        detail: st.reason || st.message || 'Pending',
        since: spec.created_at ?? null,
      });
    }
  }
  for (const v of pvcUtilization) {
    if (v.ratio <= PVC_FULL_RATIO) continue;
    items.push({
      severity: 'warning',
      kind: 'PVCFull',
      objectKind: 'PersistentVolumeClaim',
      namespace: v.namespace,
      name: v.name,
      detail: `${Math.round(v.ratio * 100)} % used`,
      since: null,
    });
  }
  items.sort(
    (a, b) =>
      SEVERITY_ORDER[a.kind] - SEVERITY_ORDER[b.kind] ||
      (a.namespace ?? '').localeCompare(b.namespace ?? '') ||
      a.name.localeCompare(b.name),
  );
  return { items: items.slice(0, limit), total: items.length };
}
