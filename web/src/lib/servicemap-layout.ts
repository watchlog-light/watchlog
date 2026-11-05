// SPDX-License-Identifier: AGPL-3.0-only
// Stable positions for the service map (ADR-109):
// computed once per topology, kept per cluster in this browser, reused on every
// refresh. New nodes are placed without moving existing ones; a dragged node is pinned
// until "Reset layout".

export interface Pos {
  x: number;
  y: number;
  /** Placed by the user (dragged). */
  pinned?: boolean;
}
export type Layout = Record<string, Pos>;

export interface LayoutNode {
  id: string;
  /** Namespace band, "external" (right column) or "nodes" (below it). */
  group: string;
}
export interface LayoutEdge {
  source: string;
  target: string;
}

export const COL = 200;
export const ROW = 96;
const BAND_GAP = 70;
const ORIGIN = { x: 100, y: 80 };
/** Closer than this, a new node is moved to the next free spot. */
export const MIN_DIST = 80;

/**
 * Columns by call depth: the longest path from a node that nobody calls, ignoring the
 * edges that close a cycle (found by a depth-first search from those nodes, in id
 * order, so the result is the same for the same topology).
 */
function ranks(nodes: LayoutNode[], edges: LayoutEdge[]): Map<string, number> {
  const ids = nodes.map((n) => n.id).sort();
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  for (const e of edges) {
    if (e.source !== e.target && out.has(e.source) && out.has(e.target))
      out.get(e.source)!.push(e.target);
  }
  for (const list of out.values()) list.sort();
  const state = new Map<string, 1 | 2>();
  const order: string[] = [];
  const forward = new Map<string, string[]>();
  const visit = (id: string) => {
    state.set(id, 1);
    const keep: string[] = [];
    for (const t of out.get(id)!) {
      if (state.get(t) === 1) continue; // closes a cycle
      keep.push(t);
      if (!state.has(t)) visit(t);
    }
    forward.set(id, keep);
    state.set(id, 2);
    order.push(id);
  };
  // Start from nodes nobody calls, so a cycle is broken at the edge pointing back up.
  const called = new Set([...out.values()].flat());
  for (const id of [...ids.filter((id) => !called.has(id)), ...ids]) if (!state.has(id)) visit(id);
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const id of order.reverse()) {
    for (const t of forward.get(id)!) rank.set(t, Math.max(rank.get(t)!, rank.get(id)! + 1));
  }
  return rank;
}

/**
 * The full layout: one horizontal band per namespace (ordered by where its services
 * sit in the call chain), columns by call depth, externals in a column on the right
 * and node-level destinations below them.
 */
export function computeLayout(nodes: LayoutNode[], edges: LayoutEdge[]): Layout {
  const rank = ranks(nodes, edges);
  const inner = nodes.filter((n) => n.group !== 'external' && n.group !== 'nodes');
  const maxRank = Math.max(0, ...inner.map((n) => rank.get(n.id)!));
  const bands = new Map<string, LayoutNode[]>();
  for (const n of inner) bands.set(n.group, [...(bands.get(n.group) ?? []), n]);
  const bandOrder = [...bands.entries()]
    .map(([g, list]) => ({ g, list, at: Math.min(...list.map((n) => rank.get(n.id)!)) }))
    .sort((a, b) => a.at - b.at || b.list.length - a.list.length || a.g.localeCompare(b.g));

  const preds = new Map<string, string[]>();
  for (const e of edges) preds.set(e.target, [...(preds.get(e.target) ?? []), e.source]);
  const layout: Layout = {};
  const barycenter = (id: string) => {
    const ys = (preds.get(id) ?? [])
      .map((p) => layout[p]?.y)
      .filter((y): y is number => y !== undefined);
    return ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : Number.POSITIVE_INFINITY;
  };

  let top = ORIGIN.y;
  for (const { list } of bandOrder) {
    const columns = new Map<number, LayoutNode[]>();
    for (const n of list) {
      const r = rank.get(n.id)!;
      columns.set(r, [...(columns.get(r) ?? []), n]);
    }
    let rows = 1;
    for (const r of [...columns.keys()].sort((a, b) => a - b)) {
      const col = columns
        .get(r)!
        .sort((a, b) => barycenter(a.id) - barycenter(b.id) || a.id.localeCompare(b.id));
      col.forEach((n, i) => (layout[n.id] = { x: ORIGIN.x + r * COL, y: top + i * ROW }));
      rows = Math.max(rows, col.length);
    }
    top += rows * ROW + BAND_GAP;
  }

  const side = ORIGIN.x + (maxRank + 1) * COL + 40;
  let y = ORIGIN.y;
  for (const g of ['external', 'nodes']) {
    const list = nodes
      .filter((n) => n.group === g)
      .sort((a, b) => barycenter(a.id) - barycenter(b.id) || a.id.localeCompare(b.id));
    list.forEach((n) => {
      layout[n.id] = { x: side, y };
      y += ROW * 0.8;
    });
    if (list.length) y += BAND_GAP;
  }
  return layout;
}

