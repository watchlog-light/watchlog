// SPDX-License-Identifier: AGPL-3.0-only
// The connect flow in the dashboard (v0.3 slice 4, ADR-133, ADR-134): the three ways to
// connect on Kubernetes and Docker with their probe, polling and Check now; the settings
// drawer for Owners and for Viewers; Add manually.
import { flushPromises, mount } from '@vue/test-utils';
import type { Application, Probe } from '@watchlog/api-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AccessStep from '@/components/applications/AccessStep.vue';
import AddServiceDialog from '@/components/applications/AddServiceDialog.vue';
import SettingsDrawer from '@/components/applications/SettingsDrawer.vue';
import type { ConnectTarget } from '@/lib/applications';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

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
const PG: ConnectTarget = {
  cluster: K8S,
  type: 'postgres',
  name: 'billing/postgres',
  version: '16.4',
  image: 'postgres:16.4',
  port: 5432,
  host: null,
  group: 'billing',
  target: {
    kind: 'workload',
    namespace: 'billing',
    workload_kind: 'StatefulSet',
    workload: 'postgres',
    port: 5432,
  },
};
const probe = (over: Partial<Probe> = {}): Probe => ({
  id: '01a1c000-0000-7000-8000-0000000000p1',
  status: 'pending',
  method: 'generated',
  username: 'watchlog',
  attempts: 0,
  result: null,
  expiresAt: '2026-11-09T10:15:00.000Z',
  ...over,
});

