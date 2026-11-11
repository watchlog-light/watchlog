// SPDX-License-Identifier: AGPL-3.0-only
// The service map page (ADR-109): filters · live graph ·
// detail panel, the Connections, External and DNS views, search, stable positions,
// zoom only with ⌘/Ctrl, and the eBPF status (ADR-107).
import { flushPromises, mount } from '@vue/test-utils';
import type { ServiceMap, ServiceMapEdge, ServiceMapNode } from '@watchlog/api-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import ServiceMapPage from '@/views/ServiceMapPage.vue';
import { mockFetch, USER, type Routes } from './fetch-mock';
import { createPlugins } from './helpers';

const CLUSTER = {
  id: '01a191b8-ae9d-7373-a09d-8df29bc1a803',
  name: 'kind-demo',
  kind: 'kubernetes',
  status: 'active',
  nodeCount: 3,
  agentVersion: 'dev',
  firstSeenAt: null,
  lastSeenAt: null,
  createdAt: '2026-11-01T12:00:00.000Z',
  ingestFailure: null,
};
const W = (ns: string, name: string, kind = 'Deployment', watchlog = false): ServiceMapNode => ({
  id: `w:${ns}/${kind}/${name}`,
  kind: 'workload',
  name,
  namespace: ns,
  workloadKind: kind,
  watchlog,
});
const edge = (
  source: string,
  target: string,
  over: Partial<ServiceMapEdge> = {},
): ServiceMapEdge => ({
  id: `${source}>${target}`,
  source,
  target,
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
  http: null,
  health: 'ok',
  ...over,
});
const fe = W('shop', 'frontend');
const cart = W('shop', 'cart');
const catalog = W('shop', 'catalog');
const pg = W('data', 'postgres', 'StatefulSet');
const agent = W('watchlog', 'watchlog-agent', 'DaemonSet', true);
const backend = W('watchlog', 'watchlog-backend', 'Deployment', true);
const stripe: ServiceMapNode = {
  id: 'x:api.stripe.com:443',
  kind: 'external',
  name: 'api.stripe.com:443',
  namespace: null,
  workloadKind: null,
  watchlog: false,
};
const failing = edge(cart.id, catalog.id, {
  health: 'critical',
  failedRatio: 0.375,
  failedPerSecond: 0.75,
  service: 'catalog',
});
const MAP: ServiceMap = {
  mode: 'flows',
  agents: [{ node: 'w1', ebpf: 'enabled', reason: null, cause: null, fix: null }],
  nodes: [fe, cart, catalog, pg, agent, backend, stripe],
  edges: [
    edge(fe.id, cart.id, { connectionsPerSecond: 5 }),
    failing,
    edge(catalog.id, pg.id, { port: 5432, health: 'warning', latencyP95Seconds: 1.3 }),
    edge(cart.id, stripe.id, { port: 443 }),
    edge(fe.id, catalog.id, { health: 'idle', connectionsPerSecond: 0, failedRatio: null }),
    edge(agent.id, backend.id, { port: 4080 }),
  ],
  dns: [
    {
      node: 'w:kube-system/Deployment/coredns',
      requestsPerSecond: 10,
      nxdomainPerSecond: 1.5,
      servfailPerSecond: 0,
      timeoutPerSecond: 0.5,
      searchMissPerSecond: 4,
      errorRatio: 0.2,
    },
  ],
};
const SERIES = {
  step: 15,
  connections: [[1793440000, 0.02]],
  failed: [[1793440000, 0.01]],
  latencyP95: [[1793440000, 0.004]],
  bytesSent: [],
  bytesReceived: [],
  context: {
    target: { ready: 0, desired: 1, changedAt: '2026-11-01T19:21:00.000Z' },
    alert: { id: 'a1', since: '2026-11-01T19:22:00.000Z' },
  },
};
const MAP_URL = `GET /api/v1/clusters/${CLUSTER.id}/service-map?range=3600`;
const routes = (map: ServiceMap): Routes => ({
  'GET /api/v1/clusters': { status: 200, body: { clusters: [CLUSTER] } },
  [MAP_URL]: { status: 200, body: map },
  [`GET /api/v1/clusters/${CLUSTER.id}/service-map/edge?source=${encodeURIComponent(cart.id)}&target=${encodeURIComponent(catalog.id)}&range=3600&port=8080`]:
    { status: 200, body: SERIES },
});

