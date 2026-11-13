// SPDX-License-Identifier: AGPL-3.0-only
// The Cloud account pages (ADR-175, Cloud slice 2b): sign-up, sign-in with 2FA, the verify
// link and the two gates, Settings › Security, the org switcher and the one-click invite.
// Each page shows only when GET /auth/config answers (Cloud); Community stays as 0.5.0.
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import {
  CLOUD_ERROR_CODES,
  cloudErrorKey,
  oauthStartUrl,
  problemCode,
  type Account,
  type CloudConfig,
} from '@/api/cloud';
import OrgSwitcher from '@/components/cloud/OrgSwitcher.vue';
import VerifyBanner from '@/components/cloud/VerifyBanner.vue';
import SecuritySettings from '@/components/settings/SecuritySettings.vue';
import { en } from '@/i18n';
import { passwordStrength } from '@/lib/password';
import { describeAgent } from '@/lib/sessions';
import { installAuthGuard, routes, type AuthState } from '@/router';
import { useAuthStore } from '@/stores/auth';
import { useOrgsStore } from '@/stores/orgs';
import AcceptInvitePage from '@/views/AcceptInvitePage.vue';
import LoginPage from '@/views/LoginPage.vue';
import SettingsPage from '@/views/SettingsPage.vue';
import SignupPage from '@/views/SignupPage.vue';
import TwoFactorPage from '@/views/TwoFactorPage.vue';
import VerifyEmailPage from '@/views/VerifyEmailPage.vue';
import { mockFetch, problem, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const CONFIG: CloudConfig = {
  signup: true,
  providers: { github: true, google: false },
  turnstileSiteKey: null,
  passwordMinLength: 10,
  verifyGraceDays: 7,
  supportEmail: 'support@watchlog.io',
  sampleUrl: 'https://demo.watchlog.io',
};
const ACCOUNT: Account = {
  email: USER.email,
  emailVerified: true,
  verifyBy: null,
  restriction: null,
  password: true,
  mfa: { enabled: false, required: false, recoveryCodesLeft: 0 },
  identities: [],
};
const cloudProblem = (status: number, code: string) => ({
  status,
  body: { type: `urn:watchlog:problem:${code}`, title: 'Error', status, code },
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mountCloud(
  component: unknown,
  path: string,
  opts: { config?: CloudConfig | null; signedIn?: boolean; account?: Partial<Account> } = {},
) {
  const plugins = await createPlugins(path);
  const auth = useAuthStore();
  auth.cloud = opts.config === undefined ? CONFIG : opts.config;
  auth.loaded = true;
  if (opts.signedIn) {
    auth.user = USER;
    auth.account = { ...ACCOUNT, ...opts.account };
  }
  const wrapper = mount(component as never, {
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  await flushPromises();
  return { wrapper, router: plugins.router, auth };
}

describe('the Cloud API helpers', () => {
  it('gives every error code a plain message in en.json', () => {
    const errors = (en as unknown as { cloud: { errors: Record<string, string> } }).cloud.errors;
    for (const code of CLOUD_ERROR_CODES) expect(errors[code], code).toBeTruthy();
  });

  it('reads the code from `code` or from the problem type', () => {
    const a = new ApiError(400, { type: 'x', title: 'x', status: 400, code: 'mfa-invalid' });
    const b = new ApiError(400, {
      type: 'urn:watchlog:problem:password-breached',
      title: 'x',
      status: 400,
    });
    expect(problemCode(a)).toBe('mfa-invalid');
    expect(cloudErrorKey(b)).toBe('cloud.errors.password-breached');
    expect(cloudErrorKey(new ApiError(0))).toBe('auth.errors.unavailable');
    expect(cloudErrorKey(new ApiError(429))).toBe('cloud.errors.rate-limited');
  });

  it('builds OAuth start links with a same-site next only', () => {
    expect(oauthStartUrl('github', 'signin', '/alerts')).toBe(
      '/api/v1/auth/oauth/github/start?intent=signin&next=%2Falerts',
    );
    expect(oauthStartUrl('google', 'signin', '//evil.example')).toBe(
      '/api/v1/auth/oauth/google/start?intent=signin',
    );
  });

  it('rates passwords: too short, weak, then stronger with length and mix', () => {
    expect(passwordStrength('short', 10)).toBe(0);
    expect(passwordStrength('aaaaaaaaaaaa', 10)).toBe(1);
    expect(passwordStrength('abcdefghij', 10)).toBe(1);
    expect(passwordStrength('correct-horse-battery', 10)).toBe(4);
    expect(passwordStrength('Tr0ub4dour&3x', 10)).toBe(3);
  });

  it('names a session by browser and system', () => {
    const mac =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0';
    expect(describeAgent(mac)).toEqual({ browser: 'Firefox', os: 'macOS' });
    expect(describeAgent(null)).toBeNull();
  });
});

describe('the auth store in Cloud', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('loads the config and the account, and never offers first-run setup', async () => {
    mockFetch({
      'GET /api/v1/setup': { status: 200, body: { required: true } },
      'GET /api/v1/auth/config': { status: 200, body: CONFIG },
      'GET /api/v1/me': { status: 200, body: { user: USER } },
      'GET /api/v1/auth/account': { status: 200, body: ACCOUNT },
    });
    const auth = useAuthStore();
    await auth.ensureLoaded();
    expect(auth.isCloud).toBe(true);
    expect(auth.setupRequired).toBe(false);
    expect(auth.account?.email).toBe(USER.email);
  });

  it('answers `mfa` when the password step asks for a code', async () => {
    mockFetch({ 'POST /api/v1/auth/login': { status: 202, body: { mfaRequired: true } } });
    const auth = useAuthStore();
    expect(await auth.login({ email: USER.email, password: 'x' })).toBe('mfa');
    expect(auth.user).toBeNull();
  });
});

describe('the guard in Cloud', () => {
  function routerWith(state: Partial<AuthState>) {
    const auth: AuthState = {
      user: state.user ?? null,
      setupRequired: false,
      isCloud: state.isCloud ?? true,
      restriction: state.restriction ?? null,
      ensureLoaded: () => Promise.resolve(),
    };
    const router = createRouter({ history: createMemoryHistory(), routes });
    installAuthGuard(router, () => auth);
    return router;
  }
  const land = async (router: ReturnType<typeof routerWith>, path: string) => {
    await router.push(path);
    return router.currentRoute.value;
  };

  it('hides the Cloud pages in Community', async () => {
    const community = routerWith({ isCloud: false });
    expect((await land(community, '/signup')).name).toBe('login');
    expect((await land(community, '/signin/2fa')).name).toBe('login');
    expect((await land(community, '/verify-email/abc')).name).toBe('login');
    expect((await land(routerWith({ isCloud: false, user: {} }), '/invite/t1')).path).toBe('/');
  });

  it('opens sign-up, the 2FA step and the backend’s /signin links in Cloud', async () => {
    const cloud = routerWith({});
    expect((await land(cloud, '/signup')).name).toBe('signup');
    expect((await land(cloud, '/signin/2fa')).name).toBe('signin-2fa');
    const back = await land(cloud, '/signin?error=oauth-cancelled');
    expect(back.name).toBe('login');
    expect(back.query.error).toBe('oauth-cancelled');
  });

  it('lets a signed-in user open an invite and a verify link', async () => {
    const cloud = routerWith({ user: {} });
    expect((await land(cloud, '/invite/t1')).name).toBe('accept-invite');
    expect((await land(cloud, '/verify-email/abc')).name).toBe('verify-email');
    expect((await land(cloud, '/signup')).path).toBe('/');
  });

  it('holds a gated account on the page that lifts the gate', async () => {
    const unverified = routerWith({ user: {}, restriction: 'email-verification-required' });
    expect((await land(unverified, '/alerts')).name).toBe('verify-required');
    expect((await land(unverified, '/verify-email/abc')).name).toBe('verify-email');
    const owner = routerWith({ user: {}, restriction: 'mfa-setup-required' });
    expect((await land(owner, '/settings')).name).toBe('mfa-required');
    expect((await land(routerWith({ user: {} }), '/setup-2fa')).path).toBe('/');
  });

  it('turns /settings/security into the Security tab', async () => {
    const route = await land(routerWith({ user: {} }), '/settings/security?linked=github');
    expect(route.name).toBe('settings');
    expect(route.query).toMatchObject({ tab: 'security', linked: 'github' });
  });
});

describe('the sign-in page', () => {
  it('is Community’s page without a Cloud config', async () => {
    const { wrapper } = await mountCloud(LoginPage, '/login', { config: null });
    expect(wrapper.find('[data-testid="providers"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="to-signup"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Sign in to your WatchLog installation.');
  });

  it('shows only the providers that are on, and a link to sign up', async () => {
    const { wrapper } = await mountCloud(LoginPage, '/login?redirect=/alerts');
    expect(wrapper.find('[data-testid="provider-github"]').attributes('href')).toBe(
      '/api/v1/auth/oauth/github/start?intent=signin&next=%2Falerts',
    );
    expect(wrapper.find('[data-testid="provider-google"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="to-signup"]').exists()).toBe(true);
  });

  it('explains an OAuth error from the callback', async () => {
    const { wrapper } = await mountCloud(LoginPage, '/login?error=identity-taken');
    expect(wrapper.get('[data-testid="oauth-error"]').text()).toContain('already linked');
  });

  it('goes to the 2FA step when the password step asks for a code', async () => {
    mockFetch({ 'POST /api/v1/auth/login': { status: 202, body: { mfaRequired: true } } });
    const { wrapper, router } = await mountCloud(LoginPage, '/login?redirect=/alerts');
    const inputs = wrapper.findAll('input');
    await inputs[0]!.setValue(USER.email);
    await inputs[1]!.setValue('correct password');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('signin-2fa'));
    expect(router.currentRoute.value.query.redirect).toBe('/alerts');
  });
});

describe('the 2FA step', () => {
  it('asks for six digits before calling the API', async () => {
    const { fetchMock } = mockFetch({});
    const { wrapper } = await mountCloud(TwoFactorPage, '/signin/2fa');
    await wrapper.get('input').setValue('12');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toBe('Enter the 6-digit code.');
  });

  it('says when a code is wrong, and takes a recovery code instead', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/2fa/verify': [
        cloudProblem(400, 'mfa-invalid'),
        { status: 200, body: { user: USER } },
      ],
      'GET /api/v1/auth/account': { status: 200, body: ACCOUNT },
    });
    const { wrapper, router } = await mountCloud(TwoFactorPage, '/signin/2fa', {});
    await wrapper.get('input').setValue('123456');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("isn't right");
    await wrapper.get('[data-testid="mfa-toggle"]').trigger('click');
    await wrapper.get('input').setValue('ABCDE-12345');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(calls[1]!.body).toEqual({ code: 'abcde-12345' });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
  });

  it('asks to sign in again when the step expired', async () => {
    mockFetch({ 'POST /api/v1/auth/2fa/verify': cloudProblem(401, 'invalid-token') });
    const { wrapper } = await mountCloud(TwoFactorPage, '/signin/2fa');
    await wrapper.get('input').setValue('123456');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-testid="mfa-again"]').exists()).toBe(true);
  });
});

