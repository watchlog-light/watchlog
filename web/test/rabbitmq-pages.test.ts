// SPDX-License-Identifier: AGPL-3.0-only
// RabbitMQ's page in 1.1.0 (ADR-243): the message flow, the health checks, the queue table
// (sort, search, "no consumers", drains in, each name opening the queue's page), the clients
// with their "Mostly" guess, the nodes against their limits, the timeline, the cause and the
// queue's alerts; the page's tab counts, its alerts tab and the finding's links; and the
// queue's own page at its stable address.
import { flushPromises, mount } from '@vue/test-utils';
import type { Panel } from '@watchlog/api-types';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouter, createWebHistory } from 'vue-router';
import { createAppI18n } from '@/i18n';
import { SERVICE_PAGE } from '@/lib/service-page';
import { formatDuration } from '@/lib/units';
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
const { default: ApplicationQueuePage } = await import('@/views/ApplicationQueuePage.vue');

afterEach(() => {
  document.body.innerHTML = '';
});

const ID = '01a1c000-0000-7000-8000-000000000042';
const CLUSTER = '01a1c000-0000-7000-8000-000000000001';
const P = 'integrations.rabbitmq.panels';
const base = { span: 2 as const, state: 'ok' as const };
const router = () =>
  createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', component: { template: '<div/>' } },
      { name: 'application', path: '/applications/:id', component: { template: '<div/>' } },
      {
        name: 'application-queue',
        path: '/applications/:id/queues/:queue',
        component: { template: '<div/>' },
      },
      { name: 'workloads', path: '/workloads', component: { template: '<div/>' } },
      { name: 'docker-container', path: '/c/:host/:name', component: { template: '<div/>' } },
      { name: 'containers', path: '/containers', component: { template: '<div/>' } },
      { name: 'server', path: '/servers/:server', component: { template: '<div/>' } },
    ],
  });

async function mountPanel(panel: Panel, at = '/') {
  setActivePinia(createPinia());
  const r = router();
  await r.push(at);
  return mount(ServicePanel, {
    props: { panel, window: [0, 3600] as [number, number] },
    global: {
      plugins: [createAppI18n(), r],
      provide: { [SERVICE_PAGE as symbol]: { appId: ID, clusterId: CLUSTER } },
    },
    attachTo: document.body,
  });
}

const row = (name: string, over: object = {}) => ({
  vhost: '/',
  queue: name,
  name,
  type: 'classic' as const,
  ready: 10,
  unacked: 0,
  in: 1,
  out: 1,
  consumers: 1,
  busy: 0.5,
  drain: { state: 'growing' as const },
  ...over,
});
const QUEUES: Panel = {
  ...base,
  id: 'queues',
  title: `${P}.allQueues`,
  kind: 'queues',
  full: true,
  total: 4,
  rows: [
    row('orders.payments', {
      type: 'quorum',
      ready: 18_420,
      in: 310,
      out: 0,
      consumers: 0,
      busy: null,
      drain: { state: 'never' },
      severity: 'critical',
    }),
    row('emails.send', {
      ready: 1120,
      in: 318,
      out: 315,
      consumers: 2,
      busy: 0.98,
      severity: 'warning',
    }),
    row('orders.created', {
      type: 'quorum',
      ready: 140,
      in: 600,
      out: 610,
      consumers: 6,
      busy: 0.71,
      drain: { state: 'eta', seconds: 14 },
    }),
    row('audit.events', { type: 'stream', ready: 5000, consumers: 0, drain: { state: 'stream' } }),
  ],
};

