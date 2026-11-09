// SPDX-License-Identifier: AGPL-3.0-only
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import type { Alert, AlertChannel, AlertRule } from '@watchlog/api-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AlertingStatusBanner from '@/components/alerts/AlertingStatusBanner.vue';
import { useAuthStore } from '@/stores/auth';
import AlertDetailPage from '@/views/AlertDetailPage.vue';
import AlertsPage from '@/views/AlertsPage.vue';
import { mockFetch, problem, USER, type Routes } from './fetch-mock';
import { chooseOption, createPlugins } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const CLUSTER = { id: '01a191b8-ae9d-7373-a09d-8df29bc1a803', name: 'prod', kind: 'kubernetes' };
const ALERT: Alert = {
  id: '01a19300-0000-7000-8000-000000000001',
  state: 'firing',
  severity: 'critical',
  rule: {
    id: '01a19300-0000-7000-8000-0000000000aa',
    key: 'k8s.pod.crashloop',
    name: 'Pod CrashLoopBackOff',
  },
  cluster: CLUSTER,
  labels: { namespace: 'wl-test', workload: 'web', workload_kind: 'Deployment', pod: 'web-1' },
  summary: 'main: Error (exit 1), 6 restarts',
  pods: ['web-1', 'web-2'],
  podCount: 2,
  startedAt: '2026-11-01T12:04:00.000Z',
  firedAt: '2026-11-01T12:06:00.000Z',
  resolvedAt: null,
  silenced: false,
  flapping: false,
  held: false,
  title: 'web is crash-looping',
  why: 'last exit: Error (code 1) · 6 restarts',
  deliveries: [],
};
const RESOLVED: Alert = {
  ...ALERT,
  id: '01a19300-0000-7000-8000-000000000002',
  state: 'resolved',
  resolvedAt: '2026-11-01T12:18:00.000Z',
};
const COUNTS = { firing: 1, pending: 0, silenced: 0 };
const RULE: AlertRule = {
  id: '01a19300-0000-7000-8000-0000000000bb',
  type: 'default',
  ruleKey: 'node.disk.usage',
  name: 'Node disk usage',
  source: 'metric',
  unit: 'ratio',
  metric: null,
  clusterId: null,
  appliesTo: ['kubernetes', 'docker'],
  scope: {},
  condition: { op: '>', value: 0.85, critical: 0.95 },
  forSeconds: 0,
  renotifySeconds: 14400,
  severity: 'warning',
  enabled: true,
  channelIds: [],
  firing: 0,
  evalError: null,
};
const CHANNEL: AlertChannel = {
  id: '01a19300-0000-7000-8000-0000000000cc',
  type: 'webhook',
  name: 'Bridge',
  config: { url: 'https://hooks.example.com/x' },
  secrets: { signingSecret: '…abcd' },
  verifiedAt: null,
  lastSentAt: null,
  lastError: null,
  lastErrorAt: null,
  createdAt: '2026-11-01T12:00:00.000Z',
  ruleCount: 14,
};
const STATUS = {
  running: true,
  lastCycleAt: '2026-11-01T12:00:00.000Z',
  workers: 1,
  publicUrlConfigured: true,
  smtpConfigured: false,
};

async function mountView(component: object, path: string, role: 'owner' | 'viewer' = 'owner') {
  const plugins = await createPlugins(path);
  useAuthStore().user = { ...USER, role };
  const wrapper = mount(component, {
    attachTo: document.body,
    global: {
      plugins: [plugins.router, plugins.i18n, plugins.pinia],
      stubs: {
        TimeSeriesChart: {
          props: ['title', 'series', 'thresholds', 'window', 'markers', 'areas', 'note'],
          template:
            '<div class="chart-stub" :data-window="(window || []).join(\'-\')">{{ title }} {{ series.length }}' +
            ' <span class="thresholds">{{ (thresholds || []).map((t) => t.label).join(" | ") }}</span>' +
            ' <span class="areas">{{ (areas || []).map((a) => a.label).join(" | ") }}</span> {{ note }}</div>',
        },
      },
    },
  });
  await flushPromises();
  return { wrapper, router: plugins.router };
}

describe('"Alerting is not running" banner (ADR-088)', () => {
  it('shows only while no worker runs', async () => {
    mockFetch({
      'GET /api/v1/alerting/status': { status: 200, body: { ...STATUS, running: false } },
    });
    let { wrapper: w } = await mountView(AlertingStatusBanner, '/');
    expect(w.get('[data-testid="alerting-down"]').text()).toContain('Alerting is not running');
    expect(w.text()).toContain('Last check:');
    w.unmount();
    mockFetch({ 'GET /api/v1/alerting/status': { status: 200, body: STATUS } });
    ({ wrapper: w } = await mountView(AlertingStatusBanner, '/'));
    expect(w.find('[data-testid="alerting-down"]').exists()).toBe(false);
    w.unmount();
  });
});

