// SPDX-License-Identifier: AGPL-3.0-only
// Cloud's per-org limits on reads and streams (security review SR-9): one org's flood
// gets 429 with Retry-After, another org is not affected; streams are counted while open.
import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { OrgQueriesBusy, OrgQueryLimiter } from '../src/lib/org-queries.js';
import { OrgLimits } from '../src/plugins/org-limits.js';
import {
  closeTestContext,
  createTestContext,
  setupAdmin,
  TEST_VM_URL,
  type TestContext,
} from './helpers.js';

const CLOUD: Partial<Config> = {
  edition: 'cloud',
  cookieSecure: 'always',
  accounts: {
    turnstile: {},
    supportEmail: 'support@watchlog.io',
    sampleUrl: 'https://demo.watchlog.io',
  },
};

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

describe('per-org limits (Cloud)', () => {
  it("an org over its request budget gets 429 with Retry-After; another org doesn't", async () => {
    let now = 1_000_000;
    ctx = await createTestContext(CLOUD, {
      fetch: (async () => new Response('offline', { status: 599 })) as typeof fetch,
      orgLimits: new OrgLimits({ ratePerSec: 1, burst: 5 }, 2, () => now),
    });
    const c = ctx;
    const signup = async (email: string, ip: string) => {
      const res = await c.app.inject({
        method: 'POST',
        url: '/api/v1/auth/signup',
        remoteAddress: ip,
        payload: { email, password: 'a long enough password' },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.cookies.find((x) => x.name === 'wl_session')!.value;
    };
    const a = await signup('a@one.example', '10.8.0.1');
    const b = await signup('b@two.example', '10.8.0.2');
    const get = (cookie: string) =>
      c.app.inject({ method: 'GET', url: '/api/v1/clusters', cookies: { wl_session: cookie } });
    for (let i = 0; i < 5; i++) expect((await get(a)).statusCode).toBe(200);
    const over = await get(a);
    expect(over.statusCode).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await get(b)).statusCode).toBe(200);
    now += 2_000;
    expect((await get(a)).statusCode).toBe(200);
  });

  it('Community has no per-org limits', async () => {
    ctx = await createTestContext({});
    expect(ctx.app.orgLimits).toBeNull();
  });

  it('counts open streams per org and frees a place when one closes', () => {
    const limits = new OrgLimits({ ratePerSec: 100, burst: 100 }, 2);
    const raws: EventEmitter[] = [];
    const open = (org: string) => {
      const raw = new EventEmitter();
      raws.push(raw);
      const sent: { code?: number } = {};
      const reply = {
        raw,
        header: () => reply,
        code: (n: number) => ((sent.code = n), reply),
        type: () => reply,
        send: () => reply,
        request: { url: '/x' },
      } as unknown as FastifyReply;
      const request = { headers: { accept: 'text/event-stream' }, url: '/x' } as FastifyRequest;
      return { refused: limits.refuse(request, reply, org), sent };
    };
    expect(open('o').refused).toBe(false);
    expect(open('o').refused).toBe(false);
    const third = open('o');
    expect(third.refused).toBe(true);
    expect(third.sent.code).toBe(429);
    expect(open('p').refused).toBe(false);
    expect(limits.openStreams('o')).toBe(2);
    raws[0]!.emit('close');
    raws[0]!.emit('close');
    expect(limits.openStreams('o')).toBe(1);
    expect(open('o').refused).toBe(false);
  });
});

