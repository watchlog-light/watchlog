// SPDX-License-Identifier: AGPL-3.0-only
// One selected cluster for every page: it never changes unless the user picks another in
// the switcher (or opens a link with ?cluster=). Navigation follows its kind; pages of
// the other kind go to its Overview; old Docker links still work.
import type { Cluster } from '@watchlog/api-types';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import AppSidebar from '@/components/layout/AppSidebar.vue';
import { installClusterGuard, navFor, routes } from '@/router';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';
import { useFleetStore } from '@/stores/fleet';
import { useKubeStore } from '@/stores/kube';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const cluster = (id: string, name: string, kind: Cluster['kind']): Cluster => ({
  id,
  name,
  kind,
  status: 'active',
  nodeCount: 1,
  agentVersion: 'dev',
  firstSeenAt: null,
  lastSeenAt: null,
  createdAt: '2026-11-01T00:00:00Z',
  ingestFailure: null,
});
const KIND = cluster('01a191fb-b18c-75a0-be51-47fcaa9eadde', 'kind-demo', 'kubernetes');
const FLEET = cluster('01a18f2a-22a8-7457-94af-5a66bca41e97', 'my-cluster', 'docker');

async function setup(path = '/') {
  mockFetch({ 'GET /api/v1/clusters': { status: 200, body: { clusters: [KIND, FLEET] } } });
  const plugins = await createPlugins();
  useAuthStore().user = USER;
  const router = createRouter({ history: createMemoryHistory(), routes });
  const store = useClustersStore();
  installClusterGuard(router, () => store);
  await router.push(path);
  return { ...plugins, router, store };
}

describe('the selected cluster', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('stays the Docker fleet on every page of its navigation', async () => {
    const { router, store } = await setup(`/?cluster=${FLEET.id}`);
    expect(store.selected?.name).toBe('my-cluster');
    for (const item of navFor('docker')) {
      await router.push(item.path);
      expect(router.currentRoute.value.name, item.path).toBe(item.name);
      expect(store.selected?.name, item.path).toBe('my-cluster');
      expect(router.currentRoute.value.query.cluster, item.path).toBe(FLEET.id);
    }
    // The other kind's stores are empty rather than falling back to another cluster.
    expect(useKubeStore().cluster).toBeNull();
    expect(useFleetStore().fleet?.id).toBe(FLEET.id);
  });

  it('sends pages of the other kind to Overview, keeping the selection', async () => {
    const { router, store } = await setup(`/?cluster=${FLEET.id}`);
    for (const path of ['/nodes', '/workloads', '/nodes/w1', '/pods/default/web']) {
      await router.push(path);
      expect(router.currentRoute.value.name, path).toBe('overview');
      expect(store.selected?.id).toBe(FLEET.id);
    }
    store.select(KIND.id);
    for (const path of ['/hosts', '/containers', '/hosts/h1', '/containers/h1/web']) {
      await router.push(path);
      expect(router.currentRoute.value.name, path).toBe('overview');
      expect(store.selected?.id).toBe(KIND.id);
    }
  });

  it('is remembered per user and kept from a link', async () => {
    let s = await setup(`/?cluster=${FLEET.id}`);
    expect(localStorage.getItem(`watchlog.cluster.${USER.id}`)).toBe(FLEET.id);
    s.store.reset();
    s = await setup('/events');
    expect(s.store.selected?.id).toBe(FLEET.id);
    expect(s.router.currentRoute.value.query.cluster).toBe(FLEET.id);
    // Without a remembered choice: the first Kubernetes cluster.
    localStorage.clear();
    s.store.reset();
    s = await setup('/alerts');
    expect(s.store.selected?.id).toBe(KIND.id);
  });

  it('keeps old Docker links working', async () => {
    const { router } = await setup(`/?cluster=${FLEET.id}`);
    await router.push('/docker?host=h1');
    expect(router.currentRoute.value).toMatchObject({ name: 'containers', query: { host: 'h1' } });
    await router.push('/docker/hosts/h1');
    expect(router.currentRoute.value).toMatchObject({
      name: 'docker-host',
      params: { host: 'h1' },
    });
    await router.push('/docker/hosts/h1/containers/web');
    expect(router.currentRoute.value).toMatchObject({
      name: 'docker-container',
      params: { host: 'h1', name: 'web' },
    });
  });

  it('shows the navigation of the selected kind', async () => {
    const { router, store, i18n, pinia } = await setup(`/?cluster=${FLEET.id}`);
    const w = mount(AppSidebar, { global: { plugins: [router, i18n, pinia] } });
    await flushPromises();
    const labels = () => w.findAll('nav a').map((a) => a.text());
    expect(labels()).toEqual([
      'Overview',
      'Hosts',
      'Containers',
      'Events',
      'Service Map',
      'Alerts',
      'Settings',
    ]);
    store.select(KIND.id);
    await flushPromises();
    expect(labels()).toEqual([
      'Overview',
      'Nodes',
      'Workloads',
      'Events',
      'Service Map',
      'Alerts',
      'Settings',
    ]);
    w.unmount();
  });
});
