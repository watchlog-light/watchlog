// SPDX-License-Identifier: AGPL-3.0-only
// Users and invites for the responsive suite (v0.3 slice 6): the mock-up's people, open
// invites and log, and the public link pages; shapes as GET /users, /invites/:token and
// /password-resets/:token answer them. The suite creates no user, invite or link.

const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const DAY = 86_400_000;

export const users = (smtp: boolean) => ({
  users: [
    {
      id: '01a1d000-0000-7000-8000-000000000001',
      name: 'Mohammad',
      email: 'mohammad@example.com',
      role: 'owner',
      you: true,
      lastActiveAt: at(0),
      tokens: 1,
    },
    {
      id: '01a1d000-0000-7000-8000-000000000002',
      name: 'Lena Park',
      email: 'lena@example.com',
      role: 'admin',
      you: false,
      lastActiveAt: at(-2 * 3_600_000),
      tokens: 2,
    },
    {
      id: '01a1d000-0000-7000-8000-000000000003',
      name: 'Omar Haddad',
      email: 'omar@example.com',
      role: 'viewer',
      you: false,
      lastActiveAt: at(-DAY),
      tokens: 1,
    },
  ],
  invites: [
    {
      id: '01a1d000-0000-7000-8000-000000000004',
      email: 'oncall@example.com',
      role: 'viewer',
      status: 'pending',
      invitedBy: 'Mohammad',
      createdAt: at(-DAY),
      expiresAt: at(6 * DAY),
      emailed: smtp,
    },
    {
      id: '01a1d000-0000-7000-8000-000000000005',
      email: 'sam@example.com',
      role: 'admin',
      status: 'expired',
      invitedBy: 'Mohammad',
      createdAt: at(-9 * DAY),
      expiresAt: at(-2 * DAY),
      emailed: false,
    },
  ],
  smtp,
  audit: [
    {
      action: 'invite_created',
      actor: 'Mohammad',
      subject: 'oncall@example.com',
      ip: '10.0.4.17',
      at: at(-DAY),
      details: { role: 'viewer' },
    },
    {
      action: 'role_changed',
      actor: 'Mohammad',
      subject: 'lena@example.com',
      ip: '10.0.4.17',
      at: at(-3 * DAY),
      details: { from: 'viewer', to: 'admin' },
    },
  ],
});

export const viewerUsers = () => {
  const u = users(false);
  return {
    ...u,
    users: u.users.map((x) => ({ ...x, you: x.email === 'omar@example.com' })),
    audit: [],
  };
};

export const createdInvite = {
  invite: {
    id: '01a1d000-0000-7000-8000-000000000006',
    email: 'dev@example.com',
    role: 'viewer',
    status: 'pending',
    invitedBy: 'Mohammad',
    createdAt: at(0),
    expiresAt: at(7 * DAY),
    emailed: false,
  },
  link: 'https://watchlog.company.com/invite/7fK2c9QxLm3tVb8nEXAMPLExEXAMPLExEXAMPLEx1',
  expiresAt: at(7 * DAY),
  emailed: false,
};

export const resetLink = {
  link: 'https://watchlog.company.com/reset/Qm8xT2vK9pLr4wZcEXAMPLExEXAMPLExEXAMPLEx1',
  expiresAt: at(3_600_000),
  emailed: true,
};

export const TOKEN = 'e2eEXAMPLExEXAMPLExEXAMPLExEXAMPLExEXAMPLE1';
export const invite = (status: 'pending' | 'expired') => ({
  email: 'dev@example.com',
  role: 'viewer',
  invitedBy: 'Mohammad',
  expiresAt: at(status === 'pending' ? 6 * DAY : -DAY),
  status,
  site: 'watchlog.company.com',
});
export const reset = { email: 'omar@example.com', status: 'valid', expiresAt: at(3_600_000) };

export const viewerMe = {
  user: {
    id: '01a1d000-0000-7000-8000-000000000003',
    email: 'omar@example.com',
    name: 'Omar Haddad',
    locale: 'en',
    role: 'viewer',
    org: {
      id: '01a1d000-0000-7000-8000-0000000000aa',
      name: 'Default',
      slug: 'default',
      plan: 'community',
    },
  },
};
