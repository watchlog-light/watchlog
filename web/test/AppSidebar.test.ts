// SPDX-License-Identifier: AGPL-3.0-only
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppSidebar from '@/components/layout/AppSidebar.vue';
import { navFor } from '@/router';
import { useAuthStore } from '@/stores/auth';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

describe('AppSidebar', () => {
  beforeEach(() => {
    localStorage.clear();
    // The cluster switcher reads the clusters; nothing else is asked.
    mockFetch({ 'GET /api/v1/clusters': { status: 200, body: { clusters: [] } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows every section and collapses from 240px to 64px', async () => {
    const { router, i18n, pinia } = await createPlugins('/nodes');
    const wrapper = mount(AppSidebar, { global: { plugins: [router, i18n, pinia] } });

    expect(wrapper.findAll('nav a').map((a) => a.text())).toEqual(
      navFor('kubernetes').map((i) => i18n.global.t(i.titleKey)),
    );
    const active = wrapper.get('nav a[aria-current="page"]');
    expect(active.text()).toBe('Nodes');
    // ADR-038: neutral active item with a primary bar, no green background or text.
    expect(active.classes()).toEqual(
      expect.arrayContaining(['bg-surface-2', 'text-text', 'before:bg-primary']),
    );
    expect(active.classes().some((c) => /^(bg|text)-primary/.test(c))).toBe(false);

    const sidebar = wrapper.get('[data-testid="sidebar"]');
    expect(sidebar.classes()).toContain('w-60');

    await wrapper.get('[data-testid="sidebar-toggle"]').trigger('click');
    expect(sidebar.classes()).toContain('w-16');
    expect(localStorage.getItem('watchlog.sidebarCollapsed')).toBe('true');
  });

  it('shows the signed-in user in the account button; nobody signed in, no button', async () => {
    const { router, i18n, pinia } = await createPlugins('/');
    useAuthStore().user = USER;
    const wrapper = mount(AppSidebar, { global: { plugins: [router, i18n, pinia] } });
    expect(wrapper.get('[data-testid="account-menu-button"]').text()).toContain(USER.name);
    useAuthStore().user = null;
    await flushPromises();
    expect(wrapper.find('[data-testid="account-menu-button"]').exists()).toBe(false);
  });

  it('keeps Settings highlighted on nested settings pages', async () => {
    const { router, i18n, pinia } = await createPlugins(
      '/settings/clusters/01a18f0e-a6c2-71ef-a7b4-42d765746d50',
    );
    const wrapper = mount(AppSidebar, { global: { plugins: [router, i18n, pinia] } });
    expect(wrapper.get('nav a[aria-current="page"]').text()).toBe('Settings');
  });

  it('Cloud marks the Pro sections with a chip; Community has none', async () => {
    const { router, i18n, pinia } = await createPlugins('/');
    const wrapper = mount(AppSidebar, { global: { plugins: [router, i18n, pinia] } });
    expect(wrapper.find('[data-testid="nav-pro"]').exists()).toBe(false);

    const auth = useAuthStore();
    auth.cloud = {
      signup: true,
      signupMode: 'public',
      providers: { github: false, google: false },
      turnstileSiteKey: null,
      passwordMinLength: 10,
      verifyGraceDays: 7,
      supportEmail: 'support@example.com',
      sampleUrl: null,
    } as unknown as NonNullable<typeof auth.cloud>;
    await flushPromises();
    const chips = wrapper.findAll('[data-testid="nav-pro"]');
    expect(chips).toHaveLength(navFor('kubernetes').filter((i) => i.pro).length);
    expect(chips.map((c) => c.element.closest('a')?.textContent)).toEqual(['What changedPro']);
    // Info tone, like the page's own chip; never the primary colour.
    expect(chips[0]!.classes()).toEqual(expect.arrayContaining(['text-info', 'border-info/50']));

    // Collapsed: no room for the chip, so the tooltip says it.
    await wrapper.get('[data-testid="sidebar-toggle"]').trigger('click');
    expect(wrapper.find('[data-testid="nav-pro"]').exists()).toBe(false);
    expect(wrapper.get('a[href="/what-changed"]').attributes('title')).toBe('What changed · Pro');
    expect(wrapper.get('a[href="/events"]').attributes('title')).toBe('Events');
  });
});
