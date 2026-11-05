// SPDX-License-Identifier: AGPL-3.0-only
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import NodeDetailPage from '@/views/NodeDetailPage.vue';
import NodesPage from '@/views/NodesPage.vue';
import OverviewPage from '@/views/OverviewPage.vue';
import { mockFetch, problem, USER, type Routes } from './fetch-mock';
import { createPlugins } from './helpers';
// Responses of the Kubernetes read API on the kind test cluster (captured in slice 7).
import FIX from './kube-fixtures.json';
import DOCKER_OV from './docker-overview.json';

afterEach(() => vi.unstubAllGlobals());

const base = `/api/v1/clusters/${FIX.cluster.id}`;
const clusters = { 'GET /api/v1/clusters': { status: 200, body: { clusters: [FIX.cluster] } } };

async function mountPage(component: object, path: string) {
  const plugins = await createPlugins(path);
  useAuthStore().user = USER;
  const wrapper = mount(component, {
    global: {
      plugins: [plugins.router, plugins.i18n, plugins.pinia],
      stubs: {
        TimeSeriesChart: {
          props: ['title'],
          template: '<div class="chart-stub">{{ title }}</div>',
        },
        ConditionTimeline: {
          props: ['node'],
          template: '<div class="timeline-stub">{{ node }}</div>',
        },
      },
    },
  });
  await flushPromises();
  return { wrapper, router: plugins.router };
}

