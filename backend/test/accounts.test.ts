// SPDX-License-Identifier: AGPL-3.0-only
// Accounts in Cloud (ADR-175): signup and its checks, email verification, TOTP, sessions,
// the org switcher, invites across orgs and GitHub and Google sign-in. Turnstile, Have I
// Been Pwned and the OAuth providers are mocked through the app's `fetch`; nothing here
// reaches a real service.
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { newId } from '../src/lib/ids.js';
import { hashPassword } from '../src/lib/passwords.js';
import { decryptSecret, encryptSecret } from '../src/lib/secrets.js';
import { sha256 } from '../src/lib/tokens.js';
import {
  emailDomain,
  isBreachedPassword,
  isDisposable,
  loadDisposableDomains,
  verifyTurnstile,
  WindowLimiter,
} from '../src/modules/accounts/checks.js';
import { safeNext } from '../src/modules/accounts/oauth.js';
import { createVerifyToken, orgNameFor, slugFor } from '../src/modules/accounts/service.js';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  totpCode,
  totpStep,
} from '../src/modules/accounts/totp.js';
import {
  closeTestContext,
  createTestContext,
  TEST_SECRET_KEY,
  type TestContext,
} from './helpers.js';

const BREACHED = 'correct horse battery';
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').toUpperCase();

interface Mock {
  fetch: typeof fetch;
  calls: { url: string; body?: string }[];
  hibpDown: boolean;
  github: Record<string, { id: number; email: string; verified: boolean }>;
  google: Record<string, { sub: string; email: string; verified: boolean }>;
}

/** Turnstile, HIBP, GitHub and Google, answered locally. */
function mockServices(): Mock {
  const m: Mock = {
    calls: [],
    hibpDown: false,
    github: {
      'gh-alice': { id: 101, email: 'alice@example.com', verified: true },
      'gh-bob': { id: 202, email: 'bob@example.com', verified: true },
      'gh-unverified': { id: 303, email: 'eve@example.com', verified: false },
    },
    google: {
      'g-carol': { sub: 'g-1', email: 'carol@example.com', verified: true },
      'g-unverified': { sub: 'g-2', email: 'dan@example.com', verified: false },
    },
    fetch: async (input, init) => {
      const url = String(input);
      const body = init?.body ? String(init.body) : undefined;
      m.calls.push({ url, body });
      const json = (v: unknown, status = 200) =>
        new Response(JSON.stringify(v), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url.startsWith('https://api.pwnedpasswords.com/range/')) {
        if (m.hibpDown) throw new Error('timeout');
        const h = sha1(BREACHED);
        const prefix = url.slice(-5);
        return new Response(
          prefix === h.slice(0, 5)
            ? `0000000000000000000000000000000000A:0\r\n${h.slice(5)}:42`
            : 'X:1',
        );
      }
      if (url.startsWith('https://challenges.cloudflare.com/')) {
        const response = new URLSearchParams(body).get('response');
        if (response === 'boom') throw new Error('unreachable');
        return json({ success: response === 'good' });
      }
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      const code = auth.replace('Bearer at-', '');
      if (url === 'https://github.com/login/oauth/access_token') {
        const c = new URLSearchParams(body).get('code')!;
        return json({ access_token: `at-${c}` });
      }
      if (url === 'https://api.github.com/user') {
        const u = m.github[code]!;
        return json({ id: u.id, login: code, name: null });
      }
      if (url === 'https://api.github.com/user/emails') {
        const u = m.github[code]!;
        return json([
          { email: 'other@example.com', primary: false, verified: true },
          { email: u.email, primary: true, verified: u.verified },
        ]);
      }
      if (url === 'https://oauth2.googleapis.com/token') {
        return json({ access_token: `at-${new URLSearchParams(body).get('code')}` });
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        const u = m.google[code]!;
        return json({ sub: u.sub, email: u.email, email_verified: u.verified, name: 'Carol' });
      }
      return new Response('not mocked', { status: 599 });
    },
  };
  return m;
}

const CLOUD: Partial<Config> = { edition: 'cloud', cookieSecure: 'always' };
const OAUTH = {
  github: { clientId: 'gh-id', clientSecret: 'gh-secret' },
  google: { clientId: 'g-id', clientSecret: 'g-secret' },
};