describe('the queue table', () => {
  it('sorts, searches, filters "no consumers" and says how long each queue takes to drain', async () => {
    const w = await mountPanel(QUEUES);
    const names = () =>
      w.findAll('[data-testid="queue-row"]').map((r) => r.attributes('data-queue'));
    // The worst first, as the server sent them.
    expect(names()).toEqual(['orders.payments', 'emails.send', 'orders.created', 'audit.events']);
    const first = w.get('[data-queue="orders.payments"]').text();
    expect(first).toContain('18,420');
    expect(first).toContain('never');
    expect(first).toContain('Critical:');
    expect(w.get('[data-queue="orders.created"]').text()).toContain('14 s');
    expect(w.get('[data-queue="emails.send"]').text()).toContain('98% busy');
    // A stream keeps what it holds: no "never", and no red zero.
    expect(w.get('[data-queue="audit.events"]').text()).not.toContain('never');
    // Sort by ready, both ways.
    await w.get('[data-testid="sort-ready"]').trigger('click');
    expect(names()[0]).toBe('orders.payments');
    await w.get('[data-testid="sort-ready"]').trigger('click');
    expect(names()[0]).toBe('orders.created');
    expect(w.get('th[aria-sort="ascending"]').text()).toContain('Ready');
    // No consumers: a stream isn't one.
    await w.get('[data-testid="queues-no-consumers"]').setValue(true);
    expect(names()).toEqual(['orders.payments']);
    await w.get('[data-testid="queues-no-consumers"]').setValue(false);
    await w.get('[data-testid="queues-search"] input').setValue('orders');
    expect(names()).toEqual(['orders.created', 'orders.payments']);
    await w.get('[data-testid="queues-search"] input').setValue('nothing');
    expect(w.get('[data-testid="queues-none"]').text()).toBe('No queue matches.');
    // Each name opens the queue's page; outside the default vhost with ?vhost=.
    await w.get('[data-testid="queues-search"] input').setValue('');
    expect(w.get('[data-queue="orders.payments"] a').attributes('href')).toBe(
      `/applications/${ID}/queues/orders.payments`,
    );
  });

  it('opens filtered from a failed check, and the short list links to the whole table', async () => {
    const w = await mountPanel(QUEUES, `/applications/${ID}?tab=queues&filter=no_consumers`);
    expect(w.findAll('[data-testid="queue-row"]')).toHaveLength(1);
    const short = await mountPanel({
      ...QUEUES,
      full: false,
      rows: QUEUES.kind === 'queues' ? QUEUES.rows.slice(0, 2) : [],
    });
    expect(short.find('[data-testid="queues-search"]').exists()).toBe(false);
    expect(short.get('[data-testid="queues-all"]').text()).toBe('All 4 queues →');
    expect(short.get('[data-testid="queues-all"]').attributes('href')).toBe(
      `/applications/${ID}?tab=queues`,
    );
  });

  it('a queue outside the default vhost keeps its vhost in its address', async () => {
    const w = await mountPanel({
      ...QUEUES,
      rows: [row('billing/invoices', { vhost: 'billing', queue: 'invoices' })],
    });
    expect(w.get('[data-testid="queue-row"] a').attributes('href')).toBe(
      `/applications/${ID}/queues/invoices?vhost=billing`,
    );
  });
});

