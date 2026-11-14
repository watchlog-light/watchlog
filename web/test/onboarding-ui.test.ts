// SPDX-License-Identifier: AGPL-3.0-only
// Onboarding (ADR-176, Cloud slice 3): the live checklist from the event stream (and its
// polling fallback), the wizard's states (choose, install with its tabs, ready, the
// troubleshooting after 2 minutes, a reload without the token), the first-week card, and
// Community's "Add cluster" with the checklist under the command.
import type { OnboardingStatus } from '@watchlog/api-types';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import type { CloudConfig } from '@/api/cloud';
import ClusterList from '@/components/clusters/ClusterList.vue';
import FirstWeekCard from '@/components/onboarding/FirstWeekCard.vue';
import LiveChecklist from '@/components/onboarding/LiveChecklist.vue';
import { POLL_MS, useOnboardingStatus } from '@/composables/useOnboardingStatus';
import { useAuthStore } from '@/stores/auth';
import OnboardingPage from '@/views/OnboardingPage.vue';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const ID = '01a1c446-a818-76d4-b058-f1b1aa7dc501';
const CONFIG: CloudConfig = {
  signup: true,
  signupMode: 'public',
  providers: { github: false, google: false },
  turnstileSiteKey: null,
  passwordMinLength: 10,
  verifyGraceDays: 7,
  supportEmail: 'support@watchlog.io',
  sampleUrl: 'https://demo.watchlog.io',
};
const CLOUD_USER = { ...USER, org: { ...USER.org, slug: 'acme', plan: 'free' as const } };

/** EventSource as the page uses it: named events, close, onerror. */
class FakeEventSource {
  static all: FakeEventSource[] = [];
  listeners: Record<string, ((e: { data: string }) => void)[]> = {};
  onerror: (() => void) | null = null;
  closed = false;
  constructor(
    public url: string,
    public init?: { withCredentials?: boolean },
  ) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) });
  }
  close() {
    this.closed = true;
  }
}
const lastSource = () => FakeEventSource.all.at(-1)!;

function status(
  kind: 'kubernetes' | 'docker',
  done: string[],
  extra: Partial<OnboardingStatus> = {},
): OnboardingStatus {
  const ids =
    kind === 'kubernetes'
      ? (['agent', 'clusterAgent', 'metrics', 'ebpf', 'map'] as const)
      : (['agent', 'metrics', 'ebpf', 'map'] as const);
  return {
    clusterId: ID,
    kind,
    createdAt: new Date().toISOString(),
    now: new Date().toISOString(),
    steps: ids.map((id) => ({
      id,
      state: done.includes(id) ? 'done' : 'waiting',
      since: null,
      nodes: 3,
      containers: 41,
      enabled: 3,
      agents: 3,
      services: 14,
      connections: 22,
    })),
    ready: done.includes('metrics'),
    complete: done.length === ids.length,
    ...extra,
  };
}

