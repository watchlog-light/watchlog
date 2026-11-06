// SPDX-License-Identifier: AGPL-3.0-only
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import StatusPill from '@/components/ui/StatusPill.vue';
import { useAuthStore } from '@/stores/auth';
import ClusterSettingsPage from '@/views/ClusterSettingsPage.vue';
import SettingsPage from '@/views/SettingsPage.vue';
import { mockFetch, problem, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const CLUSTER_ID = '01a18f0e-a6c2-71ef-a7b4-42d765746d50';
const TOKEN = `wl_ct_${'x'.repeat(43)}`;
const CLUSTER = {
  id: CLUSTER_ID,
  name: 'production',
  kind: 'docker' as const,
  status: 'pending' as const,
  nodeCount: 0,
  agentVersion: null,
  firstSeenAt: null,
  lastSeenAt: null,
  createdAt: '2026-10-31T10:00:00.000Z',
  ingestFailure: null,
};
const ISSUED = {
  token: {
    id: '01a18f0e-a6c2-71ef-a7b4-42d765746d60',
    prefix: 'xxxxxxxx',
    value: TOKEN,
    createdAt: CLUSTER.createdAt,
  },
  install: { dockerRun: `docker run -d ... -e WATCHLOG_TOKEN=${TOKEN} ...` },
};

afterEach(() => vi.unstubAllGlobals());

async function mountAs(component: typeof SettingsPage, path: string, role = USER.role as string) {
  const plugins = await createPlugins(path);
  useAuthStore().user = { ...USER, role: role as typeof USER.role };
  const wrapper = mount(component, {
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  await flushPromises();
  return wrapper;
}

describe('CodeBlock', () => {
  it('copies the code and confirms', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { router, i18n, pinia } = await createPlugins();
    const wrapper = mount(CodeBlock, {
      props: { code: 'docker run x', label: 'Install' },
      global: { plugins: [router, i18n, pinia] },
    });
    await wrapper.get('[data-testid="copy"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('docker run x');
    expect(wrapper.get('[data-testid="copy"]').text()).toBe('Copied');
  });

  it('tells the user when copying is not possible', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const { router, i18n, pinia } = await createPlugins();
    const wrapper = mount(CodeBlock, {
      props: { code: 'x', label: 'Install' },
      global: { plugins: [router, i18n, pinia] },
    });
    await wrapper.get('[data-testid="copy"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Copy failed');
  });
});

describe('StatusPill', () => {
  it.each([
    ['active', 'Connected'],
    ['pending', 'Waiting for agent'],
    ['inactive', 'Not reporting'],
  ] as const)('%s shows an icon and the label "%s"', async (status, label) => {
    const { router, i18n, pinia } = await createPlugins();
    const wrapper = mount(StatusPill, {
      props: { status },
      global: { plugins: [router, i18n, pinia] },
    });
    expect(wrapper.text()).toBe(label);
    expect(wrapper.find('svg').exists()).toBe(true);
  });
});

describe('Settings → Clusters', () => {
  it('creates a Kubernetes cluster and shows the helm command', async () => {
    const k8s = { ...CLUSTER, name: 'kind', kind: 'kubernetes' as const };
    const helm = `helm install watchlog-agent deploy/helm/watchlog-agent \\\n  --set watchlog.clusterToken=${TOKEN}`;
    const { calls } = mockFetch({
      'GET /api/v1/clusters': [
        { status: 200, body: { clusters: [] } },
        { status: 200, body: { clusters: [k8s] } },
      ],
      'POST /api/v1/clusters': {
        status: 201,
        body: { cluster: k8s, token: ISSUED.token, install: { helm } },
      },
    });
    const wrapper = await mountAs(SettingsPage, '/settings');
    await wrapper.get('[data-testid="add-first-cluster"]').trigger('click');
    await wrapper.get('[data-testid="kind-choice"] input[value="kubernetes"]').setValue(true);
    await wrapper.get('[data-testid="create-form"] input[type="text"]').setValue('kind');
    await wrapper.get('[data-testid="create-form"]').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      name: 'kind',
      kind: 'kubernetes',
    });
    const reveal = wrapper.get('[data-testid="token-reveal"]');
    expect(reveal.text()).toContain('helm install watchlog-agent');
    expect(reveal.text()).toContain('where helm reaches the cluster');
    expect(wrapper.get('[data-testid="cluster-list"]').text()).toContain('Kubernetes cluster');
    expect(wrapper.get('[data-testid="cluster-list"]').text()).toContain('no nodes yet');
  });

  it('creates the first Docker fleet and shows the token and command once', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/clusters': [
        { status: 200, body: { clusters: [] } },
        { status: 200, body: { clusters: [CLUSTER] } },
      ],
      'POST /api/v1/clusters': { status: 201, body: { cluster: CLUSTER, ...ISSUED } },
    });
    const wrapper = await mountAs(SettingsPage, '/settings');
    expect(wrapper.text()).toContain('No cluster or Docker fleet yet');

    await wrapper.get('[data-testid="add-first-cluster"]').trigger('click');
    await wrapper.get('[data-testid="create-form"] input[type="text"]').setValue('production');
    await wrapper.get('[data-testid="create-form"]').trigger('submit');
    await flushPromises();

    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      name: 'production',
      kind: 'docker',
    });
    const reveal = wrapper.get('[data-testid="token-reveal"]');
    expect(reveal.text()).toContain('shown only once');
    expect(reveal.text()).toContain(ISSUED.install.dockerRun!);
    expect(reveal.text()).toContain(TOKEN);
    expect(wrapper.get('[data-testid="cluster-list"]').text()).toContain('production');
    expect(wrapper.get('[data-testid="cluster-list"]').text()).toContain('Waiting for agent');

    await reveal.findAll('button').at(-1)!.trigger('click');
    expect(wrapper.find('[data-testid="token-reveal"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain(TOKEN);
  });

  it('explains the Community one-fleet limit', async () => {
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [CLUSTER] } },
      'POST /api/v1/clusters': {
        status: 409,
        body: { type: 'urn:watchlog:problem:cluster-limit', title: 'Conflict', status: 409 },
      },
    });
    const wrapper = await mountAs(SettingsPage, '/settings');
    await wrapper.get('[data-testid="add-cluster"]').trigger('click');
    await wrapper.get('[data-testid="create-form"] input').setValue('staging');
    await wrapper.get('[data-testid="create-form"]').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('supports one cluster or Docker fleet');
  });

  it('shows a duplicate-name message', async () => {
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [] } },
      'POST /api/v1/clusters': {
        status: 409,
        body: { type: 'urn:watchlog:problem:name-taken', title: 'Conflict', status: 409 },
      },
    });
    const wrapper = await mountAs(SettingsPage, '/settings');
    await wrapper.get('[data-testid="add-first-cluster"]').trigger('click');
    await wrapper.get('[data-testid="create-form"]').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('already exists');
  });

  it('does not offer creation to viewers', async () => {
    mockFetch({ 'GET /api/v1/clusters': { status: 200, body: { clusters: [] } } });
    const wrapper = await mountAs(SettingsPage, '/settings', 'viewer');
    expect(wrapper.find('[data-testid="add-first-cluster"]').exists()).toBe(false);
  });
});

