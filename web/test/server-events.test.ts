// SPDX-License-Identifier: AGPL-3.0-only
// A Server fleet's own events (0.9.2, ADR-207/208 amended): the Events page with Server and
// Workload facets, the Compose project only within containers, "Hide system" on by default,
// rows linking to their workload page, empty states that say why and the old-agent note;
// the top bar's workload select; the server page and a workload page reading the stored
// events; the Overview linking a service's event to its workload.
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DockerScopeFilter from '@/components/docker/DockerScopeFilter.vue';
import { agentBefore, objectLink, splitWorkload } from '@/lib/events';
import { eventObjectLink } from '@/lib/overview';
import { useAuthStore } from '@/stores/auth';
import { useDockerScopeStore } from '@/stores/dockerScope';
import EventsPage from '@/views/EventsPage.vue';
import ServerPage from '@/views/ServerPage.vue';
import ServerWorkloadPage from '@/views/ServerWorkloadPage.vue';
import { FLEET } from './docker-fixtures';
import { mockFetch, USER, type Routes } from './fetch-mock';
import { createPlugins, listedOptions } from './helpers';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const to = Math.floor(NOW / 1000);
const range = `from=${to - 3600}&to=${to}`;
const base = `/api/v1/clusters/${FLEET.id}`;

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: NOW }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mountPage(component: object, path: string) {
  const plugins = await createPlugins(path);
  useAuthStore().user = USER;
  const wrapper = mount(component, {
    attachTo: document.body,
    global: {
      plugins: [plugins.router, plugins.i18n, plugins.pinia],
      stubs: {
        TimeSeriesChart: { props: ['title'], template: '<div>{{ title }}</div>' },
        WorkloadCharts: { template: '<div />' },
      },
    },
  });
  await flushPromises();
  return { wrapper, router: plugins.router };
}

const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const ev = (kind: string, name: string, reason: string, type: string, message: string) => ({
  type,
  reason,
  message,
  count: reason === 'FailedExit' ? 7 : 1,
  firstSeen: iso(30),
  lastSeen: iso(5),
  namespace: null,
  host: 'web-1',
  involvedKind: kind,
  involvedName: name,
  reportingController: 'watchlog-agent',
  workload: `${kind.toLowerCase()}:${name}`,
});
const EVENTS = [
  ev('Process', 'activity2', 'FailedExit', 'Warning', 'killed by SIGKILL (9)'),
  ev('Service', 'orders.service', 'Failed', 'Warning', 'failed (exit-code, exit code 3)'),
  ev('Container', 'shop-api-1', 'Die', 'Warning', 'exited with code 137'),
];
const SUMMARY = {
  from: to - 3600,
  to,
  bucket: 300,
  histogram: [{ ts: to - 300, warning: 9, normal: 0 }],
  markers: [],
  total: 9,
  facets: {
    kinds: [
      { value: 'Process', count: 7 },
      { value: 'Service', count: 1 },
      { value: 'Container', count: 1 },
    ],
    namespaces: [{ value: 'shop', count: 1 }],
    reasons: [
      { value: 'FailedExit', count: 7 },
      { value: 'Failed', count: 1 },
      { value: 'Die', count: 1 },
    ],
    hosts: [{ value: 'web-1', count: 9 }],
    workloads: [
      { value: 'process:activity2', count: 7 },
      { value: 'service:orders.service', count: 1 },
      { value: 'container:shop-api-1', count: 1 },
    ],
  },
};
const EMPTY = { ...SUMMARY, total: 0, histogram: [], facets: { ...SUMMARY.facets, workloads: [] } };

// Grouped pages ask for 300 events.
const eventRoutes = (fleet: object, q: string, events = EVENTS, summary = SUMMARY): Routes => ({
  'GET /api/v1/clusters': { status: 200, body: { clusters: [fleet] } },
  [`GET ${base}/events/summary?${q}${range}`]: { status: 200, body: summary },
  [`GET ${base}/events?${q}${range}&limit=300`]: {
    status: 200,
    body: { events, nextCursor: null },
  },
});

