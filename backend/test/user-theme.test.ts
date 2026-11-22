// SPDX-License-Identifier: AGPL-3.0-only
// The dashboard's theme on the user (ADR-228): System by default, in the session's user,
// set with PATCH /me/preferences by any member (audited once per change), refused for API
// tokens and in the read-only demo.
import { afterEach, describe, expect, it } from 'vitest';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

describe('the theme preference', () => {
  it('defaults to System, is saved, comes back with the session, and is audited once', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const me = () =>
      ctx!.app.inject({ method: 'GET', url: '/api/v1/me', cookies: { wl_session: cookie } });
    const set = (body: object) =>
      ctx!.app.inject({
        method: 'PATCH',
        url: '/api/v1/me/preferences',
        cookies: { wl_session: cookie },
        payload: body,
      });
    expect((await me()).json().user.theme).toBe('system');
    const r = await set({ theme: 'light' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().user.theme).toBe('light');
    expect((await me()).json().user.theme).toBe('light');
    expect((await set({ theme: 'light' })).statusCode).toBe(200); // no change, no audit
    expect((await set({ theme: 'dark' })).json().user.theme).toBe('dark');
    const audited = await ctx.db
      .selectFrom('audit_events')
      .select(['action', 'details'])
      .where('action', '=', 'preferences_changed')
      .execute();
    expect(audited.map((a) => (a.details as { theme: string }).theme)).toEqual(['light', 'dark']);
    // Validation: one of the three, and something to set.
    expect((await set({ theme: 'blue' })).statusCode).toBe(400);
    expect((await set({})).statusCode).toBe(400);
  });

  it('needs a session; an API token can only read it', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const anon = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/me/preferences',
      payload: { theme: 'light' },
    });
    expect(anon.statusCode).toBe(401);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      cookies: { wl_session: cookie },
      payload: { name: 'read' },
    });
    const token = created.json().value as string;
    const viaToken = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/me/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: { theme: 'light' },
    });
    expect(viaToken.statusCode).toBe(403);
    const read = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.json().user.theme).toBe('system');
  });
});
