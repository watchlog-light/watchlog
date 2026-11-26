// SPDX-License-Identifier: AGPL-3.0-only
// The server must not fall over under pushes (1.0.3): the org's ceiling over all its
// own-metrics tokens, the number of tokens, shedding own metrics first under pressure while
// agents keep sending, refusals that cost nothing, pushes that write no PostgreSQL row per
// call, and the counts of what was taken, limited and shed.
import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OWN_PUSH_BYTES,
  OWN_PUSH_VALUES,
  OWN_TOKENS_PER_CLUSTER,
  OWN_TOKENS_PER_ORG,
} from '../src/modules/entitlements/own-metrics.js';
import { OWN_CALLS_METRIC, OwnIngestStats } from '../src/modules/ingest/own-stats.js';
import { judge, watchPressure } from '../src/modules/ingest/pressure.js';
import { TokenCache, UNKNOWN_TOKEN_TTL_MS } from '../src/modules/ingest/token-cache.js';
import { issueMetricToken } from '../src/modules/own-metrics/tokens.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  TEST_VM_URL,
  type TestContext,
} from './helpers.js';
import { encode } from './support/remote-write.js';

let ctx: TestContext;
let cookie: string;
let open = false;

async function start(...args: Parameters<typeof createTestContext>) {
  if (open) await closeTestContext(ctx);
  ctx = await createTestContext(...args);
  open = true;
  cookie = await setupAdmin(ctx.app);
}

// Some tests here need no app at all.
afterEach(async () => {
  if (open) await closeTestContext(ctx);
  open = false;
});

const api = (method: 'GET' | 'POST', url: string, payload?: object, as = cookie) =>
  ctx.app.inject({
    method,
    url: `/api/v1${url}`,
    cookies: { wl_session: as },
    ...(payload ? { payload } : {}),
  });

async function cluster(name: string, kind: 'kubernetes' | 'server' = 'kubernetes', as = cookie) {
  const res = await api('POST', '/clusters', { name, kind }, as);
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json().cluster.id as string, token: res.json().token.value as string };
}

async function token(clusterId: string, name: string, as = cookie) {
  const res = await api('POST', `/clusters/${clusterId}/own-metrics/tokens`, { name }, as);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().value as string;
}

const push = (value: string, payload: object | string, headers: Record<string, string> = {}) =>
  ctx.app.inject({
    method: 'POST',
    url: '/ingest/v1/metrics',
    headers: { authorization: `Bearer ${value}`, 'content-type': 'application/json', ...headers },
    payload,
  });

/** Remote write as Prometheus sends it; with a cluster token it is an agent's batch. */
const remoteWrite = (value: string, name = 'orders_total') =>
  ctx.app.inject({
    method: 'POST',
    url: '/ingest/v1/write',
    headers: {
      authorization: `Bearer ${value}`,
      'content-type': 'application/x-protobuf',
      'content-encoding': 'snappy',
      'x-watchlog-agent': 'web-1',
    },
    payload: encode([
      { labels: { __name__: name, host: 'web-1' }, value: 1, timestampMs: Date.now() },
    ]),
  });

const heartbeat = (value: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/ingest/v1/heartbeat',
    headers: { authorization: `Bearer ${value}`, 'x-watchlog-agent': 'web-1' },
    payload: {
      agent_version: '1.0.3',
      mode: 'docker',
      node: 'web-1',
      capabilities: { ebpf: 'disabled', cgroup: 'v2' },
      series: 64,
    },
  });

/** Another org with a cluster and a token of its own. */
async function otherOrg() {
  const other = await createUserSession(ctx.db, { role: 'owner' });
  const c = await cluster('theirs', 'kubernetes', other.cookie);
  return { ...other, cluster: c, token: await token(c.id, 'theirs', other.cookie) };
}

const ORG_LIMIT = /rate limit reached for this organization \(all its tokens together\)/;

