// SPDX-License-Identifier: AGPL-3.0-only
// Personal API tokens (ADR-125): format and storage, the API, authentication on every
// request (expiry, revocation, a token with a cookie), CSRF, last use and history, the
// limits, demo mode, and reads of a Kubernetes cluster and a Docker fleet with a token.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../src/lib/tokens.js';
import { createSession } from '../src/modules/auth/sessions.js';
import { insertCluster } from '../src/modules/clusters/service.js';
import { TokenUsage } from '../src/modules/api-tokens/service.js';
import {
  displayPrefix,
  generateApiToken,
  isApiTokenFormat,
  MAX_ACTIVE_API_TOKENS,
  MAX_NEW_IP_EVENTS,
  storableIp,
  tokenStatus,
} from '../src/modules/api-tokens/tokens.js';
import { DEMO_READ_ONLY_CODE } from '../src/modules/demo/constants.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  type TestContext,
} from './helpers.js';

/** Unset in the unit tests, which need no app. */
let ctx: TestContext;
afterEach(async () => {
  vi.useRealTimers();
  if (ctx) await closeTestContext(ctx);
  ctx = undefined as unknown as TestContext;
});

const DAY = 86_400_000;

type Cred = { cookie?: string; token?: string };
function api(method: string, url: string, cred: Cred = {}, extra: object = {}) {
  return ctx.app.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    ...(cred.cookie ? { cookies: { wl_session: cred.cookie } } : {}),
    ...(cred.token ? { headers: { authorization: `Bearer ${cred.token}` } } : {}),
    ...extra,
  });
}

