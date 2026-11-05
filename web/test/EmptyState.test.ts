// SPDX-License-Identifier: AGPL-3.0-only
import { mount } from '@vue/test-utils';
import { Bell } from '@lucide/vue';
import { describe, expect, it } from 'vitest';
import EmptyState from '@/components/ui/EmptyState.vue';
import { createPlugins } from './helpers';

describe('EmptyState', () => {
  it('renders title, description and a next-step action', async () => {
    const { router, i18n, pinia } = await createPlugins();
    const wrapper = mount(EmptyState, {
      props: {
        icon: Bell,
        title: 'No alerts yet',
        description: 'Connect a cluster.',
        actionLabel: 'Connect a cluster',
        actionTo: '/settings',
      },
      global: { plugins: [router, i18n, pinia] },
    });

    expect(wrapper.find('h2').text()).toBe('No alerts yet');
    expect(wrapper.text()).toContain('Connect a cluster.');
    expect(wrapper.find('a').attributes('href')).toBe('/settings');
  });

  it('omits the action when none is given', async () => {
    const { router, i18n, pinia } = await createPlugins();
    const wrapper = mount(EmptyState, {
      props: { icon: Bell, title: 't', description: 'd' },
      global: { plugins: [router, i18n, pinia] },
    });
    expect(wrapper.find('a').exists()).toBe(false);
  });
});
