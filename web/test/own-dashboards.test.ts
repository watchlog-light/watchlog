// SPDX-License-Identifier: AGPL-3.0-only
// Dashboards of own metrics (1.0.0, ADR-237): the editing rules, the tab in read and edit
// mode, the widget's states, and "Add to a dashboard" from a metric.
import type { OwnDashboard, OwnMetric, OwnWidget } from '@watchlog/api-types';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownMetricsApi } from '@/api/own-metrics';
import AddToDashboard from '@/components/own-metrics/AddToDashboard.vue';
import DashboardsTab from '@/components/own-metrics/DashboardsTab.vue';
import {
  changed,
  moveBy,
  moveOnto,
  problemOf,
  ranked,
  snapWidth,
  stepWidth,
  toInput,
  widgetFor,
} from '@/lib/own-dashboard';
import { useAuthStore } from '@/stores/auth';
import { mockFetch, problem, USER, type Routes } from './fetch-mock';
import { createPlugins } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const CLUSTER = { id: '01a18f42-06e7-7078-a01a-ea39c791d700', name: 'prod' };
const metric = (name: string, over: Partial<OwnMetric> = {}): OwnMetric => ({
  id: `id-${name}`,
  name,
  words: name.replace(/_/g, ' '),
  type: 'gauge',
  detectedType: 'gauge',
  unit: 'count',
  detectedUnit: 'count',
  shown: 'as_is',
  help: '',
  hidden: false,
  labels: ['queue'],
  refused: null,
  firstSeenAt: 0,
  lastSeenAt: 0,
  series: 2,
  sources: [],
  owners: [],
  ownerCount: 0,
  untied: true,
  pushed: true,
  value: 42,
  ...over,
});
const JOBS = metric('jobs_waiting');
const ORDERS = metric('orders_created_total', {
  type: 'counter',
  shown: 'rate',
  value: 0.07,
  labels: ['method'],
});
const BACKUP = metric('backup_last_success_timestamp', {
  type: 'timestamp',
  shown: 'time_since',
  unit: 'seconds',
  value: 10800,
  labels: [],
});

const widget = (id: string, m: OwnMetric | null, over: Partial<OwnWidget> = {}): OwnWidget => ({
  id,
  clusterId: CLUSTER.id,
  clusterName: CLUSTER.name,
  metric: m?.name ?? 'gone_metric',
  title: m?.words ?? 'Gone metric',
  shape: 'line',
  by: null,
  w: 6,
  resolved: m
    ? {
        id: m.id,
        name: m.name,
        words: m.words,
        type: m.type,
        unit: m.unit,
        shown: m.shown,
        labels: m.labels,
        refused: m.refused,
        series: m.series,
        value: m.value,
      }
    : null,
  ...over,
});

