// SPDX-License-Identifier: AGPL-3.0-only
// Read-only demo mode (ADR-122): passwordless viewer sessions, every change refused in one
// place, and no secret or secret-adjacent data in any answer.
import type { RouteOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { encryptJson } from '../src/lib/secrets.js';
import {
  DEMO_READ_ONLY_CODE,
  DEMO_READ_ONLY_MESSAGE,
  DEMO_SESSION_IDLE_MS,
  DEMO_SESSION_REFRESH_MS,
  DEMO_USER_EMAIL,
} from '../src/modules/demo/constants.js';
import { DemoSessions, ensureDemoUser } from '../src/modules/demo/service.js';
import { insertCluster } from '../src/modules/clusters/service.js';
import { issueClusterToken } from '../src/modules/clusters/tokens.js';
import {
  DEMO_ALLOWED,
  DEMO_BLOCKED_READS,
  DEMO_QUERY_RATE,
  DEMO_RANGE_MESSAGE,
  DEMO_STEP_MESSAGE,
  isDemoBlocked,
} from '../src/plugins/demo.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { chartWindow } from '../src/modules/alerts/alert-chart.js';
import {
  ADMIN,
  closeTestContext,
  createTestContext,
  createUserSession,
  sessionCookie,
  setupAdmin,
  TEST_SECRET_KEY,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
afterEach(() => closeTestContext(ctx));

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const REQUIRED_ENV = {
  DATABASE_URL: 'postgres://x@localhost/x',
  WATCHLOG_SECRET_KEY: TEST_SECRET_KEY,
};
const SAMPLE_ID = '01a18f0e-a6c2-71ef-a7b4-42d765746d40';

/** Every route the app registers, one entry per method. */
async function demoContext(demoMode = true) {
  const routes: { method: string; url: string }[] = [];
  const onRoute = (r: RouteOptions) => {
    for (const method of [r.method].flat()) routes.push({ method, url: r.url });
  };
  ctx = await createTestContext({ demoMode }, { onRoute });
  return routes;
}

const api = (method: string, url: string, cookie?: string, payload?: object) =>
  ctx.app.inject({
    method: method as 'GET',
    url: url.startsWith('/ingest') ? url : `/api/v1${url}`,
    ...(cookie ? { cookies: { wl_session: cookie } } : {}),
    ...(payload ? { payload } : {}),
  });

async function enterDemo(cookie?: string) {
  const res = await api('POST', '/demo/session', cookie);
  expect(res.statusCode).toBe(200);
  return { res, cookie: sessionCookie(res) ?? cookie! };
}

function expectReadOnly(res: Awaited<ReturnType<typeof api>>, what: string) {
  expect(res.statusCode, what).toBe(403);
  expect(res.headers['content-type'], what).toMatch(/^application\/problem\+json/);
  expect(res.json(), what).toMatchObject({
    type: 'urn:watchlog:problem:demo-read-only',
    status: 403,
    detail: DEMO_READ_ONLY_MESSAGE,
    code: DEMO_READ_ONLY_CODE,
    message: DEMO_READ_ONLY_MESSAGE,
  });
}

describe('demo mode guard', () => {
  it('refuses every non-GET route outside the allowlist, for admins and visitors alike', async () => {
    const routes = await demoContext();
    const { orgId } = await createUserSession(ctx.db, { role: 'owner' });
    const admin = (await createUserSession(ctx.db, { role: 'owner', orgId })).cookie;
    const { cookie: visitor } = await enterDemo();

    const writes = routes.filter((r) => !SAFE.has(r.method));
    // The app has many changing routes; an empty list would mean the hook saw nothing.
    expect(writes.length).toBeGreaterThan(30);
    const allowed: string[] = [];
    for (const r of writes) {
      const url = r.url.replace(/:[A-Za-z]+/g, SAMPLE_ID);
      for (const cookie of [admin, visitor, undefined]) {
        const res = await ctx.app.inject({
          method: r.method as 'POST',
          url,
          ...(cookie ? { cookies: { wl_session: cookie } } : {}),
          payload: {},
        });
        const name = `${r.method} ${r.url} (${cookie === admin ? 'admin' : cookie ? 'visitor' : 'anonymous'})`;
        if (isDemoBlocked(r.method, r.url)) expectReadOnly(res, name);
        else {
          expect(res.body, name).not.toContain(DEMO_READ_ONLY_CODE);
          allowed.push(`${r.method} ${r.url}`);
        }
      }
    }
    // The allowlist is exactly the demo sign-in, sign-out, chart queries and agent ingest.
    expect([...new Set(allowed)].sort()).toEqual(
      [
        ...DEMO_ALLOWED.map((a) => `${a.method} ${a.url}`),
        ...writes.filter((r) => r.url.startsWith('/ingest/')).map((r) => `${r.method} ${r.url}`),
      ].sort(),
    );
    expect(allowed.some((a) => a.startsWith('POST /ingest/v1/write'))).toBe(true);
  });

  it('refuses reads with side effects, and serves every other read', async () => {
    const routes = await demoContext();
    const { cookie } = await enterDemo();
    for (const url of DEMO_BLOCKED_READS) {
      expect(
        routes.some((r) => r.method === 'GET' && r.url === url),
        url,
      ).toBe(true);
      expectReadOnly(await api('GET', url.replace('/api/v1', ''), cookie), url);
    }
    for (const url of ['/me', '/clusters', '/alert-rules', '/alerts', '/settings/general']) {
      expect((await api('GET', url, cookie)).statusCode, url).toBe(200);
    }
  });

  it('lets agents send data', async () => {
    await demoContext();
    const orgId = (await createUserSession(ctx.db, { role: 'owner' })).orgId;
    const cluster = await insertCluster(ctx.db, orgId, 'demo', 'docker');
    const token = await issueClusterToken(ctx.db, cluster.id);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/heartbeat',
      headers: { authorization: `Bearer ${token.value}`, 'x-watchlog-agent': 'h1' },
      payload: { agent_version: 'dev', mode: 'docker', node: 'h1', capabilities: {}, series: 1 },
    });
    expect(res.statusCode).toBe(204);
    // Without a token the ingest's own 401 answers, not the demo's 403.
    expect((await api('POST', '/ingest/v1/heartbeat', undefined, {})).statusCode).toBe(401);
  });

  it('does nothing outside demo mode', async () => {
    await demoContext(false);
    const cookie = await setupAdmin(ctx.app);
    expect((await api('PUT', '/settings/general', cookie, { publicUrl: null })).statusCode).toBe(
      200,
    );
    expect((await api('GET', '/setup')).json()).toEqual({ required: false, demoMode: false });
    expect((await api('POST', '/demo/session')).statusCode).toBe(404);
  });
});

