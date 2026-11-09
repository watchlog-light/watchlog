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
import { mockFetch, USER } from './fetch-mock';
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
    expect(w.get('[role="alert"]').text()).toBe('Use at least 12 characters.');
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
