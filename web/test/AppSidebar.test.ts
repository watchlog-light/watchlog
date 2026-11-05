// SPDX-License-Identifier: AGPL-3.0-only
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppSidebar from '@/components/layout/AppSidebar.vue';
import { navFor } from '@/router';
import { useAuthStore } from '@/stores/auth';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

describe('AppSidebar', () => {
  beforeEach(() => localStorage.clear());
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

  it('shows the signed-in user and signs out', async () => {
    const { calls } = mockFetch({ 'POST /api/v1/auth/logout': { status: 204 } });
    const { router, i18n, pinia } = await createPlugins('/');
    useAuthStore().user = USER;
    const wrapper = mount(AppSidebar, { global: { plugins: [router, i18n, pinia] } });
    expect(wrapper.text()).toContain(USER.name);
    expect(wrapper.text()).toContain(USER.email);

    await wrapper.get('[data-testid="sign-out"]').trigger('click');
    await flushPromises();
    // The cluster switcher also loads the fleet name (GET /clusters).
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /api/v1/auth/logout');
    expect(useAuthStore().user).toBeNull();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('login'));
  });

  it('hides the account section when nobody is signed in', async () => {
    const { router, i18n, pinia } = await createPlugins('/');
    const wrapper = mount(AppSidebar, { global: { plugins: [router, i18n, pinia] } });
    expect(wrapper.find('[data-testid="sign-out"]').exists()).toBe(false);
  });

  it('keeps Settings highlighted on nested settings pages', async () => {
    const { router, i18n, pinia } = await createPlugins(
      '/settings/clusters/01a18f0e-a6c2-71ef-a7b4-42d765746d50',
    );
    const wrapper = mount(AppSidebar, { global: { plugins: [router, i18n, pinia] } });
    expect(wrapper.get('nav a[aria-current="page"]').text()).toBe('Settings');
  });
});
