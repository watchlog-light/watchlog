// SPDX-License-Identifier: AGPL-3.0-only
// Add a source (1.0.3): the question and which way opens first; a token made inline, shown
// once and kept out of the address and of storage; the push command filled in for a fleet's
// server and for a cluster's workload, in every language; "Test" with each of its answers;
// what Find tried and the ways forward when it found nothing; waiting, the first value and
// the two-minute checklist on an injected clock; the test value and its removal; a Viewer,
// the demo and Cloud Free.
import type { OwnAddressTest, OwnFound, OwnMetricsSummary, OwnReceived } from '@watchlog/api-types';
import { PUSH_LANGS } from '@watchlog/snippets';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FirstValue from '@/components/own-metrics/add/FirstValue.vue';
import { firstWay, kindOfName, nameOk, portsText, pushOwner, valueOk } from '@/lib/own-add';
import { useAuthStore } from '@/stores/auth';
import YourMetricsAddPage from '@/views/YourMetricsAddPage.vue';
import { FLEET } from './docker-fixtures';
import { mockFetch, problem, USER, type Routes } from './fetch-mock';
import { chooseOption, createPlugins, optionsOf } from './helpers';

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const KUBE = {
  ...FLEET,
  id: '01a18f42-06e7-7078-a01a-ea39c791d700',
  name: 'prod',
  kind: 'kubernetes',
};
const TOKEN = {
  id: '01a18f42-06e7-7078-a01a-ea39c791d7aa',
  name: 'my first metrics',
  prefix: '9fK2',
  value: 'wl_mt_9fK2xQ7vB4mT1pZ8cL3w',
};

const summary = (over: Partial<OwnMetricsSummary> = {}): OwnMetricsSummary => ({
  usage: { series: 0, sources: 0 },
  limits: {
    series: 1000,
    seriesPerSource: 500,
    sources: null,
    dashboards: 50,
    widgetsPerDashboard: 24,
    alerts: 'all',
    usualRange: true,
    watched: 50,
  },
  sources: [],
  tokens: [],
  metrics: 0,
  hidden: 0,
  settings: { prometheusAnnotations: false },
  kind: 'server',
  servers: ['web-1'],
  workloads: [],
  endpoint: 'https://ingest.watchlog.example',
  ...over,
});
const kubeSummary = (over: Partial<OwnMetricsSummary> = {}) =>
  summary({
    kind: 'kubernetes',
    servers: [],
    workloads: [
      { namespace: 'shop', kind: 'Deployment', name: 'orders' },
      { namespace: 'shop', kind: 'StatefulSet', name: 'db' },
    ],
    ...over,
  });
const found = (over: Partial<OwnFound> = {}): OwnFound => ({
  id: 'f1',
  done: true,
  asked: 3,
  tried: { ports: [80, 3000, 8080], skipped: [22, 5432], scraped: 0, workloads: 0 },
  found: [],
  ...over,
});
const ONE_FOUND = found({
  found: [
    {
      series: 214,
      names: ['http_requests_total'],
      add: { kind: 'address', server: 'web-1', address: 'localhost:9100/metrics', workload: '' },
    },
  ],
});

const baseOf = (c: { id: string }) => `/api/v1/clusters/${c.id}/own-metrics`;
const tid = (id: string) => `[data-testid="${id}"]`;

async function open(
  routes: Routes,
  o: { cluster?: typeof FLEET; path?: string; role?: string; demo?: boolean } = {},
) {
  const cluster = o.cluster ?? FLEET;
  const m = mockFetch({
    'GET /api/v1/clusters': { status: 200, body: { clusters: [cluster] } },
    ...routes,
  });
  const plugins = await createPlugins(o.path ?? '/your-metrics/add');
  useAuthStore().user = { ...USER, role: (o.role ?? 'owner') as 'owner' };
  useAuthStore().demoMode = o.demo ?? false;
  const w = mount(YourMetricsAddPage, {
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    attachTo: document.body,
  });
  await flushPromises();
  await flushPromises();
  return { w, router: plugins.router, ...m };
}
const panelOf = (w: VueWrapper) =>
  w.find('[role="tabpanel"]').attributes('data-testid')?.replace('own-add-panel-', '');
const base = baseOf(FLEET);
const fleetRoutes = (s = summary(), f: OwnFound | null = found()): Routes => ({
  [`GET ${base}`]: { status: 200, body: s },
  [`GET ${base}/find`]: f ? { status: 200, body: f } : problem(404, 'No search is running'),
  ...(f ? {} : { [`POST ${base}/find`]: { status: 202, body: found() } }),
});

