// SPDX-License-Identifier: AGPL-3.0-only
// Support mode in the dashboard (ADR-179): the banner over every page while WatchLog staff
// look at the org (who, why, until when, nothing can be changed, leave), the Owners' list
// of sessions in Settings › Security, the store that finds a support session instead of an
// account, and the token history's "accessed by WatchLog staff".
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudConfig, SupportSession } from '@/api/cloud';
import StaffAccess from '@/components/cloud/StaffAccess.vue';
import SupportBanner from '@/components/cloud/SupportBanner.vue';
import { EVENT_DOT } from '@/lib/api-tokens';
import { useAuthStore } from '@/stores/auth';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const CONFIG: CloudConfig = {
  signup: true,
  providers: { github: false, google: false },
  turnstileSiteKey: null,
  passwordMinLength: 10,
  verifyGraceDays: 7,
  supportEmail: 'support@watchlog.io',
  sampleUrl: 'https://demo.watchlog.io',
};
const SUPPORT = {
  sessionId: '01a1d6f3-0000-7000-8000-000000000001',
  staffEmail: 'ada@watchlog.io',
  reason: 'Customer asked why the service map is empty',
  expiresAt: new Date(Date.now() + 42 * 60_000).toISOString(),
  org: { id: USER.org.id, name: 'acme' },
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mountWith(
  component: unknown,
  setup: (auth: ReturnType<typeof useAuthStore>) => void,
) {
  const plugins = await createPlugins('/');
  const auth = useAuthStore();
  auth.cloud = CONFIG;
  auth.loaded = true;
  setup(auth);
  const wrapper = mount(component as never, {
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  await flushPromises();
  return { wrapper, auth };
}

describe('the support banner', () => {
  it('says who, why, until when and that nothing can be changed; leaving ends the session', async () => {
    const { calls } = mockFetch({ 'DELETE /api/v1/support/session': { status: 204 } });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const { wrapper } = await mountWith(SupportBanner, (auth) => {
      auth.user = { ...USER, role: 'viewer', name: 'WatchLog staff' };
      auth.support = SUPPORT;
    });
    const text = wrapper.get('[data-testid="support-banner"]').text();
    expect(text).toContain('Support mode, read-only.');
    expect(text).toContain('WatchLog staff (ada@watchlog.io) are looking at acme');
    expect(text).toContain('Nothing can be changed');
    expect(text).toMatch(/\(4[12] min left\)/);
    expect(wrapper.get('[data-testid="support-reason"]').text()).toBe(
      'Why: Customer asked why the service map is empty',
    );
    await wrapper.get('[data-testid="support-leave"]').trigger('click');
    await flushPromises();
    expect(calls).toEqual([{ method: 'DELETE', path: '/api/v1/support/session', body: undefined }]);
    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('is absent outside support mode', async () => {
    const { wrapper } = await mountWith(SupportBanner, (auth) => {
      auth.user = USER;
    });
    expect(wrapper.find('[data-testid="support-banner"]').exists()).toBe(false);
  });
});

describe('the auth store in support mode', () => {
  it('reads the support session instead of an account, and offers no changes', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/setup': { status: 200, body: { required: false, demoMode: false, smtp: true } },
      'GET /api/v1/auth/config': { status: 200, body: CONFIG },
      'GET /api/v1/me': { status: 200, body: { user: { ...USER, role: 'viewer' } } },
      'GET /api/v1/support/current': { status: 200, body: SUPPORT },
    });
    await createPlugins('/');
    const auth = useAuthStore();
    await auth.reload();
    expect(auth.support).toEqual(SUPPORT);
    expect(auth.account).toBeNull();
    expect(auth.canManage).toBe(false);
    expect(calls.some((c) => c.path === '/api/v1/auth/account')).toBe(false);
  });

  it('a normal session has no support and loads its account', async () => {
    mockFetch({
      'GET /api/v1/setup': { status: 200, body: { required: false, demoMode: false, smtp: true } },
      'GET /api/v1/auth/config': { status: 200, body: CONFIG },
      'GET /api/v1/me': { status: 200, body: { user: USER } },
      'GET /api/v1/support/current': {
        status: 404,
        body: { type: 'about:blank', title: 'Not Found', status: 404 },
      },
      'GET /api/v1/auth/account': {
        status: 200,
        body: {
          email: USER.email,
          emailVerified: true,
          verifyBy: null,
          restriction: null,
          password: true,
          mfa: { enabled: false, required: false, recoveryCodesLeft: 0 },
          identities: [],
        },
      },
    });
    await createPlugins('/');
    const auth = useAuthStore();
    await auth.reload();
    expect(auth.support).toBeNull();
    expect(auth.account?.email).toBe(USER.email);
    expect(auth.canManage).toBe(true);
  });
});

describe('Settings › Security: WatchLog staff access (Owners)', () => {
  const SESSIONS: SupportSession[] = [
    {
      id: 'a',
      staffEmail: 'ada@watchlog.io',
      reason: 'Map empty',
      startedAt: '2026-11-13T09:00:00Z',
      expiresAt: '2026-11-13T10:00:00Z',
      enteredAt: '2026-11-13T09:01:00Z',
      endedAt: '2026-11-13T09:20:00Z',
      opened: [
        { path: '/api/v1/clusters', count: 3, at: '2026-11-13T09:01:00Z' },
        { path: '/api/v1/clusters/c1/service-map', count: 1, at: '2026-11-13T09:02:00Z' },
      ],
    },
    {
      id: 'b',
      staffEmail: 'grace@watchlog.io',
      reason: 'Billing question',
      startedAt: '2026-11-12T09:00:00Z',
      expiresAt: '2026-11-12T10:00:00Z',
      enteredAt: null,
      endedAt: null,
      opened: [],
    },
  ];

  it('lists who, when, why and what each session opened', async () => {
    mockFetch({ 'GET /api/v1/support-sessions': { status: 200, body: { sessions: SESSIONS } } });
    const { wrapper } = await mountWith(StaffAccess, (auth) => {
      auth.user = USER;
    });
    const rows = wrapper.findAll('[data-testid="staff-sessions"] > li');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain('ada@watchlog.io');
    expect(rows[0]!.text()).toContain('Why: Map empty');
    expect(rows[0]!.text()).toContain('Ended');
    expect(rows[0]!.text()).toContain('Opened 2 pages');
    expect(rows[1]!.text()).toContain('Link not used');
    expect(rows[1]!.text()).toContain('Nothing opened.');
    await rows[0]!.get('button').trigger('click');
    expect(wrapper.get('[data-testid="staff-opened"]').text()).toContain(
      '/api/v1/clusters/c1/service-map',
    );
    expect(wrapper.get('[data-testid="staff-opened"]').text()).toContain('×3');
  });

  it('says when staff never opened one', async () => {
    mockFetch({ 'GET /api/v1/support-sessions': { status: 200, body: { sessions: [] } } });
    const { wrapper } = await mountWith(StaffAccess, (auth) => {
      auth.user = USER;
    });
    expect(wrapper.get('[data-testid="staff-access-none"]').text()).toContain('never opened');
  });

  it("a token's history marks staff access", () => {
    expect(EVENT_DOT.staff_access).toBe('bg-warning');
  });
});
