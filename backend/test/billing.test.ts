// SPDX-License-Identifier: AGPL-3.0-only
// Plan & billing's actions in Cloud (ADR-178): the product calls the billing service with
// the internal token, for the session's org only; Owners only for the writes; the billing
// service's refusals and outages become problems the page has words for. The billing
// service here is a small HTTP fake that records what it's asked and, for the beta, writes
// the entitlements as the real one does through the internal API.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  type TestContext,
} from './helpers.js';

const TOKEN = 'b'.repeat(48);
const offline = (async () => new Response('offline', { status: 599 })) as typeof fetch;

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}

let ctx: TestContext | undefined;
let fake: Server | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
  fake?.close();
  fake = undefined;
});

type Handler = (
  req: IncomingMessage,
  body: unknown,
) => { status: number; json: unknown } | Promise<{ status: number; json: unknown }>;

async function fakeBilling(handler: Handler) {
  const seen: Seen[] = [];
  fake = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const r = await handler(req, body);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => fake!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(fake!.address() as AddressInfo).port}`, seen };
}

const state = (over: object = {}) => ({
  live: false,
  customer: false,
  subscription: null,
  beta: null,
  dunning: null,
  ...over,
});

/** A Cloud app (billing at `billingUrl`) with one signed-up Owner. */
async function cloud(billingUrl?: string) {
  const overrides: Partial<Config> = {
    edition: 'cloud',
    cookieSecure: 'always',
    accounts: {
      turnstile: {},
      supportEmail: 'support@watchlog.io',
      sampleUrl: 'https://demo.watchlog.io',
    },
    internalApi: { token: TOKEN, host: '127.0.0.1', port: 0 },
    ...(billingUrl ? { billingUrl } : {}),
  };
  ctx = await createTestContext(overrides, { fetch: offline });
  const c = ctx;
  const email = `owner-${Date.now()}@acme.example`;
  const res = await c.app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email, password: 'a long enough password' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const cookie = res.cookies.find((x) => x.name === 'wl_session')!.value;
  const as = (session: string) => (method: 'GET' | 'POST', url: string, payload?: object) =>
    c.app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: { wl_session: session },
      ...(payload ? { payload } : {}),
    });
  const call = as(cookie);
  const me = (await call('GET', '/me')).json().user;
  return { c, call, as, orgId: me.org.id as string, orgName: me.org.name as string, email };
}

describe('Plan & billing, through the billing service', () => {
  it('without a billing service: the state says unavailable, the actions answer 503', async () => {
    const { call } = await cloud();
    const s = await call('GET', '/plan/billing');
    expect(s.statusCode).toBe(200);
    expect(s.json()).toEqual({ available: false, ...state() });
    const beta = await call('POST', '/plan/beta');
    expect(beta.statusCode).toBe(503);
    expect(beta.json().code).toBe('billing-unavailable');
  });

  it('"Start Pro, free during beta": the session’s org, with the token; Pro (beta) on the plan', async () => {
    const b = await fakeBilling(async (req) => {
      const orgId = req.url!.split('/')[2]!;
      if (req.url!.endsWith('/beta')) {
        // As the billing service does: Pro, source beta, no end date, through the internal API.
        await ctx!.app.entitlements!.put(orgId, { plan: 'pro', source: 'beta', betaUntil: null });
        return {
          status: 200,
          json: state({ beta: { startedAt: '2026-11-14T00:00:00Z', betaUntil: null } }),
        };
      }
      return { status: 200, json: state() };
    });
    const { call, orgId } = await cloud(b.url);
    expect((await call('GET', '/plan')).json()).toMatchObject({ plan: 'free' });
    expect((await call('GET', '/plan/billing')).json()).toEqual({ available: true, ...state() });

    const res = await call('POST', '/plan/beta');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ available: true, live: false, beta: { betaUntil: null } });
    expect(b.seen.at(-1)).toEqual({
      method: 'POST',
      url: `/orgs/${orgId}/beta`,
      auth: `Bearer ${TOKEN}`,
      body: undefined,
    });
    const plan = (await call('GET', '/plan')).json();
    expect(plan).toMatchObject({ plan: 'pro', source: 'beta', betaUntil: null });
    expect(plan.limits).toMatchObject({
      clusters: null,
      nodes: null,
      users: 10,
      retentionDays: 30,
    });
  });

  it('Owners only: an Admin and a Viewer get 403, and the billing service is never called', async () => {
    const b = await fakeBilling(() => ({ status: 200, json: state() }));
    const { c, as, orgId } = await cloud(b.url);
    for (const role of ['admin', 'viewer'] as const) {
      const { cookie } = await createUserSession(c.db, { role, orgId });
      const call = as(cookie);
      for (const [url, body] of [
        ['/plan/beta', undefined],
        ['/plan/checkout', { interval: 'monthly' }],
        ['/plan/portal', undefined],
      ] as const) {
        const r = await call('POST', url, body);
        expect(r.statusCode, `${role} ${url}`).toBe(403);
      }
      // Reading the state is for every member (the page shows it).
      expect((await call('GET', '/plan/billing')).statusCode).toBe(200);
    }
    expect(b.seen.filter((s) => s.method === 'POST')).toHaveLength(0);
  });

  it('the billing service’s refusals keep their code', async () => {
    const b = await fakeBilling((req) =>
      req.url!.endsWith('/checkout')
        ? { status: 409, json: { code: 'billing-not-live', status: 409 } }
        : req.url!.endsWith('/portal')
          ? { status: 409, json: { code: 'no-billing-customer', status: 409 } }
          : { status: 409, json: { code: 'already-pro', status: 409 } },
    );
    const { call } = await cloud(b.url);
    const co = await call('POST', '/plan/checkout', { interval: 'monthly' });
    expect(co.statusCode).toBe(409);
    expect(co.json()).toMatchObject({
      code: 'billing-not-live',
      type: 'urn:watchlog:problem:billing-not-live',
    });
    expect((await call('POST', '/plan/portal')).json().code).toBe('no-billing-customer');
    expect((await call('POST', '/plan/beta')).json().code).toBe('already-pro');
  });

  it('once live: Upgrade passes the Owner’s email and the org’s name, and returns Checkout’s URL', async () => {
    const b = await fakeBilling((req) =>
      req.url!.endsWith('/checkout')
        ? { status: 200, json: { url: 'https://checkout.stripe.com/c/pay/cs_test_1' } }
        : { status: 200, json: { url: 'https://billing.stripe.com/p/session/test_1' } },
    );
    const { call, orgId, orgName, email } = await cloud(b.url);
    const co = await call('POST', '/plan/checkout', { interval: 'annual', nodes: 25 });
    expect(co.statusCode, co.body).toBe(200);
    expect(co.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    expect(b.seen.at(-1)).toMatchObject({
      url: `/orgs/${orgId}/checkout`,
      body: { interval: 'annual', nodes: 25, email, orgName },
    });
    const portal = await call('POST', '/plan/portal');
    expect(portal.json()).toEqual({ url: 'https://billing.stripe.com/p/session/test_1' });
    // No other intervals; an extra field (another org's id, say) is dropped, never sent.
    expect((await call('POST', '/plan/checkout', { interval: 'weekly' })).statusCode).toBe(400);
    await call('POST', '/plan/checkout', { interval: 'monthly', orgId: 'someone-else' });
    expect(b.seen.at(-1)!.url).toBe(`/orgs/${orgId}/checkout`);
    expect(b.seen.at(-1)!.body).toEqual({ interval: 'monthly', email, orgName });
  });

  it('an answer that isn’t an https page, an error, or no answer at all: 503', async () => {
    const b = await fakeBilling((req) =>
      req.url!.endsWith('/checkout')
        ? { status: 200, json: { url: 'javascript:alert(1)' } }
        : { status: 500, json: { code: 'boom' } },
    );
    const { call } = await cloud(b.url);
    expect((await call('POST', '/plan/checkout', { interval: 'monthly' })).statusCode).toBe(503);
    expect((await call('POST', '/plan/portal')).statusCode).toBe(503);
    expect((await call('GET', '/plan/billing')).json().available).toBe(false);
    await closeTestContext(ctx!);
    const down = await cloud('http://127.0.0.1:9');
    expect((await down.call('POST', '/plan/beta')).statusCode).toBe(503);
    expect((await down.call('GET', '/plan/billing')).json()).toMatchObject({ available: false });
  });
});

describe('WATCHLOG_BILLING_URL', () => {
  const base = {
    DATABASE_URL: 'postgres://a@h/db',
    WATCHLOG_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
  };
  const cloudEnv = {
    ...base,
    WATCHLOG_EDITION: 'cloud',
    DATABASE_URL: 'postgres://watchlog_app@h/db',
    DATABASE_SYSTEM_URL: 'postgres://owner@h/db',
    WATCHLOG_PUBLIC_URL: 'https://cloud.watchlog.example',
  };
  it('is Cloud only, an origin, and needs the internal token', () => {
    expect(() => loadConfig({ ...base, WATCHLOG_BILLING_URL: 'http://billing:8090' })).toThrow(
      /only read with WATCHLOG_EDITION=cloud/,
    );
    expect(() => loadConfig({ ...cloudEnv, WATCHLOG_BILLING_URL: 'http://billing:8090' })).toThrow(
      /needs WATCHLOG_INTERNAL_TOKEN/,
    );
    expect(() =>
      loadConfig({
        ...cloudEnv,
        WATCHLOG_INTERNAL_TOKEN: TOKEN,
        WATCHLOG_BILLING_URL: 'http://billing:8090/x',
      }),
    ).toThrow(/an origin/);
    const c = loadConfig({
      ...cloudEnv,
      WATCHLOG_INTERNAL_TOKEN: TOKEN,
      WATCHLOG_BILLING_URL: 'http://billing:8090/',
    });
    expect(c.billingUrl).toBe('http://billing:8090');
    expect(loadConfig(base).billingUrl).toBeUndefined();
  });
});
