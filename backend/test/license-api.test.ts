// SPDX-License-Identifier: AGPL-3.0-only
// The Enterprise licence through the API (ADR-232), with a generated key pair and a clock:
// the gate matrix (Community without a key, with a valid one, an ended one, one without
// `pro`, Cloud with a key, the demo) over What changed, All clusters, MCP and /health;
// Settings → License (Owner only, the environment wins, a bad key refused, audited); the
// summary every member reads; the units and the 30-day rule on recorded hours.
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { insertCluster } from '../src/modules/clusters/service.js';
import { ensureDemoUser } from '../src/modules/demo/service.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { DAY, licenseKey, TEST_KEYS } from './license-keys.js';
import { mcpClient, type McpTestClient } from './support/mcp.js';

const NOW = Date.parse('2027-03-10T12:00:00Z');
let ctx: TestContext | undefined;
let mcp: McpTestClient | undefined;
afterEach(async () => {
  await mcp?.close().catch(() => {});
  mcp = undefined;
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

async function install(over: Partial<Config> = {}, now = NOW) {
  ctx = await createTestContext(over, {
    now: () => now,
    licenseTest: { trusted: [TEST_KEYS.x], now: () => now },
  });
  const cookie = await setupAdmin(ctx.app);
  const org = await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow();
  const cluster = await insertCluster(ctx.db, org.id, 'kind', 'kubernetes');
  const get = (url: string, c = cookie) =>
    ctx!.app.inject({ method: 'GET', url, cookies: { wl_session: c } });
  const put = (key: string, c = cookie) =>
    ctx!.app.inject({
      method: 'PUT',
      url: '/api/v1/license',
      payload: { key },
      cookies: { wl_session: c },
    });
  return { cookie, orgId: org.id, clusterId: cluster.id, get, put };
}

/** What a member sees of the Pro features: status codes, the MCP tools, /health. */
async function seen(i: Awaited<ReturnType<typeof install>>) {
  const wc = await i.get(`/api/v1/what-changed?cluster=${i.clusterId}`);
  const all = await i.get('/api/v1/overview/all');
  const health = (await i.get('/api/v1/health')).json();
  mcp = await mcpClient(ctx!, i.cookie);
  const tools = (await mcp.client.listTools()).tools.map((t) => t.name);
  await mcp.close();
  mcp = undefined;
  return {
    whatChanged: wc.statusCode,
    whatChangedType: wc.json().type as string | undefined,
    allClusters: all.statusCode,
    tools: tools.includes('get_what_changed') && tools.includes('get_all_clusters'),
    health: { edition: health.edition, licensed: health.licensed },
  };
}

describe('the gate matrix', () => {
  it('Community without a key: everything Pro is absent, as before', async () => {
    const i = await install();
    expect(await seen(i)).toEqual({
      whatChanged: 404,
      whatChangedType: 'about:blank',
      allClusters: 404,
      tools: false,
      health: { edition: 'community', licensed: false },
    });
    const s = (await i.get('/api/v1/license/summary')).json();
    expect(s).toMatchObject({ edition: 'community', licensed: false, pro: false, endedOn: null });
  });

  it('Community with a valid key (pasted): What changed, All clusters and the tools are on', async () => {
    const i = await install();
    expect((await i.put(licenseKey(NOW))).statusCode).toBe(200);
    const s = await seen(i);
    expect(s.whatChanged).toBe(200);
    expect(s.allClusters).toBe(200);
    expect(s.tools).toBe(true);
    expect(s.health).toEqual({ edition: 'enterprise', licensed: true });
    expect((await i.get('/api/v1/license/summary')).json()).toMatchObject({
      edition: 'enterprise',
      licensed: true,
      pro: true,
      customer: 'Acme',
    });
    // Removing it: gone again, nothing else changes.
    const del = await ctx!.app.inject({
      method: 'DELETE',
      url: '/api/v1/license',
      cookies: { wl_session: i.cookie },
    });
    expect(del.json().state).toBe('none');
    ctx!.app.license.clear();
    expect((await seen(i)).whatChanged).toBe(404);
  });

  it('a key that ended (after its grace): 403 license-ended, the tools still listed', async () => {
    const i = await install({
      license: {
        key: licenseKey(NOW, {
          issuedAt: new Date(NOW - 400 * DAY).toISOString(),
          expiresAt: new Date(NOW - 20 * DAY).toISOString(),
        }),
      },
    });
    const s = await seen(i);
    expect(s.whatChanged).toBe(403);
    expect(s.whatChangedType).toBe('urn:watchlog:problem:license-ended');
    expect(s.allClusters).toBe(403);
    expect(s.health).toEqual({ edition: 'enterprise', licensed: false });
    const sum = (await i.get('/api/v1/license/summary')).json();
    expect(sum).toMatchObject({ pro: false, licensed: false });
    expect(sum.endedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const detail = (await i.get(`/api/v1/what-changed?cluster=${i.clusterId}`)).json().detail;
    expect(detail).toMatch(/^Your licence ended on \d{4}-\d{2}-\d{2}\./);
  });

  it('a key in its grace days still works', async () => {
    const i = await install({
      license: { key: licenseKey(NOW, { expiresAt: new Date(NOW - 3 * DAY).toISOString() }) },
    });
    expect((await seen(i)).whatChanged).toBe(200);
  });

  it('a key without pro: Pro stays absent (another feature, such as network, is for its module)', async () => {
    const i = await install({ license: { key: licenseKey(NOW, { features: ['network'] }) } });
    const s = await seen(i);
    expect(s.whatChanged).toBe(404);
    expect(s.allClusters).toBe(404);
    expect(s.tools).toBe(false);
    expect(s.health).toEqual({ edition: 'enterprise', licensed: true });
  });

  it('a key signed by someone else: Community', async () => {
    const i = await install({
      license: {
        key: licenseKey(NOW, {}, (await import('./license-keys.js')).testKeyPair().privateKey),
      },
    });
    const s = await seen(i);
    expect(s.whatChanged).toBe(404);
    expect(s.health).toEqual({ edition: 'community', licensed: false });
  });

  it('Cloud ignores a key: its licence routes 404, /health says cloud', async () => {
    ctx = await createTestContext(
      { edition: 'cloud', license: { key: licenseKey(NOW) } } as Partial<Config>,
      { licenseTest: { trusted: [TEST_KEYS.x], now: () => NOW } },
    );
    expect((await ctx.app.license.current()).source).toBe('none');
    for (const url of ['/api/v1/license', '/api/v1/license/summary']) {
      expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/health' })).json()).toMatchObject({
      edition: 'cloud',
      licensed: false,
    });
  });

  it('the demo: Pro on without a key; the licence page has none', async () => {
    ctx = await createTestContext(
      { demoMode: true },
      { licenseTest: { trusted: [TEST_KEYS.x], now: () => NOW } },
    );
    await ensureDemoUser(ctx.db);
    const s = await ctx.app.inject({ method: 'POST', url: '/api/v1/demo/session' });
    const cookie = s.cookies.find((c) => c.name === 'wl_session')!.value;
    const sum = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/license/summary',
        cookies: { wl_session: cookie },
      })
    ).json();
    expect(sum).toMatchObject({ edition: 'community', pro: true, licensed: false });
  });
});