describe('the sign-up page', () => {
  async function fillAndSubmit(wrapper: ReturnType<typeof mount>, password = 'correct-horse-9') {
    const inputs = wrapper.findAll('form input');
    await inputs[0]!.setValue('sara@acme.dev');
    await inputs[1]!.setValue(password);
    await wrapper.get('form').trigger('submit');
    await flushPromises();
  }

  it('shows the providers, the meter, the terms and the three steps, without the region', async () => {
    const { wrapper } = await mountCloud(SignupPage, '/signup');
    expect(wrapper.find('[data-testid="provider-github"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="turnstile"]').exists()).toBe(false);
    const links = wrapper.findAll('a').map((a) => a.attributes('href'));
    expect(links).toContain('https://watchlog.io/terms');
    expect(links).toContain('https://watchlog.io/privacy');
    expect(wrapper.findAll('aside ol li')).toHaveLength(3);
    expect(wrapper.text()).not.toMatch(/\bEU\b/);
    await wrapper.findAll('form input')[1]!.setValue('correct-horse-battery');
    expect(wrapper.get('[data-testid="password-strength"]').attributes('data-score')).toBe('4');
  });

  it('loads Cloudflare’s script only when a site key is set', async () => {
    const turnstile = {
      render: vi.fn<(el: HTMLElement, opts: Record<string, unknown>) => string>(() => 'w1'),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal('turnstile', turnstile);
    const { wrapper } = await mountCloud(SignupPage, '/signup', {
      config: { ...CONFIG, turnstileSiteKey: '1x00000000000000000000AA' },
    });
    expect(wrapper.find('[data-testid="turnstile"]').exists()).toBe(true);
    await vi.waitFor(() => expect(turnstile.render).toHaveBeenCalled());
    expect(turnstile.render.mock.calls[0]![1]).toMatchObject({
      sitekey: '1x00000000000000000000AA',
    });
    // No token yet: the form says to wait for the check.
    const { fetchMock } = mockFetch({});
    await fillAndSubmit(wrapper);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('human check');
  });

  it('signs a new account in and goes on', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/signup': { status: 201, body: { accepted: true, verificationSent: true } },
      'GET /api/v1/me': { status: 200, body: { user: USER } },
      'GET /api/v1/auth/account': { status: 200, body: { ...ACCOUNT, emailVerified: false } },
    });
    const { wrapper, router, auth } = await mountCloud(SignupPage, '/signup');
    await fillAndSubmit(wrapper);
    expect(calls[0]!.body).toEqual({ email: 'sara@acme.dev', password: 'correct-horse-9' });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/onboarding'));
    expect(auth.account?.emailVerified).toBe(false);
  });

  it('says to check the email when the address already has an account', async () => {
    mockFetch({
      'POST /api/v1/auth/signup': { status: 201, body: { accepted: true, verificationSent: true } },
      'GET /api/v1/me': problem(401, 'Sign in'),
    });
    const { wrapper } = await mountCloud(SignupPage, '/signup');
    await fillAndSubmit(wrapper);
    expect(wrapper.get('[data-testid="signup-check-email"]').text()).toContain('sara@acme.dev');
  });

  it.each([
    ['password-breached', 'data breach'],
    ['email-disposable', 'throwaway'],
    ['turnstile-failed', 'human check'],
  ])('explains %s in plain words', async (code, words) => {
    mockFetch({ 'POST /api/v1/auth/signup': cloudProblem(400, code) });
    const { wrapper } = await mountCloud(SignupPage, '/signup');
    await fillAndSubmit(wrapper);
    expect(wrapper.get('[role="alert"]').text()).toContain(words);
  });

  it('checks the length before calling the API', async () => {
    const { fetchMock } = mockFetch({});
    const { wrapper } = await mountCloud(SignupPage, '/signup');
    await fillAndSubmit(wrapper, 'short');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('verifying the email', () => {
  it('verifies the link', async () => {
    mockFetch({ 'POST /api/v1/auth/verify-email': { status: 200, body: { verified: true } } });
    const { wrapper } = await mountCloud(VerifyEmailPage, '/verify-email/tok');
    expect(wrapper.find('[data-testid="verify-done"]').exists()).toBe(true);
  });

  it('offers a new link when an expired one is opened signed in', async () => {
    mockFetch({ 'POST /api/v1/auth/verify-email': cloudProblem(410, 'token-expired') });
    const { wrapper } = await mountCloud(VerifyEmailPage, '/verify-email/tok', { signedIn: true });
    expect(wrapper.text()).toContain('expired');
    expect(wrapper.find('[data-testid="resend-button"]').exists()).toBe(true);
  });

  it('shows the banner until the address is verified, with resend', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/verify-email/resend': { status: 202, body: { emailed: true } },
    });
    const { wrapper } = await mountCloud(VerifyBanner, '/', {
      signedIn: true,
      account: { emailVerified: false, verifyBy: '2026-11-20T10:00:00Z' },
    });
    expect(wrapper.get('[data-testid="verify-banner"]').text()).toContain(USER.email);
    await wrapper.get('[data-testid="resend-button"]').trigger('click');
    await flushPromises();
    expect(calls[0]!.path).toBe('/api/v1/auth/verify-email/resend');
    expect(wrapper.find('[data-testid="resend-sent"]').exists()).toBe(true);
  });

  it('shows no banner once verified', async () => {
    const { wrapper } = await mountCloud(VerifyBanner, '/', { signedIn: true });
    expect(wrapper.find('[data-testid="verify-banner"]').exists()).toBe(false);
  });
});

