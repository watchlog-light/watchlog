// SPDX-License-Identifier: AGPL-3.0-only
// Applications (v0.3 slice 2): the list with problems first, filters, discovered services
// and Monitor, for Kubernetes and Docker; viewers see the list without Monitor.
import { flushPromises, mount } from '@vue/test-utils';
import type { Application, DiscoveredService } from '@watchlog/api-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reasonText, sortApplications, whereText } from '@/lib/applications';
import { useAuthStore } from '@/stores/auth';
import ApplicationsPage from '@/views/ApplicationsPage.vue';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const K8S = {
  id: '01a1c000-0000-7000-8000-000000000001',
  name: 'prod-eu',
  kind: 'kubernetes' as const,
};
const DOCKER = {
  id: '01a1c000-0000-7000-8000-000000000002',
  name: 'docker-01',
  kind: 'docker' as const,
};

function app(over: Partial<Application> & Pick<Application, 'id' | 'type' | 'name'>): Application {
  return {
    version: null,
    cluster: K8S,
    where: { group: 'payments', host: null, address: null },
    target: {
      kind: 'workload',
      namespace: 'payments',
      workload_kind: 'StatefulSet',
      workload: 'postgres',
      port: 5432,
    },
    health: 'ok',
    reason: { code: 'connected', facts: { up: 1, members: 1 } },
    members: { up: 1, total: 1 },
    monitoredSince: '2026-11-09T10:00:00.000Z',
    lastReportAt: '2026-11-09T10:01:00.000Z',
    ...over,
  };
}

const APPS: Application[] = [
  app({
    id: 'a1',
    type: 'redis',
    name: 'shop/redis-cache',
    version: '7.2',
    where: { group: 'shop', host: null, address: null },
  }),
  app({
    id: 'a2',
    type: 'postgres',
    name: 'payments/postgres',
    version: '16.4',
    health: 'critical',
    reason: { code: 'unreachable', facts: { error: 'connection refused', up: 0, members: 1 } },
    members: { up: 0, total: 1 },
  }),
  app({
    id: 'a3',
    type: 'rabbitmq',
    name: 'billing/rabbitmq',
    cluster: DOCKER,
    where: { group: 'billing', host: 'docker-01', address: null },
    health: 'unknown',
    reason: { code: 'collector_missing', facts: { host: 'docker-01' } },
    members: { up: 0, total: 0 },
  }),
];

const DISCOVERED: DiscoveredService[] = [
  {
    key: 'k1',
    cluster: K8S,
    type: 'postgres',
    name: 'staging/postgres',
    image: 'postgres:16.4',
    version: '16.4',
    port: 5432,
    confidence: 'image',
    members: 1,
    host: null,
    group: 'staging',
    target: {
      kind: 'workload',
      namespace: 'staging',
      workload_kind: 'StatefulSet',
      workload: 'postgres',
      port: 5432,
    },
  },
  {
    key: 'k2',
    cluster: DOCKER,
    type: 'redis',
    name: 'analytics/redis',
    image: 'redis:7.2',
    version: '7.2',
    port: 6379,
    confidence: 'image',
    members: 1,
    host: 'docker-01',
    group: 'analytics',
    target: {
      kind: 'compose',
      host: 'docker-01',
      compose_project: 'analytics',
      compose_service: 'redis',
      port: 6379,
    },
  },
];

const PROBE = {
  id: '01a1c000-0000-7000-8000-0000000000p1',
  status: 'ok' as const,
  method: 'none',
  username: null,
  attempts: 1,
  result: { ok: true, error: null, version: '7.2', facts: {}, excess: [] },
  expiresAt: '2026-11-09T10:15:00.000Z',
};

async function mountPage(role = 'owner', query = '') {
  const plugins = await createPlugins(`/applications${query}`);
  useAuthStore().user = { ...USER, role: role as typeof USER.role };
  const wrapper = mount(ApplicationsPage, {
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    attachTo: document.body,
  });
  await flushPromises();
  return { wrapper, router: plugins.router };
}

