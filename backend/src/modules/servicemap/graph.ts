// SPDX-License-Identifier: AGPL-3.0-only
// The service map (SPEC §4.5, Phase 4): nodes are workloads, Docker containers,
// Services, nodes, external networks and "Internet"; edges are the TCP connections the
// agents' eBPF programs saw (ADR-099…ADR-101), with rates over the last 5 minutes.
// Built from query results so it can be tested without VictoriaMetrics.
import type { QuerySeries } from '../../lib/victoria.js';

/** The labels that identify an edge on the flow series (agent/internal/collectors/network). */
export const EDGE_LABELS = [
  'namespace',
  'workload_kind',
  'workload',
  'container',
  'compose_project',
  'compose_service',
  'dst_kind',
  'dst_namespace',
  'dst_workload_kind',
  'dst_workload',
  'dst_service',
  'dst',
  'dst_port',
] as const;

export type NodeKind = 'workload' | 'container' | 'service' | 'node' | 'external' | 'internet';
export type Health = 'ok' | 'warning' | 'critical' | 'idle' | 'unknown';

export interface MapNode {
  id: string;
  kind: NodeKind;
  name: string;
  namespace: string | null;
  workloadKind: string | null;
  /** One of WatchLog's own components (agents, backend, its databases): hidden by default. */
  watchlog?: boolean;
}

export interface MapEdge {
  id: string;
  source: string;
  target: string;
  port: number | null;
  /** The Service a client connected through, when the target is its workload. */
  service: string | null;
  connectionsPerSecond: number;
  failedPerSecond: number;
  failedRatio: number | null;
  latencyMeanSeconds: number | null;
  latencyP95Seconds: number | null;
  bytesSentPerSecond: number | null;
  bytesReceivedPerSecond: number | null;
  retransmitsPerSecond: number;
  health: Health;
}

/** Failed share at which an edge is critical: the default rule's threshold (§4.7). */
export const FAILED_CRITICAL = 0.05;
export const FAILED_WARNING = 0.01;
export const P95_WARNING_S = 1;

type L = Record<string, string | undefined>;

export function sourceNode(l: L): MapNode | null {
  if (l.workload) {
    return {
      id: `w:${l.namespace ?? ''}/${l.workload_kind ?? ''}/${l.workload}`,
      kind: 'workload',
      name: l.workload,
      namespace: l.namespace ?? null,
      workloadKind: l.workload_kind ?? null,
    };
  }
  if (l.container) {
    return {
      id: `c:${l.container}`,
      kind: 'container',
      name: l.compose_service || l.container,
      namespace: l.compose_project ?? null,
      workloadKind: null,
    };
  }
  return null;
}

export function targetNode(l: L): MapNode | null {
  const port = l.dst_port ?? '';
  switch (l.dst_kind) {
    case 'workload':
      return {
        id: `w:${l.dst_namespace ?? ''}/${l.dst_workload_kind ?? ''}/${l.dst_workload ?? ''}`,
        kind: 'workload',
        name: l.dst_workload ?? '',
        namespace: l.dst_namespace ?? null,
        workloadKind: l.dst_workload_kind ?? null,
      };
    case 'service':
      return {
        id: `s:${l.dst_namespace ?? ''}/${l.dst_service ?? ''}`,
        kind: 'service',
        name: l.dst_service ?? '',
        namespace: l.dst_namespace ?? null,
        workloadKind: null,
      };
    case 'node':
      return {
        id: `n:${l.dst ?? ''}`,
        kind: 'node',
        name: l.dst ?? '',
        namespace: null,
        workloadKind: null,
      };
    case 'container':
      return {
        id: `c:${l.dst ?? ''}`,
        kind: 'container',
        name: l.dst ?? '',
        namespace: null,
        workloadKind: null,
      };
    case 'external':
      // An external dependency is its network and port, as in "db.example.com:5432".
      return {
        id: `x:${l.dst ?? ''}:${port}`,
        kind: 'external',
        name: `${l.dst ?? ''}:${port}`,
        namespace: null,
        workloadKind: null,
      };
    case 'internet':
      return {
        id: 'internet',
        kind: 'internet',
        name: 'Internet',
        namespace: null,
        workloadKind: null,
      };
  }
  return null;
}

const edgeKey = (l: L) => EDGE_LABELS.map((k) => l[k] ?? '').join('\u0000');
const value = (s: QuerySeries | undefined) => {
  const v = s?.points.at(-1)?.[1];
  return v === null || v === undefined || Number.isNaN(v) ? null : v;
};

