// SPDX-License-Identifier: AGPL-3.0-only
// All clusters and fleets (ADR-226): the page's words (the status sentence, the tiles, the kind
// lines, housekeeping), its states (problems, healthy, loading, one cluster), the merged row
// with a chip per place, the filter and range in the URL and the request, the upgrade card for
// Cloud Free and Community, the sidebar's list, the switcher's first item and the landing rule.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { AllClusters } from '@watchlog/api-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudConfig } from '@/api/cloud';
import AppSidebar from '@/components/layout/AppSidebar.vue';
import { createAppI18n } from '@/i18n';
import {
  showsProLabel,
  allClustersPath,
  chores,
  countLine,
  hero,
  kindLine,
  sparkPath,
  tiles,
} from '@/lib/all-clusters';
import { EXAMPLE } from '@/lib/all-clusters-example';
import { installLandingRule, routes } from '@/router';
import { useAuthStore } from '@/stores/auth';
import AllClustersPage from '@/views/AllClustersPage.vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { mockFetch, USER, type Routes } from './fetch-mock';
import { createPlugins, listedOptions } from './helpers';
import ClusterSwitcher from '@/components/layout/ClusterSwitcher.vue';

const i18n = createAppI18n();
const tr = (k: string, v?: Record<string, unknown>) => i18n.global.t(k, v ?? {});

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

/** The design's org with something to do: the example data, as the API answers it. */
const ATTENTION: AllClusters = structuredClone(EXAMPLE);
/** The same org, everything healthy. */
const HEALTHY: AllClusters = {
  ...structuredClone(EXAMPLE),
  clusters: EXAMPLE.clusters.map((c) => ({
    ...c,
    status: 'healthy' as const,
    reporting: { live: c.reporting.total, total: c.reporting.total },
    problems: { critical: 0, warning: 0 },
  })),
  hosts: { ...EXAMPLE.hosts, notReporting: 0 },
  problems: [],
  whatChanged: { rows: [], total: 0, learning: [] },
  lastResolved: {
    title: 'Disk on pg-02',
    cluster: EXAMPLE.clusters[3]!,
    resolvedAt: '2026-11-19T14:20:00Z',
    durationSeconds: 3 * 3600,
  },
};

describe('the words', () => {
  it('the status sentence names a shared problem and a silent server', () => {
    const h = hero(ATTENTION, 'all', tr);
    expect(h.healthy).toBe(false);
    // Every cluster that isn't healthy (ADR-227): 3 critical and 2 warning.
    expect(h.title).toBe('5 clusters and fleets need attention');
    expect(h.sub).toBe('3 critical · 2 warning · acme-staging and acme-prod share one problem');
  });

  it('everything healthy: all N, the hosts reporting, nothing unusual', () => {
    const h = hero(HEALTHY, 'all', tr);
    expect(h).toEqual({
      healthy: true,
      title: 'All 6 clusters and fleets are healthy',
      sub: '30 nodes and servers reporting · nothing out of its usual range',
    });
    const one = hero({ ...HEALTHY, clusters: HEALTHY.clusters.slice(0, 1) }, 'kubernetes', tr);
    expect(one.title).toBe('The cluster or fleet is healthy');
    expect(one.sub).toMatch(/^12 nodes reporting/);
  });

  it('the worst problem when nothing is shared and nobody is silent', () => {
    const s = {
      ...ATTENTION,
      problems: ATTENTION.problems.filter((p) => p.places.length === 1),
      clusters: ATTENTION.clusters.map((c) => ({
        ...c,
        reporting: { live: c.reporting.total, total: c.reporting.total },
      })),
    };
    expect(hero(s, 'all', tr).sub).toBe(
      '3 critical · 2 warning · office-tools: mail-01 stopped reporting',
    );
  });

  it('the tiles', () => {
    const t = tiles(ATTENTION, 'all', '24h', tr);
    expect(t.map((x) => [x.label, x.value, x.sub])).toEqual([
      ['Clusters and fleets', '6', '3 critical · 2 warning · 1 healthy'],
      ['Nodes and servers', '30', '1 not reporting'],
      ['Open problems', '5', '2 critical · 3 warning'],
      ['Alerts sent, 24h', '9', 'Telegram 5 · Slack 3 failed · Email 1'],
    ]);
    expect(tiles(HEALTHY, 'server', '24h', tr)[2]!.sub).toBe('3 resolved this week');
    expect(tiles(HEALTHY, 'server', '24h', tr)[1]!.label).toBe('Servers');
  });

  it('each kind in its own words, and the three server sources', () => {
    const [prod, , office, db] = ATTENTION.clusters;
    expect(kindLine(prod!, tr)).toBe('Kubernetes 1.34 · 12 nodes');
    expect(kindLine(db!, tr)).toBe('Server fleet · 3 servers · PostgreSQL');
    expect(kindLine(office!, tr)).toBe('Server fleet · 2 servers · 4 services, 2 process groups');
    expect(
      kindLine(
        { ...office!, sources: { services: 0, processGroups: 0, containers: 7, applications: [] } },
        tr,
      ),
    ).toBe('Server fleet · 2 servers · 7 containers');
    expect(countLine(office!, tr)).toBe('1 of 2 reporting');
    expect(countLine(prod!, tr)).toBe('12 nodes');
  });

  it('the "Pro" label shows only where the page is an upgrade card', () => {
    const o = { isCloud: true, demo: false, proFeatures: false, access: null };
    expect(showsProLabel(o)).toBe(true);
    expect(showsProLabel({ ...o, proFeatures: true })).toBe(false);
    expect(showsProLabel({ ...o, access: 'pro' as const })).toBe(false);
    expect(showsProLabel({ ...o, isCloud: false, proFeatures: null })).toBe(true);
    expect(showsProLabel({ ...o, isCloud: false, demo: true })).toBe(false);
  });

  it('the sparkline skips gaps and stays in its box', () => {
    expect(
      sparkPath([
        [0, 0],
        [1, 1],
      ]),
    ).toBe('M0.0 26.0 L96.0 2.0');
    expect(
      sparkPath([
        [0, 0.5],
        [1, null],
        [2, 0.5],
      ]),
    ).toBe('M0.0 14.0 M96.0 14.0');
    expect(sparkPath([[0, 2]])).toBe('');
  });

  it('housekeeping, in the order of the design', () => {
    const c = chores(ATTENTION.housekeeping, tr);
    expect(c.map((x) => x.title)).toEqual([
      '4 agents in shop-servers run an older version',
      'Slack is failing',
      'acme-staging sends alerts nowhere',
      'eBPF is off on 2 nodes in eu-edge',
    ]);
    expect(c[1]!.body).toBe('The webhook answers 404. Still delivering: Telegram, Email.');
    expect(c[3]!.body).toBe('kernel 5.4 without BTF; everything but the service map works there.');
  });
});