async function mountWith(component: unknown, props: Record<string, unknown>, role = 'owner') {
  const plugins = await createPlugins('/applications');
  useAuthStore().user = { ...USER, role: role as typeof USER.role };
  const wrapper = mount(component as never, {
    props: props as never,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

describe('access step', () => {
  it('creates the command, polls the probe and checks now (Kubernetes, generated)', async () => {
    const command =
      'kubectl exec -n billing statefulset/postgres -- psql -U postgres -c "CREATE ROLE watchlog LOGIN PASSWORD \'wl_mon_x\'"';
    const { calls } = mockFetch({
      'POST /api/v1/applications/probes': { status: 201, body: { probe: probe(), command } },
      [`GET /api/v1/applications/probes/${probe().id}`]: [
        {
          status: 200,
          body: {
            probe: probe({
              attempts: 2,
              result: {
                ok: false,
                error: 'role "watchlog" does not exist',
                version: null,
                facts: {},
                excess: [],
              },
            }),
          },
        },
        {
          status: 200,
          body: {
            probe: probe({
              status: 'ok',
              attempts: 3,
              result: {
                ok: true,
                error: null,
                version: '16.4',
                facts: { databases: 3 },
                excess: ['superuser'],
              },
            }),
          },
        },
      ],
      [`POST /api/v1/applications/probes/${probe().id}/check`]: {
        status: 200,
        body: { probe: probe({ attempts: 2 }) },
      },
    });
    const w = await mountWith(AccessStep, { service: PG });
    // PostgreSQL needs a user: no "nothing to set up", the generated user first.
    expect(w.findAll('[data-access]').map((o) => o.attributes('data-access'))).toEqual([
      'generated',
      'entered',
      'reference',
    ]);
    expect(calls).toHaveLength(0);
    vi.useFakeTimers();
    await w.get('[data-testid="access-start"]').trigger('click');
    await flushPromises();
    expect(calls[0]!.body).toMatchObject({ access: { method: 'generated' } });
    expect(w.get('[data-testid="access-command"]').text()).toContain('CREATE ROLE watchlog');
    expect(w.get('[data-testid="probe-status"]').text()).toContain('Trying to connect');

    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    expect(w.get('[data-testid="probe-status"]').text()).toContain(
      'role "watchlog" does not exist (try 2)',
    );
    await w.get('[data-testid="check-now"]').trigger('click');
    await flushPromises();
    expect(calls.map((c) => c.path)).toContain(`/api/v1/applications/probes/${probe().id}/check`);
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    const status = w.get('[data-testid="probe-status"]');
    expect(status.attributes('data-status')).toBe('ok');
    expect(status.text()).toContain('Connected: PostgreSQL 16.4 · databases 3');
    expect(w.get('[data-testid="excess"]').text()).toContain('superuser');
    expect(w.find('[data-testid="check-now"]').exists()).toBe(false);
    const events = w.emitted('probe')!;
    expect((events.at(-1)![0] as Probe).status).toBe('ok');
    w.unmount();
  });

  it('sends an existing user, and references a Secret or a file', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/applications/probes': [
        { status: 201, body: { probe: probe({ method: 'entered', username: 'ops' }) } },
        {
          status: 201,
          body: {
            probe: probe({ method: 'reference' }),
            commands: [
              'kubectl create role watchlog-read-billing-db -n watchlog …',
              'kubectl create rolebinding …',
            ],
          },
        },
        // Redis needs nothing by default: the step tests that when it opens.
        { status: 201, body: { probe: probe({ method: 'none', status: 'ok' }) } },
        {
          status: 201,
          body: {
            probe: probe({ method: 'reference' }),
            commands: ['sudo install -d -m 0700 /etc/watchlog/secrets'],
            mount: '-v /etc/watchlog/secrets:/etc/watchlog/secrets:ro',
          },
        },
      ],
    });
    const w = await mountWith(AccessStep, { service: PG });
    await w.get('[data-access="entered"] input').setValue(true);
    await w.get('[data-access="entered"] input').trigger('change');
    const inputs = w.findAll('input:not([type="radio"])');
    await inputs[0]!.setValue('ops');
    await inputs[1]!.setValue('s3cret-value');
    await w.get('[data-testid="access-start"]').trigger('click');
    await flushPromises();
    expect(calls[0]!.body).toMatchObject({
      access: { method: 'entered', username: 'ops', password: 's3cret-value' },
    });
    // The password isn't kept in the form once sent.
    expect(
      (w.findAll('input[type="password"]')[0]?.element as HTMLInputElement | undefined)?.value ??
        '',
    ).toBe('');

    await w.get('[data-access="reference"] input').trigger('change');
    const ref = w.findAll('input:not([type="radio"])');
    await ref[1]!.setValue('billing-db');
    await w.get('[data-testid="access-start"]').trigger('click');
    await flushPromises();
    expect(calls[1]!.body).toMatchObject({
      access: { method: 'reference', secret: { name: 'billing-db', key: 'password' } },
    });
    expect(w.get('[data-testid="access-commands"]').text()).toContain(
      'Let the collector read that one Secret',
    );
    w.unmount();

    const docker = await mountWith(AccessStep, {
      service: {
        ...PG,
        cluster: DOCKER,
        type: 'redis',
        target: { kind: 'container', host: 'docker-01', container: 'cache', port: 6379 },
      },
    });
    await docker.get('[data-access="reference"] input').trigger('change');
    const f = docker.findAll('input:not([type="radio"])');
    expect(docker.text()).toContain('file under /etc/watchlog/secrets');
    await f[1]!.setValue('cache-redis');
    await docker.get('[data-testid="access-start"]').trigger('click');
    await flushPromises();
    expect(calls.at(-1)!.body).toMatchObject({
      access: { method: 'reference', file: 'cache-redis' },
    });
    expect(docker.get('[data-testid="access-commands"]').text()).toContain(
      '/etc/watchlog/secrets:ro',
    );
    docker.unmount();
  });
});

const APP: Application = {
  id: '01a1c000-0000-7000-8000-0000000000aa',
  type: 'postgres',
  name: 'billing/postgres',
  version: '16.4',
  cluster: K8S,
  where: { group: 'billing', host: null, address: null },
  target: PG.target,
  health: 'ok',
  reason: { code: 'connected', facts: { up: 1, members: 1 } },
  members: { up: 1, total: 1 },
  monitoredSince: '2026-11-09T10:00:00.000Z',
  lastReportAt: '2026-11-09T10:01:00.000Z',
};
const ACCESS = {
  access: {
    method: 'generated',
    username: 'watchlog',
    reference: null,
    setBy: 'Ada Admin',
    setAt: '2026-11-09T10:00:00.000Z',
    verifiedAt: '2026-11-09T10:01:00.000Z',
  },
  settings: { queryText: true, paused: false },
  events: [
    { action: 'verified', user: null, at: '2026-11-09T10:01:00.000Z', details: {} },
    {
      action: 'credential_set',
      user: 'Ada Admin',
      ip: '10.0.0.4',
      at: '2026-11-09T10:00:00.000Z',
      details: {},
    },
  ],
};

