// SPDX-License-Identifier: AGPL-3.0-only
// Egress watch in the dashboard (ADR-188, v0.7 slice 3): the Egress page for a Kubernetes
// cluster and a Docker fleet (badges, labels, filters in each platform's words, the empty,
// loading and error states, the phone cards), "Talks to the internet" on the source pages,
// and the navigation's "N new". Answers are in the shape the API gave on the slice's own stack.
import type { Egress, EgressRow } from '@watchlog/api-types';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppSidebar from '@/components/layout/AppSidebar.vue';
import EgressTable from '@/components/egress/EgressTable.vue';
import TalksToInternet from '@/components/egress/TalksToInternet.vue';
import { ago, egressPath, firstSeenText, percent, sourceLink, sourceName } from '@/lib/egress';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';
import { useEgressStore } from '@/stores/egress';
import EgressPage from '@/views/EgressPage.vue';
import { FLEET } from './docker-fixtures';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const NOW = Date.UTC(2026, 10, 15, 9, 30, 0);
const H = 3_600_000;
const D = 24 * H;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const CLUSTER = {
  ...FLEET,
  id: '01a1de8d-e52d-7188-9878-62ee5fd5309d',
  name: 'acme-prod',
  kind: 'kubernetes',
};
const t = (key: string, v: Record<string, unknown> = {}) =>
  `${key}${Object.keys(v).length ? JSON.stringify(v) : ''}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function row(destination: string, over: Partial<EgressRow> = {}): EgressRow {
  return {
    destination,
    port: 443,
    kind: 'name',
    class: 'name',
    private: false,
    sources: [
      {
        namespace: 'wl-test',
        workloadKind: 'Deployment',
        workload: 'web',
        firstSeen: iso(41 * D),
        lastSeen: iso(5 * 60_000),
        new: false,
      },
    ],
    firstSeen: iso(41 * D),
    firstSeenBefore: false,
    lastSeen: iso(5 * 60_000),
    sent: 432_000,
    received: 1_728_000,
    connections: 5760,
    failed: 0,
    failedRatio: 0,
    badges: [],
    expected: null,
    alertId: null,
    ...over,
  };
}
const fresh = (s: EgressRow['sources'][number]) => ({ ...s, new: true, firstSeen: iso(3 * H) });
const K8S_ROWS: EgressRow[] = [
  row('telemetry-check.example.net', {
    badges: ['new'],
    firstSeen: iso(3 * H),
    sources: [fresh(row('x').sources[0]!)],
    connections: 960,
  }),
  row('185.220.101.0/24', {
    port: 9001,
    kind: 'network',
    class: 'public_network',
    badges: ['new', 'raw_ip'],
    firstSeen: iso(2 * H),
  }),
  row('api.mailgun.net', {
    badges: ['failing'],
    connections: 2880,
    failed: 960,
    failedRatio: 1 / 3,
    sources: [{ ...row('x').sources[0]!, workloadKind: 'CronJob', workload: 'every-minute' }],
  }),
  row('10.96.0.0/24', { kind: 'network', class: 'private_network', private: true }),
  row('s3.eu-central-1.amazonaws.com', {
    badges: ['expected'],
    expected: { pattern: '*.amazonaws.com', at: iso(D) },
    sources: [
      row('x').sources[0]!,
      { ...row('x').sources[0]!, workloadKind: 'StatefulSet', workload: 'db' },
    ],
  }),
  row('api', { port: 8080, class: 'local_name' }),
  row('Internet', { port: 0, kind: 'internet', class: 'internet', sent: 0, received: 0 }),
  row('api.stripe.com', { firstSeenBefore: true, firstSeen: iso(15 * D) }),
];
const answer = (rows: EgressRow[], over: Partial<Egress> = {}): Egress => ({
  cluster: { id: CLUSTER.id, kind: 'kubernetes' },
  range: { from: iso(D), to: iso(0) },
  learning: { since: iso(41 * D), until: iso(34 * D), learning: false, days: 41 },
  traffic: true,
  summary: { destinations: rows.length, sources: 5, new: 2, rawIp: 1, failing: 1 },
  rows,
  total: rows.length,
  truncated: false,
  ...over,
});

const dockerSource = (s: Partial<EgressRow['sources'][number]>) => ({
  firstSeen: iso(9 * D),
  lastSeen: iso(0),
  new: false,
  ...s,
});
const DOCKER_ROWS: EgressRow[] = [
  row('hooks.slack.com', {
    badges: ['new'],
    sources: [dockerSource({ host: 'docker-02', container: 'cron', new: true })],
  }),
  row('api.openai.com', {
    sources: [dockerSource({ composeProject: 'storefront', composeService: 'api' })],
  }),
];

describe('the egress words and paths', () => {
  it('builds the request path for each range (24 h is the default)', () => {
    expect(egressPath('c1', { namespace: 'shop', badge: undefined })).toBe(
      '/egress?cluster=c1&namespace=shop',
    );
    expect(egressPath('c1', {}, '7d', NOW)).toBe(
      `/egress?cluster=c1&from=${NOW / 1000 - 7 * 86_400}`,
    );
  });

  it('names sources in each platform’s words and links to their pages', () => {
    const [k] = K8S_ROWS[0]!.sources;
    expect(sourceName(k!)).toBe('wl-test / web');
    expect(sourceName(DOCKER_ROWS[1]!.sources[0]!)).toBe('storefront · api');
    expect(sourceName(DOCKER_ROWS[0]!.sources[0]!)).toBe('cron (docker-02)');
    expect(sourceLink(k!, 'c1')).toMatchObject({
      name: 'workloads',
      query: { view: 'pods', wkind: 'Deployment', wname: 'web', wns: 'wl-test' },
    });
    expect(sourceLink(DOCKER_ROWS[1]!.sources[0]!, 'c1')).toMatchObject({
      name: 'containers',
      query: { project: 'storefront', service: 'api' },
    });
    expect(sourceLink(DOCKER_ROWS[0]!.sources[0]!, 'c1')).toMatchObject({
      name: 'docker-container',
      params: { host: 'docker-02', name: 'cron' },
    });
  });

  it('says how long ago, "before" a date, and the failed share', () => {
    expect(ago(iso(30_000), t, NOW)).toBe('egress.ago.now');
    expect(ago(iso(4 * 60_000), t, NOW)).toBe('egress.ago.minutes{"n":4}');
    expect(ago(iso(3 * H), t, NOW)).toBe('egress.ago.hours{"n":3}');
    expect(ago(iso(41 * D), t, NOW)).toBe('egress.ago.days{"n":41}');
    expect(firstSeenText({ firstSeen: iso(15 * D), firstSeenBefore: true }, t, NOW)).toBe(
      'egress.before{"day":"Oct 31"}',
    );
    expect([0, 0.002, 1 / 3, null].map(percent)).toEqual(['0 %', '0.2 %', '33 %', '–']);
  });
});

async function mountWith(component: object, path: string, props: object = {}) {
  const plugins = await createPlugins(path);
  useAuthStore().user = USER;
  const w = mount(component, {
    props,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  await flushPromises();
  return { w, plugins };
}

describe('the destinations table', () => {
  it('shows badges, labels, sources and numbers, and a card per destination on phones', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { w } = await mountWith(EgressTable, '/egress', {
      rows: K8S_ROWS,
      clusterId: CLUSTER.id,
    });
    const rows = w.findAll('[data-testid="egress-row"]');
    expect(rows).toHaveLength(K8S_ROWS.length);
    const badges = (i: number) =>
      rows[i]!.findAll('[data-badge],[data-class]').map((b) => b.text());
    expect(badges(0)).toEqual(['New']);
    expect(badges(1)).toEqual(['New', 'Raw IP']);
    expect(badges(2)).toEqual(['Failing']);
    expect(badges(3)).toEqual(['Private network']);
    expect(badges(4)).toEqual(['Expected · *.amazonaws.com']);
    expect(badges(5)).toEqual(['Local name']);
    expect(badges(6)).toEqual(['Names not kept']);
    expect(rows[0]!.text()).toContain('telemetry-check.example.net:443');
    expect(rows[0]!.text()).toContain('3 h ago');
    // "Internet" has no port and names nothing.
    expect(rows[6]!.text()).toContain('Other destinations');
    expect(rows[6]!.text()).not.toContain(':0');
    expect(rows[2]!.text()).toContain('33 %');
    expect(rows[2]!.text()).toContain('wl-test / every-minute');
    expect(rows[4]!.findAll('li').map((l) => l.text())).toEqual(['wl-test / web', 'wl-test / db']);
    expect(rows[7]!.text()).toContain('before Oct 31');
    expect(rows[0]!.text()).toContain('960');
    // Names are text, never links (ADR-129); sources link to their pages.
    expect(rows[0]!.find('a[href*="telemetry"]').exists()).toBe(false);
    expect(rows[0]!.get('a').attributes('href')).toContain('wname=web');
    // The table from 768 px, cards below.
    expect(w.get('[data-testid="egress-table"]').classes()).toEqual(
      expect.arrayContaining(['hidden', 'md:block']),
    );
    expect(w.get('[data-testid="egress-cards"]').classes()).toContain('md:hidden');
    const cards = w.findAll('[data-testid="egress-card"]');
    expect(cards).toHaveLength(K8S_ROWS.length);
    expect(cards[1]!.text()).toContain('Raw IP');
    expect(cards[2]!.text()).toContain('33 % failed');
  });
});

const egressUrl = (q = '') => `GET /api/v1/egress?cluster=${CLUSTER.id}${q}`;
const dockerUrl = (q = '') => `GET /api/v1/egress?cluster=${FLEET.id}${q}`;

describe('the Egress page', () => {
  it('Kubernetes: the header, the counts, the rows, and the nav’s new count', async () => {
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [CLUSTER] } },
      [egressUrl()]: { status: 200, body: answer(K8S_ROWS) },
    });
    const { w } = await mountWith(EgressPage, '/egress');
    expect(w.get('[data-testid="egress-title"]').text()).toBe(
      'What acme-prod talks to on the internet',
    );
    expect(w.get('[data-testid="egress-learning"]').text()).toContain(
      'Learned from 41 days of traffic.',
    );
    expect(w.get('[data-testid="egress-learning"]').text()).toContain('your workloads received');
    const summary = w.get('[data-testid="egress-summary"]').text();
    expect(summary).toContain('from 5 workloads');
    expect(summary).toContain('never seen before from their workload');
    expect(w.get('[data-testid="summary-new"]').classes()).toContain('border-warning');
    expect(w.findAll('[data-testid="egress-row"]')).toHaveLength(K8S_ROWS.length);
    expect(w.find('[data-testid="filter-namespace"]').exists()).toBe(true);
    expect(w.find('[data-testid="filter-host"]').exists()).toBe(false);
    expect(w.findAll('[data-testid="filter-namespace"] option').map((o) => o.text())).toEqual([
      'All namespaces',
      'wl-test',
    ]);
    expect(w.get('[data-testid="egress-footer"]').text()).toContain('forgotten');
    expect(useEgressStore().newCount[CLUSTER.id]).toBe(2);
    w.unmount();
  });

  it('Kubernetes: a badge chip, a namespace and the range go to the API and the URL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { calls } = mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [CLUSTER] } },
      [egressUrl()]: { status: 200, body: answer(K8S_ROWS) },
      [egressUrl('&badge=new')]: { status: 200, body: answer(K8S_ROWS.slice(0, 2)) },
      [egressUrl('&namespace=wl-test&badge=new')]: {
        status: 200,
        body: answer(K8S_ROWS.slice(0, 2)),
      },
      [egressUrl(`&namespace=wl-test&badge=new&from=${NOW / 1000 - 7 * 86_400}`)]: {
        status: 200,
        body: answer([]),
      },
    });
    const { w, plugins } = await mountWith(EgressPage, '/egress');
    await w.get('[data-testid="chip-new"]').trigger('click');
    await flushPromises();
    expect(plugins.router.currentRoute.value.query.badge).toBe('new');
    expect(w.get('[data-testid="chip-new"]').attributes('aria-pressed')).toBe('true');
    expect(w.findAll('[data-testid="egress-row"]')).toHaveLength(2);
    await w.get('[data-testid="filter-namespace"]').setValue('wl-test');
    await flushPromises();
    expect(plugins.router.currentRoute.value.query.namespace).toBe('wl-test');
    await w.get('[data-testid="egress-range"] button:nth-child(3)').trigger('click');
    await flushPromises();
    expect(plugins.router.currentRoute.value.query.range).toBe('7d');
    expect(calls.map((c) => c.path).at(-1)).toContain('from=');
    // Nothing matches: the "no match" state with a way back.
    expect(w.find('[data-testid="egress-no-match"]').exists()).toBe(true);
    w.unmount();
  });

  it('Docker: hosts, Compose projects and containers, in the fleet’s words', async () => {
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
      [dockerUrl()]: {
        status: 200,
        body: answer(DOCKER_ROWS, {
          cluster: { id: FLEET.id, kind: 'docker' },
          summary: { destinations: 2, sources: 2, new: 1, rawIp: 0, failing: 0 },
        }),
      },
    });
    const { w } = await mountWith(EgressPage, '/egress');
    expect(w.find('[data-testid="filter-namespace"]').exists()).toBe(false);
    expect(w.findAll('[data-testid="filter-host"] option').map((o) => o.text())).toEqual([
      'All hosts',
      'docker-02',
    ]);
    expect(w.findAll('[data-testid="filter-project"] option').map((o) => o.text())).toEqual([
      'All Compose projects',
      'storefront',
    ]);
    expect(w.findAll('[data-testid="filter-container"] option').map((o) => o.text())).toEqual([
      'All containers',
      'cron',
    ]);
    expect(w.get('[data-testid="egress-summary"]').text()).toContain(
      'from 2 containers and Compose services',
    );
    expect(w.text()).toContain('storefront · api');
    expect(w.text()).toContain('cron (docker-02)');
    expect(w.text()).not.toContain('namespace');
    w.unmount();
  });

  it('Docker: a deep link from a Compose service page keeps its filters', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
      [dockerUrl('&project=storefront&service=api')]: {
        status: 200,
        body: answer(DOCKER_ROWS.slice(1), { cluster: { id: FLEET.id, kind: 'docker' } }),
      },
    });
    const { w } = await mountWith(EgressPage, '/egress?project=storefront&service=api');
    expect(calls.at(-1)!.path).toBe(
      `/api/v1/egress?cluster=${FLEET.id}&project=storefront&service=api`,
    );
    expect(w.get('[data-testid="egress-service"]').text()).toBe('Compose service storefront · api');
    expect((w.get('[data-testid="filter-project"]').element as HTMLSelectElement).value).toBe(
      'storefront',
    );
    w.unmount();
  });

  it('empty: nothing has talked to the internet yet, in each platform’s words', async () => {
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
      [dockerUrl()]: {
        status: 200,
        body: answer([], {
          cluster: { id: FLEET.id, kind: 'docker' },
          learning: { since: iso(D), until: iso(-6 * D), learning: true, days: 1 },
          summary: { destinations: 0, sources: 0, new: 0, rawIp: 0, failing: 0 },
        }),
      },
    });
    const { w } = await mountWith(EgressPage, '/egress');
    expect(w.get('[data-testid="egress-empty"]').text()).toContain('No container connected');
    expect(w.get('[data-testid="egress-learning"]').text()).toContain('Learning until Nov 21');
    w.unmount();
  });

  it('no cluster: says to connect one', async () => {
    mockFetch({ 'GET /api/v1/clusters': { status: 200, body: { clusters: [] } } });
    const { w } = await mountWith(EgressPage, '/egress');
    expect(w.text()).toContain('Connect a Kubernetes cluster or a Docker fleet');
    w.unmount();
  });

  it('error: offers Retry, and a retry shows the rows', async () => {
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [CLUSTER] } },
      [egressUrl()]: [
        { status: 503, body: { title: 'Service Unavailable', status: 503 } },
        { status: 200, body: answer(K8S_ROWS) },
      ],
    });
    const { w } = await mountWith(EgressPage, '/egress');
    expect(w.get('[data-testid="error-state"]').text()).toContain("Couldn't load the destinations");
    await w.get('[data-testid="error-state"] button').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="error-state"]').exists()).toBe(false);
    expect(w.findAll('[data-testid="egress-row"]').length).toBeGreaterThan(0);
    w.unmount();
  });

  it('loading: the skeleton after 150 ms, then the data', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        const body = path.endsWith('/clusters')
          ? { clusters: [CLUSTER] }
          : (await gate, answer(K8S_ROWS));
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const plugins = await createPlugins('/egress');
    useAuthStore().user = USER;
    const w = mount(EgressPage, {
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    await vi.advanceTimersByTimeAsync(160);
    expect(w.find('[data-testid="egress-skeleton"]').exists()).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();
    expect(w.find('[data-testid="egress-skeleton"]').exists()).toBe(false);
    expect(w.findAll('[data-testid="egress-row"]')).toHaveLength(K8S_ROWS.length);
    w.unmount();
  });
});

describe('"Talks to the internet" on a source page', () => {
  const month = (q: string) =>
    `GET /api/v1/egress?cluster=${CLUSTER.id}${q}&from=${NOW / 1000 - 30 * 86_400}`;

  it('Kubernetes workload: 30 days of rows with today’s connections, and the link', async () => {
    const q = '&namespace=wl-test&kind=Deployment&workload=web';
    mockFetch({
      [month(q)]: { status: 200, body: answer([K8S_ROWS[4]!, K8S_ROWS[7]!]) },
      [egressUrl(q)]: {
        status: 200,
        body: answer([{ ...K8S_ROWS[4]!, connections: 212, failedRatio: 0 }]),
      },
    });
    const { w } = await mountWith(TalksToInternet, '/workloads', {
      clusterId: CLUSTER.id,
      kind: 'kubernetes',
      query: { namespace: 'wl-test', kind: 'Deployment', workload: 'web' },
      now: NOW,
    });
    const rows = w.findAll('[data-testid="talks-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain('s3.eu-central-1.amazonaws.com:443');
    expect(rows[0]!.text()).toContain(
      'first seen 41 days ago · 212 connections today · 0 % failed',
    );
    expect(rows[0]!.text()).toContain('Expected · *.amazonaws.com');
    // Not used today: 0 connections, no share.
    expect(rows[1]!.text()).toContain('first seen before Oct 31 · 0 connections today · – failed');
    expect(w.get('[data-testid="talks-link"]').text()).toBe("See the whole cluster's egress →");
    expect(w.get('[data-testid="talks-link"]').attributes('href')).toBe(
      `/egress?cluster=${CLUSTER.id}&namespace=wl-test&kind=Deployment&workload=web`,
    );
    expect(w.find('[data-testid="talks-pod-note"]').exists()).toBe(false);
  });

  it('a pod: says the rows are its workload’s', async () => {
    const q = '&namespace=wl-test&kind=Deployment&workload=web';
    mockFetch({
      [month(q)]: { status: 200, body: answer([]) },
      [egressUrl(q)]: { status: 200, body: answer([]) },
    });
    const { w } = await mountWith(TalksToInternet, '/pods/wl-test/web-1', {
      clusterId: CLUSTER.id,
      kind: 'kubernetes',
      query: { namespace: 'wl-test', kind: 'Deployment', workload: 'web' },
      podNote: true,
      now: NOW,
    });
    expect(w.get('[data-testid="talks-pod-note"]').text()).toContain('per workload, not per pod');
    expect(w.get('[data-testid="talks-empty"]').text()).toBe(
      'No external destination in the last 30 days.',
    );
  });

  it('Docker container: its Compose service’s rows, the fleet’s link; error then Retry', async () => {
    const q = '&host=docker-01&container=storefront-api-1&project=storefront&service=api';
    const fleetMonth = `GET /api/v1/egress?cluster=${FLEET.id}${q}&from=${NOW / 1000 - 30 * 86_400}`;
    mockFetch({
      [fleetMonth]: [
        { status: 503, body: { title: 'x', status: 503 } },
        { status: 200, body: answer(DOCKER_ROWS.slice(1)) },
      ],
      [dockerUrl(q)]: [
        { status: 200, body: answer([]) },
        { status: 200, body: answer(DOCKER_ROWS.slice(1)) },
      ],
    });
    const { w } = await mountWith(TalksToInternet, '/containers/docker-01/storefront-api-1', {
      clusterId: FLEET.id,
      kind: 'docker',
      query: {
        host: 'docker-01',
        container: 'storefront-api-1',
        project: 'storefront',
        service: 'api',
      },
      now: NOW,
    });
    expect(w.get('[data-testid="talks-error"]').text()).toContain(
      "Couldn't load the external destinations",
    );
    await w.get('[data-testid="talks-error"] button').trigger('click');
    await flushPromises();
    expect(w.findAll('[data-testid="talks-row"]')).toHaveLength(1);
    expect(w.text()).toContain('api.openai.com:443');
    expect(w.get('[data-testid="talks-link"]').text()).toBe("See the whole fleet's egress →");
  });

  it('shows a loading line before the answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const { w } = await mountWith(TalksToInternet, '/workloads', {
      clusterId: CLUSTER.id,
      kind: 'kubernetes',
      query: { namespace: 'wl-test', workload: 'web' },
      now: NOW,
    });
    expect(w.find('[data-testid="talks-loading"]').exists()).toBe(true);
  });
});

describe('the navigation', () => {
  it('shows "N new" beside Egress for a Kubernetes cluster and a Docker fleet', async () => {
    for (const c of [CLUSTER, FLEET]) {
      mockFetch({
        [`GET /api/v1/egress?cluster=${c.id}`]: {
          status: 200,
          body: answer([], {
            summary: { destinations: 3, sources: 1, new: 2, rawIp: 0, failing: 0 },
          }),
        },
      });
      const { router, i18n, pinia } = await createPlugins('/');
      const clusters = useClustersStore();
      clusters.list = [c as never];
      clusters.selectedId = c.id;
      const w = mount(AppSidebar, { global: { plugins: [router, i18n, pinia] } });
      await flushPromises();
      const egress = w.findAll('nav a').find((a) => a.text().startsWith('Egress'))!;
      expect(egress.get('[data-testid="nav-new"]').text()).toContain('2 new');
      expect(egress.get('[data-testid="nav-new"]').classes()).toContain('text-warning');
      w.unmount();
      vi.unstubAllGlobals();
    }
  });
});
