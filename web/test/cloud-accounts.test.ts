// SPDX-License-Identifier: AGPL-3.0-only
// The Cloud account pages (ADR-175, Cloud slice 2b): sign-up, sign-in with 2FA, the verify
// link and the two gates, Settings › Security, the org switcher and the one-click invite.
// Each page shows only when GET /auth/config answers (Cloud); Community stays as 0.5.0.
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createHash } from 'node:crypto';
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
import {
  cancel,
  confirm,
  confirmTwice,
  count,
  dialogOf,
  dialogText,
  errorOf,
  toasts,
} from './confirm';
import { mockFetch, problem, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const CONFIG: CloudConfig = {
  signup: true,
  signupMode: 'public',
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

/** Mounted pages are unmounted after each test: a field's pending check must not outlive it. */
const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  vi.useRealTimers();
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
  mounted.push(wrapper);
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

  it('says an address with an account signs in its way and links the provider (ADR-183)', async () => {
    const { wrapper } = await mountCloud(LoginPage, '/login?error=account-exists');
    const text = wrapper.get('[data-testid="oauth-error"]').text();
    expect(text).toContain('already has a WatchLog account');
    expect(text).toContain('Settings › Security');
  });

  describe('Turnstile on sign-in (ADR-175, amended in 0.9.9)', () => {
    const KEYED = { ...CONFIG, turnstileSiteKey: '1x00000000000000000000AA' };
    function stubTurnstile(behave: (opts: Record<string, (t?: string) => void>) => void) {
      let given: Record<string, (t?: string) => void> | undefined;
      const turnstile = {
        render: vi.fn((_el: HTMLElement, opts: Record<string, (t?: string) => void>) => {
          given = opts;
          behave(opts);
          return 'w1';
        }),
        // As Cloudflare's widget does: a reset runs the check again.
        reset: vi.fn(() => {
          if (given) behave(given);
        }),
        remove: vi.fn(),
      };
      vi.stubGlobal('turnstile', turnstile);
      return turnstile;
    }
    async function signIn(wrapper: ReturnType<typeof mount>) {
      const inputs = wrapper.findAll('input');
      await inputs[0]!.setValue(USER.email);
      await inputs[1]!.setValue('correct password');
      await wrapper.find('form').trigger('submit');
      await flushPromises();
    }

    it('pass: quiet, and the token goes with the password', async () => {
      const turnstile = stubTurnstile((opts) => opts.callback!('signin-token'));
      const { calls } = mockFetch({
        'POST /api/v1/auth/login': { status: 200, body: { user: USER } },
        'GET /api/v1/auth/account': { status: 200, body: ACCOUNT },
      });
      const { wrapper, router } = await mountCloud(LoginPage, '/login', { config: KEYED });
      await vi.waitFor(() => expect(turnstile.render).toHaveBeenCalled());
      // Shown only when Cloudflare wants something from the visitor.
      expect(turnstile.render.mock.calls[0]![1]).toMatchObject({
        sitekey: '1x00000000000000000000AA',
        appearance: 'interaction-only',
      });
      expect(wrapper.find('[data-testid="signin-turnstile"] [role="alert"]').exists()).toBe(false);
      await signIn(wrapper);
      expect(calls.find((c) => c.path === '/api/v1/auth/login')!.body).toEqual({
        email: USER.email,
        password: 'correct password',
        turnstileToken: 'signin-token',
      });
      await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
    });

    it('fail: a refused check is said, and a new one starts by itself', async () => {
      const turnstile = stubTurnstile((opts) => opts.callback!('signin-token'));
      mockFetch({ 'POST /api/v1/auth/login': cloudProblem(400, 'turnstile-failed') });
      const { wrapper } = await mountCloud(LoginPage, '/login', { config: KEYED });
      await vi.waitFor(() => expect(turnstile.render).toHaveBeenCalled());
      await signIn(wrapper);
      expect(wrapper.get('form > [role="alert"]').text()).toContain('human check');
      expect(turnstile.reset).toHaveBeenCalledTimes(1);
      // A wrong password spends the token too: the next try gets a new one.
      mockFetch({ 'POST /api/v1/auth/login': problem(401, 'Invalid email or password') });
      await wrapper.find('form').trigger('submit');
      await flushPromises();
      expect(wrapper.get('form > [role="alert"]').text()).toBe('Invalid email or password.');
      expect(turnstile.reset).toHaveBeenCalledTimes(2);
    });

    it('the fallback: Cloudflare blocked here, sign-in goes on without a token and says nothing', async () => {
      // The script can't load: no window.turnstile, and the tag's error fires.
      const append = vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
        queueMicrotask(() => (node as HTMLScriptElement).onerror?.(new Event('error')));
        return node;
      });
      const { calls } = mockFetch({
        'POST /api/v1/auth/login': { status: 200, body: { user: USER } },
        'GET /api/v1/auth/account': { status: 200, body: ACCOUNT },
      });
      const { wrapper, router } = await mountCloud(LoginPage, '/login', { config: KEYED });
      await flushPromises();
      expect(append).toHaveBeenCalled();
      // Nothing alarming on the page.
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
      await signIn(wrapper);
      expect(calls.find((c) => c.path === '/api/v1/auth/login')!.body).toEqual({
        email: USER.email,
        password: 'correct password',
      });
      await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
      append.mockRestore();
    });

    it('missing token: a check that has not finished is waited for 3 seconds, then sign-in goes on', async () => {
      vi.useFakeTimers();
      // Rendered, but never answers.
      const turnstile = stubTurnstile(() => {});
      const { calls } = mockFetch({
        'POST /api/v1/auth/login': cloudProblem(429, 'rate-limited'),
      });
      const { wrapper } = await mountCloud(LoginPage, '/login', { config: KEYED });
      await vi.waitFor(() => expect(turnstile.render).toHaveBeenCalled());
      const inputs = wrapper.findAll('input');
      await inputs[0]!.setValue(USER.email);
      await inputs[1]!.setValue('correct password');
      await wrapper.find('form').trigger('submit');
      await vi.advanceTimersByTimeAsync(2900);
      expect(calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(200);
      await vi.runAllTimersAsync();
      expect(calls[0]!.body).toEqual({ email: USER.email, password: 'correct password' });
      // The fallback's limit, in words that say what to do.
      expect(wrapper.get('form > [role="alert"]').text()).toBe(
        'Too many sign-in attempts without the human check. Wait 15 minutes, or let this page load challenges.cloudflare.com (a content blocker may be stopping it) and try again.',
      );
    });

    it('Community, and Cloud without a site key: no widget, no script, the form as it was', async () => {
      const append = vi.spyOn(document.head, 'appendChild');
      for (const config of [null, CONFIG]) {
        const { calls } = mockFetch({
          'POST /api/v1/auth/login': { status: 200, body: { user: USER } },
          'GET /api/v1/auth/account': { status: 200, body: ACCOUNT },
        });
        const { wrapper } = await mountCloud(LoginPage, '/login', { config });
        expect(wrapper.find('[data-testid="signin-turnstile"]').exists()).toBe(false);
        await signIn(wrapper);
        expect(calls.find((c) => c.path === '/api/v1/auth/login')!.body).toEqual({
          email: USER.email,
          password: 'correct password',
        });
      }
      expect(append.mock.calls.filter(([n]) => (n as HTMLElement).tagName === 'SCRIPT')).toEqual(
        [],
      );
      append.mockRestore();
    });
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

  it('shows the providers, the password rules, the terms and the three steps, without the region', async () => {
    const { wrapper } = await mountCloud(SignupPage, '/signup');
    expect(wrapper.find('[data-testid="provider-github"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="turnstile"]').exists()).toBe(false);
    const links = wrapper.findAll('a').map((a) => a.attributes('href'));
    expect(links).toContain('https://watchlog.io/terms');
    expect(links).toContain('https://watchlog.io/privacy');
    expect(wrapper.findAll('aside ol li')).toHaveLength(3);
    expect(wrapper.text()).not.toMatch(/\bEU\b/);
    // The checklist in place of the strength bar (0.9.9): two rules, no "Weak.".
    expect(wrapper.findAll('[data-rule]').map((r) => r.attributes('data-rule'))).toEqual([
      'length',
      'leak',
    ]);
    expect(wrapper.find('[data-testid="password-strength"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Weak');
    await wrapper.findAll('form input')[1]!.setValue('correct-horse-battery');
    expect(wrapper.get('[data-rule="length"]').attributes('data-state')).toBe('ok');
    // The right column is for clusters and servers alike.
    const aside = wrapper.get('aside').text();
    expect(aside).toContain('Two minutes from here to your cluster or servers on screen.');
    expect(aside).toContain('Kubernetes or Linux servers');
    expect(aside).toContain('Pick one, copy one command');
    expect(aside).toContain('Docker containers are picked up too');
    expect(aside).not.toContain('Kubernetes or Docker');
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
    // Said by the human check itself, not at the bottom of the form.
    expect(wrapper.get('[data-testid="turnstile-error"]').text()).toContain('human check');
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

  it('a leaked password is said under the password field; the rest is kept and the human check is not redone', async () => {
    const turnstile = {
      render: vi.fn((_el: HTMLElement, opts: { callback: (t: string) => void }) => {
        opts.callback('token-1');
        return 'w1';
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal('turnstile', turnstile);
    const { calls } = mockFetch({
      'POST /api/v1/auth/signup': [
        cloudProblem(400, 'password-breached'),
        { status: 201, body: { accepted: true, verificationSent: true } },
      ],
      'GET /api/v1/me': problem(401, 'Sign in'),
    });
    const { wrapper } = await mountCloud(SignupPage, '/signup', {
      config: { ...CONFIG, turnstileSiteKey: '1x00000000000000000000AA' },
    });
    await vi.waitFor(() => expect(turnstile.render).toHaveBeenCalled());
    await fillAndSubmit(wrapper, 'correct horse battery');
    // Under the field it is about, in words that say what to do, with the focus there.
    const error = wrapper.get('[data-testid="password-error"]');
    expect(error.text()).toBe(
      'This password is in a list of leaked passwords, so attackers try it first. Pick a different one: three or four random words work well.',
    );
    const password = wrapper.get('[data-testid="password-input"]');
    expect(document.activeElement).toBe(password.element);
    expect(wrapper.find('[data-testid="signup"] > [role="alert"]').exists()).toBe(false);
    // The email is kept, and so is the human check: its token was not spent.
    expect((wrapper.findAll('form input')[0]!.element as HTMLInputElement).value).toBe(
      'sara@acme.dev',
    );
    expect(turnstile.reset).not.toHaveBeenCalled();
    // The button is not dead: another password, and it goes with the same token.
    const submit = wrapper.get('[data-testid="signup-submit"]');
    expect(submit.attributes('disabled')).toBeUndefined();
    await password.setValue('four random words here');
    expect(wrapper.find('[data-testid="password-error"]').exists()).toBe(false);
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    const sent = calls.filter((c) => c.path === '/api/v1/auth/signup').map((c) => c.body);
    expect(sent).toEqual([
      { email: 'sara@acme.dev', password: 'correct horse battery', turnstileToken: 'token-1' },
      { email: 'sara@acme.dev', password: 'four random words here', turnstileToken: 'token-1' },
    ]);
  });

  it('a throwaway address is said under the email field, with the focus there', async () => {
    mockFetch({ 'POST /api/v1/auth/signup': cloudProblem(400, 'email-disposable') });
    const { wrapper } = await mountCloud(SignupPage, '/signup');
    await fillAndSubmit(wrapper);
    const email = wrapper.findAll('form input')[0]!;
    expect(email.attributes('aria-invalid')).toBe('true');
    const help = wrapper.get(`#${CSS.escape(email.attributes('aria-describedby')!)}`);
    expect(help.text()).toContain('throwaway');
    expect(help.attributes('role')).toBe('alert');
    expect(document.activeElement).toBe(email.element);
    expect(wrapper.find('[data-testid="password-error"]').exists()).toBe(false);
  });

  it('a refused human check is said by the human check, which starts again by itself', async () => {
    const turnstile = {
      render: vi.fn((_el: HTMLElement, opts: { callback: (t: string) => void }) => {
        opts.callback('token-1');
        return 'w1';
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal('turnstile', turnstile);
    mockFetch({ 'POST /api/v1/auth/signup': cloudProblem(400, 'turnstile-failed') });
    const { wrapper } = await mountCloud(SignupPage, '/signup', {
      config: { ...CONFIG, turnstileSiteKey: '1x00000000000000000000AA' },
    });
    await vi.waitFor(() => expect(turnstile.render).toHaveBeenCalled());
    await fillAndSubmit(wrapper);
    expect(wrapper.get('[data-testid="turnstile-error"]').text()).toContain('human check');
    expect(turnstile.reset).toHaveBeenCalledWith('w1');
    // What was typed is kept.
    expect((wrapper.get('[data-testid="password-input"]').element as HTMLInputElement).value).toBe(
      'correct-horse-9',
    );
  });

  it('without a human check on the page, its refusal is said under the form', async () => {
    mockFetch({ 'POST /api/v1/auth/signup': cloudProblem(400, 'turnstile-failed') });
    const { wrapper } = await mountCloud(SignupPage, '/signup');
    await fillAndSubmit(wrapper);
    expect(wrapper.get('[data-testid="signup"] > [role="alert"]').text()).toContain('human check');
  });

  it('the button is never dead: pressed with nothing typed, it goes to the first problem', async () => {
    const { fetchMock } = mockFetch({});
    const { wrapper } = await mountCloud(SignupPage, '/signup');
    const submit = wrapper.get('[data-testid="signup-submit"]');
    expect(submit.attributes('disabled')).toBeUndefined();
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    const email = wrapper.findAll('form input')[0]!;
    expect(document.activeElement).toBe(email.element);
    expect(wrapper.get(`#${CSS.escape(email.attributes('aria-describedby')!)}`).text()).toBe(
      'Enter your email address.',
    );
    // The email is there now: the next problem is the password.
    await email.setValue('sara@acme.dev');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[data-testid="password-error"]').text()).toContain(
      'This is too short: use at least 10 characters.',
    );
    expect(document.activeElement).toBe(wrapper.get('[data-testid="password-input"]').element);
    expect(submit.attributes('disabled')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a password the live check found leaked is not sent', async () => {
    vi.useFakeTimers();
    const hash = createHash('sha1').update('correct horse battery').digest('hex').toUpperCase();
    const { calls } = mockFetch({
      [`GET /api/v1/auth/password-range/${hash.slice(0, 5)}`]: {
        status: 200,
        body: { range: `${hash.slice(5)}:42\r\nAAAA:0` },
      },
    });
    const { wrapper } = await mountCloud(SignupPage, '/signup');
    const inputs = wrapper.findAll('form input');
    await inputs[0]!.setValue('sara@acme.dev');
    await inputs[1]!.setValue('correct horse battery');
    await vi.advanceTimersByTimeAsync(400);
    // The hashing is the browser's own work, not on this clock.
    vi.useRealTimers();
    await vi.waitFor(() =>
      expect(wrapper.get('[data-rule="leak"]').attributes('data-state')).toBe('bad'),
    );
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(wrapper.get('[data-testid="password-error"]').text()).toContain('leaked passwords');
    expect(document.activeElement).toBe(wrapper.get('[data-testid="password-input"]').element);
  });

  it('checks the length before calling the API', async () => {
    const { fetchMock } = mockFetch({});
    const { wrapper } = await mountCloud(SignupPage, '/signup');
    await fillAndSubmit(wrapper, 'short');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the sign-up page in invite waves (ADR-173)', () => {
  const INVITE = { ...CONFIG, signupMode: 'invite' as const };
  const CODE = 'wl_si_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

  it('without an invite, says Cloud opens in waves and links to the waitlist', async () => {
    const { fetchMock } = mockFetch({});
    const { wrapper } = await mountCloud(SignupPage, '/signup', { config: INVITE });
    expect(wrapper.text()).toContain('opening in waves');
    expect(wrapper.get('[data-testid="signup-waitlist"]').attributes('href')).toBe(
      'https://watchlog.io/pricing/#cloud',
    );
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.find('[data-testid="provider-github"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="signup-invite-invalid"]').exists()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with an invite, fills in its address and hands the code to the signup and to GitHub', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/signup-invite': {
        status: 200,
        body: { email: 'wave@acme.dev', expiresAt: '2026-11-28T10:00:00.000Z' },
      },
      'POST /api/v1/auth/signup': { status: 201, body: { accepted: true, verificationSent: true } },
      'GET /api/v1/me': { status: 200, body: { user: USER } },
      'GET /api/v1/auth/account': { status: 200, body: ACCOUNT },
    });
    const { wrapper, router } = await mountCloud(SignupPage, `/signup?invite=${CODE}`, {
      config: INVITE,
    });
    expect(calls[0]).toMatchObject({ path: '/api/v1/auth/signup-invite', body: { invite: CODE } });
    expect(wrapper.get('[data-testid="signup-invited"]').text()).toContain('wave@acme.dev');
    expect(wrapper.get('[data-testid="signup-invited"]').text()).toContain('2026-11-28');
    const emailInput = wrapper.findAll('form input')[0]!;
    expect((emailInput.element as HTMLInputElement).value).toBe('wave@acme.dev');
    expect(emailInput.attributes('readonly')).toBeDefined();
    const gh = new URL(
      wrapper.get('[data-testid="provider-github"]').attributes('href')!,
      'https://cloud.example',
    );
    expect(gh.searchParams.get('invite')).toBe(CODE);
    await wrapper.findAll('form input')[1]!.setValue('correct-horse-9');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.path === '/api/v1/auth/signup')!.body).toEqual({
      email: 'wave@acme.dev',
      password: 'correct-horse-9',
      invite: CODE,
    });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/onboarding'));
  });

  it('says when the invite link no longer works, with the waitlist', async () => {
    mockFetch({ 'POST /api/v1/auth/signup-invite': cloudProblem(404, 'invite-invalid') });
    const { wrapper } = await mountCloud(SignupPage, `/signup?invite=${CODE}`, { config: INVITE });
    expect(wrapper.get('[data-testid="signup-invite-invalid"]').text()).toContain('expired');
    expect(wrapper.find('[data-testid="signup-waitlist"]').exists()).toBe(true);
    expect(wrapper.find('form').exists()).toBe(false);
  });

  it('public mode shows the form to everyone, as before', async () => {
    mockFetch({});
    const { wrapper } = await mountCloud(SignupPage, '/signup');
    expect(wrapper.find('form').exists()).toBe(true);
    expect(wrapper.find('[data-testid="signup-waves"]').exists()).toBe(false);
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
    // Signing the others out asks first (ADR-219).
    await wrapper.get('[data-testid="revoke-others"]').trigger('click');
    await flushPromises();
    expect(dialogText('revoke-others')).toContain('Sign out everywhere else?');
    expect(dialogText('revoke-others')).toContain('1 other device is signed out at once');
    expect(dialogText('revoke-others')).toContain('This device stays signed in.');
    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="revoke-others-cancel"]'),
    );
    await cancel('revoke-others');
    expect(count(calls, 'DELETE', '/api/v1/auth/sessions')).toBe(0);
    expect(wrapper.findAll('[data-testid="sessions"] li')).toHaveLength(2);
    await wrapper.get('[data-testid="revoke-others"]').trigger('click');
    await flushPromises();
    await confirmTwice('revoke-others');
    expect(count(calls, 'DELETE', '/api/v1/auth/sessions')).toBe(1);
    expect(dialogOf('revoke-others')).toBeNull();
    expect(wrapper.findAll('[data-testid="sessions"] li')).toHaveLength(1);
    expect(wrapper.get('[data-testid="security-notice"]').text()).toContain(
      'Signed out of other sessions: 1.',
    );
  });

  it('signing another device out asks first; signing out here does not', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/auth/account': { status: 200, body: ACCOUNT },
      'GET /api/v1/auth/sessions': [
        { status: 200, body: SESSIONS },
        { status: 200, body: { sessions: [SESSIONS.sessions[0]] } },
      ],
      'DELETE /api/v1/auth/sessions/s2': { status: 204 },
      'DELETE /api/v1/auth/sessions/s1': { status: 204 },
    });
    const { wrapper } = await mountCloud(SecuritySettings, '/settings?tab=security', {
      signedIn: true,
    });
    const rows = () => wrapper.findAll('[data-testid="sessions"] li');
    await rows()[1]!.get('[data-testid="revoke-session"]').trigger('click');
    await flushPromises();
    const text = dialogText('revoke-session');
    expect(text).toContain('Sign this device out?');
    expect(text).toContain('Safari on iOS');
    expect(text).toContain('198.51.100.4');
    expect(text).toContain('It is signed out at once and has to sign in again.');
    await cancel('revoke-session');
    expect(count(calls, 'DELETE', '/api/v1/auth/sessions/s2')).toBe(0);
    expect(rows()).toHaveLength(2);
    await rows()[1]!.get('[data-testid="revoke-session"]').trigger('click');
    await flushPromises();
    await confirmTwice('revoke-session');
    expect(count(calls, 'DELETE', '/api/v1/auth/sessions/s2')).toBe(1);
    expect(rows()).toHaveLength(1);
    expect(toasts()).toEqual(['Signed out: Safari on iOS.']);
    // This device: its own "Sign out", at once.
    await rows()[0]!.get('[data-testid="revoke-session"]').trigger('click');
    await flushPromises();
    expect(dialogOf('revoke-session')).toBeNull();
    expect(count(calls, 'DELETE', '/api/v1/auth/sessions/s1')).toBe(1);
  });

  it('says a provider was linked, and why unlinking the last way in is refused', async () => {
    const linked = {
      ...ACCOUNT,
      password: false,
      identities: [{ provider: 'github', email: 'ada@gh', linkedAt: '2026-11-13T09:00:00Z' }],
    };
    const { calls } = mockFetch({
      'GET /api/v1/auth/account': { status: 200, body: linked },
      'GET /api/v1/auth/sessions': { status: 200, body: SESSIONS },
      'DELETE /api/v1/auth/identities/github': cloudProblem(409, 'last-sign-in-method'),
    });
    const { wrapper } = await mountCloud(SecuritySettings, '/settings?tab=security&linked=github', {
      signedIn: true,
      account: linked as Partial<Account>,
    });
    expect(wrapper.get('[data-testid="security-notice"]').text()).toContain('GitHub is linked');
    // Unlinking asks first; the server's refusal shows in the dialog and GitHub stays linked.
    await wrapper.get('[data-testid="unlink-github"]').trigger('click');
    await flushPromises();
    expect(dialogText('unlink')).toContain('Unlink GitHub?');
    expect(dialogText('unlink')).toContain('ada@gh');
    expect(dialogText('unlink')).toContain('You will no longer be able to sign in with GitHub.');
    expect(count(calls, 'DELETE', '/api/v1/auth/identities/github')).toBe(0);
    await confirm('unlink');
    expect(count(calls, 'DELETE', '/api/v1/auth/identities/github')).toBe(1);
    expect(errorOf('unlink')).toContain('only way to sign in');
    await cancel('unlink');
    expect(wrapper.find('[data-testid="unlink-github"]').exists()).toBe(true);
  });

  it('unlinks a provider after asking, and says so', async () => {
    const linked = {
      ...ACCOUNT,
      identities: [{ provider: 'github', email: 'ada@gh', linkedAt: '2026-11-13T09:00:00Z' }],
    };
    const { calls } = mockFetch({
      'GET /api/v1/auth/account': [
        { status: 200, body: linked },
        { status: 200, body: ACCOUNT },
      ],
      'GET /api/v1/auth/sessions': { status: 200, body: SESSIONS },
      'DELETE /api/v1/auth/identities/github': { status: 204 },
    });
    const { wrapper } = await mountCloud(SecuritySettings, '/settings?tab=security', {
      signedIn: true,
      account: linked as Partial<Account>,
    });
    await wrapper.get('[data-testid="unlink-github"]').trigger('click');
    await flushPromises();
    await cancel('unlink');
    expect(count(calls, 'DELETE', '/api/v1/auth/identities/github')).toBe(0);
    await wrapper.get('[data-testid="unlink-github"]').trigger('click');
    await flushPromises();
    await confirmTwice('unlink');
    expect(count(calls, 'DELETE', '/api/v1/auth/identities/github')).toBe(1);
    expect(dialogOf('unlink')).toBeNull();
    expect(wrapper.find('[data-testid="unlink-github"]').exists()).toBe(false);
    expect(toasts()).toEqual(['GitHub is no longer a way to sign in.']);
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
