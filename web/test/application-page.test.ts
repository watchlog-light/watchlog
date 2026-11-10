// SPDX-License-Identifier: AGPL-3.0-only
// The service page (v0.3 slice 3, ADR-135): every panel kind and its states, then the
// page itself driven by a fake integration on a Kubernetes cluster and a Docker host:
// header, own time range, "What WatchLog sees", tabs, panels, who connects, the MCP hint.
import { flushPromises, mount } from '@vue/test-utils';
import type { ApplicationDetail, Application, Panel } from '@watchlog/api-types';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppI18n } from '@/i18n';
import { gaugeLevel, heatGrid } from '@/lib/panels';
import { useAuthStore } from '@/stores/auth';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const setOption = vi.fn();
vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({ setOption, resize: vi.fn(), dispose: vi.fn(), on: vi.fn() })),
}));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
);
const { default: ServicePanel } = await import('@/components/panels/ServicePanel.vue');
const { default: ApplicationPage } = await import('@/views/ApplicationPage.vue');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  document.body.innerHTML = '';
});

const NOW = 1793600000;
const pts = (vals: number[]) => vals.map((v, i) => [NOW - (vals.length - i) * 60, v]);
const base = {
  span: 1 as const,
  state: 'ok' as const,
  title: 'integrations.generic.panels.connect',
};

// A fake integration's panels: one of each kind.
const PANELS: Panel[] = [
  {
    ...base,
    id: 'tiles',
    kind: 'stat',
    span: 2,
    tiles: [
      {
        id: 'ops',
        labelKey: 'integrations.generic.panels.connectTime',
        value: 0.0021,
        unit: 'seconds',
      },
      {
        id: 'members',
        labelKey: 'integrations.generic.panels.membersUp',
        value: '1/2',
        severity: 'warning',
      },
    ],
  },
  {
    ...base,
    id: 'memory',
    kind: 'line',
    unit: 'bytes',
    series: [
      { name: 'used', points: pts([1, 2, 3]) },
      {
        nameKey: 'integrations.generic.panels.series.members',
        points: pts([4, 4, 4]),
        dashed: true,
      },
    ],
  },
  {
    ...base,
    id: 'commands',
    kind: 'stack',
    unit: 'per_second',
    series: [
      { name: 'GET', points: pts([5, 6, 7]) },
      { name: 'SET', points: pts([1, 1, 2]) },
    ],
  },
  {
    ...base,
    id: 'prefixes',
    kind: 'bars',
    unit: 'bytes',
    items: [
      { label: 'session:*', value: 2048, severity: 'warning' },
      { label: 'cart:*', value: 512 },
    ],
  },
  {
    ...base,
    id: 'latency',
    kind: 'hist',
    buckets: [
      { label: '<1ms', share: 0.7 },
      { label: '1–10ms', share: 0.25 },
      { label: '>10ms', share: 0.05 },
    ],
  },
  {
    ...base,
    id: 'capacity',
    kind: 'gauge',
    items: [
      { labelKey: 'integrations.generic.panels.connectTime', value: 900, max: 1000, unit: 'bytes' },
    ],
  },
  { ...base, id: 'busy', kind: 'heat', unit: 'per_second', points: pts([1, 2, 3]) },
  {
    ...base,
    id: 'slow',
    kind: 'table',
    columns: ['integrations.generic.panels.connect'],
    rows: [{ cells: ['SELECT 1‮'], severity: 'critical' }],
  },
  {
    ...base,
    id: 'keys',
    kind: 'bars',
    unit: 'bytes',
    items: [],
    state: 'needs_permission',
    missing: {
      key: 'applications.reason.needsPermission',
      values: { tab: 'keys', missing: '+memory|usage' },
    },
  },
  { ...base, id: 'none', kind: 'line', unit: 'count', series: [], state: 'empty' },
];

function mountPanel(panel: Panel, extra: { loading?: boolean; error?: boolean } = {}) {
  setActivePinia(createPinia());
  return mount(ServicePanel, {
    props: { panel, window: [NOW - 3600, NOW] as [number, number], ...extra },
    global: { plugins: [createAppI18n()] },
  });
}

