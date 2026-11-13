// SPDX-License-Identifier: AGPL-3.0-only
// Community unchanged (ADR-173, scenario 4): with WATCHLOG_EDITION unset, the Cloud-only
// paths answer 404, no route is Cloud-only, and the installation's settings work as in
// 0.5.0. The mechanism itself: registerCloudOnly registers in Cloud only.
import Fastify from 'fastify';
import type { RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  CLOUD_ONLY_PATHS,
  isCloudOnly,
  isCommunityOnly,
  registerCloudOnly,
  registerCommunityOnlyGuard,
} from '../../src/plugins/edition.js';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDb } from '../../src/db/index.js';
import { SetupState } from '../../src/modules/setup/service.js';
import {
  closeTestContext,
  createTestContext,
  setupAdmin,
  TEST_SETUP_CODE,
  testConfig,
  type TestContext,
} from '../helpers.js';

let ctx: TestContext;
const routes: RouteOptions[] = [];
let cookie: string;

beforeAll(async () => {
  ctx = await createTestContext({}, { onRoute: (r) => void routes.push(r) });
  cookie = await setupAdmin(ctx.app);
});

afterAll(async () => {
  await closeTestContext(ctx);
});

describe('Community (WATCHLOG_EDITION unset)', () => {
  it('is the default edition, and Cloud needs its own database role', () => {
    const base = {
      DATABASE_URL: 'postgres://u@h/db',
      WATCHLOG_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
    };
    expect(loadConfig(base)).toMatchObject({
      edition: 'community',
      databaseSystemUrl: base.DATABASE_URL,
    });
    // Community ignores DATABASE_SYSTEM_URL: one connection, as in 0.5.0.
    expect(
      loadConfig({ ...base, DATABASE_SYSTEM_URL: 'postgres://o@h/db' }).databaseSystemUrl,
    ).toBe(base.DATABASE_URL);
    expect(() => loadConfig({ ...base, WATCHLOG_EDITION: 'cloud' })).toThrow(/DATABASE_SYSTEM_URL/);
    expect(() =>
      loadConfig({ ...base, WATCHLOG_EDITION: 'cloud', DATABASE_SYSTEM_URL: base.DATABASE_URL }),
    ).toThrow(/watchlog_app/);
    expect(() => loadConfig({ ...base, WATCHLOG_EDITION: 'saas' })).toThrow(/WATCHLOG_EDITION/);
  });

  it('answers 404 for every Cloud-only path, signed in or not', async () => {
    for (const url of CLOUD_ONLY_PATHS) {
      for (const method of ['GET', 'POST'] as const) {
        const anon = await ctx.app.inject({
          method,
          url,
          payload: method === 'POST' ? {} : undefined,
        });
        expect(anon.statusCode, `${method} ${url}`).toBe(404);
        const signed = await ctx.app.inject({ method, url, cookies: { wl_session: cookie } });
        expect(signed.statusCode, `${method} ${url} signed in`).toBe(404);
      }
    }
    expect(routes.filter(isCloudOnly).map((r) => r.url)).toEqual([]);
  });

  it('answers 404 for every route a Cloud app registers as Cloud-only', async () => {
    // The Cloud app's own route table, so a new Cloud route is covered without a list.
    const db = createDb(inject('databaseUrl'));
    const cloudRoutes: RouteOptions[] = [];
    const cloud = await buildApp(testConfig({ edition: 'cloud' }), {
      db,
      setup: new SetupState(() => TEST_SETUP_CODE),
      onRoute: (r) => void cloudRoutes.push(r),
      fetch: async () => {
        throw new Error('offline in tests');
      },
    });
    await cloud.ready();
    await cloud.close();
    await db.destroy();
    const only = cloudRoutes.filter(isCloudOnly).flatMap((r) =>
      [r.method]
        .flat()
        .filter((m) => m !== 'HEAD')
        .map((m) => ({ method: m, url: r.url })),
    );
    expect(only.length).toBeGreaterThanOrEqual(19);
    for (const { method, url } of only) {
      const path = url
        .replace(':id', '00000000-0000-4000-8000-000000000000')
        .replace(':token', 'x'.repeat(43))
        .replace(':provider', 'github');
      for (const cookies of [{} as Record<string, string>, { wl_session: cookie }]) {
        const res = await ctx.app.inject({
          method: method as 'GET',
          url: path,
          cookies,
          ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
        });
        expect(res.statusCode, `${method} ${path}`).toBe(404);
      }
    }
  });

  it("keeps the installation's settings (Cloud-only 404s don't apply)", async () => {
    expect(routes.filter(isCommunityOnly).length).toBeGreaterThan(5);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/settings/general',
      cookies: { wl_session: cookie },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('registerCloudOnly and the Community-only guard', () => {
  async function appFor(edition: 'community' | 'cloud') {
    const seen: RouteOptions[] = [];
    const app = Fastify();
    app.addHook('onRoute', (r) => void seen.push(r));
    registerCommunityOnlyGuard(app, edition);
    await registerCloudOnly(
      app,
      edition,
      async (s) => {
        s.get('/internal/ping', async () => ({ ok: true }));
      },
      { prefix: '' },
    );
    app.get('/settings', { config: { communityOnly: true } }, async () => ({ ok: true }));
    await app.ready();
    return { app, seen };
  }

  it('Community: the Cloud route does not exist; the installation route answers', async () => {
    const { app } = await appFor('community');
    expect((await app.inject({ url: '/internal/ping' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/settings' })).statusCode).toBe(200);
    await app.close();
  });

  it('Cloud: the Cloud route answers and is marked; the installation route is 404', async () => {
    const { app, seen } = await appFor('cloud');
    expect((await app.inject({ url: '/internal/ping' })).statusCode).toBe(200);
    expect(seen.filter((r) => isCloudOnly(r) && r.method === 'GET').map((r) => r.url)).toEqual([
      '/internal/ping',
    ]);
    expect((await app.inject({ url: '/settings' })).statusCode).toBe(404);
    await app.close();
  });
});
