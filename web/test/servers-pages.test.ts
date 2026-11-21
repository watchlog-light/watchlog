// SPDX-License-Identifier: AGPL-3.0-only
// Server fleets' pages (ADR-207): the fleet, a server's workloads grouped by unit, one
// workload's exits timeline, and 0.8's Hosts addresses redirecting.
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupByUnit, portsText, shortKernel, shortOs, timelineBars } from '@/lib/servers';
import { useAuthStore } from '@/stores/auth';
import ServerPage from '@/views/ServerPage.vue';
import ServersPage from '@/views/ServersPage.vue';
import ServerWorkloadPage from '@/views/ServerWorkloadPage.vue';
import { FLEET } from './docker-fixtures';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const base = `/api/v1/clusters/${FLEET.id}`;

async function mountPage(component: object, path: string) {
  const plugins = await createPlugins(path);
  useAuthStore().user = USER;
  const wrapper = mount(component, {
    global: {
      plugins: [plugins.router, plugins.i18n, plugins.pinia],
      stubs: {
        TimeSeriesChart: {
          props: ['title'],
          template: '<div class="chart-stub">{{ title }}</div>',
        },
      },
    },
  });
  await flushPromises();
  return { wrapper, router: plugins.router };
}

const wl = (o: Record<string, unknown>) => ({
  unit: null,
  note: null,
  state: 'active · running',
  problem: null,
  cpuCores: 0.1,
  memoryBytes: 50e6,
  memoryLimitBytes: null,
  instances: null,
  ports: [],
  restarts24h: 0,
  lastExitCode: null,
  system: false,
  ...o,
});
const API = wl({
  id: 'process:api',
  source: 'process',
  name: 'api',
  unit: 'pm2-app.service',
  note: 'pm2',
  state: '1',
  instances: 1,
  ports: [3000],
  restarts24h: 14,
  problem: { kind: 'crash_looping', severity: 'critical', code: null },
});
const WORKLOADS = [
  API,
  wl({ id: 'service:nginx.service', source: 'service', name: 'nginx.service', ports: [80, 443] }),
  wl({ id: 'service:pm2-app.service', source: 'service', name: 'pm2-app.service' }),
  wl({
    id: 'container:redis',
    source: 'container',
    name: 'redis',
    note: 'compose:app',
    state: 'running · healthy',
  }),
  wl({ id: 'service:ssh.service', source: 'service', name: 'ssh.service', system: true }),
];
const SERVER = {
  name: 'app-1',
  status: 'active',
  lastSeenAt: null,
  agentVersion: '0.9.0',
  servicesAvailable: true,
  os: 'Debian GNU/Linux 12 (bookworm)',
  kernel: '6.1.0-53-cloud-arm64',
  systemd: '252',
  docker: '27.3.1',
  cores: 4,
  memoryBytes: 8 * 2 ** 30,
  bootTime: Date.now() / 1000 - 41 * 86400 - 60,
  cpuUtilization: 0.62,
  memoryUtilization: 0.71,
  diskUtilization: 0.48,
  workloads: { services: 3, processes: 1, containers: 1 },
  problems: [
    {
      id: 'process:api',
      name: 'api',
      source: 'process',
      kind: 'crash_looping',
      severity: 'critical',
    },
  ],
  problemCount: 1,
};

describe('server helpers', () => {
  it('group process groups under the service they run in, system services folded', () => {
    const rows = groupByUnit(WORKLOADS as never).map((r) => `${r.child ? '  ' : ''}${r.w.name}`);
    expect(rows).toEqual(['nginx.service', 'pm2-app.service', '  api', 'redis']);
    expect(groupByUnit(WORKLOADS as never, true)).toHaveLength(5);
    // A group whose unit isn't listed (filtered out) stands alone.
    expect(groupByUnit([API] as never)[0]).toMatchObject({ child: false });
  });

  it('shorten the header facts and the ports', () => {
    expect(shortOs('Debian GNU/Linux 12 (bookworm)')).toBe('Debian 12');
    expect(shortOs('Rocky Linux 9.4 (Blue Onyx)')).toBe('Rocky Linux 9.4');
    expect(shortKernel('6.1.0-53-cloud-arm64')).toBe('6.1');
    expect(portsText([22, 80, 443, 3000, 8080, 9000])).toBe(':22 :80 :443 :3000 +2');
    const bars = timelineBars([
      [60, 1, 0, 1, 0],
      [120, 0, 0, 0, 0],
      [180, 2, 1, 0, 0],
    ]);
    expect(bars.map((b) => b.h)).toEqual([1 / 3, 0, 1]);
  });
});

