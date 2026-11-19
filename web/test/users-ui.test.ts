// SPDX-License-Identifier: AGPL-3.0-only
// Multi-user in the dashboard (v0.3 slice 6, ADR-140, the Users and invites mock-ups):
// Settings → Users for an Owner and a Viewer, inviting without SMTP (a link to copy),
// the accept page and its expired state, the reset page, and "Forgot your password?".
import { flushPromises, mount } from '@vue/test-utils';
import type { UserList } from '@watchlog/api-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UsersSettings from '@/components/settings/UsersSettings.vue';
import { useAuthStore } from '@/stores/auth';
import AcceptInvitePage from '@/views/AcceptInvitePage.vue';
import LoginPage from '@/views/LoginPage.vue';
import ResetPasswordPage from '@/views/ResetPasswordPage.vue';
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

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const now = Date.now();
const iso = (ms: number) => new Date(now + ms).toISOString();
const LIST: UserList = {
  users: [
    {
      id: 'me',
      name: 'Mohammad',
      email: 'mohammad@example.com',
      role: 'owner',
      you: true,
      lastActiveAt: iso(0),
      tokens: 1,
    },
    {
      id: 'lena',
      name: 'Lena Park',
      email: 'lena@example.com',
      role: 'admin',
      you: false,
      lastActiveAt: iso(-2 * 3_600_000),
      tokens: 2,
    },
    {
      id: 'omar',
      name: 'Omar Haddad',
      email: 'omar@example.com',
      role: 'viewer',
      you: false,
      lastActiveAt: iso(-86_400_000),
      tokens: 1,
    },
  ],
  invites: [
    {
      id: 'i1',
      email: 'oncall@example.com',
      role: 'viewer',
      status: 'pending',
      invitedBy: 'Mohammad',
      createdAt: iso(-86_400_000),
      expiresAt: iso(6 * 86_400_000),
      emailed: false,
    },
    {
      id: 'i2',
      email: 'sam@example.com',
      role: 'admin',
      status: 'expired',
      invitedBy: 'Mohammad',
      createdAt: iso(-9 * 86_400_000),
      expiresAt: iso(-2 * 86_400_000),
      emailed: false,
    },
  ],
  smtp: false,
  audit: [
    {
      action: 'invite_created',
      actor: 'Mohammad',
      subject: 'oncall@example.com',
      ip: '10.0.0.4',
      at: iso(-86_400_000),
      details: { role: 'viewer' },
    },
  ],
};

async function mountAt(component: unknown, path: string, role = 'owner', signedIn = true) {
  const plugins = await createPlugins(path);
  if (signedIn) useAuthStore().user = { ...USER, role: role as typeof USER.role };
  const w = mount(component as never, {
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    attachTo: document.body,
  });
  await flushPromises();
  return { w, router: plugins.router };
}

