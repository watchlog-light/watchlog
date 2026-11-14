// SPDX-License-Identifier: AGPL-3.0-only
// Cloud's per-org limits on reads and streams (security review SR-9): one org's flood
// gets 429 with Retry-After, another org is not affected; streams are counted while open.
import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { OrgLimits } from '../src/plugins/org-limits.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';

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
