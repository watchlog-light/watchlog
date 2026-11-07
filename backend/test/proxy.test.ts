// SPDX-License-Identifier: AGPL-3.0-only
// What a proxy in front may tell the backend (ADR-123): the visitor's address for rate
// limits, and https for the session cookie's Secure attribute, both only from a trusted
// proxy (by the socket's peer address).
import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  clientIpOf,
  DEFAULT_TRUSTED_PROXIES,
  parseTrustedProxies,
  secureCookieFor,
  type CookieSecure,
} from '../src/plugins/client-ip.js';
import {
  ADMIN,
  closeTestContext,
  createTestContext,
  setupAdmin,
  TEST_SECRET_KEY,
  type TestContext,
} from './helpers.js';

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

const TRUSTED_PEER = '10.42.0.7'; // e.g. the web pod
const UNTRUSTED_PEER = '198.51.100.20';
const trusted = parseTrustedProxies(DEFAULT_TRUSTED_PROXIES);

const fake = (peer: string, headers: Record<string, string> = {}, ip = peer) =>
  ({ ip, socket: { remoteAddress: peer }, headers }) as unknown as FastifyRequest;

describe('client IP header', () => {
  const opts = {
    clientIpHeader: 'X-Real-IP',
    trustedProxies: trusted,
    cookieSecure: 'auto' as const,
  };

  it('is honoured from a trusted peer, and ignored (the socket address used) from any other', () => {
    expect(clientIpOf(fake(TRUSTED_PEER, { 'x-real-ip': '203.0.113.7' }), opts)).toBe(
      '203.0.113.7',
    );
    expect(clientIpOf(fake(`::ffff:${TRUSTED_PEER}`, { 'x-real-ip': '203.0.113.7' }), opts)).toBe(
      '203.0.113.7',
    );
    expect(clientIpOf(fake('fd00::5', { 'x-real-ip': '2001:db8::1' }), opts)).toBe('2001:db8::1');
    // Spoofed from outside: the socket's peer, not the header and not request.ip.
    expect(
      clientIpOf(fake(UNTRUSTED_PEER, { 'x-real-ip': '203.0.113.7' }, '192.0.2.99'), opts),
    ).toBe(UNTRUSTED_PEER);
    // Not an address, or no header: request.ip.
    expect(clientIpOf(fake(TRUSTED_PEER, { 'x-real-ip': 'evil' }), opts)).toBe(TRUSTED_PEER);
    // Without a configured header nothing changes.
    expect(
      clientIpOf(fake(TRUSTED_PEER, { 'x-real-ip': '203.0.113.7' }), {
        ...opts,
        clientIpHeader: undefined,
      }),
    ).toBe(TRUSTED_PEER);
  });

  it('trusts loopback and private ranges by default, or exactly WATCHLOG_TRUSTED_PROXIES', () => {
    const env = { DATABASE_URL: 'postgres://x@localhost/x', WATCHLOG_SECRET_KEY: TEST_SECRET_KEY };
    expect(loadConfig(env).trustedProxies).toEqual(DEFAULT_TRUSTED_PROXIES);
    const only = loadConfig({ ...env, WATCHLOG_TRUSTED_PROXIES: '192.0.2.10, 2001:db8::/32' });
    expect(only.trustedProxies).toEqual(['192.0.2.10', '2001:db8::/32']);
    const list = parseTrustedProxies(only.trustedProxies);
    const o = { clientIpHeader: 'X-Real-IP', trustedProxies: list, cookieSecure: 'auto' as const };
    expect(clientIpOf(fake('192.0.2.10', { 'x-real-ip': '203.0.113.7' }), o)).toBe('203.0.113.7');
    expect(clientIpOf(fake(TRUSTED_PEER, { 'x-real-ip': '203.0.113.7' }), o)).toBe(TRUSTED_PEER);
    expect(() => loadConfig({ ...env, WATCHLOG_TRUSTED_PROXIES: '10.0.0.0/33' })).toThrow(
      'Invalid WATCHLOG_TRUSTED_PROXIES',
    );
    expect(() => loadConfig({ ...env, WATCHLOG_COOKIE_SECURE: 'yes' })).toThrow(
      'Invalid WATCHLOG_COOKIE_SECURE',
    );
  });

  it('gives two visitors behind a trusted proxy separate rate-limit buckets', async () => {
    ctx = await createTestContext({ demoMode: true, clientIpHeader: 'X-Real-IP' });
    // Starting a demo session: 20 a minute per visitor.
    const enter = (peer: string, visitor: string) =>
      ctx!.app.inject({
        method: 'POST',
        url: '/api/v1/demo/session',
        remoteAddress: peer,
        headers: { 'x-real-ip': visitor },
      });
    for (let i = 0; i < 20; i++) {
      expect((await enter(TRUSTED_PEER, '203.0.113.1')).statusCode).toBe(200);
      expect((await enter(TRUSTED_PEER, '203.0.113.2')).statusCode).toBe(200);
    }
    expect((await enter(TRUSTED_PEER, '203.0.113.1')).statusCode).toBe(429);
    expect((await enter(TRUSTED_PEER, '203.0.113.3')).statusCode).toBe(200);
    // From an untrusted peer, changing the header does not buy a new bucket.
    for (let i = 0; i < 20; i++) {
      expect((await enter(UNTRUSTED_PEER, `192.0.2.${i}`)).statusCode).toBe(200);
    }
    expect((await enter(UNTRUSTED_PEER, '192.0.2.200')).statusCode).toBe(429);
  });
});