describe('which way opens first', () => {
  it('the rule: the link, else the last choice, else Expose when something was found, else Push', () => {
    expect(firstWay({ query: undefined, remembered: null, found: null })).toBe('push');
    expect(firstWay({ query: undefined, remembered: null, found: found() })).toBe('push');
    expect(firstWay({ query: undefined, remembered: null, found: ONE_FOUND })).toBe('scrape');
    expect(firstWay({ query: undefined, remembered: 'prometheus', found: ONE_FOUND })).toBe(
      'prometheus',
    );
    expect(firstWay({ query: 'push', remembered: 'prometheus', found: ONE_FOUND })).toBe('push');
    expect(firstWay({ query: 'nonsense', remembered: null, found: null })).toBe('push');
  });

  it('nothing found here: Push opens, with the question above it in its order', async () => {
    const { w, calls } = await open(fleetRoutes(summary(), null));
    expect(panelOf(w)).toBe('push');
    const q = w.get(tid('own-chooser'));
    expect(q.text()).toContain('Where is your number?');
    expect(q.findAll('button').map((b) => b.attributes('data-testid'))).toEqual([
      'own-choose-push',
      'own-choose-scrape',
      'own-choose-prometheus',
    ]);
    expect(q.get(tid('own-choose-push')).text()).toContain(
      'In a script, a cron job, my CI, or my own code',
    );
    expect(q.get(tid('own-choose-push')).text()).toContain('Simplest: one command');
    expect(q.get(tid('own-choose-push')).attributes('aria-pressed')).toBe('true');
    expect(w.findAll('[role="tab"][data-testid^="own-add-way-"]').map((t) => t.text())).toEqual([
      'Push a value',
      'Expose /metrics',
      'Send from Prometheus',
    ]);
    // The search ran quietly: asked for what is held, then started.
    expect(calls.filter((c) => c.path === `${base}/find`).map((c) => c.method)).toEqual([
      'GET',
      'POST',
    ]);
    // Opening by itself chooses nothing for next time and writes nothing to the address.
    expect(localStorage.getItem('watchlog.ownAdd.way')).toBeNull();
  });

  it('an endpoint found here: Expose opens with it listed, and the question says so', async () => {
    const { w } = await open(fleetRoutes(summary(), ONE_FOUND));
    expect(panelOf(w)).toBe('scrape');
    expect(w.get(tid('own-choose-found')).text()).toBe('1 found here');
    expect(w.get(tid('own-found')).text()).toContain('web-1 :9100/metrics');
    expect(w.get(tid('own-found')).text()).toContain('214 series');
  });

  it('the user’s own choice is remembered and opens next time, even with an endpoint found', async () => {
    const first = await open(fleetRoutes(summary(), ONE_FOUND));
    await first.w.get(tid('own-choose-prometheus')).trigger('click');
    await flushPromises();
    expect(panelOf(first.w)).toBe('prometheus');
    expect(first.router.currentRoute.value.query.way).toBe('prometheus');
    expect(localStorage.getItem('watchlog.ownAdd.way')).toBe('prometheus');
    first.w.unmount();
    vi.unstubAllGlobals();
    const again = await open(fleetRoutes(summary(), ONE_FOUND));
    expect(panelOf(again.w)).toBe('prometheus');
    // A link that names a way wins over both.
    again.w.unmount();
    vi.unstubAllGlobals();
    const linked = await open(fleetRoutes(summary(), ONE_FOUND), {
      path: '/your-metrics/add?way=push',
    });
    expect(panelOf(linked.w)).toBe('push');
  });
});

