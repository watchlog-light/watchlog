// SPDX-License-Identifier: AGPL-3.0-only
// Scenario 12 of the Cloud plan (ADR-177): two real VictoriaMetrics instances, the 3-day
// and the 30-day tier. A Free org writes to the 3-day tier through ingest; after it moves
// to Pro, new writes go to the 30-day tier, and reads ask both and merge the series by
// labels, the current tier's point winning. It needs the two instances, so it runs only
// with WATCHLOG_TEST_VM_3D_URL and WATCHLOG_TEST_VM_30D_URL set (not in CI):
//   docker run -d --name vm3d -p 127.0.0.1:18501:8428 victoriametrics/victoria-metrics -retentionPeriod=3d
//   docker run -d --name vm30d -p 127.0.0.1:18502:8428 victoriametrics/victoria-metrics -retentionPeriod=30d
import { afterAll, describe, expect, it } from 'vitest';
import { authorisedScope } from '../src/lib/victoria.js';
import { metricsClient } from '../src/modules/entitlements/metrics.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';
import { encode } from './support/remote-write.js';

const VM3 = process.env.WATCHLOG_TEST_VM_3D_URL;
const VM30 = process.env.WATCHLOG_TEST_VM_30D_URL;
const RUN = `tiers-${Date.now()}`;
const offline = (async () => new Response('offline', { status: 599 })) as typeof fetch;

let ctx: TestContext | undefined;
afterAll(async () => {
  for (const url of [VM3, VM30]) {
    if (url) {
      await fetch(
        `${url}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
        { method: 'POST' },
      ).catch(() => undefined);
    }
  }
  if (ctx) await closeTestContext(ctx);
});

async function count(url: string, clusterId: string): Promise<number[]> {
  await fetch(`${url}/internal/force_flush`).catch(() => undefined);
  const q = new URLSearchParams({
    query: `watchlog_node_load1{run="${RUN}"}`,
    start: String(Math.floor(Date.now() / 1000) - 3600),
    end: String(Math.floor(Date.now() / 1000)),
    step: '60s',
    extra_label: `cluster_id=${clusterId}`,
  });
  const res = (await (await fetch(`${url}/api/v1/query_range?${q}`)).json()) as {
    data: { result: { values: [number, string][] }[] };
  };
  return (res.data.result[0]?.values ?? []).map(([, v]) => Number(v));
}

describe.skipIf(!VM3 || !VM30)('scenario 12: two retention tiers (real VictoriaMetrics)', () => {
  it('Free writes to vm-3d; after Pro, new data to vm-30d and reads merge both', async () => {
    ctx = await createTestContext(
      {
        edition: 'cloud',
        cookieSecure: 'always',
        victoriaMetricsTiers: { '3d': VM3!, '30d': VM30! },
        accounts: {
          turnstile: {},
          supportEmail: 'support@watchlog.io',
          sampleUrl: 'https://demo.watchlog.io',
        },
      },
      { fetch: offline },
    );
    const c = ctx;
    const signup = await c.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'tiers@acme.example', password: 'a long enough password' },
    });
    const cookie = signup.cookies.find((x) => x.name === 'wl_session')!.value;
    const call = (method: string, url: string, payload?: object) =>
      c.app.inject({
        method: method as 'GET',
        url: `/api/v1${url}`,
        cookies: { wl_session: cookie },
        ...(payload ? { payload } : {}),
      });
    const orgId = (await call('GET', '/me')).json().user.org.id as string;
    const created = (await call('POST', '/clusters', { name: 'prod', kind: 'kubernetes' })).json();
    const clusterId = created.cluster.id as string;
    const token = created.token.value as string;
    const minute = (m: number) => Math.floor(Date.now() / 60_000) * 60_000 - m * 60_000;
    const send = (points: [number, number][]) =>
      c.app.inject({
        method: 'POST',
        url: '/ingest/v1/write',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/x-protobuf',
          'content-encoding': 'snappy',
          'x-watchlog-agent': 'n1',
        },
        payload: encode(
          points.map(([t, v]) => ({
            labels: { __name__: 'watchlog_node_load1', node: 'n1', run: RUN },
            value: v,
            timestampMs: t,
          })),
        ),
      });

    // Free: 10 to 5 minutes ago, value 1, to the 3-day tier.
    expect((await send([10, 9, 8, 7, 6, 5].map((m) => [minute(m), 1]))).statusCode).toBe(204);
    // Upgrade to Pro mid-period: new data, 5 to 2 minutes ago, value 2 (5 overlaps).
    await c.app.entitlements!.put(orgId, { plan: 'pro', source: 'beta' });
    expect((await c.app.entitlements!.placement(orgId)).previous).toBe('3d');
    expect((await send([5, 4, 3, 2].map((m) => [minute(m), 2]))).statusCode).toBe(204);

    // Each instance holds only its part (a range query carries the last value a step on).
    const old = await count(VM3!, clusterId);
    const cur = await count(VM30!, clusterId);
    expect(old.length).toBeGreaterThanOrEqual(6);
    expect(new Set(old)).toEqual(new Set([1]));
    expect(cur.length).toBeGreaterThanOrEqual(4);
    expect(new Set(cur)).toEqual(new Set([2]));

    // The client the app uses reads both and merges; at 5 minutes ago the current tier wins.
    const vm = metricsClient(
      { victoriaMetricsTiers: { '3d': VM3!, '30d': VM30! } },
      c.app.entitlements,
      { warn: () => {} },
    )!;
    const series = await vm.queryRange(
      authorisedScope(clusterId),
      `watchlog_node_load1{run="${RUN}"}`,
      Math.floor(minute(10) / 1000),
      Math.floor(minute(2) / 1000),
      60,
    );
    expect(series).toHaveLength(1);
    expect(series[0]!.points.map(([, v]) => v)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2]);
    // An instant query: the current tier's value.
    const instant = await vm.query(
      authorisedScope(clusterId),
      `last_over_time(watchlog_node_load1{run="${RUN}"}[30m])`,
    );
    expect(instant[0]!.points[0]![1]).toBe(2);
    // Another org's cluster id still sees nothing: extra_label holds in both tiers.
    const other = await vm.queryRange(
      authorisedScope('00000000-0000-4000-8000-000000000000'),
      `watchlog_node_load1{run="${RUN}"}`,
      Math.floor(minute(10) / 1000),
      Math.floor(minute(2) / 1000),
      60,
    );
    expect(other).toEqual([]);
  });
});
