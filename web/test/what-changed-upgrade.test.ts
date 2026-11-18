// SPDX-License-Identifier: AGPL-3.0-only
// The upgrade page (ADR-201; v0.8 slice 5): what Cloud Free and Community see in place of
// What changed, on a Kubernetes cluster and a Server fleet. The demo's example labelled, the
// org's own last alerts, the three reasons, Pro's price from the plans config, and the button
// by edition, role and billing state: Checkout while billing is live, Settings › Plan & billing
// while it is off, "Ask an Owner" for Admins and Viewers, "Try WatchLog Cloud" for Community.
// Pro never sees it.
import type { Alert } from '@watchlog/api-types';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingState, CloudConfig, PlanInfo } from '@/api/cloud';
import { leaveFor } from '@/api/cloud';
import { LINKS } from '@/lib/links';
import { whatChangedPath } from '@/lib/what-changed';
import { demoExample, lastAlerts, money, upgradeAction } from '@/lib/what-changed-upgrade';
import { useAuthStore } from '@/stores/auth';
import WhatChangedPage from '@/views/WhatChangedPage.vue';
import { FLEET } from './docker-fixtures';
import { mockFetch, USER, type Routes } from './fetch-mock';
import { createPlugins } from './helpers';
import { LEARNED } from './learning-fixtures';

vi.mock('@/api/cloud', async (original) => ({
  ...(await original<typeof import('@/api/cloud')>()),
  leaveFor: vi.fn(),
}));

const NOW = Date.UTC(2026, 10, 17, 14, 10, 0);
const K8S = {
  ...FLEET,
  id: '01a1de8d-e52d-7188-9878-62ee5fd5309d',
  name: 'acme-prod',
  kind: 'kubernetes',
};
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
const PRICE = {
  currency: 'USD',
  perNodeMonth: 3,
  minimumMonth: 15,
  annualPerNode: 30,
  annualMinimumNodes: 5,
};
const FREE: PlanInfo = {
  plan: 'free',
  source: 'signup',
  betaUntil: null,
  proFeatures: false,
  limits: { clusters: 1, nodes: 5, users: 1, retentionDays: 3 },
  usage: { clusters: 1, nodes: 3, kubernetesNodes: 3, dockerHosts: 0, users: 1 },
  period: { from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z', p95: 3, peak: 4 },
  refusedNodes: 0,
  downgrade: null,
  price: PRICE,
};
const OFF: BillingState = {
  available: true,
  live: false,
  customer: false,
  subscription: null,
  beta: null,
  dunning: null,
};
const LIVE: BillingState = { ...OFF, live: true };
const PRO_FEATURE = {
  status: 403,
  body: { type: 'urn:watchlog:problem:pro-feature', title: 'Forbidden', status: 403 },
};

const alertOf = (c: typeof K8S, id: string, title: string, startedAt: string) =>
  ({
    id,
    title,
    state: 'resolved',
    severity: 'warning',
    startedAt,
    cluster: { id: c.id, name: c.name, kind: c.kind },
  }) as unknown as Alert;
const list = (alerts: Alert[]) => ({
  status: 200,
  body: {
    alerts,
    nextCursor: null,
    counts: { firing: 0, critical: 0, warning: 0, pending: 0, silenced: 0, held: 0 },
  },
});
const ALERTS = {
  kubernetes: [
    alertOf(
      K8S,
      '01a19300-0000-7000-8000-0000000000a1',
      'checkout was OOM-killed at its 512 MiB limit',
      '2026-11-17T13:02:00Z',
    ),
    alertOf(
      K8S,
      '01a19300-0000-7000-8000-0000000000a2',
      'api is crash-looping, exit code 1',
      '2026-11-12T09:15:00Z',
    ),
  ],
  docker: [
    alertOf(
      FLEET,
      '01a19300-0000-7000-8000-0000000000d1',
      'shop-web-1 was OOM-killed at its 256 MiB limit',
      '2026-11-16T22:40:00Z',
    ),
  ],
};
const alertRoutes = (c: typeof K8S, firing: Alert[], history: Alert[]): Routes => ({
  [`GET /api/v1/alerts?view=firing&clusterId=${c.id}&limit=5`]: list(firing),
  [`GET /api/v1/alerts?view=history&clusterId=${c.id}&limit=5`]: list(history),
});
const page = (c: typeof K8S): Routes => ({
  'GET /api/v1/clusters': { status: 200, body: { clusters: [c] } },
});
const wc = (c: typeof K8S) => `GET /api/v1${whatChangedPath(c.id, { window: '1h' }, NOW)}`;

let mounted: VueWrapper | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(leaveFor).mockReset();
});