describe('settings drawer', () => {
  it('shows Owners the access, switches and log, and saves a new access', async () => {
    const { calls } = mockFetch({
      [`GET /api/v1/applications/${APP.id}/access`]: { status: 200, body: ACCESS },
      [`PATCH /api/v1/applications/${APP.id}`]: { status: 204 },
      'POST /api/v1/applications/probes': {
        status: 201,
        body: { probe: probe({ status: 'ok' }), command: 'x' },
      },
      [`PUT /api/v1/applications/${APP.id}/access`]: { status: 204 },
    });
    const w = await mountWith(SettingsDrawer, { app: APP, open: true });
    const drawer = document.body.querySelector('[data-testid="settings-drawer"]')!;
    expect(drawer.querySelector('[data-testid="access-summary"]')!.textContent).toContain(
      'A user WatchLog created (watchlog)',
    );
    expect(drawer.querySelector('[data-testid="access-summary"]')!.textContent).toContain(
      'set by Ada Admin',
    );
    expect(drawer.querySelector('[data-testid="events"]')!.textContent).toContain('10.0.0.4');
    (drawer.querySelector('[data-testid="paused"] input') as HTMLInputElement).click();
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ paused: true });

    (drawer.querySelector('[data-testid="change-access"]') as HTMLButtonElement).click();
    await flushPromises();
    (document.body.querySelector('[data-testid="access-start"]') as HTMLButtonElement).click();
    await flushPromises();
    (document.body.querySelector('[data-testid="save-access"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ probeId: probe().id });
    expect(calls.find((c) => c.path === '/api/v1/applications/probes')!.body).toMatchObject({
      integrationId: APP.id,
    });
    w.unmount();
  });

  it('lets Viewers read, without changing anything', async () => {
    const noIp = { ...ACCESS.events[1]! };
    delete noIp.ip;
    mockFetch({
      [`GET /api/v1/applications/${APP.id}/access`]: {
        status: 200,
        body: { ...ACCESS, events: [ACCESS.events[0], noIp] },
      },
    });
    const w = await mountWith(SettingsDrawer, { app: APP, open: true }, 'viewer');
    const drawer = document.body.querySelector('[data-testid="settings-drawer"]')!;
    expect(drawer.textContent).toContain('last verified');
    for (const id of ['change-access', 'remove-access', 'paused', 'remove-service']) {
      expect(drawer.querySelector(`[data-testid="${id}"]`), id).toBeNull();
    }
    w.unmount();
  });
});

describe('add manually', () => {
  it('needs the Docker host on a fleet, and hands an address target on', async () => {
    mockFetch({
      'GET /api/v1/clusters': {
        status: 200,
        body: {
          clusters: [
            { ...DOCKER, status: 'active', nodeCount: 1, lastSeenAt: null, ingestFailure: null },
          ],
        },
      },
    });
    const w = await mountWith(AddServiceDialog, { open: true });
    await useClustersStore().ensure();
    useClustersStore().select(DOCKER.id);
    await flushPromises();
    const form = w.findComponent({ name: 'ModalDialog' });
    expect(form.exists()).toBe(true);
    const fields = () => [
      ...document.body.querySelectorAll<HTMLInputElement>(
        '[data-testid="add-service"] input:not([role="combobox"])',
      ),
    ];
    // The cluster defaults to the selected one; type to PostgreSQL.
    const cont = () =>
      document.body.querySelector('[data-testid="add-continue"]') as HTMLButtonElement;
    fields()[0]!.value = 'db.internal:5432';
    fields()[0]!.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(cont().disabled).toBe(true); // no host yet
    fields()[1]!.value = 'docker-01';
    fields()[1]!.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(cont().disabled).toBe(false);
    cont().click();
    await flushPromises();
    expect(w.emitted('connect')![0]![0]).toMatchObject({
      cluster: { id: DOCKER.id, kind: 'docker' },
      type: 'postgres',
      name: 'db.internal:5432',
      target: { kind: 'address', address: 'db.internal:5432' },
      collectorHost: 'docker-01',
    });
    w.unmount();
  });
});