beforeEach(() => {
  FakeEventSource.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mountWith(component: unknown, path: string, cloud = true, props = {}) {
  const plugins = await createPlugins(path);
  const auth = useAuthStore();
  auth.cloud = cloud ? CONFIG : null;
  auth.loaded = true;
  auth.user = cloud ? CLOUD_USER : USER;
  if (cloud) {
    auth.account = {
      email: 'sara@acme.dev',
      emailVerified: true,
      verifyBy: null,
      restriction: null,
      password: true,
      mfa: { enabled: false, required: false, recoveryCodesLeft: 0 },
      identities: [],
    };
  }
  const wrapper = mount(component as never, {
    props: props as never,
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  await flushPromises();
  return { wrapper, router: plugins.router };
}

describe('useOnboardingStatus', () => {
  const Probe = defineComponent({
    props: { id: { type: String, default: null } },
    setup(props) {
      const r = useOnboardingStatus(ref(props.id));
      return () => h('pre', { 'data-mode': r.mode.value }, JSON.stringify(r.status.value));
    },
  });

  it('follows the event stream, and stops when it ends complete', async () => {
    const { wrapper } = await mountWith(Probe, '/', true, { id: ID });
    const es = lastSource();
    expect(es.url).toBe(`/api/v1/clusters/${ID}/onboarding-status`);
    expect(es.init?.withCredentials).toBe(true);
    es.emit('status', status('kubernetes', ['agent']));
    await flushPromises();
    expect(wrapper.get('pre').attributes('data-mode')).toBe('stream');
    expect(wrapper.text()).toContain('"agent"');
    es.emit('end', { reason: 'complete' });
    expect(es.closed).toBe(true);
    expect(FakeEventSource.all).toHaveLength(1);
  });

  it('opens the stream again after its time limit', async () => {
    await mountWith(Probe, '/', true, { id: ID });
    lastSource().emit('end', { reason: 'limit' });
    expect(FakeEventSource.all).toHaveLength(2);
  });

  it('polls the JSON route when the stream fails before any event', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = mockFetch({
      [`GET /api/v1/clusters/${ID}/onboarding-status`]: [
        { status: 200, body: status('docker', []) },
        { status: 200, body: status('docker', ['agent', 'metrics', 'ebpf', 'map']) },
      ],
    });
    const { wrapper } = await mountWith(Probe, '/', true, { id: ID });
    lastSource().onerror!();
    await flushPromises();
    expect(lastSource().closed).toBe(true);
    expect(wrapper.get('pre').attributes('data-mode')).toBe('poll');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushPromises();
    expect(calls).toHaveLength(2);
    expect(wrapper.text()).toContain('"complete":true');
    // Complete: no third poll.
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(calls).toHaveLength(2);
  });
});

describe('the live checklist', () => {
  it('spins on the first waiting step and says each done step in plain words', async () => {
    const { wrapper } = await mountWith(LiveChecklist, '/', true, {
      status: status('kubernetes', ['agent', 'clusterAgent']),
      kind: 'kubernetes',
    });
    const state = (id: string) => wrapper.get(`[data-testid="check-${id}"]`);
    expect(state('agent').attributes('data-state')).toBe('done');
    expect(state('agent').text()).toContain('on 3 nodes');
    expect(state('clusterAgent').text()).toContain('Watching the Kubernetes API');
    expect(state('metrics').text()).toContain('Waiting for the first metrics');
    expect(state('metrics').find('.animate-spin').exists()).toBe(true);
    expect(state('map').text()).toContain('After about 2 minutes of traffic');
  });

  it('Docker: hosts, no cluster agent; eBPF off says why and how to fix it', async () => {
    const s = status('docker', ['agent', 'metrics']);
    s.steps[2] = {
      id: 'ebpf',
      state: 'off',
      since: null,
      enabled: 0,
      agents: 1,
      node: 'host-1',
      reason: 'kernel 4.19 has no BTF',
      cause: 'kernel',
      fix: null,
    };
    s.steps[3] = { id: 'map', state: 'off', since: null, services: 0, connections: 0 };
    const { wrapper } = await mountWith(LiveChecklist, '/', true, { status: s, kind: 'docker' });
    expect(wrapper.find('[data-testid="check-clusterAgent"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="check-agent"]').text()).toContain('on 3 hosts');
    expect(wrapper.get('[data-testid="check-metrics"]').text()).toContain('3 hosts, 41 containers');
    expect(wrapper.get('[data-testid="check-ebpf"]').text()).toContain(
      'Off on host-1: kernel 4.19 has no BTF',
    );
    expect(wrapper.get('[data-testid="check-map"]').text()).toContain('connections need eBPF');
    expect(wrapper.find('[data-testid="ebpf-fix"]').exists()).toBe(false);
  });
});

describe('the wizard', () => {
  const created = (kind: 'kubernetes' | 'docker') => ({
    cluster: {
      id: ID,
      name: kind === 'docker' ? 'acme-hosts' : 'acme-prod',
      kind,
      status: 'pending',
      nodeCount: 0,
      agentVersion: null,
      firstSeenAt: null,
      lastSeenAt: null,
      createdAt: new Date().toISOString(),
      ingestFailure: null,
    },
    token: { id: ID, prefix: 'abcd1234', value: 'wl_ct_secret', createdAt: '' },
    install:
      kind === 'docker'
        ? {
            dockerRun: 'docker run … WATCHLOG_ENDPOINT=https://ingest.watchlog.io',
            compose: 'services: …',
          }
        : {
            helm: 'helm install … --set watchlog.endpoint=https://ingest.watchlog.io',
            kubectl: "kubectl apply -f 'https://ingest.watchlog.io/install.yaml?code=wl_ic_x'",
          },
  });

  it('chooses, names, creates, then installs with the live checklist', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/clusters': { status: 201, body: created('kubernetes') },
      'GET /api/v1/clusters': { status: 200, body: { clusters: [created('kubernetes').cluster] } },
      'POST /api/v1/funnel': { status: 204 },
      'GET /api/v1/alert-channels': { status: 200, body: { channels: [] } },
    });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { wrapper, router } = await mountWith(OnboardingPage, '/onboarding');
    expect(wrapper.find('[data-testid="wizard-choose"]').exists()).toBe(true);
    const name = wrapper.get('[data-testid="cluster-name"] input');
    expect((name.element as HTMLInputElement).value).toBe('acme-prod');
    await wrapper.get('[data-testid="kind-docker"] input').setValue(true);
    expect((name.element as HTMLInputElement).value).toBe('acme-hosts');
    await wrapper.get('[data-testid="kind-kubernetes"] input').setValue(true);
    expect(wrapper.get('[data-testid="sample-link"]').attributes()).toMatchObject({
      href: 'https://demo.watchlog.io',
      target: '_blank',
    });

    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/clusters',
      body: { name: 'acme-prod', kind: 'kubernetes' },
    });
    expect(router.currentRoute.value.query.id).toBe(ID);
    expect(wrapper.find('[data-testid="wizard-install"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="install-command"]').text()).toContain('helm install');
    expect(wrapper.get('[data-testid="wizard-context"]').text()).toBe(
      'acme-prod · Kubernetes cluster',
    );

    // Tabs: arrows move between Helm and kubectl.
    await wrapper.get('[data-testid="tab-helm"]').trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.get('[data-testid="tab-kubectl"]').attributes('aria-selected')).toBe('true');
    expect(wrapper.get('[data-testid="install-command"]').text()).toContain('install.yaml?code=');
    await wrapper.get('[data-testid="copy-command"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(created('kubernetes').install.kubectl);
    expect(calls.find((c) => c.path === '/api/v1/funnel')?.body).toEqual({
      name: 'install_command_copied',
      props: { method: 'kubectl', kind: 'kubernetes' },
    });

    // Waiting, then the first metrics: "Open dashboard" turns primary and pulses.
    expect(wrapper.find('[data-testid="waiting-agent"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="open-dashboard"]').exists()).toBe(false);
    lastSource().emit('status', status('kubernetes', ['agent', 'clusterAgent', 'metrics']));
    await flushPromises();
    const open = wrapper.get('[data-testid="open-dashboard"]');
    expect(open.classes()).toContain('pulse-twice');
    expect(wrapper.find('[data-testid="waiting-agent"]').exists()).toBe(false);
    // Step 3: alert channels, email prefilled with the verified address.
    expect(wrapper.find('[data-testid="wizard-alerts"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="channel-email"]').text()).toContain(
      'sara@acme.dev · already verified',
    );
    await wrapper.get('[data-testid="channel-email"]').trigger('click');
    expect(
      (wrapper.get('[data-testid="add-email-form"] input').element as HTMLInputElement).value,
    ).toBe('sara@acme.dev');
  });

  describe('back from the install step', () => {
    async function toInstall(kind: 'kubernetes' | 'docker' = 'kubernetes', more = {}) {
      const mock = mockFetch({
        'POST /api/v1/clusters': [{ status: 201, body: created(kind) }],
        'GET /api/v1/clusters': { status: 200, body: { clusters: [created(kind).cluster] } },
        'POST /api/v1/funnel': { status: 204 },
        ...more,
      });
      const mounted = await mountWith(OnboardingPage, '/onboarding');
      if (kind === 'docker')
        await mounted.wrapper.get('[data-testid="kind-docker"] input').setValue(true);
      await mounted.wrapper.get('form').trigger('submit');
      await flushPromises();
      expect(mounted.wrapper.find('[data-testid="wizard-install"]').exists()).toBe(true);
      return { ...mounted, ...mock };
    }
    const input = (w: Awaited<ReturnType<typeof toInstall>>['wrapper']) =>
      w.get('[data-testid="cluster-name"] input');

    it('goes back prefilled, and returns to the same command when nothing changed', async () => {
      const { wrapper, router, calls } = await toInstall();
      await wrapper.get('[data-testid="wizard-back"]').trigger('click');
      await flushPromises();
      expect(wrapper.find('[data-testid="wizard-choose"]').exists()).toBe(true);
      expect(router.currentRoute.value.query.id).toBeUndefined();
      expect((input(wrapper).element as HTMLInputElement).value).toBe('acme-prod');
      expect(
        (wrapper.get('[data-testid="kind-kubernetes"] input').element as HTMLInputElement).checked,
      ).toBe(true);
      expect(wrapper.get('[data-testid="wizard-changing"]').text()).toContain('acme-prod');
      await wrapper.get('form').trigger('submit');
      await flushPromises();
      expect(router.currentRoute.value.query.id).toBe(ID);
      expect(wrapper.get('[data-testid="install-command"]').text()).toContain('helm install');
      expect(calls.filter((c) => c.method !== 'GET' && c.path !== '/api/v1/funnel')).toHaveLength(
        1,
      );
    });

    it('a new name renames the empty cluster and keeps its command', async () => {
      const renamed = { cluster: { ...created('kubernetes').cluster, name: 'shop-prod' } };
      const { wrapper, router, calls } = await toInstall('kubernetes', {
        [`PATCH /api/v1/clusters/${ID}`]: { status: 200, body: renamed },
      });
      await wrapper.get('[data-testid="wizard-back"]').trigger('click');
      await flushPromises();
      await input(wrapper).setValue('shop-prod');
      await wrapper.get('form').trigger('submit');
      await flushPromises();
      expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
        path: `/api/v1/clusters/${ID}`,
        body: { name: 'shop-prod' },
      });
      expect(
        calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/clusters'),
      ).toHaveLength(1);
      expect(router.currentRoute.value.query.id).toBe(ID);
      expect(wrapper.get('[data-testid="install-command"]').text()).toContain('helm install');
      expect(wrapper.get('[data-testid="wizard-context"]').text()).toContain('shop-prod');
    });

    it('another type replaces the empty cluster with a new one', async () => {
      const NEW = '01a1c446-a818-76d4-b058-f1b1aa7dc502';
      const docker = created('docker');
      const mock = mockFetch({
        'POST /api/v1/clusters': [
          { status: 201, body: created('kubernetes') },
          { status: 201, body: { ...docker, cluster: { ...docker.cluster, id: NEW } } },
        ],
        'GET /api/v1/clusters': {
          status: 200,
          body: { clusters: [created('kubernetes').cluster] },
        },
        [`DELETE /api/v1/clusters/${ID}`]: { status: 204 },
        'POST /api/v1/funnel': { status: 204 },
      });
      const { wrapper, router } = await mountWith(OnboardingPage, '/onboarding');
      await wrapper.get('form').trigger('submit');
      await flushPromises();
      await wrapper.get('[data-testid="wizard-back"]').trigger('click');
      await flushPromises();
      await wrapper.get('[data-testid="kind-docker"] input').setValue(true);
      // The name was kept (edited counts as the user's), not switched to the Docker suggestion.
      expect((input(wrapper).element as HTMLInputElement).value).toBe('acme-prod');
      await input(wrapper).setValue('acme-hosts');
      await wrapper.get('form').trigger('submit');
      await flushPromises();
      const writes = mock.calls.filter((c) => c.method !== 'GET' && c.path !== '/api/v1/funnel');
      expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /api/v1/clusters',
        `DELETE /api/v1/clusters/${ID}`,
        'POST /api/v1/clusters',
      ]);
      expect(writes[2]!.body).toEqual({ name: 'acme-hosts', kind: 'docker' });
      expect(router.currentRoute.value.query.id).toBe(NEW);
      expect(wrapper.find('[data-testid="tab-dockerRun"]').exists()).toBe(true);
    });

    it("an Admin can't replace it: says so, and nothing is created", async () => {
      const { wrapper, calls } = await toInstall('kubernetes', {
        [`DELETE /api/v1/clusters/${ID}`]: {
          status: 403,
          body: { type: 'about:blank', title: 'Forbidden', status: 403 },
        },
      });
      await wrapper.get('[data-testid="wizard-back"]').trigger('click');
      await flushPromises();
      await wrapper.get('[data-testid="kind-docker"] input').setValue(true);
      await wrapper.get('form').trigger('submit');
      await flushPromises();
      expect(wrapper.text()).toContain('Only an Owner can replace acme-prod with another type');
      expect(
        calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/clusters'),
      ).toHaveLength(1);
      expect(wrapper.find('[data-testid="wizard-choose"]').exists()).toBe(true);
    });

    it('is gone once an agent has connected', async () => {
      const { wrapper } = await toInstall();
      expect(wrapper.find('[data-testid="wizard-back"]').exists()).toBe(true);
      lastSource().emit('status', status('kubernetes', ['agent']));
      await flushPromises();
      expect(wrapper.find('[data-testid="wizard-back"]').exists()).toBe(false);
    });
  });

  it('shows troubleshooting after 2 minutes without a heartbeat, with help by email', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch({
      'POST /api/v1/clusters': { status: 201, body: created('docker') },
      'GET /api/v1/clusters': { status: 200, body: { clusters: [created('docker').cluster] } },
      'POST /api/v1/funnel': { status: 204 },
    });
    const { wrapper } = await mountWith(OnboardingPage, '/onboarding');
    await wrapper.get('[data-testid="kind-docker"] input').setValue(true);
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[data-testid="tab-dockerRun"]').attributes('aria-selected')).toBe('true');
    expect(wrapper.find('[data-testid="tab-compose"]').exists()).toBe(true);
    lastSource().emit('status', status('docker', []));
    await vi.advanceTimersByTimeAsync(119_000);
    expect(wrapper.find('[data-testid="troubleshooting"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(6_000);
    await flushPromises();
    const panel = wrapper.get('[data-testid="troubleshooting"]');
    expect(panel.attributes('open')).toBeDefined();
    expect(panel.text()).toContain('docker logs --tail 50 watchlog-agent');
    expect(panel.text()).toContain('allow connections to ingest.watchlog.io:443');
    expect(panel.text()).not.toContain('PodSecurity');
    const help = decodeURIComponent(
      wrapper.get('[data-testid="help-installing"]').attributes('href')!,
    );
    expect(help).toMatch(/^mailto:support@watchlog\.io\?subject=/);
    expect(help).toContain(`Cluster id: ${ID}`);
  });

  it('after a reload the token is gone: it offers a new command', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [created('kubernetes').cluster] } },
      [`POST /api/v1/clusters/${ID}/tokens`]: {
        status: 201,
        body: { token: created('kubernetes').token, install: created('kubernetes').install },
      },
    });
    const plugins = await createPlugins(`/onboarding?id=${ID}`);
    const auth = useAuthStore();
    auth.cloud = CONFIG;
    auth.loaded = true;
    auth.user = CLOUD_USER;
    const { useClustersStore } = await import('@/stores/clusters');
    await useClustersStore().load();
    const wrapper = mount(OnboardingPage, {
      attachTo: document.body,
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="install-lost"]').exists()).toBe(true);
    await wrapper.get('[data-testid="install-lost"] button').trigger('click');
    await flushPromises();
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `/api/v1/clusters/${ID}/tokens` });
    expect(wrapper.get('[data-testid="install-command"]').text()).toContain('helm install');
  });
});

