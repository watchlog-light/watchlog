// SPDX-License-Identifier: AGPL-3.0-only
// What the service map shows (SPEC §4.5, ADR-109): node
// groups, filters, search, the Connections table's groups and order, problem counts and
// the traffic summary. Pure functions over the API's map, shared by every view.
import type { ServiceMap, ServiceMapEdge, ServiceMapNode } from '@watchlog/api-types';

export type Edge = ServiceMapEdge;
export type Node = ServiceMapNode;

/** A namespace (or Compose project), all external services, or node-level destinations. */
export interface Group {
  key: string;
  kind: 'namespace' | 'external' | 'nodes';
  label: string;
}

export function groupOf(n: Node): Group {
  if (n.kind === 'external' || n.kind === 'internet')
    return { key: 'external', kind: 'external', label: 'external' };
  if (n.kind === 'node') return { key: 'nodes', kind: 'nodes', label: 'nodes' };
  // Docker: Compose projects are the groups; containers without one are standalone.
  const ns = n.namespace ?? (n.kind === 'container' ? 'standalone' : 'default');
  return { key: `ns:${ns}`, kind: 'namespace', label: ns };
}

export const isExternal = (n: Node) => n.kind === 'external' || n.kind === 'internet';
export const isProblem = (e: Edge) => e.health === 'critical' || e.health === 'warning';

/** Ports of common databases and brokers: the node is drawn as a database. */
const DATA_PORTS = new Set([
  5432, 3306, 6379, 27017, 9042, 5672, 9092, 11211, 9200, 2379, 26257, 8428, 1433, 1521,
]);

export function databases(m: Pick<ServiceMap, 'nodes' | 'edges'>): Set<string> {
  const out = new Set<string>();
  for (const n of m.nodes) if (n.workloadKind === 'StatefulSet') out.add(n.id);
  for (const e of m.edges) if (e.port !== null && DATA_PORTS.has(e.port)) out.add(e.target);
  return out;
}

export interface Filters {
  /** Selected namespaces; empty shows all. */
  namespaces: string[];
  onlyProblems: boolean;
  hideIdle: boolean;
  externals: boolean;
  /** WatchLog's own components and node-level destinations (kubelet, node IPs). */
  watchlog: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  namespaces: [],
  onlyProblems: false,
  hideIdle: true,
  externals: true,
  watchlog: false,
};

/** Hidden with "Show WatchLog components" off: WatchLog itself and kubelet/node traffic. */
export const isInfrastructure = (n: Node | undefined) => !!n && (n.watchlog || n.kind === 'node');

/** Filters that are about which parts of the cluster, not about health. */
function inScope(e: Edge, byId: Map<string, Node>, f: Filters): boolean {
  const s = byId.get(e.source);
  const t = byId.get(e.target);
  if (!f.watchlog && (isInfrastructure(s) || isInfrastructure(t))) return false;
  if (!f.externals && t && isExternal(t)) return false;
  if (f.namespaces.length) {
    // An edge is shown when either end is in a selected namespace (ADR-106).
    const ns = new Set(f.namespaces);
    if (!(s?.namespace && ns.has(s.namespace)) && !(t?.namespace && ns.has(t.namespace)))
      return false;
  }
  return true;
}

/** Edges in scope (namespaces, WatchLog, externals), before the health filters. */
export function scopedEdges(m: Pick<ServiceMap, 'nodes' | 'edges'>, f: Filters): Edge[] {
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  return m.edges.filter((e) => inScope(e, byId, f));
}

export function visibleEdges(m: Pick<ServiceMap, 'nodes' | 'edges'>, f: Filters): Edge[] {
  return scopedEdges(m, f).filter(
    (e) => !(f.hideIdle && e.health === 'idle') && !(f.onlyProblems && !isProblem(e)),
  );
}

/** Nodes with at least one visible edge: the map never shows orphans. */
export function visibleNodes(m: Pick<ServiceMap, 'nodes' | 'edges'>, edges: Edge[]): Node[] {
  const ids = new Set(edges.flatMap((e) => [e.source, e.target]));
  return m.nodes.filter((n) => ids.has(n.id));
}

