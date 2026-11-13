// SPDX-License-Identifier: AGPL-3.0-only
// Cloud plans in the pages (ADR-177, slice 4): the plan strip with real counts, the
// over-limit and downgrade banners, Settings › Plan & billing (Cloud only), and the
// plan-limit messages of Add cluster, the wizard and invites.
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planLimitKey, type CloudConfig, type PlanInfo } from '@/api/cloud';
import { ApiError } from '@/api/client';
import PlanBanner from '@/components/plan/PlanBanner.vue';
import PlanStrip from '@/components/plan/PlanStrip.vue';
import { useAuthStore } from '@/stores/auth';
import { usePlanStore } from '@/stores/plan';
import SettingsPage from '@/views/SettingsPage.vue';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

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
  it('Free: "3 of 5 nodes", 3 days of data, 1 user, and Try Pro to Plan & billing', async () => {
    const { wrapper } = await withPlan(FREE, PlanStrip);
    const strip = wrapper.get('[data-testid="plan-strip"]');
    expect(strip.text()).toContain('Free plan');
    expect(wrapper.get('[data-testid="plan-nodes"]').text()).toBe('3 of 5 nodes');
    expect(strip.text()).toContain('3 days of data · 1 user');
    const link = wrapper.get('[data-testid="plan-try-pro"]');
    expect(link.text()).toBe('Try Pro, free during beta →');
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
    // Without an answer from the billing service, no action (cloud-billing.test.ts has them).
    expect(wrapper.find('[data-testid="start-beta"]').exists()).toBe(false);
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
  it("name the limit and the way out, never the server's text", () => {
    expect(planLimitKey(err('clusters'))).toBe('cloud.plan.limitError.clusters');
    expect(planLimitKey(err('users'))).toBe('cloud.plan.limitError.users');
    expect(planLimitKey(err())).toBe('cloud.errors.plan-limit');
    expect(planLimitKey(new ApiError(409, { type: 'about:blank', title: 'x', status: 409 }))).toBe(
      null,
    );
  });
});
