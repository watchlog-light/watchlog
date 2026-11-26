// SPDX-License-Identifier: AGPL-3.0-only
// Your metrics (1.0.0, ADR-236): the page with its list and a metric's detail, the empty state,
// "Add a source" on a cluster and on a fleet, and the pinned card of a workload's page.
import type { OwnMetric, OwnMetricsSummary } from '@watchlog/api-types';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownMetricsApi } from '@/api/own-metrics';
import PinnedMetrics from '@/components/own-metrics/PinnedMetrics.vue';
import { chartSummary, ownChartOption, thin } from '@/lib/own-chart';
import { useAuthStore } from '@/stores/auth';
import YourMetricsAddPage from '@/views/YourMetricsAddPage.vue';
import YourMetricsPage from '@/views/YourMetricsPage.vue';
import { FLEET } from './docker-fixtures';
import { mockFetch, problem, USER, type Routes } from './fetch-mock';
import { createPlugins } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const KUBE = {
  ...FLEET,
  id: '01a18f42-06e7-7078-a01a-ea39c791d700',
  name: 'prod',
  kind: 'kubernetes',
};
const ORDERS = {
  kind: 'workload' as const,
  namespace: 'shop',
  workloadKind: 'Deployment',
  name: 'orders',
};

const metric = (over: Partial<OwnMetric>): OwnMetric => ({
  id: `id-${over.name}`,
  name: 'orders_created_total',
  words: 'Orders created',
  type: 'counter',
  detectedType: 'counter',
  unit: 'count',
  detectedUnit: 'count',
  shown: 'rate',
  help: '',
  hidden: false,
  labels: ['method'],
  refused: null,
  firstSeenAt: 0,
  lastSeenAt: 0,
  series: 7,
  sources: [{ id: 's1', label: 'orders :8080/metrics', kind: 'scrape_pod' }],
  owners: [ORDERS],
  ownerCount: 1,
  untied: false,
  pushed: false,
  value: 0.07,
  ...over,
});
const M_ORDERS = metric({ name: 'orders_created_total' });
const M_CHECKOUT = metric({
  name: 'checkout_duration_seconds',
  words: 'Checkout duration',
  type: 'histogram',
  detectedType: 'histogram',
  unit: 'seconds',
  detectedUnit: 'seconds',
  shown: 'p95',
  value: 0.38,
});
const M_BACKUP = metric({
  name: 'backup_last_success_timestamp',
  words: 'Backup last success',
  type: 'timestamp',
  detectedType: 'timestamp',
  unit: 'seconds',
  detectedUnit: 'seconds',
  shown: 'time_since',
  value: 3 * 3600,
  owners: [],
  ownerCount: 0,
  untied: true,
  pushed: true,
  labels: [],
  sources: [{ id: 's2', label: 'token "ci and cron"', kind: 'push' }],
});

const summary = (over: Partial<OwnMetricsSummary> = {}): OwnMetricsSummary => ({
  usage: { series: 412, sources: 2 },
  limits: {
    series: 2000,
    seriesPerSource: 500,
    sources: null,
    dashboards: 50,
    widgetsPerDashboard: 24,
    alerts: 'threshold',
    usualRange: false,
    watched: 0,
  },
  sources: [
    {
      id: 's1',
      kind: 'scrape_pod',
      label: 'orders :8080/metrics',
      owner: ORDERS,
      owners: [ORDERS],
      series: 296,
      lastReportedAt: Date.now() - 12_000,
      error: null,
      refused: false,
      dropped: {
        reserved: 0,
        invalid: 0,
        cardinality: [],
        sourceCap: 38,
        orgCap: 0,
        sources: false,
      },
      removable: false,
      by: 'watchlog',
    },
  ],
  tokens: [],
  metrics: 3,
  hidden: 51,
  settings: { prometheusAnnotations: false },
  kind: 'kubernetes',
  servers: [],
  endpoint: 'https://watchlog.example.com',
  ...over,
});

const detailOf = (m: OwnMetric, over: object = {}) => ({
  metric: m,
  p50: m.type === 'histogram' ? 0.21 : null,
  p99: m.type === 'histogram' ? 0.9 : null,
  labels: m.labels.map((name) => ({ name, values: 7, top: ['card', 'cash'] })),
  usedIn: { pins: [], dashboards: [] },
  ...over,
});

