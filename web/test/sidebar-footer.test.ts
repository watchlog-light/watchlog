// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's footer (0.10.1, design/cloud Sidebar): the plan line (Free with its bar and
// upgrade, Free near the limit in the warning colour, Pro with its label, Community without a
// row, the collapsed rail's label) and the account menu (its items per edition, the header,
// the keyboard: arrows, Esc, focus back on the button, closed on navigation).
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudConfig, PlanInfo } from '@/api/cloud';
import AppSidebar from '@/components/layout/AppSidebar.vue';
import { planLine } from '@/lib/plan-line';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';
import { usePlanStore } from '@/stores/plan';
import { useUiStore } from '@/stores/ui';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const CONFIG = {
  signup: true,
  signupMode: 'public',
  providers: { github: false, google: false },
  turnstileSiteKey: null,
  passwordMinLength: 10,
  verifyGraceDays: 7,
  supportEmail: 'support@example.com',
  sampleUrl: null,
} as unknown as CloudConfig;

const FREE: PlanInfo = {
  plan: 'free',
  source: 'signup',
  betaUntil: null,
  proFeatures: false,
  limits: { clusters: 1, nodes: 5, users: 1, retentionDays: 3 },
  usage: { clusters: 1, nodes: 2, kubernetesNodes: 0, dockerHosts: 2, users: 1 },
  period: { from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z', p95: 2, peak: 2 },
  refusedNodes: 0,
  downgrade: null,
};
const PRO: PlanInfo = {
  ...FREE,
  plan: 'pro',
  source: 'stripe',
  proFeatures: true,
  limits: { clusters: null, nodes: null, users: 10, retentionDays: 30 },
  usage: { clusters: 2, nodes: 9, kubernetesNodes: 0, dockerHosts: 9, users: 3 },
};
const CLOUD_USER = {
  ...USER,
  email: 'a.very.long.address.that.must.wrap@some-long-company-domain.example.com',
  org: { ...USER.org, name: 'acme', slug: 'acme', plan: 'pro' as const },
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

type Setup = {
  plan?: PlanInfo | null;
  cloud?: boolean;
  kinds?: ('kubernetes' | 'server')[];
  collapsed?: boolean;
  drawer?: boolean;
  path?: string;
};
async function mountSidebar(s: Setup = {}) {
  const clusters = (s.kinds ?? ['server']).map((kind, i) => ({ id: `c${i}`, name: `c${i}`, kind }));
  const { calls } = mockFetch({
    'GET /api/v1/clusters': { status: 200, body: { clusters } },
    'POST /api/v1/auth/logout': { status: 204 },
  });
  const { router, i18n, pinia } = await createPlugins(s.path ?? '/');
  const auth = useAuthStore();
  const cloud = s.cloud ?? true;
  auth.cloud = cloud ? CONFIG : null;
  auth.user = cloud ? CLOUD_USER : USER;
  usePlanStore().info = s.plan ?? null;
  useClustersStore().list = clusters as never;
  if (s.collapsed) useUiStore().sidebarCollapsed = true;
  const wrapper = mount(AppSidebar, {
    props: { drawer: s.drawer },
    attachTo: document.body,
    global: { plugins: [router, i18n, pinia] },
  });
  await flushPromises();
  return { wrapper, router, calls };
}

async function openMenu(wrapper: Awaited<ReturnType<typeof mountSidebar>>['wrapper']) {
  const button = wrapper.get('[data-testid="account-menu-button"]');
  await button.trigger('click', { button: 0, ctrlKey: false });
  await flushPromises();
  return document.querySelector<HTMLElement>('[data-testid="account-menu"]');
}

describe('planLine', () => {
  it('Free: used of the limit, the bar warns from 4 of 5', () => {
    expect(planLine(FREE, ['server'])).toMatchObject({
      kind: 'limited',
      used: 2,
      max: 5,
      warn: false,
    });
    const near = { ...FREE, usage: { ...FREE.usage, nodes: 4 } };
    expect(planLine(near, ['server'])).toMatchObject({ share: 0.8, warn: true });
    const over = { ...FREE, usage: { ...FREE.usage, nodes: 7 } };
    expect(planLine(over, ['server'])).toMatchObject({ share: 1, warn: true });
  });
  it('Pro: servers, or nodes when every cluster is Kubernetes', () => {
    expect(planLine(PRO, ['server', 'kubernetes'])).toMatchObject({
      kind: 'unlimited',
      count: 9,
      unit: 'servers',
      days: 30,
    });
    expect(planLine(PRO, ['kubernetes', 'kubernetes'])).toMatchObject({ unit: 'nodes' });
    expect(planLine(PRO, [])).toMatchObject({ unit: 'servers' });
  });
  it('no plan read (or Community): no line', () => {
    expect(planLine(null, ['server'])).toBeNull();
  });
});

describe('the sidebar footer', () => {
  it('Cloud Free: "Free · 2 of 5 nodes", a primary bar, the whole row links to the upgrade', async () => {
    const { wrapper } = await mountSidebar({ plan: FREE });
    const line = wrapper.get('[data-testid="plan-line"]');
    expect(line.element.tagName).toBe('A');
    expect(line.attributes('href')).toBe('/settings?tab=billing');
    expect(line.text()).toContain('Free');
    expect(line.text()).toContain('2 of 5 nodes');
    expect(line.text()).toContain('Upgrade →');
    const bar = wrapper.get('[data-testid="plan-line-bar"]');
    expect(bar.classes()).toContain('bg-primary');
    expect(bar.attributes('style')).toContain('width: 40%');
    // The old card, the separate Sign out row and the bottom collapse row are gone.
    expect(wrapper.find('[data-testid="plan-strip"]').exists()).toBe(false);
    expect(
      wrapper.find('[data-testid="sidebar-footer"] [data-testid="sidebar-toggle"]').exists(),
    ).toBe(false);
    expect(wrapper.find('[data-testid="sign-out"]').exists()).toBe(false);
  });

  it('Cloud Free near the limit: the bar is in the warning colour at 4 of 5', async () => {
    const { wrapper } = await mountSidebar({
      plan: { ...FREE, usage: { ...FREE.usage, nodes: 4 } },
    });
    expect(wrapper.get('[data-testid="plan-line"]').text()).toContain('4 of 5 nodes');
    expect(wrapper.get('[data-testid="plan-line-bar"]').classes()).toContain('bg-warning');
  });

  it('Cloud Pro: a Pro label and "9 servers · 30 days of data", no bar, no upsell', async () => {
    const { wrapper } = await mountSidebar({ plan: PRO, kinds: ['server', 'kubernetes'] });
    const line = wrapper.get('[data-testid="plan-line"]');
    expect(line.element.tagName).toBe('P');
    expect(line.text()).toBe('Pro9 servers · 30 days of data');
    expect(wrapper.find('[data-testid="plan-line-bar"]').exists()).toBe(false);
    expect(line.text()).not.toContain('Upgrade');
  });

  it('Cloud Pro with only Kubernetes clusters says nodes', async () => {
    const { wrapper } = await mountSidebar({ plan: PRO, kinds: ['kubernetes'] });
    expect(wrapper.get('[data-testid="plan-line"]').text()).toContain('9 nodes · 30 days of data');
  });

  it('Community: no plan row; the account button is there', async () => {
    const { wrapper } = await mountSidebar({ cloud: false, plan: FREE });
    expect(wrapper.find('[data-testid="plan-line"]').exists()).toBe(false);
    const button = wrapper.get('[data-testid="account-menu-button"]');
    expect(button.text()).toContain(USER.name);
    expect(button.text()).toContain('Account, tokens, sign out');
    expect(button.attributes('aria-haspopup')).toBe('menu');
    expect(button.attributes('aria-expanded')).toBe('false');
  });

  it("collapsed: the expand button in the header, Pro's label alone, the avatar opens the menu to the right", async () => {
    const { wrapper } = await mountSidebar({ plan: PRO, collapsed: true });
    const toggle = wrapper.get('[data-testid="sidebar-toggle"]');
    expect(toggle.attributes('aria-label')).toBe('Expand sidebar');
    expect(wrapper.get('[data-testid="sidebar"]').classes()).toContain('w-16');
    const label = wrapper.get('[data-testid="plan-line"]');
    expect(label.text()).toBe('Pro');
    expect(label.attributes('title')).toBe('9 servers · 30 days of data');
    const avatar = wrapper.get('[data-testid="account-menu-button"]');
    expect(avatar.attributes('aria-label')).toBe(`Account menu for ${CLOUD_USER.name}`);
    const menu = await openMenu(wrapper);
    expect(menu).not.toBeNull();
    expect(menu!.getAttribute('data-side')).toBe('right');

    await toggle.trigger('click');
    expect(wrapper.get('[data-testid="sidebar-toggle"]').attributes('aria-label')).toBe(
      'Collapse sidebar',
    );
    expect(localStorage.getItem('watchlog.sidebarCollapsed')).toBe('false');
  });

  it('collapsed Free: no plan label at all', async () => {
    const { wrapper } = await mountSidebar({ plan: FREE, collapsed: true });
    expect(wrapper.find('[data-testid="plan-line"]').exists()).toBe(false);
  });

  it('the drawer gets the same footer, without a collapse button', async () => {
    const { wrapper } = await mountSidebar({ plan: FREE, drawer: true, collapsed: true });
    expect(wrapper.find('[data-testid="sidebar-toggle"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="plan-line"]').text()).toContain('2 of 5 nodes');
    expect(wrapper.get('[data-testid="account-menu-button"]').text()).toContain(CLOUD_USER.name);
  });
});

describe('the account menu', () => {
  it('Cloud: the header (whole email, org · role · plan) and every item with its page', async () => {
    const { wrapper } = await mountSidebar({ plan: PRO });
    const menu = await openMenu(wrapper);
    expect(menu!.getAttribute('role')).toBe('menu');
    expect(menu!.getAttribute('data-side')).toBe('top');
    expect(wrapper.get('[data-testid="account-menu-button"]').attributes('aria-expanded')).toBe(
      'true',
    );
    const q = (id: string) => menu!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    expect(q('account-menu-email')!.textContent).toBe(CLOUD_USER.email);
    expect(q('account-menu-email')!.className).toContain('break-all');
    expect(q('account-menu-context')!.textContent).toBe('acme · Owner · Pro');
    const items = [...menu!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent?.trim())).toEqual([
      'Account and security',
      'API tokens',
      'Plan and billing',
      'Documentation(opens in a new tab)',
      'Sign out',
    ]);
    expect(q('account-security')!.getAttribute('href')).toBe('/settings?tab=security');
    expect(q('account-tokens')!.getAttribute('href')).toBe('/settings?tab=tokens');
    expect(q('account-billing')!.getAttribute('href')).toBe('/settings?tab=billing');
    expect(q('account-docs')!.getAttribute('href')).toBe('https://watchlog.io/docs/');
    expect(q('sign-out')!.className).toContain('text-critical-text');
  });

  it('Community: no account page and no billing, so only tokens, docs and sign out', async () => {
    const { wrapper } = await mountSidebar({ cloud: false });
    const menu = await openMenu(wrapper);
    const items = [...menu!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent?.trim())).toEqual([
      'API tokens',
      'Documentation(opens in a new tab)',
      'Sign out',
    ]);
    expect(menu!.querySelector('[data-testid="account-menu-context"]')!.textContent).toBe('Owner');
  });

  it('the keyboard: Enter opens on the first item, arrows move, Esc closes and focus returns', async () => {
    const { wrapper } = await mountSidebar({ plan: FREE });
    const button = wrapper.get('[data-testid="account-menu-button"]');
    (button.element as HTMLElement).focus();
    await button.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    const menu = document.querySelector<HTMLElement>('[data-testid="account-menu"]')!;
    expect(menu).not.toBeNull();
    await vi.waitFor(() =>
      expect(document.activeElement?.textContent?.trim()).toBe('Account and security'),
    );
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await flushPromises();
    expect(document.activeElement?.textContent?.trim()).toBe('API tokens');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await flushPromises();
    expect(document.activeElement?.textContent?.trim()).toBe('Account and security');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await flushPromises();
    expect(document.activeElement?.textContent?.trim()).toBe('Sign out');

    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await flushPromises();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="account-menu"]')).toBeNull(),
    );
    expect(button.attributes('aria-expanded')).toBe('false');
    await vi.waitFor(() => expect(document.activeElement).toBe(button.element));
  });

  it('closes on navigation', async () => {
    const { wrapper, router } = await mountSidebar({ plan: FREE });
    expect(await openMenu(wrapper)).not.toBeNull();
    await router.push('/alerts');
    await flushPromises();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="account-menu"]')).toBeNull(),
    );
  });

  it('a menu item navigates and closes the menu', async () => {
    const { wrapper, router } = await mountSidebar({ plan: FREE });
    const menu = await openMenu(wrapper);
    menu!.querySelector<HTMLElement>('[data-testid="account-tokens"]')!.click();
    await flushPromises();
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/settings?tab=tokens'));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="account-menu"]')).toBeNull(),
    );
  });

  it('Sign out signs out and goes to the sign-in page', async () => {
    const { wrapper, router, calls } = await mountSidebar({ plan: FREE });
    const menu = await openMenu(wrapper);
    menu!.querySelector<HTMLElement>('[data-testid="sign-out"]')!.click();
    await flushPromises();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /api/v1/auth/logout');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('login'));
    expect(useAuthStore().user).toBeNull();
  });
});
