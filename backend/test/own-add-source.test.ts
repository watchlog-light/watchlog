// SPDX-License-Identifier: AGPL-3.0-only
// Add a source (1.0.3) through the API, on a Kubernetes cluster and on a Server fleet: "Test"
// (an address read once by its collector, each answer the collector can give, what the caps
// would keep), what "Find endpoints for me" tried, what a token has sent since a moment (the
// page waits on it for the first value), "Send a test value for me" and its removal, the
// workloads a push can belong to, and who may do what.
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { TEST_WAIT_MS } from '../src/modules/own-metrics/probes.js';
import { TEST_METRIC } from '../src/modules/own-metrics/routes.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { encode } from './support/remote-write.js';

interface Cluster {
  id: string;
  token: string;
  orgId: string;
}

let ctx: TestContext;
let cookie: string;
let clock = 0;

async function start(...args: Parameters<typeof createTestContext>) {
  ctx = await createTestContext(...args);
  cookie = await setupAdmin(ctx.app);
}
afterEach(() => closeTestContext(ctx));

async function cluster(kind: 'server' | 'kubernetes'): Promise<Cluster> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/clusters',
    cookies: { wl_session: cookie },
    payload: { name: kind, kind },
  });
  expect(res.statusCode).toBe(201);
  const org = await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow();
  return { id: res.json().cluster.id, token: res.json().token.value, orgId: org.id };
}
const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, as = cookie) =>
  ctx.app.inject({
    method,
    url: `/api/v1${url}`,
    cookies: { wl_session: as },
    ...(payload ? { payload } : {}),
  });
const object = (
  c: Cluster,
  kind: string,
  namespace: string,
  name: string,
  spec = {},
  status = {},
) =>
  ctx.db
    .insertInto('objects')
    .values({
      id: newId(),
      cluster_id: c.id,
      source: 'kubernetes',
      kind,
      namespace,
      name,
      uid: newId(),
      spec_summary: JSON.stringify(spec),
      status_summary: JSON.stringify(status),
    })
    .execute();
const pod = (
  c: Cluster,
  name: string,
  workload: string,
  ip: string,
  ports: number[],
  phase = 'Running',
) =>
  object(
    c,
    'Pod',
    'shop',
    name,
    {
      workload: { kind: 'Deployment', name: workload },
      containers: [{ ports: ports.map((port) => ({ port })) }],
    },
    { phase, pod_ip: ip },
  );
const server = (c: Cluster, node: string) =>
  ctx.db
    .insertInto('agent_instances')
    .values({
      id: newId(),
      cluster_id: c.id,
      node,
      mode: 'docker',
      agent_version: '1.0.3',
      last_seen_at: new Date(),
    })
    .execute();

