// SPDX-License-Identifier: AGPL-3.0-only
// Settings › Plan & billing's actions (ADR-178, Cloud slice 5): the monthly/annual toggle
// and its estimate, "Start Pro, free during beta" while billing is off, Upgrade (Checkout)
// and Manage billing (the portal) once it's live, Owners only, the refusals' words, and
// the beta's Pro on the plan strip.
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingState, CloudConfig, PlanInfo } from '@/api/cloud';
import { leaveFor } from '@/api/cloud';
import PlanBilling from '@/components/plan/PlanBilling.vue';
import PlanStrip from '@/components/plan/PlanStrip.vue';
import { useAuthStore } from '@/stores/auth';
import { usePlanStore } from '@/stores/plan';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

vi.mock('@/api/cloud', async (original) => ({
  ...(await original<typeof import('@/api/cloud')>()),
  leaveFor: vi.fn(),
}));

const CONFIG: CloudConfig = {
  signup: true,
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
const PRO_BETA: PlanInfo = {
  ...FREE,
  plan: 'pro',
  source: 'beta',
  proFeatures: true,
  limits: { clusters: null, nodes: null, users: 10, retentionDays: 30 },
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(leaveFor).mockReset();
  document.body.innerHTML = '';
});

type Routes = Parameters<typeof mockFetch>[0];