describe('Alerts page', () => {
  const COUNTS0 = { firing: 0, critical: 0, warning: 0, pending: 0, silenced: 0, held: 0 };
  const KUBE = {
    id: CLUSTER.id,
    name: 'prod',
    kind: 'kubernetes',
    status: 'active',
    nodeCount: 12,
    agentVersion: 'dev',
    firstSeenAt: null,
    lastSeenAt: null,
    createdAt: '2026-11-01T12:00:00.000Z',
    ingestFailure: null,
  };
  const page = (alerts: Alert[], counts: object, extra: Routes = {}) => ({
    'GET /api/v1/alerts': {
      status: 200,
      body: { alerts, nextCursor: null, counts: { ...COUNTS0, ...counts } },
    },
    'GET /api/v1/clusters': { status: 200, body: { clusters: [KUBE] } },
    'GET /api/v1/silences': { status: 200, body: { silences: [] } },
    ...extra,
  });

  it('shows summary tiles, alerts grouped by cluster with title, why and delivery, and silences one', async () => {
    const delivered: Alert = {
      ...ALERT,
      podCount: 2,
      deliveries: [
        { channelId: 'c1', name: 'Slack', type: 'slack', status: 'sent', error: null },
        {
          channelId: 'c2',
          name: 'Email',
          type: 'email',
          status: 'failed',
          error: 'SMTP: Invalid login',
        },
      ],
    };
    const { calls } = mockFetch(
      page(
        [delivered],
        { firing: 1, critical: 1, silenced: 1 },
        {
          'POST /api/v1/silences': { status: 201, body: { id: 's1' } },
        },
      ) as Routes,
    );
    const { wrapper: w } = await mountView(AlertsPage, '/alerts');
    expect(w.get('[data-testid="tile-critical"]').text()).toBe('1');
    expect(w.get('[data-testid="tile-silenced"]').text()).toBe('1');
    const group = w.get('[data-testid="cluster-group"]');
    expect(group.text()).toContain('prod');
    expect(group.text()).toMatch(/Kubernetes cluster\s+·\s+12 nodes/);
    expect(group.text()).toContain('1 critical');
    expect(w.get('[data-testid="alert-title"]').text()).toBe('web is crash-looping');
    expect(w.get('[data-testid="alert-where"]').text()).toBe('Deployment wl-test/web · 2 pods');
    expect(w.get('[data-testid="alert-why"]').text()).toBe(
      'last exit: Error (code 1) · 6 restarts',
    );
    const d = w.findAll('[data-testid="deliveries"] li');
    expect(d.map((x) => x.text())).toEqual(['Slack Sent', 'Email Failed: SMTP: Invalid login']);
    expect(d[1]!.attributes('title')).toBe('SMTP: Invalid login');
    // Severity is never colour only.
    expect(w.get('[data-testid="alert-row"]').text()).toContain('Critical');

    await w.get('[data-testid="silence-menu"]').trigger('click');
    await w.get('[data-testid="silence-menu"]').trigger('pointerdown', { button: 0 });
    await flushPromises();
    const item = document.querySelector<HTMLElement>('[data-testid="silence-for-240"]');
    expect(item).not.toBeNull();
    item!.click();
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      matchers: { rule: ALERT.rule.id, cluster: CLUSTER.id, namespace: 'wl-test', workload: 'web' },
      durationMinutes: 240,
      comment: '',
    });
    w.unmount();
  });

  it('shows one card for a cluster that stopped reporting and its held alerts on request', async () => {
    const silent: Alert = {
      ...ALERT,
      id: '01a19300-0000-7000-8000-000000000003',
      rule: { id: 'r-agent', key: 'agent.not_reporting', name: 'Agent not reporting' },
      labels: { agent: 'all' },
      title: 'prod stopped reporting',
      why: 'all 3 agents are silent · last data 18 min ago',
    };
    const held: Alert = { ...ALERT, held: true };
    mockFetch(
      page(
        [silent],
        { firing: 1, critical: 1, held: 1 },
        {
          'GET /api/v1/alerts?held=true': {
            status: 200,
            body: { alerts: [held], nextCursor: null, counts: COUNTS0 },
          },
        },
      ) as Routes,
    );
    const { wrapper: w } = await mountView(AlertsPage, '/alerts');
    const card = w.get('[data-testid="incident"]');
    expect(card.text()).toContain('prod stopped reporting');
    expect(card.text()).toContain(
      'All 3 agents are silent. One alert is sent for the cluster instead of one per agent, and 1 other alerts from it are held',
    );
    expect(w.get('[data-testid="tile-held"]').text()).toBe('1');
    expect(w.text()).toContain('cluster not reporting');
    await card.get('[data-testid="show-held"]').trigger('click');
    await flushPromises();
    const heldList = w.get('[data-testid="held-alerts"]');
    expect(heldList.text()).toContain('web is crash-looping');
    expect(heldList.get('[data-testid="held"]').text()).toBe('Held back');
    w.unmount();
  });

  it('has distinct empty and error states', async () => {
    mockFetch({
      ...page([], {}),
      'GET /api/v1/alerts': [
        problem(503, 'down'),
        { status: 200, body: { alerts: [], nextCursor: null, counts: COUNTS0 } },
      ],
    } as Routes);
    const { wrapper: w } = await mountView(AlertsPage, '/alerts', 'viewer');
    expect(w.find('[data-testid="error-state"]').exists()).toBe(true);
    await w.get('[data-testid="retry"]').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('No alerts are firing');
    // Locked, not hidden (ADR-140): visible, disabled, saying why.
    const silence = w.get('[data-testid="new-silence"]');
    expect(silence.element.closest('fieldset')?.disabled).toBe(true);
    expect(silence.element.closest('[data-testid="locked"]')?.textContent).toContain(
      "Viewers can't change this. Ask an Admin.",
    );
    w.unmount();
  });

  it('creates a silence for a cluster from "Silence…"', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/silences': { status: 200, body: { silences: [] } },
      'GET /api/v1/clusters': { status: 200, body: { clusters: [KUBE] } },
      'POST /api/v1/silences': { status: 201, body: { id: 's1' } },
    } as Routes);
    const { wrapper: w } = await mountView(AlertsPage, '/alerts?view=silences&new=silence');
    const form = w.get('[data-testid="new-silence-form"]');
    await form.trigger('submit');
    expect(form.text()).toContain('Choose at least one');
    await chooseOption(form, 'silence-cluster', 'prod');
    await form.trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      matchers: { cluster: CLUSTER.id },
      durationMinutes: 60,
      comment: '',
    });
    w.unmount();
  });

  it('pages the history and shows how long alerts lasted', async () => {
    mockFetch({
      'GET /api/v1/alerts?view=history': {
        status: 200,
        body: { alerts: [RESOLVED], nextCursor: 'c1', counts: COUNTS },
      },
      'GET /api/v1/alerts?view=history&cursor=c1': {
        status: 200,
        body: { alerts: [{ ...RESOLVED, id: 'x' }], nextCursor: null, counts: COUNTS },
      },
    });
    const { wrapper: w } = await mountView(AlertsPage, '/alerts?view=history');
    expect(w.get('[data-testid="alert-row"]').text()).toContain('12m');
    await w.get('[data-testid="load-more"]').trigger('click');
    await flushPromises();
    expect(w.findAll('[data-testid="alert-row"]')).toHaveLength(2);
    expect(w.find('[data-testid="load-more"]').exists()).toBe(false);
    w.unmount();
  });

  it('lists silences and ends one', async () => {
    const silence = {
      id: 's1',
      matchers: { workload: 'web' },
      startsAt: ALERT.startedAt,
      endsAt: '2026-11-01T13:00:00.000Z',
      comment: 'deploying',
      createdBy: null,
      active: true,
      matching: 1,
    };
    const { calls } = mockFetch({
      // Listed for the view and for the tab counts, then again after ending it.
      'GET /api/v1/silences': [
        { status: 200, body: { silences: [silence] } },
        { status: 200, body: { silences: [silence] } },
        { status: 200, body: { silences: [] } },
      ],
      'DELETE /api/v1/silences/s1': { status: 204 },
      'GET /api/v1/clusters': { status: 200, body: { clusters: [] } },
      'GET /api/v1/alerts': {
        status: 200,
        body: { alerts: [], nextCursor: null, counts: COUNTS0 },
      },
    } as Routes);
    const { wrapper: w } = await mountView(AlertsPage, '/alerts?view=silences');
    expect(w.get('[data-testid="silence-row"]').text()).toContain('Workload: web');
    expect(w.text()).toContain('silences 1 alert');
    await w.get('[data-testid="end-silence"]').trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(w.text()).toContain('No active silences');
    w.unmount();
  });

  it('shows each rule as a sentence with its values, grouped, and default channels once', async () => {
    const rule = (over: Partial<AlertRule>): AlertRule => ({ ...RULE, ...over });
    const RULES = [
      rule({
        id: 'p',
        ruleKey: 'k8s.pod.pending',
        name: 'Pod Pending',
        source: 'state',
        unit: null,
        condition: null,
        forSeconds: 300,
        severity: 'warning',
        channelIds: [CHANNEL.id],
      }),
      rule({
        id: 'a',
        ruleKey: 'k8s.pod.crashloop',
        name: 'Pod CrashLoopBackOff',
        source: 'state',
        unit: null,
        condition: null,
        forSeconds: 120,
        severity: 'critical',
        firing: 1,
        channelIds: [CHANNEL.id],
      }),
      rule({ id: 'b', channelIds: [CHANNEL.id] }),
      rule({
        id: 'c',
        ruleKey: 'agent.not_reporting',
        name: 'Agent not reporting',
        source: 'state',
        unit: null,
        condition: null,
        severity: 'critical',
        channelIds: [CHANNEL.id],
      }),
      rule({
        id: 'd',
        type: 'threshold',
        ruleKey: null,
        name: 'Web memory',
        metric: 'pod.memory.working_set',
        unit: 'bytes',
        scope: { labels: { app: 'web' } } as AlertRule['scope'],
        condition: { op: '>', value: 512 * 2 ** 20 },
        forSeconds: 600,
        channelIds: [],
      }),
    ];
    const { calls } = mockFetch({
      'GET /api/v1/alert-rules': { status: 200, body: { rules: RULES } },
      'GET /api/v1/alert-channels': { status: 200, body: { channels: [CHANNEL] } },
      'GET /api/v1/clusters': { status: 200, body: { clusters: [] } },
      'GET /api/v1/alerts': {
        status: 200,
        body: { alerts: [], nextCursor: null, counts: { ...COUNTS0, firing: 4 } },
      },
      'GET /api/v1/silences': { status: 200, body: { silences: [] } },
      'PUT /api/v1/alert-rules/defaults/channels': { status: 200, body: { rules: RULES } },
      [`PATCH /api/v1/alert-rules/b`]: { status: 200, body: RULE },
    } as Routes);
    const { wrapper: w } = await mountView(AlertsPage, '/alerts?view=rules');
    const sentences = w.findAll('[data-testid="rule-sentence"]').map((x) => x.text());
    // Most urgent first within a group, whatever the API order; the Firing count stays.
    expect(sentences).toEqual([
      'A pod is crash-looping for 2 min',
      'A pod stays Pending for 5 min',
      'Node disk above 85% (critical above 95%)',
      'A cluster or host stops reporting for 3 min · one alert per cluster, other alerts held',
      'Pod memory (working set) of app=web pods above 512 MiB for 10 min',
    ]);
    expect(w.get('[data-testid="tab-firing"]').text()).toContain('4');
    expect(w.get('[data-testid="rule-group-pods"]').text()).toContain('Pods & workloads');
    expect(w.get('[data-testid="rule-group-watchlog"]').text()).toContain('WatchLog itself');
    expect(w.get('[data-testid="rule-group-custom"]').text()).toContain('1 rule');
    expect(w.findAll('[data-testid="default-channel"]').map((c) => c.text())).toEqual(['Bridge']);
    expect(w.text()).not.toContain('no channel');

    await w.get('[data-testid="change-defaults"]').trigger('click');
    await w.get('[data-testid="combobox-clear"]').trigger('click');
    await w.get('[data-testid="save-defaults"]').trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ channelIds: [] });

    await w.findAll('[data-testid="rule-toggle"]')[2]!.trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ enabled: false });
    w.unmount();
  });
});

