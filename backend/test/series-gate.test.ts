// SPDX-License-Identifier: AGPL-3.0-only
// Cloud's per-org active-series cap at ingest (security review SR-3): the sketch's
// accuracy, the cap per plan, what passes at the cap, the windows, the cost on the hot path,
// and a Free org flooding new series through the real ingest route.
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import {
  HEADROOM_NODES,
  SERIES_CEILING,
  SERIES_PER_NODE,
  SeriesGate,
} from '../src/modules/entitlements/series-gate.js';
import type { Entitlement } from '../src/modules/entitlements/plans.js';
import { inspectWriteRequest } from '../src/modules/ingest/remote-write.js';
import { closeTestContext, createTestContext, TEST_VM_URL, type TestContext } from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `series-gate-${Date.now()}`;
const silent = { warn: () => {} };
const LIMITS = { maxDecodedBytes: 32 << 20, maxSeries: 20_000, hashSeries: true };

/** Entitlements with a node limit (null: none), as EntitlementsService answers them. */
const entitlements = (nodes: number | null) => ({
  get: async () => ({ nodes }) as Entitlement,
});

/** A write of series `from`…`to - 1` (distinct label values), and its label hashes. */
function batch(from: number, to: number, extra: Record<string, string> = {}): TestSeries[] {
  const out: TestSeries[] = [];
  for (let i = from; i < to; i++)
    out.push({
      labels: { __name__: 'flood', id: `s${i}`, run: RUN, ...extra },
      value: i,
      timestampMs: Date.now() - 30_000,
    });
  return out;
}
const hashesOf = (series: TestSeries[]) => inspectWriteRequest(encode(series), LIMITS).hashes!;

describe('the series sketch', () => {
  it('estimates distinct series within a few percent; repeats count once', async () => {
    // A large contract (1,000 nodes): the cap is out of the way.
    const gate = new SeriesGate(entitlements(1_000), silent);
    for (let i = 0; i < 100_000; i += 10_000) {
      expect((await gate.admit('o', 'c', 'n1', hashesOf(batch(i, i + 10_000)))).ok).toBe(true);
      // The same series again: no change.
      await gate.admit('o', 'c', 'n1', hashesOf(batch(i, i + 10_000)));
    }
    const e = gate.estimate('o');
    expect(Math.abs(e - 100_000) / 100_000).toBeLessThan(0.05);
    const small = new SeriesGate(entitlements(null), silent);
    await small.admit('o', 'c', 'n1', hashesOf(batch(0, 1_000)));
    expect(Math.abs(small.estimate('o') - 1_000)).toBeLessThan(30);
  });

  it('the same labels hash the same; any label differing hashes differently', () => {
    const a = hashesOf(batch(0, 3));
    expect([...hashesOf(batch(0, 3))]).toEqual([...a]);
    expect(new Set(a).size).toBe(3);
    expect(hashesOf(batch(0, 1, { node: 'x' }))[0]).not.toBe(a[0]);
  });

  it('caps by the plan: nodes × 5,000, or the agents seen plus headroom up to a ceiling', () => {
    expect(SeriesGate.capFor(5, 0)).toBe(25_000);
    expect(SeriesGate.capFor(40, 3)).toBe(40 * SERIES_PER_NODE);
    expect(SeriesGate.capFor(null, 0)).toBe(HEADROOM_NODES * SERIES_PER_NODE);
    expect(SeriesGate.capFor(null, 20)).toBe(30 * SERIES_PER_NODE);
    expect(SeriesGate.capFor(null, 10_000)).toBe(SERIES_CEILING);
  });

  it('at the cap: series already counted keep flowing, a write with new ones is refused', async () => {
    const gate = new SeriesGate(entitlements(5), silent);
    for (let i = 0; i < 26_000; i += 13_000)
      expect((await gate.admit('o', 'c', 'n1', hashesOf(batch(i, i + 13_000)))).ok).toBe(true);
    const over = await gate.admit('o', 'c', 'n2', hashesOf(batch(26_000, 26_100)));
    expect(over).toMatchObject({ ok: false, cap: 25_000 });
    expect(over.estimate).toBeGreaterThan(25_000);
    expect((await gate.admit('o', 'c', 'n1', hashesOf(batch(100, 1_100)))).ok).toBe(true);
    // Another org is not affected.
    expect((await gate.admit('p', 'c', 'n1', hashesOf(batch(26_000, 26_100)))).ok).toBe(true);
  });

  it('counts the last one to two hours: after two quiet windows the org starts again', async () => {
    let now = 1_000_000_000;
    const gate = new SeriesGate(entitlements(5), silent, () => now);
    await gate.admit('o', 'c', 'n1', hashesOf(batch(0, 10_000)));
    now += 61 * 60_000;
    // The previous window still counts.
    await gate.admit('o', 'c', 'n1', hashesOf(batch(10_000, 11_000)));
    expect(gate.estimate('o')).toBeGreaterThan(10_000);
    now += 61 * 60_000;
    await gate.admit('o', 'c', 'n1', hashesOf(batch(20_000, 20_010)));
    // Only what the last window saw (1,000 series, then 10).
    expect(gate.estimate('o')).toBeLessThan(1_200);
    now += 3 * 60 * 60_000;
    await gate.admit('o', 'c', 'n1', hashesOf(batch(0, 5)));
    expect(gate.estimate('o')).toBeLessThan(10);
  });

  it('Pro: each node agent seen raises the cap, the cluster-agent and collectors do not', async () => {
    const gate = new SeriesGate(entitlements(null), silent);
    const one = hashesOf(batch(0, 1));
    expect((await gate.admit('o', 'k', 'n1', one)).cap).toBe(11 * SERIES_PER_NODE);
    expect((await gate.admit('o', 'k', 'cluster-agent', one)).cap).toBe(11 * SERIES_PER_NODE);
    expect((await gate.admit('o', 'k', 'integrations-a', one)).cap).toBe(11 * SERIES_PER_NODE);
    expect((await gate.admit('o', 'k', 'n2', one)).cap).toBe(12 * SERIES_PER_NODE);
  });

  it('costs microseconds per write: the hashes while reading, and the check', async () => {
    // A node's write as agents send it: about 1,050 series of about a dozen labels.
    const series: TestSeries[] = [];
    for (let i = 0; i < 1_050; i++)
      series.push({
        labels: {
          __name__: `container_metric_${i % 40}`,
          namespace: `team-${i % 7}`,
          pod: `checkout-api-7d9f8c6b5-${(i % 23).toString(36)}x2kq`,
          container: `app-${i % 5}`,
          node: 'ip-10-0-12-34.eu-west-1.compute.internal',
          image: 'registry.example.com/shop/checkout-api:2026.11.3',
          workload: 'checkout-api',
          workload_kind: 'Deployment',
          device: `eth${i % 2}`,
          mode: i % 3 ? 'user' : 'system',
          job: 'watchlog-agent',
          instance: `${i}`,
        },
        value: i,
        timestampMs: Date.now(),
      });
    const body = encode(series);
    const N = 400;
    const time = (f: () => void) => {
      for (let i = 0; i < 50; i++) f();
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) f();
      return Number(process.hrtime.bigint() - t0) / N / 1000;
    };
    const plain = time(() => inspectWriteRequest(body, { ...LIMITS, hashSeries: false }));
    const hashed = time(() => inspectWriteRequest(body, LIMITS));
    const hashes = inspectWriteRequest(body, LIMITS).hashes!;
    const gate = new SeriesGate(entitlements(null), silent);
    await gate.admit('o', 'c', 'n1', hashes);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) await gate.admit('o', 'c', 'n1', hashes);
    const check = Number(process.hrtime.bigint() - t0) / N / 1000;
    console.log(
      `series cap: reading ${plain.toFixed(0)} µs per write, +${(hashed - plain).toFixed(0)} µs for the hashes, ` +
        `${check.toFixed(1)} µs for the check (1,050 series, ${body.length} bytes snappy)`,
    );
    expect(hashed - plain).toBeLessThan(1_000);
    expect(check).toBeLessThan(500);
  });
});

