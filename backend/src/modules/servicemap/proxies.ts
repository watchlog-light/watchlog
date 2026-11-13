// SPDX-License-Identifier: AGPL-3.0-only
// Traefik on the service map (ADR-165): what its own metrics add to the eBPF edges.
//   - An edge from Traefik to a backend with no eBPF HTTP (TLS or HTTP/2 to the backend)
//     gets Traefik's numbers, marked "from Traefik". An edge eBPF reads keeps eBPF's:
//     nothing is added to it, so no request is counted twice.
//   - Requests Traefik answered itself with no server up: measured on Traefik 3.6, its
//     503 "no available server" is counted on the entrypoint and never on the service,
//     so the figure is the entrypoints' 503s less the services' 503s. It goes on the
//     edge to each backend that has no server up (an edge is added when the outage left
//     none), whole on each when several are down at once: no invented shares.
//   - The Traefik node gets requests per entrypoint, TLS included, which no edge carries
//     when clients come from outside the cluster.
// Built from query results so it can be tested without VictoriaMetrics.
import type { QuerySeries } from '../../lib/victoria.js';
import {
  isInternal,
  noServerUp as down,
  type TraefikBackend,
} from '../integrations/traefik-backends.js';
import { health, type EdgeHttp, type MapEdge, type MapNode } from './graph.js';

/** A Traefik integration and its node on the map. */
export interface ProxyTarget {
  integrationId: string;
  /** `w:<ns>/<kind>/<name>` or `c:<container>`. */
  node: MapNode;
}

export interface ProxyResults {
  /** By service (integration id), traefik_service and code: requests/s over 5 min. */
  serviceByCode: QuerySeries[];
  /** By service and traefik_service: latency quantiles of the service histogram. */
  p50: QuerySeries[];
  p95: QuerySeries[];
  p99: QuerySeries[];
  /** By service, entrypoint and code: requests/s over 5 min. */
  entrypointByCode: QuerySeries[];
  /** By service and entrypoint: TLS requests/s. */
  entrypointTls: QuerySeries[];
  /** By service and traefik_service: served in the last hour. */
  seen: QuerySeries[];
  /** By service and traefik_service: max of traefik_service_server_up (health checks only). */
  serverUp: QuerySeries[];
}

export interface ProxyEntrypoint {
  name: string;
  requestsPerSecond: number;
  serverErrorsPerSecond: number;
  tlsRequestsPerSecond: number;
}

export interface ProxySummary {
  node: string;
  integrationId: string;
  entrypoints: ProxyEntrypoint[];
  /** Requests Traefik answered itself (503, no server up), per second over 5 min. */
  answeredPerSecond: number;
}

/** Traefik's own entrypoints: its metrics and its API, not traffic. */
const OWN_ENTRYPOINTS = new Set(['metrics', 'traefik']);

const value = (s: QuerySeries) => {
  const v = s.points.at(-1)?.[1];
  return v === null || v === undefined || Number.isNaN(v) ? 0 : v;
};

function emptyEdge(source: string, target: string): MapEdge {
  return {
    id: `${source}>${target}:`,
    source,
    target,
    port: null,
    service: null,
    connectionsPerSecond: 0,
    failedPerSecond: 0,
    failedRatio: null,
    latencyMeanSeconds: null,
    latencyP95Seconds: null,
    bytesSentPerSecond: null,
    bytesReceivedPerSecond: null,
    retransmitsPerSecond: 0,
    http: null,
    health: 'unknown',
  };
}

function backendNode(b: TraefikBackend): MapNode | null {
  if (!b.mapNode) return null;
  if (b.mapNode.startsWith('w:')) {
    return {
      id: b.mapNode,
      kind: 'workload',
      name: b.name ?? '',
      namespace: b.namespace,
      workloadKind: b.workloadKind ?? null,
    };
  }
  if (b.mapNode.startsWith('c:')) {
    // The label is "<compose service> (<project>)" for a Compose container.
    const paren = b.label.indexOf(' (');
    return {
      id: b.mapNode,
      kind: 'container',
      name: paren > 0 ? b.label.slice(0, paren) : (b.name ?? ''),
      namespace: b.namespace,
      workloadKind: null,
    };
  }
  if (b.mapNode.startsWith('s:')) {
    return {
      id: b.mapNode,
      kind: 'service',
      name: b.service ?? '',
      namespace: b.namespace,
      workloadKind: null,
    };
  }
  return null;
}

/**
 * Adds Traefik's numbers to a flows graph. `resolve` maps a Traefik service name to its
 * backend (traefik-backends.ts); `namespaces` is the map's selection, if any.
 */