describe('rule editor drawer (alerts redesign item 9)', () => {
  const KUBE = {
    id: CLUSTER.id,
    name: 'prod',
    kind: 'kubernetes',
    status: 'active',
    nodeCount: 3,
    agentVersion: 'dev',
    firstSeenAt: null,
    lastSeenAt: null,
    createdAt: '2026-11-01T12:00:00.000Z',
    ingestFailure: null,
  };
  const STATE_RULE: AlertRule = {
    ...RULE,
    id: 'crash',
    ruleKey: 'k8s.pod.crashloop',
    name: 'Pod CrashLoopBackOff',
    source: 'state',
    unit: null,
    condition: null,
    forSeconds: 120,
    severity: 'critical',
  };
  const routes = (extra: Routes = {}) =>
    ({
      'GET /api/v1/alert-rules': { status: 200, body: { rules: [RULE, STATE_RULE] } },
      'GET /api/v1/alert-channels': { status: 200, body: { channels: [CHANNEL] } },
      'GET /api/v1/clusters': { status: 200, body: { clusters: [KUBE] } },
      ...extra,
    }) as Routes;
  const body = () => new DOMWrapper(document.body);
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 650)); // the preview waits 500 ms for typing to stop
    await flushPromises();
  };

  it('builds a custom rule as a sentence, previews it and shows why the API refuses it', async () => {
    const tooBroad =
      'The label selector matches 501 pods; at most 500 are allowed. Narrow it, or scope the rule to a workload or a namespace instead.';
    const { calls } = mockFetch(
      routes({
        'POST /api/v1/alert-rules/preview': {
          status: 200,
          body: {
            kind: 'metric',
            fired: 2,
            critical: 1,
            hours: 24,
            unit: 'bytes',
            series: {
              name: 'web-0',
              points: [
                [0, 1],
                [60, 2],
              ],
            },
          },
        },
        'POST /api/v1/alert-rules': problem(400, tooBroad),
      }),
    );
    const { wrapper: w } = await mountView(AlertsPage, '/alerts?view=rules');
    await w.get('[data-testid="new-rule"]').trigger('click');
    await flushPromises();
    const drawer = body().get('[data-testid="rule-drawer"]');
    expect(drawer.text()).toContain('New custom rule');
    await chooseOption(drawer, 'drawer-metric', 'Pod memory (working set)');
    await chooseOption(drawer, 'drawer-scope', 'Pod labels');
    await drawer.get('[data-testid="drawer-scope-text"] input').setValue('app=web');
    await drawer.get('[data-testid="drawer-threshold"]').setValue('512');
    await drawer.get('[data-testid="drawer-critical"]').setValue('800');
    await drawer.get('[data-testid="drawer-for"]').setValue('10');
    await settle();
    expect(drawer.get('[data-testid="drawer-fired"]').text()).toBe(
      'With these settings this rule would have fired 2 times in the last 24 h (1 reached critical).',
    );
    const preview = calls.filter((c) => c.path === '/api/v1/alert-rules/preview').at(-1)!.body;
    expect(preview).toMatchObject({
      metric: 'pod.memory.working_set',
      scope: { labels: { app: 'web' } },
      forSeconds: 600,
    });

    await drawer.get('form').trigger('submit');
    await flushPromises();
    expect(
      calls.find((c) => c.method === 'POST' && c.path === '/api/v1/alert-rules')!.body,
    ).toEqual({
      forSeconds: 600,
      renotifySeconds: 14400,
      channelIds: [CHANNEL.id],
      severity: 'warning',
      condition: { op: '>', value: 512 * 2 ** 20, critical: 800 * 2 ** 20 },
      name: 'Pod memory (working set)',
      metric: 'pod.memory.working_set',
      clusterId: CLUSTER.id,
      scope: { labels: { app: 'web' } },
    });
    expect(drawer.get('[data-testid="drawer-error"]').text()).toBe(tooBroad);
    w.unmount();
  });

  it('edits a default metric rule with one threshold model and resets it', async () => {
    const { calls } = mockFetch(
      routes({
        'POST /api/v1/alert-rules/preview': {
          status: 200,
          body: {
            kind: 'metric',
            fired: 0,
            critical: 0,
            hours: 24,
            unit: 'ratio',
            series: { name: 'w1 · /var', points: [[1793440800, 0.6]] },
          },
        },
        [`PATCH /api/v1/alert-rules/${RULE.id}`]: { status: 200, body: RULE },
        [`POST /api/v1/alert-rules/${RULE.id}/reset`]: { status: 200, body: RULE },
      }),
    );
    const { wrapper: w } = await mountView(AlertsPage, '/alerts?view=rules');
    await w.findAll('[data-testid="rule-sentence"]')[1]!.trigger('click');
    await flushPromises();
    const drawer = body().get('[data-testid="rule-drawer"]');
    expect(drawer.get('[data-testid="drawer-metric-fixed"]').text()).toBe('Disk usage');
    expect((drawer.get('[data-testid="drawer-threshold"]').element as HTMLInputElement).value).toBe(
      '85',
    );
    expect((drawer.get('[data-testid="drawer-critical"]').element as HTMLInputElement).value).toBe(
      '95',
    );
    expect(drawer.find('[data-testid="drawer-severity-critical"]').exists()).toBe(false);
    await drawer.get('[data-testid="drawer-threshold"]').setValue('80');
    await settle();
    expect(drawer.get('[data-testid="drawer-fired"]').text()).toBe(
      'With these settings this rule would not have fired in the last 24 h.',
    );
    // The backtest's 24 hours (not the top bar's hour), thresholds drawn as on alert pages.
    const preview = drawer.get('.chart-stub');
    expect(preview.attributes('data-window')).toBe(`${1793440800 - 86400}-1793440800`);
    expect(preview.get('.thresholds').text()).toBe('Warning 80% | Critical 95%');
    await chooseOption(drawer, 'drawer-remind', '24 hours');
    await drawer.get('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      forSeconds: 0,
      renotifySeconds: 86400,
      channelIds: [],
      severity: 'warning',
      condition: { op: '>', value: 0.8, critical: 0.95 },
    });

    await w.findAll('[data-testid="rule-sentence"]')[1]!.trigger('click');
    await flushPromises();
    await body().get('[data-testid="drawer-reset"]').trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.path === `/api/v1/alert-rules/${RULE.id}/reset`)).toBe(true);
    w.unmount();
  });

  it('keeps a Warning/Critical choice for state rules and shows their last 7 days', async () => {
    const { calls } = mockFetch(
      routes({
        'POST /api/v1/alert-rules/preview': {
          status: 200,
          body: {
            kind: 'state',
            fired: 3,
            critical: 3,
            hours: 168,
            unit: null,
            series: null,
            // The latest alert's chart, from the same code as its alert page.
            chart: {
              window: { from: 1793440000, to: 1793443600 },
              panels: [
                {
                  id: 'restarts',
                  kind: 'line',
                  metric: null,
                  unit: 'count',
                  lines: [{ name: 'wl · api-1', points: [[1793441000, 4]], step: true }],
                  thresholds: [],
                  rows: [],
                  more: 0,
                },
              ],
              markers: [{ ts: 1793441000, kind: 'fired' }],
              firing: { from: 1793441000, to: 1793443600 },
              episodes: [],
              gaps: [],
              silent: null,
              ruleChanged: null,
            },
          },
        },
        'PATCH /api/v1/alert-rules/crash': { status: 200, body: STATE_RULE },
      }),
    );
    const { wrapper: w } = await mountView(AlertsPage, '/alerts?view=rules');
    await w.findAll('[data-testid="rule-sentence"]')[0]!.trigger('click');
    await settle();
    const drawer = body().get('[data-testid="rule-drawer"]');
    expect(drawer.text()).toContain('A pod is crash-looping');
    expect(drawer.get('[data-testid="drawer-fired"]').text()).toBe(
      'It fired 3 times in the last 7 days.',
    );
    expect(drawer.get('[data-testid="drawer-state-chart"] .chart-stub').text()).toContain(
      'Restarts',
    );
    await drawer.get('[data-testid="drawer-severity-warning"]').setValue(true);
    await drawer.get('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({
      severity: 'warning',
      forSeconds: 120,
    });
    w.unmount();
  });
});

