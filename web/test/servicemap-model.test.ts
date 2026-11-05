// SPDX-License-Identifier: AGPL-3.0-only
// Service map filters, search, table grouping and words (ADR-109).
import type { ServiceMapEdge, ServiceMapNode } from '@watchlog/api-types';
import { describe, expect, it } from 'vitest';
import { edgeReason } from '@/lib/servicemap';
import {
  DEFAULT_FILTERS,
  databases,
  edgeMatches,
  idLabel,
  liveliness,
  namespaceCounts,
  search,
  summary,
  tableRows,
  visibleEdges,
  visibleNodes,
} from '@/lib/servicemap-model';

const W = (ns: string, name: string, kind = 'Deployment', watchlog = false): ServiceMapNode => ({
  id: `w:${ns}/${kind}/${name}`,
  kind: 'workload',
  name,
  namespace: ns,
  workloadKind: kind,
  watchlog,
});
const X = (name: string): ServiceMapNode => ({
  id: `x:${name}`,
  kind: 'external',
  name,
  namespace: null,
  workloadKind: null,
  watchlog: false,
});
const nodes: ServiceMapNode[] = [
  W('shop', 'frontend'),
  W('shop', 'cart'),
  W('shop', 'catalog'),
  W('data', 'postgres', 'StatefulSet'),
  W('traffic', 'loadgen'),
  X('api.stripe.com:443'),
  W('watchlog', 'watchlog-agent', 'DaemonSet', true),
  W('watchlog', 'watchlog-backend', 'Deployment', true),
  {
    id: 'n:worker',
    kind: 'node',
    name: 'worker',
    namespace: null,
    workloadKind: null,
    watchlog: false,
  },
];
const id = (name: string) => nodes.find((n) => n.name === name)!.id;
let seq = 0;
const E = (s: string, t: string, over: Partial<ServiceMapEdge> = {}): ServiceMapEdge => ({
  id: `e${seq++}`,
  source: id(s),
  target: id(t),
  port: 8080,
  service: null,
  connectionsPerSecond: 2,
  failedPerSecond: 0,
  failedRatio: 0,
  latencyMeanSeconds: 0.002,
  latencyP95Seconds: 0.004,
  bytesSentPerSecond: 900,
  bytesReceivedPerSecond: 1200,
  retransmitsPerSecond: 0,
  health: 'ok',
  ...over,
});
const edges = [
  E('loadgen', 'frontend', { connectionsPerSecond: 5 }),
  E('frontend', 'cart'),
  E('cart', 'catalog', { health: 'critical', failedRatio: 0.375, failedPerSecond: 0.75 }),
  E('catalog', 'postgres', { port: 5432, health: 'warning', latencyP95Seconds: 1.3 }),
  E('cart', 'api.stripe.com:443', { port: 443 }),
  E('frontend', 'catalog', { health: 'idle', connectionsPerSecond: 0, failedRatio: null }),
  E('watchlog-agent', 'watchlog-backend', { port: 4080 }),
  E('watchlog-agent', 'worker', { port: 10250 }),
];
const map = { nodes, edges };
const names = (list: ServiceMapEdge[]) =>
  list.map((e) => `${e.source.split('/').pop()}>${e.target.split('/').pop()}`).sort();

describe('service map filters', () => {
  it('hide WatchLog, node-level destinations and idle connections by default', () => {
    const shown = visibleEdges(map, DEFAULT_FILTERS);
    expect(names(shown)).toEqual([
      'cart>catalog',
      'cart>x:api.stripe.com:443',
      'catalog>postgres',
      'frontend>cart',
      'loadgen>frontend',
    ]);
    expect(visibleNodes(map, shown).map((n) => n.name)).not.toContain('watchlog-agent');
    const all = visibleEdges(map, { ...DEFAULT_FILTERS, watchlog: true, hideIdle: false });
    expect(all).toHaveLength(edges.length);
  });

  it('show only problems, hide externals, and match a namespace at either end', () => {
    expect(names(visibleEdges(map, { ...DEFAULT_FILTERS, onlyProblems: true }))).toEqual([
      'cart>catalog',
      'catalog>postgres',
    ]);
    expect(names(visibleEdges(map, { ...DEFAULT_FILTERS, externals: false }))).not.toContain(
      'cart>x:api.stripe.com:443',
    );
    // data has postgres only: the edge into it is shown because its target is in data.
    expect(names(visibleEdges(map, { ...DEFAULT_FILTERS, namespaces: ['data'] }))).toEqual([
      'catalog>postgres',
    ]);
  });

  it('count services per namespace, leaving out WatchLog unless shown', () => {
    expect(namespaceCounts(map, DEFAULT_FILTERS)).toEqual([
      { name: 'data', count: 1, watchlog: false },
      { name: 'shop', count: 3, watchlog: false },
      { name: 'traffic', count: 1, watchlog: false },
    ]);
    expect(namespaceCounts(map, { watchlog: true }).find((n) => n.name === 'watchlog')).toEqual({
      name: 'watchlog',
      count: 2,
      watchlog: true,
    });
  });
});