describe('Cluster settings page', () => {
  const ACTIVE_TOKEN = {
    id: '01a18f0e-a6c2-71ef-a7b4-42d765746d61',
    prefix: 'abcd1234',
    createdAt: CLUSTER.createdAt,
    revokedAt: null,
  };
  const detail = (tokens: object[]) => ({ status: 200, body: { cluster: CLUSTER, tokens } });

  it('rotates: issues a new token with a rotation hint', async () => {
    mockFetch({
      [`GET /api/v1/clusters/${CLUSTER_ID}`]: [
        detail([ACTIVE_TOKEN]),
        detail([ISSUED.token, ACTIVE_TOKEN]),
      ],
      [`POST /api/v1/clusters/${CLUSTER_ID}/tokens`]: { status: 201, body: ISSUED },
    });
    const wrapper = await mountAs(ClusterSettingsPage, `/settings/clusters/${CLUSTER_ID}`);
    expect(wrapper.get('[data-testid="token-list"]').text()).toContain('wl_ct_abcd1234…');

    await wrapper.get('[data-testid="issue-token"]').trigger('click');
    await flushPromises();
    const reveal = wrapper.get('[data-testid="token-reveal"]');
    expect(reveal.text()).toContain(TOKEN);
    expect(reveal.text()).toContain('then revoke the old token');
  });

  it('revokes in two steps', async () => {
    const { calls } = mockFetch({
      [`GET /api/v1/clusters/${CLUSTER_ID}`]: [
        detail([ACTIVE_TOKEN]),
        detail([{ ...ACTIVE_TOKEN, revokedAt: '2026-10-31T11:00:00.000Z' }]),
      ],
      [`DELETE /api/v1/clusters/${CLUSTER_ID}/tokens/${ACTIVE_TOKEN.id}`]: { status: 204 },
    });
    const wrapper = await mountAs(ClusterSettingsPage, `/settings/clusters/${CLUSTER_ID}`);
    await wrapper.get('[data-testid="revoke"]').trigger('click');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    await wrapper.get('[data-testid="confirm-revoke"]').trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(wrapper.get('[data-testid="token-list"]').text()).toContain('Revoked');
  });

  it('shows the token limit message', async () => {
    mockFetch({
      [`GET /api/v1/clusters/${CLUSTER_ID}`]: detail([ACTIVE_TOKEN]),
      [`POST /api/v1/clusters/${CLUSTER_ID}/tokens`]: {
        status: 409,
        body: { type: 'urn:watchlog:problem:token-limit', title: 'Conflict', status: 409 },
      },
    });
    const wrapper = await mountAs(ClusterSettingsPage, `/settings/clusters/${CLUSTER_ID}`);
    await wrapper.get('[data-testid="issue-token"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('5 active tokens');
  });

  it('handles an unknown cluster', async () => {
    mockFetch({ [`GET /api/v1/clusters/${CLUSTER_ID}`]: problem(404, 'Cluster not found') });
    const wrapper = await mountAs(ClusterSettingsPage, `/settings/clusters/${CLUSTER_ID}`);
    expect(wrapper.text()).toContain('does not exist');
  });
});

describe('Ingest failing (ADR-117)', () => {
  const FAILING = {
    ...CLUSTER,
    status: 'active' as const,
    ingestFailure: {
      since: '2026-11-06T09:00:00.000Z',
      lastErrorAt: '2026-11-06T09:20:00.000Z',
      endpoints: [
        { endpoint: 'objects' as const, status: 500, message: 'internal error', failures: 240 },
      ],
    },
  };

  it('says so in the cluster list', async () => {
    mockFetch({
      'GET /api/v1/clusters': {
        status: 200,
        body: { clusters: [FAILING, { ...CLUSTER, id: 'ok', name: 'staging' }] },
      },
    });
    const wrapper = await mountAs(SettingsPage, '/settings');
    const marks = wrapper.findAll('[data-testid="cluster-ingest-failing"]');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.text()).toMatch(/^Ingest failing since /);
  });

  it('shows the banner with each failing endpoint on the cluster page', async () => {
    mockFetch({
      [`GET /api/v1/clusters/${CLUSTER_ID}`]: {
        status: 200,
        body: { cluster: FAILING, tokens: [] },
      },
    });
    const wrapper = await mountAs(ClusterSettingsPage, `/settings/clusters/${CLUSTER_ID}`);
    const banner = wrapper.get('[data-testid="ingest-failing"]');
    expect(banner.attributes('role')).toBe('alert');
    expect(banner.text()).toContain('Data delayed: ingest failing since');
    expect(wrapper.get('[data-testid="ingest-endpoint"]').text()).toBe(
      'Kubernetes objects and Docker inventory — HTTP 500: internal error',
    );
  });

  it('shows nothing while ingest works', async () => {
    mockFetch({
      [`GET /api/v1/clusters/${CLUSTER_ID}`]: {
        status: 200,
        body: { cluster: CLUSTER, tokens: [] },
      },
    });
    const wrapper = await mountAs(ClusterSettingsPage, `/settings/clusters/${CLUSTER_ID}`);
    expect(wrapper.find('[data-testid="ingest-failing"]').exists()).toBe(false);
  });
});
