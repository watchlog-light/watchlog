// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clusterStatus } from '../src/modules/clusters/service.js';
import { TokenBuckets } from '../src/modules/ingest/rate-limit.js';
import { TokenCache } from '../src/modules/ingest/token-cache.js';
import {
  closeTestContext,
  createTestContext,
  setupAdmin,
  TEST_VM_URL,
  type TestContext,
} from './helpers.js';
import { encode } from './support/remote-write.js';

const RUN = `ingest-test-${Date.now()}`;

async function exportSeries(
  match: string,
): Promise<{ metric: Record<string, string>; values: number[] }[]> {
  await fetch(`${TEST_VM_URL}/internal/force_flush`);
  const res = await fetch(`${TEST_VM_URL}/api/v1/export?match[]=${encodeURIComponent(match)}`);
  const text = await res.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    {
      method: 'POST',
    },
  );
});

describe('ingest API', () => {
  let ctx: TestContext;
  let cookie: string;
  let clusterId: string;
  let tokenId: string;
  let token: string;

  async function start(...args: Parameters<typeof createTestContext>) {
    ctx = await createTestContext(...args);
    cookie = await setupAdmin(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: 'fleet', kind: 'docker' },
    });
    clusterId = res.json().cluster.id;
    tokenId = res.json().token.id;
    token = res.json().token.value;
  }

  beforeEach(() => start());
  afterEach(() => closeTestContext(ctx));

  const write = (body: Buffer, headers: Record<string, string> = {}, auth = token) =>
    ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/write',
      headers: {
        authorization: `Bearer ${auth}`,
        'content-type': 'application/x-protobuf',
        'content-encoding': 'snappy',
        'x-watchlog-agent': 'web-01',
        ...headers,
      },
      payload: body,
    });

  const heartbeat = (payload: object, node = 'web-01') =>
    ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/heartbeat',
      headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': node },
      payload,
    });

  const sample = (host: string, extra: Record<string, string> = {}) =>
    encode([
      {
        labels: { __name__: 'watchlog_node_load1', host, run: RUN, ...extra },
        value: 0.5,
        timestampMs: Date.now() - 60_000,
      },
    ]);

  it('rejects missing, invalid and revoked tokens with 401', async () => {
    expect((await write(sample('h'), {}, '')).statusCode).toBe(401);
    expect((await write(sample('h'), {}, `wl_ct_${'A'.repeat(43)}`)).statusCode).toBe(401);
    expect((await write(sample('h'))).statusCode).toBe(204); // now cached
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/clusters/${clusterId}/tokens/${tokenId}`,
      cookies: { wl_session: cookie },
    });
    // Revocation clears the cache immediately on this instance.
    const res = await write(sample('h'));
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('forwards metrics to VictoriaMetrics with the server-side cluster_id', async () => {
    const host = `host-${randomBytes(4).toString('hex')}`;
    expect((await write(sample(host))).statusCode).toBe(204);
    const series = await exportSeries(`watchlog_node_load1{host="${host}"}`);
    expect(series).toHaveLength(1);
    expect(series[0]!.metric).toMatchObject({ cluster_id: clusterId, host, run: RUN });
    expect(series[0]!.values).toEqual([0.5]);
  });

  it('rejects a spoofed cluster_id label', async () => {
    const res = await write(sample('h', { cluster_id: 'someone-else' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('reserved');
  });

  it('enforces size and series limits with 413', async () => {
    const tooMany = encode(
      Array.from({ length: 20_001 }, (_, i) => ({
        labels: { __name__: 'm', i: String(i), run: RUN },
        value: 1,
        timestampMs: Date.now(),
      })),
    );
    expect((await write(tooMany)).statusCode).toBe(413);
    // Header claims 64 MiB once decoded.
    expect((await write(Buffer.from([0x80, 0x80, 0x80, 0x20, 1, 2, 3]))).statusCode).toBe(413);
    // Compressed body over 4 MiB.
    expect((await write(randomBytes(5 << 20))).statusCode).toBe(413);
  });

  it('rejects malformed bodies and wrong headers', async () => {
    expect((await write(Buffer.from('not snappy'))).statusCode).toBe(400);
    expect((await write(sample('h'), { 'content-encoding': 'gzip' })).statusCode).toBe(400);
    expect((await write(sample('h'), { 'content-type': 'text/plain' })).statusCode).toBe(415);
  });

  it('answers 503 with Retry-After when VictoriaMetrics is unreachable', async () => {
    await closeTestContext(ctx);
    await start({ victoriaMetricsUrl: 'http://127.0.0.1:1' });
    const res = await write(sample('h'));
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('15');
  });

  it('rate-limits per agent instance with 429 and Retry-After', async () => {
    await closeTestContext(ctx);
    await start({}, { ingestBuckets: { agent: { ratePerSec: 1, burst: 2 } } });
    expect((await write(sample('h'))).statusCode).toBe(204);
    expect((await write(sample('h'))).statusCode).toBe(204);
    const limited = await write(sample('h'));
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    // Another host with the same token has its own bucket.
    expect((await write(sample('h2'), { 'x-watchlog-agent': 'web-02' })).statusCode).toBe(204);
  });

  it('gives the cluster-agent a bucket for its start-up burst', async () => {
    await closeTestContext(ctx);
    await start({}, { ingestBuckets: { agent: { ratePerSec: 1, burst: 2 } } });
    // ~25 requests at once on start at 15k pods (snapshot chunks, metrics, events).
    for (let i = 0; i < 25; i++) {
      expect(
        (await write(sample(`k${i}`), { 'x-watchlog-agent': 'cluster-agent' })).statusCode,
      ).toBe(204);
    }
    expect((await write(sample('n'), { 'x-watchlog-agent': 'node-1' })).statusCode).toBe(204);
    expect((await write(sample('n'), { 'x-watchlog-agent': 'node-1' })).statusCode).toBe(204);
    expect((await write(sample('n'), { 'x-watchlog-agent': 'node-1' })).statusCode).toBe(429);
  });

  it('rate-limits per cluster across agents', async () => {
    await closeTestContext(ctx);
    await start({}, { ingestBuckets: { cluster: { ratePerSec: 1, burst: 2 } } });
    expect((await write(sample('a'), { 'x-watchlog-agent': 'a' })).statusCode).toBe(204);
    expect((await write(sample('b'), { 'x-watchlog-agent': 'b' })).statusCode).toBe(204);
    expect((await write(sample('c'), { 'x-watchlog-agent': 'c' })).statusCode).toBe(429);
  });

  it('records heartbeats per node and marks the cluster active', async () => {
    const body = (node: string) => ({
      agent_version: '1.2.3',
      mode: 'docker',
      node,
      capabilities: { ebpf: 'disabled', cgroup: 'v2' },
      series: 64,
    });
    expect((await heartbeat(body('web-01'))).statusCode).toBe(204);
    expect((await heartbeat(body('web-02'), 'web-02')).statusCode).toBe(204);
    expect((await heartbeat(body('web-01'))).statusCode).toBe(204);

    const agents = await ctx.db.selectFrom('agent_instances').selectAll().orderBy('node').execute();
    expect(agents.map((a) => a.node)).toEqual(['web-01', 'web-02']);
    expect(agents[0]!.capabilities).toEqual({ ebpf: 'disabled', cgroup: 'v2' });

    // eBPF unsupported says why (ADR-102).
    const old = {
      ...body('web-03'),
      capabilities: {
        ebpf: 'unsupported',
        ebpf_reason: 'kernel has no BTF (/sys/kernel/btf/vmlinux missing)',
        cgroup: 'v2',
      },
    };
    expect((await heartbeat(old, 'web-03')).statusCode).toBe(204);
    expect(
      (
        await heartbeat(
          { ...old, capabilities: { ...old.capabilities, ebpf_reason: 'x'.repeat(301) } },
          'web-03',
        )
      ).statusCode,
    ).toBe(400);

    // The cause as a code and the chart's release give the fix (ADR-107); a field this
    // backend does not know is dropped, not rejected, so newer agents keep reporting.
    const caused = {
      ...body('web-04'),
      capabilities: {
        ebpf: 'unsupported',
        ebpf_reason: 'not permitted: the agent needs the BPF and PERFMON capabilities',
        ebpf_cause: 'permission',
        cgroup: 'v2',
        helm_release: 'watchlog-dev/kind-demo',
        helm_chart: 'watchlog-agent',
        from_a_newer_agent: 'x',
      },
    };
    expect((await heartbeat(caused, 'web-04')).statusCode).toBe(204);
    const web04 = await ctx.db
      .selectFrom('agent_instances')
      .select('capabilities')
      .where('node', '=', 'web-04')
      .executeTakeFirstOrThrow();
    expect(web04.capabilities).toEqual({ ...caused.capabilities, from_a_newer_agent: undefined });

    // Kubernetes node agents also report how the kubelet connection is secured (ADR-051).
    const node = {
      ...body('kind-worker'),
      mode: 'node',
      capabilities: { ebpf: 'disabled', cgroup: 'v2', kubelet_tls: 'unverified' },
    };
    expect((await heartbeat(node, 'kind-worker')).statusCode).toBe(204);
    expect(
      (
        await heartbeat(
          { ...node, capabilities: { ...node.capabilities, kubelet_tls: 'maybe' } },
          'kind-worker',
        )
      ).statusCode,
    ).toBe(400);
    const worker = await ctx.db
      .selectFrom('agent_instances')
      .selectAll()
      .where('node', '=', 'kind-worker')
      .executeTakeFirstOrThrow();
    expect(worker.capabilities).toEqual({
      ebpf: 'disabled',
      cgroup: 'v2',
      kubelet_tls: 'unverified',
    });

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/clusters/${clusterId}`,
      cookies: { wl_session: cookie },
    });
    expect(detail.json().cluster).toMatchObject({
      status: 'active',
      // web-01, web-02, web-03 (eBPF unsupported), web-04 (not permitted) and kind-worker.
      nodeCount: 5,
      agentVersion: '1.2.3',
    });
    expect(detail.json().cluster.firstSeenAt).not.toBeNull();
  });

  it('caches token lookups for 60 s and clears them on invalidation', async () => {
    let now = 0;
    const cache = new TokenCache(ctx.db, () => now);
    expect(await cache.verify(token)).toMatchObject({ clusterId, tokenId });
    // Revoked directly in the database (as another backend instance would): still cached.
    await ctx.db.updateTable('cluster_tokens').set({ revoked_at: new Date() }).execute();
    expect(await cache.verify(token)).not.toBeNull();
    now = 61_000;
    expect(await cache.verify(token)).toBeNull();
    // Failed lookups are not cached: un-revoking takes effect at once.
    await ctx.db.updateTable('cluster_tokens').set({ revoked_at: null }).execute();
    expect(await cache.verify(token)).not.toBeNull();
    cache.invalidateToken(tokenId);
    await ctx.db.updateTable('cluster_tokens').set({ revoked_at: new Date() }).execute();
    expect(await cache.verify(token)).toBeNull();
  });

  it('records ingest errors per cluster and clears them on the next success (ADR-117)', async () => {
    await closeTestContext(ctx);
    await start({ victoriaMetricsUrl: 'http://127.0.0.1:1' });
    const failure = async () =>
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/clusters',
          cookies: { wl_session: cookie },
        })
      ).json().clusters[0].ingestFailure;
    expect(await failure()).toBeNull();

    // VictoriaMetrics is down: every write is answered 503 and loses nothing yet, but
    // the data is delayed, and the cluster says so.
    expect((await write(sample('h'))).statusCode).toBe(503);
    expect((await write(sample('h'))).statusCode).toBe(503);
    // A heartbeat the backend refuses (400) is a second failing endpoint.
    expect((await heartbeat({ node: 'x' })).statusCode).toBe(400);
    let f = await failure();
    expect(
      f.endpoints.map((e: { endpoint: string; status: number; failures: number }) => [
        e.endpoint,
        e.status,
        e.failures,
      ]),
    ).toEqual([
      ['heartbeat', 400, 1],
      ['write', 503, 2],
    ]);
    expect(Date.parse(f.since)).toBeGreaterThan(Date.now() - 60_000);
    expect(f.endpoints[1].message).toMatch(/VictoriaMetrics|unavailable|storage/i);

    // A good heartbeat ends that endpoint's failure; writes still fail.
    const ok = {
      agent_version: '1.2.3',
      mode: 'docker',
      node: 'web-01',
      capabilities: { ebpf: 'disabled', cgroup: 'v2' },
      series: 1,
    };
    expect((await heartbeat(ok)).statusCode).toBe(204);
    f = await failure();
    expect(f.endpoints.map((e: { endpoint: string }) => e.endpoint)).toEqual(['write']);

    // An error older than 10 minutes is not "failing now".
    await ctx.db
      .updateTable('ingest_errors')
      .set({ last_error_at: new Date(Date.now() - 11 * 60_000) })
      .where('cluster_id', '=', clusterId)
      .execute();
    expect(await failure()).toBeNull();

    // Rate limiting (429) is backpressure, not an error.
    const rows = await ctx.db.selectFrom('ingest_errors').select('last_status').execute();
    expect(rows.map((r) => r.last_status).sort()).toEqual([400, 503]);
  });

  it('validates heartbeat bodies', async () => {
    expect((await heartbeat({ node: 'x' })).statusCode).toBe(400);
    expect(
      (
        await heartbeat({
          agent_version: '1',
          mode: 'swarm',
          node: 'x',
          capabilities: {},
          series: 1,
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('ingest building blocks', () => {
  it('derives cluster status from the last heartbeat', () => {
    const now = Date.now();
    expect(clusterStatus(null, now)).toBe('pending');
    expect(clusterStatus(new Date(now - 60_000), now)).toBe('active');
    expect(clusterStatus(new Date(now - 4 * 60_000), now)).toBe('inactive');
  });

  it('refills token buckets over time', () => {
    let now = 0;
    const b = new TokenBuckets({ ratePerSec: 2, burst: 2 }, () => now);
    expect([b.take('k'), b.take('k'), b.take('k')]).toEqual([0, 0, 1]);
    now = 500;
    expect(b.take('k')).toBe(0);
    now = 10_000;
    b.prune();
    expect(b.size).toBe(0);
  });
});