let mounted: VueWrapper | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
});

type Edition = 'pro' | 'free' | 'community';
const get = (range = 86_400, kind: 'all' | 'kubernetes' | 'server' = 'all') =>
  `GET /api/v1${allClustersPath(range, kind)}`;

async function open(
  path: string,
  edition: Edition,
  routes: Routes,
  role: 'owner' | 'admin' | 'viewer' = 'owner',
) {
  const { calls } = mockFetch(routes);
  const plugins = await createPlugins(path);
  const auth = useAuthStore();
  auth.user = { ...USER, role };
  auth.cloud = edition === 'community' ? null : CONFIG;
  const w = mount(AllClustersPage, {
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  mounted = w;
  await flushPromises();
  return { w, plugins, calls };
}

describe('the page', () => {
  it('problems: the sentence, tiles, merged rows with a chip per place, the table, What changed, housekeeping', async () => {
    const { w } = await open('/all', 'pro', { [get()]: { status: 200, body: ATTENTION } });
    expect(w.get('[data-testid="ac-hero"]').text()).toBe('5 clusters and fleets need attention');
    expect(w.findAll('[data-testid^="ac-tile-"]')).toHaveLength(4);
    const rows = w.findAll('[data-testid="ac-problem"]');
    expect(rows).toHaveLength(5);
    // The same crash loop in staging and prod: one row, two chips, each to its own cluster.
    const chips = rows[0]!.findAll('[data-testid="ac-problem-place"]');
    expect(chips.map((c) => c.text())).toEqual(['acme-staging', 'acme-prod']);
    expect(chips[1]!.attributes('href')).toContain(`cluster=${EXAMPLE.clusters[0]!.id}`);
    expect(rows[1]!.findAll('[data-testid="ac-problem-place"]')).toHaveLength(1);
    // The table, by status; a silent server in red; the kind line in each side's words.
    const table = w.findAll('[data-testid="ac-row"]');
    expect(table).toHaveLength(6);
    expect(table[2]!.get('[data-testid="ac-row-reporting"]').classes()).toContain('text-critical');
    expect(table[3]!.get('[data-testid="ac-row-kind"]').text()).toBe(
      'Server fleet · 3 servers · PostgreSQL',
    );
    expect(w.findAll('[data-testid="ac-change"]')).toHaveLength(2);
    expect(w.findAll('[data-testid="ac-chore"]')).toHaveLength(4);
    expect(w.find('[data-testid="ac-upgrade"]').exists()).toBe(false);
    // The wide table scrolls inside its own box (390 px).
    expect(w.get('[data-testid="ac-table-scroll"]').classes()).toContain('overflow-x-auto');
  });

  it('healthy: the sentence, "Nothing needs attention" with the last resolved, the empty What changed', async () => {
    const { w } = await open('/all', 'pro', { [get()]: { status: 200, body: HEALTHY } });
    expect(w.get('[data-testid="ac-hero"]').text()).toBe('All 6 clusters and fleets are healthy');
    const none = w.get('[data-testid="ac-attention-none"]').text();
    expect(none).toContain('Nothing needs attention');
    expect(none).toContain('Disk on pg-02 in db-servers');
    expect(none).toContain('after 3h');
    expect(w.get('[data-testid="ac-changes-empty"]').text()).toBe(
      'Nothing has left its usual range in the last 24 hours, in any cluster or fleet.',
    );
  });

  it('the learning week: says which ones still learn', async () => {
    const s = {
      ...HEALTHY,
      whatChanged: { rows: [], total: 0, learning: [{ ...EXAMPLE.clusters[1]!, until: null }] },
    };
    const { w } = await open('/all', 'pro', { [get()]: { status: 200, body: s } });
    expect(w.get('[data-testid="ac-changes-learning"]').text()).toBe(
      'Still learning: acme-staging.',
    );
  });

  it('loading: skeletons', async () => {
    mockFetch({ [get()]: { status: 200, body: ATTENTION } });
    const plugins = await createPlugins('/all');
    useAuthStore().user = USER;
    useAuthStore().cloud = CONFIG;
    const w = mount(AllClustersPage, {
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    mounted = w;
    expect(w.find('[data-testid="ac-skeleton"]').exists()).toBe(true);
    await flushPromises();
    expect(w.find('[data-testid="ac-skeleton"]').exists()).toBe(false);
  });

  it('one cluster only: the page still works', async () => {
    const one = {
      ...HEALTHY,
      counts: { all: 1, kubernetes: 1, server: 0 },
      clusters: HEALTHY.clusters.slice(0, 1),
    };
    const { w } = await open('/all', 'pro', { [get()]: { status: 200, body: one } });
    expect(w.get('[data-testid="ac-hero"]').text()).toBe('The cluster or fleet is healthy');
    expect(w.findAll('[data-testid="ac-row"]')).toHaveLength(1);
  });

  it('the filter and the range are in the URL and the request', async () => {
    const server = {
      ...ATTENTION,
      kind: 'server' as const,
      clusters: ATTENTION.clusters.filter((c) => c.kind === 'server'),
    };
    const { w, plugins, calls } = await open('/all', 'pro', {
      [get()]: { status: 200, body: ATTENTION },
      [get(86_400, 'server')]: { status: 200, body: server },
      [get(604_800, 'server')]: { status: 200, body: server },
    });
    const filter = w.get('[data-testid="ac-filter"]').findAll('button');
    expect(filter.map((b) => b.text())).toEqual(['All 6', 'Kubernetes 3', 'Server fleets 3']);
    await filter[2]!.trigger('click');
    await flushPromises();
    expect(plugins.router.currentRoute.value.query.kind).toBe('server');
    expect(w.findAll('[data-testid="ac-row"]')).toHaveLength(3);
    const range = w.get('[data-testid="ac-range"]').findAll('button');
    await range.find((b) => b.text() === '7d')!.trigger('click');
    await flushPromises();
    expect(calls.map((c) => c.path)).toEqual([
      `/api/v1${allClustersPath(86_400, 'all')}`,
      `/api/v1${allClustersPath(86_400, 'server')}`,
      `/api/v1${allClustersPath(604_800, 'server')}`,
    ]);
  });

  it('Cloud Free: the example, blurred and hidden, under the card with the price', async () => {
    const { w } = await open('/all', 'free', {
      [get()]: {
        status: 403,
        body: { type: 'urn:watchlog:problem:pro-feature', title: 'Forbidden', status: 403 },
      },
      'GET /api/v1/plan': { status: 404 },
      'GET /api/v1/cloud/billing': { status: 404 },
    });
    const content = w.get('[data-testid="ac-content"]');
    expect(content.attributes('aria-hidden')).toBe('true');
    expect(content.classes()).toContain('blur-[5px]');
    const card = w.get('[data-testid="ac-upgrade"]');
    expect(card.text()).toContain('Every cluster and server fleet on one page');
    expect(card.text()).toContain('Behind this card: example data, not yours.');
    expect(card.find('[data-testid="ac-up-plan"]').exists()).toBe(true);
  });

  it('Cloud Free, a Viewer: "Ask an Owner"', async () => {
    const { w } = await open(
      '/all',
      'free',
      {
        [get()]: {
          status: 403,
          body: { type: 'urn:watchlog:problem:pro-feature', title: 'Forbidden', status: 403 },
        },
        'GET /api/v1/plan': { status: 404 },
        'GET /api/v1/users': { status: 200, body: { users: [] } },
      },
      'viewer',
    );
    expect(w.find('[data-testid="ac-up-ask"]').exists()).toBe(true);
  });

  it('Community: the card without asking anything, "Try WatchLog Cloud" and the demo', async () => {
    const { w, calls } = await open('/all', 'community', {});
    expect(calls).toEqual([]);
    const card = w.get('[data-testid="ac-upgrade"]');
    expect(card.get('[data-testid="ac-up-cloud"]').text()).toBe('Try WatchLog Cloud');
    expect(card.get('[data-testid="ac-up-demo"]').attributes('href')).toBe(
      'https://demo.watchlog.io/all',
    );
    expect(card.text()).toContain('keeps everything it has today');
  });
});

describe('getting there', () => {
  it('the sidebar: the first item with "Pro", and on the page the clusters and fleets with dots', async () => {
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [] } },
      [get()]: { status: 200, body: ATTENTION },
    });
    const plugins = await createPlugins('/all');
    useAuthStore().user = USER;
    useAuthStore().cloud = CONFIG;
    const w = mount(AppSidebar, {
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    mounted = w;
    await flushPromises();
    const first = w.get('[data-testid="nav-all"]');
    // A Pro org sees the plain name (ADR-227).
    expect(first.text()).toBe('All clusters and fleets');
    expect(first.attributes('aria-current')).toBe('page');
    const envs = w.findAll('[data-testid="nav-env"]');
    expect(envs.map((e) => e.text())).toEqual([
      'acme-prod12',
      'acme-staging4',
      'office-tools1/2',
      'db-servers3',
      'shop-servers6',
      'eu-edge3',
    ]);
    expect(envs[0]!.get('span').classes()).toContain('bg-critical');
    expect(envs[2]!.attributes('title')).toBe('office-tools · 1 of 2 reporting');
    expect(w.find('[data-testid="nav-add"]').exists()).toBe(true);
  });

  it('the switcher: "All clusters and fleets" first with its summary, then the two groups', async () => {
    const clusters = ATTENTION.clusters.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      status: 'active',
      nodeCount: c.hosts,
      agentVersion: null,
      firstSeenAt: null,
      lastSeenAt: null,
      createdAt: '2026-11-01T00:00:00Z',
      ingestFailure: null,
    }));
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters } },
      [get()]: { status: 200, body: ATTENTION },
    });
    const plugins = await createPlugins('/all');
    useAuthStore().user = USER;
    useAuthStore().cloud = CONFIG;
    const w = mount(ClusterSwitcher, {
      props: { collapsed: false },
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
      attachTo: document.body,
    });
    mounted = w;
    await flushPromises();
    const input = w.get('[data-testid="cluster-switcher"] [role="combobox"]');
    await input.trigger('focus');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    const options = listedOptions();
    expect(options[0]).toContain('All clusters and fleets');
    expect(options[0]).not.toContain('Pro');
    expect(options[0]).toContain('5 need attention · 30 nodes and servers');
    expect(options[1]).toContain('acme-prod');
    expect(options.some((o) => o.includes('office-tools') && o.includes('1 of 2 reporting'))).toBe(
      true,
    );
    expect(document.body.textContent).toContain('Server fleets');
  });

  describe('the landing rule', () => {
    async function land(from: string | null, count: number | null, offered = true) {
      const router = createRouter({ history: createMemoryHistory(), routes });
      installLandingRule(router, () => ({
        offered,
        summary: async () => (count === null ? null : { counts: { all: count } }),
      }));
      if (from) await router.push(from);
      await router.push('/');
      return router.currentRoute.value.name;
    }
    it('Pro with two or more lands on All clusters and fleets after sign-in', async () => {
      expect(await land('/login', 2)).toBe('all-clusters');
      expect(await land(null, 3)).toBe('all-clusters');
    });
    it('one cluster, Free, Community, or a click inside the app: Overview as today', async () => {
      expect(await land('/login', 1)).toBe('overview');
      expect(await land('/login', null)).toBe('overview');
      expect(await land('/login', 5, false)).toBe('overview');
      expect(await land('/alerts', 5)).toBe('overview');
    });
  });
});
