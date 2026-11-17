// SPDX-License-Identifier: AGPL-3.0-only
// The fleet's Workloads at the Kubernetes page's level (0.9.1, ADR-124): by server, services
// with their groups, pm2's apps under pm2, containers under their Compose project, "Hide
// system" on by default with its count, chips and the name filter; and a workload's charts
// for a service and a process group, with their empty states.
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTree, type FleetWorkload } from '@/lib/server-workloads';
import { useAuthStore } from '@/stores/auth';
import ServerWorkloadPage from '@/views/ServerWorkloadPage.vue';
import ServerWorkloadsPage from '@/views/ServerWorkloadsPage.vue';
import { FLEET } from './docker-fixtures';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

afterEach(() => vi.unstubAllGlobals());
const base = `/api/v1/clusters/${FLEET.id}`;

const w = (o: Partial<FleetWorkload> & { id: string; source: FleetWorkload['source'] }) =>
  ({
    name: o.id.slice(o.id.indexOf(':') + 1),
    unit: null,
    note: null,
    state: 'active · running',
    problem: null,
    cpuCores: 0.05,
    memoryBytes: 60e6,
    memoryLimitBytes: null,
    instances: 1,
    ports: [],
    restarts24h: 0,
    lastExitCode: null,
    system: false,
    runs: null,
    cpuLimitCores: null,
    changedAt: null,
    expected: null,
    parent: null,
    server: 'ubuntu-8gb-nbg1-1',
    cpuSeries: [],
    ...o,
  }) as FleetWorkload;

// The owner's layout: pm2 run by a user outside systemd with its apps, nginx with PHP-FPM, a
// Compose project, the OS's own, WatchLog's own agent, and another product's agent of the
// same name (v1, on :3774), which is not ours.
const FLEET_WORKLOADS: FleetWorkload[] = [
  w({ id: 'service:nginx.service', source: 'service', instances: 1, expected: 1, runs: 'nginx' }),
  w({
    id: 'service:php8.3-fpm.service',
    source: 'service',
    instances: 1,
    expected: 1,
    runs: 'php-fpm8.3',
    memoryLimitBytes: 1024 ** 3,
    cpuLimitCores: 2,
  }),
  w({
    id: 'process:pool www',
    source: 'process',
    unit: 'php8.3-fpm.service',
    note: 'php-fpm',
    parent: 'service:php8.3-fpm.service',
    instances: 5,
    runs: 'php-fpm8.3',
  }),
  w({ id: 'process:pm2', source: 'process', note: 'pm2', runs: 'node' }),
  w({
    id: 'process:activity2',
    source: 'process',
    note: 'pm2',
    parent: 'process:pm2',
    runs: 'node',
    restarts24h: 4,
    problem: { kind: 'crash_looping', severity: 'critical', code: 1 },
  }),
  w({
    id: 'process:teleboost',
    source: 'process',
    note: 'pm2',
    parent: 'process:pm2',
    runs: 'node',
  }),
  w({ id: 'process:watchlog-agent', source: 'process', note: 'exe', runs: 'watchlog-agent' }),
  w({
    id: 'service:watchlog-agent.service',
    source: 'service',
    system: true,
    runs: 'watchlog-agent',
  }),
  w({ id: 'process:systemd', source: 'process', system: true, note: 'exe' }),
  w({ id: 'process:bash', source: 'process', system: true, note: 'exe' }),
  w({ id: 'container:app-redis-1', source: 'container', state: 'running', parent: 'compose:app' }),
  w({ id: 'container:app-web-1', source: 'container', state: 'running', parent: 'compose:app' }),
];
const all = { showSystem: false, source: 'all' as const, failing: false, term: '' };