describe('Servers pages', () => {
  it('lists the fleet: tiles, bars, workload chips and what needs attention', async () => {
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
      [`GET ${base}/servers`]: {
        status: 200,
        body: {
          servers: [SERVER],
          totals: {
            servers: 1,
            needAttention: 1,
            services: 3,
            servicesFailed: 0,
            processes: 1,
            crashLooping: 1,
            containers: 1,
          },
        },
      },
    });
    const { wrapper: w } = await mountPage(ServersPage, '/servers');
    expect(w.text()).toContain('1 server');
    const tiles = w.get('[data-testid="server-tiles"]').text().replace(/\s+/g, '');
    expect(tiles).toContain('Processgroups1·1crash-looping');
    const row = w.get('[data-testid="server-row"]');
    expect(row.text().replace(/\s+/g, '')).toMatch(
      /app-1Debian12·agent0\.9\.062%71%48%3svc1proc1ctr.*apicrash-looping/,
    );
    expect(row.get('a').attributes('href')).toBe('/servers/app-1');
    expect(row.findAll('a').at(-1)!.attributes('href')).toBe(
      '/servers/app-1/workloads/process:api',
    );
    // Phones get cards with the same facts.
    expect(w.get('[data-testid="server-cards"]').text()).toContain('api crash-looping');
    w.unmount();
  });

  it('shows a server: header chips, workloads grouped by unit, system services folded', async () => {
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
      [`GET ${base}/servers/app-1`]: {
        status: 200,
        body: {
          server: SERVER,
          usage: {
            cpuCores: 2.5,
            memoryUsedBytes: 5.7e9,
            diskUsedBytes: 38e9,
            diskSizeBytes: 80e9,
            networkInBytes: 9e6,
            networkOutBytes: 5e6,
          },
          events: [
            { workloadId: 'process:api', kind: 'exited', text: 'api', count: 14, alertId: null },
          ],
          talksTo: [
            {
              from: 'api',
              fromKind: 'ProcessGroup',
              to: 'db-1',
              toKind: 'external',
              port: 5432,
              rate: 3.2,
              failed: 0,
            },
          ],
        },
      },
      [`GET ${base}/servers/app-1/workloads`]: { status: 200, body: { workloads: WORKLOADS } },
      'POST /api/v1/query/range': Array.from({ length: 4 }, () => ({
        status: 200,
        body: { metric: 'x', unit: 'ratio', step: 15, series: [] },
      })),
    });
    const { wrapper: w } = await mountPage(ServerPage, '/servers/app-1');
    const chips = w.get('[data-testid="server-chips"]').text().replace(/\s+/g, ' ');
    expect(chips).toContain('Debian 12');
    expect(chips).toContain('kernel 6.1');
    expect(chips).toContain('systemd 252');
    expect(chips).toContain('Docker 27.3.1');
    expect(chips).toContain('up 41 days');
    const rows = () =>
      w.findAll('[data-testid="workload-row"]').map((r) => r.text().replace(/\s+/g, ''));
    expect(rows()).toHaveLength(4);
    expect(rows()[2]).toMatch(/^apipm2Processcrash-looping/);
    expect(rows().join('\n')).toContain(':80:443');
    await w.get('[data-testid="toggle-system"]').trigger('click');
    expect(rows()).toHaveLength(5);
    expect(w.get('[data-testid="server-events"]').text()).toContain(
      'api exited with an error 14 times',
    );
    expect(w.get('[data-testid="server-talks"]').text()).toContain('api → db-1:5432');
    expect(w.find('[data-testid="old-agent"]').exists()).toBe(false);
    w.unmount();
  });

  it('shows a workload: crash loop since, the exits timeline and the release marker', async () => {
    const end = 1_795_000_000 - (1_795_000_000 % 60);
    const points = Array.from({ length: 60 }, (_, i) => [
      end - 3540 + i * 60,
      i >= 50 ? 1 : 0,
      0,
      i >= 50 ? 1 : 0,
      0,
    ]);
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
      [`GET ${base}/servers/app-1/workloads/process%3Aapi`]: {
        status: 200,
        body: {
          workload: API,
          server: 'app-1',
          related: [WORKLOADS[2]],
          usage: { threads: 11, openFiles: 24, tasks: null, startedAt: null, cpuLimitCores: null },
          timeline: { start: end - 3600, end, step: 60, points, releases: [end - 660] },
          crashLoopSince: end - 600,
          connections: [],
          events: [],
          cause: {
            state: 'likely',
            code: 'release',
            since: end - 600,
            symptom: { exitCode: 1, failedExits: 10, restarts: 10 },
            facts: { releaseAt: end - 660, minutesAfter: 1 },
            checks: [
              {
                topic: 'changes',
                result: 'explains',
                facts: { releaseAt: end - 660, since: end - 600 },
              },
              {
                topic: 'memory',
                result: 'ok',
                facts: { oomKills: 0, usage: 1073741824, limit: null },
              },
              {
                topic: 'dependencies',
                result: 'not_run',
                facts: { to: null, port: null, failed: 0 },
              },
            ],
          },
        },
      },
    });
    const { wrapper: w } = await mountPage(
      ServerWorkloadPage,
      '/servers/app-1/workloads/process:api',
    );
    const header = w.get('[data-testid="workload-header"]').text().replace(/\s+/g, ' ');
    const tight = header.replace(/\s+/g, '');
    expect(tight).toMatch(/^apiProcess.?Crash-loopingsince\d\d:\d\d/);
    expect(header).toContain('inside pm2-app.service on app-1. Grouped by: pm2.');
    expect(w.get('[data-testid="cause-headline"]').text()).toMatch(
      /^api exits with code 1 since its executable changed at \d\d:\d\d.*a new release, 1 min before the first crash\.$/,
    );
    const card = w.get('[data-testid="cause-card"]').text();
    expect(card).toContain('Likely · the release');
    expect(card).toContain('Not memory: no OOM kill');
    expect(w.findAll('[data-testid="release-marker"]')).toHaveLength(1);
    expect(w.get('[data-testid="exit-timeline"]').findAll('.bg-critical')).toHaveLength(10);
    expect(w.text()).toContain('Command lines stay on the server');
    w.unmount();
  });

  it("redirects 0.8's Hosts addresses to Servers", async () => {
    mockFetch({ 'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } } });
    const plugins = await createPlugins('/hosts/app-1?cluster=x');
    expect(plugins.router.currentRoute.value.fullPath).toBe('/servers/app-1?cluster=x');
    await plugins.router.push('/hosts');
    expect(plugins.router.currentRoute.value.name).toBe('servers');
  });
});