export function addProxies(
  graph: { nodes: MapNode[]; edges: MapEdge[] },
  targets: ProxyTarget[],
  r: ProxyResults,
  resolve: (traefikService: string) => TraefikBackend,
  namespaces?: string[],
): { nodes: MapNode[]; edges: MapEdge[]; proxies: ProxySummary[] } {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = graph.edges.map((e) => ({ ...e }));
  const inSelection = (n: MapNode | undefined) =>
    !namespaces?.length || (n?.namespace !== null && namespaces.includes(n?.namespace ?? ''));
  const proxies: ProxySummary[] = [];
  const resolved = new Map<string, TraefikBackend>();
  const backendOf = (name: string) => {
    let b = resolved.get(name);
    if (!b) resolved.set(name, (b = resolve(name)));
    return b;
  };

  for (const t of targets) {
    const id = t.integrationId;
    const mine = (list: QuerySeries[]) => list.filter((s) => s.labels.service === id);
    const proxy = t.node.id;

    // Entrypoints, and the 503s Traefik answered itself.
    const eps = new Map<string, ProxyEntrypoint>();
    let ep503 = 0;
    for (const s of mine(r.entrypointByCode)) {
      const name = s.labels.entrypoint ?? '';
      if (!name || OWN_ENTRYPOINTS.has(name)) continue;
      const e = eps.get(name) ?? {
        name,
        requestsPerSecond: 0,
        serverErrorsPerSecond: 0,
        tlsRequestsPerSecond: 0,
      };
      const v = value(s);
      e.requestsPerSecond += v;
      if ((s.labels.code ?? '').startsWith('5')) e.serverErrorsPerSecond += v;
      if (s.labels.code === '503') ep503 += v;
      eps.set(name, e);
    }
    for (const s of mine(r.entrypointTls)) {
      const name = s.labels.entrypoint ?? '';
      const e = eps.get(name);
      if (e) e.tlsRequestsPerSecond += value(s);
    }

    // Per backend: Traefik's requests by class, and its quantiles.
    interface Acc {
      total: number;
      c4: number;
      c5: number;
      p50: number | null;
      p95: number | null;
      p99: number | null;
    }
    const perBackend = new Map<string, Acc>();
    let svc503 = 0;
    for (const s of mine(r.serviceByCode)) {
      const name = s.labels.traefik_service ?? '';
      if (!name || isInternal(name)) continue;
      const v = value(s);
      const code = s.labels.code ?? '';
      if (code === '503') svc503 += v;
      const b = backendOf(name);
      if (!b.mapNode) continue;
      const a = perBackend.get(b.mapNode) ?? {
        total: 0,
        c4: 0,
        c5: 0,
        p50: null,
        p95: null,
        p99: null,
      };
      a.total += v;
      if (code.startsWith('4')) a.c4 += v;
      if (code.startsWith('5')) a.c5 += v;
      perBackend.set(b.mapNode, a);
    }
    // Quantiles: the slowest of a backend's Traefik services (one per backend in practice).
    for (const [list, key] of [
      [r.p50, 'p50'],
      [r.p95, 'p95'],
      [r.p99, 'p99'],
    ] as const) {
      for (const s of mine(list)) {
        const b = backendOf(s.labels.traefik_service ?? '');
        const a = b.mapNode ? perBackend.get(b.mapNode) : undefined;
        const v = s.points.at(-1)?.[1];
        if (!a || v === null || v === undefined || Number.isNaN(v)) continue;
        a[key] = Math.max(a[key] ?? 0, v);
      }
    }

    const edgeTo = (target: string) =>
      edges.filter((e) => e.source === proxy && e.target === target);
    const ensureEdge = (b: TraefikBackend): MapEdge | null => {
      const existing = edgeTo(b.mapNode!);
      if (existing.length) return existing.find((e) => !e.http) ?? existing[0]!;
      const bn = nodes.get(b.mapNode!) ?? backendNode(b);
      if (!bn || !(inSelection(t.node) || inSelection(bn))) return null;
      nodes.set(t.node.id, nodes.get(t.node.id) ?? t.node);
      nodes.set(bn.id, bn);
      const e = emptyEdge(proxy, bn.id);
      edges.push(e);
      return e;
    };

    for (const [target, a] of perBackend) {
      if (a.total <= 0) continue;
      // eBPF read this edge: it stays the source, nothing is added.
      if (edgeTo(target).some((e) => e.http)) {
        for (const e of edgeTo(target)) if (e.http) e.httpSource = 'ebpf';
        continue;
      }
      const b = [...resolved.values()].find((x) => x.mapNode === target);
      const e = b ? ensureEdge(b) : null;
      if (!e) continue;
      const http: EdgeHttp = {
        requestsPerSecond: a.total,
        clientErrorsPerSecond: a.c4,
        serverErrorsPerSecond: a.c5,
        serverErrorRatio: a.total > 0 ? a.c5 / a.total : null,
        p50Seconds: a.p50,
        p95Seconds: a.p95,
        p99Seconds: a.p99,
      };
      e.http = http;
      e.httpSource = 'traefik';
      e.health = health(e);
    }

    // Answered by Traefik: on the backends with no server up.
    const answered = Math.max(0, ep503 - svc503);
    const ups = new Map<string, number>();
    for (const s of mine(r.serverUp)) ups.set(s.labels.traefik_service ?? '', value(s));
    const candidates = new Set<string>([
      ...mine(r.seen).map((s) => s.labels.traefik_service ?? ''),
      ...ups.keys(),
    ]);
    const downs = new Map<string, TraefikBackend>();
    for (const name of candidates) {
      if (!name || isInternal(name)) continue;
      const b = backendOf(name);
      if (b.mapNode && down(b, ups.get(name))) downs.set(b.mapNode, b);
    }
    if (answered > 0) {
      for (const b of downs.values()) {
        const e = ensureEdge(b);
        if (!e) continue;
        e.answeredByProxy = {
          perSecond: answered,
          reason: 'no_server_up',
          proxy,
          shared: downs.size > 1,
        };
        e.health = 'critical';
      }
    }

    proxies.push({
      node: proxy,
      integrationId: id,
      entrypoints: [...eps.values()].sort((a, b) => a.name.localeCompare(b.name)),
      answeredPerSecond: answered,
    });
  }
  edges.sort((a, b) => a.id.localeCompare(b.id));
  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges,
    proxies,
  };
}
