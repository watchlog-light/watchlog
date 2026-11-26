// SPDX-License-Identifier: AGPL-3.0-only
// The core's side of ee/ (ADR-232): without ee/ nothing is loaded and nothing fails; a
// module's routes answer only while the licence lists its feature (404 without, 403
// license-ended once it ended), read per request; in Cloud the org's Pro plan decides.
// ee/'s own placeholder is tested in ee/backend/test, so deleting ee/ deletes that test too.
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { eeCandidates, loadEeModules } from '../src/ee.js';
import type { EeBackendModule } from '../src/ee-contract.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';
import { DAY, licenseKey, TEST_KEYS } from './license-keys.js';

const NOW = Date.parse('2027-03-10T12:00:00Z');
let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

const fake: EeBackendModule = {
  name: 'fake',
  feature: 'widgets',
  async register(api, host) {
    api.get(
      '/ee/fake',
      { preHandler: [host.requireUser(), host.requireFeature('widgets')], schema: { hide: true } },
      async () => ({ ok: true }),
    );
  },
};

describe('loading ee/', () => {
  it('without ee/: no module, no error', async () => {
    expect(await loadEeModules(['/nowhere/ee/backend/index.js'])).toEqual([]);
  });

  it('looks for the built entry beside dist/, and for the sources under tsx', () => {
    expect(eeCandidates('file:///app/dist/ee.js')).toEqual([
      '/app/ee/backend/index.js',
      '/ee/backend/dist/index.js',
    ]);
    expect(eeCandidates('file:///repo/backend/src/ee.ts')).toEqual([
      '/repo/ee/backend/src/index.ts',
    ]);
  });

  it('a module’s route answers only while the licence lists its feature', async () => {
    const run = async (license: Partial<Config['license']>) => {
      if (ctx) await closeTestContext(ctx);
      ctx = await createTestContext({ license } as Partial<Config>, {
        eeModules: [fake],
        licenseTest: { trusted: [TEST_KEYS.x], now: () => NOW },
      });
      const cookie = await setupAdmin(ctx.app);
      const r = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/ee/fake',
        cookies: { wl_session: cookie },
      });
      return { status: r.statusCode, type: r.json().type as string | undefined };
    };
    expect(await run({})).toEqual({ status: 404, type: 'about:blank' });
    expect(await run({ key: licenseKey(NOW, { features: ['pro'] }) })).toMatchObject({
      status: 404,
    });
    expect(await run({ key: licenseKey(NOW, { features: ['widgets'] }) })).toEqual({
      status: 200,
      type: undefined,
    });
    const ended = licenseKey(NOW, {
      features: ['widgets'],
      issuedAt: new Date(NOW - 400 * DAY).toISOString(),
      expiresAt: new Date(NOW - 30 * DAY).toISOString(),
    });
    expect(await run({ key: ended })).toEqual({
      status: 403,
      type: 'urn:watchlog:problem:license-ended',
    });
    // Not signed in: 401 before anything about the licence.
    const anon = await ctx!.app.inject({ method: 'GET', url: '/api/v1/ee/fake' });
    expect(anon.statusCode).toBe(401);
    // The app is built four times: 3 to 5 seconds on CI's runners, past the default limit on a
    // slow one (it failed there at 5.4 s on 2026-11-26).
  }, 30_000);
});