describe('Settings → Users: taking access away asks first (ADR-219)', () => {
  const emails = (w: { findAll: (s: string) => { text: () => string }[] }) =>
    w.findAll('[data-testid="user-row"]').map((r) => r.text());
  const without = (id: string): UserList => ({
    ...LIST,
    users: LIST.users.filter((u) => u.id !== id),
    invites: LIST.invites.filter((i) => i.id !== id),
  });

  it('removing a person: asks, Cancel changes nothing, Remove calls once, the row goes', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/users': [
        { status: 200, body: LIST },
        { status: 200, body: without('omar') },
      ],
      'DELETE /api/v1/users/omar': { status: 204 },
    });
    const { w } = await mountAt(UsersSettings, '/settings?tab=users');
    const omar = () => w.findAll('[data-testid="user-row"]').find((r) => r.text().includes('Omar'));
    await omar()!.get('[data-testid="remove"]').trigger('click');
    await flushPromises();
    const text = dialogText('remove');
    expect(text).toContain('Remove Omar Haddad?');
    expect(text).toContain('omar@example.com');
    expect(text).toContain('They lose access right away and are signed out.');
    expect(text).toContain('Their API token is revoked');
    expect(document.activeElement).toBe(document.querySelector('[data-testid="remove-cancel"]'));
    expect(document.querySelector('[data-testid="remove-confirm"]')!.className).toContain(
      'bg-critical',
    );

    await cancel('remove');
    expect(dialogOf('remove')).toBeNull();
    expect(count(calls, 'DELETE', '/api/v1/users/omar')).toBe(0);
    expect(omar()).toBeDefined();

    await omar()!.get('[data-testid="remove"]').trigger('click');
    await flushPromises();
    await confirmTwice('remove');
    expect(count(calls, 'DELETE', '/api/v1/users/omar')).toBe(1);
    expect(dialogOf('remove')).toBeNull();
    expect(omar()).toBeUndefined();
    expect(toasts()).toEqual(['Omar Haddad was removed.']);
    w.unmount();
  });

  it('revoking a pending invite and removing an expired one: each asks, then the row goes', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/users': [
        { status: 200, body: LIST },
        { status: 200, body: without('i1') },
        { status: 200, body: { ...without('i1'), invites: [] } },
      ],
      'DELETE /api/v1/users/invites/i1': { status: 204 },
      'DELETE /api/v1/users/invites/i2': { status: 204 },
    });
    const { w } = await mountAt(UsersSettings, '/settings?tab=users');
    const row = (email: string) =>
      w.findAll('[data-testid="user-row"]').find((r) => r.text().includes(email));

    // Pending: the button says Revoke.
    expect(row('oncall@example.com')!.get('[data-testid="revoke"]').text()).toBe('Revoke');
    await row('oncall@example.com')!.get('[data-testid="revoke"]').trigger('click');
    await flushPromises();
    expect(count(calls, 'DELETE', '/api/v1/users/invites/i1')).toBe(0);
    let text = dialogText('revoke');
    expect(text).toContain('Revoke this invite?');
    expect(text).toContain('oncall@example.com');
    expect(text).toContain('The invite link stops working at once.');
    expect(document.querySelector('[data-testid="revoke-confirm"]')!.textContent!.trim()).toBe(
      'Revoke invite',
    );
    expect(document.activeElement).toBe(document.querySelector('[data-testid="revoke-cancel"]'));
    await cancel('revoke');
    expect(count(calls, 'DELETE', '/api/v1/users/invites/i1')).toBe(0);
    expect(row('oncall@example.com')).toBeDefined();
    await row('oncall@example.com')!.get('[data-testid="revoke"]').trigger('click');
    await flushPromises();
    await confirmTwice('revoke');
    expect(count(calls, 'DELETE', '/api/v1/users/invites/i1')).toBe(1);
    expect(row('oncall@example.com')).toBeUndefined();
    expect(toasts()).toEqual(['Invite for oncall@example.com revoked.']);

    // Expired: the same button says Remove, and asks too.
    expect(row('sam@example.com')!.get('[data-testid="revoke"]').text()).toBe('Remove');
    await row('sam@example.com')!.get('[data-testid="revoke"]').trigger('click');
    await flushPromises();
    text = dialogText('revoke');
    expect(text).toContain('Remove this expired invite?');
    expect(text).toContain('sam@example.com');
    expect(document.querySelector('[data-testid="revoke-confirm"]')!.textContent!.trim()).toBe(
      'Remove invite',
    );
    expect(count(calls, 'DELETE', '/api/v1/users/invites/i2')).toBe(0);
    await confirm('revoke');
    expect(count(calls, 'DELETE', '/api/v1/users/invites/i2')).toBe(1);
    expect(row('sam@example.com')).toBeUndefined();
    expect(toasts()).toContain('Invite for sam@example.com removed.');
    expect(emails(w)).toHaveLength(3);
    w.unmount();
  });

  it('a refusal is shown in the dialog and the row stays', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/users': { status: 200, body: LIST },
      'DELETE /api/v1/users/omar': problem(403, 'Only the Owner can remove an Admin.'),
      'DELETE /api/v1/users/invites/i1': problem(404, 'This invite no longer exists.'),
    });
    const { w } = await mountAt(UsersSettings, '/settings?tab=users');
    const row = (text: string) =>
      w.findAll('[data-testid="user-row"]').find((r) => r.text().includes(text));
    await row('Omar')!.get('[data-testid="remove"]').trigger('click');
    await flushPromises();
    await confirm('remove');
    expect(errorOf('remove')).toBe('Only the Owner can remove an Admin.');
    expect(dialogOf('remove')).not.toBeNull();
    await cancel('remove');
    expect(row('Omar')).toBeDefined();

    await row('oncall@example.com')!.get('[data-testid="revoke"]').trigger('click');
    await flushPromises();
    await confirm('revoke');
    expect(errorOf('revoke')).toBe('This invite no longer exists.');
    await cancel('revoke');
    expect(row('oncall@example.com')).toBeDefined();
    expect(toasts()).toEqual([]);
    // Nothing was reloaded: the list is as the server last sent it.
    expect(count(calls, 'GET', '/api/v1/users')).toBe(1);
    w.unmount();
  });

  it('a Viewer’s Remove and Revoke are disabled, as every control there is', async () => {
    mockFetch({
      'GET /api/v1/users': {
        status: 200,
        body: {
          ...LIST,
          users: LIST.users.map((u) => ({ ...u, you: u.id === 'omar' })),
          audit: [],
        },
      },
    });
    const { w } = await mountAt(UsersSettings, '/settings?tab=users', 'viewer');
    const buttons = w.findAll('[data-testid="remove"], [data-testid="revoke"]');
    expect(buttons.length).toBeGreaterThan(0);
    // A disabled fieldset: no mouse, keyboard or screen reader can press them. The server
    // refuses a Viewer too (backend/test/users.test.ts walks every route by role).
    for (const b of buttons) expect(b.element.closest('fieldset')?.disabled).toBe(true);
    w.unmount();
  });
});