describe('demo sessions', () => {
  const sessions = () => new DemoSessions(Buffer.from(TEST_SECRET_KEY, 'base64'));
  const demoCookieOf = (res: Awaited<ReturnType<typeof api>>) =>
    res.cookies.find((c) => c.name === 'wl_session');

  it('signs a visitor in as the demo viewer: a signed cookie, no database row', async () => {
    await demoContext();
    expect((await api('GET', '/setup')).json()).toEqual({ required: false, demoMode: true });
    const before = Date.now();
    const { res, cookie } = await enterDemo();
    expect(res.json().user).toMatchObject({ email: DEMO_USER_EMAIL, role: 'viewer' });
    const set = demoCookieOf(res)!;
    // Plain http here; Secure over https is in proxy.test.ts (ADR-123).
    expect(set).toMatchObject({ path: '/', httpOnly: true, sameSite: 'Lax' });
    expect(cookie).toMatch(/^wl_demo\./);
    const ttl = set.expires!.getTime() - before;
    expect(Math.abs(ttl - DEMO_SESSION_IDLE_MS)).toBeLessThan(5_000);
    expect((await api('GET', '/me', cookie)).json().user.role).toBe('viewer');

    // A second click with a valid cookie keeps it.
    const again = await enterDemo(cookie);
    expect(sessionCookie(again.res)).toBeUndefined();
    // Many visitors cost no rows (15: the sign-in itself is limited to 20 a minute per IP).
    for (let i = 0; i < 15; i++) await enterDemo();
    expect(await ctx.db.selectFrom('sessions').select('id').execute()).toEqual([]);

    // Sign-out clears the cookie; sign-in with a password is refused, even as the demo user.
    const out = await api('POST', '/auth/logout', cookie);
    expect(out.statusCode).toBe(204);
    expect(demoCookieOf(out)?.value).toBe('');
    expectReadOnly(
      await api('POST', '/auth/login', undefined, { email: DEMO_USER_EMAIL, password: 'x' }),
      'login',
    );
  });

  it('ends 2 hours after the last request, renews itself, and cannot be forged', async () => {
    await demoContext();
    await ensureDemoUser(ctx.db);
    const s = sessions();
    const now = Date.now();
    const me = (cookie: string) => api('GET', '/me', cookie);

    // Fresh: accepted, not renewed.
    const fresh = await me(s.issue(now - 60_000).token);
    expect(fresh.statusCode).toBe(200);
    expect(demoCookieOf(fresh)).toBeUndefined();
    // Older than the refresh interval: accepted and renewed for another 2 hours.
    const old = await me(s.issue(now - DEMO_SESSION_REFRESH_MS - 60_000).token);
    expect(old.statusCode).toBe(200);
    const renewed = demoCookieOf(old)!;
    expect(renewed.value).toMatch(/^wl_demo\./);
    expect(renewed.expires!.getTime()).toBeGreaterThan(now + DEMO_SESSION_IDLE_MS - 5_000);
    // Idle for longer than 2 hours: expired.
    expect((await me(s.issue(now - DEMO_SESSION_IDLE_MS - 1_000).token)).statusCode).toBe(401);
    // Tampered, or signed with another key: refused.
    const good = s.issue(now).token;
    const [prefix, iat, , sig] = good.split('.');
    const later = `${prefix}.${iat}.${now + 365 * 86_400_000}.${sig}`;
    expect((await me(later)).statusCode).toBe(401);
    const other = new DemoSessions(Buffer.alloc(32, 9)).issue(now).token;
    expect((await me(other)).statusCode).toBe(401);
    expect(s.verify(good, now)).not.toBeNull();
    expect(s.verify(good, now + DEMO_SESSION_IDLE_MS + 1)).toBeNull();
  });

  it('is not accepted when demo mode is off', async () => {
    await demoContext(false);
    await ensureDemoUser(ctx.db);
    const token = sessions().issue().token;
    const res = await api('GET', '/me', token);
    expect(res.statusCode).toBe(401);
  });

  it('never lets the demo account sign in, and does not count it as the admin', async () => {
    // Demo first, without an admin; then demo mode is turned off.
    await demoContext(false);
    await ensureDemoUser(ctx.db);
    await ensureDemoUser(ctx.db); // idempotent
    expect((await api('GET', '/setup')).json().required).toBe(true);
    const login = await api('POST', '/auth/login', undefined, {
      email: DEMO_USER_EMAIL,
      password: '!demo-account-has-no-password',
    });
    expect(login.statusCode).toBe(401);
    // First-run setup still works and joins the demo's org.
    const cookie = await setupAdmin(ctx.app);
    const me = (await api('GET', '/me', cookie)).json().user;
    expect(me).toMatchObject({ email: ADMIN.email, role: 'owner' });
    expect(await ctx.db.selectFrom('orgs').select('id').execute()).toEqual([{ id: me.org.id }]);
  });
});

