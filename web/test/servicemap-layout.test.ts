// SPDX-License-Identifier: AGPL-3.0-only
// Stable service map layout (ADR-109): positions computed once per topology, kept per
// cluster, reused on refresh; new nodes never move existing ones.
import { describe, expect, it } from 'vitest';
import {
  MIN_DIST,
  computeLayout,
  layoutStore,
  placeNodes,
  type Layout,
  type LayoutEdge,
  type LayoutNode,
} from '@/lib/servicemap-layout';

const N = (id: string, group = 'ns:shop'): LayoutNode => ({ id, group });
const E = (source: string, target: string): LayoutEdge => ({ source, target });
const nodes = [
  N('loadgen', 'ns:traffic'),
  N('frontend'),
  N('cart'),
  N('catalog'),
  N('postgres', 'ns:data'),
  N('x:stripe:443', 'external'),
];
const edges = [
  E('loadgen', 'frontend'),
  E('frontend', 'cart'),
  E('cart', 'catalog'),
  E('catalog', 'postgres'),
  E('cart', 'x:stripe:443'),
  E('catalog', 'frontend'),
];

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

const tooClose = (l: Layout) => {
  const ps = Object.entries(l);
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) {
      const [a, p] = ps[i]!;
      const [b, q] = ps[j]!;
      if (Math.hypot(p.x - q.x, p.y - q.y) < MIN_DIST) return `${a} / ${b}`;
    }
  return null;
};

describe('service map layout', () => {
  it('is deterministic, follows the call chain and puts externals on the right', () => {
    const a = computeLayout(nodes, edges);
    expect(computeLayout([...nodes].reverse(), [...edges].reverse())).toEqual(a);
    expect(a.loadgen!.x).toBeLessThan(a.frontend!.x);
    expect(a.frontend!.x).toBeLessThan(a.cart!.x); // the catalog → frontend cycle is ignored
    expect(a.cart!.x).toBeLessThan(a.catalog!.x);
    const inner = Math.max(
      ...['loadgen', 'frontend', 'cart', 'catalog', 'postgres'].map((id) => a[id]!.x),
    );
    expect(a['x:stripe:443']!.x).toBeGreaterThan(inner);
    expect(tooClose(a)).toBeNull();
  });

  it('does not move anything on refresh: same topology, same positions, nothing added', () => {
    const first = placeNodes({}, nodes, edges);
    expect(first.added).toHaveLength(nodes.length);
    const again = placeNodes(first.layout, nodes, edges);
    expect(again.added).toEqual([]);
    expect(again.layout).toBe(first.layout);
  });

  it('places new nodes without moving existing ones, pinned ones included, and without overlap', () => {
    const { layout } = placeNodes({}, nodes, edges);
    // The user dragged cart somewhere else.
    const dragged: Layout = { ...layout, cart: { x: 900, y: 500, pinned: true } };
    const more = [
      ...nodes,
      N('checkout'),
      N('payments'),
      N('redis', 'ns:data'),
      N('x:s3:443', 'external'),
    ];
    const moreEdges = [
      ...edges,
      E('frontend', 'checkout'),
      E('checkout', 'payments'),
      E('cart', 'redis'),
      E('catalog', 'x:s3:443'),
    ];
    const next = placeNodes(dragged, more, moreEdges);
    expect(next.added.sort()).toEqual(['checkout', 'payments', 'redis', 'x:s3:443']);
    for (const [id, p] of Object.entries(dragged)) expect(next.layout[id]).toEqual(p);
    expect(tooClose(next.layout)).toBeNull();
  });

  it('keeps positions per cluster in storage and survives storage failures', () => {
    const storage = new MemoryStorage();
    const s = layoutStore('c1', storage);
    const { layout } = placeNodes({}, nodes, edges);
    s.save({ ...layout, cart: { x: 1, y: 2, pinned: true } });
    expect(layoutStore('c1', storage).load().cart).toEqual({ x: 1, y: 2, pinned: true });
    expect(layoutStore('c2', storage).load()).toEqual({});
    s.clear();
    expect(layoutStore('c1', storage).load()).toEqual({});

    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const b = layoutStore('c1', broken);
    expect(b.load()).toEqual({});
    expect(() => b.save(layout)).not.toThrow();
    storage.setItem('watchlog.serviceMap.layout.v1.c3', '{not json');
    expect(layoutStore('c3', storage).load()).toEqual({});
  });

  it('lays out 200 nodes and 400 edges quickly and without overlap', () => {
    const many: LayoutNode[] = [];
    const links: LayoutEdge[] = [];
    for (let i = 0; i < 200; i++) many.push(N(`s${i}`, `ns:ns${i % 12}`));
    for (let i = 0; i < 400; i++) links.push(E(`s${(i * 7) % 200}`, `s${(i * 13 + 5) % 200}`));
    const t0 = performance.now();
    const { layout } = placeNodes({}, many, links);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(Object.keys(layout)).toHaveLength(200);
    expect(tooClose(layout)).toBeNull();
  });
});