// ------------------------------------------------------------------------- through ingest

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  ).catch(() => undefined);
});

describe('a Free org flooding new series', () => {
  it('gets 402 plan-limit (series) past 25,000; its known series and other orgs keep sending', async () => {
    const CLOUD: Partial<Config> = {
      edition: 'cloud',
      cookieSecure: 'always',
      accounts: {
        turnstile: {},
        supportEmail: 'support@watchlog.io',
        sampleUrl: 'https://demo.watchlog.io',
      },
    };
    ctx = await createTestContext(CLOUD, {
      fetch: (async () => new Response('offline', { status: 599 })) as typeof fetch,
    });
    const c = ctx;
    const org = async (email: string) => {
      const res = await c.app.inject({
        method: 'POST',
        url: '/api/v1/auth/signup',
        remoteAddress: `10.9.${email.length}.1`,
        payload: { email, password: 'a long enough password' },
      });
      expect(res.statusCode, res.body).toBe(201);
      const cookie = res.cookies.find((x) => x.name === 'wl_session')!.value;
      const r = await c.app.inject({
        method: 'POST',
        url: '/api/v1/clusters',
        cookies: { wl_session: cookie },
        payload: { name: 'prod', kind: 'kubernetes' },
      });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().token.value as string;
    };
    const write = (token: string, series: TestSeries[]) =>
      c.app.inject({
        method: 'POST',
        url: '/ingest/v1/write',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/x-protobuf',
          'content-encoding': 'snappy',
          'x-watchlog-agent': 'n1',
        },
        payload: encode(series),
      });
    const flood = await org('flood@acme.example');
    expect((await write(flood, batch(0, 13_000))).statusCode).toBe(204);
    expect((await write(flood, batch(13_000, 26_000))).statusCode).toBe(204);
    const over = await write(flood, batch(26_000, 26_500));
    expect(over.statusCode).toBe(402);
    expect(over.json()).toMatchObject({ code: 'plan-limit', limit: 'series', max: 25_000 });
    expect((await write(flood, batch(0, 1_000))).statusCode).toBe(204);
    const other = await org('calm@other.example');
    expect((await write(other, batch(26_000, 26_500))).statusCode).toBe(204);
  }, 60_000);
});
