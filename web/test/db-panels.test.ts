// SPDX-License-Identifier: AGPL-3.0-only
// The database panels of 1.2 (ADR-245): the statements with "sent mostly by" and their hints
// opening a statement's page, the blocking tree with its root first, a statement's alerts
// added in one click, the flow's words between columns and table rows that open a table.
import { flushPromises, mount } from '@vue/test-utils';
import type { Panel } from '@watchlog/api-types';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouter, createWebHistory } from 'vue-router';
import { createAppI18n } from '@/i18n';
import { SERVICE_PAGE } from '@/lib/service-page';
import { useAuthStore } from '@/stores/auth';
import { mockFetch, USER } from './fetch-mock';

vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), on: vi.fn() })),
}));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
);
const { default: ServicePanel } = await import('@/components/panels/ServicePanel.vue');

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

const ID = '01a1c000-0000-7000-8000-000000000042';
const CLUSTER = '01a1c000-0000-7000-8000-000000000001';
const P = 'integrations.db.panels';
const base = { span: 2 as const, state: 'ok' as const };
const router = () =>
  createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', component: { template: '<div/>' } },
      { name: 'application', path: '/applications/:id', component: { template: '<div/>' } },
      {
        name: 'application-statement',
        path: '/applications/:id/statements/:statement',
        component: { template: '<div/>' },
      },
      {
        name: 'application-table',
        path: '/applications/:id/tables/:db/:table',
        component: { template: '<div/>' },
      },
      { name: 'workloads', path: '/workloads', component: { template: '<div/>' } },
    ],
  });

async function mountPanel(panel: Panel) {
  setActivePinia(createPinia());
  const r = router();
  await r.push('/');
  return mount(ServicePanel, {
    props: { panel, window: [0, 3600] as [number, number] },
    global: {
      plugins: [createAppI18n(), r],
      provide: { [SERVICE_PAGE as symbol]: { appId: ID, clusterId: CLUSTER } },
    },
    attachTo: document.body,
  });
}

describe('the statements panel', () => {
  it('opens a statement, says who sends it, and gives the hint under the text', async () => {
    const w = await mountPanel({
      ...base,
      id: 'slowest',
      title: `${P}.costly.title`,
      kind: 'statements',
      shareOf: 'time',
      full: false,
      total: 50,
      rows: [
        {
          id: '-5253',
          text: 'UPDATE stock SET qty = qty - $1 WHERE sku = $2',
          calls: 310,
          mean: 1.9,
          usual: 0.004,
          rows: 1,
          share: 0.61,
          sentBy: {
            name: 'shop/checkout',
            share: 0.9,
            link: { kind: 'workload', id: 'shop/Deployment/checkout', name: 'shop/checkout' },
          },
          hint: { key: `${P}.hint.slower`, values: { x: 475 } },
          severity: 'warning',
        },
        {
          id: '-8944',
          text: 'select count(*) from shop.events where created_at > $1',
          calls: 0.5,
          mean: 0.013,
          usual: 0.013,
          rows: 1,
          share: 0.04,
          sentBy: null,
          hint: { key: `${P}.hint.index`, values: { table: 'shop.events' } },
          severity: 'info',
        },
      ],
    });
    const rows = w.findAll('[data-testid="statement-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.get('[data-testid="statement-link"]').attributes('href')).toBe(
      `/applications/${ID}/statements/-5253`,
    );
    expect(rows[0]!.text()).toContain('475× slower than usual');
    expect(rows[0]!.text()).toContain('1.9 s ↑');
    expect(rows[0]!.text()).toContain('61%');
    expect(rows[0]!.text()).toContain('shop/checkout');
    expect(rows[1]!.text()).toContain('probably missing an index on shop.events');
    // Nobody clearly sends it: a dash, never a guess.
    expect(rows[1]!.findAll('td').at(-1)!.text()).toBe('–');
    expect(w.get('[data-testid="statements-all"]').text()).toBe('All 50 statements →');
  });
});

describe('the blocking tree', () => {
  it('shows the root blocker first and the blocked under it, indented', async () => {
    const w = await mountPanel({
      ...base,
      id: 'tree',
      title: `${P}.tree.title`,
      kind: 'tree',
      nodes: [
        {
          id: '75',
          depth: 0,
          name: 'shop/inventory',
          link: { kind: 'workload', id: 'shop/Deployment/inventory', name: 'shop/inventory' },
          state: { key: `${P}.tree.idleHolds`, values: { wait: null } },
          seconds: 240,
          xact: 240,
          query: 'update shop.stock set qty = qty where sku = $1',
          severity: 'critical',
        },
        {
          id: '72',
          depth: 1,
          name: 'shop/checkout',
          state: { key: `${P}.tree.waits`, values: { wait: 'Lock transactionid' } },
          seconds: 20,
          xact: 20,
          query: null,
        },
      ],
    });
    const nodes = w.findAll('[data-testid="tree-node"]');
    expect(nodes.map((n) => n.attributes('aria-level'))).toEqual(['1', '2']);
    expect(nodes[0]!.text()).toContain('shop/inventory');
    expect(nodes[0]!.text()).toContain('idle in a transaction, holds the lock');
    expect(nodes[0]!.text()).toContain('update shop.stock');
    expect(nodes[1]!.text()).toContain('waits on a lock');
    expect(nodes[1]!.attributes('style')).toContain('padding-left: 1.5rem');
  });
});

