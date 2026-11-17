// SPDX-License-Identifier: AGPL-3.0-only
// The demo's shared answer cache, single-flight and load shedding (ADR-206), on a bare app
// with a fake upstream and an injected clock: no database, no VictoriaMetrics, no waiting.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { internalCallMark } from '../src/lib/internal-call.js';
import { DEMO_USER_EMAIL } from '../src/modules/demo/constants.js';
import {
  AnswerCache,
  DEMO_BUSY_RETRY_AFTER_S,
  DEMO_CACHE_HEADER,
  demoCacheEnabled,
  MAX_ANSWER_BYTES,
  registerDemoCache,
  roundRange,
  stableJson,
  type DemoCacheOptions,
} from '../src/plugins/demo-cache.js';

describe('AnswerCache', () => {
  it('keeps an answer for its time to live, on the injected clock', () => {
    let t = 1_000_000;
    const cache = new AnswerCache(1024 * 1024, () => t);
    cache.set('k', { status: 200, contentType: 'application/json', body: '{"a":1}' }, 15_000);
    t += 14_999;
    expect(cache.get('k')?.body).toBe('{"a":1}');
    t += 1;
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size()).toEqual({ entries: 0, bytes: 0 });
  });

  it('drops the least recently used answers past its byte cap, and refuses a huge one', () => {
    const cache = new AnswerCache(300);
    const body = 'x'.repeat(90);
    const a = { status: 200, contentType: 'application/json', body };
    cache.set('a', a, 60_000);
    cache.set('b', a, 60_000);
    cache.set('c', a, 60_000);
    cache.get('a'); // a is now the most recent
    cache.set('d', a, 60_000);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.size().bytes).toBeLessThanOrEqual(300);

    const big = new AnswerCache(64 * 1024 * 1024);
    const huge = { ...a, body: 'x'.repeat(MAX_ANSWER_BYTES + 1) };
    expect(big.set('h', huge, 60_000)).toBe(false);
    expect(big.size().entries).toBe(0);
  });
});

describe('the cache key', () => {
  it('sorts object keys at every depth', () => {
    expect(stableJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } })).toBe(
      stableJson({ a: { c: 3, d: [2, { y: 2, z: 1 }] }, b: 1 }),
    );
    expect(stableJson(undefined)).toBe('');
  });

  it('rounds an absolute range down to the bucket, or to a larger step', () => {
    const q = { from: 1_000_007, to: 1_003_607, range: 3600 };
    roundRange(q, 15, false);
    expect(q).toEqual({ from: 1_000_005, to: 1_003_605, range: 3600 });

    const stepped = { from: 1_000_007, to: 1_003_607, step: 60 };
    roundRange(stepped, 15, false);
    expect(stepped).toEqual({ from: 999_960, to: 1_003_560, step: 60 });

    // POST /query/range: the step the handler would choose (24 h at 1,000 points: 90 s).
    const day = { from: 1_000_007, to: 1_000_007 + 86_400 };
    roundRange(day, 15, true);
    expect(day.from % 90).toBe(0);
    expect(day.to - day.from).toBe(86_400);

    const tiny = { from: 1_000_001, to: 1_000_004 };
    roundRange(tiny, 15, false);
    expect(tiny).toEqual({ from: 999_990, to: 1_000_005 });

    const relative = { range: 3600, window: '6h' };
    roundRange(relative, 15, false);
    expect(relative).toEqual({ range: 3600, window: '6h' });
  });

  it('is on in demo mode only, and never in Cloud', () => {
    expect(demoCacheEnabled({ demoMode: true, edition: 'community' })).toBe(true);
    expect(demoCacheEnabled({ demoMode: false, edition: 'community' })).toBe(false);
    expect(demoCacheEnabled({ demoMode: false, edition: 'cloud' })).toBe(false);
    expect(demoCacheEnabled({ demoMode: true, edition: 'cloud' })).toBe(false);
  });
});

