// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCrossSiteRequest } from '../src/plugins/csrf.js';
import {
  ADMIN,
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from './helpers.js';

describe('isCrossSiteRequest', () => {
  const host = 'watchlog.local:8080';

  it.each([
    [{ secFetchSite: 'same-origin', origin: 'http://watchlog.local:8080', host }, false],
    [{ secFetchSite: 'none', host }, false],
    [{ secFetchSite: 'cross-site', origin: 'https://evil.example', host }, true],
    [{ secFetchSite: 'same-site', origin: 'https://other.watchlog.local', host }, true],
    [{ secFetchSite: 'cross-site', host }, true],
    [{ origin: 'http://watchlog.local:8080', host }, false],
    [{ origin: 'https://evil.example', host }, true],
    [{ origin: 'null', host }, true],
    [{ host }, false], // curl and other non-browser clients
  ])('%o → blocked=%s', (req, blocked) => {
    expect(isCrossSiteRequest(req)).toBe(blocked);
  });

  it('allows the configured public URL even when it differs from Host', () => {
    expect(
      isCrossSiteRequest(
        { secFetchSite: 'same-site', origin: 'https://app.example.com', host: 'backend:4080' },
        'https://app.example.com/',
      ),
    ).toBe(false);
  });
});

describe('CSRF protection on the API', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await setupAdmin(ctx.app);
  });

  afterAll(() => closeTestContext(ctx));

  const login = (headers: Record<string, string>) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: 'localhost:4088', ...headers },
      payload: { email: ADMIN.email, password: ADMIN.password },
    });

  it('blocks cross-site POSTs with 403 before reaching the handler', async () => {
    const res = await login({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('blocks POSTs whose Origin does not match the host', async () => {
    expect((await login({ origin: 'https://evil.example' })).statusCode).toBe(403);
  });

  it('allows same-origin POSTs', async () => {
    const res = await login({ 'sec-fetch-site': 'same-origin', origin: 'http://localhost:4088' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects text/plain bodies (no form-encoded or plain-text CSRF)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    expect(res.statusCode).toBe(415);
  });
});
