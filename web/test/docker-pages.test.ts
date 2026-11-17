// SPDX-License-Identifier: AGPL-3.0-only
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import DockerContainerPage from '@/views/DockerContainerPage.vue';
import ContainersPage from '@/views/ContainersPage.vue';
import { CONTAINERS, FLEET, HOST } from './docker-fixtures';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

afterEach(() => vi.unstubAllGlobals());

async function mountPage(component: object, path: string) {
  const plugins = await createPlugins(path);
  useAuthStore().user = USER;
  const wrapper = mount(component, {
    global: {
      plugins: [plugins.router, plugins.i18n, plugins.pinia],
      stubs: {
        TimeSeriesChart: {
          props: ['title', 'series', 'unit', 'note'],
          template: '<div class="chart-stub" :data-note="note">{{ title }}</div>',
        },
      },
    },
  });
  await flushPromises();
  return wrapper;
}

const base = `/api/v1/clusters/${FLEET.id}`;

describe('Containers page', () => {
  it('groups containers by Compose project, problem rows with a badge and the diagnosis', async () => {
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
      [`GET ${base}/docker/containers?range=3600`]: {
        status: 200,
        body: { containers: CONTAINERS, range: 3600, step: 60 },
      },
    });
    const w = await mountPage(ContainersPage, '/containers');
    // The standalone group has the problems: first.
    const groups = w.findAll('[data-testid="ns-row"]').map((g) =>
      g
        .text()
        .replace(/\s*([✓✕])/g, ' $1')
        .replace(/\s+/g, ' '),
    );
    expect(groups).toEqual([
      'Standalone · 2 containers ✕ 2 need attention',
      'demo · 2 containers ✓ all healthy',
    ]);
    const rows = w.findAll('[data-testid="container-row"]');
    expect(rows[0]!.text()).toContain('fx-crashloop');
    expect(rows[0]!.get('[data-testid="health-badge"]').text()).toBe('✕ Restarting');
    expect(rows[0]!.get('[data-testid="container-reason"]').text()).toMatch(
      /^Restarting · 32 restarts/,
    );
    expect(rows[1]!.get('[data-testid="health-badge"]').text()).toBe('▲ Unhealthy');
    const cache = rows.find((r) => r.text().includes('demo-cache-1'))!;
    expect(cache.find('[data-testid="health-badge"]').exists()).toBe(false);
    expect(cache.find('[data-testid="health-dot"]').exists()).toBe(true);
    expect(cache.find('[data-testid="resource-bar"]').exists()).toBe(true);
    expect(cache.text()).toContain('redis:7-alpine');
    // A click shows the last exit / probes and a link to the container.
    await rows[1]!.trigger('click');
    expect(w.get('[data-testid="open-container"]').attributes('href')).toBe(
      `/containers/${HOST.name}/fx-unhealthy`,
    );
    w.unmount();
  });

  it('explains what to do when no fleet is selected', async () => {
    mockFetch({ 'GET /api/v1/clusters': { status: 200, body: { clusters: [] } } });
    const w = await mountPage(ContainersPage, '/containers');
    expect(w.text()).toContain('No servers connected');
    w.unmount();
  });

  it('explains that the first host has not reported yet', async () => {
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
      [`GET ${base}/docker/containers?range=3600`]: {
        status: 200,
        body: { containers: [], range: 3600, step: 60 },
      },
    });
    const w = await mountPage(ContainersPage, '/containers');
    expect(w.text()).toContain('Waiting for the first host');
    expect(w.find('a[href*="/settings/clusters/"]').exists()).toBe(true);
    w.unmount();
  });
});

const rangeBody = { metric: 'x', unit: 'ratio', step: 15, series: [] };

describe('Host and container pages', () => {
  it('shows container facts and its four charts', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
      [`GET ${base}/docker/containers?host=${HOST.name}`]: {
        status: 200,
        body: { containers: CONTAINERS },
      },
      'POST /api/v1/query/range': Array.from({ length: 6 }, () => ({
        status: 200,
        body: rangeBody,
      })),
    });
    const w = await mountPage(
      DockerContainerPage,
      `/docker/hosts/${HOST.name}/containers/demo-web-1`,
    );
    const facts = w.get('[data-testid="container-facts"]').text();
    expect(facts).toContain('redis:7-alpine');
    expect(facts).toContain('demo / web');
    expect(facts).toContain('8081→80/tcp');
    expect(w.text()).toContain('Healthy');
    // No memory data (yet): no claim about a missing limit.
    expect(w.findAll('.chart-stub')[1]!.attributes('data-note')).toBeUndefined();
    expect(w.findAll('.chart-stub').map((c) => c.text())).toEqual([
      'CPU (% of one core)',
      'Memory',
      'Network',
      'Disk I/O',
    ]);
    const scopes = calls
      .filter((c) => c.path === '/api/v1/query/range')
      .map((c) => (c.body as { scope: object }).scope);
    expect(
      scopes.every(
        (s) => JSON.stringify(s) === JSON.stringify({ host: HOST.name, container: 'demo-web-1' }),
      ),
    ).toBe(true);
    w.unmount();
  });
});