const stubs = {
  OwnMetricChart: {
    props: ['lines', 'showing', 'label'],
    template:
      '<div class="chart-stub">{{ label }}|{{ lines.map((l) => l.name).join(",") }}|{{ showing.shown }}</div>',
  },
};

async function mountAt(
  component: object,
  path: string,
  routes: Routes,
  cluster = KUBE,
  role = 'owner',
) {
  const m = mockFetch({
    'GET /api/v1/clusters': { status: 200, body: { clusters: [cluster] } },
    ...routes,
  });
  const series = vi.spyOn(ownMetricsApi, 'series').mockResolvedValue({
    step: 60,
    unit: 'count',
    shown: 'rate',
    values: 0,
    lines: [{ value: null, other: false, points: [[1, 0.07]] }],
  });
  const plugins = await createPlugins(path);
  useAuthStore().user = { ...USER, role: role as 'owner' };
  const wrapper = mount(component, {
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia], stubs },
    attachTo: document.body,
  });
  await flushPromises();
  return { wrapper, router: plugins.router, calls: m.calls, series };
}

const base = `/api/v1/clusters/${KUBE.id}/own-metrics`;
const LIST = {
  metrics: [M_ORDERS, M_CHECKOUT, M_BACKUP].map((m) => ({ ...m, spark: [1, 2, 3] })),
  hidden: 51,
};

