// SPDX-License-Identifier: AGPL-3.0-only
// The Containers page's filters (Docker parity of the Workloads page): search in the
// URL, state chips with counts, Failing, WatchLog's own containers hidden by default.
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import ContainersPage from '@/views/ContainersPage.vue';
import { container, CONTAINERS, FLEET } from './docker-fixtures';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const base = `/api/v1/clusters/${FLEET.id}`;
const ALL = [
  ...CONTAINERS,
  container('fx-exited', { state: 'exited', image: 'busybox:1.37', host: 'edge-2' }),
  container('watchlog-agent', { image: 'ghcr.io/watchlog-light/agent:dev', watchlog: true }),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  mockFetch({
    'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
    [`GET ${base}/docker/containers?range=3600`]: {
      status: 200,
      body: { containers: ALL, range: 3600, step: 60 },
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mountPage(path = '/containers') {
  const plugins = await createPlugins(path);
  useAuthStore().user = USER;
  const wrapper = mount(ContainersPage, {
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  await flushPromises();
  return { wrapper, router: plugins.router };
}

const rows = (w: ReturnType<typeof mount>) =>
  w.findAll('[data-testid="container-row"] td:first-child button').map((a) => a.text());
const summary = (w: ReturnType<typeof mount>) =>
  w.get('[data-testid="summary"]').text().replace(/\s+/g, ' ');

describe('Containers page filters', () => {
  it('restores the filter from the URL and groups by Compose project', async () => {
    const { wrapper } = await mountPage('/containers?q=DEMO&status=running');
    expect((wrapper.get('[data-testid="search"]').element as HTMLInputElement).value).toBe('DEMO');
    expect(wrapper.get('[data-testid="state-running"]').attributes('aria-pressed')).toBe('true');
    expect(rows(wrapper)).toEqual(['demo-cache-1', 'demo-web-1']);
    expect(
      wrapper.findAll('[data-testid="ns-row"]').map((g) => g.text().split('·')[0]!.trim()),
    ).toEqual(['demo']);
    expect(wrapper.findAll('mark').map((m) => m.text())).toContain('demo');
    wrapper.unmount();
  });

  it("hides WatchLog's own containers until asked, and debounces typing into ?q=", async () => {
    const { wrapper, router } = await mountPage();
    expect(summary(wrapper)).toMatch(/^5 containers · 1 of WatchLog's hidden · 2 need attention/);
    expect(rows(wrapper)).not.toContain('watchlog-agent');
    await wrapper.get('[data-testid="hide-own"] input').setValue(false);
    await flushPromises();
    expect(router.currentRoute.value.query.own).toBe('show');
    expect(rows(wrapper)).toContain('watchlog-agent');

    await wrapper.get('[data-testid="search"]').setValue('FX');
    await vi.advanceTimersByTimeAsync(100);
    expect(router.currentRoute.value.query.q).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60);
    await flushPromises();
    expect(rows(wrapper).sort()).toEqual(['fx-crashloop', 'fx-exited', 'fx-unhealthy']);
    expect(router.currentRoute.value.query.q).toBe('FX');
    wrapper.unmount();
  });

  it('combines state chips (with counts) and Failing', async () => {
    const { wrapper, router } = await mountPage();
    expect(wrapper.get('[data-testid="state-unhealthy"]').text()).toBe('Unhealthy 1');
    expect(wrapper.get('[data-testid="failing-chip"]').text()).toBe('✕ Failing 2');
    await wrapper.get('[data-testid="state-unhealthy"]').trigger('click');
    await wrapper.get('[data-testid="state-restarting"]').trigger('click');
    await flushPromises();
    expect(rows(wrapper)).toEqual(['fx-crashloop', 'fx-unhealthy']);
    expect(router.currentRoute.value.query).toEqual({ status: 'unhealthy,restarting' });
    await wrapper.get('[data-testid="failing-chip"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.problems).toBe('1');
    wrapper.unmount();
  });

  it('names the query when nothing matches and clears all filters', async () => {
    const { wrapper, router } = await mountPage('/containers?q=postgres&status=stopped');
    expect(wrapper.get('[data-testid="no-matches"]').text()).toContain(
      'Nothing matches “postgres”',
    );
    await wrapper.get('[data-testid="clear-filters"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
    expect(rows(wrapper)).toHaveLength(5);
    wrapper.unmount();
  });

  it('focuses the search box on "/" and clears it on Esc', async () => {
    const { wrapper, router } = await mountPage('/containers?q=demo');
    const input = wrapper.get('[data-testid="search"]').element as HTMLInputElement;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', cancelable: true }));
    expect(document.activeElement).toBe(input);
    await wrapper.get('[data-testid="search"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(router.currentRoute.value.query.q).toBeUndefined();
    expect(rows(wrapper)).toHaveLength(5);
    wrapper.unmount();
  });
});
