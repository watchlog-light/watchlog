// SPDX-License-Identifier: AGPL-3.0-only
import { flushPromises, mount } from '@vue/test-utils';
import type { DockerContainer } from '@watchlog/api-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContainerDiagnosis from '@/components/docker/ContainerDiagnosis.vue';
import ContainerList from '@/components/docker/ContainerList.vue';
import { containerRows } from '@/lib/containers';
import AppTopBar from '@/components/layout/AppTopBar.vue';
import { useAuthStore } from '@/stores/auth';
import ContainersPage from '@/views/ContainersPage.vue';
import { container, CRASHLOOP, FLEET, OOM, UNHEALTHY, UNHEALTHY_DETAIL } from './docker-fixtures';
import { mockFetch, USER } from './fetch-mock';
import { chooseOption, createPlugins } from './helpers';

const NOW = Date.parse('2026-10-31T06:29:16.696Z');

async function render(c: object) {
  const plugins = await createPlugins('/');
  return mount(ContainerDiagnosis, {
    props: { container: c as DockerContainer, now: NOW },
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Why is this container unhealthy? panel', () => {
  it('unhealthy: duration and streak, last probe output, check settings, recent probes', async () => {
    const w = await render(UNHEALTHY);
    expect(w.get('h3').text()).toBe('Why is this container unhealthy?');
    expect(w.get('[data-testid="diagnosis-summary"]').text()).toBe(
      'Health check failing for 9m · 3 consecutive failures',
    );
    expect(w.text()).toContain(
      "wget: can't connect to remote host (127.0.0.1): Connection refused",
    );
    const check = w.get('[data-testid="check"]').text();
    expect(check).toContain('Authorization: Bearer ***');
    expect(check).toMatch(/Interval\s*5s/);
    expect(check).toMatch(/Timeout\s*3s/);
    expect(check).toMatch(/Retries\s*3/);
    expect(check).toMatch(/Start period\s*2s/);
    const probes = w.findAll('[data-testid="probes"] li');
    expect(probes).toHaveLength(3);
    expect(probes[0]!.text()).toContain('Failed at');
    expect(probes[0]!.text()).toContain('exit code 1');
  });

  it('says so when the agent does not send probe output', async () => {
    const quiet = {
      ...UNHEALTHY,
      healthDetail: {
        ...UNHEALTHY_DETAIL,
        probes: UNHEALTHY_DETAIL.probes.map((p) => ({ ...p, output: null })),
      },
    };
    const w = await render(quiet);
    expect(w.text()).toContain('set not to send health check output');
    expect(w.text()).not.toContain('Connection refused');
  });

  it('exited, OOM killed: flags out of memory and the exit code meaning', async () => {
    const w = await render(OOM);
    expect(w.get('h3').text()).toBe('Why did this container stop?');
    expect(w.get('[data-testid="oom"]').text()).toContain('Out of memory');
    expect(w.get('[data-testid="exit-meaning"]').text()).toBe('137 · killed (SIGKILL)');
    expect(w.text()).toContain('Finished');
    expect(w.find('[data-testid="killed-hint"]').exists()).toBe(false);
  });

  it('exit 137 without the OOM flag: explains SIGKILL and names the memory limit', async () => {
    // Measured: Docker can miss an OOM kill right after start (OOMKilled=false, 137).
    const w = await render({ ...OOM, oomKilled: false });
    expect(w.find('[data-testid="oom"]').exists()).toBe(false);
    expect(w.get('[data-testid="killed-hint"]').text()).toContain('32 MiB memory limit');
  });

  it('exited normally and dead containers show the code and Docker error', async () => {
    let w = await render(
      container('job', { state: 'exited', exitCode: 0, finishedAt: OOM.finishedAt }),
    );
    expect(w.get('[data-testid="exit-meaning"]').text()).toBe('0 · completed normally');
    w = await render(
      container('broken', {
        state: 'dead',
        exitCode: 127,
        stateError: 'exec: "srv": executable file not found',
      }),
    );
    expect(w.get('[data-testid="exit-meaning"]').text()).toBe('127 · command not found');
    expect(w.text()).toContain('executable file not found');
  });

  it('restarting: restart count and last exit code', async () => {
    const w = await render(CRASHLOOP);
    expect(w.get('h3').text()).toBe('Why is this container restarting?');
    expect(w.get('[data-testid="restart-count"]').text()).toBe('4');
    expect(w.get('[data-testid="exit-meaning"]').text()).toBe('2 · invalid usage or shell error');
  });

  it('renders nothing for a healthy running container', async () => {
    const w = await render(container('ok', { health: 'healthy' }));
    expect(w.find('[data-testid="diagnosis"]').exists()).toBe(false);
  });
});

describe('reasons in the list and the top bar', () => {
  it('shows the one-line reason under bad-state containers and on the pill', async () => {
    const plugins = await createPlugins('/');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    // As the API returns them: each bad container with its problem.
    const bad = (c: object, severity: string, kind: string) => ({
      ...c,
      problem: { severity, kind, title: '', reason: null, alertId: null },
    });
    const w = mount(ContainerList, {
      props: {
        containers: containerRows([
          bad(UNHEALTHY, 'warning', 'Unhealthy'),
          bad(OOM, 'critical', 'OOMKilled'),
          bad(CRASHLOOP, 'critical', 'Restarting'),
          container('ok'),
        ] as DockerContainer[]),
        range: 3600,
      },
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    vi.useRealTimers();
    const reasons = w.findAll('[data-testid="container-reason"]').map((r) => r.text());
    // Critical rows first (OOM, restarting), then the warning.
    expect(reasons).toEqual([
      'Restarting · 4 restarts · last exit 2 (invalid usage or shell error)',
      'Exited with code 137 · killed (SIGKILL) · out of memory (OOM killed)',
      'Health check failing for 9m · 3 consecutive failures',
    ]);
    expect(w.findAll('[data-testid="health-badge"]').map((b) => b.text())).toEqual([
      '✕ Restarting',
      '✕ OOM-killed',
      '▲ Unhealthy',
    ]);
  });

  it('replaces the namespace filter with host and Compose project filters on Docker pages', async () => {
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
      [`GET /api/v1/clusters/${FLEET.id}/docker/containers?range=3600`]: {
        status: 200,
        body: {
          containers: [UNHEALTHY, container('demo-web-1', { composeProject: 'demo' })],
          range: 3600,
          step: 60,
        },
      },
    });
    const plugins = await createPlugins('/containers');
    useAuthStore().user = USER;
    const global = { plugins: [plugins.router, plugins.i18n, plugins.pinia] };
    const page = mount(ContainersPage, { global });
    const bar = mount(AppTopBar, { props: { title: 'Docker' }, global });
    await flushPromises();
    expect(bar.find('[data-testid="namespace-filter"]').exists()).toBe(false);
    expect(
      bar.get('[data-testid="scope-project"] [role="combobox"]').attributes('placeholder'),
    ).toBe('All Compose projects');
    await chooseOption(bar, 'scope-project', 'demo');
    expect(plugins.router.currentRoute.value.query).toEqual({ project: 'demo' });
    expect(
      page.findAll('[data-testid="container-row"] td:first-child button').map((a) => a.text()),
    ).toEqual(['demo-web-1']);

    // A fleet's Overview takes the same filters; never the namespace filter.
    await plugins.router.push('/');
    await flushPromises();
    expect(bar.find('[data-testid="namespace-filter"]').exists()).toBe(false);
    expect(bar.find('[data-testid="docker-scope"]').exists()).toBe(true);
    page.unmount();
  });
});
