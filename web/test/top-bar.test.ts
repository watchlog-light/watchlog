// SPDX-License-Identifier: AGPL-3.0-only
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppTopBar from '@/components/layout/AppTopBar.vue';
import { useAuthStore } from '@/stores/auth';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('top bar (alerts redesign item 10)', () => {
  it.each([
    ['/nodes/worker-1', true],
    ['/pods/wl-test/web-1', true],
    ['/docker/hosts/h1', true],
    ['/alerts?view=rules', false],
    ['/settings', false],
    ['/', true], // the overview's KPIs and resources chart follow the range (overview redesign)
  ])('%s shows the time range: %s', async (path, shown) => {
    mockFetch({ 'GET /api/v1/clusters': { status: 200, body: { clusters: [] } } });
    const p = await createPlugins(path);
    useAuthStore().user = USER;
    const w = mount(AppTopBar, {
      props: { title: 'T' },
      global: { plugins: [p.router, p.i18n, p.pinia] },
    });
    await flushPromises();
    expect(w.find('[role="group"][aria-label="Time range"]').exists()).toBe(shown);
    w.unmount();
  });
});