describe('the fleet workloads tree', () => {
  it("nests groups under their service, pm2's apps under pm2, containers under their project", () => {
    const t = buildTree(FLEET_WORKLOADS, all);
    const rows = t.servers[0]!.rows.map((r) => `${'  '.repeat(r.depth)}${r.id}`);
    expect(rows).toContain('  process:activity2');
    expect(rows.indexOf('  process:activity2')).toBe(rows.indexOf('process:pm2') + 1);
    expect(rows).toContain('  process:pool www');
    expect(rows).toContain('compose:app');
    expect(rows).toContain('  container:app-redis-1');
    // Problems first: pm2 holds the crash-looping app, so it leads.
    expect(rows[0]).toBe('process:pm2');
  });

  it('hides the OS and WatchLog by identity, counts them, and keeps a foreign watchlog-agent', () => {
    const t = buildTree(FLEET_WORKLOADS, all);
    const ids = t.servers[0]!.rows.map((r) => r.id);
    expect(t.hiddenSystem).toBe(3);
    expect(ids).not.toContain('service:watchlog-agent.service');
    expect(ids).not.toContain('process:systemd');
    expect(ids).toContain('process:watchlog-agent');
    const shown = buildTree(FLEET_WORKLOADS, { ...all, showSystem: true });
    expect(shown.hiddenSystem).toBe(0);
    expect(shown.servers[0]!.rows.map((r) => r.id)).toContain('process:systemd');
  });

  it('chips count after Hide system; Failing and a name keep their parents', () => {
    const t = buildTree(FLEET_WORKLOADS, all);
    expect(t.counts).toEqual({ service: 2, process: 5, container: 2, failing: 1 });
    const failing = buildTree(FLEET_WORKLOADS, { ...all, failing: true }).servers[0]!.rows;
    expect(failing.map((r) => r.id)).toEqual(['process:activity2']);
    const byName = buildTree(FLEET_WORKLOADS, { ...all, term: 'teleb' }).servers[0]!.rows;
    expect(byName.map((r) => [r.id, r.depth])).toEqual([
      ['process:pm2', 0],
      ['process:teleboost', 1],
    ]);
    const services = buildTree(FLEET_WORKLOADS, { ...all, source: 'service' }).servers[0]!.rows;
    expect(services.every((r) => r.kind === 'service')).toBe(true);
  });
});

async function mountPage(component: object, path: string) {
  const plugins = await createPlugins(path);
  useAuthStore().user = USER;
  const wrapper = mount(component, {
    global: {
      plugins: [plugins.router, plugins.i18n, plugins.pinia],
      stubs: {
        TimeSeriesChart: {
          props: ['title', 'emptyText'],
          template: '<div class="chart-stub">{{ title }}</div>',
        },
        SparkLine: { template: '<i class="spark" />' },
      },
    },
  });
  await flushPromises();
  return { wrapper, router: plugins.router };
}