describe('the Overview panels', () => {
  it('draws the message flow with the queue nobody consumes and the consumer that is gone', async () => {
    const at = Math.floor(Date.now() / 1000) - 600;
    const w = await mountPanel({
      ...base,
      id: 'flow',
      title: `${P}.flow.title`,
      kind: 'flow',
      columns: [
        {
          id: 'publishers',
          title: { key: `${P}.flow.publishers`, values: { n: 2 } },
          value: 1240,
          unit: 'per_second',
          rows: [
            {
              name: 'shop/checkout-api',
              value: 1_800_000,
              unit: 'bytes_per_second',
              link: { kind: 'workload', id: 'shop/Deployment/checkout-api', name: 'checkout-api' },
            },
          ],
          next: 1240,
        },
        {
          id: 'exchanges',
          title: { key: `${P}.flow.exchanges`, values: { n: 2 } },
          value: 1240,
          unit: 'per_second',
          valueKey: `${P}.flow.in`,
          rows: [
            { name: 'orders (topic)', value: 910, unit: 'per_second' },
            {
              name: '',
              nameKey: `${P}.flow.unroutable`,
              value: 2,
              unit: 'per_second',
              severity: 'warning',
            },
          ],
          next: 1238,
        },
        {
          id: 'queues',
          title: { key: `${P}.flow.queues`, values: { n: 42 } },
          value: 19_870,
          unit: 'count',
          valueKey: `${P}.flow.ready`,
          severity: 'critical',
          rows: [
            {
              name: 'orders.payments',
              value: 18_420,
              unit: 'count',
              severity: 'critical',
              link: {
                kind: 'queue',
                vhost: '/',
                queue: 'orders.payments',
                name: 'orders.payments',
              },
            },
          ],
          next: 925,
        },
        {
          id: 'consumers',
          title: { key: `${P}.flow.consumers`, values: { n: 1 } },
          value: 925,
          unit: 'per_second',
          rows: [
            {
              name: 'shop/payments-worker',
              value: null,
              unit: 'count',
              text: { key: `${P}.flow.gone`, values: { at } },
              severity: 'critical',
            },
          ],
        },
      ],
    });
    expect(w.get('[data-testid="flow-publishers"]').text()).toContain('Publishers · 2 services');
    expect(w.get('[data-testid="flow-exchanges"]').text()).toContain('unroutable');
    const queues = w.get('[data-testid="flow-queues"]');
    expect(queues.classes()).toContain('border-critical/50');
    expect(queues.get('a').attributes('href')).toBe(`/applications/${ID}/queues/orders.payments`);
    expect(w.get('[data-testid="flow-consumers"]').text()).toMatch(/gone \d\d:\d\d \(10 min ago\)/);
    expect(w.text()).toContain('1238/s');
  });

  it('counts the checks that pass, and links the failed one', async () => {
    const w = await mountPanel({
      ...base,
      span: 1,
      id: 'checks',
      title: `${P}.checks.title`,
      kind: 'checks',
      items: [
        {
          id: 'consumers',
          labelKey: `${P}.checks.consumers`,
          state: 'fail',
          value: { key: `${P}.checks.queuesN`, values: { n: 1 } },
          link: { kind: 'tab', tab: 'queues', filter: 'no_consumers', name: 'orders' },
        },
        {
          id: 'memory',
          labelKey: `${P}.checks.memory`,
          state: 'pass',
          value: { key: `${P}.checks.ofLimit`, values: { pct: 61 } },
        },
        {
          id: 'unroutable',
          labelKey: `${P}.checks.unroutable`,
          state: 'warn',
          value: { key: `${P}.checks.perSecond`, values: { n: 2 } },
        },
      ],
    });
    expect(w.get('[data-testid="checks-summary"]').text()).toBe('1 of 3 pass');
    const failed = w.get('[data-testid="check-consumers"]');
    expect(failed.text()).toContain('1 queue');
    expect(failed.get('a').attributes('href')).toBe(
      `/applications/${ID}?tab=queues&filter=no_consumers`,
    );
    expect(w.get('[data-testid="check-memory"]').find('a').exists()).toBe(false);
    expect(w.get('[data-testid="check-memory"]').text()).toContain('61% of the watermark');
  });

  it('marks what happened on a chart, and draws the usual band', async () => {
    setOption.mockClear();
    await mountPanel({
      ...base,
      id: 'depth',
      title: `${P}.depth`,
      kind: 'line',
      unit: 'count',
      markers: [{ at: 1000, text: { key: `${P}.markerLost` }, severity: 'critical' }],
      band: {
        low: [
          [0, 1],
          [3600, 1],
        ],
        high: [
          [0, 5],
          [3600, 5],
        ],
      },
      series: [
        {
          nameKey: `${P}.series.ready`,
          points: [
            [0, 2],
            [3600, 90],
          ],
        },
      ],
    });
    const opt = setOption.mock.calls.at(-1)![0];
    expect(opt.series[0].markLine.data[0]).toMatchObject({
      xAxis: 1_000_000,
      name: 'last consumer gone',
    });
    expect(opt.series.map((s: { name: string }) => s.name)).toEqual([
      'Ready',
      '\u0000band-low',
      'usual range',
    ]);
    expect(opt.series[2].data[0]).toEqual([0, 4]);
    expect(opt.legend.data).toEqual(['Ready', 'usual range']);
  });
});