/** Namespaces with their number of services, for the filter list. */
export function namespaceCounts(
  m: Pick<ServiceMap, 'nodes'>,
  f: Pick<Filters, 'watchlog'>,
): { name: string; count: number; watchlog: boolean }[] {
  const out = new Map<string, { count: number; own: number }>();
  for (const n of m.nodes) {
    if (!n.namespace || isExternal(n) || n.kind === 'node') continue;
    const c = out.get(n.namespace) ?? { count: 0, own: 0 };
    c.count++;
    if (n.watchlog) c.own++;
    out.set(n.namespace, c);
  }
  return [...out.entries()]
    .map(([name, c]) => ({
      name,
      count: f.watchlog ? c.count : c.count - c.own,
      watchlog: c.own === c.count,
    }))
    .filter((r) => r.count > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** "cart" (title), "Deployment · shop" (subtitle); externals by name and port. */
export function nodeLabel(n: Node): { title: string; sub: string } {
  if (isExternal(n)) return { title: n.name, sub: '' };
  return { title: n.name, sub: [n.workloadKind, n.namespace].filter(Boolean).join(' · ') };
}

/**
 * A node id as words, for ids without a node (DNS rows): "w:kube-system/Deployment/
 * coredns" → "coredns · kube-system"; "c:web-1" → "web-1".
 */
export function idLabel(id: string): string {
  if (id.startsWith('w:')) {
    const [ns, , ...name] = id.slice(2).split('/');
    return `${name.join('/')} · ${ns}`;
  }
  if (id.startsWith('s:')) {
    const [ns, ...name] = id.slice(2).split('/');
    return `${name.join('/')} · ${ns}`;
  }
  return id.replace(/^[a-z]:/, '');
}

export interface SearchResult {
  node: Node;
  kind: 'service' | 'database' | 'external' | 'node';
}

/** Services, databases and externals matching a query: names first, then namespaces. */
export function search(
  m: Pick<ServiceMap, 'nodes' | 'edges'>,
  query: string,
  limit = 8,
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const db = databases(m);
  const scored: { r: SearchResult; score: number }[] = [];
  for (const n of m.nodes) {
    const name = n.name.toLowerCase();
    const ns = (n.namespace ?? '').toLowerCase();
    const score =
      name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : ns.includes(q) ? 3 : -1;
    if (score < 0) continue;
    const kind = isExternal(n)
      ? 'external'
      : n.kind === 'node'
        ? 'node'
        : db.has(n.id)
          ? 'database'
          : 'service';
    scored.push({ r: { node: n, kind }, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.r.node.name.localeCompare(b.r.node.name))
    .slice(0, limit)
    .map((s) => s.r);
}

/** Whether an edge matches the search box (either end's name or namespace). */
export function edgeMatches(e: Edge, byId: Map<string, Node>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [byId.get(e.source), byId.get(e.target)].some(
    (n) =>
      !!n && (n.name.toLowerCase().includes(q) || (n.namespace ?? '').toLowerCase().includes(q)),
  );
}

export type ConnGroup = 'attention' | 'healthy' | 'idle';
export type SortKey = 'name' | 'health' | 'rate' | 'failed' | 'p95' | 'throughput';

export const throughput = (e: Edge) =>
  (e.bytesSentPerSecond ?? 0) + (e.bytesReceivedPerSecond ?? 0);

export function connGroup(e: Edge): ConnGroup {
  if (isProblem(e)) return 'attention';
  return e.health === 'ok' ? 'healthy' : 'idle';
}

const HEALTH_RANK: Record<string, number> = { critical: 0, warning: 1, ok: 2, idle: 3, unknown: 4 };

function compare(a: Edge, b: Edge, key: SortKey, title: (id: string) => string): number {
  switch (key) {
    case 'name':
      return `${title(a.source)}${title(a.target)}`.localeCompare(
        `${title(b.source)}${title(b.target)}`,
      );
    case 'health':
      return (HEALTH_RANK[a.health] ?? 5) - (HEALTH_RANK[b.health] ?? 5);
    case 'rate':
      return a.connectionsPerSecond - b.connectionsPerSecond;
    case 'failed':
      return (a.failedRatio ?? -1) - (b.failedRatio ?? -1);
    case 'p95':
      return (a.latencyP95Seconds ?? -1) - (b.latencyP95Seconds ?? -1);
    case 'throughput':
      return throughput(a) - throughput(b);
  }
}

export type TableRow =
  { type: 'group'; group: ConnGroup; count: number } | { type: 'edge'; edge: Edge };

/**
 * The Connections table as flat rows for the virtual list: Needs attention, Healthy,
 * Idle, each sorted by the chosen column (worst and busiest first by default).
 */
export function tableRows(
  edges: Edge[],
  title: (id: string) => string,
  sort: { key: SortKey; desc: boolean } | null,
): TableRow[] {
  const rows: TableRow[] = [];
  for (const g of ['attention', 'healthy', 'idle'] as ConnGroup[]) {
    const list = edges.filter((e) => connGroup(e) === g);
    if (!list.length) continue;
    list.sort((a, b) => {
      if (!sort) return compare(a, b, 'health', title) || compare(b, a, 'rate', title);
      const c = compare(a, b, sort.key, title);
      return (sort.desc ? -c : c) || compare(a, b, 'name', title);
    });
    rows.push(
      { type: 'group', group: g, count: list.length },
      ...list.map((edge) => ({ type: 'edge' as const, edge })),
    );
  }
  return rows;
}

/** DNS rows that count as a problem: at least 1 % of lookups failed. */
export const DNS_PROBLEM = 0.01;

export interface Summary {
  connectionsPerSecond: number;
  failedRatio: number | null;
  active: number;
  externals: number;
  attention: Edge[];
  busiest: Edge[];
}

export function summary(edges: Edge[], byId: Map<string, Node>): Summary {
  const rate = edges.reduce((s, e) => s + e.connectionsPerSecond, 0);
  const failed = edges.reduce((s, e) => s + e.failedPerSecond, 0);
  return {
    connectionsPerSecond: rate,
    failedRatio: rate > 0 ? Math.min(1, failed / rate) : null,
    active: edges.filter((e) => e.health !== 'idle' && e.health !== 'unknown').length,
    externals: new Set(
      edges
        .map((e) => e.target)
        .filter((t) => {
          const n = byId.get(t);
          return !!n && isExternal(n);
        }),
    ).size,
    attention: edges
      .filter(isProblem)
      .sort(
        (a, b) =>
          (HEALTH_RANK[a.health] ?? 5) - (HEALTH_RANK[b.health] ?? 5) ||
          (b.failedRatio ?? 0) - (a.failedRatio ?? 0),
      ),
    busiest: edges
      .filter((e) => e.health !== 'idle')
      .sort(
        (a, b) => b.connectionsPerSecond - a.connectionsPerSecond || throughput(b) - throughput(a),
      )
      .slice(0, 5),
  };
}

/**
 * How lively an edge is drawn: particle count (0 when idle), line width and speed.
 * Connections per second when the edge opens connections; bytes for keep-alive edges
 * (ADR-108), which open none.
 */
export function liveliness(e: Edge): { particles: number; width: number; speed: number } {
  if (e.health === 'idle' || e.health === 'unknown') return { particles: 0, width: 1.4, speed: 0 };
  const kib = throughput(e) / 1024;
  const rate = e.connectionsPerSecond > 0 ? e.connectionsPerSecond : Math.min(kib / 8, 2);
  const level = Math.log2(1 + rate * 2);
  return {
    particles: Math.max(1, Math.min(5, Math.round(level))),
    width: 1.5 + Math.min(level, 4) * 0.7,
    speed: e.health === 'critical' ? 45 : 50 + Math.min(level, 4) * 10,
  };
}
