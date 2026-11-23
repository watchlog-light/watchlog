// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The placeholder module through the real loader (ADR-232): the core finds ee/backend, and
// its route answers only with a licence that lists `network`. Runs with the backend's tests.
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../../../backend/src/config.js';
import { loadEeModules } from '../../../backend/src/ee.js';
import {
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from '../../../backend/test/helpers.js';
import { licenseKey, TEST_KEYS } from '../../../backend/test/license-keys.js';

const NOW = Date.parse('2027-03-10T12:00:00Z');
let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

describe('the placeholder module', () => {
  it('is found by the core', async () => {
    const modules = await loadEeModules();
    expect(modules.map((m) => [m.name, m.feature])).toContainEqual(['placeholder', 'network']);
  });

  it('answers only with a licence that lists network', async () => {
    for (const [license, status] of [
      [{}, 404],
      [{ key: licenseKey(NOW, { features: ['pro'] }) }, 404],
      [{ key: licenseKey(NOW, { features: ['network'] }) }, 200],
    ] as const) {
      if (ctx) await closeTestContext(ctx);
      ctx = await createTestContext({ license } as Partial<Config>, {
        licenseTest: { trusted: [TEST_KEYS.x], now: () => NOW },
      });
      const cookie = await setupAdmin(ctx.app);
      const r = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/ee/placeholder',
        cookies: { wl_session: cookie },
      });
      expect(r.statusCode).toBe(status);
      if (status === 200)
        expect(r.json()).toEqual({ module: 'placeholder', feature: 'network', licensed: true });
    }
  });
});