const facet = (w: ReturnType<typeof mount>, f: string) =>
  w
    .findAll(`[data-testid="facet-${f}"] [data-testid="facet-value"]`)
    .map((x) => x.text().replace(/\s+/g, ''));

describe('server events, the Events page', () => {
  it('facets by kind, server, workload and reason; hides system by default; rows open their workload', async () => {
    const { calls } = mockFetch({
      ...eventRoutes(FLEET, 'types=Warning&system=hide&'),
      ...eventRoutes(FLEET, 'types=Warning&'),
    });
    const { wrapper: w, router } = await mountPage(EventsPage, '/events');
    expect(calls.some((c) => c.path.includes('system=hide'))).toBe(true);

    const heads = w.findAll('[data-testid="event-facets"] h3').map((h) => h.text());
    expect(heads).toEqual(['Kind', 'Server', 'Workload', 'Reason']);
    expect(facet(w, 'workloads')).toEqual([
      'activity2process7',
      'orders.serviceservice1',
      'shop-api-1container1',
    ]);
    expect(w.find('[data-testid="facet-ns"]').exists()).toBe(false);
    expect(w.get('[data-testid="hide-system"] input').element).toHaveProperty('checked', true);

    // Each row links to its workload's page.
    await w.get('[data-testid="group-toggle"] input').setValue(false);
    await flushPromises();
    const links = w.findAll('[data-testid="event-row"] a').map((a) => a.attributes('href'));
    expect(links).toContain('/servers/web-1/workloads/process:activity2');
    expect(links).toContain('/servers/web-1/workloads/service:orders.service');

    // Show system: asked again without system=hide.
    calls.length = 0;
    await w.get('[data-testid="hide-system"] input').setValue(false);
    await flushPromises();
    expect(router.currentRoute.value.query.system).toBe('show');
    expect(calls.map((c) => c.path).filter((p) => p.includes('/events'))).not.toEqual([]);
    expect(calls.every((c) => !c.path.includes('system=hide'))).toBe(true);
    w.unmount();
  });

  it('shows the Compose project facet only within containers, and filters by workload', async () => {
    mockFetch({
      ...eventRoutes(FLEET, 'types=Warning&kinds=Container&system=hide&'),
      ...eventRoutes(FLEET, 'types=Warning&workloads=process%3Aactivity2&system=hide&'),
    });
    const { wrapper: w, router } = await mountPage(EventsPage, '/events?kinds=Container');
    const heads = w.findAll('[data-testid="event-facets"] h3').map((h) => h.text());
    expect(heads).toEqual(['Kind', 'Server', 'Workload', 'Compose project', 'Reason']);
    expect(facet(w, 'ns')).toEqual(['shop1']);
    // The top bar's ?workload= narrows like the facet.
    await router.replace({ query: { workload: 'process:activity2' } });
    await flushPromises();
    expect(w.find('[data-testid="facet-ns"]').exists()).toBe(false);
    expect(
      w.findAll('[data-testid="facet-workloads"] input:checked').map((i) => i.element),
    ).toHaveLength(1);
    w.unmount();
  });

  it('says why it is empty: system hidden, or nothing yet; and when the agent is older than 0.9.2', async () => {
    const old = { ...FLEET, agentVersion: '0.9.1' };
    mockFetch({
      ...eventRoutes(old, 'system=hide&', [], EMPTY),
      ...eventRoutes(old, '', [], EMPTY),
    });
    const { wrapper: w } = await mountPage(EventsPage, '/events?type=all');
    expect(w.get('[data-testid="events-old-agent"]').text()).toContain(
      "This fleet's agent is 0.9.1: only containers' events show",
    );
    const hidden = w.get('[data-testid="no-events-system-hidden"]');
    expect(hidden.text()).toContain('No events from your workloads');
    await hidden.get('button').trigger('click');
    await flushPromises();
    expect(w.get('[data-testid="no-events-yet"]').text()).toContain('services failing');
    w.unmount();
  });

  it('offers Show system when the Warning filter finds nothing', async () => {
    mockFetch(eventRoutes(FLEET, 'types=Warning&system=hide&', [], EMPTY));
    const { wrapper: w } = await mountPage(EventsPage, '/events');
    const none = w.get('[data-testid="no-events"]');
    expect(none.text()).toContain("The OS's own workloads' events are hidden.");
    expect(none.find('[data-testid="show-system"]').exists()).toBe(true);
    expect(w.find('[data-testid="events-old-agent"]').exists()).toBe(false);
    w.unmount();
  });
});