describe('panels', () => {
  it('draws each kind', () => {
    const stat = mountPanel(PANELS[0]!);
    expect(stat.get('[data-tile="ops"]').text()).toContain('2.1 ms');
    expect(stat.get('[data-tile="members"]').classes()).toContain('border-warning/50');

    setOption.mockClear();
    mountPanel(PANELS[1]!);
    const line = setOption.mock.calls.at(-1)![0];
    expect(line.series.map((s: { name: string }) => s.name)).toEqual(['used', 'Members']);
    expect(line.series[1].lineStyle.type).toBe('dashed');
    expect(line.series[0].stack).toBeUndefined();

    mountPanel(PANELS[2]!);
    const stack = setOption.mock.calls.at(-1)![0];
    expect(stack.series.every((s: { stack?: string }) => s.stack === 'total')).toBe(true);

    const bars = mountPanel(PANELS[3]!).findAll('[data-testid="bar"]');
    expect(bars.map((b) => b.text().replace(/\s+/g, ' '))).toEqual([
      'session:*2 KiB',
      'cart:*512 B',
    ]);

    expect(mountPanel(PANELS[4]!).find('table').text()).toContain('70%');

    const gauge = mountPanel(PANELS[5]!).get('[role="meter"]');
    expect(gauge.attributes('aria-valuetext')).toBe('90% · Warning');

    expect(mountPanel(PANELS[6]!).findAll('table tr')).toHaveLength(7);

    const table = mountPanel(PANELS[7]!).get('[data-testid="table-row"]');
    expect(table.text()).toContain('Critical:');
  });

  it('says what is missing, when it is empty, loading or failed', async () => {
    const perm = mountPanel(PANELS[8]!);
    expect(perm.get('[data-testid="needs-permission"]').text()).toBe(
      "WatchLog's user can't read this yet. The keys tab needs +memory|usage.",
    );
    expect(mountPanel(PANELS[9]!).text()).toContain('No data yet in this time range.');
    const failed = mountPanel(PANELS[3]!, { error: true });
    expect(failed.get('[role="alert"]').text()).toContain("This panel couldn't be loaded.");
    await failed.get('button').trigger('click');
    expect(failed.emitted('retry')).toHaveLength(1);
    expect(
      mountPanel({ ...PANELS[3]!, state: 'empty' }, { loading: true })
        .find('[role="status"]')
        .exists(),
    ).toBe(true);
  });

  it('buckets a week by local weekday and hour, and fills gauges by their limit', () => {
    // Monday 2026-11-09 10:00 and 10:30 UTC; Tuesday 03:00.
    const mon = Date.UTC(2026, 10, 9, 10) / 1000;
    const g = heatGrid(
      [
        [mon, 2],
        [mon + 1800, 4],
        [mon + 17 * 3600, 9],
        [mon + 3600, null],
      ],
      'UTC',
    );
    expect(g.cells[0]![10]).toBe(3);
    expect(g.cells[1]![3]).toBe(9);
    expect(g.cells[0]![11]).toBeNull();
    expect(g.max).toBe(9);
    expect(gaugeLevel(50, 100)).toEqual({ share: 0.5, severity: 'ok' });
    expect(gaugeLevel(85, 100).severity).toBe('warning');
    expect(gaugeLevel(120, 100)).toEqual({ share: 1, severity: 'critical' });
  });
});

const K8S = {
  id: '01a1c000-0000-7000-8000-000000000001',
  name: 'prod-eu',
  kind: 'kubernetes' as const,
};
const DOCKER = {
  id: '01a1c000-0000-7000-8000-000000000002',
  name: 'docker-01',
  kind: 'docker' as const,
};
const ID = '01a1c000-0000-7000-8000-0000000000aa';