describe('Settings → Users', () => {
  it('shows people and invites with their actions, and invites by link without SMTP', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/users': { status: 200, body: LIST },
      'POST /api/v1/users/invites': {
        status: 201,
        body: {
          invite: { ...LIST.invites[0]!, id: 'i3', email: 'dev@example.com', role: 'admin' },
          link: 'https://watchlog.company.com/invite/7fK2c9QxLm3tVb8n',
          expiresAt: iso(7 * 86_400_000),
          emailed: false,
        },
      },
      'PATCH /api/v1/users/omar': { status: 204 },
    });
    const { w } = await mountAt(UsersSettings, '/settings?tab=users');
    const rows = w.findAll('[data-testid="user-row"]');
    expect(rows.map((r) => r.attributes('data-status'))).toEqual([
      'active',
      'active',
      'active',
      'pending',
      'expired',
    ]);
    expect(rows[0]!.text()).toContain('Mohammad (you)');
    expect(rows[0]!.get('[data-testid="role-fixed"]').text()).toBe('Owner');
    expect(rows[1]!.text()).toContain('Make Owner');
    expect(rows[2]!.text()).toContain('Reset password');
    expect(rows[3]!.text()).toContain('Pending invite');
    expect(rows[3]!.text()).toContain('Copy link');
    expect(rows[4]!.text()).toContain('New link');
    expect(w.get('[data-testid="smtp-banner"]').text()).toContain("Email isn't set up");
    expect(w.findAll('[data-role-card]').map((c) => c.attributes('data-role-card'))).toEqual([
      'viewer',
      'admin',
      'owner',
    ]);
    expect(w.get('[data-role-card="viewer"]').text()).toContain('Silence alerts');
    expect(w.get('[data-testid="audit"]').text()).toContain('Invited oncall@example.com as viewer');

    await rows[2]!.get('[data-testid="role"]').setValue('admin');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ role: 'admin' });
    // The server answers 204 with no body: that is a success, said and reloaded.
    expect(toasts()).toEqual(['Omar Haddad is now Admin.']);
    expect(count(calls, 'GET', '/api/v1/users')).toBe(2);

    await w.get('[data-testid="invite"]').trigger('click');
    await flushPromises();
    const form = document.body.querySelector('[data-testid="invite-form"]')!;
    expect(form.textContent).toContain("Email isn't set up: you'll get a link to send yourself.");
    const email = form.querySelector('input[type="email"]') as HTMLInputElement;
    email.value = 'dev@example.com';
    email.dispatchEvent(new Event('input'));
    (form.querySelector('[data-invite-role="admin"] input') as HTMLInputElement).click();
    await flushPromises();
    (document.body.querySelector('[data-testid="invite-submit"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(calls.find((c) => c.path === '/api/v1/users/invites')!.body).toEqual({
      email: 'dev@example.com',
      role: 'admin',
    });
    const link = document.body.querySelector('[data-testid="link-dialog"]')!;
    expect(link.querySelector('[data-testid="link"]')!.textContent).toBe(
      'https://watchlog.company.com/invite/7fK2c9QxLm3tVb8n',
    );
    expect(link.querySelector('[data-testid="not-emailed"]')!.textContent).toContain(
      'nothing was sent',
    );
    w.unmount();
  });

  it('shows a Viewer the same page, with every control locked', async () => {
    mockFetch({
      'GET /api/v1/users': {
        status: 200,
        body: {
          ...LIST,
          users: LIST.users.map((u) => ({ ...u, you: u.id === 'omar' })),
          audit: [],
        },
      },
    });
    const { w } = await mountAt(UsersSettings, '/settings?tab=users', 'viewer');
    expect(w.get('[data-testid="viewer-banner"]').text()).toContain(
      'ask an Admin, for example lena@example.com',
    );
    expect(w.get('[data-testid="invite"]').element.closest('fieldset')?.disabled).toBe(true);
    expect(w.find('[data-testid="role"]').exists()).toBe(false);
    for (const b of w.findAll(
      '[data-testid="reset-link"], [data-testid="copy-link"], [data-testid="revoke"]',
    )) {
      expect(b.element.closest('fieldset')?.disabled).toBe(true);
    }
    expect(w.find('[data-testid="audit"]').exists()).toBe(false);
    w.unmount();
  });
});