describe("server events, the top bar's workload select", () => {
  it('lists workloads with their kind on Events and sets ?workload=', async () => {
    mockFetch({ 'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } } });
    const { wrapper: w, router } = await mountPage(DockerScopeFilter, '/events');
    useDockerScopeStore().workloads = ['process:activity2', 'service:orders.service'];
    await flushPromises();
    expect(w.find('[data-testid="scope-project"]').exists()).toBe(false);
    const host = w.get('[data-testid="scope-host"] [role="combobox"]');
    expect(host.attributes('placeholder')).toBe('All servers');
    const input = w.get('[data-testid="scope-workload"] [role="combobox"]');
    expect(input.attributes('placeholder')).toBe('All workloads');
    await input.trigger('focus');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(listedOptions()).toEqual(['activity2 · process', 'orders.service · service']);
    [...document.querySelectorAll<HTMLElement>('[role="option"]')][1]!.click();
    await flushPromises();
    expect(router.currentRoute.value.query.workload).toBe('service:orders.service');
    w.unmount();
  });
});

const SERVER = {
  name: 'web-1',
  status: 'active',
  lastSeenAt: iso(1),
  agentVersion: '0.9.2',
  servicesAvailable: true,
  os: 'Ubuntu 24.04',
  kernel: '6.8.0',
  systemd: '255',
  docker: null,
  cpus: 4,
  memoryBytes: 8e9,
  uptimeSeconds: 86400,
  cpuUtilization: 0.2,
  memoryUtilization: 0.4,
  diskUtilization: 0.3,
  counts: { services: 1, processes: 1, containers: 0 },
  problems: [],
  problemCount: 0,
};
const serverRoutes = (events: object[], eventsStored: boolean): Routes => ({
  'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
  [`GET ${base}/servers/web-1`]: {
    status: 200,
    body: {
      server: SERVER,
      usage: {
        cpuCores: 1,
        memoryUsedBytes: 3e9,
        diskUsedBytes: 1e10,
        diskSizeBytes: 4e10,
        networkInBytes: 1e5,
        networkOutBytes: 1e5,
      },
      events,
      eventsStored,
      talksTo: [],
    },
  },
  [`GET ${base}/servers/web-1/workloads`]: { status: 200, body: { workloads: [] } },
  'POST /api/v1/query/range': Array.from({ length: 4 }, () => ({
    status: 200,
    body: { metric: 'x', unit: 'ratio', step: 15, series: [] },
  })),
});

describe('server events, the server and workload pages', () => {
  it('the server page lists its stored events with their message and links to Events', async () => {
    mockFetch(
      serverRoutes(
        [
          {
            workloadId: 'service:orders.service',
            kind: 'event',
            text: 'orders.service',
            count: 2,
            alertId: null,
            reason: 'Failed',
            type: 'Warning',
            message: 'failed (exit-code, exit code 3)',
            at: to - 300,
          },
        ],
        true,
      ),
    );
    const { wrapper: w } = await mountPage(ServerPage, '/servers/web-1');
    const card = w.get('[data-testid="server-events"]');
    const row = card.get('[data-testid="server-event"]');
    expect(row.get('a').text()).toBe('orders.service: Failed');
    expect(row.text()).toMatch(/^\d\d:\d\d.*failed \(exit-code, exit code 3\)×2$/);
    expect(row.get('a').attributes('href')).toBe('/servers/web-1/workloads/service:orders.service');
    expect(card.get('[data-testid="server-events-link"]').attributes('href')).toBe(
      '/events?host=web-1&type=all',
    );
    expect(card.find('[data-testid="server-events-old-agent"]').exists()).toBe(false);
    w.unmount();
  });

  it('the server page says its events are derived when the agent is older than 0.9.2', async () => {
    mockFetch(
      serverRoutes(
        [{ workloadId: 'process:api', kind: 'exited', text: 'api', count: 3, alertId: null }],
        false,
      ),
    );
    const { wrapper: w } = await mountPage(ServerPage, '/servers/web-1');
    const card = w.get('[data-testid="server-events"]');
    expect(card.text()).toContain('api exited with an error 3 times');
    expect(card.get('[data-testid="server-events-old-agent"]').text()).toContain(
      'older than 0.9.2',
    );
    w.unmount();
  });

  it('a workload page lists its own events and links to them on Events', async () => {
    const end = to - (to % 60);
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
      [`GET ${base}/servers/web-1/workloads/process%3Aactivity2`]: {
        status: 200,
        body: {
          workload: {
            id: 'process:activity2',
            server: 'web-1',
            name: 'activity2',
            source: 'process',
            unit: null,
            parent: 'process:pm2',
            note: 'pm2',
            state: 'running',
            status: 'ok',
            problem: null,
            instances: 1,
            restarts24h: 0,
            cpuCores: 0.1,
            memoryBytes: 1e8,
            memoryLimitBytes: null,
            ports: [],
            changedAt: null,
            system: false,
            exe: 'node',
          },
          server: 'web-1',
          related: [],
          usage: { threads: 11, openFiles: 24, tasks: null, startedAt: null, cpuLimitCores: null },
          timeline: { start: end - 3600, end, step: 60, points: [], releases: [] },
          crashLoopSince: null,
          connections: [],
          cause: null,
          events: [
            {
              reason: 'FailedExit',
              type: 'Warning',
              message: 'killed by SIGKILL (9)',
              count: 7,
              firstSeen: to - 1800,
              lastSeen: to - 300,
            },
            {
              reason: 'Appeared',
              type: 'Normal',
              message: 'started',
              count: 1,
              firstSeen: to - 1700,
              lastSeen: to - 1700,
            },
          ],
        },
      },
    });
    const { wrapper: w } = await mountPage(
      ServerWorkloadPage,
      '/servers/web-1/workloads/process:activity2',
    );
    const rows = w
      .findAll('[data-testid="workload-event"]')
      .map((r) => r.text().replace(/\s+/g, ' '));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^\d\d:\d\d.*FailedExit ?killed by SIGKILL \(9\) ?×7$/);
    expect(w.get('[data-testid="workload-events-link"]').attributes('href')).toBe(
      '/events?host=web-1&workload=process:activity2&type=all',
    );
    w.unmount();
  });
});

describe('server events, helpers', () => {
  it('splits workload ids, compares agent versions and links events', () => {
    expect(splitWorkload('process:pm2')).toEqual({ kind: 'process', name: 'pm2' });
    expect(splitWorkload('service:a:b.service')).toEqual({ kind: 'service', name: 'a:b.service' });
    expect(agentBefore('0.9.1', '0.9.2')).toBe(true);
    expect(agentBefore('0.9.2', '0.9.2')).toBe(false);
    expect(agentBefore('0.10.0', '0.9.2')).toBe(false);
    expect(agentBefore('v0.8.3-rc.1', '0.9.2')).toBe(true);
    expect(agentBefore(null, '0.9.2')).toBe(false);
    expect(objectLink(EVENTS[0] as never)).toEqual({
      name: 'server-workload',
      params: { server: 'web-1', workload: 'process:activity2' },
    });
    expect(
      eventObjectLink({ kind: 'Service', namespace: 'web-1', name: 'orders.service' }),
    ).toEqual({
      name: 'server-workload',
      params: { server: 'web-1', workload: 'service:orders.service' },
    });
    expect(eventObjectLink({ kind: 'Image', namespace: null, name: 'x' })).toBeUndefined();
  });
});