export function health(
  e: Pick<MapEdge, 'connectionsPerSecond' | 'failedRatio' | 'latencyP95Seconds'> &
    Partial<Pick<MapEdge, 'bytesSentPerSecond' | 'bytesReceivedPerSecond'>>,
): Health {
  // Keep-alive clients (HTTP/1.1 pools, database pools) open no new connections but
  // still move bytes: that edge is in use, not idle (measured on kind with podinfo).
  const bytes = (e.bytesSentPerSecond ?? 0) + (e.bytesReceivedPerSecond ?? 0);
  if (e.connectionsPerSecond === 0 && bytes === 0) return 'idle';
  if ((e.failedRatio ?? 0) >= FAILED_CRITICAL) return 'critical';
  if ((e.failedRatio ?? 0) >= FAILED_WARNING || (e.latencyP95Seconds ?? 0) >= P95_WARNING_S)
    return 'warning';
  return 'ok';
}

export interface FlowResults {
  /** Edges with any connection in the selected range. */
  seen: QuerySeries[];
  connections: QuerySeries[];
  failed: QuerySeries[];
  latencySum: QuerySeries[];
  latencyCount: QuerySeries[];
  latencyP95: QuerySeries[];
  /** By `dir` (sent, received); empty when no agent has byte counters. */
  bytes: QuerySeries[];
  retransmits: QuerySeries[];
}

/** Nodes and edges from the flow queries (rates per second over the last 5 minutes). */
export function buildGraph(r: FlowResults): { nodes: MapNode[]; edges: MapEdge[] } {
  const by = (list: QuerySeries[]) => new Map(list.map((s) => [edgeKey(s.labels), s]));
  const conn = by(r.connections);
  const failed = by(r.failed);
  const latSum = by(r.latencySum);
  const latCount = by(r.latencyCount);
  const p95 = by(r.latencyP95);
  const retrans = by(r.retransmits);
  const sent = by(r.bytes.filter((s) => s.labels.dir === 'sent'));
  const received = by(r.bytes.filter((s) => s.labels.dir === 'received'));
  const nodes = new Map<string, MapNode>();
  const edges: MapEdge[] = [];
  for (const s of r.seen) {
    const l = s.labels;
    const src = sourceNode(l);
    const dst = targetNode(l);
    if (!src || !dst) continue;
    nodes.set(src.id, src);
    nodes.set(dst.id, dst);
    const k = edgeKey(l);
    const c = value(conn.get(k)) ?? 0;
    const f = value(failed.get(k)) ?? 0;
    const n = value(latCount.get(k));
    const sum = value(latSum.get(k));
    const port = l.dst_port ? Number(l.dst_port) : null;
    const e: MapEdge = {
      id: `${src.id}>${dst.id}:${port ?? ''}`,
      source: src.id,
      target: dst.id,
      port,
      service: l.dst_kind === 'workload' && l.dst_service ? l.dst_service : null,
      connectionsPerSecond: c,
      failedPerSecond: f,
      // Failures and attempts land in slightly different windows: never above 100 %.
      failedRatio: c > 0 ? Math.min(1, f / c) : null,
      latencyMeanSeconds: n && sum !== null ? sum / n : null,
      latencyP95Seconds: value(p95.get(k)),
      bytesSentPerSecond: value(sent.get(k)),
      bytesReceivedPerSecond: value(received.get(k)),
      retransmitsPerSecond: value(retrans.get(k)) ?? 0,
      health: 'unknown',
    };
    e.health = health(e);
    edges.push(e);
  }
  edges.sort((a, b) => a.id.localeCompare(b.id));
  return { nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges };
}

