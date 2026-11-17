// SPDX-License-Identifier: AGPL-3.0-only
// What changed in the dashboard (ADR-199; v0.8 slice 3): the page and the alert card on a
// Kubernetes cluster and a Server fleet, each in its own words; the windows and the demo's
// 24 hours; the states (learning, nothing, error); and the gate: Pro (and the demo) see the
// data, Cloud Free the upgrade page and a locked line to it, Community the upgrade page and no card,
// without asking the backend.
import type { AlertDetail, WhatChanged, WhatChangedRow } from '@watchlog/api-types';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudConfig } from '@/api/cloud';
import WhatChangedAlertCard from '@/components/what-changed/WhatChangedAlertCard.vue';
import {
  clampCustom,
  customBounds,
  metricText,
  objectContext,
  rangeText,
  whatChangedPath,
  whatChangedWindows,
} from '@/lib/what-changed';
import { useAuthStore } from '@/stores/auth';
import WhatChangedPage from '@/views/WhatChangedPage.vue';
import { FLEET } from './docker-fixtures';
import { mockFetch, USER, type Routes } from './fetch-mock';
import { createPlugins } from './helpers';

const NOW = Date.UTC(2026, 10, 17, 14, 10, 0);
const MIN = 60_000;
const nowS = NOW / 1000;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const K8S = {
  ...FLEET,
  id: '01a1de8d-e52d-7188-9878-62ee5fd5309d',
  name: 'acme-prod',
  kind: 'kubernetes',
};
const ALERT_ID = '01a19300-0000-7000-8000-000000000042';
const CONFIG: CloudConfig = {
  signup: true,
  signupMode: 'public',
  providers: { github: false, google: false },
  turnstileSiteKey: null,
  passwordMinLength: 10,
  verifyGraceDays: 7,
  supportEmail: 'support@watchlog.io',
  sampleUrl: 'https://demo.watchlog.io',
};

const row = (over: Partial<WhatChangedRow>): WhatChangedRow =>
  ({
    id: '01a19300-0000-7000-8000-00000000000' + Math.floor(Math.random() * 10),
    since: iso(12 * MIN),
    until: null,
    key: 'workload.cpu.usage',
    unit: 'cores',
    subject: {},
    object: { kind: 'workload', name: 'api', namespace: 'shop', workloadKind: 'Deployment' },
    peer: null,
    usualLow: 0.3,
    usualHigh: 0.5,
    value: 0.9,
    peakScore: 8,
    peakAt: iso(10 * MIN),
    ...over,
  }) as WhatChangedRow;

const K8S_ROWS: WhatChangedRow[] = [
  row({
    id: 'a1',
    since: iso(12 * MIN),
    key: 'edge.connections.rate',
    unit: 'per_second',
    object: {
      kind: 'workload',
      name: 'reports-worker',
      namespace: 'shop',
      workloadKind: 'Deployment',
    },
    peer: 'postgres',
    usualLow: 0,
    usualHigh: 2,
    value: 85,
    peakScore: 40,
  }),
  row({
    id: 'a2',
    since: iso(10 * MIN),
    key: 'workload.http.latency.p95',
    unit: 'seconds',
    object: { kind: 'workload', name: 'checkout', namespace: 'shop', workloadKind: 'Deployment' },
    usualLow: 0.12,
    usualHigh: 0.18,
    value: 2.4,
    peakScore: 90,
  }),
  row({ id: 'a3', since: iso(9 * MIN), peakScore: 6 }),
  row({
    id: 'a4',
    since: iso(8 * MIN),
    key: 'node.cpu.utilization',
    unit: 'ratio',
    object: { kind: 'node', name: 'kind-worker' },
    usualLow: 0.2,
    usualHigh: 0.4,
    value: 0.71,
    until: iso(2 * MIN),
    peakScore: 5,
  }),
];
const DOCKER_ROWS: WhatChangedRow[] = [
  row({
    id: 'd1',
    key: 'container.memory.working_set',
    unit: 'bytes',
    object: {
      kind: 'container',
      name: 'shop-db-1',
      host: 'docker-01',
      composeProject: 'shop',
      composeService: 'db',
    },
    usualLow: 200 * 2 ** 20,
    usualHigh: 260 * 2 ** 20,
    value: 900 * 2 ** 20,
    peakScore: 12,
  }),
  row({
    id: 'd2',
    since: iso(9 * MIN),
    key: 'host.cpu.utilization',
    unit: 'ratio',
    object: { kind: 'host', name: 'docker-01' },
    peakScore: 5,
  }),
];