describe('service map search', () => {
  it('finds services, databases and externals, exact and prefix matches first', () => {
    expect(search(map, 'cat').map((r) => [r.node.name, r.kind])).toEqual([['catalog', 'service']]);
    expect(search(map, 'post')[0]).toMatchObject({ kind: 'database' });
    expect(search(map, 'stripe')[0]).toMatchObject({ kind: 'external' });
    expect(search(map, 'shop').map((r) => r.node.name)).toEqual(['cart', 'catalog', 'frontend']);
    expect(search(map, '  ')).toEqual([]);
    expect(databases(map).has(id('postgres'))).toBe(true);
  });

  it('filters connections by either end', () => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(names(edges.filter((e) => edgeMatches(e, byId, 'catalog')))).toEqual([
      'cart>catalog',
      'catalog>postgres',
      'frontend>catalog',
    ]);
  });
});

describe('Connections table', () => {
  const title = (i: string) => i.split('/').pop()!;
  it('groups Needs attention, Healthy and Idle; worst and busiest first', () => {
    const rows = tableRows(visibleEdges(map, { ...DEFAULT_FILTERS, hideIdle: false }), title, null);
    expect(
      rows.map((r) => (r.type === 'group' ? `[${r.group} ${r.count}]` : title(r.edge.target))),
    ).toEqual([
      '[attention 2]',
      'Deployment/catalog'.split('/').pop(),
      'postgres',
      '[healthy 3]',
      'frontend',
      'cart',
      'x:api.stripe.com:443',
      '[idle 1]',
      'catalog',
    ]);
  });

  it('sorts within each group by the chosen column', () => {
    const rows = tableRows(visibleEdges(map, DEFAULT_FILTERS), title, { key: 'p95', desc: true });
    const attention = rows.slice(1, 3).map((r) => (r.type === 'edge' ? title(r.edge.target) : ''));
    expect(attention).toEqual(['postgres', 'catalog']);
    const byName = tableRows(visibleEdges(map, DEFAULT_FILTERS), title, {
      key: 'name',
      desc: false,
    });
    const healthy = byName.filter((r) => r.type === 'edge' && r.edge.health === 'ok');
    expect(healthy.map((r) => (r.type === 'edge' ? title(r.edge.source) : ''))).toEqual([
      'cart',
      'frontend',
      'loadgen',
    ]);
  });
});

describe('service map words and drawing', () => {
  it('turns raw ids into names (DNS rows)', () => {
    expect(idLabel('w:kube-system/Deployment/coredns')).toBe('coredns · kube-system');
    expect(idLabel('s:shop/cart')).toBe('cart · shop');
    expect(idLabel('c:demo-web-1')).toBe('demo-web-1');
  });

  it('sums the traffic now and lists what needs attention', () => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const s = summary(visibleEdges(map, DEFAULT_FILTERS), byId);
    expect(s.connectionsPerSecond).toBe(13);
    expect(s.failedRatio).toBeCloseTo(0.75 / 13, 4);
    expect(s.externals).toBe(1);
    expect(s.attention.map((e) => e.health)).toEqual(['critical', 'warning']);
  });

  it('draws busier edges with more particles and idle ones with none; keep-alive edges move', () => {
    expect(
      liveliness(E('frontend', 'cart', { health: 'idle', connectionsPerSecond: 0 })).particles,
    ).toBe(0);
    const slow = liveliness(E('frontend', 'cart', { connectionsPerSecond: 0.2 }));
    const busy = liveliness(E('frontend', 'cart', { connectionsPerSecond: 40 }));
    expect(busy.particles).toBeGreaterThan(slow.particles);
    expect(busy.width).toBeGreaterThan(slow.width);
    expect(busy.particles).toBeLessThanOrEqual(5);
    // Adopted keep-alive connection: no new connects, bytes flowing (ADR-108).
    expect(
      liveliness(E('frontend', 'cart', { connectionsPerSecond: 0, bytesSentPerSecond: 60_000 }))
        .particles,
    ).toBeGreaterThan(0);
  });

  it('explains a failing edge with the target state, in plain words', () => {
    const t = (k: string, v?: Record<string, unknown>) => `${k} ${JSON.stringify(v ?? {})}`;
    const e = edges[2]!;
    const r = edgeReason(
      e,
      'catalog',
      { target: { ready: 0, desired: 1, changedAt: '2026-11-01T19:21:00Z' }, alert: null },
      t,
      () => '19:21',
    );
    expect(r?.lead).toContain('serviceMap.reason.failed.critical');
    expect(r?.lead).toContain('38%');
    expect(r?.detail).toBe('serviceMap.reason.noneReady {"name":"catalog","time":"19:21"}');
    expect(edgeReason(edges[3]!, 'postgres', null, t, () => '')?.lead).toContain(
      'serviceMap.reason.slow',
    );
    expect(edgeReason(edges[1]!, 'cart', null, t, () => '')).toBeNull();
  });
});
