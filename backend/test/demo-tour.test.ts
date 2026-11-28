// SPDX-License-Identifier: AGPL-3.0-only
// The live demo's guided tour (1.3.0, ADR-246): its stories come from the seed, in order, to
// a demo visitor only; each moment is one request answered with nothing, which the demo's
// access log carries to its analytics. Outside demo mode both answer 404, and the seed's tour
// is never read.
import { afterEach, describe, expect, it } from 'vitest';
import { TOUR_EVENTS } from '../src/modules/demo/constants.js';
import type { Seed } from '../src/modules/seed/seed.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(() => closeTestContext(ctx));

const SEED: Seed = {
  demoTour: {
    stories: [
      {
        id: 'rabbitmq-payments',
        kind: 'kubernetes',
        rules: ['RabbitMQ queue growing with no consumers'],
        labels: { queue: 'orders.payments' },
      },
      {
        id: 'legacy-importer',
        kind: 'kubernetes',
        rules: ['k8s.pod.crashloop'],
        labels: { workload: 'legacy-importer' },
        fallback: true,
      },
      {
        id: 'invoices',
        kind: 'server',
        rules: ['server.unit.failed', 'server.unit.crashloop'],
        labels: { unit: 'invoices.service' },
        fallback: true,
      },
    ],
    another: ['legacy-importer', 'invoices'],
  },
};

async function visitor() {
  const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/demo/session' });
  expect(r.statusCode, r.body).toBe(200);
  return r.cookies.find((c) => c.name === 'wl_session')!.value;
}
const get = (url: string, cookie?: string) =>
  ctx.app.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    ...(cookie ? { cookies: { wl_session: cookie } } : {}),
  });

describe('the guided tour in the live demo', () => {
  it("gives a demo visitor the seed's stories in order, with defaults filled in", async () => {
    ctx = await createTestContext({ demoMode: true }, { seed: SEED });
    const cookie = await visitor();
    const r = await get('/demo/tour', cookie);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      stories: [
        {
          id: 'rabbitmq-payments',
          kind: 'kubernetes',
          rules: ['RabbitMQ queue growing with no consumers'],
          labels: { queue: 'orders.payments' },
          fallback: false,
        },
        {
          id: 'legacy-importer',
          kind: 'kubernetes',
          rules: ['k8s.pod.crashloop'],
          labels: { workload: 'legacy-importer' },
          fallback: true,
        },
        {
          id: 'invoices',
          kind: 'server',
          rules: ['server.unit.failed', 'server.unit.crashloop'],
          labels: { unit: 'invoices.service' },
          fallback: true,
        },
      ],
      another: ['legacy-importer', 'invoices'],
    });
    // Signed in only, as every page is.
    expect((await get('/demo/tour')).statusCode).toBe(401);
  });

  it('answers each moment with nothing, uncached, and refuses unknown ones', async () => {
    ctx = await createTestContext({ demoMode: true }, { seed: SEED });
    const cookie = await visitor();
    for (const path of [
      ...TOUR_EVENTS.map((e) => `/demo/tour/event/${e}`),
      '/demo/tour/event/started/k8s',
      '/demo/tour/event/step/2',
      '/demo/tour/event/skipped/0',
      '/demo/tour/event/another/invoices',
    ]) {
      const r = await get(path, cookie);
      expect(r.statusCode, `${path}: ${r.body}`).toBe(204);
      expect(r.body).toBe('');
      expect(r.headers['cache-control']).toBe('no-store');
    }
    expect((await get('/demo/tour/event/clicked', cookie)).statusCode).toBe(400);
    expect((await get('/demo/tour/event/step/Two', cookie)).statusCode).toBe(400);
    expect((await get('/demo/tour/event/shown')).statusCode).toBe(401);
  });

  it('is not there outside demo mode', async () => {
    ctx = await createTestContext({ demoMode: false }, { seed: SEED });
    const cookie = await setupAdmin(ctx.app);
    expect((await get('/demo/tour', cookie)).statusCode).toBe(404);
    expect((await get('/demo/tour/event/shown', cookie)).statusCode).toBe(404);
  });

  it('has no stories when the seed has no tour', async () => {
    ctx = await createTestContext({ demoMode: true });
    const cookie = await visitor();
    expect((await get('/demo/tour', cookie)).json()).toEqual({ stories: [], another: [] });
  });
});