describe("a statement's alerts", () => {
  it('adds a rule scoped to the service and the statement in one click', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/alert-channels': { status: 200, body: { channels: [{ id: 'c1' }] } },
      'POST /api/v1/alert-rules': { status: 201, body: { rule: { id: 'r1' } } },
    });
    const w = await mountPanel({
      ...base,
      id: 'alerts',
      title: `${P}.alerts.statement`,
      kind: 'scoped_alerts',
      scope: { statement: '-5253' },
      rules: [],
      presets: [
        {
          key: 'slower',
          nameKey: `${P}.presets.slower`,
          metric: 'postgres.statement.slower',
          op: '>',
          value: 3,
          forSeconds: 600,
          severity: 'warning',
        },
      ],
    });
    useAuthStore().user = USER as never;
    await flushPromises();
    await w.get('[data-testid="scoped-alert-slower"]').trigger('click');
    await flushPromises();
    const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/alert-rules'));
    expect(post?.body).toMatchObject({
      metric: 'postgres.statement.slower',
      scope: { service: ID, statement: '-5253' },
      condition: { op: '>', value: 3 },
      channelIds: ['c1'],
    });
  });
});

describe('the flow and table rows', () => {
  it("writes the flow's words between columns and opens a table from its row", async () => {
    const flow = await mountPanel({
      ...base,
      id: 'flow',
      title: `${P}.flow.title`,
      kind: 'flow',
      columns: [
        {
          id: 'clients',
          title: { key: `${P}.flow.clients`, values: { n: 7 } },
          value: 86,
          unit: 'count',
          valueKey: `${P}.flow.connections`,
          rows: [],
          nextText: { key: `${P}.flow.ofMax`, values: { n: 86, max: 200 } },
        },
        {
          id: 'queries',
          title: { key: `${P}.flow.queries` },
          value: 1420,
          unit: 'per_second',
          valueKey: `${P}.flow.txPerSecond`,
          rows: [],
        },
        {
          id: 'innodb',
          title: { key: `${P}.flow.innodb` },
          value: 0.99,
          unit: 'ratio',
          rows: [
            {
              name: '',
              nameKey: `${P}.flow.largestTable`,
              value: null,
              unit: 'bytes',
              text: { key: `${P}.flow.tableSize`, values: { table: 'orders', size: '38 GiB' } },
              link: { kind: 'table', id: 'shop/orders', name: 'shop.orders' },
            },
          ],
        },
      ],
    });
    expect(flow.text()).toContain('86 of 200');
    // A database's own word for its rate, never RabbitMQ's messages.
    expect(flow.text()).toContain('1,420tx/s');
    // A labelled row: its label, then its words opening the table's page.
    const row = flow.findAll('[data-testid="flow-row"]').at(-1)!;
    expect(row.text()).toBe('largest tableorders · 38 GiB');
    expect(row.get('a').attributes('href')).toBe(`/applications/${ID}/tables/shop/orders`);
    const table = await mountPanel({
      ...base,
      id: 'growing',
      title: `${P}.tables.growing`,
      kind: 'table',
      columns: [`${P}.cols.table`, `${P}.cols.perDay`],
      rows: [
        {
          cells: ['public.orders', '1.2 GiB'],
          link: { kind: 'table', id: 'shop/public.orders', name: 'shop: public.orders' },
        },
      ],
    });
    expect(table.get('a').attributes('href')).toBe(`/applications/${ID}/tables/shop/public.orders`);
    // A clock column: unix seconds as the viewer's time of day.
    const at = new Date();
    at.setHours(13, 55, 0, 0);
    const clients = await mountPanel({
      ...base,
      id: 'clients',
      title: `${P}.clients.title`,
      kind: 'table',
      columns: [`${P}.cols.client`, `${P}.cols.since`],
      clock: [1],
      rows: [{ cells: ['report', Math.floor(at.getTime() / 1000)] }, { cells: ['web', null] }],
    });
    const cells = clients.findAll('td').map((c) => c.text());
    expect(cells[1]).toMatch(/13:55|1:55/);
    expect(cells[3]).toBe('–');
  });
});