const free = (p: Pos, taken: Pos[]) =>
  taken.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= MIN_DIST);

/**
 * Positions for this topology: existing ones are kept as they are; new nodes take
 * their spot in a fresh layout, shifted with their namespace's existing nodes, then
 * moved to the nearest free spot if another node is there.
 */
export function placeNodes(
  existing: Layout,
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): { layout: Layout; added: string[] } {
  const missing = nodes.filter((n) => !existing[n.id]);
  if (!missing.length) return { layout: existing, added: [] };
  const fresh = computeLayout(nodes, edges);
  const layout: Layout = { ...existing };
  const taken = nodes.filter((n) => existing[n.id]).map((n) => existing[n.id]!);
  for (const n of missing.sort((a, b) => a.id.localeCompare(b.id))) {
    const peers = nodes.filter((m) => m.group === n.group && existing[m.id]);
    const dx = peers.length
      ? peers.reduce((s, m) => s + existing[m.id]!.x - fresh[m.id]!.x, 0) / peers.length
      : 0;
    const dy = peers.length
      ? peers.reduce((s, m) => s + existing[m.id]!.y - fresh[m.id]!.y, 0) / peers.length
      : 0;
    const want = { x: fresh[n.id]!.x + dx, y: fresh[n.id]!.y + dy };
    let spot = want;
    // Spiral outwards on a grid until nothing is closer than MIN_DIST.
    for (let i = 1; !free(spot, taken) && i < 400; i++) {
      const ring = Math.ceil(Math.sqrt(i));
      const a = i * 2.39996; // golden angle
      spot = {
        x: want.x + Math.cos(a) * ring * MIN_DIST,
        y: want.y + Math.sin(a) * ring * MIN_DIST * 0.8,
      };
    }
    layout[n.id] = { x: Math.round(spot.x), y: Math.round(spot.y) };
    taken.push(layout[n.id]!);
  }
  return { layout, added: missing.map((n) => n.id) };
}

const MAX_SAVED = 3000;

/** Positions per cluster in this browser; reading or writing may fail and never throws. */
export function layoutStore(clusterId: string, storage: Storage | undefined = safeStorage()) {
  const key = `watchlog.serviceMap.layout.v1.${clusterId}`;
  return {
    load(): Layout {
      try {
        const raw = storage?.getItem(key);
        const parsed = raw ? (JSON.parse(raw) as { positions?: Layout }) : null;
        return parsed?.positions && typeof parsed.positions === 'object' ? parsed.positions : {};
      } catch {
        return {};
      }
    },
    save(layout: Layout, keep?: Set<string>) {
      let entries = Object.entries(layout);
      // Too many remembered nodes: forget unpinned ones that are not on the map now.
      if (entries.length > MAX_SAVED && keep)
        entries = entries.filter(([id, p]) => p.pinned || keep.has(id)).slice(0, MAX_SAVED);
      try {
        storage?.setItem(key, JSON.stringify({ positions: Object.fromEntries(entries) }));
      } catch {
        // Private mode or full storage: positions last for this visit only.
      }
    },
    clear() {
      try {
        storage?.removeItem(key);
      } catch {
        // as above
      }
    },
  };
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
