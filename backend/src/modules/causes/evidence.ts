// SPDX-License-Identifier: AGPL-3.0-only
// The evidence snapshot (ADR-146): what WatchLog already stores about one object, gathered
// on demand through the public API in-process (mcp/reader.ts), as the caller. The queries
// stay where they live (the pod, workload, container, event, change-marker, node, host,
// service-map and application routes); this module only asks them, so a cause can never
// show more than the API shows the same user or token. Rules and checks are pure functions
// of the snapshot: fixtures are snapshots (test/fixtures/causes/).
import type { Platform } from './types.js';

/** What evidence is read with: the in-process API reader, or a fixture in tests. */
export interface Reader {
  get<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<T>;
}

/** The object whose evidence is gathered: a subject, or what an alert or edge is about. */
export type Focus =
  | { kind: 'pod'; namespace: string; name: string }
  | { kind: 'workload'; namespace: string; workloadKind: string; name: string }
  | { kind: 'container'; host: string; name: string }
  | { kind: 'compose_service'; project: string; service: string }
  | { kind: 'node'; name: string }
  | { kind: 'host'; name: string }
  | { kind: 'application'; id: string }
  | { kind: 'none' };

// ---- The API's shapes, as far as causes read them (measured on kind and Docker, slice 0).

export interface EvEvent {
  type: string;
  reason: string;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  namespace: string | null;
  involvedKind: string;
  involvedName: string;
  host?: string | null;
}

export interface EvMarker {
  /** rollout, image, scale, node, namespace (Kubernetes); recreate, image, compose (Docker). */
  kind: string;
  /** Kind/namespace/name, Node/name; Container/host/name, Compose/host/project. */
  target: string;
  namespace: string | null;
  details: Record<string, unknown>;
  ts: string;
}

export interface EvTermination {
  container?: string;
  reason: string;
  exitCode: number;
  finishedAt: string | null;
}

export interface EvPodContainer {
  name: string;
  init: boolean;
  image: string;
  ready: boolean;
  state: string;
  reason: string | null;
  exitCode: number | null;
  restartCount: number;
  lastTermination: EvTermination | null;
  cpuLimitCores: number | null;
  memoryLimitBytes: number | null;
  memoryBytes: number | null;
}

export interface EvPod {
  namespace: string;
  name: string;
  node: string | null;
  phase: string;
  status: string;
  ready: boolean;
  restarts: number;
  workloadKind: string | null;
  workload: string | null;
  createdAt: string | null;
  startedAt: string | null;
  lastTermination: EvTermination | null;
  /** CrashLoopBackOff, OOMKilled, ImagePullBackOff, Pending… or null. */
  failing: string | null;
  cpuLimitCores: number | null;
  memoryLimitBytes: number | null;
  memoryBytes: number | null;
  /** Only when the pod's detail was read (a pod subject). */
  containers?: EvPodContainer[];
}

export interface EvWorkload {
  kind: string;
  namespace: string;
  name: string;
  desired: number | null;
  ready: number | null;
  updated: number | null;
  health: string;
  restarts: number;
  restartsInRange: number | null;
  images: string[];
  lastRolloutAt: string | null;
  problem: { severity: string; reason: string; alertId: string | null } | null;
  podStates: string[];
}

export interface EvNode {
  name: string;
  status: string;
  unschedulable: boolean;
  taints: string[];
  conditions: {
    type: string;
    status: string;
    reason: string | null;
    since: string | null;
    bad: boolean;
  }[];
  agent: { status: string; lastSeenAt: string | null };
}

export interface EvContainer {
  name: string;
  host: string;
  image: string;
  state: string;
  status: string;
  health: string | null;
  restartCount: number;
  restartsInRange: number | null;
  exitCode: number;
  oomKilled: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  composeProject: string | null;
  composeService: string | null;
  cpuLimitCores: number | null;
  memoryLimitBytes: number | null;
  memoryBytes: number | null;
  restarting: boolean;
  healthDetail: { status: string; failingStreak: number; since: string | null } | null;
  problem: { severity: string; kind: string; reason: string | null; alertId: string | null } | null;
}