describe('process-group rules', () => {
  it('preview a process as the agent would group it', async () => {
    const { previewRules, globRegExp } = await import('@/lib/process-rules');
    const rules = [
      { exe: 'node', unit: 'pm2-*.service', name: 'pm2 apps' },
      { exe: 'python*', args: '-m (\\w+)', name: 'py $1' },
    ];
    expect(
      previewRules(rules, { exe: 'python3', unit: '', args: '/usr/bin/python3 -m sync' }),
    ).toEqual({
      name: 'py sync',
      rule: 2,
    });
    expect(previewRules(rules, { exe: 'node', unit: 'pm2-deploy.service', args: 'x' })).toEqual({
      name: 'pm2 apps',
      rule: 1,
    });
    expect(previewRules(rules, { exe: 'ruby', unit: '', args: '' })).toBeNull();
    expect(globRegExp('php-fpm[0-9]*').test('php-fpm8.3')).toBe(true);
    expect(globRegExp('a.b').test('axb')).toBe(false);
  });

  it('edits the ordered list and shows the backend refusal', async () => {
    const { default: ProcessRules } = await import('@/components/servers/ProcessRules.vue');
    const { calls } = mockFetch({
      [`GET ${base}/process-rules`]: {
        status: 200,
        body: {
          rules: [{ exe: 'python*', args: '-m (\\w+)', name: 'py $1' }],
          matches: [{ group: 'py sync', servers: ['app-1'], instances: 2 }],
        },
      },
      [`PUT ${base}/process-rules`]: [
        {
          status: 400,
          body: {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: 'Rule 2: A rule needs a name',
          },
        },
      ],
    });
    const plugins = await createPlugins('/');
    const w = mount(ProcessRules, {
      props: { clusterId: FLEET.id, canManage: true },
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    await flushPromises();
    expect(w.findAll('[data-testid="rule-row"]')).toHaveLength(1);
    expect(w.get('[data-testid="preview-result"]').text()).toBe('Grouped as py sync by rule 1');
    expect(w.text()).toContain('py sync: 2 on app-1');
    await w.get('[data-testid="add-rule"]').trigger('click');
    await w.findAll('[data-testid="rule-row"]')[1]!.get('[data-field="exe"]').setValue('ruby');
    await w.get('[data-testid="save-rules"]').trigger('click');
    await flushPromises();
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({
      rules: [
        { exe: 'python*', args: '-m (\\w+)', name: 'py $1' },
        { exe: 'ruby', name: '' },
      ],
    });
    expect(w.get('[data-testid="rules-error"]').text()).toBe('Rule 2: A rule needs a name');
    w.unmount();
  });

  it('is read-only for viewers', async () => {
    const { default: ProcessRules } = await import('@/components/servers/ProcessRules.vue');
    mockFetch({ [`GET ${base}/process-rules`]: { status: 200, body: { rules: [], matches: [] } } });
    const plugins = await createPlugins('/');
    const w = mount(ProcessRules, {
      props: { clusterId: FLEET.id, canManage: false },
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    await flushPromises();
    expect(w.find('[data-testid="save-rules"]').exists()).toBe(false);
    expect(w.text()).toContain('Only Owners and Admins');
    w.unmount();
  });
});