describe('the org’s ceiling over all its tokens', () => {
  it('pushes: 429 with Retry-After once the org’s tokens together are over it; another org is not', async () => {
    await start({}, { ingestBuckets: { metricOrgPush: { ratePerSec: 0.01, burst: 3 } } });
    const first = await cluster('shop');
    const second = await cluster('fleet', 'server');
    const a = await token(first.id, 'a');
    const b = await token(first.id, 'b');
    const c = await token(second.id, 'c');
    const theirs = await otherOrg();
    // Three tokens in two clusters, each far under its own limit.
    for (const t of [a, b, c]) {
      expect((await push(t, { name: 'jobs_waiting', value: 1 })).statusCode).toBe(200);
    }
    for (const t of [a, c]) {
      const limited = await push(t, { name: 'jobs_waiting', value: 1 });
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.json().detail).toMatch(ORG_LIMIT);
    }
    expect((await push(theirs.token, { name: 'jobs_waiting', value: 1 })).statusCode).toBe(200);
    // Remote write has a ceiling of its own.
    expect((await remoteWrite(a)).statusCode).toBe(204);
    expect(ctx.app.ownIngestStats.snapshot()).toEqual({
      push: { accepted: 4, limited_token: 0, limited_org: 2, shed: 0 },
      remote_write: { accepted: 1, limited_token: 0, limited_org: 0, shed: 0 },
    });
  });

  it('remote write: the same, in the same words', async () => {
    await start({}, { ingestBuckets: { metricOrgWrite: { ratePerSec: 0.01, burst: 2 } } });
    const first = await cluster('shop');
    const a = await token(first.id, 'a');
    const b = await token(first.id, 'b');
    const theirs = await otherOrg();
    expect((await remoteWrite(a)).statusCode).toBe(204);
    expect((await remoteWrite(b)).statusCode).toBe(204);
    const limited = await remoteWrite(a);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.json().detail).toMatch(ORG_LIMIT);
    expect((await remoteWrite(theirs.token)).statusCode).toBe(204);
    // Pushes are counted apart.
    expect((await push(a, { name: 'jobs_waiting', value: 1 })).statusCode).toBe(200);
    expect(ctx.app.ownIngestStats.snapshot().remote_write).toEqual({
      accepted: 3,
      limited_token: 0,
      limited_org: 1,
      shed: 0,
    });
  });

  it('a token over its own limit is told so, and takes nothing from the org’s allowance', async () => {
    await start(
      {},
      {
        ingestBuckets: {
          metricPush: { ratePerSec: 0.01, burst: 1 },
          metricOrgPush: { ratePerSec: 0.01, burst: 2 },
        },
      },
    );
    const c = await cluster('shop');
    const a = await token(c.id, 'a');
    const b = await token(c.id, 'b');
    expect((await push(a, { name: 'jobs_waiting', value: 1 })).statusCode).toBe(200);
    for (let i = 0; i < 3; i++) {
      const limited = await push(a, { name: 'jobs_waiting', value: 1 });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().detail).toMatch(/for this token/);
    }
    expect((await push(b, { name: 'jobs_waiting', value: 1 })).statusCode).toBe(200);
    expect(ctx.app.ownIngestStats.snapshot().push).toMatchObject({
      accepted: 2,
      limited_token: 3,
      limited_org: 0,
    });
  });
});

describe('the number of tokens', () => {
  it(`a cluster has ${OWN_TOKENS_PER_CLUSTER}, an org ${OWN_TOKENS_PER_ORG} over all its clusters; the next is refused in words`, async () => {
    await start();
    const user = await ctx.db.selectFrom('users').select('id').executeTakeFirstOrThrow();
    const fill = async (clusterId: string, n: number) => {
      for (let i = 0; i < n; i++) await issueMetricToken(ctx.db, clusterId, `t${i}`, user.id);
    };
    const first = await cluster('shop');
    await fill(first.id, OWN_TOKENS_PER_CLUSTER - 1);
    await token(first.id, 'the twentieth');
    const full = await api('POST', `/clusters/${first.id}/own-metrics/tokens`, { name: 'more' });
    expect(full.statusCode).toBe(409);
    expect(full.json().detail).toBe(
      `A cluster or fleet can have ${OWN_TOKENS_PER_CLUSTER} own-metrics tokens; revoke one first`,
    );

    for (let i = 1; i < OWN_TOKENS_PER_ORG / OWN_TOKENS_PER_CLUSTER; i++) {
      await fill((await cluster(`fleet-${i}`, 'server')).id, OWN_TOKENS_PER_CLUSTER);
    }
    const last = await cluster('one-more');
    const over = await api('POST', `/clusters/${last.id}/own-metrics/tokens`, { name: 'more' });
    expect(over.statusCode).toBe(409);
    expect(over.json().detail).toBe(
      `An organization can have ${OWN_TOKENS_PER_ORG} own-metrics tokens over all its clusters and fleets; revoke one first`,
    );
    // Another org's count is its own; a revoked token makes room.
    await otherOrg();
    await ctx.db
      .updateTable('own_metric_tokens')
      .set({ revoked_at: new Date() })
      .where('name', '=', 'the twentieth')
      .execute();
    await token(last.id, 'now it fits');
  });
});