describe('Settings › Security', () => {
  const SESSIONS = {
    sessions: [
      {
        id: 's1',
        current: true,
        createdAt: '2026-11-13T09:00:00Z',
        lastSeenAt: '2026-11-13T10:00:00Z',
        expiresAt: '2026-12-13T09:00:00Z',
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/131.0 Safari/537.36',
        mfa: false,
      },
      {
        id: 's2',
        current: false,
        createdAt: '2026-11-12T09:00:00Z',
        lastSeenAt: null,
        expiresAt: '2026-12-12T09:00:00Z',
        ip: '198.51.100.4',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
        mfa: false,
      },
    ],
  };

  it('is a Settings tab in Cloud only', async () => {
    mockFetch({
      'GET /api/v1/auth/account': { status: 200, body: ACCOUNT },
      'GET /api/v1/auth/sessions': { status: 200, body: SESSIONS },
    });
    const community = await mountCloud(SettingsPage, '/settings?tab=security', { config: null });
    expect(community.wrapper.find('[data-testid="settings-tab-security"]').exists()).toBe(false);
    community.wrapper.unmount();
  });

  it('lists sessions, signs out the others, and links GitHub', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/auth/account': { status: 200, body: ACCOUNT },
      'GET /api/v1/auth/sessions': [
        { status: 200, body: SESSIONS },
        { status: 200, body: { sessions: [SESSIONS.sessions[0]] } },
      ],
      'DELETE /api/v1/auth/sessions': { status: 200, body: { revoked: 1 } },
    });
    const { wrapper } = await mountCloud(SecuritySettings, '/settings?tab=security', {
      signedIn: true,
    });
    const rows = wrapper.findAll('[data-testid="sessions"] li');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain('Chrome on macOS');
    expect(rows[0]!.text()).toContain('This device');
    expect(wrapper.get('[data-testid="mfa-status"]').text()).toBe('Off');
    expect(wrapper.get('[data-testid="link-github"]').attributes('href')).toBe(
      '/api/v1/auth/oauth/github/start?intent=link&next=%2Fsettings%2Fsecurity',
    );
    await wrapper.get('[data-testid="revoke-others"]').trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/auth/sessions')).toBe(
      true,
    );
    expect(wrapper.findAll('[data-testid="sessions"] li')).toHaveLength(1);
  });

  it('says a provider was linked, and why unlinking the last way in is refused', async () => {
    const linked = {
      ...ACCOUNT,
      password: false,
      identities: [{ provider: 'github', email: 'ada@gh', linkedAt: '2026-11-13T09:00:00Z' }],
    };
    mockFetch({
      'GET /api/v1/auth/account': { status: 200, body: linked },
      'GET /api/v1/auth/sessions': { status: 200, body: SESSIONS },
      'DELETE /api/v1/auth/identities/github': cloudProblem(409, 'last-sign-in-method'),
    });
    const { wrapper } = await mountCloud(SecuritySettings, '/settings?tab=security&linked=github', {
      signedIn: true,
      account: linked as Partial<Account>,
    });
    expect(wrapper.get('[data-testid="security-notice"]').text()).toContain('GitHub is linked');
    await wrapper.get('[data-testid="unlink-github"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('only way to sign in');
  });

  it('turns 2FA on and shows the recovery codes once', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `aaaa${i}-bbbbb`);
    mockFetch({
      'GET /api/v1/auth/account': { status: 200, body: ACCOUNT },
      'GET /api/v1/auth/sessions': { status: 200, body: SESSIONS },
      'POST /api/v1/auth/2fa/setup': {
        status: 200,
        body: {
          secret: 'JBSWY3DPEHPK3PXP',
          uri: 'otpauth://totp/WatchLog:ada?secret=JBSWY3DPEHPK3PXP',
        },
      },
      'POST /api/v1/auth/2fa/enable': { status: 200, body: { recoveryCodes: codes } },
    });
    const { wrapper } = await mountCloud(SecuritySettings, '/settings?tab=security', {
      signedIn: true,
    });
    await wrapper.get('[data-testid="mfa-turn-on"]').trigger('click');
    await flushPromises();
    const secret = document.querySelector('[data-testid="mfa-secret"]');
    expect(secret?.textContent).toBe('JBSW Y3DP EHPK 3PXP');
    expect(document.querySelector('[data-testid="mfa-uri"]')?.getAttribute('href')).toMatch(
      /^otpauth:\/\//,
    );
    const input = document.querySelector<HTMLInputElement>('[data-testid="mfa-setup"] input')!;
    input.value = '123456';
    input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('[data-testid="mfa-enable"]')!.click();
    await flushPromises();
    expect(document.querySelectorAll('[data-testid="recovery-code"]')).toHaveLength(10);
    const done = document.querySelector<HTMLButtonElement>('[data-testid="recovery-done"]')!;
    expect(done.disabled).toBe(true);
  });

  it('keeps 2FA on for an Owner of a paid org', async () => {
    const required = { ...ACCOUNT, mfa: { enabled: true, required: true, recoveryCodesLeft: 9 } };
    mockFetch({
      'GET /api/v1/auth/account': { status: 200, body: required },
      'GET /api/v1/auth/sessions': { status: 200, body: SESSIONS },
    });
    const { wrapper } = await mountCloud(SecuritySettings, '/settings?tab=security', {
      signedIn: true,
      account: required,
    });
    expect(wrapper.get('[data-testid="mfa-turn-off"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="codes-left"]').text()).toContain('9 of 10');
  });
});

