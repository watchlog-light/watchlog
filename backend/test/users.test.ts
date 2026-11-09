// SPDX-License-Identifier: AGPL-3.0-only
// Multi-user (v0.3 slice 6, ADR-140): invites that never depend on SMTP (and are emailed
// when it is set up), expiry and new links, roles and who may change whom, reset links
// that sign a user out everywhere, removal, handing ownership over, the command-line
// reset, "Forgot your password?", and the role every mutating route declares.
import type { RouteOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { resetPassword } from '../src/cli.js';
import { declaredRoles } from '../src/plugins/auth.js';
import { SettingsService } from '../src/modules/settings/service.js';
import {
  ADMIN,
  closeTestContext,
  createTestContext,
  sessionCookie,
  setupAdmin,
  testConfig,
  type TestContext,
} from './helpers.js';
import { mailpitMessages, mailpitText, TEST_SMTP_URL } from './support/mock-providers.js';

let ctx: TestContext;
afterEach(() => closeTestContext(ctx));

const call = (method: string, url: string, cookie?: string, payload?: object) =>
  ctx.app.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    ...(cookie ? { cookies: { wl_session: cookie } } : {}),
    ...(payload ? { payload } : {}),
  });

const tokenOf = (link: string) => link.split('/').pop()!;

/** Invites someone and accepts as them; returns their id and session. */
async function join(owner: string, email: string, role: 'admin' | 'viewer') {
  const inv = await call('POST', '/users/invites', owner, { email, role });
  expect(inv.statusCode, inv.body).toBe(201);
  const acc = await call('POST', `/invites/${tokenOf(inv.json().link)}/accept`, undefined, {
    name: email.split('@')[0],
    password: 'a long enough password',
  });
  expect(acc.statusCode, acc.body).toBe(201);
  return { id: acc.json().user.id as string, cookie: sessionCookie(acc)! };
}