describe('secrets in demo mode', () => {
  async function seed() {
    const userId = await ensureDemoUser(ctx.db);
    const { org_id: orgId } = await ctx.db
      .selectFrom('memberships')
      .select('org_id')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    const key = Buffer.from(TEST_SECRET_KEY, 'base64');
    const channel = (type: string, config: object, secret?: Record<string, string>) =>
      ctx.db
        .insertInto('alert_channels')
        .values({
          id: newId(),
          org_id: orgId,
          type,
          name: `ops ${type}`,
          config: JSON.stringify(config),
          secret: secret ? encryptJson(key, secret) : null,
          last_error: 'HTTP 403 from https://hooks.example.com/abc',
        })
        .execute();
    await channel('slack', {}, { webhookUrl: 'https://hooks.slack.com/services/T0/B0/xyzPLMN' });
    await channel('email', { recipients: ['oncall@example.com'] });
    await channel(
      'webhook',
      { url: 'https://bob:hunter2@hooks.example.com/in?token=abc' },
      { signingSecret: 'signing-secret-KJHG' },
    );
    await channel(
      'telegram',
      { botName: 'acme_bot', chatName: 'Bob Smith', chatId: 42 },
      { botToken: '123456:ABCdefGHIjklMNOpqrSTUvwxYZ' },
    );
    const cluster = await insertCluster(ctx.db, orgId, 'demo', 'kubernetes');
    await issueClusterToken(ctx.db, cluster.id);
    await ctx.db
      .insertInto('server_settings')
      .values([
        {
          key: 'smtp',
          value: JSON.stringify({
            host: 'smtp.example.com',
            port: 587,
            security: 'starttls',
            username: 'mailer@example.com',
            from: 'alerts@example.com',
          }),
          secret: encryptJson(key, { password: 'smtp-password-QZXW' }),
        },
        { key: 'telegram', value: JSON.stringify({ proxyUrl: 'http://px:pw-secret@proxy:3128' }) },
      ])
      .execute();
    return cluster.id;
  }

  it('returns no channel targets, tokens, mail server or proxy', async () => {
    await demoContext();
    const clusterId = await seed();
    const { cookie } = await enterDemo();
    const bodies = await Promise.all(
      ['/alert-channels', `/clusters/${clusterId}`, '/settings/smtp', '/settings/telegram'].map(
        async (url) => {
          const res = await api('GET', url, cookie);
          expect(res.statusCode, url).toBe(200);
          return res.body;
        },
      ),
    );
    const all = bodies.join('\n');
    for (const leak of [
      'hooks.slack.com',
      'PLMN',
      'oncall@example.com',
      'hooks.example.com',
      'hunter2',
      'KJHG',
      'acme_bot',
      'Bob Smith',
      'wxYZ',
      'smtp.example.com',
      'mailer@',
      'QZXW',
      'pw-secret',
      'proxy:3128',
    ]) {
      expect(all, leak).not.toContain(leak);
    }
    const channels = JSON.parse(bodies[0]!).channels;
    expect(channels).toHaveLength(4);
    expect(channels.map((c: { name: string }) => c.name).sort()).toEqual([
      'ops email',
      'ops slack',
      'ops telegram',
      'ops webhook',
    ]);
    expect(JSON.parse(bodies[1]!).tokens).toEqual([]);
    expect(JSON.parse(bodies[2]!)).toEqual({ smtp: null });
    expect(JSON.parse(bodies[3]!)).toEqual({ proxyUrl: null, source: 'none' });
  });

  it('never returns a password inside a proxy or webhook address, in any mode', async () => {
    await demoContext(false);
    const cookie = await setupAdmin(ctx.app);
    const viewer = (
      await createUserSession(ctx.db, {
        role: 'viewer',
        orgId: (await api('GET', '/me', cookie)).json().user.org.id,
      })
    ).cookie;
    await api('PUT', '/settings/telegram', cookie, { proxyUrl: 'http://px:pw-secret@proxy:3128' });
    const shown = (await api('GET', '/settings/telegram', viewer)).json();
    expect(shown).toEqual({ proxyUrl: 'http://px:****@proxy:3128/', source: 'db' });
    // Saving the form unchanged keeps the stored password.
    await api('PUT', '/settings/telegram', cookie, { proxyUrl: shown.proxyUrl });
    const row = await ctx.db
      .selectFrom('server_settings')
      .select('value')
      .where('key', '=', 'telegram')
      .executeTakeFirstOrThrow();
    expect((row.value as { proxyUrl: string }).proxyUrl).toBe('http://px:pw-secret@proxy:3128/');

    const created = await api('POST', '/alert-channels', cookie, {
      type: 'webhook',
      name: 'hook',
      settings: { url: 'https://bob:hunter2@hooks.example.com/in?token=abc&team=ops' },
    });
    expect(created.statusCode).toBe(201);
    const list = (await api('GET', '/alert-channels', viewer)).json().channels;
    expect(list[0].config.url).toBe('https://bob:****@hooks.example.com/in?token=****&team=ops');
  });
});