describe('under pressure', () => {
  it('own-metric pushes and remote write are shed with 503; agents and collectors are still taken', async () => {
    let reason: string | null = null;
    const lines: string[] = [];
    await start(
      { logLevel: 'info' },
      { pressure: { shedding: () => reason }, logStream: { write: (l) => lines.push(l) } },
    );
    const c = await cluster('fleet', 'server');
    const t = await token(c.id, 'cron');
    expect((await push(t, { name: 'jobs_waiting', value: 1 })).statusCode).toBe(200);

    reason = 'event loop lag 412 ms';
    for (let i = 0; i < 3; i++) {
      const shed = await push(t, { name: 'jobs_waiting', value: 1 });
      expect(shed.statusCode).toBe(503);
      expect(Number(shed.headers['retry-after'])).toBeGreaterThan(0);
      expect(shed.json().detail).toMatch(/under heavy load/);
    }
    const shedWrite = await remoteWrite(t);
    expect(shedWrite.statusCode).toBe(503);
    expect(Number(shedWrite.headers['retry-after'])).toBeGreaterThan(0);
    // No token is looked up for a shed call: an unknown one is shed too.
    expect((await push(`wl_mt_${'x'.repeat(43)}`, '{')).statusCode).toBe(503);
    // WatchLog's own monitoring is not what gives way.
    expect((await remoteWrite(c.token, 'watchlog_node_load1')).statusCode).toBe(204);
    expect((await heartbeat(c.token)).statusCode).toBe(204);

    reason = null;
    expect((await push(t, { name: 'jobs_waiting', value: 1 })).statusCode).toBe(200);
    expect(ctx.app.ownIngestStats.snapshot()).toEqual({
      push: { accepted: 2, limited_token: 0, limited_org: 0, shed: 4 },
      remote_write: { accepted: 0, limited_token: 0, limited_org: 0, shed: 1 },
    });
    expect(ctx.app.ownIngestStats.render()).toContain(
      `${OWN_CALLS_METRIC}{kind="push",result="shed"} 4\n`,
    );
    // One line for the five shed calls, with why; none per call.
    const said = lines.map((l) => JSON.parse(l)).filter((l) => /shedding/.test(l.msg));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ level: 40, reason: 'event loop lag 412 ms' });
  });

  it('the signals: the first over its threshold is named; 0 turns one off', () => {
    const at = (eventLoopLagMs: number, metricWritesInFlight: number, dbWaiting: number) => ({
      eventLoopLagMs: () => eventLoopLagMs,
      metricWritesInFlight: () => metricWritesInFlight,
      dbWaiting: () => dbWaiting,
    });
    const t = { eventLoopLagMs: 200, metricWritesInFlight: 100, dbWaiting: 50 };
    expect(judge(t, at(199, 99, 49))).toBeNull();
    expect(judge(t, at(250.4, 0, 0))).toBe('event loop lag 250 ms');
    expect(judge(t, at(0, 100, 0))).toBe('100 writes to the metrics storage in flight');
    expect(judge(t, at(0, 0, 60))).toBe('60 queries waiting for a database connection');
    expect(judge({ ...t, eventLoopLagMs: 0, dbWaiting: 0 }, at(9000, 99, 9000))).toBeNull();
  });

  it('reads the signals on a timer, and measures the event loop itself', async () => {
    let waiting = 0;
    const p = watchPressure(
      { eventLoopLagMs: 0, metricWritesInFlight: 0, dbWaiting: 5 },
      { metricWritesInFlight: () => 0, dbWaiting: () => waiting },
      5,
    );
    try {
      expect(p.shedding()).toBeNull();
      waiting = 7;
      await vi.waitFor(() => expect(p.shedding()).toMatch(/7 queries waiting/));
      waiting = 0;
      await vi.waitFor(() => expect(p.shedding()).toBeNull());
    } finally {
      p.stop();
    }
  });
});