type Edition = 'free' | 'community' | 'pro';
async function open(c: typeof K8S, edition: Edition, role: 'owner' | 'admin' | 'viewer') {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const plugins = await createPlugins(`/what-changed?cluster=${c.id}`);
  const auth = useAuthStore();
  auth.user = { ...USER, role };
  auth.cloud = edition === 'community' ? null : CONFIG;
  auth.demoMode = false;
  const w = mount(WhatChangedPage, {
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  mounted = w;
  await flushPromises();
  await flushPromises();
  return { w, router: plugins.router };
}
const done = () => {
  mounted!.unmount();
  mounted = null;
};
const platformOf = (c: typeof K8S): 'docker' | 'kubernetes' =>
  c.kind === 'server' ? 'docker' : 'kubernetes';

describe('Cloud Free, an Owner', () => {
  it('billing off: the example labelled, the alerts, the reasons, the price, and Plan & billing', async () => {
    for (const c of [K8S, FLEET]) {
      const p = platformOf(c);
      const { calls } = mockFetch({
        ...page(c),
        [wc(c)]: PRO_FEATURE,
        ...alertRoutes(c, [], ALERTS[p]),
        'GET /api/v1/plan': { status: 200, body: FREE },
        'GET /api/v1/plan/billing': { status: 200, body: OFF },
      });
      const { w } = await open(c, 'free', 'owner');
      const up = w.get('[data-testid="wc-upgrade"]');
      expect(w.find('[data-testid="wc-hero"]').exists()).toBe(false);
      // The demo's example, clearly the demo's.
      expect(w.get('[data-testid="wc-up-demo-label"]').text()).toBe(
        p === 'docker' ? 'Live demo · not your fleet' : 'Live demo · not your cluster',
      );
      expect(w.get('[data-testid="wc-up-example"]').findAll('[data-testid="wc-row"]')).toHaveLength(
        3,
      );
      expect(w.get('[data-testid="wc-up-example"]').find('a').exists()).toBe(false);
      // The org's own alerts, each locked to Pro and linking to its page.
      const rows = w.findAll('[data-testid="wc-up-alert"]');
      expect(rows).toHaveLength(ALERTS[p].length);
      expect(rows[0]!.text()).toContain(ALERTS[p][0]!.title);
      expect(rows[0]!.text()).toContain('What changed: Pro');
      expect(rows[0]!.attributes('href')).toBe(`/alerts/${ALERTS[p][0]!.id}`);
      expect(w.get('[data-testid="wc-up-alerts"]').text()).toContain(
        `Your last alerts in ${c.name}`,
      );
      // The three reasons, in the platform's words.
      const reasons = w.get('[data-testid="wc-up-reasons"]').text();
      expect(reasons).toContain('The first thing that moved');
      expect(reasons).toContain('Alerts with no thresholds');
      expect(reasons).toContain('30 days to learn from');
      expect(reasons).toContain(p === 'docker' ? 'Compose change' : 'after a rollout');
      // The price, and no beta or Stripe wording while billing is off.
      expect(w.get('[data-testid="wc-up-badge"]').text()).toBe('Pro · $3 per node a month');
      expect(w.get('[data-testid="wc-up-fine"]').text()).toBe(
        p === 'docker'
          ? '$3 per server a month, $15 minimum, billed on the 95th percentile of your servers.'
          : '$3 per node a month, $15 minimum, billed on the 95th percentile of your nodes.',
      );
      expect(up.text()).not.toMatch(/beta|Stripe/i);
      expect(up.text()).toContain('What changed learns your normal week.');
      expect(up.text()).toContain('Egress watch stay free on every plan');
      // The button: Plan & billing, where the beta switch is.
      expect(w.get('[data-testid="wc-up-plan"]').attributes('href')).toBe('/settings?tab=billing');
      expect(w.get('[data-testid="wc-up-plan"]').text()).toBe('Upgrade to Pro');
      expect(w.find('[data-testid="wc-up-checkout"]').exists()).toBe(false);
      expect(calls.some((x) => x.method === 'POST')).toBe(false);
      done();
    }
  });

  it('billing live: Upgrade to Pro opens Stripe Checkout, and the fine print names Stripe', async () => {
    for (const c of [K8S, FLEET]) {
      const { calls } = mockFetch({
        ...page(c),
        [wc(c)]: PRO_FEATURE,
        ...alertRoutes(c, [], []),
        'GET /api/v1/plan': { status: 200, body: FREE },
        'GET /api/v1/plan/billing': { status: 200, body: LIVE },
        'POST /api/v1/plan/checkout': {
          status: 200,
          body: { url: 'https://checkout.stripe.com/c/pay/cs_test_1' },
        },
      });
      const { w } = await open(c, 'free', 'owner');
      // A space before Stripe's sentence (Vue drops a template's leading whitespace).
      expect(w.get('[data-testid="wc-up-fine"]').text()).toMatch(/\. Paid through Stripe/);
      expect(w.get('[data-testid="wc-up-fine"]').text()).toContain(
        'Paid through Stripe; cancel any time.',
      );
      expect(w.get('[data-testid="wc-upgrade"]').text()).not.toMatch(/beta/i);
      expect(w.find('[data-testid="wc-up-plan"]').exists()).toBe(false);
      await w.get('[data-testid="wc-up-checkout"]').trigger('click');
      await flushPromises();
      expect(calls.find((x) => x.method === 'POST')).toMatchObject({
        path: '/api/v1/plan/checkout',
        body: { interval: 'monthly' },
      });
      expect(leaveFor).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1');
      expect(w.find('[data-testid="wc-up-alerts-none"]').text()).toContain(
        c.kind === 'server' ? `No alerts on ${c.name} yet` : `No alerts in ${c.name} yet`,
      );
      vi.mocked(leaveFor).mockReset();
      done();
    }
  });

  it('billing switched off since the page loaded: Checkout answers billing-not-live, Plan & billing opens', async () => {
    mockFetch({
      ...page(K8S),
      [wc(K8S)]: PRO_FEATURE,
      ...alertRoutes(K8S, [], []),
      'GET /api/v1/plan': { status: 200, body: FREE },
      'GET /api/v1/plan/billing': { status: 200, body: LIVE },
      'POST /api/v1/plan/checkout': {
        status: 409,
        body: {
          type: 'urn:watchlog:problem:billing-not-live',
          title: 'Conflict',
          status: 409,
          code: 'billing-not-live',
        },
      },
    });
    const { w, router } = await open(K8S, 'free', 'owner');
    await w.get('[data-testid="wc-up-checkout"]').trigger('click');
    await flushPromises();
    await vi.waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe('/settings?tab=billing'),
    );
    expect(leaveFor).not.toHaveBeenCalled();
    expect(w.find('[data-testid="wc-up-error"]').exists()).toBe(false);
  });

  it("the price is the plans config's, not the copy's", async () => {
    mockFetch({
      ...page(K8S),
      [wc(K8S)]: PRO_FEATURE,
      ...alertRoutes(K8S, [], []),
      'GET /api/v1/plan': {
        status: 200,
        body: { ...FREE, price: { ...PRICE, perNodeMonth: 2, minimumMonth: 25 } },
      },
      'GET /api/v1/plan/billing': { status: 200, body: OFF },
    });
    const { w } = await open(K8S, 'free', 'owner');
    expect(w.get('[data-testid="wc-up-badge"]').text()).toBe('Pro · $2 per node a month');
    expect(w.get('[data-testid="wc-up-fine"]').text()).toContain(
      '$2 per node a month, $25 minimum',
    );
  });

  it('billing service out of reach: still Plan & billing', async () => {
    mockFetch({
      ...page(K8S),
      [wc(K8S)]: PRO_FEATURE,
      ...alertRoutes(K8S, [], []),
      'GET /api/v1/plan': { status: 200, body: FREE },
      'GET /api/v1/plan/billing': { status: 200, body: { ...LIVE, available: false } },
    });
    const { w } = await open(K8S, 'free', 'owner');
    expect(w.find('[data-testid="wc-up-plan"]').exists()).toBe(true);
    expect(w.get('[data-testid="wc-up-fine"]').text()).not.toContain('Stripe');
  });
});

describe('Cloud Free, an Admin or a Viewer', () => {
  it('sees "Ask an Owner to upgrade" and who the Owners are, and never starts Checkout', async () => {
    for (const role of ['admin', 'viewer'] as const) {
      for (const c of [K8S, FLEET]) {
        const { calls } = mockFetch({
          ...page(c),
          [wc(c)]: PRO_FEATURE,
          ...alertRoutes(c, ALERTS[platformOf(c)], []),
          'GET /api/v1/plan': { status: 200, body: FREE },
          'GET /api/v1/users': {
            status: 200,
            body: {
              users: [
                { name: 'Grace Hopper', email: 'grace@example.com', role: 'owner' },
                { name: '', email: 'lin@example.com', role: 'owner' },
                { name: 'Ada Admin', email: 'ada@example.com', role },
              ],
              invites: [],
              smtp: false,
              audit: [],
            },
          },
        });
        const { w } = await open(c, 'free', role);
        expect(w.get('[data-testid="wc-up-ask"]').text()).toBe('Ask an Owner to upgrade');
        expect(w.get('[data-testid="wc-up-owners"]').text()).toBe(
          'Owners: Grace Hopper, lin@example.com',
        );
        expect(w.find('[data-testid="wc-up-checkout"]').exists()).toBe(false);
        expect(w.find('[data-testid="wc-up-plan"]').exists()).toBe(false);
        // No Checkout or beta switch for an Admin (the plan strip may read the billing state).
        expect(calls.some((x) => x.method === 'POST' && x.path.startsWith('/api/v1/plan/'))).toBe(
          false,
        );
        expect(w.findAll('[data-testid="wc-up-alert"]')).toHaveLength(ALERTS[platformOf(c)].length);
        expect(w.get('[data-testid="wc-up-badge"]').text()).toBe('Pro · $3 per node a month');
        done();
      }
    }
  });
});

describe('Community', () => {
  it('"Try WatchLog Cloud", its alerts with "What changed: Cloud Pro", and nothing asked of Cloud', async () => {
    for (const c of [K8S, FLEET]) {
      const p = platformOf(c);
      const { calls } = mockFetch({ ...page(c), ...alertRoutes(c, ALERTS[p], []) });
      const { w } = await open(c, 'community', 'owner');
      const up = w.get('[data-testid="wc-upgrade"]');
      expect(up.attributes('data-access')).toBe('community');
      expect(w.get('[data-testid="wc-up-badge"]').text()).toBe('WatchLog Cloud Pro');
      const cta = w.get('[data-testid="wc-up-cloud"]');
      expect(cta.attributes('href')).toBe(LINKS.cloudSignup);
      expect(cta.text()).toContain('Try WatchLog Cloud');
      expect(w.get('[data-testid="wc-up-fine"]').text()).toBe(
        'Your self-hosted install keeps everything it has today, with no limits.',
      );
      expect(w.get('[data-testid="wc-up-alert"]').text()).toContain('What changed: Cloud Pro');
      expect(up.text()).not.toMatch(/\$|Stripe|beta/);
      // Only the install's own clusters and alerts: no plan, billing or What changed request.
      expect(
        calls.every((x) => x.path === '/api/v1/clusters' || x.path.startsWith('/api/v1/alerts?')),
      ).toBe(true);
      done();
    }
  });
});

describe('Pro', () => {
  it('never sees the upgrade page', async () => {
    mockFetch({
      ...page(K8S),
      [wc(K8S)]: {
        status: 200,
        body: {
          cluster: { id: K8S.id, name: K8S.name, kind: K8S.kind },
          window: {
            from: new Date(NOW - 3_600_000).toISOString(),
            to: new Date(NOW).toISOString(),
            alert: null,
          },
          sort: 'first',
          chart: {
            from: new Date(NOW - 3_600_000).toISOString(),
            to: new Date(NOW).toISOString(),
            step: 60,
            counts: [0, 0],
          },
          rows: [],
          total: 0,
          truncated: false,
          learning: LEARNED,
          cause: { subject: null, likely: null },
        },
      },
    });
    const { w } = await open(K8S, 'pro', 'viewer');
    expect(w.find('[data-testid="wc-hero"]').exists()).toBe(true);
    expect(w.find('[data-testid="wc-upgrade"]').exists()).toBe(false);
  });
});

describe('the helpers', () => {
  it('upgradeAction: by edition, role and billing state', () => {
    const live = { available: true, live: true };
    const off = { available: true, live: false };
    expect(upgradeAction('free', 'owner', live)).toBe('checkout');
    expect(upgradeAction('free', 'owner', off)).toBe('plan');
    expect(upgradeAction('free', 'owner', { available: false, live: true })).toBe('plan');
    expect(upgradeAction('free', 'owner', null)).toBe('plan');
    expect(upgradeAction('free', 'admin', live)).toBe('ask-owner');
    expect(upgradeAction('free', 'viewer', off)).toBe('ask-owner');
    expect(upgradeAction('community', 'owner', live)).toBe('cloud');
  });

  it('lastAlerts: firing and history merged, newest first, each once, at most three', () => {
    const a = (id: string, at: string) => ({ id, startedAt: at }) as Alert;
    expect(
      lastAlerts(
        [a('f1', '2026-11-17T10:00:00Z'), a('h1', '2026-11-17T12:00:00Z')],
        [
          a('h1', '2026-11-17T12:00:00Z'),
          a('h2', '2026-11-16T10:00:00Z'),
          a('h3', '2026-11-15T10:00:00Z'),
        ],
      ).map((x) => x.id),
    ).toEqual(['h1', 'f1', 'h2']);
  });

  it('money and the demo example in each platform', () => {
    expect(money(1, 'USD')).toBe('$1');
    expect(money(10, 'USD')).toBe('$10');
    expect(money(1.5, 'USD')).toBe('$1.50');
    const k = demoExample('kubernetes', NOW);
    expect(k.rows.map((r) => r.object.kind)).toEqual(['service', 'workload', 'workload']);
    const d = demoExample('docker', NOW);
    expect(d.rows.every((r) => r.object.kind === 'container')).toBe(true);
    expect(d.rows[0]!.object).toMatchObject({
      composeProject: 'storefront',
      composeService: 'worker',
    });
    expect(Math.max(...k.chart.chart.counts)).toBeGreaterThan(5);
  });
});