export interface EvHost {
  name: string;
  status: string;
  lastSeenAt: string | null;
  cpuUtilization: number | null;
  memoryUtilization: number | null;
  diskUtilization: number | null;
}

export interface EvEdge {
  id: string;
  source: string;
  target: string;
  port: number | null;
  service: string | null;
  connectionsPerSecond: number;
  failedPerSecond: number;
  failedRatio: number | null;
  latencyP95Seconds: number | null;
  failedLastMinute?: number;
  http: {
    requestsPerSecond: number;
    serverErrorsPerSecond: number;
    serverErrorRatio: number | null;
    p50Seconds: number | null;
    p95Seconds: number | null;
    p99Seconds: number | null;
  } | null;
  health: string;
}

export interface EvDns {
  node: string;
  requestsPerSecond: number;
  nxdomainPerSecond: number;
  servfailPerSecond: number;
  timeoutPerSecond: number;
  searchMissPerSecond: number;
  errorRatio: number;
}

export interface EvMapNode {
  id: string;
  kind: string;
  name: string;
  namespace: string | null;
  workloadKind: string | null;
}

export interface EvAgentFlows {
  node: string;
  ebpf: string;
  reason: string | null;
  cause: string | null;
}

export interface EvMap {
  /** flows: eBPF traffic; topology: no agent sees flows; unavailable: metrics couldn't be read. */
  mode: 'flows' | 'topology' | 'unavailable';
  agents: EvAgentFlows[];
  /** The focus's own map node ids (w:… for a workload, c:… per container). */
  ids: string[];
  nodes: EvMapNode[];
  /** Edges from and to the focus, as the map has them (rates over 5 minutes). */
  outgoing: EvEdge[];
  incoming: EvEdge[];
  dns: EvDns[];
}

export interface EvApplication {
  id: string;
  type: string;
  name: string;
  health: string;
  reason: { code: string; facts: Record<string, string | number | null> };
  target: Record<string, unknown>;
  reasons: {
    severity: string;
    code: string;
    facts: Record<string, string | number | null>;
    links?: { kind: string; id: string; name: string }[];
  }[];
}

export interface EvAlert {
  id: string;
  state: string;
  severity: string;
  rule: { id: string; key: string | null; name: string };
  labels: Record<string, string>;
  startedAt: string;
  firedAt: string | null;
  resolvedAt: string | null;
}

/** Everything the rules and checks may use about one focus. */
export interface Evidence {
  platform: Platform;
  clusterId: string;
  focus: Focus;
  /** When the snapshot was taken (ms). */
  now: number;
  /** The window looked at: 60 minutes before the symptom, to its end (ADR-146). */
  window: { from: string; to: string };
  /** When the symptom began, when known. */
  symptomAt: string | null;
  /** Kubernetes: the pod, or the workload's pods. */
  pods: EvPod[];
  workload: EvWorkload | null;
  /** Docker: the container, or the Compose service's containers. */
  containers: EvContainer[];
  /** The object's events last seen in the window, newest first. */
  events: EvEvent[];
  /** Change markers in the window, in its namespace (Kubernetes) or cluster (Docker). */
  changes: EvMarker[];
  /** Change marker targets that are the object itself (or its workload, its node). */
  ownTargets: string[];
  /** Kubernetes nodes under its pods; Docker hosts under its containers. */
  nodes: EvNode[];
  hosts: EvHost[];
  map: EvMap;
  /** The monitored application (an application subject). */
  application: EvApplication | null;
  /** The edge (an edge subject). */
  edge: EvEdge | null;
  /** The alert (an alert subject). */
  alert: EvAlert | null;
  /** The focus no longer exists (an alert on a pod that was deleted). */
  gone: boolean;
}

export const emptyMap = (mode: EvMap['mode'] = 'unavailable'): EvMap => ({
  mode,
  agents: [],
  ids: [],
  nodes: [],
  outgoing: [],
  incoming: [],
  dns: [],
});

/** The window before a symptom that changes and events are looked for in (ADR-146). */
export const WINDOW_BEFORE_MS = 60 * 60_000;
/** Nodes or hosts whose state is read for a workload or Compose service. */
export const MAX_NODES = 3;
/** Containers whose events are read for a Compose service. */
export const MAX_EVENT_CONTAINERS = 3;
