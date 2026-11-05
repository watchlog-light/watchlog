// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/lib/tokens.js';
import { SESSION_REFRESH_MS } from '../src/modules/auth/sessions.js';
import {
  ADMIN,
  closeTestContext,
  createTestContext,
  sessionCookie,
  setupAdmin,
  type TestContext,
} from './helpers.js';

describe('login, logout and /me', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
    await setupAdmin(ctx.app);
  });

  afterEach(() => closeTestContext(ctx));

  const login = (email: string, password: string) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  const me = (cookie?: string) =>
    ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      ...(cookie ? { cookies: { wl_session: cookie } } : {}),
    });

  it('signs in with valid credentials and returns the user', async () => {
    const res = await login(ADMIN.email.toUpperCase(), ADMIN.password);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ email: ADMIN.email, role: 'owner' });
    const cookie = sessionCookie(res)!;
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const meRes = await me(cookie);
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().user.org).toMatchObject({ slug: 'default', plan: 'community' });
  });

  it('stores only the SHA-256 hash of the session token', async () => {
    const cookie = sessionCookie(await login(ADMIN.email, ADMIN.password))!;
    const rows = await ctx.db.selectFrom('sessions').select('token_hash').execute();
    expect(rows.some((r) => r.token_hash.equals(sha256(cookie)))).toBe(true);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPassword = await login(ADMIN.email, 'wrong password!');
    const unknownEmail = await login('nobody@example.com', 'wrong password!');
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json().detail).toBe(unknownEmail.json().detail);
    expect(sessionCookie(wrongPassword)).toBeUndefined();
  });

  it('rejects /me without a session, and clears an invalid cookie', async () => {
    expect((await me()).statusCode).toBe(401);
    const res = await me('not-a-real-session-token');
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const cleared = res.cookies.find((c) => c.name === 'wl_session');
    expect(cleared?.value).toBe('');
  });

  it('logs out by deleting the session', async () => {
    const cookie = sessionCookie(await login(ADMIN.email, ADMIN.password))!;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { wl_session: cookie },
    });
    expect(res.statusCode).toBe(204);
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('logout without a session still succeeds', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(res.statusCode).toBe(204);
  });

  it('rejects expired sessions', async () => {
    const cookie = sessionCookie(await login(ADMIN.email, ADMIN.password))!;
    await ctx.db
      .updateTable('sessions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('token_hash', '=', sha256(cookie))
      .execute();
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('extends the session when it was last seen more than an hour ago', async () => {
    const cookie = sessionCookie(await login(ADMIN.email, ADMIN.password))!;
    const old = new Date(Date.now() - SESSION_REFRESH_MS - 60_000);
    await ctx.db
      .updateTable('sessions')
      .set({ last_seen_at: old, expires_at: new Date(Date.now() + 60_000) })
      .where('token_hash', '=', sha256(cookie))
      .execute();
    expect((await me(cookie)).statusCode).toBe(200);
    const row = await ctx.db
      .selectFrom('sessions')
      .select(['expires_at', 'last_seen_at'])
      .where('token_hash', '=', sha256(cookie))
      .executeTakeFirstOrThrow();
    expect(row.last_seen_at.getTime()).toBeGreaterThan(old.getTime());
    expect(row.expires_at.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
  });

  it('rate-limits repeated login attempts per IP and email with 429 and Retry-After', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login(ADMIN.email, 'wrong password!')).statusCode).toBe(401);
    }
    const limited = await login(ADMIN.email, ADMIN.password);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.headers['content-type']).toContain('application/problem+json');
    // A different email from the same IP is not affected.
    expect((await login('other@example.com', 'wrong password!')).statusCode).toBe(401);
  });
});