describe('Push a value', () => {
  it('a token is made right here, shown once, and filled into the command', async () => {
    const { w, calls, router } = await open({
      ...fleetRoutes(),
      [`POST ${base}/tokens`]: { status: 201, body: TOKEN },
      [`GET ${base}/tokens/${TOKEN.id}/received`]: {
        status: 200,
        body: { now: 1, received: null },
      },
    });
    const step = w.get(tid('own-token-step'));
    expect((step.get('input').element as HTMLInputElement).value).toBe('my first metrics');
    expect(step.get(tid('own-token-make')).text()).toBe('Create a token');
    // Before a token: the placeholder, and what to do about it.
    expect(w.get(tid('own-push-code')).text()).toContain('Bearer wl_mt_…');
    expect(w.get(tid('own-token-hint')).text()).toBe('Create a token to fill this in.');
    expect(w.find(tid('own-first')).exists()).toBe(false);

    await step.get(tid('own-token-inline')).trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST' && c.path === `${base}/tokens`)!.body).toEqual({
      name: 'my first metrics',
    });
    expect(w.get(tid('own-token-value')).text()).toBe(TOKEN.value);
    expect(w.get(tid('own-token-made')).text()).toContain(
      'Shown once. It can only send, never read.',
    );
    expect(w.get(tid('own-push-code')).text()).toContain(`Bearer ${TOKEN.value}`);
    expect(w.find(tid('own-token-hint')).exists()).toBe(false);
    expect(w.get(tid('own-first-waiting')).text()).toContain('Waiting for your first value…');
    // The value lives in the page only: not in the address, not in storage.
    expect(JSON.stringify(router.currentRoute.value.query)).not.toContain('wl_mt_');
    expect(
      JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    ).not.toContain('wl_mt_');
    // It carries over to Send from Prometheus.
    await w.get(tid('own-add-way-prometheus')).trigger('click');
    await flushPromises();
    expect(w.get(tid('own-prometheus-code')).text()).toContain(`credentials: ${TOKEN.value}`);
    expect(w.get(tid('own-prometheus-code')).text()).toContain(
      'url: https://ingest.watchlog.example/ingest/v1/write',
    );
    expect(w.get(tid('own-first-waiting')).text()).toContain('Waiting for your first samples…');
  });

  it('with tokens already: says an old one can’t be shown again, and offers another', async () => {
    const old = {
      id: 'old-1',
      name: 'ci and cron',
      prefix: 'ab12',
      createdAt: 1,
      lastUsedAt: null,
    };
    const { w, calls } = await open({
      ...fleetRoutes(summary({ tokens: [old] })),
      [`POST ${base}/tokens`]: problem(409, 'A token with this name exists; pick another name'),
      [`GET ${base}/tokens/old-1/received`]: { status: 200, body: { now: 5000, received: null } },
    });
    const have = w.get(tid('own-token-have'));
    expect(have.text()).toContain('You have 1 token here (ci and cron).');
    expect(have.text()).toContain("can't be shown again");
    expect(w.get(tid('own-token-make')).text()).toBe('Create another');
    // The one they will use can be chosen, so the page can say when its value arrives.
    await chooseOption(w, 'own-token-watch', 'ci and cron');
    await flushPromises();
    expect(w.find(tid('own-first-waiting')).exists()).toBe(true);
    expect(calls.some((c) => c.path === `${base}/tokens/old-1/received`)).toBe(true);
    expect(w.get(tid('own-push-code')).text()).toContain('wl_mt_…');
    // The server's own words on a mistake.
    await w.get(tid('own-token-inline')).trigger('submit');
    await flushPromises();
    expect(w.get(tid('own-token-error')).text()).toBe(
      'A token with this name exists; pick another name',
    );
  });

  it('on a fleet: the one server is chosen, and the command follows the name and the value', async () => {
    const { w } = await open(fleetRoutes());
    const code = () => w.get(tid('own-push-code')).text();
    expect(code()).toContain('curl -sS -X POST https://ingest.watchlog.example/ingest/v1/metrics');
    expect(code()).toContain(`-d '{"name": "orders_total", "value": 1, "server": "web-1"}'`);
    expect(w.get(tid('own-push-kind-counter')).attributes('aria-current')).toBe('true');
    expect(w.get(tid('own-push-kinds')).text()).toContain(
      'Ends in _total: a counter. Each push adds up.',
    );
    expect(w.get(tid('own-push-kinds')).text()).toContain(
      'Anything else: a gauge. The last value wins.',
    );

    await w.get(`${tid('own-push-name')} input`).setValue('queue_jobs_waiting');
    await w.get(`${tid('own-push-value')} input`).setValue('12');
    expect(code()).toContain('{"name": "queue_jobs_waiting", "value": 12, "server": "web-1"}');
    expect(w.get(tid('own-push-kind-gauge')).attributes('aria-current')).toBe('true');
    // What isn't a name or a number is said, and never reaches the command.
    await w.get(`${tid('own-push-name')} input`).setValue('2 bad name');
    await w.get(`${tid('own-push-value')} input`).setValue('twelve');
    expect(w.get(tid('own-push-name')).text()).toContain(
      'A name is letters, digits and underscores',
    );
    expect(w.get(tid('own-push-value')).text()).toContain('A value is a number');
    expect(code()).toContain('{"name": "orders_total", "value": 1, "server": "web-1"}');

    // Every language, with the same address, name and owner.
    await w.get(`${tid('own-push-name')} input`).setValue('orders_total');
    for (const lang of PUSH_LANGS) {
      await w.get(tid(`own-push-lang-${lang}`)).trigger('click');
      expect(code(), lang).toContain('https://ingest.watchlog.example/ingest/v1/metrics');
      expect(code(), lang).toContain('orders_total');
      expect(code(), lang).toContain('web-1');
      expect(w.get(tid(`own-push-lang-${lang}`)).attributes('aria-selected')).toBe('true');
    }
    // The timestamp example: the clock's value, in the cron script.
    await w.get(tid('own-push-timestamp')).trigger('click');
    expect(code()).toContain('backup_last_success_timestamp_seconds');
    expect(code()).toContain('value=$(date +%s)');
    expect(w.get(tid('own-push-kind-timestamp')).attributes('aria-current')).toBe('true');
  });

  it('in a cluster: a workload is chosen from a searchable list, named as namespace/name', async () => {
    const kb = baseOf(KUBE);
    const { w } = await open(
      {
        [`GET ${kb}`]: { status: 200, body: kubeSummary() },
        [`GET ${kb}/find`]: { status: 200, body: found() },
      },
      { cluster: KUBE },
    );
    expect(w.get(tid('own-push')).text()).toContain('Workload it belongs to');
    expect(w.get(tid('own-push-code')).text()).toContain(
      `-d '{"name": "orders_total", "value": 1}'`,
    );
    expect(await optionsOf(w, 'own-push-owner')).toEqual([
      'shop/ordersDeployment',
      'shop/dbStatefulSet',
    ]);
    await chooseOption(w, 'own-push-owner', 'shop/orders');
    expect(w.get(tid('own-push-code')).text()).toContain(
      `-d '{"name": "orders_total", "value": 1, "workload": "shop/orders"}'`,
    );
  });

  it('“Send a test value for me” makes the token first, then says what arrived; it can be removed', async () => {
    const got: OwnReceived = {
      now: 10_000,
      received: {
        at: Date.now(),
        way: 'push',
        metricId: 'm-1',
        name: 'my_first_test_value',
        owner: { kind: 'server', namespace: '', workloadKind: '', name: 'web-1' },
        value: 1,
        series: 1,
        metrics: 1,
      },
    };
    const { w, calls } = await open({
      ...fleetRoutes(),
      [`POST ${base}/tokens`]: { status: 201, body: TOKEN },
      [`GET ${base}/tokens/${TOKEN.id}/received`]: [
        { status: 200, body: { now: 1, received: null } },
        { status: 200, body: got },
      ],
      [`GET ${base}/tokens/${TOKEN.id}/received?since=0`]: { status: 200, body: got },
      [`POST ${base}/test-value`]: {
        status: 200,
        body: { name: 'my_first_test_value', value: 1, stored: true },
      },
      [`DELETE ${base}/test-value`]: { status: 204 },
    });
    await w.get(tid('own-push-test')).trigger('click');
    await flushPromises();
    await flushPromises();
    expect(calls.find((c) => c.path === `${base}/test-value`)!.body).toEqual({
      tokenId: TOKEN.id,
      server: 'web-1',
    });
    const done = w.get(tid('own-first-received'));
    expect(done.get(tid('own-first-headline')).text()).toBe('Received my_first_test_value = 1');
    expect(done.text()).toContain('for web-1, a moment ago');
    expect(done.text()).toContain('This is the test value the page sent.');
    expect(done.get(tid('own-first-open')).attributes('href')).toContain('metric=m-1');
    expect(done.get(tid('own-first-dashboard')).attributes('href')).toContain('add=dashboard');
    expect(done.get(tid('own-first-alert')).attributes('href')).toContain('tab=alerts&alert=m-1');
    // The token it made is shown, to be used by the user's own command next.
    expect(w.get(tid('own-token-value')).text()).toBe(TOKEN.value);

    await done.get(tid('own-first-remove')).trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `${base}/test-value`)).toBe(true);
    expect(w.find(tid('own-first-received')).exists()).toBe(false);
    expect(w.get(tid('own-first-waiting')).text()).toContain('The test value is removed.');
  });

  it('a test value the plan has no room for says why', async () => {
    const free = summary({
      limits: { ...summary().limits, series: 200, sources: 3, alerts: 'none' },
      usage: { series: 12, sources: 3 },
      tokens: [],
    });
    const { w } = await open({
      ...fleetRoutes(free),
      [`POST ${base}/tokens`]: { status: 201, body: TOKEN },
      [`GET ${base}/tokens/${TOKEN.id}/received`]: {
        status: 200,
        body: { now: 1, received: null },
      },
      [`GET ${base}/tokens/${TOKEN.id}/received?since=0`]: {
        status: 200,
        body: { now: 2, received: null },
      },
      [`POST ${base}/test-value`]: {
        status: 200,
        body: { name: 'my_first_test_value', value: 1, stored: false, refused: 'sources' },
      },
    });
    await w.get(tid('own-push-test')).trigger('click');
    await flushPromises();
    await flushPromises();
    expect(w.get(tid('own-first-refused')).text()).toContain(
      "your plan's 3 sources are all in use",
    );
  });
});