function detail(
  over: Partial<Application>,
  extra: Partial<ApplicationDetail> = {},
): ApplicationDetail {
  return {
    application: {
      id: ID,
      type: 'redis',
      name: 'shop/redis',
      version: '7.2.5',
      product: null,
      cluster: K8S,
      where: { group: 'shop', host: null, address: null },
      target: {
        kind: 'workload',
        namespace: 'shop',
        workload_kind: 'StatefulSet',
        workload: 'redis',
        port: 6379,
      },
      health: 'warning',
      reason: { code: 'connected', facts: { up: 1, members: 2 } },
      members: { up: 1, total: 2 },
      monitoredSince: '2026-11-09T10:00:00.000Z',
      lastReportAt: '2026-11-09T10:01:00.000Z',
      ...over,
    },
    reasons: [
      { severity: 'warning', code: 'connected', facts: { up: 1, members: 2 } },
      {
        severity: 'warning',
        code: 'member_down',
        facts: { member: 'redis-1', error: 'i/o timeout' },
      },
    ],
    connected: {
      flows: true,
      items: [
        {
          kind: 'workload',
          name: 'checkout',
          namespace: 'shop',
          workloadKind: 'Deployment',
          composeService: null,
          connections: 1200,
          failed: 3,
        },
      ],
    },
    page: {
      id: 'redis',
      tabs: [
        { id: 'overview', title: 'integrations.tabs.overview' },
        { id: 'keys', title: 'integrations.generic.panels.summary' },
      ],
    },
    range: 3600,
    ...extra,
  };
}

async function mountPage(path: string) {
  const plugins = await createPlugins(path);
  useAuthStore().user = USER;
  const wrapper = mount(ApplicationPage, {
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    attachTo: document.body,
  });
  await flushPromises();
  return { wrapper, router: plugins.router };
}