// ---------------------------------------------------------------- on a bare app

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Fake {
  calls: Record<string, number>;
  seen: unknown[];
  /** Holds the upstream route until released. */
  gate: Promise<void> | null;
  open: () => void;
  limited: number;
  stats: () => { hits: number; shared: number; misses: number; shed: number; upstream: number };
}

const DEMO = { 'x-test-user': 'demo' };

async function bareApp(opts: Partial<DemoCacheOptions> = {}, t = { now: 1_000_000_000 }) {
  const fake: Fake = {
    calls: {},
    seen: [],
    gate: null,
    open: () => {},
    limited: 0,
    stats: () => ({ hits: 0, shared: 0, misses: 0, shed: 0, upstream: 0 }),
  };
  const a = Fastify();
  a.decorateRequest('user', null);
  a.addHook('onRequest', async (request) => {
    const who = request.headers['x-test-user'];
    if (who === 'demo') request.user = { email: DEMO_USER_EMAIL } as never;
    if (who === 'other') request.user = { email: 'someone@example.com' } as never;
  });
  const cache = registerDemoCache(a, {
    bucketS: 15,
    maxBytes: 1024 * 1024,
    maxUpstream: 2,
    upstreamRoutes: ['GET /api/v1/clusters/:id/overview', 'POST /api/v1/query/range'],
    limit: async () => {
      fake.limited++;
    },
    now: () => t.now,
    ...opts,
  });
  fake.stats = cache.stats;
  const count = (k: string) => (fake.calls[k] = (fake.calls[k] ?? 0) + 1);
  a.get(
    '/api/v1/clusters/:id/overview',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'integer' },
            to: { type: 'integer' },
            range: { type: 'integer' },
          },
        },
      },
    },
    async (request) => {
      const n = count(`overview:${(request.params as { id: string }).id}`);
      fake.seen.push(request.query);
      if (fake.gate) await fake.gate;
      return { n, query: request.query };
    },
  );
  a.post('/api/v1/query/range', async (request) => {
    fake.seen.push(request.body);
    return { n: count('range'), body: request.body };
  });
  a.get('/api/v1/plain', async () => ({ n: count('plain') }));
  a.get('/api/v1/busy', async (_request, reply) => {
    count('busy');
    if (fake.gate) await fake.gate;
    return reply.code(503).header('retry-after', '7').send({ title: 'busy' });
  });
  a.get('/api/v1/cookie', async (_request, reply) => {
    count('cookie');
    return reply.header('set-cookie', 'wl_session=renewed; Path=/').send({ ok: true });
  });
  a.get('/api/v1/boom', async () => {
    count('boom');
    throw new Error('upstream failed');
  });
  a.get('/api/v1/auth/me', async () => ({ n: count('me') }));
  await a.ready();
  app = a;
  return fake;
}

function hold(fake: Fake) {
  fake.gate = new Promise<void>((r) => (fake.open = r));
}