describe('Settings → License', () => {
  it('Owner only; a bad or ended key is refused and not kept; a good one is audited', async () => {
    const i = await install();
    const admin = await createUserSession(ctx!.db, { role: 'admin', orgId: i.orgId });
    expect((await i.get('/api/v1/license', admin.cookie)).statusCode).toBe(403);
    expect((await i.put(licenseKey(NOW), admin.cookie)).statusCode).toBe(403);
    // Every member reads the summary, without the customer or the banners.
    expect((await i.put(licenseKey(NOW))).statusCode).toBe(200);
    expect((await i.get('/api/v1/license/summary', admin.cookie)).json()).toMatchObject({
      pro: true,
      customer: null,
      banners: [],
    });

    const bad = await i.put('wl1.abc.def');
    expect(bad.statusCode).toBe(422);
    expect(bad.json().state).toBe('invalid');
    const ended = await i.put(
      licenseKey(NOW, {
        issuedAt: new Date(NOW - 400 * DAY).toISOString(),
        expiresAt: new Date(NOW - 30 * DAY).toISOString(),
      }),
    );
    expect(ended.statusCode).toBe(422);
    expect(ended.json().detail).toMatch(/ended on/);

    const v = (await i.get('/api/v1/license')).json();
    expect(v).toMatchObject({
      source: 'setting',
      state: 'valid',
      license: { customer: 'Acme', units: 50, features: ['pro', 'network'] },
    });
    expect(JSON.stringify(v)).not.toContain('wl1.');
    const audit = await ctx!.db
      .selectFrom('audit_events')
      .select(['action', 'details'])
      .where('action', 'like', 'license_%')
      .execute();
    expect(audit.map((a) => a.action)).toEqual(['license_set']);
    // The key is kept encrypted, never as text.
    const row = await ctx!.db
      .selectFrom('server_settings')
      .selectAll()
      .where('key', '=', 'license')
      .executeTakeFirstOrThrow();
    expect(row.secret).not.toContain('wl1.');
    expect(JSON.stringify(row.value)).not.toContain('wl1.');
  });

  it('the environment wins over the pasted key, and the page says so', async () => {
    const env = licenseKey(NOW, { customer: 'From env' });
    const i = await install({ license: { key: env } });
    expect((await i.put(licenseKey(NOW))).statusCode).toBe(409);
    await ctx!.db
      .insertInto('server_settings')
      .values({ key: 'license', value: '{}', secret: null, updated_by: null })
      .execute();
    ctx!.app.license.clear();
    const v = (await i.get('/api/v1/license')).json();
    expect(v).toMatchObject({ source: 'env', license: { customer: 'From env' } });
  });

  it('a file: read on each check, its error said', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const file = join(mkdtempSync(join(tmpdir(), 'wl-lic-')), 'license.key');
    const i = await install({ license: { file } });
    expect((await i.get('/api/v1/license')).json()).toMatchObject({
      source: 'file',
      state: 'invalid',
    });
    writeFileSync(file, `${licenseKey(NOW)}\n`);
    ctx!.app.license.clear();
    expect((await i.get('/api/v1/license')).json()).toMatchObject({
      source: 'file',
      state: 'valid',
    });
  });

  it('expiring: the banner for Owners; over the limit: units of allowed', async () => {
    const i = await install({
      license: {
        key: licenseKey(NOW, { units: 3, expiresAt: new Date(NOW + 10 * DAY).toISOString() }),
      },
    });
    // Five nodes in yesterday's busiest hour.
    await ctx!.db
      .insertInto('usage_hourly')
      .values({ org_id: i.orgId, hour: new Date(NOW - DAY), nodes: 4, docker_hosts: 1 })
      .execute();
    const v = (await i.get('/api/v1/license')).json();
    expect(v.state).toBe('expiring');
    expect(v.units).toMatchObject({
      used: 5,
      limit: 3,
      over: true,
      overDays: 1,
      closedSince: null,
    });
    expect(v.banners.map((b: { kind: string }) => b.kind)).toEqual(['expiring', 'over']);
    expect(v.banners[0]).toMatchObject({
      endsOn: new Date(NOW + 10 * DAY).toISOString().slice(0, 10),
      days: 10,
    });
  });
});