/** Label matchers selecting one edge's series, from its node ids and port. */
export function edgeMatchers(
  source: string,
  target: string,
  port: number | null,
): Record<string, string> | null {
  const m: Record<string, string> = {};
  const [sk, ...srest] = source.split(':');
  const sv = srest.join(':');
  if (sk === 'w') {
    const [ns, kind, ...name] = sv.split('/');
    Object.assign(m, { namespace: ns ?? '', workload_kind: kind ?? '', workload: name.join('/') });
  } else if (sk === 'c') {
    m.container = sv;
  } else {
    return null;
  }
  const [tk, ...trest] = target.split(':');
  const tv = trest.join(':');
  switch (tk) {
    case 'w': {
      const [ns, kind, ...name] = tv.split('/');
      Object.assign(m, {
        dst_kind: 'workload',
        dst_namespace: ns ?? '',
        dst_workload_kind: kind ?? '',
        dst_workload: name.join('/'),
      });
      break;
    }
    case 's': {
      const [ns, ...name] = tv.split('/');
      Object.assign(m, {
        dst_kind: 'service',
        dst_namespace: ns ?? '',
        dst_service: name.join('/'),
      });
      break;
    }
    case 'n':
      Object.assign(m, { dst_kind: 'node', dst: tv });
      break;
    case 'c':
      Object.assign(m, { dst_kind: 'container', dst: tv });
      break;
    case 'x':
      // "x:<network>:<port>": the network itself may contain ':' (IPv6).
      Object.assign(m, { dst_kind: 'external', dst: tv.slice(0, tv.lastIndexOf(':')) });
      break;
    case 'internet':
      m.dst_kind = 'internet';
      break;
    default:
      return null;
  }
  if (port !== null && tk !== 'internet') m.dst_port = String(port);
  return m;
}

export interface DnsRow {
  /** The source node (workload or Docker container). */
  node: string;
  requestsPerSecond: number;
  nxdomainPerSecond: number;
  servfailPerSecond: number;
  timeoutPerSecond: number;
  /**
   * NXDOMAIN for names under the pod's search domains (ndots expansions, ADR-113): the
   * resolver at work, left out of the lookups and the errors.
   */
  searchMissPerSecond: number;
  /** NXDOMAIN, SERVFAIL, other errors and timeouts over all lookups. */
  errorRatio: number;
}

/** DNS outcomes per source from `sum by (source labels, rcode) (rate(...))`. */
export function dnsRows(series: QuerySeries[]): DnsRow[] {
  const by = new Map<string, DnsRow & { errors: number }>();
  for (const s of series) {
    const src = sourceNode(s.labels);
    const v = value(s);
    if (!src || v === null) continue;
    const row = by.get(src.id) ?? {
      node: src.id,
      requestsPerSecond: 0,
      nxdomainPerSecond: 0,
      servfailPerSecond: 0,
      timeoutPerSecond: 0,
      searchMissPerSecond: 0,
      errorRatio: 0,
      errors: 0,
    };
    by.set(src.id, row);
    const rcode = s.labels.rcode;
    if (rcode === 'search_miss') {
      row.searchMissPerSecond += v;
      continue;
    }
    row.requestsPerSecond += v;
    if (rcode === 'NXDOMAIN') row.nxdomainPerSecond += v;
    if (rcode === 'SERVFAIL') row.servfailPerSecond += v;
    if (rcode === 'timeout') row.timeoutPerSecond += v;
    if (rcode !== 'NOERROR') row.errors += v;
  }
  return [...by.values()]
    .map(({ errors, ...r }) => ({
      ...r,
      errorRatio: r.requestsPerSecond > 0 ? errors / r.requestsPerSecond : 0,
    }))
    .filter((r) => r.requestsPerSecond > 0)
    .sort((a, b) => b.errorRatio - a.errorRatio || b.requestsPerSecond - a.requestsPerSecond);
}

/** A workload or container that may be one of WatchLog's own components. */
export interface ComponentCandidate {
  id: string;
  /** Namespace (Kubernetes) or host (Docker): components of one install share it. */
  group: string;
  name: string;
  images: string[];
}

const OWN_IMAGE = /(^|\/)(watchlog-light\/[a-z-]+|watchlog-(agent|backend|web))(:|@|$)/;
const OWN_SUFFIX = /-(backend|web|alert-worker|cluster-agent|agent)$/;
const SIBLINGS =
  '(backend|web|alert-worker|cluster-agent|agent|postgres|postgresql|victoriametrics|migrate)';

/**
 * WatchLog's own components, so the map can hide its own traffic: anything running a
 * WatchLog image, and its siblings of the same install (the chart's or Compose's
 * PostgreSQL and VictoriaMetrics), named `<release>-<component>` in the same group.
 */
export function watchlogComponents(rows: ComponentCandidate[]): Set<string> {
  const out = new Set<string>();
  const prefixes = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.images.some((i) => OWN_IMAGE.test(i))) continue;
    out.add(r.id);
    const set = prefixes.get(r.group) ?? new Set<string>();
    set.add(r.name.replace(OWN_SUFFIX, ''));
    prefixes.set(r.group, set);
  }
  for (const r of rows) {
    for (const p of prefixes.get(r.group) ?? []) {
      if (
        new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-${SIBLINGS}(-\\d+)?$`).test(r.name)
      )
        out.add(r.id);
    }
  }
  return out;
}