describe('Cluster overview', () => {
  // Captured from the kind cluster (backend 050f2ea): 3 crash-looping / OOM pods with
  // their alerts, BackOff events, WatchLog readiness probes, an HPA without metrics.
  const OV = FIX.overview;
  const MAP_EMPTY = { mode: 'flows', agents: [], nodes: [], edges: [], dns: [] };
  const routes = (overview: unknown, path = `${base}/overview?range=3600`) => ({
    ...clusters,
    [`GET ${path}`]: { status: 200, body: overview },
    [`GET ${base}/service-map?range=3600`]: { status: 200, body: MAP_EMPTY },
  });

  it('counts the strip and Needs attention from the same list, with chips per kind', async () => {
    mockFetch(routes(OV));
    const { wrapper: w } = await mountPage(OverviewPage, '/');
    const n = OV.problems.items.length;
    expect(w.get('[data-testid="strip-title"]').text()).toBe(
      `Critical · ${n} problems need attention`,
    );
    expect(w.get('[data-testid="attention-count"]').text()).toBe(String(n));
    expect(w.findAll('[data-testid="attention-item"]')).toHaveLength(n);
    const chips = w.findAll('[data-testid="strip-chip"]');
    expect(chips.map((c) => c.text())).toEqual(['✕ 1 crash-looping pod', '✕ 2 out of memory']);
    expect(chips[0]!.attributes('href')).toBe(`/alerts?rule=${OV.problems.types[0]!.ruleId}`);
    // Human titles and why lines from the alert texts; a click opens the alert.
    const first = w.findAll('[data-testid="attention-item"]')[0]!;
    expect(first.text()).toContain('crashloop is crash-looping');
    expect(first.text()).toContain('last exit: Error (code 1)');
    expect(first.attributes('href')).toBe(`/alerts/${OV.problems.items[0]!.alertId}`);
    w.unmount();
  });

  it('shows the facts, KPIs with trends and comparisons, and CPU against requests', async () => {
    mockFetch(routes(OV));
    const { wrapper: w } = await mountPage(OverviewPage, '/');
    const facts = w.get('[data-testid="facts"]').text();
    expect(facts).toContain('Kubernetes 1.37.0');
    expect(facts).toContain('agents 3 / 3');
    expect(facts).toContain('eBPF on');
    expect(facts).toContain('alerting running');
    expect(w.get('[data-testid="kpi-nodes"]').text()).toContain('all Ready');
    expect(w.get('[data-testid="kpi-pods"]').text()).toContain(String(OV.kpis.pods.running));
    // 32 restarts against 34 in the previous hour: 6 % fewer.
    expect(w.get('[data-testid="kpi-restarts"]').text()).toContain('▼ -2 vs previous 1h');
    expect(w.get('[data-testid="kpi-traffic"]').text()).toContain('conn/s');
    expect(w.get('[data-testid="kpi-cpu"]').text()).toMatch(/used \d+%.*requested \d+%/);
    expect(w.findAll('[data-testid="kpis"] svg path').length).toBeGreaterThan(4);
    w.unmount();
  });

  it('groups warning events, hides covered ones and WatchLog pods, says what it hid', async () => {
    mockFetch(routes(OV));
    const { wrapper: w } = await mountPage(OverviewPage, '/');
    const rows = w.findAll('[data-testid="event-row"]').map((r) => r.text());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('FailedGetResourceMetric');
    expect(rows[0]).toContain('install metrics-server');
    expect(rows.join(' ')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    const hidden = w.get('[data-testid="events-hidden"]').text();
    expect(hidden).toContain('+ 6 hidden');
    expect(hidden).toContain('3 for problems already in Needs attention');
    expect(hidden).toContain("3 from WatchLog's own pods");
    await w.get('[data-testid="hide-own"]').setValue(false);
    expect(w.findAll('[data-testid="event-row"]')).toHaveLength(4);
    w.unmount();
  });

  it('shows recent changes, pods by node, and passes the namespace filter', async () => {
    const { calls } = mockFetch(
      routes(OV, `${base}/overview?range=3600&namespaces=kube-system%2Cwl-test`),
    );
    const { wrapper: w } = await mountPage(OverviewPage, '/?ns=wl-test,kube-system');
    expect(calls.some((c) => c.path.includes('namespaces=kube-system%2Cwl-test'))).toBe(true);
    expect(w.findAll('[data-testid="change"]')[0]!.text()).toContain('Rollout · watchlog-backend');
    // No service map card; one heat row per node, failing pods marked, a legend.
    expect(w.find('[data-testid="card-map"]').exists()).toBe(false);
    const rows = w.findAll('[data-testid="heat-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text()).toContain('watchlog-control-plane');
    expect(rows[0]!.text()).toContain('12 pods');
    const cells = w.findAll('[data-testid="heat-cell"]');
    expect(cells).toHaveLength(OV.pods.length);
    const failing = cells.filter((c) => c.text() === '✕');
    expect(failing).toHaveLength(3);
    expect(failing[0]!.attributes('title')).toMatch(/failing: CrashLoopBackOff$/);
    expect(failing[0]!.attributes('href')).toMatch(/^\/pods\//);
    expect(cells.find((c) => c.text() === '')!.attributes('title')).toMatch(
      /CPU [\d.]+ cores(, \d+% of its [\d.]+ request|, no request)|no CPU data/,
    );
    expect(w.get('[data-testid="heat-legend"]').text()).toContain('over request');
    // Top workloads hide system namespaces until asked.
    const top = () => w.findAll('[data-testid="top-row"]').map((r) => r.text());
    expect(top().some((t) => /kube-system/.test(t))).toBe(false);
    await w.get('[data-testid="top-hide-system"]').setValue(false);
    expect(top().some((t) => /kube-system/.test(t))).toBe(true);
    w.unmount();
  });

  it("keeps each node's own pod count when a large cluster draws only some pods", async () => {
    const node = OV.nodes[0]!.name;
    const few = {
      ...OV,
      pods: OV.pods.filter((p) => p.node !== node).concat(OV.pods.find((p) => p.node === node)!),
    };
    mockFetch(routes(few));
    const { wrapper: w } = await mountPage(OverviewPage, '/');
    const row = w.findAll('[data-testid="heat-row"]')[0]!;
    expect(row.text()).toContain(`${OV.nodes[0]!.pods} pods`);
    expect(row.get('[data-testid="heat-more"]').text()).toBe(`+${OV.nodes[0]!.pods - 1}`);
    w.unmount();
  });

  it('is a calm green strip when healthy, and unknown while alerting is not running', async () => {
    const calm = {
      ...OV,
      health: 'healthy',
      problems: { items: [], critical: 0, warning: 0, types: [], silenced: 1, oldestSince: null },
    };
    mockFetch(routes(calm));
    let { wrapper: w } = await mountPage(OverviewPage, '/');
    expect(w.get('[data-testid="status-strip"]').classes()).toContain('strip-healthy');
    expect(w.get('[data-testid="strip-title"]').text()).toBe('All clear');
    expect(w.get('[data-testid="strip-silenced"]').text()).toBe('1 silenced');
    w.unmount();
    mockFetch(
      routes({ ...calm, health: 'unknown', facts: { ...OV.facts, alertingRunning: false } }),
    );
    ({ wrapper: w } = await mountPage(OverviewPage, '/'));
    expect(w.get('[data-testid="status-strip"]').text()).toContain('Status unknown');
    expect(w.get('[data-testid="status-strip"]').text()).toContain('Alerting is not running');
    expect(w.get('[data-testid="facts"]').text()).toContain('alerting not running');
    w.unmount();
  });

  it('explains what to do without a cluster and while waiting for agents', async () => {
    mockFetch({ 'GET /api/v1/clusters': { status: 200, body: { clusters: [] } } });
    let { wrapper: w } = await mountPage(OverviewPage, '/');
    expect(w.text()).toContain('No cluster connected yet');
    w.unmount();
    const empty = {
      ...OV,
      facts: { ...OV.facts, nodes: 0, agents: { reporting: 0, expected: 0 } },
      kpis: { ...OV.kpis, pods: { ...OV.kpis.pods, total: 0 } },
    };
    mockFetch(routes(empty));
    ({ wrapper: w } = await mountPage(OverviewPage, '/'));
    expect(w.text()).toContain('Waiting for the agents');
    expect(w.find(`a[href="/settings/clusters/${FIX.cluster.id}"]`).exists()).toBe(true);
    w.unmount();
  });

  it('shows an error with Retry and recovers', async () => {
    mockFetch({
      ...routes(OV),
      [`GET ${base}/overview?range=3600`]: [problem(503, 'down'), { status: 200, body: OV }],
    } as Routes);
    const { wrapper: w } = await mountPage(OverviewPage, '/');
    expect(w.find('[data-testid="error-state"]').exists()).toBe(true);
    await w.get('[data-testid="retry"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="error-state"]').exists()).toBe(false);
    expect(w.find('[data-testid="status-strip"]').exists()).toBe(true);
    w.unmount();
  });
});

describe('Nodes', () => {
  type NodesBody = Omit<typeof FIX.nodes, 'diskAlerts'> & { diskAlerts: unknown[] };
  const nodeRoutes = (body: NodesBody = FIX.nodes) => ({
    ...clusters,
    [`GET ${base}/nodes?range=3600`]: {
      status: 200,
      body: { ...body, nodes: body.nodes.map((n) => ({ ...n, heat: undefined })) },
    },
    [`GET ${base}/nodes?range=3600&heat=1`]: { status: 200, body },
  });

  it('shows capacity tiles, one TLS notice and node cards with heatmaps', async () => {
    const withAlert = {
      ...FIX.nodes,
      diskAlerts: [{ node: 'watchlog-worker', mount: '/var', alertId: 'disk-1' }],
    };
    const { calls } = mockFetch(nodeRoutes(withAlert));
    const { wrapper: w } = await mountPage(NodesPage, '/nodes');
    // Three nodes: cards, with the heatmaps asked for once the count is known.
    expect(calls.map((c) => c.path).filter((p) => p.includes('/nodes'))).toEqual([
      `${base}/nodes?range=3600`,
      `${base}/nodes?range=3600&heat=1`,
    ]);
    const cards = w.findAll('[data-testid="node-card"]');
    expect(cards).toHaveLength(3);
    expect(w.get('[data-testid="ready-count"]').text()).toBe('✓ 3 / 3 Ready');
    expect(w.get('[data-testid="tile-pods"]').text()).toMatch(/^Pods\s*31\s*\/ 330 capacity/);
    expect(w.get('[data-testid="tile-cpu"]').text()).toContain('12.0 cores allocatable');
    const disk = w.get('[data-testid="tile-disk"]').text();
    expect(disk).toContain('25%');
    expect(disk).toContain('/var on watchlog-worker');
    expect(w.get('[data-testid="disk-alert"]').attributes('href')).toBe('/alerts/disk-1');
    // One notice for the cluster, a small shield on each card, no badges per row.
    const note = w.get('[data-testid="kubelet-tls-note"]');
    expect(note.text()).toContain('on 1 node is self-signed');
    expect(note.get('a').attributes('href')).toMatch(/faq\.md#nodes-say-the-kubelet-certificate/);
    expect(w.findAll('[data-testid="tls-hint"]')).toHaveLength(1);
    expect(w.find('[data-testid="kubelet-tls-badge"]').exists()).toBe(false);
    const worker = cards[1]!;
    expect(worker.text()).toContain('watchlog-worker');
    expect(worker.text()).toMatch(/worker · v1\.37\.0 · .* · kernel .* · up /);
    expect(worker.text()).toContain('✓ Memory');
    expect(worker.get('[data-testid="node-disk"]').text()).toContain('Disk /var');
    expect(worker.findAll('[data-testid="heat-cell"]')).toHaveLength(9);
    // Failing pods are marked in the heatmaps.
    expect(w.findAll('[data-testid="heat-cell"]').filter((c) => c.text() === '✕')).toHaveLength(2);

    await w.get('[data-testid="dismiss-tls"]').trigger('click');
    expect(w.find('[data-testid="kubelet-tls-note"]').exists()).toBe(false);
    w.unmount();
    mockFetch(nodeRoutes());
    const again = await mountPage(NodesPage, '/nodes');
    expect(again.wrapper.find('[data-testid="kubelet-tls-note"]').exists()).toBe(false);
    again.wrapper.unmount();
    localStorage.clear();
  });

  it('switches to a sortable table, the default beyond 12 nodes', async () => {
    mockFetch(nodeRoutes());
    const { wrapper: w, router } = await mountPage(NodesPage, '/nodes?layout=table');
    const rows = w.findAll('[data-testid="node-row"]');
    expect(rows.map((r) => r.find('a').text())).toEqual([
      'watchlog-control-plane',
      'watchlog-worker',
      'watchlog-worker2',
    ]);
    expect(rows[1]!.text()).toContain('9 / 110');
    // Sorting by pods (descending first) puts the 9-pod worker last.
    const podsHeader = w.findAll('th button').find((b) => b.text() === 'Pods')!;
    await podsHeader.trigger('click');
    expect(w.findAll('[data-testid="node-row"]').at(-1)!.find('a').text()).toBe('watchlog-worker');
    await router.replace({ query: { q: 'worker2', layout: 'table' } });
    w.unmount();
    mockFetch(nodeRoutes());
    const filtered = await mountPage(NodesPage, '/nodes?q=worker2&layout=table');
    expect(filtered.wrapper.findAll('[data-testid="node-row"]')).toHaveLength(1);
    filtered.wrapper.unmount();

    const many = {
      ...FIX.nodes,
      nodes: Array.from({ length: 13 }, (_, i) => ({ ...FIX.nodes.nodes[0]!, name: `n-${i}` })),
    };
    const { calls } = mockFetch(nodeRoutes(many));
    const big = await mountPage(NodesPage, '/nodes');
    expect(big.wrapper.findAll('[data-testid="node-row"]')).toHaveLength(13);
    expect(calls.some((c) => c.path.includes('heat=1'))).toBe(false);
    big.wrapper.unmount();
  });
});

describe('Node detail', () => {
  it('shows the node, its pods with termination reasons, charts and events', async () => {
    mockFetch({
      ...clusters,
      [`GET ${base}/nodes/watchlog-worker`]: { status: 200, body: FIX.node },
    });
    const { wrapper: w } = await mountPage(NodeDetailPage, '/nodes/watchlog-worker');
    expect(w.get('h2').text()).toBe('watchlog-worker');
    expect(w.get('[data-testid="node-meta"]').text()).toContain('v1.37.0');
    expect(w.find('[data-testid="kubelet-tls-badge"]').exists()).toBe(true);
    expect(w.findAll('.chart-stub').map((c) => c.text())).toContain('CPU usage');
    expect(w.get('.timeline-stub').text()).toBe('watchlog-worker');
    const pods = w.get('[data-testid="pod-table"]').text();
    expect(pods).toContain('crashloop');
    expect(pods).toContain('CrashLoopBackOff');
    expect(w.findAll('[data-testid="last-termination"]').map((x) => x.text())).toContain(
      'last: Error (exit 1)',
    );
    // The same heatmap as on the Nodes page.
    const cells = w.findAll('[data-testid="node-heatmap"] [data-testid="heat-cell"]');
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.filter((c) => c.text() === '✕').length).toBeGreaterThan(0);
    w.unmount();
  });

  it('says so when the node is gone', async () => {
    mockFetch({ ...clusters, [`GET ${base}/nodes/gone`]: problem(404, 'Node not found') });
    const { wrapper: w } = await mountPage(NodeDetailPage, '/nodes/gone');
    expect(w.get('[data-testid="not-found"]').text()).toContain('not in the cluster');
    expect(w.find('[data-testid="error-state"]').exists()).toBe(false);
    w.unmount();
  });
});

describe('Docker overview', () => {
  it('shows a fleet with the same cards: facts, counts, problems, changes, events, heatmap', async () => {
    const fleet = {
      ...FIX.cluster,
      id: DOCKER_OV.cluster?.id ?? FIX.cluster.id,
      kind: 'docker',
      name: 'fleet',
    };
    const fbase = `/api/v1/clusters/${fleet.id}`;
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [fleet] } },
      [`GET ${fbase}/overview?range=3600`]: { status: 200, body: DOCKER_OV },
    });
    const { wrapper: w } = await mountPage(OverviewPage, '/');
    expect(w.get('[data-testid="facts"]').text()).toContain('Docker 29.9.2');
    expect(w.get('[data-testid="facts"]').text()).toContain('1 host');
    expect(w.get('[data-testid="kpi-pods"]').text()).toMatch(/Containers running\s*2\s*\/ 3/);
    expect(w.get('[data-testid="kpi-pods"]').text()).toContain('1 stopped · 0 unhealthy');
    const item = w.get('[data-testid="attention-item"]');
    expect(item.text()).toContain('fx-crashloop keeps restarting');
    expect(item.attributes('href')).toBe('/containers/h1/fx-crashloop');
    const change = w.get('[data-testid="change"]');
    expect(change.text()).toContain('New image · demo-web-1');
    expect(change.get('a').attributes('href')).toBe('/containers/h1/demo-web-1');
    // The crash-looping container's event is covered by the problem: hidden.
    expect(w.findAll('[data-testid="event-row"]').map((r) => r.text())).toEqual([
      expect.stringContaining('demo-web-1'),
    ]);
    expect(w.get('[data-testid="card-pods-by-node"]').text()).toContain('Containers by host');
    expect(w.findAll('[data-testid="heat-cell"]').filter((c) => c.text() === '✕')).toHaveLength(1);
    w.unmount();
  });
});

describe('Cluster switcher', () => {
  it('names the Kubernetes cluster', async () => {
    mockFetch(clusters);
    const { default: ClusterSwitcher } = await import('@/components/layout/ClusterSwitcher.vue');
    const plugins = await createPlugins('/');
    useAuthStore().user = USER;
    const w = mount(ClusterSwitcher, {
      props: { collapsed: false },
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    await flushPromises();
    const input = w.get('[role="combobox"]');
    expect(input.attributes('aria-label')).toBe(`Cluster: ${FIX.cluster.name}`);
    w.unmount();
  });
});