async function mountTab(
  routes: Routes,
  role: 'owner' | 'admin' | 'viewer' = 'owner',
  path = '/settings?tab=billing',
) {
  const fetch = mockFetch(routes);
  const plugins = await createPlugins(path);
  const auth = useAuthStore();
  auth.cloud = CONFIG;
  auth.loaded = true;
  auth.user = { ...USER, role };
  const wrapper = mount(PlanBilling, {
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  await flushPromises();
  return { wrapper, fetch, plugins };
}

describe('Plan & billing while billing is off (the beta)', () => {
  it('Free: the beta notice, the toggle and its estimate, and "Start Pro, free during beta"', async () => {
    const { wrapper } = await mountTab({
      'GET /api/v1/plan': { status: 200, body: FREE },
      'GET /api/v1/plan/billing': { status: 200, body: OFF },
    });
    expect(wrapper.get('[data-testid="beta-notice"]').text()).toContain(
      'Pro is free until billing starts',
    );
    const estimate = () => wrapper.get('[data-testid="estimate"]').text();
    expect(estimate()).toContain('$12 / month');
    expect(estimate()).toContain('$1 per node');
    expect(wrapper.get('[data-testid="interval-monthly"]').attributes('aria-pressed')).toBe('true');
    await wrapper.get('[data-testid="interval-annual"]').trigger('click');
    expect(wrapper.get('[data-testid="interval-annual"]').attributes('aria-pressed')).toBe('true');
    expect(estimate()).toContain('$120 / year');
    expect(estimate()).toContain('saves $24 a year');
    await wrapper.get('#estimate-nodes').setValue('4');
    expect(estimate()).toContain('$100 / year');
    expect(estimate()).toContain('10 nodes minimum');
    await wrapper.get('[data-testid="interval-monthly"]').trigger('click');
    expect(estimate()).toContain('$10 / month');
    expect(estimate()).toContain('$10 minimum');

    const start = wrapper.get('[data-testid="start-beta"]');
    expect(start.text()).toBe('Start Pro, free during beta');
    expect(start.attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-testid="pro-action"]').text()).toContain('No card needed');
    expect(wrapper.get('[data-testid="pro-card"]').text()).toContain('coming to Pro');
    expect(wrapper.get('[data-testid="invoices-later"]').text()).toBe(
      'Available when billing starts',
    );
    expect(wrapper.find('[data-testid="upgrade"]').exists()).toBe(false);
  });

  it('starting the beta: one call, then Pro (free during beta) on the page and the strip', async () => {
    const { wrapper, fetch, plugins } = await mountTab({
      'GET /api/v1/plan': [
        { status: 200, body: FREE },
        { status: 200, body: PRO_BETA },
      ],
      'GET /api/v1/plan/billing': { status: 200, body: OFF },
      'POST /api/v1/plan/beta': {
        status: 200,
        body: { ...OFF, beta: { startedAt: '2026-11-14T10:00:00Z', betaUntil: null } },
      },
    });
    await wrapper.get('[data-testid="start-beta"]').trigger('click');
    await flushPromises();
    expect(fetch.calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/v1/plan/beta', body: undefined },
    ]);
    expect(wrapper.find('[data-testid="start-beta"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="on-beta"]').text()).toBe(
      "You're on Pro, free during the beta.",
    );
    expect(wrapper.text()).toContain('Your plan: Pro');
    const strip = mount(PlanStrip, {
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    expect(strip.get('[data-testid="plan-strip"]').text()).toContain('Pro plan');
    expect(strip.get('[data-testid="plan-beta"]').text()).toBe('free during beta');
    expect(usePlanStore().info?.source).toBe('beta');
  });

  it('a beta with an end date says so', async () => {
    const { wrapper } = await mountTab({
      'GET /api/v1/plan': {
        status: 200,
        body: { ...PRO_BETA, betaUntil: '2027-03-01T00:00:00.000Z' },
      },
      'GET /api/v1/plan/billing': { status: 200, body: OFF },
    });
    expect(wrapper.get('[data-testid="on-beta"]').text()).toContain('until March 1, 2027');
  });

  it('Admins and Viewers see the button locked, with why', async () => {
    const { wrapper, fetch } = await mountTab(
      {
        'GET /api/v1/plan': { status: 200, body: FREE },
        'GET /api/v1/plan/billing': { status: 200, body: OFF },
      },
      'admin',
    );
    expect(wrapper.get('[data-testid="start-beta"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="owner-only"]').text()).toBe(
      'Only an Owner can change the plan.',
    );
    await wrapper.get('[data-testid="start-beta"]').trigger('click');
    expect(fetch.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('a refusal shows its own words', async () => {
    const { wrapper } = await mountTab({
      'GET /api/v1/plan': { status: 200, body: FREE },
      'GET /api/v1/plan/billing': { status: 200, body: OFF },
      'POST /api/v1/plan/beta': {
        status: 503,
        body: {
          type: 'urn:watchlog:problem:billing-unavailable',
          title: 'x',
          status: 503,
          code: 'billing-unavailable',
        },
      },
    });
    await wrapper.get('[data-testid="start-beta"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="billing-error"]').text()).toContain(
      "Billing can't be reached right now",
    );
  });

  it('no billing service: no button, and why', async () => {
    const { wrapper } = await mountTab({
      'GET /api/v1/plan': { status: 200, body: FREE },
      'GET /api/v1/plan/billing': { status: 200, body: { ...OFF, available: false } },
    });
    expect(wrapper.find('[data-testid="start-beta"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="billing-unavailable"]').text()).toContain("can't be reached");
  });
});

describe('Plan & billing once billing is live', () => {
  it('Upgrade opens Checkout with the interval and the committed count', async () => {
    const { wrapper, fetch } = await mountTab({
      'GET /api/v1/plan': { status: 200, body: FREE },
      'GET /api/v1/plan/billing': { status: 200, body: LIVE },
      'POST /api/v1/plan/checkout': [
        { status: 200, body: { url: 'https://checkout.stripe.com/c/pay/cs_test_1' } },
        { status: 200, body: { url: 'https://checkout.stripe.com/c/pay/cs_test_2' } },
      ],
    });
    expect(wrapper.find('[data-testid="beta-notice"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="start-beta"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="invoices-later"]').text()).toBe(
      'Available after you upgrade',
    );
    const upgrade = wrapper.get('[data-testid="upgrade"]');
    expect(upgrade.text()).toBe('Upgrade to Pro');
    expect(wrapper.get('[data-testid="pro-action"]').text()).toContain('Opens Stripe Checkout');
    await upgrade.trigger('click');
    await flushPromises();
    expect(leaveFor).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1');

    await wrapper.get('[data-testid="interval-annual"]').trigger('click');
    expect(wrapper.get('[data-testid="pro-action"]').text()).toContain(
      'Annual commits to 12 nodes',
    );
    await wrapper.get('[data-testid="upgrade"]').trigger('click');
    await flushPromises();
    expect(fetch.calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { interval: 'monthly' },
      { interval: 'annual', nodes: 12 },
    ]);
  });

  it('subscribed: the plan and Manage billing (the portal); a failed payment warns', async () => {
    const { wrapper } = await mountTab({
      'GET /api/v1/plan': { status: 200, body: { ...PRO_BETA, source: 'billing' } },
      'GET /api/v1/plan/billing': {
        status: 200,
        body: {
          ...LIVE,
          customer: true,
          subscription: {
            interval: 'annual',
            status: 'past_due',
            committedNodes: 20,
            currentPeriodEnd: '2027-11-01T00:00:00Z',
            cancelAtPeriodEnd: false,
          },
          dunning: {
            since: '2026-11-10T00:00:00Z',
            downgradeAt: '2026-11-24T00:00:00Z',
            downgraded: false,
          },
        },
      },
      'POST /api/v1/plan/portal': {
        status: 200,
        body: { url: 'https://billing.stripe.com/p/session/test_1' },
      },
    });
    expect(wrapper.get('[data-testid="subscribed"]').text()).toBe("You're on Pro, billed yearly.");
    expect(wrapper.text()).toContain('Committed: 20 nodes a year');
    expect(wrapper.get('[data-testid="payment-failed"]').text()).toContain(
      'before November 24, 2026',
    );
    expect(wrapper.find('[data-testid="upgrade"]').exists()).toBe(false);
    await wrapper.get('[data-testid="manage-billing"]').trigger('click');
    await flushPromises();
    expect(leaveFor).toHaveBeenCalledWith('https://billing.stripe.com/p/session/test_1');
  });

  it('back from Checkout: a word about it', async () => {
    const { wrapper } = await mountTab(
      {
        'GET /api/v1/plan': { status: 200, body: FREE },
        'GET /api/v1/plan/billing': { status: 200, body: LIVE },
      },
      'owner',
      '/settings?tab=billing&checkout=cancelled',
    );
    expect(wrapper.get('[data-testid="checkout-return"]').text()).toContain('nothing was charged');
  });
});