describe('waiting for the first value (the clock is the test’s)', () => {
  async function waiting(routes: Routes, props: object = {}) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let clock = 1_000_000;
    const m = mockFetch(routes);
    const plugins = await createPlugins('/your-metrics/add');
    useAuthStore().user = { ...USER, role: 'owner' };
    const w = mount(FirstValue, {
      props: {
        cluster: FLEET.id,
        summary: summary(),
        tokenId: TOKEN.id,
        fresh: true,
        way: 'push',
        now: () => clock,
        everyMs: 4000,
        ...props,
      },
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
      attachTo: document.body,
    });
    await flushPromises();
    const tick = async (ms: number) => {
      clock += ms;
      // The poll's own spread is ±20 %: a step past it.
      await vi.advanceTimersByTimeAsync(ms);
      await flushPromises();
    };
    return { w, tick, ...m };
  }
  const received = (over: object = {}): OwnReceived => ({
    now: 1_000_000,
    received: {
      at: 1_009_000,
      way: 'push',
      metricId: 'm-7',
      name: 'orders_total',
      owner: { kind: 'server', namespace: '', workloadKind: '', name: 'web-1' },
      value: 1,
      series: 1,
      metrics: 1,
      ...over,
    },
  });
  const path = `${base}/tokens/${TOKEN.id}/received`;

  it('waits, asks every few seconds, then says what arrived and for what', async () => {
    const { w, tick, calls } = await waiting({
      [`GET ${path}`]: { status: 200, body: { now: 1_000_000, received: null } },
      [`GET ${path}?since=0`]: [
        { status: 200, body: { now: 1_005_000, received: null } },
        { status: 200, body: received() },
        { status: 200, body: received() },
      ],
    });
    expect(w.get(tid('own-first-waiting')).text()).toContain('Waiting for your first value…');
    expect(w.get(tid('own-first-waiting')).text()).toContain('within a few seconds of the command');
    await tick(5000);
    expect(w.find(tid('own-first-received')).exists()).toBe(false);
    await tick(5000);
    expect(w.get(tid('own-first-headline')).text()).toBe('Received orders_total = 1');
    expect(w.get(tid('own-first-received')).text()).toContain('for web-1, a moment ago');
    expect(w.find(tid('own-first-remove')).exists()).toBe(false);
    expect(w.emitted('changed')).toHaveLength(1);
    expect(calls.filter((c) => c.path.startsWith(path)).length).toBeGreaterThanOrEqual(3);
  });

  it('after two minutes with nothing: what to check, with the address and the status codes', async () => {
    const { w, tick } = await waiting({
      [`GET ${path}`]: { status: 200, body: { now: 1_000_000, received: null } },
      [`GET ${path}?since=0`]: { status: 200, body: { now: 1_000_000, received: null } },
    });
    await tick(110_000);
    expect(w.find(tid('own-first-late')).exists()).toBe(false);
    await tick(15_000);
    const late = w.get(tid('own-first-late')).text();
    expect(late).toContain('Nothing has arrived in two minutes.');
    expect(late).toContain('it starts with wl_mt_');
    expect(late).toContain('https://ingest.watchlog.example is reachable from the machine');
    for (const code of ['401:', '400:', '429:']) expect(late).toContain(code);
    expect(w.find(tid('own-first-waiting')).exists()).toBe(true);
  });

  it('an older token: only what arrives from now on counts', async () => {
    const { w, tick, calls } = await waiting(
      {
        [`GET ${path}`]: { status: 200, body: received({ at: 900_000 }) },
        [`GET ${path}?since=1000000`]: [
          { status: 200, body: { now: 1_004_000, received: null } },
          {
            status: 200,
            body: received({ at: 1_008_000, name: 'queue_jobs_waiting', value: null }),
          },
        ],
      },
      { fresh: false },
    );
    // What it sent last week isn't a first value.
    expect(w.find(tid('own-first-received')).exists()).toBe(false);
    await tick(5000);
    await tick(5000);
    expect(w.get(tid('own-first-headline')).text()).toBe('Received queue_jobs_waiting');
    expect(calls.some((c) => c.path === `${path}?since=1000000`)).toBe(true);
  });

  it('remote write says how many series of how many metrics; Free has no “Alert on it”', async () => {
    const { w } = await waiting(
      {
        [`GET ${path}`]: {
          status: 200,
          body: received({
            way: 'remote_write',
            value: null,
            series: 214,
            metrics: 12,
            owner: { kind: '', namespace: '', workloadKind: '', name: '' },
          }),
        },
      },
      { way: 'prometheus', summary: summary({ limits: { ...summary().limits, alerts: 'none' } }) },
    );
    expect(w.get(tid('own-first-headline')).text()).toBe(
      'Received 214 series of 12 metrics, for example orders_total',
    );
    expect(w.get(tid('own-first-received')).text()).toContain('not tied to a server or workload');
    expect(w.find(tid('own-first-alert')).exists()).toBe(false);
    expect(w.get(tid('own-first-alert-locked')).text()).toBe(
      "Alerts on your own metrics aren't part of the Free plan.",
    );
  });
});