async function createToken(cookie: string, body: object = { name: 'Claude Code · laptop' }) {
  const res = await api('POST', '/api-tokens', { cookie }, { payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { value: string; token: { id: string; prefix: string; status: string } };
}

const tokenRow = (id: string) =>
  ctx.db.selectFrom('api_tokens').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const events = (id: string) =>
  ctx.db
    .selectFrom('api_token_events')
    .select(['kind', 'ip', 'country'])
    .where('token_id', '=', id)
    .orderBy('at')
    .orderBy('id')
    .execute();

describe('token format', () => {
  it('is wl_pat_ and 43 base64url characters, stored as SHA-256 with a 4-character prefix', () => {
    const t = generateApiToken();
    expect(t.value).toMatch(/^wl_pat_[A-Za-z0-9_-]{43}$/);
    expect(isApiTokenFormat(t.value)).toBe(true);
    expect(t.hash.equals(sha256(t.value))).toBe(true);
    expect(t.hash).toHaveLength(32);
    expect(t.prefix).toBe(t.value.slice(0, 11));
    expect(displayPrefix('wl_pat_7Kq2abc')).toBe('wl_pat_7Kq2');
    expect(generateApiToken().value).not.toBe(t.value);
    for (const bad of [
      'wl_ct_' + 'a'.repeat(43),
      'wl_pat_' + 'a'.repeat(42),
      'wl_pat_' + '!'.repeat(43),
    ]) {
      expect(isApiTokenFormat(bad), bad).toBe(false);
    }
  });

  it('computes the status from expiry and revocation', () => {
    const now = new Date('2026-11-08T12:00:00Z');
    const at = (ms: number) => new Date(now.getTime() + ms);
    expect(tokenStatus({ revoked_at: null, expires_at: null }, now)).toBe('never');
    expect(tokenStatus({ revoked_at: null, expires_at: at(30 * DAY) }, now)).toBe('active');
    expect(tokenStatus({ revoked_at: null, expires_at: at(7 * DAY) }, now)).toBe('expires_soon');
    expect(tokenStatus({ revoked_at: null, expires_at: at(0) }, now)).toBe('expired');
    expect(tokenStatus({ revoked_at: now, expires_at: at(-DAY) }, now)).toBe('revoked');
  });

  it('stores addresses PostgreSQL accepts', () => {
    expect(storableIp('::ffff:203.0.113.4')).toBe('203.0.113.4');
    expect(storableIp('2001:db8::1')).toBe('2001:db8::1');
    expect(storableIp('')).toBeNull();
    expect(storableIp('not-an-ip')).toBeNull();
  });
});

describe('API tokens API', () => {
  it('creates, lists, shows and revokes a token; the value is shown once', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const created = await createToken(cookie, { name: '  Claude Code · laptop  ' });
    expect(created.value).toMatch(/^wl_pat_[A-Za-z0-9_-]{43}$/);
    expect(created.token).toMatchObject({
      name: 'Claude Code · laptop',
      prefix: created.value.slice(0, 11),
      scope: 'read',
      status: 'active',
      lastUsedAt: null,
      lastUsedIp: null,
      usedRest: false,
      mcpCalls30d: 0,
      revokedAt: null,
    });
    // Default expiry: 90 days.
    const t = created.token as unknown as { createdAt: string; expiresAt: string };
    expect(Date.parse(t.expiresAt) - Date.parse(t.createdAt)).toBe(90 * DAY);
    const never = await createToken(cookie, { name: 'CI', expiresInDays: null });
    expect(never.token).toMatchObject({ status: 'never', expiresAt: null });
    const year = await createToken(cookie, { name: 'Yearly', expiresInDays: 365 });
    expect(year.token.status).toBe('active');

    // Only the hash is stored.
    const row = await tokenRow(created.token.id);
    expect(row.token_hash.equals(sha256(created.value))).toBe(true);
    expect(JSON.stringify(row)).not.toContain(created.value.slice(7));

    const list = await api('GET', '/api-tokens', { cookie });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(created.value);
    expect(list.json().tokens.map((x: { name: string }) => x.name)).toEqual([
      'Yearly',
      'CI',
      'Claude Code · laptop',
    ]);

    const detail = await api('GET', `/api-tokens/${created.token.id}`, { cookie });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      token: { id: created.token.id },
      history: [{ kind: 'created', expiresAt: t.expiresAt, ip: null }],
      activity: [],
    });

    expect((await api('DELETE', `/api-tokens/${created.token.id}`, { cookie })).statusCode).toBe(
      204,
    );
    // Idempotent.
    expect((await api('DELETE', `/api-tokens/${created.token.id}`, { cookie })).statusCode).toBe(
      204,
    );
    const revoked = (await api('GET', `/api-tokens/${created.token.id}`, { cookie })).json();
    expect(revoked.token.status).toBe('revoked');
    expect(revoked.token.revokedAt).not.toBeNull();
    const me = (await api('GET', '/me', { cookie })).json().user;
    expect(revoked.history.map((e: { kind: string }) => e.kind)).toEqual(['revoked', 'created']);
    expect(revoked.history[0].by).toEqual({ id: me.id, name: me.name });
    // Revoked tokens stay listed, after the usable ones.
    const after = (await api('GET', '/api-tokens', { cookie })).json().tokens;
    expect(after.at(-1)).toMatchObject({ id: created.token.id, status: 'revoked' });
  });

  it("stops a disabled account's tokens, as its sessions stop (SR-17)", async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const created = await createToken(cookie, { name: 'CI' });
    expect((await api('GET', '/clusters', { token: created.value })).statusCode).toBe(200);
    await ctx.db.updateTable('users').set({ disabled_at: new Date() }).execute();
    expect((await api('GET', '/clusters', { token: created.value })).statusCode).toBe(401);
  });

  it("validates the body and keeps each user's tokens to themselves", async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    for (const payload of [
      {},
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { name: 'line\nbreak' },
      { name: 'ok', expiresInDays: 7 },
    ]) {
      const res = await api('POST', '/api-tokens', { cookie }, { payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // There is no other scope to ask for.
    const asked = await createToken(cookie, { name: 'write?', scope: 'write' });
    expect(asked.token).toMatchObject({ scope: 'read' });
    const mine = await createToken(cookie);
    const orgId = (await api('GET', '/me', { cookie })).json().user.org.id;
    const other = await createUserSession(ctx.db, { role: 'viewer', orgId });
    // Viewers may have tokens too: they read only what the viewer can read.
    await createToken(other.cookie, { name: 'viewer token' });
    const theirs = (await api('GET', '/api-tokens', { cookie: other.cookie })).json().tokens;
    expect(theirs.map((x: { name: string }) => x.name)).toEqual(['viewer token']);
    for (const method of ['GET', 'DELETE']) {
      const res = await api(method, `/api-tokens/${mine.token.id}`, { cookie: other.cookie });
      expect(res.statusCode, method).toBe(404);
    }
    expect((await api('GET', '/api-tokens')).statusCode).toBe(401);
  });

  it(`allows at most ${MAX_ACTIVE_API_TOKENS} active tokens per user (409 token-limit)`, async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_API_TOKENS; i++) {
      ids.push((await createToken(cookie, { name: `t${i}` })).token.id);
    }
    const limited = await api('POST', '/api-tokens', { cookie }, { payload: { name: 'one more' } });
    expect(limited.statusCode).toBe(409);
    expect(limited.json().type).toBe('urn:watchlog:problem:token-limit');
    // A revoked or expired token frees a place.
    await api('DELETE', `/api-tokens/${ids[0]}`, { cookie });
    await createToken(cookie, { name: 'after revoke' });
    await ctx.db
      .updateTable('api_tokens')
      .set({ created_at: new Date(Date.now() - 2 * DAY), expires_at: new Date(Date.now() - DAY) })
      .where('id', '=', ids[1]!)
      .execute();
    await createToken(cookie, { name: 'after expiry' });
    expect(
      (await api('POST', '/api-tokens', { cookie }, { payload: { name: 'x' } })).statusCode,
    ).toBe(409);
    // Another user has their own ten.
    const orgId = (await api('GET', '/me', { cookie })).json().user.org.id;
    const other = await createUserSession(ctx.db, { role: 'admin', orgId });
    await createToken(other.cookie);
  });

  it('never writes the token value to the log', async () => {
    const lines: string[] = [];
    ctx = await createTestContext(
      { logLevel: 'trace' },
      { logStream: { write: (line: string) => void lines.push(line) } },
    );
    const cookie = await setupAdmin(ctx.app);
    const created = await createToken(cookie);
    expect((await api('GET', '/me', { token: created.value })).statusCode).toBe(200);
    expect((await api('GET', '/settings/smtp', { token: created.value })).statusCode).toBe(403);
    await api('DELETE', `/api-tokens/${created.token.id}`, { cookie });
    expect((await api('GET', '/me', { token: created.value })).statusCode).toBe(401);
    const log = lines.join('');
    expect(log).toContain('API token created');
    expect(log).toContain(created.token.prefix);
    expect(log).not.toContain(created.value);
    expect(log).not.toContain(created.value.slice(11));
    expect(log).not.toContain(cookie);
  });

  it('answers in demo mode: the list is empty, creating is refused', async () => {
    ctx = await createTestContext({ demoMode: true });
    const enter = await api('POST', '/demo/session');
    const cookie = enter.cookies.find((c) => c.name === 'wl_session')!.value;
    const list = await api('GET', '/api-tokens', { cookie });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ tokens: [] });
    const create = await api('POST', '/api-tokens', { cookie }, { payload: { name: 'x' } });
    expect(create.statusCode).toBe(403);
    expect(create.json().code).toBe(DEMO_READ_ONLY_CODE);
    const revoke = await api('DELETE', `/api-tokens/01a18f0e-a6c2-71ef-a7b4-42d765746d40`, {
      cookie,
    });
    expect(revoke.json().code).toBe(DEMO_READ_ONLY_CODE);
  });
});