describe('the demo cache on a request', () => {
  it('answers the same request once per bucket, and again after it', async () => {
    const t = { now: 1_000_000_000 };
    const fake = await bareApp({}, t);
    const get = () =>
      app!.inject({ url: '/api/v1/clusters/c1/overview?range=3600', headers: DEMO });
    const first = await get();
    expect(first.headers[DEMO_CACHE_HEADER]).toBe('miss');
    const second = await get();
    expect(second.headers[DEMO_CACHE_HEADER]).toBe('hit');
    expect(second.body).toBe(first.body);
    expect(second.headers['content-type']).toContain('application/json');
    expect(fake.calls['overview:c1']).toBe(1);

    t.now += 15_000;
    const third = await get();
    expect(third.headers[DEMO_CACHE_HEADER]).toBe('miss');
    expect(fake.calls['overview:c1']).toBe(2);
    // Another cluster, or other parameters, is another answer.
    await app!.inject({ url: '/api/v1/clusters/c2/overview?range=3600', headers: DEMO });
    await app!.inject({ url: '/api/v1/clusters/c1/overview?range=86400', headers: DEMO });
    expect(fake.calls).toMatchObject({ 'overview:c1': 3, 'overview:c2': 1 });
  });

  it('shares an absolute range within one bucket, rounded in the request itself', async () => {
    const fake = await bareApp();
    // One bucket: 1,000,000,005 up to 1,000,000,020 (exclusive).
    for (const s of [1_000_000_005, 1_000_000_010, 1_000_000_019]) {
      await app!.inject({
        method: 'POST',
        url: '/api/v1/query/range',
        headers: DEMO,
        payload: { metric: 'cpu', clusterId: 'c1', from: s - 3600, to: s },
      });
    }
    expect(fake.calls.range).toBe(1);
    expect(fake.seen[0]).toMatchObject({ from: 999_996_405, to: 1_000_000_005 });
    // The body's key order doesn't matter.
    const swapped = await app!.inject({
      method: 'POST',
      url: '/api/v1/query/range',
      headers: DEMO,
      payload: { to: 1_000_000_011, from: 999_996_411, clusterId: 'c1', metric: 'cpu' },
    });
    expect(swapped.headers[DEMO_CACHE_HEADER]).toBe('hit');
  });

  it('sends identical requests in flight upstream once (single-flight)', async () => {
    const fake = await bareApp();
    hold(fake);
    const all = Array.from({ length: 25 }, () =>
      app!.inject({ url: '/api/v1/clusters/c1/overview?range=3600', headers: DEMO }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.calls['overview:c1']).toBe(1);
    fake.open();
    const answers = await Promise.all(all);
    expect(new Set(answers.map((a) => a.body)).size).toBe(1);
    expect(answers.every((a) => a.statusCode === 200)).toBe(true);
    expect(answers.filter((a) => a.headers[DEMO_CACHE_HEADER] === 'shared')).toHaveLength(24);
    expect(fake.stats()).toMatchObject({ misses: 1, shared: 24, upstream: 0 });
  });

  it('shares a 503 in flight with its Retry-After, but never stores it', async () => {
    const fake = await bareApp();
    hold(fake);
    const both = [1, 2].map(() => app!.inject({ url: '/api/v1/busy', headers: DEMO }));
    await new Promise((r) => setTimeout(r, 20));
    fake.open();
    const [a, b] = await Promise.all(both);
    expect([a!.statusCode, b!.statusCode]).toEqual([503, 503]);
    expect(b!.headers['retry-after']).toBe('7');
    expect(fake.calls.busy).toBe(1);
    fake.gate = null;
    await app!.inject({ url: '/api/v1/busy', headers: DEMO });
    expect(fake.calls.busy).toBe(2);
  });

  it('never stores a header but the content type: a renewed cookie stays with its visitor', async () => {
    await bareApp();
    const first = await app!.inject({ url: '/api/v1/cookie', headers: DEMO });
    expect(first.headers['set-cookie']).toBeDefined();
    const hit = await app!.inject({ url: '/api/v1/cookie', headers: DEMO });
    expect(hit.headers[DEMO_CACHE_HEADER]).toBe('hit');
    expect(hit.headers['set-cookie']).toBeUndefined();
  });

  it('serves nobody but the demo viewer, and skips sign-in routes and event streams', async () => {
    const fake = await bareApp();
    for (const headers of [{}, { 'x-test-user': 'other' }, {}, { 'x-test-user': 'other' }]) {
      const r = await app!.inject({ url: '/api/v1/plain', headers });
      expect(r.headers[DEMO_CACHE_HEADER]).toBeUndefined();
    }
    expect(fake.calls.plain).toBe(4);
    await app!.inject({ url: '/api/v1/auth/me', headers: DEMO });
    await app!.inject({ url: '/api/v1/auth/me', headers: DEMO });
    expect(fake.calls.me).toBe(2);
    const sse = { ...DEMO, accept: 'text/event-stream' };
    await app!.inject({ url: '/api/v1/plain', headers: sse });
    await app!.inject({ url: '/api/v1/plain', headers: sse });
    expect(fake.calls.plain).toBe(6);
  });

  it('counts only misses against the visitor rate limit', async () => {
    const fake = await bareApp();
    for (let i = 0; i < 10; i++) {
      await app!.inject({ url: '/api/v1/clusters/c1/overview?range=3600', headers: DEMO });
    }
    expect(fake.limited).toBe(1);
    // Not shared (another user): counted every time, as in 0.8.2.
    await app!.inject({
      url: '/api/v1/clusters/c1/overview?range=3600',
      headers: { 'x-test-user': 'other' },
    });
    expect(fake.limited).toBe(2);
  });

  it("never shares one visitor's 429 with the visitors waiting on the same answer", async () => {
    const t = { now: 1_000_000_000 };
    let limitNext = true;
    const fake = await bareApp(
      {
        limit: async (request, reply) => {
          if (limitNext && request.headers['x-test-ip'] === 'noisy') {
            limitNext = false;
            await new Promise((r) => setTimeout(r, 20));
            await reply.code(429).header('retry-after', '60').send({ title: 'slow down' });
          }
        },
      },
      t,
    );
    const noisy = app!.inject({
      url: '/api/v1/clusters/c1/overview?range=3600',
      headers: { ...DEMO, 'x-test-ip': 'noisy' },
    });
    await new Promise((r) => setTimeout(r, 5));
    const quiet = app!.inject({ url: '/api/v1/clusters/c1/overview?range=3600', headers: DEMO });
    expect((await noisy).statusCode).toBe(429);
    expect((await quiet).statusCode).toBe(200);
    expect(fake.calls['overview:c1']).toBe(1);
  });

  it('answers 503 demo-busy at once past the upstream cap, and frees slots after', async () => {
    const fake = await bareApp({ maxUpstream: 2 });
    hold(fake);
    const running = ['c1', 'c2'].map((c) =>
      app!.inject({ url: `/api/v1/clusters/${c}/overview?range=3600`, headers: DEMO }),
    );
    await new Promise((r) => setTimeout(r, 20));
    const shed = await app!.inject({
      url: '/api/v1/clusters/c3/overview?range=3600',
      headers: DEMO,
    });
    expect(shed.statusCode).toBe(503);
    expect(shed.headers['retry-after']).toBe(String(DEMO_BUSY_RETRY_AFTER_S));
    expect(shed.headers['content-type']).toContain('application/problem+json');
    expect(shed.json()).toMatchObject({ type: 'urn:watchlog:problem:demo-busy', status: 503 });
    // A request already in flight is shared, not shed; an in-process read isn't counted.
    const shared = app!.inject({ url: '/api/v1/clusters/c1/overview?range=3600', headers: DEMO });
    const internal = app!.inject({
      url: '/api/v1/clusters/c4/overview?range=3600',
      headers: { ...DEMO, ...internalCallMark() },
    });
    await new Promise((r) => setTimeout(r, 20));
    fake.open();
    expect((await shared).statusCode).toBe(200);
    expect((await internal).statusCode).toBe(200);
    await Promise.all(running);
    expect(fake.stats()).toMatchObject({ shed: 1, upstream: 0 });
    fake.gate = null;
    const after = await app!.inject({
      url: '/api/v1/clusters/c3/overview?range=3600',
      headers: DEMO,
    });
    expect(after.statusCode).toBe(200);
  });

  it('frees the slot and the waiters when the upstream throws', async () => {
    const fake = await bareApp({ upstreamRoutes: ['GET /api/v1/boom'], maxUpstream: 1 });
    const [a, b] = await Promise.all([
      app!.inject({ url: '/api/v1/boom', headers: DEMO }),
      app!.inject({ url: '/api/v1/boom', headers: DEMO }),
    ]);
    expect([a!.statusCode, b!.statusCode]).toEqual([500, 500]);
    expect(fake.calls.boom).toBe(1);
    expect(fake.stats().upstream).toBe(0);
    await app!.inject({ url: '/api/v1/boom', headers: DEMO });
    expect(fake.calls.boom).toBe(2); // an error is never stored
  });
});