describe('Expose /metrics', () => {
  const OUTCOMES: [Partial<OwnAddressTest>, string][] = [
    [
      {
        outcome: 'answered',
        series: 214,
        names: ['http_requests_total', 'queue_jobs_waiting', 'x'],
      },
      'Answered: 214 series, for example http_requests_total, queue_jobs_waiting.',
    ],
    [{ outcome: 'refused' }, 'Nothing is listening on that port.'],
    [{ outcome: 'html' }, 'It answered, but not with metrics (it looks like HTML).'],
    [
      { outcome: 'auth', detail: '401' },
      "It asks for a password (401), which scraping can't send yet: use Push or remote write for this one.",
    ],
    [{ outcome: 'slow' }, 'Too slow: no answer within 10 seconds.'],
    [{ outcome: 'big' }, 'Too big: the page is larger than 5 MB'],
    [
      { outcome: 'not_metrics' },
      'It answered, but not with metrics: nothing in the answer reads as the Prometheus text format.',
    ],
    [{ outcome: 'status', detail: '404' }, 'It answered 404, not a metrics page.'],
    [
      { outcome: 'silent' },
      "The collector there didn't answer the test. It needs the 1.0.3 collector",
    ],
    [{ outcome: 'something_new', detail: 'EOF' }, "It couldn't be read: EOF"],
  ];
  for (const [answer, words] of OUTCOMES) {
    it(`Test says “${answer.outcome}” in words`, async () => {
      const { w, calls } = await open(
        {
          ...fleetRoutes(),
          [`POST ${base}/test`]: {
            status: 202,
            body: { id: 't1', done: true, address: 'localhost:9400/metrics', ...answer },
          },
        },
        { path: '/your-metrics/add?way=scrape' },
      );
      await w.get(`${tid('own-address-input')} input`).setValue('localhost:9400');
      await w.get(tid('own-address-test')).trigger('click');
      await flushPromises();
      expect(calls.find((c) => c.path === `${base}/test`)!.body).toEqual({
        server: 'web-1',
        address: 'localhost:9400',
      });
      const result = w.get(tid('own-test-result'));
      expect(result.attributes('data-outcome')).toBe(answer.outcome);
      expect(result.text()).toContain(words);
      // Nothing was added by testing.
      expect(calls.some((c) => c.path === `${base}/sources`)).toBe(false);
    });
  }

  it('says what it is with a sample, keeps the placeholder in lower case, and how many series a cap would keep', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { w } = await open(
      {
        ...fleetRoutes(),
        [`POST ${base}/test`]: {
          status: 202,
          body: { id: 't1', done: false, address: 'localhost:9400/metrics' },
        },
        [`GET ${base}/test`]: {
          status: 200,
          body: {
            id: 't1',
            done: true,
            address: 'localhost:9400/metrics',
            outcome: 'answered',
            series: 900,
            names: ['a'],
            kept: 500,
            cap: 'source',
          },
        },
        [`POST ${base}/sources`]: { status: 201, body: { id: 's9' } },
      },
      { path: '/your-metrics/add?way=scrape' },
    );
    const panel = w.get(tid('own-expose'));
    expect(panel.text()).toContain('an address that lists their numbers as plain text');
    expect(w.get(tid('own-expose-sample')).text()).toContain('# TYPE orders_total counter');
    expect(w.get(tid('own-expose-sample')).text().split('\n')).toHaveLength(4);
    const input = w.get(`${tid('own-address-input')} input`);
    expect(input.attributes('placeholder')).toBe('localhost:9400/metrics');
    expect(input.classes()).not.toContain('uppercase');

    await input.setValue('localhost:9400/metrics');
    await w.get(tid('own-address-test')).trigger('click');
    await flushPromises();
    expect(w.get(tid('own-test-running')).text()).toContain(
      'Asking the collector to read localhost:9400/metrics',
    );
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(w.get(tid('own-test-result')).text()).toContain('Answered: 900 series');
    expect(w.get(tid('own-test-kept')).text()).toBe(
      '500 of them would be kept: one endpoint brings at most 500 series.',
    );
    await w.get(tid('own-address-form')).trigger('submit');
    await flushPromises();
    expect(w.get(tid('own-address-added')).text()).toContain('Added.');
  });

  it('Find says what it tried; with nothing found, three ways forward instead of a dead end', async () => {
    const { w } = await open(fleetRoutes(), { path: '/your-metrics/add?way=scrape' });
    expect(w.get(tid('own-find-state')).text()).toBe(
      'Tried /metrics on 3 listening ports: 80, 3000, 8080. None answers with metrics.',
    );
    expect(w.get(tid('own-find-skipped')).text()).toContain('Left out 22, 5432');
    const none = w.get(tid('own-none'));
    expect(none.text()).toContain('No /metrics page here yet? Three ways forward');
    expect(none.text()).toContain("node_exporter and cAdvisor aren't needed");
    await none.get(tid('own-none-lang-python')).trigger('click');
    expect(none.get(tid('own-none-code')).text()).toContain(
      'from prometheus_client import Counter, start_http_server',
    );
    await none.get(tid('own-none-lang-node')).trigger('click');
    expect(none.get(tid('own-none-code')).text()).toContain('@prometheus-io/client');
    await none.get(tid('own-none-push')).trigger('click');
    await flushPromises();
    expect(panelOf(w)).toBe('push');
  });

  it('in a cluster: a workload’s port is tested and scraped with no restart; the annotation as one command and as YAML', async () => {
    const kb = baseOf(KUBE);
    const { w, calls } = await open(
      {
        [`GET ${kb}`]: { status: 200, body: kubeSummary() },
        [`GET ${kb}/find`]: {
          status: 200,
          body: found({
            tried: { ports: [8080, 9102], skipped: [], scraped: 1, workloads: 2 },
            asked: 2,
          }),
        },
        [`POST ${kb}/test`]: {
          status: 202,
          body: { id: 't1', done: true, address: 'shop/orders :9102/metrics', outcome: 'refused' },
        },
        [`POST ${kb}/sources`]: { status: 201, body: { id: 's1' } },
      },
      { cluster: KUBE, path: '/your-metrics/add?way=scrape' },
    );
    expect(w.get(tid('own-find-state')).text()).toContain(
      'Tried /metrics on 2 ports of 2 workloads: 8080, 9102.',
    );
    expect(w.get(tid('own-find-skipped')).text()).toContain('1 port is scraped already.');
    await chooseOption(w, 'own-port-workload', 'shop/orders');
    await w.get(`${tid('own-port-input')} input`).setValue('9102');
    await w.get(tid('own-address-test')).trigger('click');
    await flushPromises();
    const body = { namespace: 'shop', workloadKind: 'Deployment', workload: 'orders', port: 9102 };
    expect(calls.find((c) => c.path === `${kb}/test`)!.body).toEqual(body);
    expect(w.get(tid('own-test-result')).text()).toContain('Nothing is listening on that port.');
    await w.get(tid('own-port-form')).trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.path === `${kb}/sources`)!.body).toEqual(body);
    expect(w.get(tid('own-expose')).text()).toContain('no pod restarts');
    const annotate = w.get(tid('own-annotate'));
    expect(annotate.text()).toContain('Changing the pod template restarts its pods.');
    expect(annotate.get(tid('own-annotate-patch')).text()).toContain(
      'kubectl -n shop patch deployment orders --type merge',
    );
    expect(annotate.get(tid('own-annotate-patch')).text()).toContain('"watchlog.io/port":"9102"');
    expect(annotate.get(tid('own-annotate-yaml')).text()).toContain('watchlog.io/scrape: "true"');
  });
});