describe('the fleet Workloads page', () => {
  const totals = {
    servers: 1,
    needAttention: 1,
    services: 2,
    servicesFailed: 0,
    processes: 5,
    crashLooping: 1,
    containers: 2,
  };
  const routes = (workloads: FleetWorkload[]) => ({
    'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
    [`GET ${base}/servers?workloads=1&range=3600`]: {
      status: 200,
      body: { servers: [], workloads, totals },
    },
  });

  it('groups by server with its attention count; rows as the Kubernetes rows', async () => {
    mockFetch(routes(FLEET_WORKLOADS));
    const { wrapper } = await mountPage(ServerWorkloadsPage, '/workloads');
    const group = wrapper.get('[data-testid=server-group]');
    expect(group.text()).toContain('ubuntu-8gb-nbg1-1');
    expect(group.get('[data-testid=server-attention]').text()).toContain('1 needs attention');
    const row = wrapper
      .findAll('[data-testid=server-workload-row]')
      .find((r) => r.text().includes('activity2'))!;
    expect(row.attributes('data-depth')).toBe('1');
    expect(row.get('[data-testid=kind-tag]').text()).toBe('Process · pm2');
    expect(row.get('[data-testid=problem-reason]').text()).toBe('crash-looping, exit 1');
    expect(row.get('[data-testid=health-badge]').text()).toContain('Failing');
    expect(row.get('[data-testid=restarts]').text()).toBe('4');
    expect(row.get('[data-testid=runs]').text()).toBe('node');
    const nginx = wrapper
      .findAll('[data-testid=server-workload-row]')
      .find((r) => r.text().includes('nginx.service'))!;
    expect(nginx.get('[data-testid=instances]').text()).toBe('1/1');
    expect(nginx.get('[data-testid=restarts]').text()).toBe('0');
    expect(nginx.find('[data-testid=health-dot]').exists()).toBe(true);
  });

  it('hides system by default and says how many; the switch shows them', async () => {
    mockFetch(routes(FLEET_WORKLOADS));
    const { wrapper, router } = await mountPage(ServerWorkloadsPage, '/workloads');
    expect(wrapper.get('[data-testid=hidden-system]').text()).toBe('3 system workloads hidden');
    expect(wrapper.text()).not.toContain('watchlog-agent.service');
    expect(wrapper.text()).toContain('watchlog-agent');
    await wrapper.get('[data-testid=hide-system] input').setValue(false);
    await flushPromises();
    expect(router.currentRoute.value.query.system).toBe('show');
    expect(wrapper.text()).toContain('watchlog-agent.service');
    expect(wrapper.find('[data-testid=hidden-system]').exists()).toBe(false);
  });

  it('counts the chips and filters to failing', async () => {
    mockFetch(routes(FLEET_WORKLOADS));
    const { wrapper } = await mountPage(ServerWorkloadsPage, '/workloads');
    expect(wrapper.get('[data-testid=chip-process]').text()).toBe('Processes 5');
    expect(wrapper.get('[data-testid=chip-failing]').text()).toBe('Failing 1');
    await wrapper.get('[data-testid=chip-failing]').trigger('click');
    await flushPromises();
    const rows = wrapper.findAll('[data-testid=server-workload-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toMatch(/^activity2/);
  });

  it('says why nothing shows: no workloads yet, or filters that match none', async () => {
    mockFetch(routes([]));
    const { wrapper } = await mountPage(ServerWorkloadsPage, '/workloads');
    expect(wrapper.get('[data-testid=workloads-empty]').text()).toContain('No workloads yet');
    mockFetch(routes(FLEET_WORKLOADS));
    const filtered = await mountPage(ServerWorkloadsPage, '/workloads?q=nothing-like-this');
    expect(filtered.wrapper.get('[data-testid=workloads-empty]').text()).toContain(
      'No workload matches these filters',
    );
  });
});

describe("a workload's charts", () => {
  const end = Math.floor(Date.now() / 1000);
  const detail = (workload: FleetWorkload, usage: Record<string, number | null>) => ({
    workload,
    server: 'ubuntu-8gb-nbg1-1',
    related: [],
    usage: {
      threads: null,
      openFiles: null,
      tasks: null,
      startedAt: null,
      cpuLimitCores: null,
      ...usage,
    },
    timeline: { start: end - 3600, end, step: 60, points: [], releases: [] },
    crashLoopSince: null,
    connections: [],
    cause: null,
  });
  const range = { status: 200, body: { metric: 'x', unit: 'count', step: 60, series: [] } };
  const page = async (
    id: string,
    workload: FleetWorkload,
    usage: Record<string, number | null>,
  ) => {
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
      [`GET ${base}/servers/ubuntu-8gb-nbg1-1/workloads/${encodeURIComponent(id)}`]: {
        status: 200,
        body: detail(workload, usage),
      },
      'POST /api/v1/query/range': Array.from({ length: 20 }, () => range),
    });
    return mountPage(
      ServerWorkloadPage,
      `/servers/ubuntu-8gb-nbg1-1/workloads/${encodeURIComponent(id)}`,
    );
  };

  it('a process group: CPU, memory, instances, threads and files, its events; restarts 0, never –', async () => {
    const g = FLEET_WORKLOADS.find((x) => x.id === 'process:teleboost')!;
    const { wrapper } = await page('process:teleboost', g, { threads: 11, openFiles: 31 });
    const titles = wrapper.findAll('.chart-stub').map((c) => c.text());
    expect(titles).toEqual([
      'CPU (cores)',
      'Memory',
      'Instances',
      'Threads and open files',
      'Starts, exits and OOM kills',
    ]);
    expect(wrapper.get('[data-testid=events-line]').text()).toBe(
      'No exits, restarts or OOM kills in this window.',
    );
    expect(wrapper.text()).toContain('Restarts 24 h');
    expect(wrapper.text()).not.toMatch(/Restarts 24 h\s*–/);
  });

  it('a service: CPU, memory, tasks, disk I/O and its restarts, crashes and OOM kills', async () => {
    const svc = FLEET_WORKLOADS.find((x) => x.id === 'service:php8.3-fpm.service')!;
    const { wrapper } = await page('service:php8.3-fpm.service', svc, { tasks: 24 });
    expect(wrapper.findAll('.chart-stub').map((c) => c.text())).toEqual([
      'CPU (cores)',
      'Memory',
      'Tasks',
      'Disk I/O',
      'Restarts, crashes and OOM kills',
    ]);
  });

  it('a container: a link to its own page instead of charts', async () => {
    const c = FLEET_WORKLOADS.find((x) => x.id === 'container:app-redis-1')!;
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
      [`GET ${base}/servers/ubuntu-8gb-nbg1-1/workloads/${encodeURIComponent('container:app-redis-1')}`]:
        { status: 200, body: detail(c, {}) },
    });
    const { wrapper } = await mountPage(
      ServerWorkloadPage,
      `/servers/ubuntu-8gb-nbg1-1/workloads/${encodeURIComponent('container:app-redis-1')}`,
    );
    expect(wrapper.find('[data-testid=workload-charts]').exists()).toBe(false);
    expect(wrapper.get('[data-testid=container-page-link]').attributes('href')).toContain(
      '/containers/ubuntu-8gb-nbg1-1/app-redis-1',
    );
  });
});