describe('Clients and Nodes', () => {
  it('says "Mostly" only when the traffic says so, and how a client ended', async () => {
    const w = await mountPanel({
      ...base,
      id: 'clients',
      title: `${P}.clients`,
      kind: 'clients',
      rows: [
        {
          name: 'shop/payments-worker',
          link: {
            kind: 'workload',
            id: 'shop/Deployment/payments-worker',
            name: 'payments-worker',
          },
          where: { key: 'whereWorkload', values: { namespace: 'shop', kind: 'Deployment' } },
          connections: 3,
          sends: null,
          receives: null,
          mostly: 'consumes',
          state: {
            key: 'ended',
            values: { how: 'OOMKilled', at: Math.floor(Date.now() / 1000) - 120 },
          },
          severity: 'critical',
        },
        {
          name: 'shop-report-1',
          link: { kind: 'container', id: 'web-01/shop-report-1', name: 'shop-report-1' },
          where: { key: 'whereContainer', values: { project: 'shop' } },
          connections: 1,
          sends: 4000,
          receives: 2000,
          mostly: null,
          state: { key: 'running' },
        },
      ],
    });
    const rows = w.findAll('[data-testid="client-row"]');
    expect(rows[0]!.text()).toMatch(/OOMKilled, \d\d:\d\d \(2 min ago\)/);
    expect(rows[0]!.find('[data-testid="mostly-consumes"]').text()).toBe('consumes');
    expect(rows[0]!.text()).toContain('shop · Deployment');
    expect(rows[1]!.find('[data-testid^="mostly-"]').exists()).toBe(false);
    expect(rows[1]!.get('a').attributes('href')).toBe(`/c/web-01/shop-report-1?cluster=${CLUSTER}`);
    expect(rows[0]!.get('a').attributes('href')).toContain('wname=payments-worker');
  });

  it('shows each node against its limits, and why one is down', async () => {
    const w = await mountPanel({
      ...base,
      id: 'nodes',
      title: `${P}.nodes`,
      kind: 'nodes',
      items: [
        {
          name: 'rabbitmq-0',
          version: '3.13.7',
          uptime: 41 * 86400,
          connections: 9,
          leaders: null,
          limits: [
            {
              labelKey: `${P}.limit.memory`,
              value: 1.1 * 2 ** 30,
              max: 3.2 * 2 ** 30,
              unit: 'bytes',
            },
          ],
        },
        {
          name: 'rabbitmq-1',
          version: null,
          uptime: null,
          connections: null,
          leaders: null,
          down: 'connection refused',
          severity: 'critical',
          limits: [],
        },
      ],
    });
    const nodes = w.findAll('[data-testid="node"]');
    expect(nodes[0]!.text()).toContain('3.13.7');
    expect(nodes[0]!.text()).toContain('41 d');
    expect(nodes[0]!.text()).toContain('Memory of the high watermark');
    expect(nodes[1]!.get('[data-testid="node-down"]').text()).toBe(
      "Doesn't answer: connection refused",
    );
    expect(formatDuration(9600)).toBe('2 h 40 min');
  });
});