describe('the side panels', () => {
  it('say what a series is, the plan’s numbers first, and what happens next for the open way', async () => {
    const { w } = await open(fleetRoutes(summary({ usage: { series: 12, sources: 1 } })));
    expect(w.get(tid('own-plan-series')).text()).toBe('12 of 1,000 series');
    expect(w.get(tid('own-series-meaning')).text()).toBe(
      'A series is one line on a chart: one metric with one set of labels. orders_total is 1 series however often you send it. orders_total split by 3 payment methods is 3. There is no limit on how many times you send.',
    );
    expect(w.get(tid('own-next')).text()).toContain(
      'The value arrives within seconds, and this page says so.',
    );
    await w.get(tid('own-add-way-scrape')).trigger('click');
    await flushPromises();
    expect(w.get(tid('own-next')).text()).toContain(
      'Test the address: WatchLog says what it found, in words.',
    );
    await w.get(tid('own-add-way-prometheus')).trigger('click');
    await flushPromises();
    expect(w.get(tid('own-next')).text()).toContain(
      'Only the metrics your keep rule names are sent.',
    );
    expect(w.get(tid('own-prometheus-who')).text()).toContain(
      'Only if you already run Prometheus.',
    );
    expect(w.find(tid('own-limits-sources')).exists()).toBe(false);
  });

  it('Cloud Free: 200 series and 3 sources, said with what is in use', async () => {
    const free = summary({
      limits: {
        ...summary().limits,
        series: 200,
        seriesPerSource: 100,
        sources: 3,
        alerts: 'none',
      },
      usage: { series: 40, sources: 2 },
    });
    const { w } = await open(fleetRoutes(free));
    expect(w.get(tid('own-plan-series')).text()).toBe('40 of 200 series');
    expect(w.get(tid('own-limits-sources')).text()).toBe('3 sources on your plan; 2 in use.');
    expect(w.get(tid('own-limits')).text()).toContain(
      "one token's pushes, brings at most 100 series",
    );
  });
});

