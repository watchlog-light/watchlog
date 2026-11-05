// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';

describe('backend app', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(() => closeTestContext(ctx));

  it('GET /api/v1/health returns ok with the version', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: '1.2.3-test' });
  });

  it('unknown routes return an RFC 9457 problem', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ type: 'about:blank', title: 'Not Found', status: 404 });
  });

  it('serves an OpenAPI 3.1 document that includes the health route', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths).toHaveProperty('/api/v1/health');
  });
});