describe('orgs and invites', () => {
  const ORGS = [
    { id: 'o1', name: 'Acme', slug: 'acme', role: 'owner', current: true },
    { id: 'o2', name: 'Globex', slug: 'globex', role: 'viewer', current: false },
  ];

  it('shows the switcher only with two or more orgs', async () => {
    mockFetch({ 'GET /api/v1/orgs': { status: 200, body: { orgs: [ORGS[0]] } } });
    const one = await mountCloud(OrgSwitcher, '/', { signedIn: true });
    expect(one.wrapper.find('[data-testid="org-switcher"]').exists()).toBe(false);
    one.wrapper.unmount();
    setActivePinia(createPinia());
    mockFetch({ 'GET /api/v1/orgs': { status: 200, body: { orgs: ORGS } } });
    const two = await mountCloud(OrgSwitcher, '/', { signedIn: true });
    expect(two.wrapper.find('[data-testid="org-switcher"]').exists()).toBe(true);
  });

  it('switches the session’s org, then reloads the app', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/orgs/o2/switch': { status: 200, body: { org: { id: 'o2' } } },
    });
    setActivePinia(createPinia());
    const orgs = useOrgsStore();
    const reload = vi.fn();
    await orgs.switchTo('o2', reload);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/v1/orgs/o2/switch' });
    expect(reload).toHaveBeenCalled();
  });

  const INVITE = {
    email: USER.email,
    role: 'viewer',
    invitedBy: 'Sara',
    expiresAt: '2026-11-20T00:00:00Z',
    status: 'pending',
    site: 'https://cloud.example',
  };

  it('joins with one click when signed in, and explains a wrong address', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/invites/tok': { status: 200, body: INVITE },
      'POST /api/v1/invites/tok/join': cloudProblem(403, 'invite-other-email'),
    });
    const { wrapper } = await mountCloud(AcceptInvitePage, '/invite/tok', { signedIn: true });
    expect(wrapper.find('[data-testid="accept"]').exists()).toBe(false);
    await wrapper.get('[data-testid="join-submit"]').trigger('click');
    await flushPromises();
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/api/v1/invites/tok/join' });
    expect(wrapper.get('[role="alert"]').text()).toContain('another address');
  });

  it('keeps Community’s create-account form, with "sign in to join" in Cloud', async () => {
    mockFetch({ 'GET /api/v1/invites/tok': { status: 200, body: INVITE } });
    const cloud = await mountCloud(AcceptInvitePage, '/invite/tok');
    expect(cloud.wrapper.find('[data-testid="accept"]').exists()).toBe(true);
    expect(cloud.wrapper.get('[data-testid="sign-in-to-join"]').attributes('href')).toBe(
      '/login?redirect=/invite/tok',
    );
    cloud.wrapper.unmount();
    mockFetch({ 'GET /api/v1/invites/tok': { status: 200, body: INVITE } });
    const community = await mountCloud(AcceptInvitePage, '/invite/tok', { config: null });
    expect(community.wrapper.find('[data-testid="sign-in-to-join"]').exists()).toBe(false);
  });
});
