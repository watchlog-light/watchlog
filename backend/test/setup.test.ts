// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { generateSetupCode, SetupState } from '../src/modules/setup/service.js';
import {
  ADMIN,
  closeTestContext,
  createTestContext,
  sessionCookie,
  TEST_SETUP_CODE,
  type TestContext,
} from './helpers.js';
import { inject } from 'vitest';

describe('first-run setup', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(() => closeTestContext(ctx));

  const post = (payload: object) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/setup', payload });

  it('reports setup as required while no user exists', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/setup' });
    expect(res.json()).toEqual({ required: true });
  });

  it('rejects a wrong setup code with 403', async () => {
    const res = await post({ code: 'WRON-GCOD-E000', ...ADMIN });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('accepts the code case-insensitively and without dashes', async () => {
    const res = await post({ code: TEST_SETUP_CODE.toLowerCase().replaceAll('-', ''), ...ADMIN });
    expect(res.statusCode).toBe(201);
  });

  it('creates the default org, an owner and a signed-in session', async () => {
    const res = await post({ code: TEST_SETUP_CODE, ...ADMIN, email: 'Admin@Example.com' });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({
      email: 'admin@example.com',
      name: ADMIN.name,
      role: 'owner',
      org: { slug: 'default', plan: 'community' },
    });

    const cookie = res.cookies.find((c) => c.name === 'wl_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.path).toBe('/');
    expect(cookie.secure).toBeFalsy(); // plain HTTP request

    const user = await ctx.db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    expect(user.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('sets a Secure cookie when the request arrives over HTTPS via a trusted proxy', async () => {
    await closeTestContext(ctx);
    ctx = await createTestContext({ trustProxy: true });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { code: TEST_SETUP_CODE, ...ADMIN },
    });
    expect(res.cookies.find((c) => c.name === 'wl_session')?.secure).toBe(true);
  });

  it('cannot be run twice', async () => {
    expect((await post({ code: TEST_SETUP_CODE, ...ADMIN })).statusCode).toBe(201);
    const second = await post({ code: TEST_SETUP_CODE, ...ADMIN, email: 'other@example.com' });
    expect(second.statusCode).toBe(409);
    const status = await ctx.app.inject({ method: 'GET', url: '/api/v1/setup' });
    expect(status.json()).toEqual({ required: false });
  });

  it('validates the password length and email format', async () => {
    expect((await post({ code: TEST_SETUP_CODE, ...ADMIN, password: 'short' })).statusCode).toBe(
      400,
    );
    expect(
      (await post({ code: TEST_SETUP_CODE, ...ADMIN, email: 'not-an-email' })).statusCode,
    ).toBe(400);
  });

  it('rate-limits setup attempts', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await post({ code: 'nope', ...ADMIN })).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 403)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('logs in immediately with the session cookie from setup', async () => {
    const res = await post({ code: TEST_SETUP_CODE, ...ADMIN });
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: { wl_session: sessionCookie(res)! },
    });
    expect(me.statusCode).toBe(200);
  });
});

describe('SetupState', () => {
  it('generates codes in XXXX-XXXX-XXXX form without ambiguous characters', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateSetupCode()).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
      );
    }
  });

  it('creates the admin from env bootstrap and prints no code', async () => {
    const ctx = await createTestContext();
    await closeTestContext(ctx);
    const db = createDb(inject('databaseUrl'));
    const warnings: string[] = [];
    const state = new SetupState(() => TEST_SETUP_CODE);
    await state.initialize(
      db,
      { email: 'Boot@Example.com', password: 'bootstrap password' },
      { info: () => {}, warn: (m) => warnings.push(m) },
    );
    expect(await state.isRequired(db)).toBe(false);
    expect(state.verifyCode(TEST_SETUP_CODE)).toBe(false);
    expect(warnings).toEqual([]);
    const user = await db.selectFrom('users').select('email').executeTakeFirstOrThrow();
    expect(user.email).toBe('boot@example.com');
    await db.destroy();
  });

  it('prints the setup code when no user exists and no bootstrap is configured', async () => {
    const ctx = await createTestContext();
    await closeTestContext(ctx);
    const db = createDb(inject('databaseUrl'));
    const warnings: string[] = [];
    const state = new SetupState(() => TEST_SETUP_CODE);
    await state.initialize(db, {}, { info: () => {}, warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(TEST_SETUP_CODE);
    await db.destroy();
  });
});