describe('demo query cost', () => {
  /** A demo visitor and a cluster in the demo's org. */
  async function visitorWithCluster() {
    const userId = await ensureDemoUser(ctx.db);
    const { org_id: orgId } = await ctx.db
      .selectFrom('memberships')
      .select('org_id')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    const cluster = await insertCluster(ctx.db, orgId, 'demo', 'kubernetes');
    const { cookie } = await enterDemo();
    return { cookie, clusterId: cluster.id };
  }
  const nowS = () => Math.floor(Date.now() / 1000);
  const query = (cookie: string, body: object) => api('POST', '/query/range', cookie, body);

  it('refuses ranges over 24 hours and steps that draw too many points', async () => {
    await demoContext();
    const { cookie, clusterId } = await visitorWithCluster();
    const base = { clusterId, metric: 'node.cpu.utilization' };
    const t = nowS();
    const problemOf = async (res: Awaited<ReturnType<typeof api>>) => {
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      return res.json().detail;
    };
    // 25 hours, and an hour from two days ago.
    expect(await problemOf(await query(cookie, { ...base, from: t - 25 * 3600, to: t }))).toBe(
      DEMO_RANGE_MESSAGE,
    );
    expect(
      await problemOf(await query(cookie, { ...base, from: t - 48 * 3600, to: t - 47 * 3600 })),
    ).toBe(DEMO_RANGE_MESSAGE);
    // 24 hours at a 15 s step is 5,760 points.
    expect(
      await problemOf(await query(cookie, { ...base, from: t - 86_400, to: t, step: 15 })),
    ).toBe(DEMO_STEP_MESSAGE);
    // The same day at the server's own step is fine.
    expect((await query(cookie, { ...base, from: t - 86_400, to: t })).statusCode).toBe(200);

    // Page endpoints: `range` and `from` are limited the same way.
    const overview = await api('GET', `/clusters/${clusterId}/overview?range=604800`, cookie);
    expect(await problemOf(overview)).toBe(DEMO_RANGE_MESSAGE);
    const events = await api('GET', `/clusters/${clusterId}/events?from=${t - 3 * 86_400}`, cookie);
    expect(await problemOf(events)).toBe(DEMO_RANGE_MESSAGE);
    expect(
      (await api('GET', `/clusters/${clusterId}/overview?range=86400`, cookie)).statusCode,
    ).toBe(200);
  });

  it('leaves ranges alone outside demo mode', async () => {
    await demoContext(false);
    const cookie = await setupAdmin(ctx.app);
    const orgId = (await api('GET', '/me', cookie)).json().user.org.id;
    const cluster = await insertCluster(ctx.db, orgId, 'prod', 'kubernetes');
    const t = nowS();
    const res = await query(cookie, {
      clusterId: cluster.id,
      metric: 'node.cpu.utilization',
      from: t - 7 * 86_400,
      to: t,
    });
    expect(res.statusCode).toBe(200);
  });

  it('rate-limits the queries of each visitor (429), by the configured client IP header', async () => {
    ctx = await createTestContext({ demoMode: true, clientIpHeader: 'X-Real-IP' });
    const { cookie } = await enterDemo();
    const from = (ip: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/query/range',
        cookies: { wl_session: cookie },
        headers: { 'x-real-ip': ip },
        payload: {}, // invalid: cheap, and still counted
      });
    for (let i = 0; i < DEMO_QUERY_RATE; i++) {
      expect((await from('203.0.113.7')).statusCode).toBe(400);
    }
    const limited = await from('203.0.113.7');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(limited.headers['retry-after']).toBeDefined();
    // Page endpoints that query VictoriaMetrics share the budget.
    const page = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/clusters/${SAMPLE_ID}/overview`,
      cookies: { wl_session: cookie },
      headers: { 'x-real-ip': '203.0.113.7' },
    });
    expect(page.statusCode).toBe(429);
    // Another visitor is not affected; reads that do not query metrics are not limited.
    expect((await from('198.51.100.9')).statusCode).toBe(400);
    expect((await api('GET', '/me', cookie)).statusCode).toBe(200);
  });

  it('aborts a VictoriaMetrics query that takes too long', async () => {
    const hanging = createServer(() => {}); // never answers
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    try {
      const port = (hanging.address() as AddressInfo).port;
      ctx = await createTestContext({
        demoMode: true,
        victoriaMetricsUrl: `http://127.0.0.1:${port}`,
        queryTimeoutMs: 300,
      });
      const { cookie, clusterId } = await visitorWithCluster();
      const started = Date.now();
      const t = nowS();
      const res = await query(cookie, {
        clusterId,
        metric: 'node.cpu.utilization',
        from: t - 3600,
        to: t,
      });
      expect(res.statusCode).toBe(503);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      hanging.closeAllConnections();
      hanging.close();
    }
    // Demo mode's own timeout is 10 s (15 s otherwise).
    expect(loadConfig({ ...REQUIRED_ENV, WATCHLOG_DEMO_MODE: 'true' }).queryTimeoutMs).toBe(10_000);
    expect(loadConfig(REQUIRED_ENV).queryTimeoutMs).toBe(15_000);
  });

  it('charts at most a day of a long alert', () => {
    const now = Date.now();
    const w = chartWindow(
      { startedAt: now - 5 * 86_400_000, resolvedAt: null },
      0,
      now,
      undefined,
      86_400,
    );
    expect(w.to - w.from).toBe(86_400);
  });
});