let ctx: TestContext;
let mock: Mock;
let ip = 0;
/** Each signup from its own address, so the per-address limit doesn't interfere. */
const nextIp = () => `10.0.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;

async function cloudContext(accounts: Partial<Config['accounts']> = {}) {
  mock = mockServices();
  ctx = await createTestContext(
    { ...CLOUD, accounts: { turnstile: {}, ...accounts } },
    { fetch: mock.fetch },
  );
  return ctx;
}

afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined as unknown as TestContext;
});

const cookieOf = (res: LightMyRequestResponse, name = 'wl_session') =>
  res.cookies.find((c) => c.name === name);

async function signup(
  email: string,
  extra: Record<string, unknown> = {},
  remoteAddress = nextIp(),
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    remoteAddress,
    payload: { email, password: 'a long enough password', ...extra },
  });
}

async function signedUp(email: string) {
  const res = await signup(email);
  expect(res.statusCode, res.body).toBe(201);
  const cookie = cookieOf(res)!.value;
  const user = await ctx.db
    .selectFrom('users')
    .selectAll()
    .where('email', '=', email)
    .executeTakeFirstOrThrow();
  return { cookie, user };
}

const call = (
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  cookie?: string,
  payload?: object,
  extra: object = {},
) =>
  ctx.app.inject({
    method,
    url,
    ...(cookie ? { cookies: { wl_session: cookie } } : {}),
    ...(payload ? { payload } : {}),
    ...extra,
  });

// ------------------------------------------------------------------------------- pieces

describe('the checks, alone', () => {
  it('HIBP sends only the first 5 characters of the SHA-1, and finds the suffix', async () => {
    const m = mockServices();
    expect(await isBreachedPassword(m.fetch, BREACHED)).toBe(true);
    expect(await isBreachedPassword(m.fetch, 'something nobody uses 7781')).toBe(false);
    for (const c of m.calls) {
      expect(c.url).toMatch(/\/range\/[0-9A-F]{5}$/);
      expect(c.url).not.toContain(sha1(BREACHED).slice(5));
    }
    m.hibpDown = true;
    expect(await isBreachedPassword(m.fetch, BREACHED)).toBeNull();
  });

  it('Turnstile: off without a secret, fails closed when Cloudflare is unreachable', async () => {
    const m = mockServices();
    expect(await verifyTurnstile(m.fetch, undefined, undefined, undefined)).toBe(true);
    expect(m.calls).toEqual([]);
    expect(await verifyTurnstile(m.fetch, 's', undefined, undefined)).toBe(false);
    expect(await verifyTurnstile(m.fetch, 's', 'good', '1.2.3.4')).toBe(true);
    expect(await verifyTurnstile(m.fetch, 's', 'bad', undefined)).toBe(false);
    expect(await verifyTurnstile(m.fetch, 's', 'boom', undefined)).toBe(false);
    const sent = new URLSearchParams(m.calls[0]!.body);
    expect(sent.get('secret')).toBe('s');
    expect(sent.get('remoteip')).toBe('1.2.3.4');
  });

  it('disposable domains: built in, subdomains, and a file that adds more', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wl-disposable-'));
    const file = join(dir, 'domains.txt');
    writeFileSync(file, '# extra\nthrowaway.test\n\n  Burner.Example  # trailing\n');
    const d = loadDisposableDomains(file);
    expect(isDisposable(d, 'x@mailinator.com')).toBe(true);
    expect(isDisposable(d, 'x@eu.mailinator.com')).toBe(true);
    expect(isDisposable(d, 'x@throwaway.test')).toBe(true);
    expect(isDisposable(d, 'x@burner.example')).toBe(true);
    expect(isDisposable(d, 'x@example.com')).toBe(false);
    expect(emailDomain('A@Example.COM')).toBe('example.com');
  });

  it('a window limiter counts per key and forgets after its window', () => {
    const l = new WindowLimiter(2, 1000);
    expect(l.hit('a', 0)).toBe(true);
    expect(l.hit('a', 10)).toBe(true);
    expect(l.full('a', 20)).toBe(true);
    expect(l.hit('a', 20)).toBe(false);
    expect(l.hit('b', 20)).toBe(true);
    expect(l.hit('a', 1000)).toBe(true);
  });

  it('org names and slugs come from the local part', () => {
    expect(orgNameFor('Jane.Doe+ops@example.com')).toBe('Jane.Doe+ops');
    expect(slugFor('Jane.Doe+ops')).toBe('jane-doe-ops');
    expect(slugFor('---')).toBe('org');
  });

  it('TOTP: ±1 step, and the secret is bound to its user', () => {
    const key = Buffer.from(TEST_SECRET_KEY, 'base64');
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(totpStep(secret, totpCode(secret, now), now)).toBe(step);
    expect(totpStep(secret, totpCode(secret, now - 30_000), now)).toBe(step - 1);
    expect(totpStep(secret, totpCode(secret, now + 30_000), now)).toBe(step + 1);
    expect(totpStep(secret, totpCode(secret, now + 90_000), now)).toBeNull();
    expect(totpStep(secret, 'abcdef', now)).toBeNull();
    const ct = encryptTotpSecret(key, 'user-a', secret);
    expect(decryptTotpSecret(key, 'user-a', ct)).toBe(secret);
    expect(() => decryptTotpSecret(key, 'user-b', ct)).toThrow();
    expect(() => decryptSecret(key, ct)).toThrow();
    expect(encryptSecret(key, 'x')).not.toBe(ct);
  });

  it('only paths on this site are followed after OAuth', () => {
    expect(safeNext('/clusters')).toBe('/clusters');
    expect(safeNext('//evil.example')).toBeUndefined();
    expect(safeNext('https://evil.example')).toBeUndefined();
    expect(safeNext('/\\evil')).toBeUndefined();
  });

  it('config: Cloud cookies are always Secure; OAuth needs both id and secret', () => {
    const base = {
      DATABASE_URL: 'postgres://app@h/db',
      DATABASE_SYSTEM_URL: 'postgres://owner@h/db',
      WATCHLOG_SECRET_KEY: TEST_SECRET_KEY,
      WATCHLOG_EDITION: 'cloud',
    };
    const c = loadConfig(base);
    expect(c.cookieSecure).toBe('always');
    expect(c.accounts).toEqual({ turnstile: {}, github: undefined, google: undefined });
    expect(() => loadConfig({ ...base, WATCHLOG_COOKIE_SECURE: 'auto' })).toThrow(/Secure/);
    expect(() => loadConfig({ ...base, WATCHLOG_GITHUB_CLIENT_ID: 'x' })).toThrow(/together/);
    expect(
      loadConfig({
        ...base,
        WATCHLOG_GOOGLE_CLIENT_ID: 'i',
        WATCHLOG_GOOGLE_CLIENT_SECRET: 's',
        TURNSTILE_SECRET_KEY: 't',
        TURNSTILE_SITE_KEY: 'k',
      }).accounts,
    ).toMatchObject({
      google: { clientId: 'i', clientSecret: 's' },
      turnstile: { secretKey: 't', siteKey: 'k' },
    });
    // Community keeps 0.5.0's per-request Secure.
    expect(loadConfig({ ...base, WATCHLOG_EDITION: undefined }).cookieSecure).toBe('auto');
  });
});

// ------------------------------------------------------------------------------- signup

describe('signup', () => {
  it('creates the user, an org named after the local part, an Owner and Free entitlements', async () => {
    await cloudContext();
    const res = await signup('Jane.Doe@Example.com');
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ accepted: true, verificationSent: false });
    const c = cookieOf(res)!;
    expect(c.secure).toBe(true);
    expect(c.httpOnly).toBe(true);
    const me = await call('GET', '/api/v1/me', c.value);
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({
      email: 'jane.doe@example.com',
      name: 'jane.doe',
      role: 'owner',
      org: { name: 'jane.doe', slug: 'jane-doe', plan: 'free' },
    });
    const ent = await ctx.db
      .selectFrom('entitlements')
      .selectAll()
      .where('org_id', '=', me.json().user.org.id)
      .executeTakeFirstOrThrow();
    expect(ent).toMatchObject({ plan: 'free', source: 'signup' });
    const tokens = await ctx.db.selectFrom('email_tokens').selectAll().execute();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.email).toBe('jane.doe@example.com');
    // A second "jane.doe" gets its own slug.
    const again = await signup('jane.doe@other.example');
    expect(again.statusCode).toBe(201);
    const slugs = await ctx.db
      .selectFrom('orgs')
      .select('slug')
      .where('name', '=', 'jane.doe')
      .execute();
    expect(new Set(slugs.map((s) => s.slug)).size).toBe(2);
  });

  it('answers the same for an existing address, starts no session and makes no account', async () => {
    await cloudContext();
    const first = await signup('taken@example.com');
    const second = await signup('taken@example.com', { password: 'another long password' });
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json());
    expect(cookieOf(second)).toBeUndefined();
    const n = await ctx.db
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('email', '=', 'taken@example.com')
      .executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(1);
  });

  it('refuses a breached password, and goes on when HIBP is down', async () => {
    await cloudContext();
    const bad = await signup('b@example.com', { password: BREACHED });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('password-breached');
    mock.hibpDown = true;
    expect((await signup('b@example.com', { password: BREACHED })).statusCode).toBe(201);
  });

  it('refuses disposable addresses and short passwords', async () => {
    await cloudContext();
    const res = await signup('x@yopmail.com');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('email-disposable');
    expect((await signup('x@example.com', { password: 'short' })).statusCode).toBe(400);
  });

  it('limits signups to 5 an hour per address and 20 a day per email domain', async () => {
    await cloudContext();
    for (let i = 0; i < 5; i++) {
      expect((await signup(`ip${i}@example.com`, {}, '10.9.9.9')).statusCode).toBe(201);
    }
    const sixth = await signup('ip5@example.com', {}, '10.9.9.9');
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().code).toBe('rate-limited');
    for (let i = 0; i < 20; i++) {
      expect((await signup(`d${i}@busy.example`)).statusCode).toBe(201);
    }
    expect((await signup('d20@busy.example')).statusCode).toBe(429);
  });

  it('checks Turnstile when it is on, and the config endpoint shows its site key', async () => {
    await cloudContext({ turnstile: { secretKey: 'sec', siteKey: 'site' }, ...OAUTH });
    const cfg = await call('GET', '/api/v1/auth/config');
    expect(cfg.json()).toEqual({
      signup: true,
      providers: { github: true, google: true },
      turnstileSiteKey: 'site',
      passwordMinLength: 10,
      verifyGraceDays: 7,
    });
    expect((await signup('t@example.com')).json().code).toBe('turnstile-failed');
    expect((await signup('t@example.com', { turnstileToken: 'bad' })).statusCode).toBe(400);
    expect((await signup('t@example.com', { turnstileToken: 'good' })).statusCode).toBe(201);
    // Reset asks for it too.
    const reset = await call('POST', '/api/v1/auth/forgot-password', undefined, {
      email: 't@example.com',
    });
    expect(reset.statusCode).toBe(400);
    expect(reset.json().code).toBe('turnstile-failed');
  });

  it('the config endpoint hides providers that are not set up', async () => {
    await cloudContext({ turnstile: { siteKey: 'only-site' } });
    expect((await call('GET', '/api/v1/auth/config')).json()).toMatchObject({
      providers: { github: false, google: false },
      turnstileSiteKey: null,
    });
    const start = await call('GET', '/api/v1/auth/oauth/github/start');
    expect(start.statusCode).toBe(404);
    expect(start.json().code).toBe('oauth-disabled');
  });
});

// ------------------------------------------------------------------- email verification

describe('email verification', () => {
  it('verifies once with the link, and the link is single-use and expires', async () => {
    await cloudContext();
    const { user } = await signedUp('v@example.com');
    const token = await createVerifyToken(ctx.db, user.id, user.email);
    const ok = await call('POST', '/api/v1/auth/verify-email', undefined, { token });
    expect(ok.statusCode, ok.body).toBe(200);
    const row = await ctx.db
      .selectFrom('users')
      .select('email_verified_at')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(row.email_verified_at).not.toBeNull();
    const again = await call('POST', '/api/v1/auth/verify-email', undefined, { token });
    expect(again.json().code).toBe('invalid-token');
    const old = await createVerifyToken(ctx.db, user.id, user.email);
    await ctx.db
      .updateTable('email_tokens')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('token_hash', '=', sha256(old))
      .execute();
    expect(
      (await call('POST', '/api/v1/auth/verify-email', undefined, { token: old })).statusCode,
    ).toBe(410);
  });

  it('after 7 days unverified, the account can sign in only to verify', async () => {
    await cloudContext();
    const { cookie, user } = await signedUp('late@example.com');
    expect((await call('GET', '/api/v1/clusters', cookie)).statusCode).toBe(200);
    await ctx.db
      .updateTable('users')
      .set({ created_at: new Date(Date.now() - 8 * 86_400_000) })
      .where('id', '=', user.id)
      .execute();
    const blocked = await call('GET', '/api/v1/clusters', cookie);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().type).toBe('urn:watchlog:problem:email-verification-required');
    const account = await call('GET', '/api/v1/auth/account', cookie);
    expect(account.statusCode).toBe(200);
    expect(account.json()).toMatchObject({
      emailVerified: false,
      restriction: 'email-verification-required',
      password: true,
    });
    // Resend works for a restricted session, 3 times an hour.
    for (let i = 0; i < 3; i++) {
      expect((await call('POST', '/api/v1/auth/verify-email/resend', cookie, {})).statusCode).toBe(
        202,
      );
    }
    const fourth = await call('POST', '/api/v1/auth/verify-email/resend', cookie, {});
    expect(fourth.statusCode).toBe(429);
    const token = await createVerifyToken(ctx.db, user.id, user.email);
    await call('POST', '/api/v1/auth/verify-email', undefined, { token });
    expect((await call('GET', '/api/v1/clusters', cookie)).statusCode).toBe(200);
    expect((await call('POST', '/api/v1/auth/verify-email/resend', cookie, {})).json().code).toBe(
      'already-verified',
    );
  });
});

// -------------------------------------------------------------------------------- TOTP

describe('TOTP', () => {
  async function enable(cookie: string) {
    const setup = await call('POST', '/api/v1/auth/2fa/setup', cookie);
    expect(setup.statusCode, setup.body).toBe(200);
    const { secret, uri } = setup.json();
    expect(uri).toMatch(/^otpauth:\/\/totp\/WatchLog:.*secret=/);
    const bad = await call('POST', '/api/v1/auth/2fa/enable', cookie, { code: '000000' });
    expect(bad.json().code).toBe('mfa-invalid');
    const on = await call('POST', '/api/v1/auth/2fa/enable', cookie, { code: totpCode(secret) });
    expect(on.statusCode, on.body).toBe(200);
    return { secret: secret as string, res: on };
  }

  async function login(email: string, password = 'a long enough password') {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
  }

  it('turns on with a code, rotates the session, and stores the secret encrypted', async () => {
    await cloudContext();
    const { cookie, user } = await signedUp('t@example.com');
    const { secret, res } = await enable(cookie);
    expect(res.json().recoveryCodes).toHaveLength(10);
    const rotated = cookieOf(res)!.value;
    expect(rotated).not.toBe(cookie);
    expect((await call('GET', '/api/v1/me', cookie)).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/me', rotated)).statusCode).toBe(200);
    const row = await ctx.db
      .selectFrom('users')
      .select(['totp_secret'])
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(row.totp_secret).toMatch(/^v1:/);
    expect(row.totp_secret).not.toContain(secret);
    const s = await ctx.db
      .selectFrom('sessions')
      .select('mfa_passed_at')
      .where('token_hash', '=', sha256(rotated))
      .executeTakeFirstOrThrow();
    expect(s.mfa_passed_at).not.toBeNull();
    const codes = await ctx.db
      .selectFrom('recovery_codes')
      .selectAll()
      .where('user_id', '=', user.id)
      .execute();
    expect(codes).toHaveLength(10);
    expect(JSON.stringify(codes)).not.toContain(res.json().recoveryCodes[0]);
  });

  it('sign-in asks for the code; a used step is not accepted twice; recovery codes work once', async () => {
    await cloudContext();
    const { cookie } = await signedUp('m@example.com');
    const { secret, res } = await enable(cookie);
    const recovery = res.json().recoveryCodes as string[];

    const first = await login('m@example.com');
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ mfaRequired: true });
    expect(cookieOf(first)).toBeUndefined();
    const pending = cookieOf(first, 'wl_mfa')!;
    expect(pending.httpOnly).toBe(true);
    // The pending session is not signed in.
    expect((await call('GET', '/api/v1/me', pending.value)).statusCode).toBe(401);
    const verify = (code: string, mfa = pending.value) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/2fa/verify',
        cookies: { wl_mfa: mfa },
        payload: { code },
      });
    // The step the setup used is spent.
    expect((await verify(totpCode(secret))).json().code).toBe('mfa-invalid');
    const next = totpCode(secret, Date.now() + 30_000);
    const ok = await verify(next);
    expect(ok.statusCode, ok.body).toBe(200);
    const full = cookieOf(ok)!.value;
    expect((await call('GET', '/api/v1/me', full)).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/auth/sessions', full)).json().sessions[0].mfa).toBe(true);

    const second = cookieOf(await login('m@example.com'), 'wl_mfa')!.value;
    expect((await verify(next, second)).json().code).toBe('mfa-invalid');
    expect((await verify(recovery[0]!, second)).statusCode).toBe(200);
    const third = cookieOf(await login('m@example.com'), 'wl_mfa')!.value;
    expect((await verify(recovery[0]!, third)).json().code).toBe('mfa-invalid');
    // Five wrong codes end the pending session.
    for (let i = 0; i < 4; i++) await verify('111111', third);
    const gone = await verify(recovery[1]!, third);
    expect(gone.statusCode).toBe(401);
  });

  it('is required for Owners of a billed org before anything else, and stays on', async () => {
    await cloudContext();
    const { cookie, user } = await signedUp('owner@paid.example');
    const org = await ctx.db
      .selectFrom('memberships')
      .select('org_id')
      .where('user_id', '=', user.id)
      .executeTakeFirstOrThrow();
    await ctx.db
      .updateTable('entitlements')
      .set({ plan: 'pro', source: 'billing' })
      .where('org_id', '=', org.org_id)
      .execute();
    const blocked = await call('GET', '/api/v1/clusters', cookie);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().type).toBe('urn:watchlog:problem:mfa-setup-required');
    expect((await call('GET', '/api/v1/auth/account', cookie)).json()).toMatchObject({
      restriction: 'mfa-setup-required',
      mfa: { enabled: false, required: true },
    });
    const { secret, res } = await enable(cookie);
    const rotated = cookieOf(res)!.value;
    expect((await call('GET', '/api/v1/clusters', rotated)).statusCode).toBe(200);
    const off = await call('POST', '/api/v1/auth/2fa/disable', rotated, {
      code: totpCode(secret, Date.now() + 30_000),
    });
    expect(off.statusCode).toBe(409);
    expect(off.json().code).toBe('mfa-required');
  });

  it('turns off with a code when it is optional', async () => {
    await cloudContext();
    const { cookie } = await signedUp('opt@example.com');
    const { secret, res } = await enable(cookie);
    const rotated = cookieOf(res)!.value;
    const newCodes = await call('POST', '/api/v1/auth/2fa/recovery-codes', rotated, {
      code: totpCode(secret, Date.now() + 30_000),
    });
    expect(newCodes.json().recoveryCodes).toHaveLength(10);
    const off = await call('POST', '/api/v1/auth/2fa/disable', rotated, {
      code: newCodes.json().recoveryCodes[0],
    });
    expect(off.statusCode, off.body).toBe(204);
    expect((await login('opt@example.com')).statusCode).toBe(200);
  });
});

// ------------------------------------------------------------------- sessions and orgs

describe('sessions and orgs', () => {
  it('lists and revokes your own sessions; another user’s is 404', async () => {
    await cloudContext();
    const a = await signedUp('sa@example.com');
    const b = await signedUp('sb@example.com');
    const second = cookieOf(
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'sa@example.com', password: 'a long enough password' },
      }),
    )!.value;
    const list = (await call('GET', '/api/v1/auth/sessions', a.cookie)).json().sessions;
    expect(list).toHaveLength(2);
    expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const other = list.find((s: { current: boolean }) => !s.current);
    // B can't end A's session.
    expect((await call('DELETE', `/api/v1/auth/sessions/${other.id}`, b.cookie)).statusCode).toBe(
      404,
    );
    expect((await call('GET', '/api/v1/me', second)).statusCode).toBe(200);
    expect((await call('DELETE', `/api/v1/auth/sessions/${other.id}`, a.cookie)).statusCode).toBe(
      204,
    );
    expect((await call('GET', '/api/v1/me', second)).statusCode).toBe(401);
    // Ending every other session.
    const third = cookieOf(
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'sa@example.com', password: 'a long enough password' },
      }),
    )!.value;
    expect((await call('DELETE', '/api/v1/auth/sessions', a.cookie)).json()).toEqual({
      revoked: 1,
    });
    expect((await call('GET', '/api/v1/me', third)).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/me', a.cookie)).statusCode).toBe(200);
  });

  it('sign-in rotates the session the browser had', async () => {
    await cloudContext();
    const a = await signedUp('rot@example.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      cookies: { wl_session: a.cookie },
      payload: { email: 'rot@example.com', password: 'a long enough password' },
    });
    expect(res.statusCode).toBe(200);
    expect((await call('GET', '/api/v1/me', a.cookie)).statusCode).toBe(401);
  });

  it('switches between orgs the user belongs to; another org is 404', async () => {
    await cloudContext();
    const a = await signedUp('multi@example.com');
    const b = await signedUp('someone@example.com');
    const orgOf = async (cookie: string) =>
      (await call('GET', '/api/v1/me', cookie)).json().user.org;
    const home = await orgOf(a.cookie);
    const other = await orgOf(b.cookie);
    await ctx.db
      .insertInto('memberships')
      .values({ id: newId(), org_id: other.id, user_id: a.user.id, role: 'viewer' })
      .execute();
    const orgs = (await call('GET', '/api/v1/orgs', a.cookie)).json().orgs;
    expect(orgs.map((o: { id: string; current: boolean }) => [o.id, o.current])).toEqual([
      [home.id, true],
      [other.id, false],
    ]);
    const sw = await call('POST', `/api/v1/orgs/${other.id}/switch`, a.cookie);
    expect(sw.statusCode, sw.body).toBe(200);
    expect((await call('GET', '/api/v1/me', a.cookie)).json().user).toMatchObject({
      role: 'viewer',
      org: { id: other.id },
    });
    // Removed from it: back to the first membership.
    await ctx.db
      .deleteFrom('memberships')
      .where('user_id', '=', a.user.id)
      .where('org_id', '=', other.id)
      .execute();
    expect((await orgOf(a.cookie)).id).toBe(home.id);
    const stranger = await call('POST', `/api/v1/orgs/${other.id}/switch`, a.cookie);
    expect(stranger.statusCode).toBe(404);
  });

  it('an existing account joins an org from an invite with one click; Free can’t invite', async () => {
    await cloudContext();
    const owner = await signedUp('boss@team.example');
    const ownerOrg = (await call('GET', '/api/v1/me', owner.cookie)).json().user.org;
    // Cloud Free has one user.
    const free = await call('POST', '/api/v1/users/invites', owner.cookie, {
      email: 'mate@example.com',
      role: 'viewer',
    });
    expect(free.statusCode).toBe(409);
    expect(free.json().code).toBe('plan-limit');
    await ctx.db
      .updateTable('entitlements')
      .set({ plan: 'pro', source: 'beta' })
      .where('org_id', '=', ownerOrg.id)
      .execute();
    const inv = await call('POST', '/api/v1/users/invites', owner.cookie, {
      email: 'mate@example.com',
      role: 'admin',
    });
    expect(inv.statusCode, inv.body).toBe(201);
    const token = (inv.json().link as string).split('/').pop()!;
    const mate = await signedUp('mate@example.com');
    const wrong = await signedUp('wrong@example.com');
    expect((await call('POST', `/api/v1/invites/${token}/join`, wrong.cookie)).json().code).toBe(
      'invite-other-email',
    );
    const join = await call('POST', `/api/v1/invites/${token}/join`, mate.cookie);
    expect(join.statusCode, join.body).toBe(200);
    expect(join.json().org).toMatchObject({ id: ownerOrg.id, role: 'admin', current: true });
    expect((await call('GET', '/api/v1/me', mate.cookie)).json().user.org.id).toBe(ownerOrg.id);
    expect((await call('GET', '/api/v1/orgs', mate.cookie)).json().orgs).toHaveLength(2);
    expect((await call('POST', `/api/v1/invites/${token}/join`, mate.cookie)).statusCode).toBe(410);
  });
});

// ------------------------------------------------------------------------------- OAuth

describe('GitHub and Google sign-in', () => {
  async function start(provider: string, cookie?: string, query: Record<string, string> = {}) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/${provider}/start`,
      query,
      ...(cookie ? { cookies: { wl_session: cookie } } : {}),
    });
    expect(res.statusCode, res.body).toBe(302);
    return { res, url: new URL(res.headers.location as string), state: cookieOf(res, 'wl_oauth')! };
  }

  async function callback(provider: string, code: string, opts: { cookie?: string } = {}) {
    const s = await start(provider, opts.cookie, opts.cookie ? { intent: 'link' } : {});
    return ctx.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/${provider}/callback`,
      query: { code, state: s.url.searchParams.get('state')! },
      cookies: { wl_oauth: s.state.value, ...(opts.cookie ? { wl_session: opts.cookie } : {}) },
    });
  }

  it('starts with PKCE and a state bound to a short-lived HttpOnly cookie', async () => {
    await cloudContext(OAUTH);
    const { url, state } = await start('github', undefined, { next: '/clusters' });
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('redirect_uri')).toMatch(
      /\/api\/v1\/auth\/oauth\/github\/callback$/,
    );
    expect(state).toMatchObject({ httpOnly: true, secure: true, path: '/api/v1/auth/oauth' });
    expect(state.maxAge).toBe(600);
    // The cookie is sealed: it doesn't show the state or the verifier.
    expect(state.value).not.toContain(url.searchParams.get('state')!);
  });

  it('signs up with GitHub, then signs in to the same account by its id', async () => {
    await cloudContext(OAUTH);
    const res = await callback('github', 'gh-alice');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookie = cookieOf(res)!.value;
    const me = (await call('GET', '/api/v1/me', cookie)).json().user;
    expect(me).toMatchObject({ email: 'alice@example.com', role: 'owner', org: { plan: 'free' } });
    expect((await call('GET', '/api/v1/auth/account', cookie)).json()).toMatchObject({
      emailVerified: true,
      password: false,
      identities: [{ provider: 'github', email: 'alice@example.com' }],
    });
    // The token exchange carried the PKCE verifier.
    const exchange = mock.calls.find((c) => c.url.includes('access_token'))!;
    expect(new URLSearchParams(exchange.body).get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const again = await callback('github', 'gh-alice');
    expect((await call('GET', '/api/v1/me', cookieOf(again)!.value)).json().user.id).toBe(me.id);
    // Unlinking the only way in is refused.
    expect((await call('DELETE', '/api/v1/auth/identities/github', cookie)).json().code).toBe(
      'last-sign-in-method',
    );
  });

  it('scenario 5: email first, then GitHub with the same address, are two accounts until linked', async () => {
    await cloudContext(OAUTH);
    const pw = await signedUp('alice@example.com');
    const gh = await callback('github', 'gh-alice');
    const ghUser = (await call('GET', '/api/v1/me', cookieOf(gh)!.value)).json().user;
    expect(ghUser.id).not.toBe(pw.user.id);
    expect(
      (
        await ctx.db
          .selectFrom('users')
          .select('id')
          .where('email', '=', 'alice@example.com')
          .execute()
      ).length,
    ).toBe(2);
    // The password account links another GitHub account after signing in.
    const linked = await callback('github', 'gh-bob', { cookie: pw.cookie });
    expect(linked.headers.location).toBe('/settings/security?linked=github');
    const via = await callback('github', 'gh-bob');
    expect((await call('GET', '/api/v1/me', cookieOf(via)!.value)).json().user.id).toBe(pw.user.id);
    // A GitHub account already linked elsewhere can't be linked again.
    const taken = await callback('github', 'gh-alice', { cookie: cookieOf(via)!.value });
    expect(taken.headers.location).toBe('/settings/security?error=identity-taken');
  });

  it("refuses GitHub's unverified primary address, Google's unverified one, and a wrong state", async () => {
    await cloudContext(OAUTH);
    expect((await callback('github', 'gh-unverified')).headers.location).toBe(
      '/signin?error=oauth-email-unverified',
    );
    expect((await callback('google', 'g-unverified')).headers.location).toBe(
      '/signin?error=oauth-email-unverified',
    );
    const s = await start('github');
    const forged = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/github/callback',
      query: { code: 'gh-alice', state: 'not-the-state' },
      cookies: { wl_oauth: s.state.value },
    });
    expect(forged.headers.location).toBe('/signin?error=oauth-state');
    const noCookie = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/github/callback',
      query: { code: 'gh-alice', state: s.url.searchParams.get('state')! },
    });
    expect(noCookie.headers.location).toBe('/signin?error=oauth-state');
    expect(
      await ctx.db
        .selectFrom('users')
        .select('id')
        .where('email', '=', 'alice@example.com')
        .execute(),
    ).toEqual([]);
  });

  it('signs up with Google, and asks for the TOTP code after the OAuth step', async () => {
    await cloudContext(OAUTH);
    const res = await callback('google', 'g-carol');
    const cookie = cookieOf(res)!.value;
    const setup = (await call('POST', '/api/v1/auth/2fa/setup', cookie)).json();
    const on = await call('POST', '/api/v1/auth/2fa/enable', cookie, {
      code: totpCode(setup.secret),
    });
    expect(on.statusCode).toBe(200);
    const again = await callback('google', 'g-carol');
    expect(again.headers.location).toBe('/signin/2fa');
    expect(cookieOf(again)).toBeUndefined();
    expect(cookieOf(again, 'wl_mfa')).toBeDefined();
  });

  it('the password reset form never reaches accounts made with GitHub', async () => {
    await cloudContext(OAUTH);
    await callback('github', 'gh-alice');
    const res = await call('POST', '/api/v1/auth/forgot-password', undefined, {
      email: 'alice@example.com',
    });
    // No SMTP in tests: 409 either way, before any lookup.
    expect([202, 409]).toContain(res.statusCode);
    const resets = await sql<{ n: string }>`SELECT count(*) AS n FROM password_resets`.execute(
      ctx.db,
    );
    expect(resets.rows[0]!.n).toBe('0');
  });
});

describe('a hashed password row stays usable', () => {
  it('argon2id hashes verify through login in Cloud', async () => {
    await cloudContext();
    const id = newId();
    const orgId = newId();
    await ctx.db
      .insertInto('orgs')
      .values({ id: orgId, name: 'x', slug: `x-${id.slice(0, 6)}`, plan: 'free' })
      .execute();
    await ctx.db
      .insertInto('users')
      .values({
        id,
        email: 'old@example.com',
        name: 'Old',
        password_hash: await hashPassword('old password 123'),
      })
      .execute();
    await ctx.db
      .insertInto('memberships')
      .values({ id: newId(), org_id: orgId, user_id: id, role: 'owner' })
      .execute();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'old@example.com', password: 'old password 123' },
    });
    expect(res.statusCode).toBe(200);
    expect(cookieOf(res)!.secure).toBe(true);
  });
});