async function mountPage(path = '/service-map') {
  const plugins = await createPlugins(path);
  useAuthStore().user = USER;
  const wrapper = mount(ServiceMapPage, {
    attachTo: document.body,
    global: {
      plugins: [plugins.router, plugins.i18n, plugins.pinia],
      stubs: {
        TimeSeriesChart: {
          props: ['title', 'unit'],
          template: '<div class="chart-stub">{{ title }} ({{ unit }})</div>',
        },
      },
    },
  });
  await flushPromises();
  return { wrapper, router: plugins.router };
}
const nodeIds = (w: ReturnType<typeof mount>) =>
  w.findAll('[data-testid="map-node"]').map((n) => n.attributes('data-node'));

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('service map page', () => {
  it('lays out filters, the live graph and the traffic summary, without WatchLog or idle edges', async () => {
    mockFetch(routes(MAP));
    const { wrapper: w } = await mountPage();
    expect(w.find('[data-testid="map-filters"]').exists()).toBe(true);
    expect(nodeIds(w).sort()).toEqual([cart.id, catalog.id, pg.id, fe.id, stripe.id].sort());
    // Namespaces as labelled boxes, externals grouped.
    const groups = w.findAll('[data-testid="map-group"]').map((g) => g.text());
    expect(groups).toEqual(expect.arrayContaining(['shop · 3', 'data · 1', 'external · 1']));
    // Failing and slow edges say so on the map, not by colour alone.
    expect(w.findAll('[data-testid="map-badge"]').map((b) => b.text())).toEqual([
      '✕ 38% failed',
      '▲ p95 1.30 s',
    ]);
    expect(
      w
        .findAll('[data-testid="map-edge"]')
        .map((e) => e.attributes('data-health'))
        .sort(),
    ).toEqual(['critical', 'ok', 'ok', 'warning']);
    const panel = w.get('[data-testid="map-panel"]').text();
    expect(panel).toContain('Traffic now');
    expect(w.get('[data-testid="panel-attention"]').text()).toContain('cart → catalog');
    expect(w.get('[data-testid="view-connections"]').text()).toContain('2');
    expect(w.get('[data-testid="view-dns"]').text()).toContain('1');
    expect(w.get('[data-testid="live"]').text()).toContain('Live');
    w.unmount();
  });

  it('selects a node (called by / calls) and an edge (reason, alert, charts with rate ticks)', async () => {
    mockFetch(routes(MAP));
    const { wrapper: w, router } = await mountPage();
    await w.get(`[data-node="${cart.id}"]`).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(router.currentRoute.value.query.node).toBe(cart.id);
    // Sections: the first with something in it is open, the other folded.
    expect(w.get('[data-testid="panel-calledBy"]').text()).toContain('frontend');
    expect(w.get('[data-testid="panel-calls"]').text()).toBe('Calls · 2');
    const calls = w.get('[data-testid="panel-calls-toggle"]');
    expect(calls.attributes('aria-expanded')).toBe('false');
    await calls.trigger('click');
    expect(w.get('[data-testid="panel-calls"]').text()).toContain('catalog');
    expect(calls.attributes('aria-expanded')).toBe('true');
    // Hovering keeps the node's neighbours and fades the rest.
    const faded = w.findAll('[data-testid="map-node"].faded').map((n) => n.attributes('data-node'));
    expect(faded).toEqual([pg.id]);

    await w.get(`[data-edge="${failing.id}"] .edge-hit`).trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.edge).toBe(failing.id);
    const reason = w.get('[data-testid="edge-reason"]').text();
    expect(reason).toContain('38% of connections fail.');
    expect(reason).toContain('catalog has 0 ready pods since');
    expect(w.get('[data-testid="edge-alert"]').attributes('href')).toBe('/alerts/a1');
    // Numbers first, then the charts in sections: Connections open, Latency folded.
    const panel = w.get('[data-testid="map-panel"]').html();
    expect(panel.indexOf('edge-numbers')).toBeLessThan(panel.indexOf('section-connections'));
    expect(w.findAll('.chart-stub').map((c) => c.text())).toEqual([
      'Connections and failures per second (per_second)',
    ]);
    await w.get('[data-testid="section-latency-toggle"]').trigger('click');
    expect(w.findAll('.chart-stub').map((c) => c.text())).toEqual([
      'Connections and failures per second (per_second)',
      'Connect latency (p95) (seconds)',
    ]);
    w.unmount();
  });

  it("shows an edge's HTTP: requests, 5xx share and latency, and says when 5xx make it critical", async () => {
    const http = edge(fe.id, cart.id, {
      health: 'critical',
      connectionsPerSecond: 0.1,
      http: {
        requestsPerSecond: 40,
        clientErrorsPerSecond: 1.5,
        serverErrorsPerSecond: 2.4,
        serverErrorRatio: 0.06,
        p50Seconds: 0.012,
        p95Seconds: 0.18,
        p99Seconds: 0.9,
      },
    });
    const map = { ...MAP, edges: [http, ...MAP.edges.slice(1)] };
    mockFetch({
      ...routes(map),
      [`GET /api/v1/clusters/${CLUSTER.id}/service-map/edge?source=${encodeURIComponent(fe.id)}&target=${encodeURIComponent(cart.id)}&range=3600&port=8080`]:
        {
          status: 200,
          body: {
            ...SERIES,
            context: { target: null, alert: null },
            httpRequests: [[1793440000, 40]],
            http4xx: [[1793440000, 1.5]],
            http5xx: [[1793440000, 2.4]],
            httpP50: [[1793440000, 0.012]],
            httpP95: [[1793440000, 0.18]],
          },
        },
    });
    const { wrapper: w } = await mountPage();
    await w.get(`[data-edge="${http.id}"] .edge-hit`).trigger('click');
    await flushPromises();
    expect(w.get('[data-testid="edge-reason"]').text()).toContain(
      '6.0% of HTTP requests answer 5xx.',
    );
    const section = w.get('[data-testid="edge-http"]');
    expect(section.text()).toContain('40/s');
    expect(section.get('[data-testid="edge-http-5xx"]').classes()).toContain('text-critical');
    expect(section.text()).toContain('12 ms · 180 ms · 900 ms');
    // HTTP is the first section, open; Connections and Latency are folded.
    expect(w.findAll('.chart-stub').map((c) => c.text())).toEqual([
      'HTTP requests and errors (per_second)',
      'HTTP latency (seconds)',
    ]);
    await w.get('[data-testid="section-connections-toggle"]').trigger('click');
    await w.get('[data-testid="section-latency-toggle"]').trigger('click');
    expect(w.findAll('.chart-stub').map((c) => c.text())).toEqual([
      'HTTP requests and errors (per_second)',
      'HTTP latency (seconds)',
      'Connections and failures per second (per_second)',
      'Connect latency (p95) (seconds)',
    ]);
    // An edge with no HTTP has no HTTP numbers or section, and opens on Connections.
    await w.get(`[data-edge="${MAP.edges[2]!.id}"] .edge-hit`).trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="edge-http"]').exists()).toBe(false);
    expect(w.find('[data-testid="section-http"]').exists()).toBe(false);
    expect(w.findAll('.chart-stub').map((c) => c.text())).toEqual([
      'Connections and failures per second (per_second)',
    ]);
    w.unmount();
  });

  it('keeps positions across refreshes and reloads; a new service does not move the others', async () => {
    mockFetch(routes(MAP));
    let { wrapper: w } = await mountPage();
    const at = (wr: ReturnType<typeof mount>) =>
      Object.fromEntries(
        wr
          .findAll('[data-testid="map-node"]')
          .map((n) => [n.attributes('data-node'), n.attributes('transform')]),
      );
    const before = at(w);
    w.unmount();
    const redis = W('data', 'redis', 'StatefulSet');
    mockFetch(
      routes({
        ...MAP,
        nodes: [...MAP.nodes, redis],
        edges: [...MAP.edges, edge(cart.id, redis.id, { port: 6379 })],
      }),
    );
    ({ wrapper: w } = await mountPage());
    const after = at(w);
    for (const [id, tr] of Object.entries(before)) expect(after[id]).toBe(tr);
    expect(after[redis.id]).toBeTruthy();
    w.unmount();
  });

  it('filters: WatchLog components, namespaces, only problems', async () => {
    mockFetch(routes(MAP));
    const { wrapper: w } = await mountPage();
    const at = () =>
      Object.fromEntries(
        w
          .findAll('[data-testid="map-node"]')
          .map((n) => [n.attributes('data-node'), n.attributes('transform')]),
      );
    const before = at();
    await w.get('[data-testid="filter-watchlog"]').setValue(true);
    expect(nodeIds(w)).toEqual(expect.arrayContaining([agent.id, backend.id]));
    // Newly shown nodes are placed around the others, which do not move.
    const after = at();
    for (const [id, tr] of Object.entries(before)) expect(after[id]).toBe(tr);
    await w.get('[data-testid="filter-onlyProblems"]').setValue(true);
    expect(nodeIds(w).sort()).toEqual([cart.id, catalog.id, pg.id].sort());
    await w.get('[data-testid="filter-onlyProblems"]').setValue(false);
    // Unchecking shop leaves the data namespace and edges into it.
    const shop = w
      .findAll('[data-testid="filter-namespace"]')
      .find((l) => l.text().includes('shop'))!;
    await shop.get('input').setValue(false);
    await flushPromises();
    // WatchLog components are still shown, and so is their namespace.
    expect(nodeIds(w).sort()).toEqual([catalog.id, pg.id, agent.id, backend.id].sort());
    w.unmount();
  });

  it('searches with "/" and Enter selects the result; the text filters the Connections table', async () => {
    mockFetch(routes(MAP));
    const { wrapper: w, router } = await mountPage();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }));
    const input = w.get('[data-testid="search"]');
    expect(document.activeElement).toBe(input.element);
    await input.setValue('cata');
    expect(w.get('[data-testid="map-search-results"]').text()).toContain('catalog');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(router.currentRoute.value.query.node).toBe(catalog.id);

    await w.get('[data-testid="view-connections"]').trigger('click');
    await flushPromises();
    const rows = w.findAll('[data-testid="conn-row"]').map((r) => r.text());
    expect(rows).toHaveLength(2); // cart → catalog and catalog → postgres
    expect(rows.every((r) => r.includes('catalog'))).toBe(true);
    w.unmount();
  });

  it('Connections view: grouped, sortable, a row opens the edge on the map', async () => {
    mockFetch(routes(MAP));
    const { wrapper: w, router } = await mountPage('/service-map?view=connections');
    const groups = w.findAll('[data-testid="conn-group"]').map((g) => g.text());
    expect(groups).toEqual(['Needs attention · 2', 'Healthy · 2']);
    expect(w.findAll('[data-testid="conn-row"]')[0]!.text()).toContain('cart → catalog');
    await w.get('[data-testid="sort-rate"]').trigger('click');
    expect(w.get('[role="columnheader"][aria-sort="descending"]').text()).toContain(
      'Connections/s',
    );
    await w.findAll('[data-testid="conn-row"]')[0]!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.view).toBeUndefined();
    expect(router.currentRoute.value.query.edge).toBeTruthy();
    w.unmount();
  });

  it('External and DNS views: DNS names, and workload names instead of raw ids', async () => {
    mockFetch(routes(MAP));
    let { wrapper: w } = await mountPage('/service-map?view=external');
    expect(w.get('[data-testid="external-card"]').text()).toContain('api.stripe.com:443');
    w.unmount();
    ({ wrapper: w } = await mountPage('/service-map?view=dns'));
    const row = w.get('[data-testid="dns-row"]').text();
    expect(row).toContain('coredns');
    expect(row).toContain('kube-system');
    expect(row).not.toContain('w:kube-system');
    expect(row).toContain('20% of lookups failed');
    // Search-path misses: a muted line, not part of the failed share (ADR-113).
    expect(w.get('[data-testid="dns-search-miss"]').text()).toContain('not counted as errors');
    w.unmount();
  });

  it('zooms only with ⌘/Ctrl + wheel; a plain wheel scrolls the page and shows a hint', async () => {
    mockFetch(routes(MAP));
    const { wrapper: w } = await mountPage();
    const svg = w.get('[data-testid="map-canvas"] svg');
    const world = () => svg.get('g[transform]').attributes('transform');
    const start = world();
    const plain = new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true });
    svg.element.dispatchEvent(plain);
    await flushPromises();
    expect(plain.defaultPrevented).toBe(false);
    expect(world()).toBe(start);
    expect(w.get('[data-testid="zoom-hint"]').classes()).toContain('opacity-100');
    const zoom = new WheelEvent('wheel', { deltaY: -100, cancelable: true, bubbles: true });
    Object.defineProperty(zoom, 'ctrlKey', { value: true }); // happy-dom drops it from the init
    svg.element.dispatchEvent(zoom);
    await flushPromises();
    expect(zoom.defaultPrevented).toBe(true);
    expect(world()).not.toBe(start);
    w.unmount();
  });

  it('says "topology only" with each node\'s reason when no agent runs eBPF', async () => {
    mockFetch(
      routes({
        mode: 'topology',
        dns: [],
        agents: [
          {
            node: 'old-1',
            ebpf: 'unsupported',
            reason: 'kernel 5.4 is older than 5.8',
            cause: 'kernel',
            fix: null,
          },
        ],
        nodes: [
          {
            id: 's:shop/cart',
            kind: 'service',
            name: 'cart',
            namespace: 'shop',
            workloadKind: null,
            watchlog: false,
          },
          cart,
        ],
        edges: [
          edge('s:shop/cart', cart.id, {
            port: null,
            health: 'unknown',
            connectionsPerSecond: 0,
            failedRatio: null,
            latencyP95Seconds: null,
            bytesSentPerSecond: null,
            bytesReceivedPerSecond: null,
          }),
        ],
      }),
    );
    const { wrapper: w } = await mountPage();
    expect(w.get('[data-testid="topology-only"]').text()).toContain(
      'Topology only, no traffic data',
    );
    expect(w.get('[data-testid="ebpf-reason"]').text()).toContain('kernel 5.4 is older than 5.8');
    expect(w.get('[data-testid="live"]').text()).toBe('Topology only');
    expect(w.findAll('[data-testid="map-edge"]').map((e) => e.attributes('data-health'))).toEqual([
      'unknown',
    ]);
    w.unmount();
  });

  it('says why eBPF is off with one fix per release (ADR-107)', async () => {
    const fix = 'helm upgrade kind-demo deploy/helm/watchlog-agent';
    const off = { ebpf: 'disabled', reason: null, cause: 'outdated' as const, fix };
    mockFetch(
      routes({ ...MAP, agents: [...MAP.agents, { node: 'k2', ...off }, { node: 'k3', ...off }] }),
    );
    const { wrapper: w } = await mountPage();
    expect(w.get('[data-testid="ebpf-partial"]').text()).toContain('eBPF is off on 2 of 3 agents');
    expect(w.findAll('[data-testid="ebpf-fix"]')).toHaveLength(1);
    w.unmount();
  });

  it('has empty states for filtered-out maps and for no cluster', async () => {
    mockFetch(routes({ ...MAP, edges: [edge(agent.id, backend.id)] }));
    let { wrapper: w } = await mountPage();
    expect(w.text()).toContain('Nothing matches the filters');
    await w.get('[data-testid="reset-filters"]').trigger('click');
    w.unmount();
    mockFetch({ 'GET /api/v1/clusters': { status: 200, body: { clusters: [] } } });
    ({ wrapper: w } = await mountPage());
    expect(w.text()).toContain('No traffic recorded yet');
    w.unmount();
  });
});