describe('Application page', () => {
  it('shows a Kubernetes service: header, reasons, tabs, panels, connected workloads', async () => {
    const { calls } = mockFetch({
      [`GET /api/v1/applications/${ID}?range=3600`]: { status: 200, body: detail({}) },
      [`GET /api/v1/applications/${ID}?range=86400`]: {
        status: 200,
        body: detail({}, { range: 86400 }),
      },
      [`GET /api/v1/applications/${ID}/panels?tab=overview&range=3600`]: {
        status: 200,
        body: { tab: 'overview', range: 3600, panels: PANELS.slice(0, 2) },
      },
      [`GET /api/v1/applications/${ID}/panels?tab=keys&range=3600`]: {
        status: 200,
        body: { tab: 'keys', range: 3600, panels: [PANELS[8]] },
      },
      [`GET /api/v1/applications/${ID}/panels?tab=keys&range=86400`]: {
        status: 200,
        body: { tab: 'keys', range: 86400, panels: [PANELS[8]] },
      },
    });
    const { wrapper, router } = await mountPage(`/applications/${ID}?cluster=${K8S.id}`);
    expect(wrapper.get('[data-testid="application-name"]').text()).toBe('shop/redis');
    expect(wrapper.get('[data-testid="health"]').text()).toBe('Warning');
    expect(wrapper.text()).toContain('Redis 7.2.5');
    expect(wrapper.text()).toContain('namespace shop');
    expect(
      wrapper.findAll('[data-testid="reason"]').map((r) => r.text().replace(/\s+/g, ' ')),
    ).toEqual(['Warning: 1 of 2 members answer.', "Warning: redis-1 doesn't answer: i/o timeout"]);
    expect(wrapper.get('[data-testid="open-service-map"]').attributes('href')).toBe(
      `/service-map?cluster=${K8S.id}&node=w:shop/StatefulSet/redis`,
    );
    expect(wrapper.findAll('[data-testid="tab"]').map((t) => t.text())).toEqual([
      'Overview',
      'At a glance',
    ]);
    expect(wrapper.find('[data-testid="generic-note"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="panels"] > *')).toHaveLength(2);
    expect(wrapper.get('[data-panel="tiles"]').classes()).toContain('md:col-span-2');

    const conn = wrapper.get('[data-testid="connected"]');
    expect(conn.text()).toContain('Connected workloads');
    expect(conn.get('[data-testid="connected-item"]').text().replace(/\s+/g, ' ')).toBe(
      'shop/checkout1200 connections · 3 failed',
    );
    expect(conn.get('a').attributes('href')).toContain('wname=checkout');
    expect(conn.text()).toContain('get_application');

    await wrapper.findAll('[data-testid="tab"]')[1]!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.tab).toBe('keys');
    expect(wrapper.find('[data-testid="needs-permission"]').exists()).toBe(true);

    await wrapper.findAll('[data-testid="range"]')[2]!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.range).toBe('86400');
    expect(calls.map((c) => c.path)).toContain(
      `/api/v1/applications/${ID}/panels?tab=keys&range=86400`,
    );
    wrapper.unmount();
  });

  it("shows a Docker service's host, Compose project and containers, with the generic page", async () => {
    mockFetch({
      [`GET /api/v1/applications/${ID}?range=3600`]: {
        status: 200,
        body: detail(
          {
            cluster: DOCKER,
            name: 'billing/redis',
            where: { group: 'billing', host: 'docker-01', address: null },
            target: {
              kind: 'compose',
              host: 'docker-01',
              compose_project: 'billing',
              compose_service: 'redis',
              port: 6379,
            },
            health: 'unknown',
            reason: { code: 'collector_missing', facts: { host: 'docker-01' } },
          },
          {
            reasons: [
              { severity: 'info', code: 'collector_missing', facts: { host: 'docker-01' } },
            ],
            connected: { flows: false, items: [] },
            page: {
              id: 'generic',
              tabs: [{ id: 'overview', title: 'integrations.tabs.overview' }],
            },
            collectorCommand: 'docker run -d --name watchlog-integrations …',
          },
        ),
      },
      [`GET /api/v1/applications/${ID}/panels?tab=overview&range=3600`]: {
        status: 200,
        body: { tab: 'overview', range: 3600, panels: [PANELS[9]] },
      },
    });
    const { wrapper } = await mountPage(`/applications/${ID}?cluster=${DOCKER.id}`);
    expect(wrapper.text()).toContain('on docker-01, Compose project billing');
    expect(wrapper.get('[data-testid="reason"]').text().replace(/\s+/g, ' ')).toBe(
      'Note: No integrations collector runs on docker-01 yet.',
    );
    expect(wrapper.find('[role="tablist"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="collector-command"]').text()).toContain(
      'Start the integrations collector on docker-01',
    );
    // Neutral for a type without its own words; never another type's tabs.
    expect(wrapper.get('[data-testid="generic-note"]').text()).toContain("Redis's own tabs");
    expect(wrapper.get('[data-testid="generic-note"]').text()).not.toContain('keys');
    expect(wrapper.get('[data-testid="open-service-map"]').attributes('href')).toBe(
      `/service-map?cluster=${DOCKER.id}`,
    );
    const conn = wrapper.get('[data-testid="connected"]');
    expect(conn.text()).toContain('Connected containers');
    expect(conn.text()).toContain('Network flows are off');
    wrapper.unmount();
  });

  it("gives Nginx's setup hint with its snippet, and words 5xx by what is known", async () => {
    mockFetch({
      [`GET /api/v1/applications/${ID}?range=3600`]: {
        status: 200,
        body: detail(
          {
            type: 'nginx',
            name: 'store/web',
            reason: { code: 'connected', facts: { up: 1, members: 1 } },
          },
          {
            reasons: [
              {
                severity: 'critical',
                code: 'errors_high',
                facts: { pct: 12.5, upstream: 'shop/api', upstreamPct: 80, rollout: '12 min ago' },
              },
              {
                severity: 'warning',
                code: 'errors_high',
                facts: { pct: 2, upstream: null, upstreamPct: null, rollout: null },
              },
              {
                severity: 'info',
                code: 'stub_status_missing',
                facts: { command: 'server {\n    listen 8080;\n}' },
              },
            ],
            page: {
              id: 'nginx',
              tabs: [{ id: 'overview', title: 'integrations.nginx.tabs.overview' }],
            },
          },
        ),
      },
      [`GET /api/v1/applications/${ID}/panels?tab=overview&range=3600`]: {
        status: 200,
        body: { tab: 'overview', range: 3600, panels: [PANELS[9]] },
      },
    });
    const { wrapper } = await mountPage(`/applications/${ID}?cluster=${K8S.id}`);
    const rs = wrapper.findAll('[data-testid="reason"]').map((r) => r.text().replace(/\s+/g, ' '));
    expect(rs[0]).toContain(
      '12.5% of requests answer 5xx. Most come from shop/api (80%), last rolled out 12 min ago.',
    );
    expect(rs[1]).toContain('2% of requests answer 5xx.');
    expect(rs[1]).not.toContain('null');
    expect(rs[2]).toContain('Nginx has no stub_status');
    expect(wrapper.get('[data-testid="reason-command"]').text()).toContain('listen 8080;');
    wrapper.unmount();
  });

  it('names the consumer a RabbitMQ queue lost, and how to enable its plugin', async () => {
    mockFetch({
      [`GET /api/v1/applications/${ID}?range=3600`]: {
        status: 200,
        body: detail(
          { type: 'rabbitmq', name: 'shop/rabbitmq' },
          {
            reasons: [
              {
                severity: 'critical',
                code: 'queue_no_consumers',
                facts: {
                  queue: 'orders',
                  queues: 1,
                  ready: 4200,
                  perMin: 600,
                  since: '6 min ago',
                  sinceAt: Math.floor(Date.now() / 1000) - 360,
                  consumer: 'shop/worker',
                  how: 'OOMKilled, CrashLoopBackOff',
                  when: '6 min ago',
                },
                links: [{ kind: 'workload', id: 'shop/Deployment/worker', name: 'shop/worker' }],
              },
              {
                severity: 'critical',
                code: 'queue_no_consumers',
                facts: {
                  queue: 'emails',
                  queues: 1,
                  ready: 3,
                  perMin: 1,
                  since: null,
                  consumer: null,
                  how: null,
                  when: null,
                },
              },
              {
                severity: 'info',
                code: 'prometheus_plugin_off',
                facts: {
                  n: 1,
                  command:
                    'docker exec shop-rabbitmq-2 rabbitmq-plugins enable rabbitmq_prometheus',
                },
              },
            ],
            page: {
              id: 'rabbitmq',
              tabs: [{ id: 'overview', title: 'integrations.rabbitmq.tabs.overview' }],
            },
          },
        ),
      },
      [`GET /api/v1/applications/${ID}/panels?tab=overview&range=3600`]: {
        status: 200,
        body: { tab: 'overview', range: 3600, panels: [PANELS[9]] },
      },
    });
    const { wrapper } = await mountPage(`/applications/${ID}?cluster=${K8S.id}`);
    const rs = wrapper.findAll('[data-testid="reason"]').map((r) => r.text().replace(/\s+/g, ' '));
    expect(rs[0]).toMatch(
      /orders has had no consumers since \d\d:\d\d \(6 min ago\) and grows by 600 a minute \(4200 ready\)\. shop\/worker, connected to RabbitMQ until then, was OOMKilled, CrashLoopBackOff 6 min ago\./,
    );
    expect(rs[1]).toContain(
      'No client that was connected to RabbitMQ in the last 24 hours ended in that time.',
    );
    expect(rs[1]).not.toContain('null');
    expect(wrapper.get('[data-testid="reason-command"]').text()).toContain(
      'rabbitmq-plugins enable rabbitmq_prometheus',
    );
    wrapper.unmount();
  });

  it('says a paused service is paused, by whom, and resumes it', async () => {
    const paused = detail(
      {
        health: 'unknown',
        reason: { code: 'paused', facts: { by: 'Mohammad', at: '2026-11-09T10:00:00.000Z' } },
      },
      {
        reasons: [
          {
            severity: 'info',
            code: 'paused',
            facts: { by: 'Mohammad', at: '2026-11-09T10:00:00.000Z' },
          },
        ],
      },
    );
    const { calls } = mockFetch({
      [`GET /api/v1/applications/${ID}?range=3600`]: [
        { status: 200, body: paused },
        { status: 200, body: detail({}) },
      ],
      [`GET /api/v1/applications/${ID}/panels?tab=overview&range=3600`]: {
        status: 200,
        body: { tab: 'overview', range: 3600, panels: [PANELS[9]] },
      },
      [`PATCH /api/v1/applications/${ID}`]: { status: 204 },
    });
    const { wrapper } = await mountPage(`/applications/${ID}?cluster=${K8S.id}`);
    const banner = wrapper.get('[data-testid="paused"]');
    expect(banner.text()).toContain('Monitoring is paused');
    expect(banner.text()).toContain('Paused by Mohammad on');
    await banner.get('[data-testid="resume"]').trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ paused: false });
    expect(wrapper.find('[data-testid="paused"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('says when the service is gone', async () => {
    mockFetch({
      [`GET /api/v1/applications/${ID}?range=3600`]: {
        status: 404,
        body: { type: 'about:blank', title: 'Not Found', status: 404, detail: 'Service not found' },
      },
    });
    const { wrapper } = await mountPage(`/applications/${ID}?cluster=${K8S.id}`);
    expect(wrapper.text()).toContain('Service not found');
    wrapper.unmount();
  });
});