describe('the first-week card', () => {
  const week = (done: string[], dismissed = false) => ({
    dismissed,
    steps: (['channel', 'teammate', 'application', 'mcp', 'problem'] as const).map((id) => ({
      id,
      done: done.includes(id),
      blocked: id === 'teammate' && !done.includes(id) ? 'plan-limit' : null,
    })),
  });

  it('shows real progress, says Free needs Pro to invite, and hides when dismissed', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/onboarding/first-week': { status: 200, body: week(['channel']) },
      'POST /api/v1/onboarding/first-week/dismiss': { status: 204 },
    });
    const { wrapper } = await mountWith(FirstWeekCard, '/');
    expect(wrapper.get('[data-testid="first-week-count"]').text()).toBe('1 of 5');
    expect(wrapper.get('[data-testid="first-week-channel"]').attributes('data-done')).toBe('true');
    const team = wrapper.get('[data-testid="first-week-teammate"]');
    expect(team.text()).toContain('Pro adds your team');
    expect(team.get('a').attributes('href')).toBe('/settings?tab=billing');
    expect(wrapper.get('[data-testid="first-week-mcp"] a').attributes('href')).toBe(
      '/settings?tab=tokens',
    );
    await wrapper.get('[data-testid="first-week-dismiss"]').trigger('click');
    await flushPromises();
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/v1/onboarding/first-week/dismiss',
    });
    expect(wrapper.find('[data-testid="first-week"]').exists()).toBe(false);
  });

  it('is hidden when every step is done or it was dismissed before', async () => {
    mockFetch({
      'GET /api/v1/onboarding/first-week': [
        { status: 200, body: week(['channel', 'teammate', 'application', 'mcp', 'problem']) },
        { status: 200, body: week([], true) },
      ],
    });
    expect(
      (await mountWith(FirstWeekCard, '/')).wrapper.find('[data-testid="first-week"]').exists(),
    ).toBe(false);
    expect(
      (await mountWith(FirstWeekCard, '/')).wrapper.find('[data-testid="first-week"]').exists(),
    ).toBe(false);
  });
});