describe('Applications page', () => {
  it('lists problems first with their reasons, and what was found', async () => {
    mockFetch({
      'GET /api/v1/applications': { status: 200, body: { applications: APPS } },
      'GET /api/v1/applications/discovered': { status: 200, body: { discovered: DISCOVERED } },
    });
    const { wrapper } = await mountPage();
    const rows = wrapper.findAll('[data-testid="application-row"]');
    expect(rows.map((r) => r.find('.font-mono').text())).toEqual([
      'payments/postgres',
      'billing/rabbitmq',
      'shop/redis-cache',
    ]);
    expect(rows[0]!.get('[data-testid="health"]').text()).toBe('Critical');
    expect(rows[0]!.get('[data-testid="reason"]').text()).toBe("Can't connect: connection refused");
    expect(rows[1]!.get('[data-testid="reason"]').text()).toBe(
      'No integrations collector runs on docker-01 yet.',
    );
    expect(rows[1]!.find('img[data-logo="docker"]').exists()).toBe(true);
    expect(rows[2]!.find('img[data-logo="redis"]').exists()).toBe(true);

    const found = wrapper.get('[data-testid="discovered"]');
    expect(found.text()).toContain("Found 2 services that aren't monitored yet");
    const discovered = found.findAll('[data-testid="discovered-row"]');
    expect(discovered[0]!.text()).toContain('PostgreSQL 16.4');
    expect(discovered[0]!.text()).toContain('needs a read-only user');
    expect(discovered[1]!.text()).toContain('Compose project analytics');
    expect(discovered[1]!.text()).toContain('nothing to set up');
  });

  it('filters by type and sorts by name', async () => {
    mockFetch({
      'GET /api/v1/applications': { status: 200, body: { applications: APPS } },
      'GET /api/v1/applications/discovered': { status: 200, body: { discovered: [] } },
    });
    const { wrapper, router } = await mountPage('owner', '?type=databases');
    expect(wrapper.findAll('[data-testid="application-row"]')).toHaveLength(1);
    const chips = wrapper
      .findAll('[data-testid="family-filter"]')
      .map((c) => c.text().replace(/\s+/g, ' '));
    expect(chips).toEqual(['All 3', 'Databases 1', 'Caches 1', 'Queues 1']);
    await router.replace('/applications?sort=name');
    await flushPromises();
    expect(
      wrapper.findAll('[data-testid="application-row"] .font-mono').map((r) => r.text()),
    ).toEqual(['billing/rabbitmq', 'payments/postgres', 'shop/redis-cache']);
  });

  it('monitors a discovered service and reloads', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/applications': [
        { status: 200, body: { applications: [] } },
        {
          status: 200,
          body: {
            applications: [
              app({ id: 'n', type: 'redis', name: 'analytics/redis', cluster: DOCKER }),
            ],
          },
        },
      ],
      'GET /api/v1/applications/discovered': [
        { status: 200, body: { discovered: DISCOVERED } },
        { status: 200, body: { discovered: [DISCOVERED[0]] } },
      ],
      'POST /api/v1/applications': {
        status: 201,
        body: { application: app({ id: 'n', type: 'redis', name: 'analytics/redis' }) },
      },
      'POST /api/v1/applications/probes': {
        status: 201,
        body: { probe: PROBE },
      },
      'GET /api/v1/applications/alert-defaults?type=redis': {
        status: 200,
        body: {
          defaults: [
            {
              key: 'unreachable',
              name: 'Service unreachable',
              metric: 'service.reachable.ratio',
              condition: { op: '<', value: 1 },
              forSeconds: 120,
            },
            {
              key: 'slow_connect',
              name: 'Service slow to connect',
              metric: 'service.connect.time',
              condition: { op: '>', value: 0.5 },
              forSeconds: 300,
            },
          ],
        },
      },
    });
    const { wrapper } = await mountPage();
    await wrapper.findAll('[data-testid="monitor"]')[1]!.trigger('click');
    await flushPromises();
    const drawer = document.body.querySelector('[data-testid="monitor-drawer"]')!;
    expect(drawer.textContent).toContain('on docker-01, Compose project analytics');
    // Both default alerts start ticked; untick the slow-connect one.
    const slow = document.body.querySelector(
      '[data-default="slow_connect"] input',
    ) as HTMLInputElement;
    expect(slow.checked).toBe(true);
    slow.click();
    await flushPromises();
    (document.body.querySelector('[data-testid="start-monitoring"]') as HTMLButtonElement).click();
    await flushPromises();
    // Redis needs nothing: the drawer tested the connection when it opened.
    expect(calls.find((c) => c.path === '/api/v1/applications/probes')!.body).toEqual({
      clusterId: DOCKER.id,
      type: 'redis',
      target: DISCOVERED[1]!.target,
      access: { method: 'none' },
    });
    expect(
      calls.find((c) => c.path === '/api/v1/applications' && c.method === 'POST')!.body,
    ).toEqual({
      clusterId: DOCKER.id,
      type: 'redis',
      target: DISCOVERED[1]!.target,
      probeId: PROBE.id,
      defaultAlerts: ['unreachable'],
    });
    expect(wrapper.findAll('[data-testid="application-row"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="discovered-row"]')).toHaveLength(1);
    wrapper.unmount();
  });

  it('shows viewers what was found without Monitor', async () => {
    mockFetch({
      'GET /api/v1/applications': { status: 200, body: { applications: [] } },
      'GET /api/v1/applications/discovered': { status: 200, body: { discovered: DISCOVERED } },
    });
    const { wrapper } = await mountPage('viewer');
    expect(wrapper.findAll('[data-testid="discovered-row"]')).toHaveLength(2);
    expect(wrapper.find('[data-testid="monitor"]').exists()).toBe(false);
  });

  it('explains an empty page', async () => {
    mockFetch({
      'GET /api/v1/applications': { status: 200, body: { applications: [] } },
      'GET /api/v1/applications/discovered': { status: 200, body: { discovered: [] } },
    });
    const { wrapper } = await mountPage();
    expect(wrapper.text()).toContain('No services found yet');
  });
});

describe('applications lib', () => {
  it("says where a service runs in its cluster's words", () => {
    expect(whereText(APPS[0]!)).toBe('prod-eu · shop');
    expect(whereText(APPS[2]!)).toBe('docker-01 · docker-01 · billing');
    expect(
      whereText(
        app({
          id: 'x',
          type: 'postgres',
          name: 'db',
          where: { group: null, host: null, address: 'db.internal:5432' },
        }),
      ),
    ).toBe('prod-eu · db.internal:5432');
  });

  it('puts problems first, then waiting, then healthy', () => {
    expect(sortApplications(APPS, 'problems').map((a) => a.health)).toEqual([
      'critical',
      'unknown',
      'ok',
    ]);
  });

  it('turns a reason code into a sentence key', () => {
    const fmt = () => '14:02';
    expect(
      reasonText(
        app({
          id: 'x',
          type: 'redis',
          name: 'r',
          reason: { code: 'collector_silent', facts: { since: 'x' } },
        }),
        fmt,
      ),
    ).toEqual({
      key: 'applications.reason.collectorSilent',
      values: { since: '14:02' },
    });
    expect(
      reasonText(
        app({
          id: 'x',
          type: 'redis',
          name: 'r',
          reason: { code: 'connected', facts: { up: 1, members: 2 } },
        }),
        fmt,
      ).key,
    ).toBe('applications.reason.someDown');
  });
});