describe('Your metrics: the list and a metric', () => {
  const routes = (): Routes => ({
    [`GET ${base}`]: { status: 200, body: summary() },
    [`GET ${base}/metrics?spark=true`]: { status: 200, body: LIST },
    [`GET ${base}/metrics/${M_ORDERS.id}`]: { status: 200, body: detailOf(M_ORDERS) },
    [`GET ${base}/metrics/${M_CHECKOUT.id}`]: { status: 200, body: detailOf(M_CHECKOUT) },
    [`GET ${base}/metrics/${M_BACKUP.id}`]: { status: 200, body: detailOf(M_BACKUP) },
  });

  it('shows what is used, each metric as its type reads, and the first metric’s detail', async () => {
    const { wrapper, series } = await mountAt(
      YourMetricsPage,
      '/your-metrics?tab=metrics',
      routes(),
    );
    expect(wrapper.get('[data-testid="own-usage"]').text()).toBe('412 of 2,000 series');
    const rows = wrapper.findAll('[data-testid="own-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text()).toContain('orders_created_total');
    expect(rows[0]!.text()).toContain('Orders created · shop/orders');
    expect(rows[0]!.text()).toMatch(/4\.2\s+\/min/);
    expect(rows[1]!.text()).toMatch(/380\s+ms/);
    expect(rows[2]!.text()).toContain('Backup last success · pushed');
    expect(rows[2]!.text()).toMatch(/3 h\s+ago/);
    expect(wrapper.get('[data-testid="own-hidden"]').text()).toContain(
      '3 of 54 · Go and process internals are hidden.',
    );
    // The first metric is open, with its line over the selected range.
    expect(wrapper.get('[data-testid="own-name"]').text()).toBe('orders_created_total');
    expect(wrapper.get('[data-testid="own-now"]').text()).toMatch(/4\.2\s+\/min/);
    expect(wrapper.get('[data-testid="own-detail"]').text()).toContain('shown as a rate');
    expect(wrapper.get('[data-testid="own-detail"]').text()).toContain('from orders :8080/metrics');
    expect(wrapper.get('[data-testid="own-labels"]').text()).toBe('method');
    expect(wrapper.get('[data-testid="own-series"]').text()).toBe('7 series');
    expect(wrapper.get('[data-testid="own-used"]').text()).toBe('Nowhere yet');
    expect(wrapper.get('.chart-stub').text()).toBe('Orders created||rate');
    expect(series).toHaveBeenCalledWith(
      KUBE.id,
      M_ORDERS.id,
      expect.objectContaining({ from: expect.any(Number) }),
    );
    wrapper.unmount();
  });

  it('opens another metric from the list; a histogram shows its other quantiles', async () => {
    const { wrapper, router } = await mountAt(
      YourMetricsPage,
      '/your-metrics?tab=metrics',
      routes(),
    );
    await wrapper.findAll('[data-testid="own-row"]')[1]!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.metric).toBe(M_CHECKOUT.id);
    expect(wrapper.get('[data-testid="own-name"]').text()).toBe('checkout_duration_seconds');
    expect(wrapper.get('[data-testid="own-quantiles"]').text()).toBe('p50 210 ms · p99 900 ms');
    wrapper.unmount();
  });

  it('filters by what is typed and by where metrics come from', async () => {
    const { wrapper } = await mountAt(YourMetricsPage, '/your-metrics?tab=metrics', routes());
    await wrapper.get('[data-testid="own-chip-pushed"]').trigger('click');
    expect(wrapper.findAll('[data-testid="own-row"]')).toHaveLength(1);
    await wrapper.get('[data-testid="own-chip-ns:shop"]').trigger('click');
    expect(wrapper.findAll('[data-testid="own-row"]')).toHaveLength(2);
    await wrapper.get('[data-testid="own-search"] input').setValue('checkout');
    expect(wrapper.findAll('[data-testid="own-row"]')).toHaveLength(1);
    await wrapper.get('[data-testid="own-search"] input').setValue('nothing-like-this');
    expect(wrapper.get('[data-testid="own-list"]').text()).toContain('No metric matches.');
    wrapper.unmount();
  });

  it('“Show all” reads the internals too', async () => {
    const { wrapper, calls } = await mountAt(YourMetricsPage, '/your-metrics?tab=metrics', {
      ...routes(),
      [`GET ${base}/metrics?all=true&spark=true`]: {
        status: 200,
        body: {
          metrics: [
            ...LIST.metrics,
            {
              ...metric({
                name: 'go_goroutines',
                hidden: true,
                value: 31,
                type: 'gauge',
                shown: 'as_is',
              }),
              spark: [],
            },
          ],
          hidden: 0,
        },
      },
    });
    await wrapper.get('[data-testid="own-show-all"]').trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.path.endsWith('/metrics?all=true&spark=true'))).toBe(true);
    expect(wrapper.findAll('[data-testid="own-row"]')).toHaveLength(4);
    expect(wrapper.get('[data-testid="own-hidden"]').text()).toContain('Hide internals');
    wrapper.unmount();
  });

  it('pins a metric to the page it belongs to, and unpins it', async () => {
    const pinned = detailOf(M_ORDERS, {
      usedIn: { pins: [{ id: 'pin-1', owner: ORDERS }], dashboards: [] },
    });
    const { wrapper, calls } = await mountAt(YourMetricsPage, '/your-metrics?tab=metrics', {
      ...routes(),
      [`GET ${base}/metrics/${M_ORDERS.id}`]: [
        { status: 200, body: detailOf(M_ORDERS) },
        { status: 200, body: pinned },
        { status: 200, body: detailOf(M_ORDERS) },
      ],
      [`POST ${base}/pins`]: { status: 201, body: { id: 'pin-1' } },
      [`DELETE ${base}/pins/pin-1`]: { status: 204 },
    });
    const pin = wrapper.get('[data-testid="own-pin"]');
    expect(pin.text()).toBe('Pin to shop/orders');
    await pin.trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      metricId: M_ORDERS.id,
      owner: { kind: 'workload', namespace: 'shop', workloadKind: 'Deployment', name: 'orders' },
    });
    expect(wrapper.get('[data-testid="own-pin"]').text()).toBe('Unpin from shop/orders');
    expect(wrapper.get('[data-testid="own-used"]').text()).toBe('Pinned on shop/orders');
    await wrapper.get('[data-testid="own-pin"]').trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/pins/pin-1'))).toBe(true);
    wrapper.unmount();
  });

  it('says why a metric is refused and lets an Admin check it again', async () => {
    const refused = { ...M_ORDERS, refused: { label: 'user_id' } };
    const { wrapper, calls } = await mountAt(YourMetricsPage, '/your-metrics?tab=metrics', {
      ...routes(),
      [`GET ${base}/metrics?spark=true`]: { status: 200, body: { metrics: [refused], hidden: 0 } },
      [`GET ${base}/metrics/${M_ORDERS.id}`]: { status: 200, body: detailOf(refused) },
      [`PATCH ${base}/metrics/${M_ORDERS.id}`]: { status: 200, body: { metric: M_ORDERS } },
    });
    expect(wrapper.get('[data-testid="own-row-refused"]').text()).toBe('Refused');
    expect(wrapper.get('[data-testid="own-refused"]').text()).toContain(
      'too many values for the label user_id',
    );
    await wrapper.get('[data-testid="own-refused"] button').trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ checkAgain: true });
    wrapper.unmount();
  });

  it('a Viewer reads everything and changes nothing', async () => {
    const { wrapper } = await mountAt(
      YourMetricsPage,
      '/your-metrics?tab=metrics',
      routes(),
      KUBE,
      'viewer',
    );
    expect(wrapper.find('[data-testid="own-actions"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="own-add"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="own-name"]').text()).toBe('orders_created_total');
    wrapper.unmount();
  });

  it('with nothing reporting: the three ways in', async () => {
    const { wrapper } = await mountAt(YourMetricsPage, '/your-metrics?tab=metrics', {
      [`GET ${base}`]: {
        status: 200,
        body: summary({ sources: [], usage: { series: 0, sources: 0 } }),
      },
      [`GET ${base}/metrics?spark=true`]: { status: 200, body: { metrics: [], hidden: 0 } },
    });
    const empty = wrapper.get('[data-testid="own-empty"]');
    expect(empty.text()).toContain('Nothing reports yet');
    for (const way of ['scrape', 'prometheus', 'push'])
      expect(empty.get(`[data-testid="own-way-${way}"]`).attributes('href')).toContain(
        `/your-metrics/add?cluster=${KUBE.id}&way=${way}`,
      );
    wrapper.unmount();
  });

  it('says so when the plan’s series are all in use', async () => {
    const { wrapper } = await mountAt(YourMetricsPage, '/your-metrics?tab=metrics', {
      ...routes(),
      [`GET ${base}`]: { status: 200, body: summary({ usage: { series: 2000, sources: 2 } }) },
    });
    expect(wrapper.get('[data-testid="own-full"]').text()).toContain(
      'All 2,000 series of your plan are in use',
    );
    wrapper.unmount();
  });
});