describe('Alert detail', () => {
  const notifications = [
    {
      id: 'n1',
      kind: 'firing',
      status: 'sent',
      error: null,
      attempts: 1,
      createdAt: '2026-11-01T12:06:00.000Z',
      sentAt: '2026-11-01T12:06:01.000Z',
      channel: { id: CHANNEL.id, name: 'Bridge', type: 'webhook' },
    },
    {
      id: 'n2',
      kind: 'firing',
      status: 'failed',
      error: 'Slack answered 404: no_service',
      attempts: 1,
      createdAt: '2026-11-01T12:06:00.000Z',
      sentAt: null,
      channel: null,
    },
  ];
  const s = (iso: string) => Date.parse(iso) / 1000;
  const CHART = {
    window: { from: s('2026-11-01T11:34:00.000Z'), to: s('2026-11-01T12:30:00.000Z') },
    panels: [
      {
        id: 'restarts',
        kind: 'line',
        metric: null,
        unit: 'count',
        lines: [
          { name: 'wl-test · web-1', points: [[s('2026-11-01T12:00:00.000Z'), 3]], step: true },
        ],
        thresholds: [],
        rows: [],
        more: 2,
      },
      {
        id: 'metric',
        kind: 'line',
        metric: 'node.filesystem.utilization',
        unit: 'ratio',
        lines: [{ name: 'w1 · /var', points: [[s('2026-11-01T12:00:00.000Z'), 0.9]] }],
        thresholds: [
          { kind: 'warning', value: 0.85 },
          { kind: 'critical', value: 0.95 },
        ],
        rows: [],
        more: 0,
      },
      {
        id: 'conditions',
        kind: 'bands',
        metric: null,
        unit: null,
        lines: [],
        thresholds: [],
        rows: [
          {
            name: 'Ready',
            segments: [
              {
                from: s('2026-11-01T11:34:00.000Z'),
                to: s('2026-11-01T12:04:00.000Z'),
                state: 'True',
                tone: 'ok',
              },
              {
                from: s('2026-11-01T12:04:00.000Z'),
                to: s('2026-11-01T12:30:00.000Z'),
                state: 'False',
                tone: 'critical',
              },
            ],
          },
        ],
        more: 0,
      },
    ],
    markers: [
      { ts: s(ALERT.startedAt), kind: 'started' },
      { ts: s(ALERT.firedAt!), kind: 'fired' },
      {
        ts: s('2026-11-01T12:06:01.000Z'),
        kind: 'notification',
        channel: 'Bridge',
        status: 'sent',
        messageKind: 'firing',
      },
    ],
    firing: { from: s(ALERT.firedAt!), to: s('2026-11-01T12:30:00.000Z') },
    episodes: [{ from: s('2026-11-01T11:40:00.000Z'), to: s('2026-11-01T11:50:00.000Z') }],
    gaps: [],
    silent: null,
    ruleChanged: { condition: { op: '>', value: 0.9 }, forSeconds: 0, unit: 'ratio' },
  };

  it('says what is wrong in plain words, links the object, charts it and lists the timeline', async () => {
    const { calls } = mockFetch({
      [`GET /api/v1/alerts/${ALERT.id}`]: {
        status: 200,
        body: {
          alert: ALERT,
          notifications,
          history: [RESOLVED],
          // The worker was down between the condition starting and the alert firing.
          gaps: [{ from: '2026-11-01T12:04:30.000Z', to: '2026-11-01T12:05:50.000Z' }],
        },
      },
      [`GET /api/v1/alerts/${ALERT.id}/chart?range=3600`]: { status: 200, body: CHART },
    } as Routes);
    const { wrapper: w } = await mountView(AlertDetailPage, `/alerts/${ALERT.id}`);
    const header = w.get('[data-testid="alert-header"]').text();
    expect(w.get('[data-testid="alert-title"]').text()).toBe('web is crash-looping');
    expect(w.get('[data-testid="alert-why"]').text()).toBe(
      'last exit: Error (code 1) · 6 restarts',
    );
    expect(header).toContain('Pods (2): web-1, web-2');
    const link = w.get('[data-testid="open-target"]');
    expect(link.text()).toBe('Open web-1');
    expect(link.attributes('href')).toBe('/pods/wl-test/web-1');

    // The chart asks for the picker's range (1 h by default) and draws each panel.
    expect(calls.find((c) => c.path.includes('/chart'))!.path).toContain('range=3600');
    const charts = w.findAll('.chart-stub');
    expect(charts.map((c) => c.text().split(' ')[0])).toEqual(['Restarts', 'Node']);
    expect(charts[0]!.text()).toContain('and 2 more');
    expect(charts[1]!.get('.thresholds').text()).toBe('Warning 85% | Critical 95%');
    expect(charts[1]!.get('.areas').text()).toBe('Earlier episode | Firing');
    expect(charts[1]!.attributes('data-window')).toBe(`${CHART.window.from}-${CHART.window.to}`);
    expect(w.get('[data-testid="rule-changed"]').text()).toBe(
      'Rule changed since: threshold now 90%',
    );
    const bands = w.get('[data-testid="alert-chart-conditions"]');
    expect(
      bands.findAll('[data-testid="state-segment"]').map((x) => x.attributes('data-state')),
    ).toEqual(['True', 'False']);
    expect(bands.get('[data-testid="state-legend"]').text()).toContain('False');
    expect(w.get('[data-testid="alert-chart-markers"]').text()).toContain(
      'Firing to Bridge · Sent',
    );

    const timeline = w.get('[data-testid="alert-timeline"]').text();
    expect(timeline).toContain('Condition started');
    expect(timeline).toContain('Firing message to Bridge');
    expect(timeline).toContain('Sent');
    expect(timeline).toContain('Failed');
    expect(timeline).toContain('no_service');
    expect(w.get('[data-testid="timeline-gap"]').text()).toMatch(
      /^Alerting was not running \d\d:\d\d–\d\d:\d\d$|^Alerting was not running Nov 1, \d\d:\d\d–Nov 1, \d\d:\d\d$/,
    );
    expect(timeline).toMatch(/ago/);
    // Never a raw ISO timestamp anywhere on the page.
    expect(w.text()).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:/);
    expect(w.findAll('[data-testid="alert-row"]')).toHaveLength(1);
    w.unmount();
  });

  it('links a silent cluster to its page and says when there is no data to chart', async () => {
    const silent: Alert = {
      ...ALERT,
      rule: { ...ALERT.rule, key: 'agent.not_reporting', name: 'Agent not reporting' },
      labels: { agent: 'all' },
      pods: [],
      podCount: 0,
      title: 'kind-demo stopped reporting',
      why: 'all 3 agents are silent · last data 18 min ago',
    };
    mockFetch({
      [`GET /api/v1/alerts/${ALERT.id}`]: {
        status: 200,
        body: { alert: silent, notifications: [], history: [], gaps: [] },
      },
      [`GET /api/v1/alerts/${ALERT.id}/chart?range=3600`]: {
        status: 200,
        body: {
          ...CHART,
          panels: [{ ...CHART.panels[2], id: 'phases', rows: [{ name: 'web-1', segments: [] }] }],
          ruleChanged: null,
        },
      },
    } as Routes);
    const { wrapper: w } = await mountView(AlertDetailPage, `/alerts/${ALERT.id}`);
    expect(w.get('[data-testid="alert-title"]').text()).toBe('kind-demo stopped reporting');
    expect(w.get('[data-testid="open-target"]').attributes('href')).toBe(
      `/settings/clusters/${CLUSTER.id}`,
    );
    expect(w.get('[data-testid="alert-header"]').text()).not.toContain('on cluster-agent');
    expect(w.get('[data-testid="alert-chart-phases"]').text()).toContain(
      'No data from this object in this window',
    );
    expect(w.find('[data-testid="rule-changed"]').exists()).toBe(false);
    w.unmount();
  });

  it('says when an alert does not exist', async () => {
    mockFetch({
      'GET /api/v1/alerts/nope': problem(404, 'Alert not found'),
      'GET /api/v1/alerts/nope/chart?range=3600': problem(404, 'Alert not found'),
    });
    const { wrapper: w } = await mountView(AlertDetailPage, '/alerts/nope');
    expect(w.text()).toContain('Alert not found');
    w.unmount();
  });
});