describe("Community's Add cluster", () => {
  it('shows the live checklist under the install command', async () => {
    const body = {
      cluster: {
        id: ID,
        name: 'kind',
        kind: 'kubernetes',
        status: 'pending',
        nodeCount: 0,
        agentVersion: null,
        firstSeenAt: null,
        lastSeenAt: null,
        createdAt: '',
        ingestFailure: null,
      },
      token: { id: ID, prefix: 'abcd1234', value: 'wl_ct_secret', createdAt: '' },
      install: { helm: 'helm install …' },
    };
    mockFetch({
      'GET /api/v1/clusters': [
        { status: 200, body: { clusters: [] } },
        { status: 200, body: { clusters: [body.cluster] } },
        { status: 200, body: { clusters: [body.cluster] } },
      ],
      'POST /api/v1/clusters': { status: 201, body },
    });
    const { wrapper } = await mountWith(ClusterList, '/settings', false);
    await wrapper.get('[data-testid="add-first-cluster"]').trigger('click');
    await wrapper.get('[data-testid="kind-choice"] input[value="kubernetes"]').setValue(true);
    await wrapper.get('[data-testid="create-form"]').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-testid="token-reveal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="add-cluster-checklist"]').exists()).toBe(true);
    expect(lastSource().url).toBe(`/api/v1/clusters/${ID}/onboarding-status`);
    lastSource().emit('status', status('kubernetes', ['agent']));
    await flushPromises();
    expect(wrapper.get('[data-testid="check-agent"]').attributes('data-state')).toBe('done');
  });
});