describe('the links', () => {
  it('accepts an invite and signs in; an expired one says who to ask', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/invites/tok_valid_0123456789abcdef': {
        status: 200,
        body: {
          email: 'dev@example.com',
          role: 'viewer',
          invitedBy: 'Mohammad',
          expiresAt: iso(6 * 86_400_000),
          status: 'pending',
          site: 'watchlog.company.com',
        },
      },
      'POST /api/v1/invites/tok_valid_0123456789abcdef/accept': {
        status: 201,
        body: { user: { ...USER, role: 'viewer' } },
      },
      'GET /api/v1/invites/tok_old_0123456789abcdefgh': {
        status: 200,
        body: {
          email: 'dev@example.com',
          role: 'viewer',
          invitedBy: 'Mohammad',
          expiresAt: iso(-1000),
          status: 'expired',
          site: 'watchlog.company.com',
        },
      },
    });
    const { w, router } = await mountAt(
      AcceptInvitePage,
      '/invite/tok_valid_0123456789abcdef',
      'owner',
      false,
    );
    expect(w.text()).toContain('Mohammad invited you to watchlog.company.com as a Viewer.');
    const inputs = w.findAll('input');
    await inputs[1]!.setValue('Dev Person');
    await inputs[2]!.setValue('short');
    await w.get('form').trigger('submit');
    await flushPromises();
    // The server's minimum is 10 (the page said 12 until 0.9.9), said under the field.
    expect(w.get('[data-testid="password-error"]').text()).toContain(
      'This is too short: use at least 10 characters.',
    );
    await inputs[2]!.setValue('ten chars!');
    expect(w.get('[data-rule="length"]').attributes('data-state')).toBe('ok');
    await inputs[2]!.setValue('a long enough password');
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      name: 'Dev Person',
      password: 'a long enough password',
    });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
    w.unmount();

    const old = await mountAt(
      AcceptInvitePage,
      '/invite/tok_old_0123456789abcdefgh',
      'owner',
      false,
    );
    expect(old.w.text()).toContain('This invite has expired');
    expect(old.w.text()).toContain('Ask Mohammad for a new one');
    old.w.unmount();
  });

  it('sets a new password from a reset link', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/password-resets/tok_reset_0123456789abcde': {
        status: 200,
        body: { email: 'omar@example.com', status: 'valid', expiresAt: iso(3_600_000) },
      },
      'POST /api/v1/password-resets/tok_reset_0123456789abcde': {
        status: 200,
        body: { user: { ...USER, role: 'viewer' } },
      },
    });
    const { w, router } = await mountAt(
      ResetPasswordPage,
      '/reset/tok_reset_0123456789abcde',
      'owner',
      false,
    );
    expect(w.text()).toContain('For omar@example.com.');
    await w.get('input').setValue('a brand new password');
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      password: 'a brand new password',
    });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
    w.unmount();
  });

  it('Cloud with 2FA on: the reset sets the password, then asks for the code', async () => {
    mockFetch({
      'GET /api/v1/password-resets/tok_reset_0123456789abcde': {
        status: 200,
        body: { email: 'omar@example.com', status: 'valid', expiresAt: iso(3_600_000) },
      },
      'POST /api/v1/password-resets/tok_reset_0123456789abcde': {
        status: 202,
        body: { mfaRequired: true },
      },
    });
    const { w, router } = await mountAt(
      ResetPasswordPage,
      '/reset/tok_reset_0123456789abcde',
      'owner',
      false,
    );
    await w.get('input').setValue('a brand new password');
    await w.get('form').trigger('submit');
    await flushPromises();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('signin-2fa'));
    expect(useAuthStore().user).toBeNull();
    w.unmount();
  });

  it('Cloud: no "Reset password" button (an account there spans orgs)', async () => {
    mockFetch({ 'GET /api/v1/users': { status: 200, body: LIST } });
    const plugins = await createPlugins('/settings?tab=users');
    const auth = useAuthStore();
    auth.user = { ...USER, role: 'owner' };
    auth.cloud = {
      signup: true,
      signupMode: 'public',
      providers: { github: false, google: false },
      turnstileSiteKey: null,
      passwordMinLength: 10,
      verifyGraceDays: 7,
      supportEmail: 'support@watchlog.io',
      sampleUrl: 'https://demo.watchlog.io',
    };
    const w = mount(UsersSettings as never, {
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
      attachTo: document.body,
    });
    await flushPromises();
    expect(w.findAll('[data-testid="user-row"]').length).toBeGreaterThan(2);
    expect(w.find('[data-testid="reset-link"]').exists()).toBe(false);
    expect(w.text()).not.toContain('Reset password');
    w.unmount();
  });

  it('"Forgot your password?" emails a link with SMTP, and shows the command without', async () => {
    for (const smtp of [false, true]) {
      const { calls } = mockFetch({
        'POST /api/v1/auth/forgot-password': { status: 202, body: { emailed: true } },
      });
      const { w } = await mountAt(LoginPage, '/login', 'owner', false);
      useAuthStore().smtp = smtp;
      await w.get('[data-testid="forgot"]').trigger('click');
      await flushPromises();
      if (!smtp) {
        const cli = document.body.querySelector('[data-testid="forgot-cli"]')!;
        expect(cli.textContent).toContain('kubectl exec -n watchlog deploy/watchlog-backend');
        expect(cli.textContent).toContain('docker exec watchlog-backend-1');
        expect(cli.textContent).toContain('watchlog admin reset-password');
        expect(cli.textContent).toContain('you@example.com');
      } else {
        const form = document.body.querySelector('[data-testid="forgot-email"]') as HTMLFormElement;
        const input = form.querySelector('input') as HTMLInputElement;
        input.value = 'omar@example.com';
        input.dispatchEvent(new Event('input'));
        form.dispatchEvent(new Event('submit'));
        await flushPromises();
        expect(calls[0]!.body).toEqual({ email: 'omar@example.com' });
        expect(document.body.querySelector('[data-testid="forgot-sent"]')!.textContent).toContain(
          'a link is on its way',
        );
      }
      w.unmount();
      document.body.innerHTML = '';
    }
  });
});