describe('invites', () => {
  it('without SMTP: a link to copy, copied again, accepted once', async () => {
    ctx = await createTestContext({ publicUrl: 'https://watchlog.company.com' });
    const owner = await setupAdmin(ctx.app);
    const res = await call('POST', '/users/invites', owner, {
      email: 'Lena@Example.com',
      role: 'viewer',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { link, emailed, invite } = res.json();
    expect(link).toMatch(/^https:\/\/watchlog\.company\.com\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(emailed).toBe(false);
    expect(invite).toMatchObject({
      email: 'lena@example.com',
      role: 'viewer',
      status: 'pending',
      invitedBy: 'Ada Admin',
    });
    // Stored as a hash and an encrypted copy, never in clear.
    const row = await ctx.db.selectFrom('invites').selectAll().executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(tokenOf(link));

    const list = (await call('GET', '/users', owner)).json();
    expect(list.smtp).toBe(false);
    expect(list.invites).toEqual([
      expect.objectContaining({ email: 'lena@example.com', status: 'pending' }),
    ]);
    // Copy link again: the same link.
    const again = await call('POST', `/users/invites/${invite.id}/link`, owner);
    expect(again.json().link).toBe(link);
    // One open invite per address; a member can't be invited.
    expect(
      (await call('POST', '/users/invites', owner, { email: 'lena@example.com', role: 'admin' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call('POST', '/users/invites', owner, { email: ADMIN.email, role: 'admin' }))
        .statusCode,
    ).toBe(409);

    // The accept page, then accepting.
    const info = await call('GET', `/invites/${tokenOf(link)}`);
    expect(info.json()).toMatchObject({
      email: 'lena@example.com',
      role: 'viewer',
      invitedBy: 'Ada Admin',
      status: 'pending',
      site: 'watchlog.company.com',
    });
    const short = await call('POST', `/invites/${tokenOf(link)}/accept`, undefined, {
      name: 'Lena',
      password: 'short',
    });
    expect(short.statusCode).toBe(400);
    const acc = await call('POST', `/invites/${tokenOf(link)}/accept`, undefined, {
      name: 'Lena Park',
      password: 'a long enough password',
    });
    expect(acc.statusCode, acc.body).toBe(201);
    expect(acc.json().user).toMatchObject({
      email: 'lena@example.com',
      name: 'Lena Park',
      role: 'viewer',
    });
    expect(sessionCookie(acc)).toBeTruthy();
    // Used: the link no longer works, the invite leaves the list, the copy is gone.
    expect(
      (
        await call('POST', `/invites/${tokenOf(link)}/accept`, undefined, {
          name: 'X',
          password: 'a long enough password',
        })
      ).statusCode,
    ).toBe(410);
    const after = (await call('GET', '/users', owner)).json();
    expect(after.invites).toEqual([]);
    expect(after.users.map((u: { email: string; role: string }) => `${u.role} ${u.email}`)).toEqual(
      ['owner admin@example.com', 'viewer lena@example.com'],
    );
    expect(
      (await ctx.db.selectFrom('invites').select('token_ciphertext').executeTakeFirstOrThrow())
        .token_ciphertext,
    ).toBeNull();
    expect(after.audit.map((a: { action: string }) => a.action)).toEqual([
      'invite_accepted',
      'invite_copied',
      'invite_created',
    ]);
  });

  it('with SMTP: also emailed; expired ones get a new link; revoked ones stop working', async () => {
    ctx = await createTestContext({
      smtp: { url: TEST_SMTP_URL, from: 'WatchLog <alerts@watchlog.test>' },
    });
    const owner = await setupAdmin(ctx.app);
    const to = `invite-${Date.now()}@example.com`;
    const res = await call('POST', '/users/invites', owner, { email: to, role: 'admin' });
    expect(res.json().emailed).toBe(true);
    const mails = await mailpitMessages(to);
    expect(mails).toHaveLength(1);
    const text = await mailpitText(mails[0]!.ID);
    expect(text).toContain('Ada Admin invited you to WatchLog');
    expect(text).toContain('as an Admin');
    expect(text).toContain(res.json().link);
    expect((await call('GET', '/users', owner)).json().smtp).toBe(true);

    // Expired: listed as such; its link can't be copied; a new link (new token) works.
    const id = res.json().invite.id as string;
    await ctx.db
      .updateTable('invites')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();
    expect((await call('GET', '/users', owner)).json().invites[0].status).toBe('expired');
    expect((await call('POST', `/users/invites/${id}/link`, owner)).statusCode).toBe(409);
    expect((await call('GET', `/invites/${tokenOf(res.json().link)}`)).json().status).toBe(
      'expired',
    );
    const renewed = await call('POST', `/users/invites/${id}/renew`, owner);
    expect(renewed.json().link).not.toBe(res.json().link);
    expect((await call('GET', `/invites/${tokenOf(res.json().link)}`)).statusCode).toBe(404);
    expect((await call('GET', `/invites/${tokenOf(renewed.json().link)}`)).json().status).toBe(
      'pending',
    );
    expect(await mailpitMessages(to)).toHaveLength(2);

    // Revoked: gone from the list, the link stops working.
    expect((await call('DELETE', `/users/invites/${id}`, owner)).statusCode).toBe(204);
    expect((await call('GET', '/users', owner)).json().invites).toEqual([]);
    expect(
      (
        await call('POST', `/invites/${tokenOf(renewed.json().link)}/accept`, undefined, {
          name: 'S',
          password: 'a long enough password',
        })
      ).statusCode,
    ).toBe(410);
  });
});

describe('roles', () => {
  it('Admins manage Admins and Viewers; Viewers change nothing; nobody touches the Owner', async () => {
    ctx = await createTestContext();
    const owner = await setupAdmin(ctx.app);
    const ownerId = (await call('GET', '/me', owner)).json().user.id as string;
    const admin = await join(owner, 'lena@example.com', 'admin');
    const viewer = await join(owner, 'omar@example.com', 'viewer');

    // A Viewer sees the list (without the log) and can't invite.
    const seen = (await call('GET', '/users', viewer.cookie)).json();
    expect(seen.users).toHaveLength(3);
    expect(seen.users.find((u: { you: boolean }) => u.you).email).toBe('omar@example.com');
    expect(seen.audit).toEqual([]);
    const refused = await call('POST', '/users/invites', viewer.cookie, {
      email: 'x@example.com',
      role: 'viewer',
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().detail).toBe("Viewers can't change this. Ask an Admin.");
    // Viewers can't silence alerts either (ADR-140).
    expect(
      (
        await call('POST', '/silences', viewer.cookie, {
          matchers: { namespace: 'shop' },
          durationMinutes: 60,
        })
      ).statusCode,
    ).toBe(403);

    // An Admin promotes the Viewer, invites an Admin, but can't touch the Owner or itself.
    expect(
      (await call('PATCH', `/users/${viewer.id}`, admin.cookie, { role: 'admin' })).statusCode,
    ).toBe(204);
    expect((await call('GET', '/me', viewer.cookie)).json().user.role).toBe('admin');
    expect(
      (
        await call('POST', '/users/invites', admin.cookie, {
          email: 'sam@example.com',
          role: 'admin',
        })
      ).statusCode,
    ).toBe(201);
    for (const [method, url, body] of [
      ['PATCH', `/users/${ownerId}`, { role: 'viewer' }],
      ['POST', `/users/${ownerId}/reset-link`],
      ['DELETE', `/users/${ownerId}`],
      ['PATCH', `/users/${admin.id}`, { role: 'viewer' }],
      ['POST', `/users/${viewer.id}/owner`],
    ] as const) {
      expect(
        (await call(method, url, admin.cookie, body as object | undefined)).statusCode,
        `${method} ${url}`,
      ).toBe(403);
    }
    // Only the Owner deletes clusters.
    const cluster = (
      await call('POST', '/clusters', owner, { name: 'prod', kind: 'kubernetes' })
    ).json().cluster.id;
    expect((await call('DELETE', `/clusters/${cluster}`, admin.cookie)).statusCode).toBe(403);
    expect((await call('DELETE', `/clusters/${cluster}`, owner)).statusCode).toBe(204);
  });

  it('hands ownership to an Admin, in one step', async () => {
    ctx = await createTestContext();
    const owner = await setupAdmin(ctx.app);
    const admin = await join(owner, 'lena@example.com', 'admin');
    const viewer = await join(owner, 'omar@example.com', 'viewer');
    expect((await call('POST', `/users/${viewer.id}/owner`, owner)).statusCode).toBe(400);
    expect((await call('POST', `/users/${admin.id}/owner`, owner)).statusCode).toBe(204);
    const users = (await call('GET', '/users', admin.cookie)).json().users;
    expect(users.map((u: { email: string; role: string }) => `${u.role} ${u.email}`)).toEqual([
      'owner lena@example.com',
      'admin admin@example.com',
      'viewer omar@example.com',
    ]);
    expect((await call('GET', '/users', admin.cookie)).json().audit[0]).toMatchObject({
      action: 'ownership_transferred',
      actor: 'Ada Admin',
      subject: 'lena@example.com',
    });
  });
});

describe('password resets and removal', () => {
  it('a reset link works once for an hour; setting a password signs the user out everywhere', async () => {
    ctx = await createTestContext({ publicUrl: 'https://watchlog.company.com/' });
    const owner = await setupAdmin(ctx.app);
    const omar = await join(owner, 'omar@example.com', 'viewer');
    const res = await call('POST', `/users/${omar.id}/reset-link`, owner);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      link: expect.stringMatching(/^https:\/\/watchlog\.company\.com\/reset\//),
      emailed: false,
    });
    const token = tokenOf(res.json().link);
    // The old password keeps working until a new one is set.
    expect(
      (
        await call('POST', '/auth/login', undefined, {
          email: 'omar@example.com',
          password: 'a long enough password',
        })
      ).statusCode,
    ).toBe(200);
    expect((await call('GET', `/password-resets/${token}`)).json()).toMatchObject({
      email: 'omar@example.com',
      status: 'valid',
    });
    const set = await call('POST', `/password-resets/${token}`, undefined, {
      password: 'a brand new password',
    });
    expect(set.statusCode, set.body).toBe(200);
    expect((await call('GET', '/me', omar.cookie)).statusCode).toBe(401);
    expect((await call('GET', '/me', sessionCookie(set)!)).statusCode).toBe(200);
    expect(
      (
        await call('POST', '/auth/login', undefined, {
          email: 'omar@example.com',
          password: 'a long enough password',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await call('POST', `/password-resets/${token}`, undefined, {
          password: 'another new password',
        })
      ).statusCode,
    ).toBe(410);
    // An hour later a fresh link has expired.
    const late = tokenOf((await call('POST', `/users/${omar.id}/reset-link`, owner)).json().link);
    await ctx.db
      .updateTable('password_resets')
      .set({ expires_at: new Date(Date.now() - 1) })
      .where('used_at', 'is', null)
      .execute();
    expect(
      (
        await call('POST', `/password-resets/${late}`, undefined, {
          password: 'another new password',
        })
      ).statusCode,
    ).toBe(410);
  });

  it('removing a user signs them out and revokes their tokens; what they made stays', async () => {
    ctx = await createTestContext();
    const owner = await setupAdmin(ctx.app);
    const lena = await join(owner, 'lena@example.com', 'admin');
    const token = (await call('POST', '/api-tokens', lena.cookie, { name: 'mcp' })).json()
      .value as string;
    const rule = await call('POST', '/alert-rules', lena.cookie, {
      name: 'cpu',
      metric: 'node.cpu.utilization',
      clusterId: null,
      scope: {},
      condition: { op: '>', value: 0.9 },
      forSeconds: 0,
      severity: 'warning',
      channelIds: [],
    });
    expect(rule.statusCode, rule.body).toBe(201);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/clusters',
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
    expect((await call('DELETE', `/users/${lena.id}`, owner)).statusCode).toBe(204);
    expect((await call('GET', '/me', lena.cookie)).statusCode).toBe(401);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/clusters',
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await call('GET', '/alert-rules', owner))
        .json()
        .rules.some((r: { id: string }) => r.id === rule.json().id),
    ).toBe(true);
    expect((await call('GET', '/users', owner)).json().audit[0]).toMatchObject({
      action: 'user_removed',
      subject: 'lena@example.com',
      details: { role: 'admin', tokensRevoked: 1 },
    });
  });
});

describe('a locked-out Owner', () => {
  it('gets a reset link from the command line; every use is audited', async () => {
    ctx = await createTestContext();
    const owner = await setupAdmin(ctx.app);
    await join(owner, 'omar@example.com', 'viewer');
    const settings = new SettingsService(ctx.db, testConfig());
    await expect(resetPassword(ctx.db, settings, {})).rejects.toThrow(
      /Public URL setting is empty/,
    );
    const out = await resetPassword(ctx.db, settings, { url: 'https://watchlog.company.com/' });
    expect(out).toMatch(
      /^Reset link for admin@example\.com \(works once, valid for 1 hour\):\nhttps:\/\/watchlog\.company\.com\/reset\/[A-Za-z0-9_-]{43}$/,
    );
    const other = await resetPassword(ctx.db, settings, {
      email: 'omar@example.com',
      url: 'https://w.example',
    });
    expect(other).toContain('omar@example.com');
    await expect(
      resetPassword(ctx.db, settings, { email: 'nobody@example.com', url: 'https://w.example' }),
    ).rejects.toThrow(/No user/);
    const set = await call('POST', `/password-resets/${out.split('/').pop()}`, undefined, {
      password: 'the owner is back',
    });
    expect(set.statusCode).toBe(200);
    const log = (await call('GET', '/users', sessionCookie(set)!)).json().audit;
    expect(
      log.map((a: { action: string; actor: string }) => `${a.action} ${a.actor}`).slice(0, 3),
    ).toEqual([
      'password_reset admin@example.com',
      'reset_link_created command line',
      'reset_link_created command line',
    ]);
  });

  it('"Forgot your password?" emails a link when SMTP is set up, and points to the command otherwise', async () => {
    ctx = await createTestContext();
    await setupAdmin(ctx.app);
    expect((await call('GET', '/setup')).json().smtp).toBe(false);
    const off = await call('POST', '/auth/forgot-password', undefined, { email: ADMIN.email });
    expect(off.statusCode).toBe(409);
    expect(off.json().detail).toContain('watchlog admin reset-password');
    await closeTestContext(ctx);

    ctx = await createTestContext({
      smtp: { url: TEST_SMTP_URL, from: 'WatchLog <alerts@watchlog.test>' },
    });
    const owner = await setupAdmin(ctx.app);
    const email = `forgot-${Date.now()}@example.com`;
    await join(owner, email, 'viewer');
    expect((await call('GET', '/setup')).json().smtp).toBe(true);
    for (const e of [email, `nobody-${Date.now()}@example.com`]) {
      const r = await call('POST', '/auth/forgot-password', undefined, { email: e });
      expect(r.statusCode).toBe(202);
      expect(r.json()).toEqual({ emailed: true });
    }
    // The invite, then the reset link.
    const mails = await mailpitMessages(email);
    expect(mails).toHaveLength(2);
    expect(await mailpitText(mails[1]!.ID)).toMatch(/\/reset\/[A-Za-z0-9_-]{43}/);
  });
});

describe('every mutating route declares its roles (ADR-140)', () => {
  it('the route walk', async () => {
    const routes = new Map<string, string>();
    const onRoute = (r: RouteOptions) => {
      for (const method of [r.method].flat()) {
        if (['GET', 'HEAD', 'OPTIONS'].includes(method) || !r.url.startsWith('/api/v1/')) continue;
        routes.set(`${method} ${r.url}`, declaredRoles(r.preHandler)?.join(',') ?? 'NONE');
      }
    };
    ctx = await createTestContext({}, { onRoute });
    // Public routes (no session): first-run setup, signing in and out, the demo entry,
    // and the links in invites and resets. Everything else names its roles.
    const PUBLIC = [
      'POST /api/v1/setup',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/forgot-password',
      'POST /api/v1/demo/session',
      'POST /api/v1/invites/:token/accept',
      'POST /api/v1/password-resets/:token',
    ];
    const undeclared = [...routes]
      .filter(([k, v]) => v === 'NONE' && !PUBLIC.includes(k))
      .map(([k]) => k);
    expect(undeclared, 'a mutating route without requireRole').toEqual([]);
    const ALL = 'owner,admin,viewer';
    const OWNER = 'owner';
    const expected: Record<string, string> = {
      'POST /api/v1/api-tokens': ALL,
      'DELETE /api/v1/api-tokens/:id': ALL,
      'POST /api/v1/query/range': ALL,
      'DELETE /api/v1/clusters/:id': OWNER,
      'POST /api/v1/users/:id/owner': OWNER,
    };
    for (const [route, roles] of routes) {
      if (PUBLIC.includes(route)) continue;
      // Everything else changes something: Owners and Admins only.
      expect(roles, route).toBe(expected[route] ?? 'owner,admin');
    }
    expect(routes.size).toBeGreaterThan(40);
  });
});