describe('Settings → General: public address (ADR-093)', () => {
  it('saves the address in the browser with one click', async () => {
    const { default: GeneralSettings } = await import('@/components/settings/GeneralSettings.vue');
    const { calls } = mockFetch({
      'GET /api/v1/settings/general': {
        status: 200,
        body: { publicUrl: null, publicUrlSource: 'none' },
      },
      'PUT /api/v1/settings/general': {
        status: 200,
        body: { publicUrl: window.location.origin, publicUrlSource: 'db' },
      },
    });
    const { wrapper: w } = await mountView(GeneralSettings, '/settings?tab=general');
    await w.get('[data-testid="use-this-address"]').trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      publicUrl: window.location.origin,
    });
    expect(w.text()).toContain('Saved.');
    w.unmount();
  });

  it("is read-only when the server's environment sets it, without naming variables", async () => {
    const { default: GeneralSettings } = await import('@/components/settings/GeneralSettings.vue');
    mockFetch({
      'GET /api/v1/settings/general': {
        status: 200,
        body: { publicUrl: 'https://watchlog.acme.dev', publicUrlSource: 'env' },
      },
    });
    const { wrapper: w } = await mountView(GeneralSettings, '/settings?tab=general');
    expect(w.get('input').attributes('readonly')).toBeDefined();
    expect(w.text()).toContain("Set by the server's environment");
    expect(w.text()).not.toMatch(/WATCHLOG_/);
    expect(w.find('[data-testid="save-public-url"]').exists()).toBe(false);
    w.unmount();
  });
});

describe('Settings → General: system namespaces', () => {
  it('edits the list and resets it to the default', async () => {
    const { default: SystemNamespaces } =
      await import('@/components/settings/SystemNamespaces.vue');
    const DEFAULT = ['kube-node-lease', 'kube-public', 'kube-system', 'local-path-storage'];
    const { calls } = mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [] } },
      'GET /api/v1/settings/namespaces': {
        status: 200,
        body: { system: DEFAULT, watchlog: true, isDefault: true },
      },
      'PUT /api/v1/settings/namespaces': {
        status: 200,
        body: { system: DEFAULT, watchlog: false, isDefault: false },
      },
    });
    const { wrapper: w } = await mountView(SystemNamespaces, '/settings?tab=general');
    expect(w.findAll('[data-testid="combobox-chip"]').map((c) => c.text())).toEqual(DEFAULT);
    expect(w.find('[data-testid="reset-namespaces"]').exists()).toBe(false);
    await w.get('[data-testid="hide-watchlog"]').setValue(false);
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      system: DEFAULT,
      watchlog: false,
    });
    expect(w.text()).toContain('Saved.');
    expect(w.find('[data-testid="reset-namespaces"]').exists()).toBe(true);
    w.unmount();
  });
});
