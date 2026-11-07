// SPDX-License-Identifier: AGPL-3.0-only
// Read-only demo mode (ADR-122): the demo entry, the banner, the toast on a refused
// change, and no controls that change anything.
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, isDemoReadOnly, setReadOnlyHandler } from '@/api/client';
import DemoBanner from '@/components/layout/DemoBanner.vue';
import ToastHost from '@/components/ui/ToastHost.vue';
import { LINKS } from '@/lib/links';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';
import LoginPage from '@/views/LoginPage.vue';
import { createPlugins } from './helpers';
import { mockFetch, problem, USER } from './fetch-mock';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setReadOnlyHandler(() => {});
});

const DEMO_USER = { ...USER, email: 'demo@watchlog.invalid', name: 'Demo visitor', role: 'viewer' };
const MESSAGE = 'This is a read-only demo. Install WatchLog to try this on your cluster.';
const READ_ONLY = {
  status: 403,
  body: {
    type: 'urn:watchlog:problem:demo-read-only',
    title: 'Forbidden',
    status: 403,
    detail: MESSAGE,
    code: 'demo_read_only',
    message: MESSAGE,
  },
};

async function mountLogin(path: string, demoMode: boolean) {
  const plugins = await createPlugins('/setup'); // not a page that acts on mount
  useAuthStore().demoMode = demoMode;
  await plugins.router.push(path);
  const wrapper = mount(LoginPage, {
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  return { wrapper, router: plugins.router };
}

describe('demo entry', () => {
  it('learns demo mode from GET /setup', async () => {
    mockFetch({
      'GET /api/v1/setup': { status: 200, body: { required: false, demoMode: true } },
      'GET /api/v1/me': problem(401, 'Sign in to continue'),
    });
    await createPlugins('/setup');
    const auth = useAuthStore();
    await auth.ensureLoaded();
    expect(auth.demoMode).toBe(true);
    expect(auth.canManage).toBe(false);
  });

  it('shows one button instead of the sign-in form', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/demo/session': { status: 200, body: { user: DEMO_USER } },
    });
    const { wrapper, router } = await mountLogin('/login?redirect=/events', true);
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.get('[data-testid="enter-demo"]').text()).toBe('Enter live demo');
    expect(wrapper.get(`a[href="${LINKS.install}"]`).attributes('rel')).toContain('noopener');
    await wrapper.get('[data-testid="enter-demo"]').trigger('click');
    await flushPromises();
    expect(calls).toEqual([{ method: 'POST', path: '/api/v1/demo/session', body: undefined }]);
    expect(useAuthStore().user?.role).toBe('viewer');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/events'), {
      timeout: 5000,
    });
  });

  it('enters at once on /demo', async () => {
    mockFetch({ 'POST /api/v1/demo/session': { status: 200, body: { user: DEMO_USER } } });
    const { router } = await mountLogin('/demo', true);
    await flushPromises();
    expect(useAuthStore().user?.email).toBe(DEMO_USER.email);
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'), { timeout: 5000 });
  });

  it('keeps the sign-in form when the server is not a demo', async () => {
    const { fetchMock } = mockFetch({});
    const { wrapper, router } = await mountLogin('/demo', false);
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.currentRoute.value.name).toBe('login');
    expect(wrapper.find('form').exists()).toBe(true);
  });

  it('explains when the demo cannot start', async () => {
    mockFetch({ 'POST /api/v1/demo/session': problem(503, 'not ready') });
    const { wrapper } = await mountLogin('/login', true);
    await wrapper.get('[data-testid="enter-demo"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('not available right now');
  });
});

describe('demo banner', () => {
  it('links to the install guide', async () => {
    const plugins = await createPlugins('/setup');
    const wrapper = mount(DemoBanner, { global: { plugins: [plugins.i18n] } });
    expect(wrapper.text()).toContain('Live demo');
    expect(wrapper.text()).toContain('sample cluster');
    const link = wrapper.get('[data-testid="demo-install"]');
    expect(link.text()).toBe('Install yours in 5 minutes');
    expect(link.attributes('href')).toBe('https://watchlog.io/docs/install/');
    expect(link.attributes('target')).toBe('_blank');
  });
});

describe('a refused change', () => {
  it('is recognised and reported to the handler, once per request', async () => {
    mockFetch({ 'PUT /api/v1/settings/general': READ_ONLY });
    const seen: string[] = [];
    setReadOnlyHandler((m) => seen.push(m));
    const err = await api('/settings/general', { method: 'PUT', body: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isDemoReadOnly(err)).toBe(true);
    expect(seen).toEqual([MESSAGE]);
  });

  it('is not confused with other 403s', async () => {
    mockFetch({ 'PUT /api/v1/settings/general': problem(403, 'Your role does not allow this') });
    const handler = vi.fn();
    setReadOnlyHandler(handler);
    const err = await api('/settings/general', { method: 'PUT', body: {} }).catch((e) => e);
    expect(isDemoReadOnly(err)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('shows as a toast that goes away', async () => {
    vi.useFakeTimers();
    const plugins = await createPlugins('/setup');
    const wrapper = mount(ToastHost, { global: { plugins: [plugins.i18n, plugins.pinia] } });
    const toast = useToastStore();
    toast.show(MESSAGE, 'warning');
    toast.show(MESSAGE, 'warning'); // the same message twice shows once
    await flushPromises();
    expect(wrapper.findAll('[data-testid="toast"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="toasts"]').attributes('aria-live')).toBe('polite');
    expect(wrapper.text()).toContain(MESSAGE);
    vi.advanceTimersByTime(7000);
    await flushPromises();
    expect(wrapper.findAll('[data-testid="toast"]')).toHaveLength(0);
  });
});

describe('time ranges in the demo', () => {
  it('offers at most 24 hours (the server refuses longer ranges)', async () => {
    const { default: TimeRangePicker } = await import('@/components/layout/TimeRangePicker.vue');
    const plugins = await createPlugins('/setup');
    const labels = () =>
      mount(TimeRangePicker, { global: { plugins: [plugins.i18n, plugins.pinia] } })
        .findAll('button')
        .map((b) => b.text());
    expect(labels()).toHaveLength(5);
    useAuthStore().demoMode = true;
    const demo = labels();
    expect(demo).toHaveLength(4);
    expect(demo.join(' ')).not.toMatch(/7/);
  });
});