describe('editing rules', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('moves a widget earlier or later, and onto another’s place', () => {
    expect(moveBy(list, 'b', -1).map((w) => w.id)).toEqual(['b', 'a', 'c']);
    expect(moveBy(list, 'b', 1).map((w) => w.id)).toEqual(['a', 'c', 'b']);
    expect(moveBy(list, 'a', -1).map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(moveBy(list, 'c', 1).map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(moveOnto(list, 'a', 'c').map((w) => w.id)).toEqual(['b', 'c', 'a']);
    expect(moveOnto(list, 'c', 'a').map((w) => w.id)).toEqual(['c', 'a', 'b']);
    expect(moveOnto(list, 'a', 'a').map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });

  it('a corner snaps to the nearest of five widths; buttons step through them', () => {
    expect(snapWidth(0.1)).toBe(3);
    expect(snapWidth(0.3)).toBe(4);
    expect(snapWidth(0.5)).toBe(6);
    expect(snapWidth(0.62)).toBe(8);
    expect(snapWidth(0.95)).toBe(12);
    expect(snapWidth(3)).toBe(12);
    expect(snapWidth(-1)).toBe(3);
    expect(stepWidth(6, 1)).toBe(8);
    expect(stepWidth(6, -1)).toBe(4);
    expect(stepWidth(12, 1)).toBe(12);
    expect(stepWidth(3, -1)).toBe(3);
  });

  it('a new widget starts as a medium line; a timestamp as a small number', () => {
    const line = widgetFor(JOBS, CLUSTER.id, CLUSTER.name);
    expect(line).toMatchObject({
      metric: 'jobs_waiting',
      title: 'jobs waiting',
      shape: 'line',
      w: 6,
      by: null,
    });
    expect(line.id).toMatch(/^w[a-z0-9]+$/);
    expect(widgetFor(BACKUP, CLUSTER.id, CLUSTER.name)).toMatchObject({ shape: 'number', w: 3 });
  });

  it('knows unsaved changes, and sends only what a widget is', () => {
    const saved = [widget('a', JOBS), widget('b', ORDERS)];
    expect(
      changed(
        saved,
        saved.map((w) => ({ ...w })),
      ),
    ).toBe(false);
    expect(changed(saved, [saved[1]!, saved[0]!])).toBe(true);
    expect(changed(saved, [{ ...saved[0]!, w: 12 }, saved[1]!])).toBe(true);
    // What the server resolved is not a change and is never sent.
    expect(changed(saved, [{ ...saved[0]!, resolved: null }, saved[1]!])).toBe(false);
    expect(toInput(saved[0]!)).toEqual({
      id: 'a',
      clusterId: CLUSTER.id,
      metric: 'jobs_waiting',
      title: 'jobs waiting',
      shape: 'line',
      by: null,
      w: 6,
    });
  });

  it('says what a widget can’t show', () => {
    expect(problemOf(widget('a', JOBS))).toBeNull();
    expect(problemOf(widget('a', null))).toBe('gone');
    expect(problemOf(widget('a', JOBS, { clusterName: null }))).toBe('cluster');
    expect(
      problemOf(widget('a', metric('logins_total', { refused: { label: 'user_id' }, series: 0 }))),
    ).toBe('refused');
  });

  it('ranks a split by its last values, “other” last', () => {
    expect(
      ranked([
        { name: 'paypal', points: [[1, 0.3]] },
        { name: 'other', points: [[1, 9]], other: true },
        {
          name: 'stripe',
          points: [
            [1, 1],
            [2, 2.4],
            [3, null],
          ],
        },
        { name: 'empty', points: [] },
      ]),
    ).toEqual([
      { name: 'stripe', value: 2.4, share: 2.4 / 9, other: false },
      { name: 'paypal', value: 0.3, share: 0.3 / 9, other: false },
      { name: 'empty', value: null, share: 0, other: false },
      { name: 'other', value: 9, share: 1, other: true },
    ]);
  });
});

const stubs = {
  OwnMetricChart: {
    props: ['lines', 'shape', 'label'],
    template:
      '<div class="chart-stub">{{ label }}|{{ shape }}|{{ lines.map((l) => l.name).join(",") }}</div>',
  },
};
const BOARD: OwnDashboard = {
  id: 'd1',
  name: 'Shop business',
  updatedAt: 0,
  widgets: [
    widget('n1', ORDERS, { shape: 'number', w: 3, title: 'Orders created' }),
    widget('c1', JOBS, { by: 'queue', shape: 'area', title: 'Jobs waiting' }),
    widget('g1', null, { w: 12 }),
  ],
};
const LIST = {
  dashboards: [
    { id: 'd1', name: 'Shop business', widgets: 3 },
    { id: 'd2', name: 'GPU box', widgets: 0 },
  ],
  limits: { dashboards: 50, widgetsPerDashboard: 24 },
};

async function mountTab(routes: Routes, role = 'owner', path = '/your-metrics') {
  const m = mockFetch({
    'GET /api/v1/own-dashboards': { status: 200, body: LIST },
    'GET /api/v1/own-dashboards/d1': { status: 200, body: BOARD },
    ...routes,
  });
  const series = vi.spyOn(ownMetricsApi, 'series').mockResolvedValue({
    step: 60,
    unit: 'count',
    shown: 'as_is',
    values: 2,
    lines: [
      { value: 'emails', other: false, points: [[1, 400]] },
      { value: 'invoices', other: false, points: [[1, 20]] },
    ],
  });
  const plugins = await createPlugins(path);
  useAuthStore().user = { ...USER, role: role as 'owner' };
  const wrapper = mount(DashboardsTab, {
    props: { cluster: CLUSTER, metrics: [JOBS, ORDERS, BACKUP] },
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia], stubs },
    attachTo: document.body,
  });
  await flushPromises();
  return { wrapper, router: plugins.router, calls: m.calls, series };
}
const order = (w: {
  findAll: (s: string) => { attributes: (n: string) => string | undefined }[];
}) => w.findAll('[data-widget-id]').map((e) => e.attributes('data-widget-id'));