describe('Add a source', () => {
  it('in a cluster: the annotations, the Prometheus switch, the limits and what each source dropped', async () => {
    const { wrapper, calls } = await mountAt(YourMetricsAddPage, '/your-metrics/add', {
      [`GET ${base}`]: [
        { status: 200, body: summary() },
        { status: 200, body: summary({ settings: { prometheusAnnotations: true } }) },
      ],
      [`PUT ${base}/settings`]: { status: 200, body: { prometheusAnnotations: true } },
    });
    const panel = wrapper.get('[data-testid="own-add-panel-scrape"]');
    expect(panel.text()).toContain('watchlog.io/scrape: "true"');
    expect(panel.text()).toContain('watchlog.io/port');
    expect(wrapper.get('[data-testid="own-limits"]').text()).toContain(
      'At most 500 series from one source',
    );
    expect(wrapper.get('[data-testid="own-limits"]').text()).toContain(
      '2,000 series on your plan; 412 in use.',
    );
    const source = wrapper.get('[data-testid="own-source"]');
    expect(source.text()).toContain('orders :8080/metrics');
    expect(source.text()).toContain('Scraped, every 30 s');
    expect(source.text()).toContain('shop/orders');
    expect(source.text()).toContain('296');
    expect(source.get('[data-testid="own-source-state"]').text()).toBe('ok · just now');
    expect(source.get('[data-testid="own-source-dropped"]').text()).toBe(
      '38 series dropped: one source brings at most 500.',
    );
    // Scraped because of its annotation: removed there, not here.
    expect(source.find('[data-testid="own-source-remove"]').exists()).toBe(false);
    await wrapper.get('[data-testid="own-prom-toggle"] input').setValue(true);
    await flushPromises();
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ prometheusAnnotations: true });
    wrapper.unmount();
  });

  it('Prometheus and push: the real address, and the token once it is made', async () => {
    const { wrapper, calls } = await mountAt(
      YourMetricsAddPage,
      '/your-metrics/add?way=prometheus',
      {
        [`GET ${base}`]: { status: 200, body: summary() },
        [`POST ${base}/tokens`]: [
          problem(409, 'A token with this name exists; pick another name'),
          {
            status: 201,
            body: {
              id: 't1',
              name: 'prometheus',
              prefix: 'abcdefgh',
              value: 'wl_mt_abcdefgh_secret',
            },
          },
        ],
      },
    );
    const panel = () => wrapper.get('[data-testid="own-add-panel-prometheus"]').text();
    expect(panel()).toContain('url: https://watchlog.example.com/ingest/v1/write');
    expect(panel()).toContain('credentials: wl_mt_…');
    expect(panel()).toContain('action: keep');
    expect(wrapper.find('[data-testid="own-token-hint"]').exists()).toBe(true);
    // Without a name nothing is sent.
    await wrapper.get('[data-testid="own-token-form"]').trigger('submit');
    expect(wrapper.get('[data-testid="own-tokens"]').text()).toContain('Give the token a name.');
    await wrapper.get('[data-testid="own-token-form"] input').setValue('prometheus');
    await wrapper.get('[data-testid="own-token-form"]').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[data-testid="own-tokens"]').text()).toContain(
      'A token with this name exists',
    );
    await wrapper.get('[data-testid="own-token-form"]').trigger('submit');
    await flushPromises();
    expect(calls.filter((c) => c.method === 'POST').at(-1)!.body).toEqual({ name: 'prometheus' });
    expect(wrapper.get('[data-testid="own-token-made"]').text()).toContain('wl_mt_abcdefgh_secret');
    expect(wrapper.get('[data-testid="own-token-made"]').text()).toContain(
      "It won't be shown again.",
    );
    expect(panel()).toContain('credentials: wl_mt_abcdefgh_secret');
    await wrapper.get('[data-testid="own-add-way-push"]').trigger('click');
    await flushPromises();
    const push = wrapper.get('[data-testid="own-add-panel-push"]').text();
    expect(push).toContain('https://watchlog.example.com/ingest/v1/metrics');
    expect(push).toContain('Bearer wl_mt_abcdefgh_secret');
    expect(push).toContain('"workload": "shop/orders"');
    wrapper.unmount();
  });

  it('on a fleet: an address on one server, with the server’s own words on a mistake', async () => {
    const fleetBase = `/api/v1/clusters/${FLEET.id}/own-metrics`;
    const fleet = summary({
      kind: 'server',
      servers: ['db-1'],
      sources: [
        {
          id: 's9',
          kind: 'scrape_address',
          label: 'db-1 :9400/metrics',
          owner: { kind: 'server', namespace: '', workloadKind: '', name: 'db-1' },
          owners: [],
          series: 0,
          lastReportedAt: Date.now() - 40_000,
          error: 'connection refused',
          refused: false,
          dropped: {
            reserved: 0,
            invalid: 0,
            cardinality: [{ metric: 'logins_total', label: 'user_id' }],
            sourceCap: 0,
            orgCap: 0,
            sources: false,
          },
          removable: true,
          by: 'panel',
        },
      ],
    });
    const { wrapper, calls } = await mountAt(
      YourMetricsAddPage,
      '/your-metrics/add',
      {
        [`GET ${fleetBase}`]: { status: 200, body: fleet },
        [`POST ${fleetBase}/sources`]: [
          problem(
            400,
            'Give an address like localhost:9400/metrics (http or https, no user or password)',
          ),
          { status: 201, body: { id: 's10' } },
        ],
        [`DELETE ${fleetBase}/sources/s9`]: { status: 204 },
      },
      FLEET,
    );
    expect(wrapper.get('[data-testid="own-add-panel-scrape"]').text()).toContain(
      'Give the address on one server',
    );
    const state = wrapper.get('[data-testid="own-source"]');
    expect(state.get('[data-testid="own-source-state"]').text()).toBe('not stored');
    expect(state.text()).toContain('The last read failed: connection refused');
    expect(state.text()).toContain('logins_total refused: too many values for user_id.');
    // One server: it is already picked.
    await wrapper
      .get('[data-testid="own-address-form"] input[placeholder="localhost:9400/metrics"]')
      .setValue('user:pw@localhost:9400');
    await wrapper.get('[data-testid="own-address-form"]').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[data-testid="own-add-error"]').text()).toContain('no user or password');
    await wrapper
      .get('[data-testid="own-address-form"] input[placeholder="localhost:9400/metrics"]')
      .setValue('localhost:9100/metrics');
    await wrapper.get('[data-testid="own-address-form"]').trigger('submit');
    await flushPromises();
    expect(calls.filter((c) => c.method === 'POST').at(-1)!.body).toEqual({
      server: 'db-1',
      address: 'localhost:9100/metrics',
    });
    // A source added in the panel is removed here, after a question.
    await wrapper.get('[data-testid="own-source-remove"]').trigger('click');
    await flushPromises();
    const confirm = document.querySelector<HTMLElement>(
      '[data-testid="own-source-confirm-confirm"]',
    );
    expect(document.body.textContent).toContain('Stop scraping this endpoint?');
    confirm?.click();
    await flushPromises();
    wrapper.unmount();
  });

  it('finds endpoints and adds one with a click', async () => {
    const found = {
      id: 'p1',
      done: true,
      asked: 2,
      found: [
        {
          series: 42,
          names: ['orders_created_total', 'jobs_waiting'],
          add: {
            kind: 'pod',
            namespace: 'shop',
            workloadKind: 'Deployment',
            workload: 'cart',
            port: 9102,
          },
        },
      ],
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { wrapper, calls } = await mountAt(YourMetricsAddPage, '/your-metrics/add', {
      [`GET ${base}`]: { status: 200, body: summary() },
      [`POST ${base}/find`]: { status: 202, body: { id: 'p1', done: false, asked: 2, found: [] } },
      [`GET ${base}/find`]: { status: 200, body: found },
      [`POST ${base}/sources`]: { status: 201, body: { id: 's3' } },
    });
    await wrapper.get('[data-testid="own-find-start"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="own-find-state"]').text()).toBe('Trying 2 ports…');
    await vi.advanceTimersByTimeAsync(2100);
    await flushPromises();
    expect(wrapper.get('[data-testid="own-find-state"]').text()).toBe(
      '1 endpoint with metrics, of 2 tried.',
    );
    const row = wrapper.get('[data-testid="own-found"]');
    expect(row.text()).toContain('shop/cart :9102');
    expect(row.text()).toContain('42 series · orders_created_total, jobs_waiting');
    await row.get('[data-testid="own-found-add"]').trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/sources'))!.body).toEqual({
      namespace: 'shop',
      workloadKind: 'Deployment',
      workload: 'cart',
      port: 9102,
    });
    expect(row.text()).toContain('Added');
    vi.useRealTimers();
    wrapper.unmount();
  });
});