describe('per-org cap on concurrent metric queries (Cloud)', () => {
  const later = () => {
    let done!: () => void;
    const p = new Promise<void>((r) => (done = r));
    return { p, done };
  };

  it('runs a few at once, queues more in order, and refuses beyond the queue or the wait', async () => {
    const limiter = new OrgQueryLimiter({ running: 2, queued: 1, waitMs: 50 });
    const gates = [later(), later()];
    const order: number[] = [];
    const first = limiter.run('o', async () => (await gates[0]!.p, order.push(1)));
    const second = limiter.run('o', async () => (await gates[1]!.p, order.push(2)));
    const third = limiter.run('o', async () => order.push(3));
    expect(limiter.load('o')).toEqual({ running: 2, queued: 1 });
    // Queue full: refused at once. Another org has its own share.
    await expect(limiter.run('o', async () => 4)).rejects.toBeInstanceOf(OrgQueriesBusy);
    await expect(limiter.run('p', async () => 'p')).resolves.toBe('p');
    gates[0]!.done();
    await Promise.all([first, third]);
    expect(order).toEqual([1, 3]);
    gates[1]!.done();
    await second;
    expect(limiter.load('o')).toEqual({ running: 0, queued: 0 });

    // A query that waits longer than waitMs is refused, and its place is freed.
    const hold = later();
    const busy = [limiter.run('o', () => hold.p), limiter.run('o', () => hold.p)];
    const waited = limiter.run('o', async () => 'late');
    await expect(waited).rejects.toBeInstanceOf(OrgQueriesBusy);
    expect(limiter.load('o')).toEqual({ running: 2, queued: 0 });
    hold.done();
    await Promise.all(busy);
    // A failing query frees its slot too.
    await expect(
      limiter.run('o', async () => {
        throw new Error('storage down');
      }),
    ).rejects.toThrow('storage down');
    expect(limiter.load('o')).toEqual({ running: 0, queued: 0 });
  });

  it('a chart or an overview over the cap answers 429 with Retry-After; another org is served', async () => {
    // One at a time, the rest wait up to a second: an overview's ~20 queries go one by one.
    const limiter = new OrgQueryLimiter({ running: 1, queued: 64, waitMs: 1_000 });
    ctx = await createTestContext(
      { ...CLOUD, victoriaMetricsUrl: TEST_VM_URL },
      {
        fetch: (async () => new Response('offline', { status: 599 })) as typeof fetch,
        orgQueries: limiter,
      },
    );
    const c = ctx;
    const org = async (email: string, ip: string) => {
      const res = await c.app.inject({
        method: 'POST',
        url: '/api/v1/auth/signup',
        remoteAddress: ip,
        payload: { email, password: 'a long enough password' },
      });
      expect(res.statusCode, res.body).toBe(201);
      const cookie = res.cookies.find((x) => x.name === 'wl_session')!.value;
      const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
        c.app.inject({ method, url: `/api/v1${url}`, cookies: { wl_session: cookie }, payload });
      const orgId = (await call('GET', '/me')).json().user.org.id as string;
      const cl = await call('POST', '/clusters', { name: 'prod', kind: 'kubernetes' });
      expect(cl.statusCode, cl.body).toBe(201);
      return { orgId, call, clusterId: cl.json().cluster.id as string };
    };
    const a = await org('q-a@one.example', '10.9.0.1');
    const b = await org('q-b@two.example', '10.9.0.2');
    const to = Math.floor(Date.now() / 1000);
    const chart = (o: typeof a) =>
      o.call('POST', '/query/range', {
        clusterId: o.clusterId,
        metric: 'node.cpu.usage',
        from: to - 3600,
        to,
      });
    expect((await chart(a)).statusCode).toBe(200);

    // A's one slot is held (a slow query): A's next queries wait, then are refused; B's run.
    const hold = later();
    const slow = limiter.run(a.orgId, () => hold.p);
    const refused = await chart(a);
    expect(refused.statusCode, refused.body).toBe(429);
    expect(refused.headers['retry-after']).toBe('2');
    const overview = await a.call('GET', `/clusters/${a.clusterId}/overview`);
    expect(overview.statusCode, overview.body).toBe(429);
    expect(overview.headers['retry-after']).toBe('2');
    expect((await chart(b)).statusCode).toBe(200);
    expect((await b.call('GET', `/clusters/${b.clusterId}/overview`)).statusCode).toBe(200);
    hold.done();
    await slow;
    expect((await chart(a)).statusCode).toBe(200);
  });

  it('Community has no cap', async () => {
    // A limiter that refuses everything: Community never uses it.
    ctx = await createTestContext(
      { victoriaMetricsUrl: TEST_VM_URL },
      { orgQueries: new OrgQueryLimiter({ running: 0, queued: 0, waitMs: 0 }) },
    );
    const cookie = await setupAdmin(ctx.app);
    const cl = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: 'prod', kind: 'kubernetes' },
    });
    const to = Math.floor(Date.now() / 1000);
    const chart = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/query/range',
      cookies: { wl_session: cookie },
      payload: { clusterId: cl.json().cluster.id, metric: 'node.cpu.usage', from: to - 3600, to },
    });
    expect(chart.statusCode, chart.body).toBe(200);
  });
});