describe('the queue page', () => {
  it('is at its own address, with its timeline, cause and alerts; a preset adds a scoped rule', async () => {
    const at = Math.floor(Date.now() / 1000) - 1800;
    const panels: Panel[] = [
      {
        ...base,
        id: 'summary',
        title: `${P}.summary`,
        kind: 'stat',
        tiles: [
          {
            id: 'drain',
            labelKey: `${P}.fillsMemory`,
            value: 9600,
            unit: 'seconds',
            sub: { key: `${P}.atThisRate` },
            severity: 'warning',
          },
        ],
      },
      {
        ...base,
        span: 1,
        id: 'timeline',
        title: `${P}.whatHappened`,
        kind: 'timeline',
        events: [
          {
            at,
            text: {
              key: `${P}.event.ended`,
              values: { name: 'shop/payments-worker', how: 'OOMKilled' },
            },
            sourceKey: `${P}.source.kubernetes`,
            severity: 'critical',
            link: {
              kind: 'workload',
              id: 'shop/Deployment/payments-worker',
              name: 'shop/payments-worker',
            },
          },
          {
            at: at + 1,
            text: { key: `${P}.event.consumers`, values: { from: 3, to: 0 } },
            sourceKey: `${P}.source.rabbitmq`,
            severity: 'critical',
          },
        ],
      },
      {
        ...base,
        span: 1,
        id: 'cause',
        title: `${P}.probableCause`,
        kind: 'cause',
        text: {
          key: `${P}.causeEnded`,
          values: { name: 'shop/payments-worker', how: 'OOMKilled', at },
        },
        caveat: { key: `${P}.causeCaveat` },
        links: [
          { kind: 'workload', id: 'shop/Deployment/payments-worker', name: 'shop/payments-worker' },
        ],
      },
      {
        ...base,
        span: 1,
        id: 'facts',
        title: `${P}.thisQueue`,
        kind: 'facts',
        rows: [
          { labelKey: `${P}.fact.type`, value: 'quorum' },
          { labelKey: `${P}.fact.leader`, value: 'rabbitmq-1' },
          { labelKey: `${P}.fact.onDisk`, value: 41 * 2 ** 20, unit: 'bytes' },
        ],
      },
      {
        ...base,
        id: 'alerts',
        title: `${P}.queueAlerts.title`,
        kind: 'queue_alerts',
        vhost: '/',
        queue: 'orders.payments',
        rules: [{ id: 'r1', name: 'orders.payments: Ready above 5,000', state: 'firing' }],
        presets: [
          {
            key: 'unconsumed',
            nameKey: `${P}.queueAlerts.unconsumed`,
            metric: 'rabbitmq.queue.unconsumed',
            op: '>',
            value: 0,
            forSeconds: 300,
            severity: 'critical',
          },
          {
            key: 'depth',
            nameKey: `${P}.queueAlerts.depth`,
            metric: 'rabbitmq.queue.ready',
            op: '>',
            value: 5000,
            forSeconds: 300,
            severity: 'warning',
          },
        ],
      },
    ];
    const { calls } = mockFetch({
      [`GET /api/v1/applications/${ID}?range=3600`]: {
        status: 200,
        body: {
          application: {
            id: ID,
            type: 'rabbitmq',
            name: 'shop/rabbitmq',
            health: 'critical',
            cluster: { id: CLUSTER, name: 'prod', kind: 'kubernetes' },
            target: {
              kind: 'workload',
              namespace: 'shop',
              workload_kind: 'StatefulSet',
              workload: 'rabbitmq',
              port: 5672,
            },
            where: { group: 'shop' },
            reason: { code: 'connected', facts: {} },
            members: { up: 1, total: 1 },
            monitoredSince: '2026-11-01T00:00:00Z',
            lastReportAt: null,
            finding: null,
          },
          reasons: [],
          connected: null,
          page: { id: 'rabbitmq', tabs: [] },
          range: 3600,
        },
      },
      [`GET /api/v1/applications/${ID}/panels?tab=queue&queue=orders.payments&vhost=%2F&range=3600`]:
        {
          status: 200,
          body: { tab: 'queue', range: 3600, panels },
        },
      'GET /api/v1/alert-channels': { status: 200, body: { channels: [{ id: 'ch1' }] } },
      'POST /api/v1/alert-rules': { status: 201, body: { id: 'r2' } },
    });
    const plugins = await createPlugins(`/applications/${ID}/queues/orders.payments`);
    useAuthStore().user = USER;
    const w = mount(ApplicationQueuePage, {
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
      attachTo: document.body,
    });
    await flushPromises();
    expect(w.get('[data-testid="queue-name"]').text()).toBe('orders.payments');
    expect(w.text()).toContain('quorum');
    expect(w.text()).toContain('leader rabbitmq-1');
    expect(w.get('[data-tile="drain"]').text()).toContain('2 h 40 min');
    const events = w.findAll('[data-testid="timeline-event"]');
    expect(events[0]!.text()).toContain('shop/payments-worker OOMKilled');
    expect(events[0]!.text()).toContain('Kubernetes');
    expect(events[1]!.text()).toContain('Consumers on this queue: 3 → 0');
    expect(w.get('[data-testid="cause-text"]').text()).toMatch(
      /shop\/payments-worker was connected to this broker and was OOMKilled at \d\d:\d\d/,
    );
    expect(w.text()).toContain("RabbitMQ doesn't say which client consumed which queue.");
    expect(w.text()).toContain('41 MiB');
    expect(w.get('[data-testid="queue-rule"]').text()).toContain('Firing');
    await w.get('[data-testid="queue-alert-unconsumed"]').trigger('click');
    await flushPromises();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/alert-rules');
    expect(post?.body).toMatchObject({
      name: 'orders.payments: Grows with no consumers, 5 min',
      metric: 'rabbitmq.queue.unconsumed',
      clusterId: CLUSTER,
      scope: { service: ID, queue: { vhost: '/', name: 'orders.payments' } },
      condition: { op: '>', value: 0 },
      channelIds: ['ch1'],
    });
    expect(w.get('[data-testid="queue-back"]').attributes('href')).toBe(
      `/applications/${ID}?tab=queues`,
    );
    w.unmount();
  });
});

