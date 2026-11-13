// SPDX-License-Identifier: AGPL-3.0-only
// Logs on demand (ADR-167): the Logs panel on the pod and Docker container pages, and the
// Settings switch. Lines are read only on request, error codes become their states, stderr
// is marked in words as well as colour, Copy copies what is shown, and following uses an
// EventSource that is closed when the panel goes away.
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LogsPanel from '@/components/logs/LogsPanel.vue';
import LogsAccess from '@/components/settings/LogsAccess.vue';
import { useAuthStore } from '@/stores/auth';
import { mockFetch, USER, type Routes } from './fetch-mock';
import { createPlugins } from './helpers';

const CLUSTER = '01a18f0e-a6c2-71ef-a7b4-42d765746d50';
const POD_URL = `/api/v1/clusters/${CLUSTER}/pods/logs-e2e/printer/logs`;
const DOCKER_URL = `/api/v1/clusters/${CLUSTER}/docker/hosts/docker-01/containers/logs-e2e-printer/logs`;
const SETTINGS = { 'GET /api/v1/settings/logs': { status: 200, body: { access: 'all' } } };

const answer = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    container: 'main',
    previous: false,
    lines: [
      { ts: '2026-11-13T02:44:18.937338010Z', text: 'tick 3 WLTOKEN-logs-e2e' },
      { ts: '2026-11-13T02:44:18.937339469Z', text: 'connecting with password=*** to db' },
    ],
    redacted: 1,
    truncated: false,
    cut: 0,
    ...over,
  },
});
const refusal = (status: number, code: string) => ({
  status,
  body: { type: 'about:blank', title: 'Error', status, detail: 'refused', code },
});

