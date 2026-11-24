// SPDX-License-Identifier: AGPL-3.0-only
// Cloud plans in the pages (ADR-177, slice 4): the plan strip with real counts, the
// over-limit and downgrade banners, Settings › Plan & billing (Cloud only), and the
// plan-limit messages of Add cluster, the wizard and invites. Every one of them offers Pro
// the same way (useProOffer, 0.9.5): the price from GET /plan, and "free during the beta"
// only while the billing service itself says the beta is on.
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planLimitKind, type CloudConfig, type PlanInfo } from '@/api/cloud';
import { ApiError } from '@/api/client';
import PlanBanner from '@/components/plan/PlanBanner.vue';
import PlanStrip from '@/components/plan/PlanStrip.vue';
import { useProOffer } from '@/composables/useProOffer';
import { useAuthStore } from '@/stores/auth';
import { usePlanStore } from '@/stores/plan';
import SettingsPage from '@/views/SettingsPage.vue';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

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
};

const PRICE = {
  currency: 'USD',
  perNodeMonth: 3,
  minimumMonth: 15,
  annualPerNode: 30,
  annualMinimumNodes: 5,
};
/** The billing service's answer: the live switch on or off. */
const billingIs = (live: boolean) => ({
  available: true,
  live,
  customer: false,
  subscription: null,
  beta: null,
  dunning: null,
});
/** What the billing service says, or that it couldn't be reached. */
type Billing = 'live' | 'beta' | 'unreachable';
const billingRoute = (b: Billing) => ({
  'GET /api/v1/plan/billing':
    b === 'unreachable' ? { status: 502 } : { status: 200, body: billingIs(b === 'live') },
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mountWith(component: unknown, path = '/', cloud = true) {
  const plugins = await createPlugins(path);
  const auth = useAuthStore();
  auth.cloud = cloud ? CONFIG : null;
  auth.loaded = true;
  auth.user = USER;
  const wrapper = mount(component as never, {
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  return { wrapper, plugins };
}

async function withPlan(info: PlanInfo, component: unknown) {
  mockFetch({ 'GET /api/v1/plan': { status: 200, body: info } });
  const m = await mountWith(component);
  await usePlanStore().load();
  await flushPromises();
  return m;
}

describe('the plan strip', () => {
  it('Free: "3 of 5 nodes", 3 days of data, 1 user, and the upgrade to Plan & billing', async () => {
    const { wrapper } = await withPlan(FREE, PlanStrip);
    const strip = wrapper.get('[data-testid="plan-strip"]');
    expect(strip.text()).toContain('Free plan');
    expect(wrapper.get('[data-testid="plan-nodes"]').text()).toBe('3 of 5 nodes');
    expect(strip.text()).toContain('3 days of data · 1 user');
    const link = wrapper.get('[data-testid="plan-try-pro"]');
    // No price in this answer and no word from billing: the upgrade, with no amount, and
    // nothing about a free beta.
    expect(link.text()).toBe('Upgrade to Pro →');
    expect(link.attributes('href')).toBe('/settings?tab=billing');
    expect(strip.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('3');
  });

  it('Pro: the node count without a limit, up to 10 users, Plan & billing', async () => {
    const { wrapper } = await withPlan(
      {
        ...FREE,
        plan: 'pro',
        limits: { clusters: null, nodes: null, users: 10, retentionDays: 30 },
        usage: { ...FREE.usage, nodes: 12 },
      },
      PlanStrip,
    );
    expect(wrapper.get('[data-testid="plan-nodes"]').text()).toBe('12 nodes');
    expect(wrapper.text()).toContain('30 days of data · up to 10 users');
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="plan-try-pro"]').text()).toBe('Plan & billing →');
  });

  it('Free: the price from GET /plan while billing is live; the beta only while billing says it is off; never "free" when billing can’t be reached', async () => {
    const want: Record<Billing, string> = {
      live: 'Upgrade to Pro · $3 per node →',
      beta: 'Try Pro, free during beta →',
      unreachable: 'Upgrade to Pro · $3 per node →',
    };
    for (const b of ['live', 'beta', 'unreachable'] as Billing[]) {
      mockFetch({
        'GET /api/v1/plan': { status: 200, body: { ...FREE, price: PRICE } },
        ...billingRoute(b),
      });
      const { wrapper } = await mountWith(PlanStrip);
      await usePlanStore().load();
      await flushPromises();
      const link = wrapper.get('[data-testid="plan-try-pro"]');
      expect(link.text(), b).toBe(want[b]);
      expect(link.attributes('href')).toBe('/settings?tab=billing');
      expect(usePlanStore().betaOpen, b).toBe(b === 'beta');
      wrapper.unmount();
    }
    // Another price in the plans config is another price on the strip.
    mockFetch({
      'GET /api/v1/plan': { status: 200, body: { ...FREE, price: { ...PRICE, perNodeMonth: 4 } } },
      ...billingRoute('live'),
    });
    const { wrapper } = await mountWith(PlanStrip);
    await usePlanStore().load();
    await flushPromises();
    expect(wrapper.get('[data-testid="plan-try-pro"]').text()).toBe(
      'Upgrade to Pro · $4 per node →',
    );
  });

  it('Pro never asks billing for the strip; two callers at once share one read of the plan', async () => {
    const pro = mockFetch({
      'GET /api/v1/plan': {
        status: 200,
        body: { ...FREE, plan: 'pro', proFeatures: true, limits: { ...FREE.limits, nodes: null } },
      },
    });
    const a = await mountWith(PlanStrip);
    await Promise.all([usePlanStore().load(), usePlanStore().load()]);
    await flushPromises();
    expect(a.wrapper.get('[data-testid="plan-try-pro"]').text()).toBe('Plan & billing →');
    expect(pro.calls.map((c) => c.path)).toEqual(['/api/v1/plan']);
  });

  it('shows nothing when the plan could not be read (Community never asks)', async () => {
    mockFetch({ 'GET /api/v1/plan': { status: 404 } });
    const { wrapper } = await mountWith(PlanStrip);
    await usePlanStore().load();
    await flushPromises();
    expect(wrapper.find('[data-testid="plan-strip"]').exists()).toBe(false);
  });
});

describe('the banners', () => {
  it('over the limit: the count and the way out', async () => {
    const { wrapper } = await withPlan(
      { ...FREE, usage: { ...FREE.usage, nodes: 5 }, refusedNodes: 1 },
      PlanBanner,
    );
    const b = wrapper.get('[data-testid="over-limit-banner"]');
    expect(b.text()).toContain(
      "A new node can't send data: Free allows 5 nodes, and 5 already send.",
    );
    expect(b.get('a').attributes('href')).toBe('/settings?tab=billing');
    // The way out is the upgrade, not a free beta nobody said is on.
    expect(b.get('[data-testid="banner-link"]').text()).toBe('Upgrade to Pro →');
    const three = await withPlan(
      { ...FREE, usage: { ...FREE.usage, nodes: 5 }, refusedNodes: 3 },
      PlanBanner,
    );
    expect(three.wrapper.text()).toContain("3 new nodes can't send data");
  });

  it('after a downgrade: the days left and what stops after them', async () => {
    const { wrapper } = await withPlan(
      {
        ...FREE,
        usage: { ...FREE.usage, nodes: 8, clusters: 2 },
        downgrade: {
          graceUntil: '2026-11-28T09:00:00.000Z',
          daysLeft: 14,
          ended: false,
          nodesOver: 3,
          clustersOver: 1,
        },
      },
      PlanBanner,
    );
    const b = wrapper.get('[data-testid="downgrade-banner"]');
    expect(b.text()).toContain('Your plan is now Free.');
    expect(b.text()).toContain('keeps sending until Nov 28, 14 days from now');
    expect(b.text()).toContain('3 nodes and 1 cluster beyond the plan stop sending, newest first');
  });

  it('the banner’s link is the same offer: the price when live, the beta only when billing says so; "Plan & billing" for an org that pays', async () => {
    const over = { ...FREE, usage: { ...FREE.usage, nodes: 5 }, refusedNodes: 1, price: PRICE };
    const want: Record<Billing, string> = {
      live: 'Upgrade to Pro · $3 per node →',
      beta: 'Try Pro, free during beta →',
      unreachable: 'Upgrade to Pro · $3 per node →',
    };
    for (const b of ['live', 'beta', 'unreachable'] as Billing[]) {
      mockFetch({ 'GET /api/v1/plan': { status: 200, body: over }, ...billingRoute(b) });
      const { wrapper } = await mountWith(PlanBanner);
      await usePlanStore().load();
      await flushPromises();
      expect(wrapper.get('[data-testid="banner-link"]').text(), b).toBe(want[b]);
      wrapper.unmount();
    }
    const { wrapper } = await withPlan(
      {
        ...over,
        plan: 'pro',
        downgrade: null,
        limits: { ...FREE.limits, nodes: 50 },
        usage: { ...FREE.usage, nodes: 50 },
      },
      PlanBanner,
    );
    expect(wrapper.get('[data-testid="banner-link"]').text()).toBe('Plan & billing →');
  });

  it('none while under the limit', async () => {
    const { wrapper } = await withPlan(FREE, PlanBanner);
    expect(wrapper.find('[role="region"]').exists()).toBe(false);
  });
});

describe('Settings › Plan & billing', () => {
  it('Cloud: the tab shows the plan, the meters, how nodes are counted; Phase 6 is "coming to Pro"', async () => {
    mockFetch({ 'GET /api/v1/plan': [{ status: 200, body: FREE }] });
    const { wrapper } = await mountWith(SettingsPage, '/settings?tab=billing');
    await flushPromises();
    expect(wrapper.get('[data-testid="settings-tab-billing"]').text()).toBe('Plan & billing');
    const page = wrapper.get('[data-testid="plan-billing"]');
    expect(page.text()).toContain('Your plan: Free');
    expect(page.text()).toContain('Period 1–30 November');
    expect(wrapper.get('[data-testid="meter-nodes"]').text()).toContain('3 / 5');
    expect(wrapper.get('[data-testid="meter-nodes"]').text()).toContain('peak this period: 4');
    expect(wrapper.get('[data-testid="meter-clusters"]').text()).toContain('1 / 1');
    expect(wrapper.get('[data-testid="meter-users"]').text()).toContain('Pro: up to 10');
    expect(wrapper.get('[data-testid="meter-retention"]').text()).toContain('3 days');
    expect(wrapper.get('[data-testid="pro-card"]').text()).toContain('coming to Pro');
    expect(wrapper.get('[data-testid="how-counted"]').text()).toContain('95th percentile');
    // Without an answer from the billing service, no action (cloud-billing.test.ts has them),
    // and no notice that Pro is free: only billing itself can say the beta is on.
    expect(wrapper.find('[data-testid="start-beta"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="beta-notice"]').exists()).toBe(false);
    expect(page.text()).not.toMatch(/free (until|during)/i);
  });

  it('Community: no Plan & billing tab', async () => {
    mockFetch({});
    const { wrapper } = await mountWith(SettingsPage, '/settings?tab=billing', false);
    expect(wrapper.find('[data-testid="settings-tab-billing"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="plan-billing"]').exists()).toBe(false);
  });
});

describe('plan-limit messages', () => {
  const err = (limit?: string) =>
    new ApiError(409, {
      type: 'urn:watchlog:problem:plan-limit',
      title: 'Conflict',
      status: 409,
      code: 'plan-limit',
      ...(limit ? { limit } : {}),
    });
  /** A page that shows what a refusal says, the way Add cluster, the wizard and invites do. */
  const Harness = defineComponent({
    setup() {
      const offer = useProOffer();
      return () =>
        h('ul', [
          ...(['clusters', 'users', 'nodes', undefined] as const).map((limit) =>
            h(
              'li',
              { 'data-testid': `limit-${limit ?? 'other'}` },
              String(offer.limitMessage(err(limit))),
            ),
          ),
          h('li', { 'data-testid': 'not-a-limit' }, String(offer.limitMessage(new Error('x')))),
        ]);
    },
  });
  const say = (wrapper: { get(s: string): { text(): string } }, limit: string) =>
    wrapper.get(`[data-testid="limit-${limit}"]`).text();
  const OFFER = {
    live: 'Upgrade to Pro in Settings › Plan & billing: $3 per node, server or network device a month, $15 minimum.',
    beta: 'Try Pro, free during the beta, in Settings › Plan & billing.',
    plain: 'Upgrade to Pro in Settings › Plan & billing.',
  };

  it('which limit a refusal names', () => {
    expect(planLimitKind(err('clusters'))).toBe('clusters');
    expect(planLimitKind(err('users'))).toBe('users');
    expect(planLimitKind(err('nodes'))).toBe('nodes');
    expect(planLimitKind(err())).toBe('other');
    expect(planLimitKind(err('retention'))).toBe('other');
    expect(planLimitKind(new ApiError(409, { type: 'about:blank', title: 'x', status: 409 }))).toBe(
      null,
    );
  });

  it('billing live: each names its limit and offers the real upgrade, at the price from GET /plan', async () => {
    mockFetch({
      'GET /api/v1/plan': { status: 200, body: { ...FREE, price: PRICE } },
      ...billingRoute('live'),
    });
    const { wrapper } = await mountWith(Harness);
    await usePlanStore().load();
    await flushPromises();
    expect(say(wrapper, 'clusters')).toBe(
      `Cloud Free has one cluster or Server fleet; Pro has no limit on them. ${OFFER.live}`,
    );
    expect(say(wrapper, 'users')).toBe(
      `Cloud Free has one user (an open invite counts too); Pro has room for your team. ${OFFER.live}`,
    );
    expect(say(wrapper, 'nodes')).toBe(
      `This node is over Cloud Free's node limit; Pro has none. ${OFFER.live}`,
    );
    expect(say(wrapper, 'other')).toBe(`Your plan's limit is reached. ${OFFER.live}`);
    expect(wrapper.text()).not.toMatch(/beta|free during|Try Pro/i);
    expect(wrapper.get('[data-testid="not-a-limit"]').text()).toBe('null');
    // The amounts are the plans config's, not the copy's.
    wrapper.unmount();
    mockFetch({
      'GET /api/v1/plan': {
        status: 200,
        body: { ...FREE, price: { ...PRICE, perNodeMonth: 4, minimumMonth: 20 } },
      },
      ...billingRoute('live'),
    });
    const other = await mountWith(Harness);
    await usePlanStore().load();
    await flushPromises();
    expect(say(other.wrapper, 'clusters')).toContain(
      '$4 per node, server or network device a month, $20 minimum.',
    );
  });

  it('billing out of reach, or no price yet: still the upgrade, never "free"', async () => {
    mockFetch({
      'GET /api/v1/plan': { status: 200, body: { ...FREE, price: PRICE } },
      ...billingRoute('unreachable'),
    });
    let { wrapper } = await mountWith(Harness);
    await usePlanStore().load();
    await flushPromises();
    for (const limit of ['clusters', 'users', 'nodes', 'other']) {
      expect(say(wrapper, limit), limit).toContain(OFFER.live);
    }
    expect(wrapper.text()).not.toMatch(/beta|free during/i);
    wrapper.unmount();
    // Nothing read yet (a page that opened before the plan arrived): no amount, no beta.
    mockFetch({});
    ({ wrapper } = await mountWith(Harness));
    for (const limit of ['clusters', 'users', 'nodes', 'other']) {
      expect(say(wrapper, limit), limit).toContain(OFFER.plain);
    }
    expect(wrapper.text()).not.toMatch(/beta|free during|\$/i);
  });

  it('the beta’s free Pro only while the billing service says it is off', async () => {
    mockFetch({
      'GET /api/v1/plan': { status: 200, body: { ...FREE, price: PRICE } },
      ...billingRoute('beta'),
    });
    const { wrapper } = await mountWith(Harness);
    await usePlanStore().load();
    await flushPromises();
    for (const limit of ['clusters', 'users', 'nodes', 'other']) {
      expect(say(wrapper, limit), limit).toContain(OFFER.beta);
    }
    expect(wrapper.text()).not.toContain('$3');
  });

  it('an org that already pays is not offered Pro', async () => {
    const { wrapper } = await withPlan(
      { ...FREE, plan: 'pro', price: PRICE, limits: { ...FREE.limits, users: 10 } },
      Harness,
    );
    expect(say(wrapper, 'users')).toBe(
      'Your plan has no room for another user (open invites count too). Remove one, or ask about Enterprise.',
    );
    expect(say(wrapper, 'clusters')).toBe(
      "Your plan's cluster limit is reached. Contact support to raise it.",
    );
    expect(wrapper.text()).not.toMatch(/Upgrade to Pro|beta/i);
  });
});