describe('session cookie Secure attribute', () => {
  const opts = (cookieSecure: CookieSecure) => ({ trustedProxies: trusted, cookieSecure });
  const https = { 'x-forwarded-proto': 'https' };

  it('auto: Secure over https (trusted X-Forwarded-Proto or TLS), not over plain http', () => {
    expect(secureCookieFor(fake(TRUSTED_PEER, https), opts('auto'))).toBe(true);
    expect(
      secureCookieFor(fake(TRUSTED_PEER, { 'x-forwarded-proto': 'https, http' }), opts('auto')),
    ).toBe(true);
    expect(secureCookieFor(fake(TRUSTED_PEER), opts('auto'))).toBe(false);
    expect(secureCookieFor(fake(TRUSTED_PEER, { 'x-forwarded-proto': 'http' }), opts('auto'))).toBe(
      false,
    );
    expect(secureCookieFor(fake(UNTRUSTED_PEER, https), opts('auto'))).toBe(false);
    const tls = { ip: '', headers: {}, socket: { remoteAddress: UNTRUSTED_PEER, encrypted: true } };
    expect(secureCookieFor(tls as unknown as FastifyRequest, opts('auto'))).toBe(true);
  });

  it('always and never override the request', () => {
    expect(secureCookieFor(fake(UNTRUSTED_PEER), opts('always'))).toBe(true);
    expect(secureCookieFor(fake(TRUSTED_PEER, https), opts('never'))).toBe(false);
  });

  // End to end: the cookie the sign-in sets, for each mode and kind of request.
  const signIn = async (headers: Record<string, string>, remoteAddress = '127.0.0.1') => {
    const res = await ctx!.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress,
      headers,
      payload: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(res.statusCode).toBe(200);
    return res.cookies.find((c) => c.name === 'wl_session')!;
  };

  it('is set per request by sign-in and sign-out (auto)', async () => {
    ctx = await createTestContext();
    await setupAdmin(ctx.app);
    expect((await signIn(https)).secure).toBe(true);
    expect((await signIn({})).secure).toBeUndefined();
    expect((await signIn(https, UNTRUSTED_PEER)).secure).toBeUndefined();
    const out = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: https,
    });
    expect(out.cookies.find((c) => c.name === 'wl_session')!.secure).toBe(true);
  });

  it('follows WATCHLOG_COOKIE_SECURE=always and never', async () => {
    ctx = await createTestContext({ cookieSecure: 'always' });
    await setupAdmin(ctx.app);
    expect((await signIn({})).secure).toBe(true);
    await closeTestContext(ctx);
    ctx = await createTestContext({ cookieSecure: 'never' });
    await setupAdmin(ctx.app);
    expect((await signIn(https)).secure).toBeUndefined();
  });

  it('applies to the demo cookie too', async () => {
    ctx = await createTestContext({ demoMode: true });
    const enter = (headers: Record<string, string>) =>
      ctx!.app.inject({ method: 'POST', url: '/api/v1/demo/session', headers });
    const cookie = async (headers: Record<string, string>) =>
      (await enter(headers)).cookies.find((c) => c.name === 'wl_session')!;
    // Behind the demo's nginx (X-Forwarded-Proto: https) through Caddy: Secure.
    expect(await cookie(https)).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax' });
    // Local development over plain http: usable.
    expect((await cookie({})).secure).toBeUndefined();
  });
});