describe('ingest stays token-only', () => {
  for (const demoMode of [true, false]) {
    it(`answers 401 without a valid cluster token, cookies or not (demo mode ${demoMode ? 'on' : 'off'})`, async () => {
      const routes = await demoContext(demoMode);
      const ingest = routes.filter((r) => r.url.startsWith('/ingest/') && !SAFE.has(r.method));
      expect(ingest.map((r) => r.url).sort()).toEqual([
        '/ingest/v1/events',
        '/ingest/v1/heartbeat',
        '/ingest/v1/objects',
        '/ingest/v1/write',
      ]);
      const admin = (await createUserSession(ctx.db, { role: 'owner' })).cookie;
      const demoCookie = new DemoSessions(Buffer.from(TEST_SECRET_KEY, 'base64')).issue().token;
      await ensureDemoUser(ctx.db);
      const attempts: { name: string; headers?: Record<string, string>; cookie?: string }[] = [
        { name: 'no credentials' },
        { name: 'a wrong token', headers: { authorization: `Bearer wl_ct_${'x'.repeat(43)}` } },
        { name: 'not a bearer token', headers: { authorization: 'Basic YWRtaW46YWRtaW4=' } },
        { name: 'a demo session cookie', cookie: demoCookie },
        { name: "an admin's session cookie", cookie: admin },
        {
          name: 'a session cookie as the token',
          headers: { authorization: `Bearer ${demoCookie}` },
        },
      ];
      for (const r of ingest) {
        for (const a of attempts) {
          const res = await ctx.app.inject({
            method: r.method as 'POST',
            url: r.url,
            headers: { 'content-type': 'application/json', ...a.headers },
            ...(a.cookie ? { cookies: { wl_session: a.cookie } } : {}),
            payload: '{}',
          });
          expect(res.statusCode, `${r.method} ${r.url} with ${a.name}`).toBe(401);
        }
      }
      // Nothing was recorded.
      expect(await ctx.db.selectFrom('agent_instances').select('id').execute()).toEqual([]);
    });
  }
});