describe('refusals that cost nothing', () => {
  it('a bad token is refused before its body is read; so is a cluster token’s push', async () => {
    await start();
    const c = await cluster('shop');
    const bad = `wl_mt_${'x'.repeat(43)}`;
    const lookups = vi.spyOn(ctx.db, 'selectFrom');
    const tokenLookups = () =>
      lookups.mock.calls.filter(([table]) => table === 'own_metric_tokens as t').length;
    // Not JSON at all: the answer is about the token, so nothing was parsed.
    for (let i = 0; i < 5; i++) expect((await push(bad, '{not json')).statusCode).toBe(401);
    // And one lookup for the five calls.
    expect(tokenLookups()).toBe(1);
    expect((await push('', '{not json')).statusCode).toBe(401);
    const agent = await push(c.token, '{not json');
    expect(agent.statusCode).toBe(403);
    expect(agent.json().detail).toMatch(/Pushes need an own-metrics token/);
    lookups.mockRestore();
  });

  it('an unknown token is looked up again after ten seconds; a revoked one stops at once', async () => {
    await start();
    const c = await cluster('shop');
    const t = await token(c.id, 'cron');
    let now = 1_000_000;
    const cache = new TokenCache(ctx.db, () => now);
    const lookups = vi.spyOn(ctx.db, 'selectFrom');
    const bad = `wl_mt_${'y'.repeat(43)}`;
    expect(await cache.verifyMetric(bad)).toBeNull();
    expect(await cache.verifyMetric(bad)).toBeNull();
    expect(lookups).toHaveBeenCalledTimes(1);
    now += UNKNOWN_TOKEN_TTL_MS + 1;
    expect(await cache.verifyMetric(bad)).toBeNull();
    expect(lookups).toHaveBeenCalledTimes(2);
    // A valid token: one lookup, then from memory until it is revoked.
    const owner = await cache.verifyMetric(t);
    expect(owner?.clusterId).toBe(c.id);
    await cache.verifyMetric(t);
    expect(lookups).toHaveBeenCalledTimes(3);
    await ctx.db.updateTable('own_metric_tokens').set({ revoked_at: new Date() }).execute();
    cache.invalidateMetricToken(owner!.tokenId);
    expect(await cache.verifyMetric(t)).toBeNull();
    lookups.mockRestore();
  });

  it(`a push carries at most ${OWN_PUSH_VALUES} values and ${OWN_PUSH_BYTES / 1024} KB; the answer names the limit`, async () => {
    await start();
    const c = await cluster('shop');
    const t = await token(c.id, 'cron');
    const values = (n: number) => ({
      metrics: Array.from({ length: n }, (_, i) => ({ name: `jobs_${i}`, value: i })),
    });
    const many = await push(t, values(OWN_PUSH_VALUES + 1));
    expect(many.statusCode).toBe(400);
    expect(many.json().detail).toBe(
      `A push carries at most ${OWN_PUSH_VALUES} values; send the rest in another call`,
    );
    // Too large by its Content-Length: refused unread (it isn't even JSON).
    const large = await push(t, 'x'.repeat(OWN_PUSH_BYTES + 1));
    expect(large.statusCode).toBe(413);
    expect(large.json().detail).toBe(
      `A push is at most ${OWN_PUSH_BYTES / 1024} KB; send fewer values in one call`,
    );
    // Without a Content-Length it is cut off while it is read, with the same words.
    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const chunked = await fetch(`${address}/ingest/v1/metrics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(OWN_PUSH_BYTES + 1)));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect(chunked.status).toBe(413);
    expect(((await chunked.json()) as { detail: string }).detail).toMatch(/A push is at most/);
    // The full allowance of values still goes through.
    const fits = await push(t, values(OWN_PUSH_VALUES));
    expect(fits.statusCode).toBe(200);
    // Over a limit: refused before the body, whatever it is.
    await start({}, { ingestBuckets: { metricPush: { ratePerSec: 0.01, burst: 1 } } });
    const t2 = await token((await cluster('shop')).id, 'cron');
    expect((await push(t2, { name: 'jobs_waiting', value: 1 })).statusCode).toBe(200);
    expect((await push(t2, '{not json')).statusCode).toBe(429);
  });
});

describe('what a push costs PostgreSQL', () => {
  /** Every table's rows as (how many, the sum of the transactions that wrote them). */
  async function rows(): Promise<Record<string, string>> {
    const tables = await sql<{ tablename: string }>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`.execute(ctx.db);
    const out: Record<string, string> = {};
    for (const { tablename } of tables.rows) {
      const r = await sql<{ n: string; x: string }>`
        SELECT count(*) AS n, coalesce(sum(xmin::text::bigint), 0) AS x
        FROM ${sql.table(tablename)}`.execute(ctx.db);
      out[tablename] = `${r.rows[0]!.n} rows, ${r.rows[0]!.x}`;
    }
    return out;
  }

  it('200 pushes of a counter write no row; the total is written by the flush and survives it', async () => {
    await start();
    const c = await cluster('shop');
    const t = await token(c.id, 'cron');
    const one = () => push(t, { name: 'orders_total', value: 1, labels: { region: 'eu' } });
    // The first push makes the source, the metric and the series, and says the token was used.
    expect((await one()).json()).toMatchObject({ stored: 1 });
    await vi.waitFor(async () => {
      const row = await ctx.db
        .selectFrom('own_metric_tokens')
        .select('last_used_at')
        .executeTakeFirstOrThrow();
      expect(row.last_used_at).not.toBeNull();
    });

    const before = await rows();
    for (let i = 0; i < 200; i++) expect((await one()).statusCode).toBe(200);
    // No row of any table was inserted, updated or deleted by those 200 calls.
    expect(await rows()).toEqual(before);
    expect(ctx.app.ownIngestStats.snapshot().push.accepted).toBe(201);

    // The running total is in memory and in VictoriaMetrics; the flush writes it once.
    await ctx.app.ownMetrics.flush();
    const after = await rows();
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(changed.sort()).toEqual(['own_metrics', 'own_series', 'own_sources']);
    const series = await ctx.db.selectFrom('own_series').select('total').execute();
    expect(series).toEqual([{ total: 201 }]);

    // After a restart that flushed (a clean stop does), the next push goes on from it.
    await ctx.app.ownMetrics.forget(c.id);
    expect((await one()).statusCode).toBe(200);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const q = encodeURIComponent(`{__name__="orders_total",cluster_id="${c.id}"}`);
    const at = Math.floor(Date.now() / 1000);
    const res = await fetch(
      `${TEST_VM_URL}/api/v1/export?match[]=${q}&start=${at - 3600}&end=${at + 120}`,
    );
    const line = JSON.parse((await res.text()).split('\n')[0]!) as { values: number[] };
    expect(Math.max(...line.values)).toBe(202);
  });
});

describe('the counts', () => {
  it('are kept per kind and result, as Prometheus text; the log gets a line a minute at most', () => {
    let now = 0;
    const warn = vi.fn();
    const info = vi.fn();
    const stats = new OwnIngestStats({ warn, info }, () => now);
    stats.count('push', 'accepted');
    stats.count('push', 'limited_token');
    expect(info).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) stats.count('remote_write', 'shed', 'event loop lag 300 ms');
    stats.count('push', 'limited_org');
    // Within the minute: counted, not logged.
    expect(warn).not.toHaveBeenCalled();
    now += 60_000;
    stats.report();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toEqual({
      reason: 'event loop lag 300 ms',
      pushes: { accepted: 0, limited_token: 0, limited_org: 1, shed: 0 },
      remoteWrites: { accepted: 0, limited_token: 0, limited_org: 0, shed: 50 },
    });
    // Nothing refused since: nothing said.
    now += 60_000;
    stats.count('push', 'accepted');
    stats.report();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(stats.render()).toBe(
      [
        `# HELP ${OWN_CALLS_METRIC} Calls with an own-metrics token, by what ingest did with them.`,
        `# TYPE ${OWN_CALLS_METRIC} counter`,
        `${OWN_CALLS_METRIC}{kind="push",result="accepted"} 2`,
        `${OWN_CALLS_METRIC}{kind="push",result="limited_token"} 1`,
        `${OWN_CALLS_METRIC}{kind="push",result="limited_org"} 1`,
        `${OWN_CALLS_METRIC}{kind="push",result="shed"} 0`,
        `${OWN_CALLS_METRIC}{kind="remote_write",result="accepted"} 0`,
        `${OWN_CALLS_METRIC}{kind="remote_write",result="limited_token"} 0`,
        `${OWN_CALLS_METRIC}{kind="remote_write",result="limited_org"} 0`,
        `${OWN_CALLS_METRIC}{kind="remote_write",result="shed"} 50`,
        '',
      ].join('\n'),
    );
  });
});