describe('who sees what', () => {
  for (const [who, o] of [
    ['a Viewer', { role: 'viewer' }],
    ['the demo', { demo: true }],
  ] as const) {
    it(`${who} reads every way with its commands, without a token or anything that changes things`, async () => {
      const { w, calls } = await open({ [`GET ${base}`]: { status: 200, body: summary() } }, o);
      expect(w.get(tid('own-add-readonly')).text()).toContain(
        who === 'the demo' ? 'This demo is read-only' : 'Only Owners and Admins',
      );
      // Push opens; the search (a change) isn't started.
      expect(panelOf(w)).toBe('push');
      expect(w.get(tid('own-push-code')).text()).toContain(
        'curl -sS -X POST https://ingest.watchlog.example',
      );
      expect(w.get(tid('own-push-code')).text()).toContain('wl_mt_…');
      expect(w.find(tid('own-token-make')).exists()).toBe(false);
      expect(w.find(tid('own-push-test')).exists()).toBe(false);
      expect(w.get(tid('own-token-locked')).text()).not.toBe('');
      await w.get(tid('own-add-way-scrape')).trigger('click');
      await flushPromises();
      expect(w.find(tid('own-address-form')).exists()).toBe(false);
      expect(w.find(tid('own-find-start')).exists()).toBe(false);
      expect(w.find(tid('own-expose-sample')).exists()).toBe(true);
      expect(w.find(tid('own-none')).exists()).toBe(true);
      await w.get(tid('own-add-way-prometheus')).trigger('click');
      await flushPromises();
      expect(w.get(tid('own-prometheus-code')).text()).toContain('credentials: wl_mt_…');
      expect(calls.every((c) => c.method === 'GET')).toBe(true);
    });
  }
});

describe('the rules, in small', () => {
  it('names, values, kinds, owners and port lists', () => {
    expect(nameOk('orders_total')).toBe(true);
    expect(nameOk('2orders')).toBe(false);
    expect(nameOk('watchlog_up')).toBe(false);
    expect(valueOk('12.5')).toBe(true);
    expect(valueOk('')).toBe(false);
    expect(valueOk('twelve')).toBe(false);
    expect(kindOfName('orders_total')).toBe('counter');
    expect(kindOfName('backup_last_success_timestamp_seconds')).toBe('timestamp');
    expect(kindOfName('queue_jobs_waiting')).toBe('gauge');
    expect(pushOwner('server', 'web-1')).toEqual({ server: 'web-1' });
    expect(pushOwner('kubernetes', 'shop/Deployment/orders')).toEqual({ workload: 'shop/orders' });
    expect(pushOwner('kubernetes', null)).toBeNull();
    const more = (n: number) => `and ${n} more`;
    expect(portsText([22, 80], more)).toBe('22, 80');
    expect(portsText([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], more)).toBe(
      '1, 2, 3, 4, 5, 6, 7, 8 and 2 more',
    );
  });
});