describe('the Dashboards tab', () => {
  it('reads: a chip per dashboard, each widget as its shape, a gone metric saying so', async () => {
    const { wrapper, series } = await mountTab({});
    expect(wrapper.get('[data-testid="own-dash-chip-d1"]').text()).toBe('Shop business 3');
    expect(wrapper.get('[data-testid="own-dash-chip-d1"]').attributes('aria-selected')).toBe(
      'true',
    );
    expect(wrapper.get('[data-testid="own-widget-n1"]').text()).toMatch(
      /Orders created\s*per minute\s*4\.2\s+\/min/,
    );
    const chart = wrapper.get('[data-testid="own-widget-c1"]');
    expect(chart.text()).toContain('by queue');
    expect(chart.get('.chart-stub').text()).toBe('Jobs waiting|area|emails,invoices');
    expect(series).toHaveBeenCalledWith(
      CLUSTER.id,
      JOBS.id,
      expect.objectContaining({ by: 'queue' }),
    );
    // A number reads no line; a gone metric asks for nothing.
    expect(series).toHaveBeenCalledTimes(1);
    expect(
      wrapper.get('[data-testid="own-widget-g1"] [data-testid="own-widget-problem"]').text(),
    ).toContain('gone_metric no longer reports.');
    // A widget's title leads to its metric.
    expect(chart.get('h3 a').attributes('href')).toContain(`metric=${JOBS.id}`);
    expect(wrapper.find('[data-testid="own-w-drag"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('a Viewer reads and can’t edit', async () => {
    const { wrapper } = await mountTab({}, 'viewer');
    expect(wrapper.find('[data-testid="own-dash-edit"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="own-dash-new"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-widget-id]')).toHaveLength(3);
    wrapper.unmount();
  });

  it('edits: moves and resizes with buttons and keys, removes, and saves it all with Done', async () => {
    const { wrapper, calls } = await mountTab({
      'PUT /api/v1/own-dashboards/d1': {
        status: 200,
        body: { ...BOARD, widgets: [BOARD.widgets[1], BOARD.widgets[0]] },
      },
    });
    await wrapper.get('[data-testid="own-dash-edit"]').trigger('click');
    expect(order(wrapper)).toEqual(['n1', 'c1', 'g1']);
    const cell = (id: string) => wrapper.get(`[data-widget-id="${id}"]`);
    // The first can't go earlier, the last can't go later.
    expect(cell('n1').get('[data-testid="own-w-earlier"]').attributes('disabled')).toBeDefined();
    expect(cell('g1').get('[data-testid="own-w-later"]').attributes('disabled')).toBeDefined();
    await cell('c1').get('[data-testid="own-w-earlier"]').trigger('click');
    expect(order(wrapper)).toEqual(['c1', 'n1', 'g1']);
    // The handle takes the arrow keys.
    await cell('c1').get('[data-testid="own-w-drag"]').trigger('keydown', { key: 'ArrowRight' });
    expect(order(wrapper)).toEqual(['n1', 'c1', 'g1']);
    await cell('c1').get('[data-testid="own-w-drag"]').trigger('keydown', { key: 'ArrowLeft' });
    // Sizes: buttons, and the corner's keys.
    expect(cell('c1').attributes('data-span')).toBe('6');
    await cell('c1').get('[data-testid="own-w-wider"]').trigger('click');
    expect(cell('c1').attributes('data-span')).toBe('8');
    await cell('c1').get('[data-testid="own-w-corner"]').trigger('keydown', { key: 'ArrowRight' });
    expect(cell('c1').attributes('data-span')).toBe('12');
    expect(cell('c1').get('[data-testid="own-w-wider"]').attributes('disabled')).toBeDefined();
    await cell('c1').get('[data-testid="own-w-narrower"]').trigger('click');
    await cell('g1').get('[data-testid="own-w-remove"]').trigger('click');
    expect(order(wrapper)).toEqual(['c1', 'n1']);
    await wrapper.get('[data-testid="own-dash-done"]').trigger('click');
    await flushPromises();
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({
      widgets: [
        {
          id: 'c1',
          clusterId: CLUSTER.id,
          metric: 'jobs_waiting',
          title: 'Jobs waiting',
          shape: 'area',
          by: 'queue',
          w: 8,
        },
        {
          id: 'n1',
          clusterId: CLUSTER.id,
          metric: 'orders_created_total',
          title: 'Orders created',
          shape: 'number',
          by: null,
          w: 3,
        },
      ],
    });
    // Saved: reading again, no tools.
    expect(wrapper.find('[data-testid="own-w-drag"]').exists()).toBe(false);
    expect(order(wrapper)).toEqual(['c1', 'n1']);
    wrapper.unmount();
  });

  it('adds a widget in the side panel: a metric, a shape, a split, a size, with a preview', async () => {
    const { wrapper } = await mountTab({});
    await wrapper.get('[data-testid="own-dash-edit"]').trigger('click');
    await wrapper.get('[data-testid="own-w-add"]').trigger('click');
    const editor = wrapper.get('[data-testid="own-editor"]');
    expect(editor.text()).toContain('Add a widget');
    // It starts on the first metric, as a medium line, and the preview shows it.
    expect(editor.get('[data-testid^="own-widget-"]').text()).toContain('jobs waiting');
    expect(editor.get('[data-testid="own-editor-shape-line"]').attributes('aria-checked')).toBe(
      'true',
    );
    expect(editor.get('[data-testid="own-editor-size-6"]').attributes('aria-checked')).toBe('true');
    await editor.get('[data-testid="own-editor-shape-number"]').trigger('click');
    expect(editor.text()).toContain('A number is one value');
    expect(
      editor.get('[data-testid^="own-widget-"] [data-testid="own-widget-number"]').text(),
    ).toMatch(/42/);
    await editor.get('[data-testid="own-editor-size-3"]').trigger('click');
    await editor.get('[data-testid="own-editor-apply"]').trigger('click');
    expect(wrapper.findAll('[data-widget-id]')).toHaveLength(4);
    const added = wrapper.findAll('[data-widget-id]')[3]!;
    expect(added.attributes('data-span')).toBe('3');
    expect(added.text()).toContain('jobs waiting');
    expect(wrapper.find('[data-testid="own-editor"]').exists()).toBe(false);
    // Changing one opens the same panel on it.
    await wrapper.get('[data-widget-id="c1"] [data-testid="own-w-edit"]').trigger('click');
    expect(wrapper.get('[data-testid="own-editor"]').text()).toContain('Change the widget');
    expect(wrapper.get('[data-testid="own-editor-shape-area"]').attributes('aria-checked')).toBe(
      'true',
    );
    wrapper.unmount();
  });

  it('asks before leaving with unsaved changes; Cancel without changes just leaves edit mode', async () => {
    const { wrapper, calls } = await mountTab({
      'GET /api/v1/own-dashboards/d2': {
        status: 200,
        body: { id: 'd2', name: 'GPU box', updatedAt: 0, widgets: [] },
      },
    });
    await wrapper.get('[data-testid="own-dash-edit"]').trigger('click');
    await wrapper.get('[data-testid="own-dash-cancel"]').trigger('click');
    expect(wrapper.find('[data-testid="own-w-drag"]').exists()).toBe(false);
    expect(document.querySelector('[data-testid="own-dash-discard"]')).toBeNull();

    await wrapper.get('[data-testid="own-dash-edit"]').trigger('click');
    await wrapper.get('[data-widget-id="g1"] [data-testid="own-w-remove"]').trigger('click');
    // Another dashboard's chip: asked first.
    await wrapper.get('[data-testid="own-dash-chip-d2"]').trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('Leave without saving?');
    document.querySelector<HTMLElement>('[data-testid="own-dash-keep"]')!.click();
    await flushPromises();
    expect(order(wrapper)).toEqual(['n1', 'c1']);
    expect(calls.some((c) => c.path.endsWith('/own-dashboards/d2'))).toBe(false);
    await wrapper.get('[data-testid="own-dash-chip-d2"]').trigger('click');
    await flushPromises();
    document.querySelector<HTMLElement>('[data-testid="own-dash-discard"]')!.click();
    await flushPromises();
    expect(calls.some((c) => c.path.endsWith('/own-dashboards/d2'))).toBe(true);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(wrapper.get('[data-testid="own-dash-nowidgets"]').text()).toContain('no widget yet');
    wrapper.unmount();
  });

  it('makes, renames and deletes a dashboard; says what the server says about a name', async () => {
    const { wrapper, calls } = await mountTab({
      'POST /api/v1/own-dashboards': [
        problem(409, 'A dashboard with this name exists; pick another name'),
        { status: 201, body: { id: 'd3', name: 'Backups' } },
      ],
      'GET /api/v1/own-dashboards/d3': {
        status: 200,
        body: { id: 'd3', name: 'Backups', updatedAt: 0, widgets: [] },
      },
      'PUT /api/v1/own-dashboards/d3': {
        status: 200,
        body: { id: 'd3', name: 'Backups 2', updatedAt: 0, widgets: [] },
      },
      'DELETE /api/v1/own-dashboards/d3': { status: 204 },
    });
    await wrapper.get('[data-testid="own-dash-new"]').trigger('click');
    await flushPromises();
    const form = () =>
      document.querySelector<HTMLFormElement>('[data-testid="own-dash-name-form"]')!;
    const type = async (v: string) => {
      const input = form().querySelector('input')!;
      input.value = v;
      input.dispatchEvent(new Event('input'));
      form().dispatchEvent(new Event('submit'));
      await flushPromises();
    };
    await type('Shop business');
    expect(form().textContent).toContain('A dashboard with this name exists');
    LIST.dashboards.push({ id: 'd3', name: 'Backups', widgets: 0 });
    await type('Backups');
    expect(calls.filter((c) => c.method === 'POST').at(-1)!.body).toEqual({ name: 'Backups' });
    // A new dashboard opens in edit mode with the panel ready.
    expect(wrapper.get('[data-testid="own-editor"]').text()).toContain('Add a widget');
    await wrapper.get('[data-testid="own-dash-rename"]').trigger('click');
    await flushPromises();
    await type('Backups 2');
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ name: 'Backups 2' });
    await wrapper.get('[data-testid="own-dash-delete"]').trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('Delete this dashboard?');
    LIST.dashboards.pop();
    document.querySelector<HTMLElement>('[data-testid="own-dash-delete-confirm-confirm"]')!.click();
    await flushPromises();
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/d3'))).toBe(true);
    wrapper.unmount();
  });

  it('at the plan’s number of dashboards and widgets: says so instead of offering more', async () => {
    const free = {
      dashboards: [LIST.dashboards[0]],
      limits: { dashboards: 1, widgetsPerDashboard: 3 },
    };
    const { wrapper } = await mountTab({
      'GET /api/v1/own-dashboards': { status: 200, body: free },
    });
    expect(wrapper.find('[data-testid="own-dash-new"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="own-dash-limit"]').text()).toBe(
      'Your plan has one dashboard.',
    );
    await wrapper.get('[data-testid="own-dash-edit"]').trigger('click');
    expect(wrapper.find('[data-testid="own-w-add"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="own-w-full"]').text()).toBe(
      'A dashboard has at most 3 widgets on your plan.',
    );
    expect(wrapper.find('[data-testid="own-dash-copy"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('without a dashboard: what one is, and a way to make the first', async () => {
    const { wrapper } = await mountTab({
      'GET /api/v1/own-dashboards': { status: 200, body: { dashboards: [], limits: LIST.limits } },
    });
    expect(wrapper.get('[data-testid="own-dash-empty"]').text()).toContain(
      'Build a dashboard from your metrics',
    );
    expect(wrapper.find('[data-testid="own-dash-first"]').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe('Add to a dashboard', () => {
  it('appends the metric to the dashboard picked, as a widget of its own', async () => {
    const m = mockFetch({
      'GET /api/v1/own-dashboards': {
        status: 200,
        body: {
          dashboards: [{ id: 'd1', name: 'Shop business', widgets: 1 }],
          limits: LIST.limits,
        },
      },
      'GET /api/v1/own-dashboards/d1': {
        status: 200,
        body: { ...BOARD, widgets: [BOARD.widgets[0]] },
      },
      'PUT /api/v1/own-dashboards/d1': [
        problem(
          402,
          'A dashboard has at most 8 widgets on your plan. Remove one, or upgrade to Pro for 24.',
        ),
        { status: 200, body: BOARD },
      ],
    });
    const plugins = await createPlugins('/');
    const wrapper = mount(AddToDashboard, {
      props: { metric: JOBS, cluster: CLUSTER, open: true },
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
      attachTo: document.body,
    });
    await flushPromises();
    const form = document.querySelector<HTMLFormElement>('[data-testid="own-addto"]')!;
    form.dispatchEvent(new Event('submit'));
    await flushPromises();
    expect(document.querySelector('[data-testid="own-addto-error"]')!.textContent).toContain(
      'at most 8 widgets',
    );
    form.dispatchEvent(new Event('submit'));
    await flushPromises();
    const put = m.calls.filter((c) => c.method === 'PUT').at(-1)!.body as {
      widgets: { metric: string; shape: string; w: number }[];
    };
    expect(put.widgets.map((w) => [w.metric, w.shape, w.w])).toEqual([
      ['orders_created_total', 'number', 3],
      ['jobs_waiting', 'line', 6],
    ]);
    expect(wrapper.emitted('added')![0]).toEqual([{ id: 'd1', name: 'Shop business' }]);
    wrapper.unmount();
  });
});
