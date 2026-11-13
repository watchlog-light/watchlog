// SPDX-License-Identifier: AGPL-3.0-only
// Cloud's response headers (ADR-181): the strict Content-Security-Policy and the others on
// the API (helmet) and on the dashboard's files (web/Caddyfile with WATCHLOG_EDITION=cloud),
// one policy in both; Secure cookies always in Cloud. Community keeps 0.5.0's headers.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOUD_CSP } from '../src/lib/csp.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';
import { cloudWorld, type CloudWorld } from './isolation/cloud.js';

const caddyfile = readFileSync(new URL('../../web/Caddyfile', import.meta.url), 'utf8');

describe('the web image (web/Caddyfile)', () => {
  it("sends the backend's policy, only in Cloud", () => {
    const cloud = /\(edition-cloud\) \{([\s\S]*?)\n\}/.exec(caddyfile)?.[1] ?? '';
    const csp = /Content-Security-Policy "([^"]+)"/.exec(cloud)?.[1];
    expect(csp).toBe(CLOUD_CSP);
    expect(cloud).toContain('Referrer-Policy "strict-origin-when-cross-origin"');
    expect(cloud).toContain('X-Content-Type-Options "nosniff"');
    expect(cloud).toContain('X-Frame-Options "DENY"');
    // Community's snippet is empty: no new header without WATCHLOG_EDITION=cloud.
    expect(/\(edition-community\) \{\s*\}/.test(caddyfile)).toBe(true);
    // Imported for the dashboard's files, by the edition (community by default).
    expect(caddyfile).toContain('import edition-{$WATCHLOG_EDITION:community}');
  });

  it('allows what the pages need and nothing inline for scripts', () => {
    expect(CLOUD_CSP).toContain("default-src 'self'");
    expect(CLOUD_CSP).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(CLOUD_CSP).toContain('frame-src https://challenges.cloudflare.com');
    expect(CLOUD_CSP).toContain("frame-ancestors 'none'");
    expect(CLOUD_CSP).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(CLOUD_CSP).not.toMatch(/style-src [^;]*'unsafe-inline'/);
  });
});

describe('the API in Cloud', () => {
  let w: CloudWorld;
  beforeAll(async () => {
    w = await cloudWorld();
  }, 120_000);
  afterAll(() => w?.close());

  it('sends the strict policy, the referrer policy, nosniff and DENY', async () => {
    const res = await w.app.inject({ method: 'GET', url: '/api/v1/health' });
    const norm = (v: unknown) =>
      String(v)
        .split(';')
        .map((d) => d.trim())
        .join('; ');
    expect(norm(res.headers['content-security-policy'])).toBe(CLOUD_CSP);
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    // HSTS is nginx's in Cloud (one header, for the whole host).
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('marks the session cookie Secure, also over plain http', async () => {
    const res = await w.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: `secure-${Date.now()}@cookies.test`, password: 'a long password 2026' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const session = res.cookies.find((c) => c.name === 'wl_session');
    expect(session?.secure).toBe(true);
    expect(session?.httpOnly).toBe(true);
  });
});

describe('the API in Community', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => closeTestContext(ctx));

  it("keeps helmet's defaults, as 0.5.0", async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});
