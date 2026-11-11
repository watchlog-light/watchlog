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
  /** A read sent as POST (the curated metric query); without it, metrics stay unread. */
  post?<T>(path: string, body: object): Promise<T>;
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
  /** The waiting or terminated message (e.g. the registry's answer to a pull). */
  message?: string | null;
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
  /** Containers in the pod (the pods API). */
  totalContainers?: number;
  createdAt: string | null;
  startedAt: string | null;
  lastTermination: EvTermination | null;
  /** CrashLoopBackOff, OOMKilled, ImagePullBackOff, Pending… or null. */
  failing: string | null;
  cpuRequestCores?: number | null;
  memoryRequestBytes?: number | null;
  cpuLimitCores: number | null;
  memoryLimitBytes: number | null;
  memoryBytes: number | null;
  /** Only when the pod's detail was read (a pod subject, or a workload's failing pods). */
  containers?: EvPodContainer[];
  /** The pod's own message (an eviction's "The node was low on resource: memory…"), from its detail. */
  message?: string | null;
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
  /** CronJobs: the newest run (a Job), when one ran. */
  lastRun?: { result: 'succeeded' | 'failed' | 'running'; at: string | null } | null;
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
  /** Memory used and allocatable (the nodes API), when known. */
  memory?: { usageBytes: number | null; allocatableBytes: number | null } | null;
  /** The node's own events (NodeNotSchedulable, NodeNotReady…), from its detail, newest first. */
  events?: EvEvent[];
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
  /** Unix seconds: when this container (this incarnation) was created. */
  createdAt?: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Stopped by its host's reboot or its daemon's restart (the containers API, ADR-159). */
  stoppedWith?: { how: 'host' | 'docker'; at: string };
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

/** A counter's increase over the counted hour, and when it first and last went up (unix s). */
export interface EvCount {
  n: number;
  first: number | null;
  last: number | null;
}

/**
 * Metrics of the focus over the counted hour: the last 60 minutes of the window, to its end
 * (now, or when the alert resolved), so counts are always inside the window. Read through
 * POST /query/range; null when they couldn't be read (rules then fall back to the object's
 * own numbers or say less).
 */
export interface EvMetrics {
  from: string;
  to: string;
  /** Seconds between points. */
  step: number;
  /** Restarts per pod (`<namespace>/<pod>`) or container (`<host>/<name>`). */
  restarts: Record<string, EvCount>;
  /** Docker: OOM kills per container (`<host>/<name>`), from the container's oom events. */
  oomKills: Record<string, EvCount>;
  /** Working set per container (`<namespace>/<pod>/<container>` or `<host>/<name>`), [unix s, bytes]. */
  memory: Record<string, [number, number][]>;
  /**
   * NXDOMAIN answers per second to the focus's lookups, [unix s, per second]; read only when
   * the map shows some (slice 3). Absent in older snapshots.
   */
  nxdomain?: [number, number][];
  /**
   * Throttled CPU seconds a second per container (`<namespace>/<pod>/<container>` or
   * `<host>/<name>`), [unix s, s/s] (slice 4, cpu_throttled); read only when the focus has a
   * CPU limit. Absent in older snapshots.
   */
  cpuThrottled?: Record<string, [number, number][]>;
}

/**
 * An edge over the last hour (GET /service-map/edge), as the dependency rules read it: when
 * its current trouble began, when it last carried a connection. Times are ISO; null when the
 * series doesn't say (no data, or the state lasts the whole hour).
 */
export interface EdgeHistory {
  /** The current run of failed connects (≥ 1 %) or 5xx answers (≥ 1 %) began. */
  troubleSince: string | null;
  /** The current run of a slow p95 (≥ 1 s) began. */
  slowSince: string | null;
  /** The p95 before that run (the median of the points before it), seconds. */
  p95Before: number | null;
  /**
   * Slice 4: the current run of a p95 well above the edge's own usual one (at least 50 ms and
   * 5 times the hour's lower quartile) began, though it may be under the 1 s "slow" bar (a
   * dependency that went from 1 ms to 200 ms); null when it isn't (or began before the hour).
   * Absent in older snapshots.
   */
  risenSince?: string | null;
  /** That usual p95: the lower quartile of the hour's points, seconds. */
  p95Usual?: number | null;
  /**
   * The last point with traffic: a new connection, bytes either way or HTTP requests (a
   * keep-alive client opens no new connection while its requests flow).
   */
  lastConnectedAt: string | null;
  /** The newest point of the series (data lags the clock by about a minute). */
  end: string | null;
}

/**
 * How the walk reached this focus (slice 3): the edge from the caller that is failing, slow
 * or went quiet, and what the caller sees. Rules at the far end of an edge
 * (dependency_down, connection_refused, bad_change's dependency form, application_finding's
 * caller form) need it; null on the subject itself.
 */
export interface Via {
  edge: EvEdge;
  history: EdgeHistory | null;
  /** The caller's short name ("web") and its object. */
  from: string;
  caller: { kind: string; ref: string; name: string };
  /** The caller's failed DNS lookups a second (NXDOMAIN, SERVFAIL, timeouts; no search misses). */
  dnsErrorsPerSecond: number;
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
  /**
   * The monitored application: an application subject's, or (at the far end of an edge) the
   * one monitoring this workload or container, with its findings.
   */
  application: EvApplication | null;
  /** The edge (an edge subject). */
  edge: EvEdge | null;
  /** The alert (an alert subject). */
  alert: EvAlert | null;
  /** The focus no longer exists (an alert on a pod that was deleted). */
  gone: boolean;
  /** Restarts, OOM kills and memory over the counted hour; null when unread. */
  metrics: EvMetrics | null;
  /** The edge the walk followed to reach this focus; null (or absent) on the subject. */
  via?: Via | null;
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
/** Restarts and kills are counted over the window's last hour ("in the last hour"). */
export const COUNT_MS = 60 * 60_000;
/** Failing pods of a workload whose detail (containers, messages) is read. */
export const MAX_POD_DETAILS = 2;
/** Nodes or hosts whose state is read for a workload or Compose service. */
export const MAX_NODES = 3;
/** Containers whose events are read for a Compose service. */
export const MAX_EVENT_CONTAINERS = 3;