class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (ev: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? [])
      fn({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
  close() {
    this.closed = true;
  }
}

async function mountPod(routes: Routes, role: 'owner' | 'viewer' = 'owner') {
  mockFetch({ ...SETTINGS, ...routes });
  const { pinia, router, i18n } = await createPlugins('/');
  useAuthStore().user = { ...USER, role };
  const wrapper = mount(LogsPanel, {
    props: {
      kind: 'pod',
      clusterId: CLUSTER,
      namespace: 'logs-e2e',
      pod: 'printer',
      containers: [
        { name: 'main', init: false },
        { name: 'sidecar', init: false },
        { name: 'setup', init: true },
      ],
    },
    global: { plugins: [pinia, router, i18n] },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

async function mountDocker(routes: Routes) {
  mockFetch({ ...SETTINGS, ...routes });
  const { pinia, router, i18n } = await createPlugins('/');
  useAuthStore().user = { ...USER };
  const wrapper = mount(LogsPanel, {
    props: { kind: 'container', clusterId: CLUSTER, host: 'docker-01', name: 'logs-e2e-printer' },
    global: { plugins: [pinia, router, i18n] },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  FakeEventSource.last = null;
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('LogsPanel', () => {
  it('reads nothing until asked, then shows the lines with the redaction note', async () => {
    const w = await mountPod({ [`GET ${POD_URL}?lines=200&container=main`]: answer() });
    expect(w.find('[data-testid="logs-idle"]').exists()).toBe(true);
    expect(w.find('[data-testid="logs-output"]').exists()).toBe(false);
    await w.get('[data-testid="logs-read"]').trigger('submit');
    await flushPromises();
    const lines = w.findAll('[data-testid="log-line"]');
    expect(lines.map((l) => l.text())).toEqual([
      'tick 3 WLTOKEN-logs-e2e',
      'connecting with password=*** to db',
    ]);
    expect(w.get('[data-testid="logs-redacted"]').text()).toBe('1 line redacted');
    expect(w.get('[data-testid="logs-read"]').text()).toContain('Refresh');
    expect(w.get('[data-testid="logs-panel"]').text()).toContain('never stored');
  });

  it('lists init containers last, marked, and reads the picked one and its previous run', async () => {
    const w = await mountPod({
      [`GET ${POD_URL}?lines=200&container=main`]: answer(),
      [`GET ${POD_URL}?lines=500&container=sidecar`]: answer({ container: 'sidecar' }),
      [`GET ${POD_URL}?lines=500&container=sidecar&previous=true`]: answer({
        container: 'sidecar',
        previous: true,
      }),
    });
    const options = w.findAll('[data-testid="logs-container"] option').map((o) => o.text());
    expect(options).toEqual(['main', 'sidecar', 'setup (init)']);
    await w.get('[data-testid="logs-read"]').trigger('submit');
    await flushPromises();
    await w.get('[data-testid="logs-lines"]').setValue('500');
    await w.get('[data-testid="logs-container"]').setValue('sidecar');
    await flushPromises();
    await w.get('[data-testid="logs-previous"] input').setValue(true);
    await flushPromises();
    expect(w.findAll('[data-testid="log-line"]')).toHaveLength(2);
  });

  it.each([
    [403, 'logs_off', 'turned off in Settings'],
    [403, 'logs_admins_only', 'Only Owners and Admins'],
    [409, 'logs_disabled', 'turned off for this cluster or host'],
    [422, 'container_not_found', 'no such container'],
    [422, 'no_previous_run', 'no previous run'],
    [422, 'driver_unsupported', 'log driver'],
    [429, 'rate_limited', 'Too many log reads'],
    [504, 'no_agent', '0.5.0'],
  ])('answers %i %s with its own words', async (status, code, words) => {
    const w = await mountPod({
      [`GET ${POD_URL}?lines=200&container=main`]: refusal(status, code),
    });
    await w.get('[data-testid="logs-read"]').trigger('submit');
    await flushPromises();
    const error = w.get('[data-testid="logs-error"]');
    expect(error.attributes('data-code')).toBe(code);
    expect(error.attributes('role')).toBe('alert');
    expect(error.text()).toContain(words);
  });

  it('says so when the container printed nothing', async () => {
    const w = await mountPod({
      [`GET ${POD_URL}?lines=200&container=main`]: answer({ lines: [], redacted: 0 }),
    });
    await w.get('[data-testid="logs-read"]').trigger('submit');
    await flushPromises();
    expect(w.get('[data-testid="logs-empty"]').text()).toContain('nothing in its last 200 lines');
  });

  it('shows the Settings switch up front: off for everyone, admins only for a viewer', async () => {
    const off = await mountPod({
      'GET /api/v1/settings/logs': { status: 200, body: { access: 'off' } },
    });
    expect(off.get('[data-testid="logs-blocked"]').text()).toContain('turned off in Settings');
    expect(off.find('[data-testid="logs-read"]').exists()).toBe(false);
    expect(off.get('[data-testid="logs-blocked"] a').text()).toBe('Open Settings');

    const viewer = await mountPod(
      { 'GET /api/v1/settings/logs': { status: 200, body: { access: 'admins' } } },
      'viewer',
    );
    expect(viewer.get('[data-testid="logs-blocked"]').text()).toContain('Only Owners and Admins');
    expect(viewer.find('[data-testid="logs-blocked"] a').exists()).toBe(false);
  });

  it('marks Docker stderr in words, not only colour, and copies what is shown', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const w = await mountDocker({
      [`GET ${DOCKER_URL}?lines=200`]: answer({
        container: 'logs-e2e-printer',
        lines: [
          { ts: '2026-11-13T02:44:18Z', stream: 'stdout', text: 'out' },
          { ts: '2026-11-13T02:44:19Z', stream: 'stderr', text: 'err' },
        ],
        cut: 1,
        truncated: true,
      }),
    });
    expect(w.find('[data-testid="logs-previous"]').exists()).toBe(false);
    expect(w.find('[data-testid="logs-container"]').exists()).toBe(false);
    await w.get('[data-testid="logs-read"]').trigger('submit');
    await flushPromises();
    const [out, err] = w.findAll('[data-testid="log-line"]');
    expect(out!.attributes('data-stream')).toBe('stdout');
    expect(err!.attributes('data-stream')).toBe('stderr');
    expect(err!.get('.sr-only').text()).toBe('stderr:');
    expect(w.get('[data-testid="logs-cut"]').text()).toBe('1 line cut at 2 KB');
    expect(w.find('[data-testid="logs-truncated"]').exists()).toBe(true);
    await w.get('[data-testid="logs-copy"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('out\n[stderr] err');
    await w.get('[data-testid="logs-times"] input').setValue(true);
    await w.get('[data-testid="logs-copy"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith(
      '2026-11-13T02:44:18Z out\n2026-11-13T02:44:19Z [stderr] err',
    );
  });

  it('follows through an EventSource, appends lines, ends after the limit and closes on unmount', async () => {
    const w = await mountDocker({});
    await w.get('[data-testid="logs-follow"] input').setValue(true);
    await w.get('[data-testid="logs-read"]').trigger('submit');
    await flushPromises();
    const es = FakeEventSource.last!;
    expect(es.url).toBe(`${DOCKER_URL}?lines=200&follow=true`);
    expect(es.init).toEqual({ withCredentials: true });
    es.emit('lines', {
      lines: [{ ts: null, stream: 'stdout', text: 'a' }],
      redacted: 0,
      truncated: false,
      cut: 0,
    });
    es.emit('lines', {
      lines: [{ ts: null, stream: 'stdout', text: 'b' }],
      redacted: 2,
      truncated: false,
      cut: 0,
    });
    await flushPromises();
    expect(w.findAll('[data-testid="log-line"]').map((l) => l.text())).toEqual(['a', 'b']);
    expect(w.get('[data-testid="logs-redacted"]').text()).toBe('2 lines redacted');
    es.emit('end', { reason: 'limit' });
    await flushPromises();
    expect(es.closed).toBe(true);
    expect(w.get('[data-testid="logs-follow-end"]').text()).toBe(
      'Stopped following after 5 minutes',
    );

    // A second follow, then the page goes away: the stream is closed.
    await w.get('[data-testid="logs-follow"] input').setValue(true);
    await flushPromises();
    const second = FakeEventSource.last!;
    expect(second).not.toBe(es);
    w.unmount();
    expect(second.closed).toBe(true);
  });

  it('turns a follow refused before it opened into its state', async () => {
    const w = await mountDocker({ [`GET ${DOCKER_URL}?lines=200`]: refusal(429, 'rate_limited') });
    await w.get('[data-testid="logs-follow"] input').setValue(true);
    await w.get('[data-testid="logs-read"]').trigger('submit');
    await flushPromises();
    const es = FakeEventSource.last!;
    es.onerror!();
    await flushPromises();
    expect(es.closed).toBe(true);
    expect(w.get('[data-testid="logs-error"]').attributes('data-code')).toBe('rate_limited');
  });
});

describe('Settings → Container logs', () => {
  it('lets an owner pick who may read, and shows the choice to a viewer', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/settings/logs': { status: 200, body: { access: 'all' } },
      'PUT /api/v1/settings/logs': { status: 200, body: { access: 'admins' } },
    });
    const { pinia, router, i18n } = await createPlugins('/');
    useAuthStore().user = { ...USER };
    const w = mount(LogsAccess, { global: { plugins: [pinia, router, i18n] } });
    await flushPromises();
    expect((w.get('[data-testid="logs-access-all"]').element as HTMLInputElement).checked).toBe(
      true,
    );
    await w.get('[data-testid="logs-access-admins"]').setValue(true);
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      path: '/api/v1/settings/logs',
      body: { access: 'admins' },
    });
    expect(w.text()).toContain('Saved');

    mockFetch({ 'GET /api/v1/settings/logs': { status: 200, body: { access: 'off' } } });
    const p2 = await createPlugins('/');
    useAuthStore().user = { ...USER, role: 'viewer' };
    const v = mount(LogsAccess, { global: { plugins: [p2.pinia, p2.router, p2.i18n] } });
    await flushPromises();
    expect(v.find('[data-testid="logs-access-all"]').exists()).toBe(false);
    expect(v.get('[data-testid="logs-access-readonly"]').text()).toBe('Now: Off');
  });
});