function answer(
  cluster: typeof K8S,
  rows: WhatChangedRow[],
  over: Partial<WhatChanged> = {},
): WhatChanged {
  return {
    cluster: { id: cluster.id, name: cluster.name, kind: cluster.kind },
    window: { from: iso(60 * MIN), to: iso(0), alert: null },
    sort: 'first',
    chart: {
      from: iso(60 * MIN),
      to: iso(0),
      step: 60,
      counts: Array(60)
        .fill(0)
        .map((_, i) => (i > 47 ? 3 : 0)),
    },
    rows,
    total: rows.length,
    truncated: false,
    learning: { learning: false, since: iso(10 * 86_400_000), until: iso(3 * 86_400_000) },
    cause: {
      subject: rows.length ? 'workload:shop/Deployment/reports-worker' : null,
      likely: null,
    },
    ...over,
  } as WhatChanged;
}

let mounted: VueWrapper | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Edition = 'pro' | 'free' | 'community' | 'demo';
async function open(component: object, path: string, edition: Edition, props: object = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const plugins = await createPlugins(path);
  const auth = useAuthStore();
  auth.user = { ...USER, role: 'viewer' };
  auth.cloud = edition === 'pro' || edition === 'free' ? CONFIG : null;
  auth.demoMode = edition === 'demo';
  const w = mount(component, {
    props,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  mounted = w;
  await flushPromises();
  return { w, plugins };
}

const wc = (cluster: string, q: Parameters<typeof whatChangedPath>[1] = { window: '1h' }) =>
  `GET /api/v1${whatChangedPath(cluster, q, NOW)}`;
const causes = (cluster: string, subject: string) =>
  `GET /api/v1/causes?cluster=${cluster}&subject=${encodeURIComponent(subject)}`;
const notFound = { status: 404, body: { type: 'about:blank', title: 'Not Found', status: 404 } };
const noAlerts = (id: string): Routes => {
  const empty = {
    status: 200,
    body: {
      alerts: [],
      nextCursor: null,
      counts: { firing: 0, critical: 0, warning: 0, pending: 0, silenced: 0, held: 0 },
    },
  };
  return {
    [`GET /api/v1/alerts?view=firing&clusterId=${id}&limit=5`]: empty,
    [`GET /api/v1/alerts?view=history&clusterId=${id}&limit=5`]: empty,
  };
};
const clusters = (c: object): Routes => ({
  'GET /api/v1/clusters': { status: 200, body: { clusters: [c] } },
});

describe('the lib', () => {
  it('offers around the alert only from an alert; every window fits the demo’s 24 hours', () => {
    expect(whatChangedWindows(false)).toEqual(['1h', '6h', 'custom']);
    expect(whatChangedWindows(true)).toEqual(['alert', '1h', '6h', 'custom']);
  });

  it('the custom range: at most 24 hours, not in the future, in the demo within its 24 hours', () => {
    expect(customBounds(false, NOW)).toEqual({ min: null, max: nowS });
    expect(customBounds(true, NOW)).toEqual({ min: nowS - 86_400, max: nowS });
    // Elsewhere: two days back is fine; 30 hours is cut to 24.
    expect(clampCustom(nowS - 49 * 3600, nowS - 48 * 3600, false, NOW)).toEqual({
      from: nowS - 49 * 3600,
      to: nowS - 48 * 3600,
    });
    expect(clampCustom(nowS - 30 * 3600, nowS, false, NOW)).toEqual({
      from: nowS - 86_400,
      to: nowS,
    });
    // The demo: a range two days back is moved into its last 24 hours, never asked for.
    const d = clampCustom(nowS - 49 * 3600, nowS - 48 * 3600, true, NOW)!;
    expect(d.from).toBeGreaterThanOrEqual(nowS - 86_400);
    expect(d.to - d.from).toBeLessThanOrEqual(86_400);
    expect(clampCustom(nowS - 3600, nowS + 3600, true, NOW)).toEqual({
      from: nowS - 3600,
      to: nowS,
    });
  });

  it('the request: the alert, 6 hours, a custom range, the order', () => {
    expect(whatChangedPath('c', { window: '1h' }, NOW)).toBe('/what-changed?cluster=c');
    expect(whatChangedPath('c', { window: '6h' }, NOW)).toBe(
      `/what-changed?cluster=c&from=${nowS - 21_600}`,
    );
    expect(whatChangedPath('c', { window: 'alert', alert: 'a', sort: 'furthest' }, NOW)).toBe(
      '/what-changed?cluster=c&alert=a&sort=furthest',
    );
    expect(whatChangedPath('c', { window: 'custom', from: 1, to: 2 }, NOW)).toBe(
      '/what-changed?cluster=c&from=1&to=2',
    );
  });

  it('words: the usual range with its unit once, the metric, the place in each platform', () => {
    expect(rangeText(0.12, 0.18, 'seconds')).toBe('120–180 ms');
    expect(rangeText(0.3, 0.5, 'cores')).toBe('0.30–0.50 cores');
    expect(rangeText(0, 2, 'per_second')).toBe('0–2/s');
    const tr = (k: string, v?: Record<string, unknown>) => `${k}${v?.peer ? `(${v.peer})` : ''}`;
    expect(metricText({ key: 'edge.connections.rate', peer: 'postgres' }, tr)).toBe(
      'whatChanged.metric.edge_connections_rate(postgres)',
    );
    const named = (k: string) => (k === 'metricNames.redis_ops_rate' ? 'Redis commands/s' : k);
    expect(metricText({ key: 'redis.ops.rate', peer: null }, named)).toBe('Redis commands/s');
    // A key with no name yet reads as the key.
    expect(metricText({ key: 'redis.new.key', peer: null }, named)).toBe('redis.new.key');
    expect(
      objectContext(
        { kind: 'workload', name: 'x', namespace: 'shop', workloadKind: 'Deployment' },
        tr,
      ),
    ).toBe('shop · Deployment');
    expect(objectContext({ kind: 'host', name: 'h' }, tr)).toBe('whatChanged.context.host');
  });
});

describe('the page on a Pro org', () => {
  it('Kubernetes: the chart, the rows first to move, then furthest out, the cause underneath', async () => {
    const subject = 'workload:shop/Deployment/reports-worker';
    const { calls } = mockFetch({
      ...clusters(K8S),
      [wc(K8S.id)]: { status: 200, body: answer(K8S, K8S_ROWS) },
      [wc(K8S.id, { window: '1h', sort: 'furthest' })]: {
        status: 200,
        body: answer(K8S, [K8S_ROWS[1]!, K8S_ROWS[0]!, K8S_ROWS[2]!, K8S_ROWS[3]!], {
          sort: 'furthest',
        }),
      },
      [causes(K8S.id, subject)]: notFound,
    });
    const { w, plugins } = await open(WhatChangedPage, `/what-changed?cluster=${K8S.id}`, 'pro');
    expect(w.get('[data-testid="wc-cluster"]').text()).toContain('acme-prod');
    expect(w.get('[data-testid="wc-cluster"]').text()).toContain('Kubernetes');
    expect(w.findAll('[data-testid="wc-windows"] button').map((b) => b.text())).toEqual([
      'Last hour',
      'Last 6 hours',
      'Custom',
    ]);
    expect(w.find('[data-testid="wc-chart"] svg').attributes('aria-label')).toContain('At most 3');
    const rows = w.findAll('[data-testid="wc-row"]');
    expect(rows).toHaveLength(4);
    expect(rows[0]!.text()).toContain('reports-worker');
    expect(rows[0]!.get('[data-testid="wc-metric"]').text()).toBe('connections to postgres');
    expect(rows[0]!.get('[data-testid="wc-context"]').text()).toBe('shop · Deployment');
    expect(rows[0]!.get('[data-testid="wc-usual"]').text()).toContain('0–2/s');
    expect(rows[0]!.get('[data-testid="wc-now"]').text()).toContain('85/s');
    expect(rows[1]!.get('[data-testid="wc-metric"]').text()).toBe('p95 response time');
    expect(rows[1]!.get('[data-testid="wc-now"]').text()).toContain('2.4 s');
    expect(rows[3]!.get('[data-testid="wc-context"]').text()).toBe('node');
    expect(w.get('[data-testid="wc-count"]').text()).toMatch(
      /^4 things left their usual range between/,
    );
    expect(w.find('[data-testid="wc-cause"]').exists()).toBe(true);
    expect(w.get('[data-testid="wc-footnote"]').text()).toContain('nothing is sent to an AI');

    await w.get('[data-testid="wc-sort-furthest"]').trigger('click');
    await flushPromises();
    expect(plugins.router.currentRoute.value.query.sort).toBe('furthest');
    expect(calls.some((c) => c.path.includes('sort=furthest'))).toBe(true);
    expect(w.findAll('[data-testid="wc-name"]')[0]!.text()).toBe('checkout');
  });

  it('Docker: Compose services, their containers and hosts in the fleet’s words', async () => {
    mockFetch({
      ...clusters(FLEET),
      [wc(FLEET.id)]: {
        status: 200,
        body: answer(FLEET, DOCKER_ROWS, {
          cause: { subject: 'container:docker-01/shop-db-1', likely: null },
        }),
      },
      [causes(FLEET.id, 'container:docker-01/shop-db-1')]: notFound,
    });
    const { w } = await open(WhatChangedPage, `/what-changed?cluster=${FLEET.id}`, 'pro');
    expect(w.get('[data-testid="wc-cluster"]').text()).toContain('Docker');
    const rows = w.findAll('[data-testid="wc-row"]');
    expect(rows[0]!.get('[data-testid="wc-name"]').text()).toBe('db');
    expect(rows[0]!.get('[data-testid="wc-metric"]').text()).toBe('memory');
    expect(rows[0]!.get('[data-testid="wc-context"]').text()).toBe('Compose shop · shop-db-1');
    expect(rows[0]!.get('[data-testid="wc-usual"]').text()).toContain('200–260 MiB');
    expect(rows[1]!.get('[data-testid="wc-context"]').text()).toBe('host');
  });

  it('around an alert: the window named by its start, asked by the alert', async () => {
    mockFetch({
      ...clusters(K8S),
      [wc(K8S.id, { window: 'alert', alert: ALERT_ID })]: {
        status: 200,
        body: answer(K8S, K8S_ROWS, {
          window: {
            from: iso(80 * MIN),
            to: iso(5 * MIN),
            alert: { id: ALERT_ID, startedAt: '2026-11-17T14:02:00Z' },
          },
          cause: { subject: `alert:${ALERT_ID}`, likely: null },
        }),
      },
      [causes(K8S.id, `alert:${ALERT_ID}`)]: notFound,
    });
    const { w } = await open(
      WhatChangedPage,
      `/what-changed?cluster=${K8S.id}&alert=${ALERT_ID}`,
      'pro',
    );
    const buttons = w.findAll('[data-testid="wc-windows"] button');
    expect(buttons[0]!.text()).toMatch(/^Around the \d\d:\d\d alert$/);
    expect(buttons[0]!.attributes('aria-pressed')).toBe('true');
    expect(w.find('[data-testid="wc-window"]').exists()).toBe(true);
  });

  it('states: learning with its date, nothing in the window, an error with retry, "and N more"', async () => {
    mockFetch({
      ...clusters(K8S),
      [wc(K8S.id)]: [
        {
          status: 200,
          body: answer(K8S, [], {
            learning: { learning: true, since: iso(86_400_000), until: '2026-11-23T14:00:00Z' },
          }),
        },
      ],
    });
    let { w } = await open(WhatChangedPage, `/what-changed?cluster=${K8S.id}`, 'pro');
    expect(w.get('[data-testid="wc-learning"]').text()).toContain(
      "Learning acme-prod's usual week until",
    );
    expect(w.find('[data-testid="wc-row"]').exists()).toBe(false);
    expect(w.find('[data-testid="wc-cause"]').exists()).toBe(false);
    mounted!.unmount();

    mockFetch({ ...clusters(FLEET), [wc(FLEET.id)]: { status: 200, body: answer(FLEET, []) } });
    ({ w } = await open(WhatChangedPage, `/what-changed?cluster=${FLEET.id}`, 'pro'));
    expect(w.get('[data-testid="wc-empty"]').text()).toContain(
      'No container, Compose service, host',
    );
    mounted!.unmount();

    mockFetch({
      ...clusters(K8S),
      [wc(K8S.id)]: [
        { status: 500, body: { type: 'about:blank', title: 'Error', status: 500 } },
        { status: 200, body: answer(K8S, K8S_ROWS.slice(0, 1), { total: 51, truncated: true }) },
      ],
      [causes(K8S.id, 'workload:shop/Deployment/reports-worker')]: notFound,
    });
    ({ w } = await open(WhatChangedPage, `/what-changed?cluster=${K8S.id}`, 'pro'));
    expect(w.text()).toContain("Couldn't load What changed.");
    await w.get('[data-testid="retry"]').trigger('click');
    await flushPromises();
    expect(w.get('[data-testid="wc-more"]').text()).toBe('and 50 more');
  });
});

describe('the gate', () => {
  it('Cloud Free: the upgrade page, both kinds, after the 403', async () => {
    for (const c of [K8S, FLEET]) {
      mockFetch({
        ...clusters(c),
        [wc(c.id)]: {
          status: 403,
          body: {
            type: 'urn:watchlog:problem:pro-feature',
            title: 'Forbidden',
            status: 403,
            detail: 'What changed is part of Pro',
          },
        },
        ...noAlerts(c.id),
        'GET /api/v1/plan': { status: 404 },
        'GET /api/v1/users': {
          status: 200,
          body: { users: [], invites: [], smtp: false, audit: [] },
        },
      });
      const { w } = await open(WhatChangedPage, `/what-changed?cluster=${c.id}`, 'free');
      expect(w.get('[data-testid="wc-upgrade"]').attributes('data-access')).toBe('free');
      expect(w.find('[data-testid="wc-hero"]').exists()).toBe(false);
      mounted!.unmount();
      mounted = null;
    }
  });

  it('Community: the upgrade page, both kinds, and What changed is never asked', async () => {
    for (const c of [K8S, FLEET]) {
      const { calls } = mockFetch({ ...clusters(c), ...noAlerts(c.id) });
      const { w } = await open(WhatChangedPage, `/what-changed?cluster=${c.id}`, 'community');
      expect(w.get('[data-testid="wc-upgrade"]').attributes('data-access')).toBe('community');
      expect(w.text()).toContain('WatchLog Cloud Pro');
      expect(calls.some((x) => x.path.includes('what-changed'))).toBe(false);
      mounted!.unmount();
      mounted = null;
    }
  });
});

describe('the demo', () => {
  it('Kubernetes and Docker: the windows it allows; a custom range two days back is asked within 24 hours', async () => {
    for (const c of [K8S, FLEET]) {
      const from = nowS - 49 * 3600;
      const to = nowS - 48 * 3600;
      const clamped = clampCustom(from, to, true, NOW)!;
      const { calls } = mockFetch({
        ...clusters(c),
        [wc(c.id, { window: 'custom', ...clamped })]: { status: 200, body: answer(c, []) },
      });
      const { w } = await open(
        WhatChangedPage,
        `/what-changed?cluster=${c.id}&window=custom&from=${from}&to=${to}`,
        'demo',
      );
      expect(w.findAll('[data-testid="wc-windows"] button')).toHaveLength(3);
      const asked = calls.find((x) => x.path.includes('what-changed'))!;
      const f = Number(new URL(asked.path, 'http://x').searchParams.get('from'));
      expect(f).toBeGreaterThanOrEqual(nowS - 86_400);
      expect(w.get('[data-testid="wc-custom"]').text()).toContain(
        "Within the demo's last 24 hours.",
      );
      expect(w.get('[data-testid="wc-custom-from"]').attributes('min')).toBeTruthy();
      mounted!.unmount();
      mounted = null;
    }
  });
});

describe('"What changed around it" on an alert', () => {
  const alert = (cluster: typeof K8S) =>
    ({
      id: ALERT_ID,
      title: 'x',
      state: 'firing',
      severity: 'warning',
      startedAt: iso(20 * MIN),
      cluster: { id: cluster.id, name: cluster.name, kind: cluster.kind },
    }) as unknown as AlertDetail['alert'];
  const path = (c: typeof K8S) => wc(c.id, { window: 'alert', alert: ALERT_ID });

  it('Kubernetes and Docker on Pro: the first three rows and a link to the page around it', async () => {
    for (const [c, rows] of [
      [K8S, K8S_ROWS],
      [FLEET, DOCKER_ROWS],
    ] as const) {
      mockFetch({ [path(c)]: { status: 200, body: answer(c, [...rows]) } });
      const { w } = await open(WhatChangedAlertCard, '/alerts', 'pro', { alert: alert(c) });
      expect(w.get('[data-testid="wc-card"]').text()).toContain('What changed around it');
      expect(w.findAll('[data-testid="wc-row"]')).toHaveLength(Math.min(3, rows.length));
      const link = w.get('[data-testid="wc-card-link"]');
      expect(link.attributes('href')).toBe(`/what-changed?cluster=${c.id}&alert=${ALERT_ID}`);
      expect(link.text()).toContain(`${rows.length} thing`);
      if (rows.length > 3) expect(w.get('[data-testid="wc-card-more"]').text()).toBe('and 1 more');
      mounted!.unmount();
      mounted = null;
    }
  });

  it('nothing around it, and learning', async () => {
    mockFetch({ [path(FLEET)]: { status: 200, body: answer(FLEET, []) } });
    let { w } = await open(WhatChangedAlertCard, '/alerts', 'demo', { alert: alert(FLEET) });
    expect(w.get('[data-testid="wc-card-empty"]').text()).toContain('in this fleet');
    mounted!.unmount();
    mockFetch({
      [path(K8S)]: {
        status: 200,
        body: answer(K8S, [], { learning: { learning: true, since: null, until: null } }),
      },
    });
    ({ w } = await open(WhatChangedAlertCard, '/alerts', 'pro', { alert: alert(K8S) }));
    expect(w.get('[data-testid="wc-card-learning"]').text()).toContain('starts within a minute');
    expect(w.find('[data-testid="wc-card-link"]').exists()).toBe(false);
  });

  it('Cloud Free: one locked line to the page; Community: no card and no request', async () => {
    mockFetch({
      [path(K8S)]: {
        status: 403,
        body: { type: 'urn:watchlog:problem:pro-feature', title: 'Forbidden', status: 403 },
      },
    });
    let { w } = await open(WhatChangedAlertCard, '/alerts', 'free', { alert: alert(K8S) });
    expect(w.get('[data-testid="wc-card-locked"]').attributes('href')).toBe(
      `/what-changed?cluster=${K8S.id}`,
    );
    expect(w.find('[data-testid="wc-card"]').exists()).toBe(false);
    mounted!.unmount();
    const { calls } = mockFetch({});
    ({ w } = await open(WhatChangedAlertCard, '/alerts', 'community', { alert: alert(FLEET) }));
    expect(w.html()).not.toContain('wc-card');
    expect(calls).toHaveLength(0);
  });
});