describe('authenticating with a token', () => {
  it('acts as the token user, on every request: revocation counts at the next request', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const { value, token } = await createToken(cookie);
    const me = await api('GET', '/me', { token: value });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('admin@example.com');
    expect((await api('GET', '/clusters', { token: value })).statusCode).toBe(200);
    await api('DELETE', `/api-tokens/${token.id}`, { cookie });
    const after = await api('GET', '/me', { token: value });
    expect(after.statusCode).toBe(401);
    expect(after.headers['www-authenticate']).toMatch(/^Bearer/);
    expect(after.headers['content-type']).toMatch(/^application\/problem\+json/);
  });

  it('refuses unknown and malformed tokens with 401 and WWW-Authenticate: Bearer', async () => {
    ctx = await createTestContext();
    await setupAdmin(ctx.app);
    for (const token of [generateApiToken().value, 'wl_pat_short', 'garbage', '']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, token).toBe(401);
      expect(res.headers['www-authenticate'], token).toMatch(/^Bearer/);
    }
  });

  it('refuses a token whose user left the org', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const orgId = (await api('GET', '/me', { cookie })).json().user.org.id;
    const other = await createUserSession(ctx.db, { role: 'viewer', orgId });
    const { value } = await createToken(other.cookie);
    expect((await api('GET', '/me', { token: value })).json().user.role).toBe('viewer');
    await ctx.db.deleteFrom('memberships').where('user_id', '=', other.userId).execute();
    expect((await api('GET', '/me', { token: value })).statusCode).toBe(401);
  });

  it('refuses a token and a session cookie on one request (400)', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const { value } = await createToken(cookie);
    for (const [method, url] of [
      ['GET', '/me'],
      ['POST', '/query/range'],
      ['POST', '/auth/logout'],
    ] as const) {
      const res = await api(method, url, { cookie, token: value }, { payload: {} });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().type, url).toBe('urn:watchlog:problem:token-with-session');
    }
    // The session itself still works.
    expect((await api('GET', '/me', { cookie })).statusCode).toBe(200);
  });

  it('expires: 401 after the expiry, and the status follows the clock', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const { value, token } = await createToken(cookie, { name: 'short', expiresInDays: 30 });
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: start + 24 * DAY });
    expect((await api('GET', '/me', { token: value })).statusCode).toBe(200);
    expect((await api('GET', '/api-tokens', { cookie })).json().tokens[0].status).toBe(
      'expires_soon',
    );
    vi.setSystemTime(start + 30 * DAY + 1000);
    const res = await api('GET', '/me', { token: value });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
    // Sessions last 30 days: sign in again at the new time.
    const userId = (await tokenRow(token.id)).user_id;
    const fresh = (await createSession(ctx.db, userId)).token;
    expect((await api('GET', '/api-tokens', { cookie: fresh })).json().tokens[0]).toMatchObject({
      id: token.id,
      status: 'expired',
    });
    // An expired token is not revoked again.
    await api('DELETE', `/api-tokens/${token.id}`, { cookie: fresh });
    expect((await tokenRow(token.id)).revoked_at).toBeNull();
  });

  it('skips the CSRF check only for token requests', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const { value } = await createToken(cookie);
    const crossSite = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
    const withCookie = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/query/range',
      cookies: { wl_session: cookie },
      headers: crossSite,
      payload: {},
    });
    expect(withCookie.statusCode).toBe(403);
    expect(withCookie.json().detail).toBe('Cross-site request blocked');
    const withToken = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/query/range',
      headers: { ...crossSite, authorization: `Bearer ${value}` },
      payload: {},
    });
    expect(withToken.statusCode).toBe(400); // the body is invalid: past CSRF and the scope
  });

  it('records the last use at most once a minute, the first use and each new address', async () => {
    ctx = await createTestContext({
      clientIpHeader: 'X-Real-IP',
      clientCountryHeader: 'CF-IPCountry',
    });
    const cookie = await setupAdmin(ctx.app);
    const { value, token } = await createToken(cookie);
    const from = (ip: string, country?: string) =>
      api(
        'GET',
        '/me',
        {},
        {
          headers: {
            authorization: `Bearer ${value}`,
            'x-real-ip': ip,
            ...(country ? { 'cf-ipcountry': country } : {}),
          },
        },
      );
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    expect((await from('203.0.113.42', 'DE')).statusCode).toBe(200);
    let row = await tokenRow(token.id);
    expect(row).toMatchObject({ last_used_ip: '203.0.113.42', last_used_country: 'DE' });
    expect(row.last_used_at!.getTime()).toBe(start);
    expect(row.used_rest_at!.getTime()).toBe(start);

    // Within the minute: no write, but the new address is in the history at once.
    vi.setSystemTime(start + 30_000);
    await from('198.51.100.7', 'NL');
    await from('203.0.113.42', 'DE');
    row = await tokenRow(token.id);
    expect(row.last_used_at!.getTime()).toBe(start);
    expect(row.last_used_ip).toBe('203.0.113.42');

    vi.setSystemTime(start + 61_000);
    await from('198.51.100.7', 'NL');
    row = await tokenRow(token.id);
    expect(row.last_used_at!.getTime()).toBe(start + 61_000);
    expect(row).toMatchObject({ last_used_ip: '198.51.100.7', last_used_country: 'NL' });

    expect(await events(token.id)).toEqual([
      { kind: 'created', ip: null, country: null },
      { kind: 'first_use', ip: '203.0.113.42', country: 'DE' },
      { kind: 'new_ip', ip: '198.51.100.7', country: 'NL' },
    ]);
    // The list shows the last use.
    const item = (await api('GET', '/api-tokens', { cookie })).json().tokens[0];
    expect(item).toMatchObject({
      lastUsedIp: '198.51.100.7',
      lastUsedCountry: 'NL',
      usedRest: true,
    });
    const history = (await api('GET', `/api-tokens/${token.id}`, { cookie })).json().history;
    expect(history.map((e: { kind: string }) => e.kind)).toEqual([
      'new_ip',
      'first_use',
      'created',
    ]);

    // Once revoked, only the networks are shown.
    await api('DELETE', `/api-tokens/${token.id}`, { cookie });
    const dead = (await api('GET', `/api-tokens/${token.id}`, { cookie })).json();
    expect(dead.token.lastUsedIp).toBe('198.51.100.0/24');
    expect(dead.history.map((e: { ip: string | null }) => e.ip)).toEqual([
      null,
      '198.51.100.0/24',
      '203.0.113.0/24',
      null,
    ]);
    expect((await tokenRow(token.id)).last_used_ip).toBe('198.51.100.0/24');
  });

  it('takes the country only from a trusted proxy that is configured to send it', async () => {
    for (const [overrides, remoteAddress, expected] of [
      [{ clientCountryHeader: 'CF-IPCountry' }, '10.0.0.5', 'DE'],
      [{ clientCountryHeader: 'CF-IPCountry' }, '198.51.100.1', null], // untrusted peer
      [{}, '10.0.0.5', null], // no header configured
    ] as const) {
      ctx = await createTestContext(overrides);
      const cookie = await setupAdmin(ctx.app);
      const { value, token } = await createToken(cookie);
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        remoteAddress,
        headers: { authorization: `Bearer ${value}`, 'cf-ipcountry': 'de' },
      });
      expect(res.statusCode).toBe(200);
      expect((await tokenRow(token.id)).last_used_country, remoteAddress).toBe(expected);
      await closeTestContext(ctx);
      ctx = undefined as unknown as TestContext;
    }
  });

  it('writes the last use once across replicas, and caps the new addresses', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const { token } = await createToken(cookie);
    const t0 = new Date('2026-11-08T12:00:00Z');
    const req = {
      id: token.id,
      name: 'replicas',
      prefix: token.prefix,
      scope: 'read' as const,
      expiresAt: null,
      lastUsedAt: null,
      public: false,
    };
    const use = (ip: string) => ({ ip, country: null, rest: true });
    await new TokenUsage(ctx.db).record(req, use('203.0.113.1'), t0);
    // A second replica that has not seen the token: the database condition holds it back.
    await new TokenUsage(ctx.db).record(req, use('203.0.113.2'), new Date(t0.getTime() + 10_000));
    expect((await tokenRow(token.id)).last_used_ip).toBe('203.0.113.1');
    await new TokenUsage(ctx.db).record(req, use('203.0.113.2'), new Date(t0.getTime() + 60_000));
    expect((await tokenRow(token.id)).last_used_ip).toBe('203.0.113.2');

    const usage = new TokenUsage(ctx.db);
    for (let i = 0; i < MAX_NEW_IP_EVENTS + 10; i++) {
      await usage.record(req, use(`198.51.100.${i}`), t0);
    }
    const kinds = (await events(token.id)).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'first_use')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'new_ip')).toHaveLength(MAX_NEW_IP_EVENTS);
  });

  it('limits each token to its own bucket of requests a minute (429 with Retry-After)', async () => {
    const config = { apiTokenLimits: { restPerMinute: 5, mcpCallsPerMinute: 60 } };
    ctx = await createTestContext(config);
    const cookie = await setupAdmin(ctx.app);
    const a = (await createToken(cookie, { name: 'a' })).value;
    const b = (await createToken(cookie, { name: 'b' })).value;
    for (let i = 0; i < 5; i++)
      expect((await api('GET', '/me', { token: a })).statusCode).toBe(200);
    const limited = await api('GET', '/clusters', { token: a });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toMatch(/^\d+$/);
    expect(limited.headers['content-type']).toMatch(/^application\/problem\+json/);
    // Another token and the session are not affected.
    expect((await api('GET', '/me', { token: b })).statusCode).toBe(200);
    for (let i = 0; i < 10; i++) expect((await api('GET', '/me', { cookie })).statusCode).toBe(200);
  });

  it('reads a Kubernetes cluster and a Docker fleet', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const orgId = (await api('GET', '/me', { cookie })).json().user.org.id;
    const k8s = await insertCluster(ctx.db, orgId, 'prod-eu', 'kubernetes');
    const docker = await insertCluster(ctx.db, orgId, 'docker-01', 'docker');
    const { value } = await createToken(cookie);
    const clusters = await api('GET', '/clusters', { token: value });
    expect(
      clusters
        .json()
        .clusters.map((c: { kind: string }) => c.kind)
        .sort(),
    ).toEqual(['docker', 'kubernetes']);
    for (const url of [
      `/clusters/${k8s.id}/workloads`,
      `/clusters/${k8s.id}/overview`,
      `/clusters/${docker.id}/docker/containers`,
      `/clusters/${docker.id}/overview`,
    ]) {
      const res = await api('GET', url, { token: value });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    }
    const now = Math.floor(Date.now() / 1000);
    for (const [clusterId, metric] of [
      [k8s.id, 'node.cpu.utilization'],
      [docker.id, 'host.cpu.utilization'],
    ]) {
      const res = await api(
        'POST',
        '/query/range',
        { token: value },
        { payload: { clusterId, metric, from: now - 3600, to: now } },
      );
      expect(res.statusCode, `${metric}: ${res.body}`).toBe(200);
    }
    // Writes are refused for both kinds.
    for (const url of [`/clusters/${k8s.id}`, `/clusters/${docker.id}`]) {
      const res = await api('DELETE', url, { token: value });
      expect(res.statusCode).toBe(403);
      expect(res.json().type).toBe('urn:watchlog:problem:token-scope');
    }
  });
});