describe('the RabbitMQ page itself', () => {
  it('counts its tabs, shows its alerts in their tab, and links the finding to the queue', async () => {
    mockFetch({
      [`GET /api/v1/applications/${ID}?range=3600`]: {
        status: 200,
        body: {
          application: {
            id: ID,
            type: 'rabbitmq',
            name: 'shop/rabbitmq',
            health: 'critical',
            cluster: { id: CLUSTER, name: 'prod', kind: 'kubernetes' },
            target: {
              kind: 'workload',
              namespace: 'shop',
              workload_kind: 'StatefulSet',
              workload: 'rabbitmq',
              port: 5672,
            },
            where: { group: 'shop' },
            reason: { code: 'connected', facts: {} },
            members: { up: 1, total: 1 },
            monitoredSince: '2026-11-01T00:00:00Z',
            lastReportAt: null,
            finding: null,
          },
          reasons: [
            {
              severity: 'critical',
              code: 'queue_no_consumers',
              facts: {
                queue: 'orders.payments',
                vhost: '/',
                queueRaw: 'orders.payments',
                queues: 1,
                ready: 18420,
                perMin: 310,
                since: '2 min ago',
                sinceAt: Math.floor(Date.now() / 1000) - 120,
                consumer: 'shop/payments-worker',
                how: 'OOMKilled',
                when: '2 min ago',
                watermarkIn: 9600,
              },
              links: [
                {
                  kind: 'workload',
                  id: 'shop/Deployment/payments-worker',
                  name: 'shop/payments-worker',
                },
              ],
            },
          ],
          connected: null,
          page: {
            id: 'rabbitmq',
            tabs: [
              { id: 'overview', title: 'integrations.rabbitmq.tabs.overview' },
              { id: 'queues', title: 'integrations.rabbitmq.tabs.queues', count: 42 },
              { id: 'clients', title: 'integrations.rabbitmq.tabs.clients' },
              { id: 'nodes', title: 'integrations.rabbitmq.tabs.nodes', count: 3 },
              { id: 'alerts', title: 'integrations.rabbitmq.tabs.alerts', view: 'alerts' },
            ],
          },
          range: 3600,
        },
      },
      [`GET /api/v1/applications/${ID}/panels?tab=overview&range=3600`]: {
        status: 200,
        body: { tab: 'overview', range: 3600, panels: [] },
      },
      [`GET /api/v1/applications/${ID}/panels?tab=alerts&range=3600`]: {
        status: 200,
        body: { tab: 'alerts', range: 3600, panels: [] },
      },
      'GET /api/v1/alert-rules': { status: 200, body: { rules: [] } },
      'GET /api/v1/alert-channels': { status: 200, body: { channels: [] } },
      'GET /api/v1/clusters': { status: 200, body: { clusters: [] } },
    });
    const plugins = await createPlugins(`/applications/${ID}`);
    useAuthStore().user = USER;
    const w = mount(ApplicationPage, {
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
      attachTo: document.body,
    });
    await flushPromises();
    const tabs = w.findAll('[data-testid="tab"]').map((t) => t.text().replace(/\s+/g, ' '));
    expect(tabs).toEqual(['Overview', 'Queues · 42', 'Clients', 'Nodes · 3', 'Alerts']);
    const reason = w.get('[data-testid="reason"]').text();
    expect(reason).toContain('At this rate memory reaches the high watermark in about 2 h 40 min.');
    const links = w.findAll('[data-testid="reason-link"]');
    expect(links.map((l) => l.text())).toEqual(['Open the queue', 'Open shop/payments-worker']);
    expect(links[0]!.attributes('href')).toBe(`/applications/${ID}/queues/orders.payments`);
    // The alerts live in their tab: not under the panels too.
    expect(w.findAll('[data-testid="service-alerts"]')).toHaveLength(0);
    await plugins.router.push(`/applications/${ID}?tab=alerts`);
    await flushPromises();
    expect(w.find('[data-testid="alerts-tab"] [data-testid="service-alerts"]').exists()).toBe(true);
    w.unmount();
  });
});