const collector = { 'x-watchlog-agent': 'integrations' };
type Section = {
  probe?: { id: string; candidates: { id: string; url: string }[] };
  test?: { id: string; candidates: { id: string; url: string }[] };
};
async function section(c: Cluster, host = ''): Promise<Section | undefined> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/ingest/v1/integrations/config?host=${encodeURIComponent(host)}`,
    headers: { authorization: `Bearer ${c.token}`, ...collector },
  });
  expect(res.statusCode).toBe(200);
  return res.json().modules?.own_metrics;
}
const answer = (c: Cluster, id: string, host: string, result: object) =>
  ctx.app.inject({
    method: 'POST',
    url: '/ingest/v1/own-metrics/probe',
    headers: { authorization: `Bearer ${c.token}`, ...collector },
    payload: { id, host, results: [{ id: 'test', ok: false, series: 0, ...result }] },
  });
async function token(c: Cluster, name = 'my first metrics') {
  const res = await api('POST', `/clusters/${c.id}/own-metrics/tokens`, { name });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; value: string };
}
const push = (value: string, payload: object) =>
  ctx.app.inject({
    method: 'POST',
    url: '/ingest/v1/metrics',
    headers: { authorization: `Bearer ${value}` },
    payload,
  });
const received = async (c: Cluster, tokenId: string, since?: number) =>
  (
    await api(
      'GET',
      `/clusters/${c.id}/own-metrics/tokens/${tokenId}/received${since === undefined ? '' : `?since=${since}`}`,
    )
  ).json();

describe('Test, on a Server fleet', () => {
  it('asks only that server’s collector, once, and says each answer the collector can give', async () => {
    clock = Date.parse('2026-11-26T10:00:00Z');
    // The collector is played many times in a moment: its own request budget isn't the subject.
    await start(
      {},
      { now: () => clock, ingestBuckets: { agent: { ratePerSec: 1000, burst: 1000 } } },
    );
    const c = await cluster('server');
    await server(c, 'web-1');
    await server(c, 'db-1');
    const url = `/clusters/${c.id}/own-metrics/test`;
    expect((await api('GET', url)).statusCode).toBe(404);

    const started = await api('POST', url, { server: 'web-1', address: 'localhost:9400' });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ done: false, address: 'localhost:9400/metrics' });
    expect(started.json().outcome).toBeUndefined();
    // Its own collector is asked; another server's isn't.
    expect((await section(c, 'db-1'))?.test).toBeUndefined();
    const s = await section(c, 'web-1');
    expect(s!.test!.candidates).toEqual([{ id: 'test', url: 'http://localhost:9400/metrics' }]);

    expect((await answer(c, s!.test!.id, 'web-1', { reason: 'refused' })).statusCode).toBe(204);
    expect((await api('GET', url)).json()).toMatchObject({ done: true, outcome: 'refused' });
    // Answered: the collector isn't asked again.
    expect((await section(c, 'web-1'))?.test).toBeUndefined();

    for (const [reason, detail] of [
      ['html', undefined],
      ['auth', '401'],
      ['slow', undefined],
      ['big', undefined],
      ['not_metrics', undefined],
      ['status', '404'],
    ] as const) {
      await api('POST', url, { server: 'web-1', address: 'http://localhost:8080/' });
      const t = (await section(c, 'web-1'))!.test!;
      expect(t.candidates[0]!.url).toBe('http://localhost:8080/');
      await answer(c, t.id, 'web-1', { reason, ...(detail ? { detail } : {}) });
      const got = (await api('GET', url)).json();
      expect(got).toMatchObject({ done: true, outcome: reason, address: 'localhost:8080/' });
      expect(got.detail).toBe(detail);
    }

    // It answers with metrics: how many, a few names.
    await api('POST', url, { server: 'web-1', address: 'localhost:9400/metrics' });
    const ok = (await section(c, 'web-1'))!.test!;
    await answer(c, ok.id, 'web-1', {
      ok: true,
      series: 214,
      names: ['http_requests_total', 'queue_jobs_waiting'],
    });
    expect((await api('GET', url)).json()).toEqual({
      id: ok.id,
      done: true,
      address: 'localhost:9400/metrics',
      outcome: 'answered',
      series: 214,
      names: ['http_requests_total', 'queue_jobs_waiting'],
    });

    // More than one endpoint may bring: how many would be kept, and which cap cuts it.
    await api('POST', url, { server: 'web-1', address: 'localhost:9400/metrics' });
    await answer(c, (await section(c, 'web-1'))!.test!.id, 'web-1', {
      ok: true,
      series: 900,
      names: ['a'],
    });
    expect((await api('GET', url)).json()).toMatchObject({ series: 900, kept: 500, cap: 'source' });

    // A collector that never answers (older than 1.0.3, or not running): said after the wait.
    await api('POST', url, { server: 'web-1', address: 'localhost:9400/metrics' });
    clock += TEST_WAIT_MS - 1000;
    expect((await api('GET', url)).json()).toMatchObject({ done: false });
    clock += 2000;
    expect((await api('GET', url)).json()).toMatchObject({ done: true, outcome: 'silent' });
    expect((await section(c, 'web-1'))?.test).toBeUndefined();

    // An older collector's answer without a reason is still an answer.
    await api('POST', url, { server: 'web-1', address: 'localhost:9400/metrics' });
    await answer(c, (await section(c, 'web-1'))!.test!.id, 'web-1', {});
    expect((await api('GET', url)).json()).toMatchObject({ done: true, outcome: 'other' });
  });

  it('refuses what isn’t an address, a server it doesn’t know, and a workload’s port', async () => {
    await start();
    const c = await cluster('server');
    await server(c, 'web-1');
    const url = `/clusters/${c.id}/own-metrics/test`;
    for (const [body, words] of [
      [{ server: 'web-1', address: 'ftp://localhost/metrics' }, /Give an address like/],
      [{ server: 'web-1', address: 'http://user:secret@localhost:9400' }, /Give an address like/],
      [{ server: 'web-9', address: 'localhost:9400' }, /No server named web-9/],
      [
        { namespace: 'shop', workloadKind: 'Deployment', workload: 'orders', port: 8080 },
        /Kubernetes/,
      ],
    ] as const) {
      const res = await api('POST', url, body);
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toMatch(words);
    }
    expect((await section(c, 'web-1'))?.test).toBeUndefined();
  });

  it('with the installation nearly full, says how many series the plan has room for', async () => {
    await start({ ownMetricSeries: 40 });
    const c = await cluster('server');
    await server(c, 'web-1');
    const url = `/clusters/${c.id}/own-metrics/test`;
    await api('POST', url, { server: 'web-1', address: 'localhost:9400' });
    await answer(c, (await section(c, 'web-1'))!.test!.id, 'web-1', {
      ok: true,
      series: 214,
      names: [],
    });
    expect((await api('GET', url)).json()).toMatchObject({ series: 214, kept: 40, cap: 'plan' });
  });
});

describe('Test and Find, on a Kubernetes cluster', () => {
  it('reads a workload’s port through one running pod; lists the workloads to choose from', async () => {
    await start();
    const c = await cluster('kubernetes');
    await object(c, 'Deployment', 'shop', 'orders');
    await object(c, 'StatefulSet', 'shop', 'db');
    await object(c, 'ConfigMap', 'shop', 'settings');
    await pod(c, 'orders-0', 'orders', '10.1.0.4', [8080], 'Pending');
    await pod(c, 'orders-1', 'orders', '10.1.0.5', [8080]);
    const summary = (await api('GET', `/clusters/${c.id}/own-metrics`)).json();
    expect(summary.workloads).toEqual([
      { namespace: 'shop', kind: 'StatefulSet', name: 'db' },
      { namespace: 'shop', kind: 'Deployment', name: 'orders' },
    ]);
    expect(summary.servers).toEqual([]);

    const url = `/clusters/${c.id}/own-metrics/test`;
    const body = { namespace: 'shop', workloadKind: 'Deployment', workload: 'orders', port: 9102 };
    const started = await api('POST', url, { ...body, path: '/internal/metrics' });
    expect(started.json()).toMatchObject({ address: 'shop/orders :9102/internal/metrics' });
    const s = await section(c);
    expect(s!.test!.candidates[0]!.url).toBe('http://10.1.0.5:9102/internal/metrics');
    await answer(c, s!.test!.id, '', { ok: true, series: 12, names: ['orders_total'] });
    expect((await api('GET', url)).json()).toMatchObject({ outcome: 'answered', series: 12 });

    const none = await api('POST', url, { ...body, workload: 'db', workloadKind: 'StatefulSet' });
    expect(none.statusCode).toBe(400);
    expect(none.json().detail).toBe('No running pod of shop/db to read');
    expect(
      (await api('POST', url, { server: 'web-1', address: 'localhost:9400' })).statusCode,
    ).toBe(400);
  });

  it('Find says what it tried: the ports, the ones left out, the workloads', async () => {
    await start();
    const c = await cluster('kubernetes');
    await pod(c, 'orders-1', 'orders', '10.1.0.5', [8080, 9102]);
    await pod(c, 'db-0', 'db', '10.1.0.6', [5432, 9187]);
    await pod(c, 'cart-1', 'cart', '10.1.0.7', [8080]);
    const found = (await api('POST', `/clusters/${c.id}/own-metrics/find`)).json();
    expect(found.asked).toBe(4);
    expect(found.tried).toEqual({
      ports: [8080, 9102, 9187],
      skipped: [5432],
      scraped: 0,
      workloads: 3,
    });
    // A test and a search run side by side, each answered by its own id.
    await api('POST', `/clusters/${c.id}/own-metrics/test`, {
      namespace: 'shop',
      workloadKind: 'Deployment',
      workload: 'cart',
      port: 8080,
    });
    const s = await section(c);
    expect(s!.probe!.candidates).toHaveLength(4);
    expect(s!.test!.candidates).toHaveLength(1);
    await answer(c, s!.test!.id, '', { reason: 'html' });
    expect((await api('GET', `/clusters/${c.id}/own-metrics/find`)).json()).toMatchObject({
      done: false,
      found: [],
    });
    expect((await api('GET', `/clusters/${c.id}/own-metrics/test`)).json().outcome).toBe('html');
  });
});

describe('what a token has sent', () => {
  it('nothing, then the first push with its value and what it belongs to; later only what is new', async () => {
    clock = Date.parse('2026-11-26T10:00:00Z');
    await start({}, { now: () => clock });
    const c = await cluster('server');
    await server(c, 'web-1');
    const t = await token(c);
    const other = await token(c, 'ci');
    expect(await received(c, t.id)).toEqual({ now: clock, received: null });

    expect(
      (await push(t.value, { name: 'orders_total', value: 1, server: 'web-1' })).json(),
    ).toMatchObject({
      stored: 1,
    });
    const first = await received(c, t.id, 0);
    expect(first.received).toMatchObject({
      at: clock,
      way: 'push',
      name: 'orders_total',
      value: 1,
      owner: { kind: 'server', name: 'web-1' },
      series: 1,
      metrics: 1,
    });
    expect(first.received.metricId).toMatch(/^[0-9a-f-]{36}$/);
    // Another token sent nothing; a later moment has nothing new.
    expect((await received(c, other.id, 0)).received).toBeNull();
    expect((await received(c, t.id, clock + 1)).received).toBeNull();

    // The newest arrival is the one said.
    clock += 4000;
    await push(t.value, { name: 'queue_jobs_waiting', value: 12 });
    const second = await received(c, t.id, 0);
    expect(second.received).toMatchObject({
      name: 'queue_jobs_waiting',
      value: 12,
      owner: { kind: '', name: '' },
      series: 2,
      metrics: 2,
    });
    expect(
      (await api('GET', `/clusters/${c.id}/own-metrics/tokens/${newId()}/received`)).statusCode,
    ).toBe(404);
  });

  it('remote write: how many series of how many metrics, and one of their names', async () => {
    await start();
    const c = await cluster('kubernetes');
    const t = await token(c);
    const now = Date.now();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/write',
      headers: {
        authorization: `Bearer ${t.value}`,
        'content-type': 'application/x-protobuf',
        'content-encoding': 'snappy',
      },
      payload: encode([
        { labels: { __name__: 'orders_total', method: 'card' }, value: 5, timestampMs: now },
        { labels: { __name__: 'orders_total', method: 'paypal' }, value: 2, timestampMs: now },
        { labels: { __name__: 'checkout_seconds' }, value: 0.4, timestampMs: now },
      ]),
    });
    expect(res.statusCode).toBeLessThan(300);
    const got = (await received(c, t.id, 0)).received;
    expect(got).toMatchObject({ way: 'remote_write', series: 3, metrics: 2, value: null });
    expect(['orders_total', 'checkout_seconds']).toContain(got.name);
  });
});

describe('Send a test value for me', () => {
  for (const kind of ['server', 'kubernetes'] as const) {
    it(`${kind}: one value through the token’s own way in, named as a test, and removed again`, async () => {
      await start();
      const c = await cluster(kind);
      if (kind === 'server') await server(c, 'web-1');
      else {
        await object(c, 'Deployment', 'shop', 'orders');
        await pod(c, 'orders-1', 'orders', '10.1.0.5', [8080]);
      }
      const t = await token(c);
      const owner = kind === 'server' ? { server: 'web-1' } : { workload: 'shop/orders' };
      const sent = await api('POST', `/clusters/${c.id}/own-metrics/test-value`, {
        tokenId: t.id,
        ...owner,
      });
      expect(sent.statusCode).toBe(200);
      expect(sent.json()).toEqual({ name: TEST_METRIC, value: 1, stored: true });
      expect(TEST_METRIC).toBe('my_first_test_value');

      const got = (await received(c, t.id, 0)).received;
      expect(got).toMatchObject({
        way: 'push',
        name: TEST_METRIC,
        value: 1,
        owner:
          kind === 'server'
            ? { kind: 'server', name: 'web-1' }
            : { kind: 'workload', namespace: 'shop', name: 'orders' },
      });
      // It is a push of that token: one series of the plan's, one source (the token's).
      const before = (await api('GET', `/clusters/${c.id}/own-metrics`)).json();
      expect(before.usage).toEqual({ series: 1, sources: 1 });
      expect(before.sources[0]).toMatchObject({ kind: 'push', series: 1 });
      expect(before.metrics).toBe(1);

      expect((await api('DELETE', `/clusters/${c.id}/own-metrics/test-value`)).statusCode).toBe(
        204,
      );
      const after = (await api('GET', `/clusters/${c.id}/own-metrics`)).json();
      expect(after.metrics).toBe(0);
      expect(after.usage.series).toBe(0);
      expect((await received(c, t.id, 0)).received).toBeNull();
      // The user's own push still arrives after it.
      await push(t.value, { name: 'orders_total', value: 3, ...owner });
      expect((await received(c, t.id, 0)).received).toMatchObject({
        name: 'orders_total',
        value: 3,
      });
      // Removing it twice is nothing.
      expect((await api('DELETE', `/clusters/${c.id}/own-metrics/test-value`)).statusCode).toBe(
        204,
      );
    });
  }

  it('says when the plan has no room for it; refuses a token of another place', async () => {
    await start({ ownMetricSeries: 1 });
    const c = await cluster('server');
    const elsewhere = await cluster('kubernetes');
    const t = await token(c);
    await push(t.value, { name: 'orders_total', value: 1 });
    const full = await api('POST', `/clusters/${c.id}/own-metrics/test-value`, { tokenId: t.id });
    expect(full.json()).toEqual({ name: TEST_METRIC, value: 1, stored: false, refused: 'series' });
    expect(
      (await api('POST', `/clusters/${elsewhere.id}/own-metrics/test-value`, { tokenId: t.id }))
        .statusCode,
    ).toBe(404);
  });
});

describe('who may', () => {
  it('a Viewer reads a test’s answer and what a token sent, and starts or removes nothing', async () => {
    await start();
    const c = await cluster('server');
    await server(c, 'web-1');
    const t = await token(c);
    const viewer = await createUserSession(ctx.db, { role: 'viewer', orgId: c.orgId });
    const as = viewer.cookie;
    await api('POST', `/clusters/${c.id}/own-metrics/test`, {
      server: 'web-1',
      address: 'localhost:9400',
    });
    expect((await api('GET', `/clusters/${c.id}/own-metrics/test`, undefined, as)).statusCode).toBe(
      200,
    );
    expect(
      (await api('GET', `/clusters/${c.id}/own-metrics/tokens/${t.id}/received`, undefined, as))
        .statusCode,
    ).toBe(200);
    for (const [method, path, body] of [
      ['POST', 'test', { server: 'web-1', address: 'localhost:9400' }],
      ['POST', 'test-value', { tokenId: t.id }],
      ['DELETE', 'test-value', undefined],
    ] as const) {
      expect(
        (await api(method, `/clusters/${c.id}/own-metrics/${path}`, body, as)).statusCode,
      ).toBe(403);
    }
  });

  it('the demo starts no test and sends no test value', async () => {
    ctx = await createTestContext({ demoMode: true });
    const session = await createUserSession(ctx.db, { role: 'owner' });
    cookie = session.cookie;
    const id = newId();
    for (const [method, path, body] of [
      ['POST', 'test', { server: 'web-1', address: 'localhost:9400' }],
      ['POST', 'test-value', { tokenId: newId() }],
      ['DELETE', 'test-value', undefined],
    ] as const) {
      const res = await api(method, `/clusters/${id}/own-metrics/${path}`, body);
      expect(res.statusCode).toBe(403);
    }
  });
});