describe('Its own metrics, on a workload’s page', () => {
  const q = 'ownerKind=workload&owner=orders&namespace=shop&workloadKind=Deployment';
  const mountPins = async (body: object, role = 'owner', extra: Routes = {}) => {
    const m = mockFetch({ [`GET ${base}/pins?${q}`]: { status: 200, body }, ...extra });
    const plugins = await createPlugins('/');
    useAuthStore().user = { ...USER, role: role as 'owner' };
    const wrapper = mount(PinnedMetrics, {
      props: { clusterId: KUBE.id, owner: ORDERS },
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    await flushPromises();
    return { wrapper, calls: m.calls };
  };

  it('shows the pinned metrics with their value now and a way to all of them', async () => {
    const { wrapper, calls } = await mountPins(
      {
        pins: [
          {
            id: 'p1',
            metric: M_ORDERS,
            spark: [
              [1, 0.05],
              [2, 0.07],
            ],
          },
          { id: 'p2', metric: M_CHECKOUT, spark: [] },
        ],
        max: 6,
        metrics: 14,
      },
      'owner',
      { [`DELETE ${base}/pins/p1`]: { status: 204 } },
    );
    expect(wrapper.text()).toContain('Its own metrics');
    expect(wrapper.text()).toContain('Pinned here by you; at most 6 on a page.');
    const tiles = wrapper.findAll('[data-testid="own-pin-tile"]');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]!.text()).toMatch(/Orders created\s*4\.2\s+\/min\s*orders_created_total/);
    expect(tiles[1]!.text()).toMatch(/380\s+ms/);
    expect(wrapper.get('[data-testid="own-pins-all"]').text()).toBe('All 14 metrics of orders →');
    expect(wrapper.get('[data-testid="own-pins-all"]').attributes('href')).toContain(
      'q=shop/orders',
    );
    await tiles[0]!.get('[data-testid="own-pin-remove"]').trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('offers pinning when it has metrics and none is pinned; nothing when it has none', async () => {
    const offer = await mountPins({ pins: [], max: 6, metrics: 3 }, 'viewer');
    expect(offer.wrapper.text()).toContain(
      'orders reports 3 metrics of its own. Pin up to 6 here from their pages.',
    );
    const none = await mountPins({ pins: [], max: 6, metrics: 0 });
    expect(none.wrapper.find('[data-testid="own-pins"]').exists()).toBe(false);
  });
});

describe('the chart’s option', () => {
  const colors = { palette: ['c1', 'c2', 'c3'], token: (n: string) => `tok(${n})` };
  const showing = { unit: 'count' as const, shown: 'rate' as const };
  const window: [number, number] = [0, 600];

  it('one series: a smooth line with a gradient, its last point marked, no legend', () => {
    const o = ownChartOption(
      {
        lines: [
          {
            name: '',
            points: [
              [0, 0.01],
              [300, 0.05],
              [600, 0.07],
            ],
          },
        ],
        showing,
        shape: 'line',
        window,
      },
      colors,
    ) as {
      series: Record<string, unknown>[];
      legend: { show: boolean };
      yAxis: {
        splitLine: { lineStyle: { type: string } };
        axisLabel: { formatter: (v: number) => string };
      };
    };
    expect(o.series).toHaveLength(1);
    const s = o.series[0]!;
    expect(s.type).toBe('line');
    expect(s.smooth).toBeTruthy();
    expect((s.areaStyle as { color: { colorStops: unknown[] } }).color.colorStops).toHaveLength(2);
    expect((s.markPoint as { data: { coord: number[] }[] }).data[0]!.coord).toEqual([
      600_000, 0.07,
    ]);
    expect(o.legend.show).toBe(false);
    expect(o.yAxis.splitLine.lineStyle.type).toBe('dashed');
    // One scale for the whole axis: the highest point reads per minute.
    expect(o.yAxis.axisLabel.formatter(0.05)).toBe('3 /min');
  });

  it('the usual range is a soft band under a single line', () => {
    const o = ownChartOption(
      {
        lines: [
          {
            name: '',
            points: [
              [0, 4],
              [600, 5],
            ],
          },
        ],
        showing: { unit: 'count', shown: 'as_is' },
        shape: 'line',
        window,
        band: [
          [0, 3, 6],
          [600, 3.5, 5.5],
        ],
        bandName: 'usual range',
      },
      colors,
    ) as { series: { name: string; data: number[][]; stack?: string }[] };
    expect(o.series.map((s) => s.name)).toEqual(['__band_low', 'usual range', '']);
    expect(o.series[1]!.data).toEqual([
      [0, 3],
      [600_000, 2],
    ]);
    expect(o.series[0]!.stack).toBe('band');
  });

  it('a split: one line each, a legend, "other" in its muted colour; areas stack', () => {
    const lines = [
      { name: 'stripe', points: [[0, 2]] },
      { name: 'other', points: [[0, 1]], colorToken: '--text-subtle' },
    ];
    const line = ownChartOption({ lines, showing, shape: 'line', window }, colors) as {
      series: Record<string, unknown>[];
      legend: { show: boolean; data: string[] };
    };
    expect(line.legend).toMatchObject({ show: true, data: ['stripe', 'other'] });
    expect(line.series[1]!.color).toBe('tok(--text-subtle)');
    expect(line.series[0]!.areaStyle).toBeUndefined();
    expect(line.series[0]!.markPoint).toBeUndefined();
    const area = ownChartOption({ lines, showing, shape: 'area', window }, colors) as {
      series: Record<string, unknown>[];
    };
    expect(area.series.every((s) => s.stack === 'total' && s.areaStyle)).toBe(true);
  });

  it('bars are thinned to about 60, each the mean of its bucket', () => {
    const points = Array.from({ length: 240 }, (_, i) => [i, i % 2 === 0 ? 2 : 4]);
    expect(thin(points)).toHaveLength(60);
    expect(thin(points)[0]).toEqual([0, 3]);
    expect(
      thin(
        [
          [0, null],
          [1, null],
        ],
        1,
      ),
    ).toEqual([[0, null]]);
    const o = ownChartOption(
      { lines: [{ name: '', points }], showing, shape: 'bars', window },
      colors,
    ) as { series: { type: string; data: unknown[] }[] };
    expect(o.series[0]!.type).toBe('bar');
    expect(o.series[0]!.data).toHaveLength(60);
  });

  it('says in words what the chart shows', () => {
    expect(chartSummary([{ name: '', points: [[0, 0.07]] }], showing)).toBe('4.2 /min');
    expect(
      chartSummary(
        [
          { name: 'stripe', points: [[0, 2]] },
          { name: 'paypal', points: [[0, null]] },
        ],
        showing,
      ),
    ).toBe('stripe: 2 /s; paypal: –');
  });
});
