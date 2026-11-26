// SPDX-License-Identifier: AGPL-3.0-only
// Own metrics through the API (1.0.0, ADR-236), on a Kubernetes cluster and on a Server fleet:
// what the collector is told to scrape, its reports, remote write and pushes with the
// write-only token, what each series belongs to, every cap with what it says, and the panel's
// sources, tokens and "Find endpoints for me".
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import type { OwnMetricLimits } from '../src/modules/entitlements/own-metrics.js';
import { ownMetricLimits } from '../src/modules/entitlements/own-metrics.js';
import { OwnMetrics, type SourceRef } from '../src/modules/own-metrics/service.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  TEST_VM_URL,
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

async function start(...args: Parameters<typeof createTestContext>) {
  ctx = await createTestContext(...args);
  cookie = await setupAdmin(ctx.app);
}

afterEach(() => closeTestContext(ctx));

async function cluster(kind: 'server' | 'kubernetes', name: string = kind): Promise<Cluster> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/clusters',
    cookies: { wl_session: cookie },
    payload: { name, kind },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  const org = await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow();
  return { id: body.cluster.id as string, token: body.token.value as string, orgId: org.id };
}

const api = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  as = cookie,
) =>
  ctx.app.inject({
    method,
    url: `/api/v1${url}`,
    cookies: { wl_session: as },
    ...(payload ? { payload } : {}),
  });

async function pod(
  c: Cluster,
  p: {
    namespace?: string;
    name: string;
    workload?: string;
    kind?: string;
    ip?: string;
    ports?: { name?: string; port: number }[];
    scrape?: Record<string, unknown>;
    phase?: string;
  },
) {
  await ctx.db
    .insertInto('objects')
    .values({
      id: newId(),
      cluster_id: c.id,
      source: 'kubernetes',
      kind: 'Pod',
      namespace: p.namespace ?? 'shop',
      name: p.name,
      uid: newId(),
      spec_summary: JSON.stringify({
        workload: { kind: p.kind ?? 'Deployment', name: p.workload ?? 'orders' },
        containers: [{ ports: p.ports ?? [{ name: 'http', port: 8080 }] }],
        ...(p.scrape ? { scrape: p.scrape } : {}),
      }),
      status_summary: JSON.stringify({ phase: p.phase ?? 'Running', pod_ip: p.ip ?? '10.1.0.5' }),
    })
    .execute();
}

async function workload(c: Cluster, namespace: string, kind: string, name: string) {
  await ctx.db
    .insertInto('objects')
    .values({
      id: newId(),
      cluster_id: c.id,
      source: 'kubernetes',
      kind,
      namespace,
      name,
      uid: newId(),
      spec_summary: '{}',
      status_summary: '{}',
    })
    .execute();
}

async function server(c: Cluster, node: string) {
  await ctx.db
    .insertInto('agent_instances')
    .values({
      id: newId(),
      cluster_id: c.id,
      node,
      mode: 'docker',
      agent_version: '1.0.0',
      last_seen_at: new Date(),
    })
    .execute();
}

const collector = { 'x-watchlog-agent': 'integrations' };

async function section(c: Cluster, host = '') {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/ingest/v1/integrations/config?host=${encodeURIComponent(host)}`,
    headers: { authorization: `Bearer ${c.token}`, ...collector },
  });
  expect(res.statusCode).toBe(200);
  return res.json().modules?.own_metrics as
    | {
        interval_s: number;
        targets: { id: string; url: string }[];
        probe?: { id: string; candidates: { id: string; url: string }[] };
      }
    | undefined;
}

const report = (c: Cluster, body: object) =>
  ctx.app.inject({
    method: 'POST',
    url: '/ingest/v1/own-metrics/scrape',
    headers: {
      authorization: `Bearer ${c.token}`,
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      ...collector,
    },
    payload: gzipSync(Buffer.from(JSON.stringify(body))),
  });

async function token(c: Cluster, name = 'ci and cron') {
  const res = await api('POST', `/clusters/${c.id}/own-metrics/tokens`, { name });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string; prefix: string; value: string };
}

const push = (value: string, payload: object) =>
  ctx.app.inject({
    method: 'POST',
    url: '/ingest/v1/metrics',
    headers: { authorization: `Bearer ${value}` },
    payload,
  });

const remoteWrite = (value: string, series: Parameters<typeof encode>[0]) =>
  ctx.app.inject({
    method: 'POST',
    url: '/ingest/v1/write',
    headers: {
      authorization: `Bearer ${value}`,
      'content-type': 'application/x-protobuf',
      'content-encoding': 'snappy',
    },
    payload: encode(series),
  });

/** What VictoriaMetrics holds of a cluster's metric: each series' labels and last value. */
async function stored(c: Cluster, name: string) {
  await fetch(`${TEST_VM_URL}/internal/force_flush`);
  const q = encodeURIComponent(`{__name__="${name}",cluster_id="${c.id}"}`);
  // An explicit range: without one the newest samples are not in the answer yet.
  const now = Math.floor(Date.now() / 1000);
  const res = await fetch(
    `${TEST_VM_URL}/api/v1/export?match[]=${q}&start=${now - 3600}&end=${now + 120}`,
  );
  const lines = (await res.text()).split('\n').filter(Boolean);
  return lines.map((l) => {
    const row = JSON.parse(l) as { metric: Record<string, string>; values: number[] };
    const labels = Object.fromEntries(
      Object.entries(row.metric).filter(([k]) => k !== '__name__' && k !== 'cluster_id'),
    );
    return { labels, last: row.values[row.values.length - 1]!, values: row.values };
  });
}

const summary = async (c: Cluster) => {
  const res = await api('GET', `/clusters/${c.id}/own-metrics`);
  expect(res.statusCode).toBe(200);
  return res.json();
};

describe('scraping on a Kubernetes cluster', () => {
  beforeEach(() => start());

  it('tells the collector the annotated pods, at the annotated port and path', async () => {
    const c = await cluster('kubernetes');
    await pod(c, { name: 'orders-1', ip: '10.1.0.5', scrape: { by: 'watchlog' } });
    await pod(c, {
      name: 'orders-2',
      ip: '10.1.0.6',
      ports: [{ port: 8080 }, { name: 'metrics', port: 9102 }],
      scrape: { by: 'watchlog', port_name: 'metrics', path: '/stats' },
    });
    await pod(c, {
      name: 'cart-1',
      workload: 'cart',
      ip: '10.1.0.7',
      scrape: { by: 'watchlog', port: 9000 },
    });
    // Not annotated, not running, annotated for Prometheus only: none is scraped.
    await pod(c, { name: 'plain-1', workload: 'plain', ip: '10.1.0.8' });
    await pod(c, {
      name: 'gone-1',
      workload: 'gone',
      ip: '10.1.0.9',
      phase: 'Pending',
      scrape: { by: 'watchlog' },
    });
    await pod(c, {
      name: 'prom-1',
      workload: 'prom',
      ip: '10.1.0.10',
      scrape: { by: 'prometheus', port: 9100 },
    });
    const s = await section(c);
    expect(s!.interval_s).toBe(30);
    expect(s!.targets.map((t) => t.url).sort()).toEqual([
      'http://10.1.0.5:8080/metrics',
      'http://10.1.0.6:9102/stats',
      'http://10.1.0.7:9000/metrics',
    ]);
  });

  it('honours prometheus.io/scrape only with the cluster’s setting on', async () => {
    const c = await cluster('kubernetes');
    await pod(c, {
      name: 'prom-1',
      workload: 'prom',
      ip: '10.1.0.10',
      scrape: { by: 'prometheus', port: 9100 },
    });
    expect(await section(c)).toBeUndefined();
    expect((await summary(c)).settings.prometheusAnnotations).toBe(false);
    const put = await api('PUT', `/clusters/${c.id}/own-metrics/settings`, {
      prometheusAnnotations: true,
    });
    expect(put.statusCode).toBe(200);
    expect((await section(c))!.targets.map((t) => t.url)).toEqual([
      'http://10.1.0.10:9100/metrics',
    ]);
    expect((await summary(c)).settings.prometheusAnnotations).toBe(true);
  });

  it('stores a scrape under the pod’s workload, apart from WatchLog’s own, and lists the source', async () => {
    const c = await cluster('kubernetes');
    await pod(c, { name: 'orders-1', scrape: { by: 'watchlog' } });
    const [t] = (await section(c))!.targets;
    const res = await report(c, {
      at: Date.now(),
      host: '',
      targets: [
        {
          id: t!.id,
          series: [
            { n: 'orders_created_total', l: { method: 'card' }, v: 12 },
            { n: 'orders_created_total', l: { method: 'cash' }, v: 3 },
            { n: 'checkout_duration_seconds_bucket', l: { le: '0.5' }, v: 9 },
            { n: 'checkout_duration_seconds_bucket', l: { le: '+Inf' }, v: 10 },
            { n: 'checkout_duration_seconds_sum', v: 4.2 },
            { n: 'checkout_duration_seconds_count', v: 10 },
            { n: 'backup_last_success_timestamp_seconds', v: 1_700_000_000 },
            { n: 'go_goroutines', v: 31 },
            { n: 'watchlog_container_cpu_usage', v: 99 },
            { n: 'bad name', v: 1 },
          ],
          types: {
            orders_created_total: 'counter',
            checkout_duration_seconds: 'histogram',
            backup_last_success_timestamp_seconds: 'gauge',
            go_goroutines: 'gauge',
          },
          help: { orders_created_total: 'Orders created.' },
        },
        // An id this collector was never handed is ignored.
        { id: 'p|x|Deployment|other|other-1|80|/metrics', series: [{ n: 'stolen_total', v: 1 }] },
      ],
    });
    expect(res.statusCode).toBe(204);

    const orders = await stored(c, 'orders_created_total');
    expect(orders).toHaveLength(2);
    const card = orders.find((o) => o.labels.method === 'card')!;
    expect(card.last).toBe(12);
    expect(card.labels).toMatchObject({
      wl_ns: 'shop',
      wl_wkind: 'Deployment',
      wl_workload: 'orders',
      pod: 'orders-1',
    });
    expect(card.labels.wl_own).toMatch(/^[0-9a-f-]{36}$/);
    // The reserved name never reaches the store, and neither does another endpoint's.
    expect(await stored(c, 'watchlog_container_cpu_usage')).toEqual([]);
    expect(await stored(c, 'stolen_total')).toEqual([]);

    const s = await summary(c);
    expect(s.usage).toEqual({ series: 8, sources: 1 });
    expect(s.limits).toMatchObject({ series: 20_000, seriesPerSource: 500, sources: null });
    expect(s.metrics).toBe(3);
    expect(s.hidden).toBe(1);
    expect(s.sources).toHaveLength(1);
    expect(s.sources[0]).toMatchObject({
      kind: 'scrape_pod',
      label: 'orders :8080/metrics',
      owner: { kind: 'workload', namespace: 'shop', workloadKind: 'Deployment', name: 'orders' },
      series: 8,
      error: null,
      refused: false,
      by: 'watchlog',
      removable: false,
      dropped: { reserved: 1, invalid: 1, cardinality: [], sourceCap: 0, orgCap: 0 },
    });
    expect(s.sources[0].lastReportedAt).toBeGreaterThan(Date.now() - 60_000);

    const metrics = await ctx.db
      .selectFrom('own_metrics')
      .select(['name', 'type', 'hidden', 'help'])
      .orderBy('name')
      .execute();
    expect(metrics).toEqual([
      { name: 'backup_last_success_timestamp_seconds', type: 'timestamp', hidden: false, help: '' },
      { name: 'checkout_duration_seconds', type: 'histogram', hidden: false, help: '' },
      { name: 'go_goroutines', type: 'gauge', hidden: true, help: '' },
      { name: 'orders_created_total', type: 'counter', hidden: false, help: 'Orders created.' },
    ]);
  });

  it('a failed scrape says why and keeps the endpoint’s series', async () => {
    const c = await cluster('kubernetes');
    await pod(c, { name: 'orders-1', scrape: { by: 'watchlog' } });
    const [t] = (await section(c))!.targets;
    await report(c, {
      at: Date.now(),
      targets: [{ id: t!.id, series: [{ n: 'jobs_waiting', v: 4 }] }],
    });
    await report(c, {
      at: Date.now(),
      targets: [{ id: t!.id, error: 'connection refused', series: [] }],
    });
    const s = await summary(c);
    expect(s.sources[0]).toMatchObject({ error: 'connection refused', series: 1 });
  });

  it('scrapes a workload’s port added in the panel, with no annotation; removes it again', async () => {
    const c = await cluster('kubernetes');
    await pod(c, { name: 'cart-1', workload: 'cart', ip: '10.1.0.7' });
    await pod(c, { name: 'cart-2', workload: 'cart', ip: '10.1.0.8' });
    await pod(c, { name: 'orders-1', ip: '10.1.0.5', scrape: { by: 'watchlog' } });
    expect((await section(c))!.targets).toHaveLength(1);
    const add = await api('POST', `/clusters/${c.id}/own-metrics/sources`, {
      namespace: 'shop',
      workloadKind: 'Deployment',
      workload: 'cart',
      port: 9102,
    });
    expect(add.statusCode).toBe(201);
    expect((await section(c))!.targets.map((t) => t.url).sort()).toEqual([
      'http://10.1.0.5:8080/metrics',
      'http://10.1.0.7:9102/metrics',
      'http://10.1.0.8:9102/metrics',
    ]);
    const again = await api('POST', `/clusters/${c.id}/own-metrics/sources`, {
      namespace: 'shop',
      workloadKind: 'Deployment',
      workload: 'cart',
      port: 9102,
    });
    expect(again.statusCode).toBe(409);
    // An address is a fleet's.
    const address = await api('POST', `/clusters/${c.id}/own-metrics/sources`, {
      server: 'db-1',
      address: 'localhost:9400',
    });
    expect(address.statusCode).toBe(400);

    // An annotated endpoint is removed by its annotation, a panel one here.
    const orders = (await section(c))!.targets.find((t) => t.url.includes('10.1.0.5'))!;
    await report(c, {
      at: Date.now(),
      targets: [{ id: orders.id, series: [{ n: 'jobs_waiting', v: 1 }] }],
    });
    const s = await summary(c);
    const annotated = s.sources.find((x: { by: string }) => x.by === 'watchlog');
    const panel = s.sources.find((x: { by: string }) => x.by === 'panel');
    expect(panel).toMatchObject({ removable: true, label: 'cart :9102/metrics' });
    const no = await api('DELETE', `/clusters/${c.id}/own-metrics/sources/${annotated.id}`);
    expect(no.statusCode).toBe(400);
    expect(no.json().detail).toMatch(/annotation/);
    const yes = await api('DELETE', `/clusters/${c.id}/own-metrics/sources/${panel.id}`);
    expect(yes.statusCode).toBe(204);
    expect((await section(c))!.targets).toHaveLength(1);
  });

  it('finds endpoints: asks the collector about declared ports, lists what answered', async () => {
    const c = await cluster('kubernetes');
    await pod(c, {
      name: 'cart-1',
      workload: 'cart',
      ip: '10.1.0.7',
      ports: [
        { name: 'http', port: 8080 },
        { name: 'metrics', port: 9102 },
      ],
    });
    await pod(c, { name: 'cart-2', workload: 'cart', ip: '10.1.0.8', ports: [{ port: 8080 }] });
    expect((await api('GET', `/clusters/${c.id}/own-metrics/find`)).statusCode).toBe(404);
    const started = await api('POST', `/clusters/${c.id}/own-metrics/find`);
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ done: false, asked: 2, found: [] });
    const s = await section(c);
    // One pod of a workload answers for all of them.
    expect(s!.probe!.candidates.map((x) => x.url).sort()).toEqual([
      'http://10.1.0.7:8080/metrics',
      'http://10.1.0.7:9102/metrics',
    ]);
    const answer = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/own-metrics/probe',
      headers: { authorization: `Bearer ${c.token}`, ...collector },
      payload: {
        id: s!.probe!.id,
        host: '',
        results: s!.probe!.candidates.map((x) => ({
          id: x.id,
          ok: x.url.includes(':9102'),
          series: x.url.includes(':9102') ? 42 : 0,
          names: x.url.includes(':9102') ? ['orders_created_total'] : [],
        })),
      },
    });
    expect(answer.statusCode).toBe(204);
    const found = (await api('GET', `/clusters/${c.id}/own-metrics/find`)).json();
    expect(found.done).toBe(true);
    expect(found.found).toEqual([
      {
        series: 42,
        names: ['orders_created_total'],
        add: {
          kind: 'pod',
          namespace: 'shop',
          workloadKind: 'Deployment',
          workload: 'cart',
          port: 9102,
        },
      },
    ]);
    // Answered: the collector isn't asked again.
    expect((await section(c))?.probe).toBeUndefined();
  });
});

describe('scraping on a Server fleet', () => {
  beforeEach(() => start());

  it('scrapes an address added for one server, on that server’s collector only', async () => {
    const c = await cluster('server');
    await server(c, 'db-1');
    await server(c, 'web-1');
    const bad = await api('POST', `/clusters/${c.id}/own-metrics/sources`, {
      server: 'db-1',
      address: 'http://user:pw@localhost:9400/metrics',
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await api('POST', `/clusters/${c.id}/own-metrics/sources`, {
      server: 'nope',
      address: 'localhost:9400',
    });
    expect(unknown.statusCode).toBe(400);
    const add = await api('POST', `/clusters/${c.id}/own-metrics/sources`, {
      server: 'db-1',
      address: 'localhost:9400/metrics',
    });
    expect(add.statusCode).toBe(201);
    expect(await section(c, 'web-1')).toBeUndefined();
    const s = await section(c, 'db-1');
    expect(s!.targets).toEqual([
      { id: `a|${add.json().id}`, url: 'http://localhost:9400/metrics' },
    ]);

    const res = await report(c, {
      at: Date.now(),
      host: 'db-1',
      targets: [
        { id: s!.targets[0]!.id, series: [{ n: 'jobs_waiting', l: { queue: 'mail' }, v: 17 }] },
      ],
    });
    expect(res.statusCode).toBe(204);
    // Another server's collector can't report for it.
    await report(c, {
      at: Date.now(),
      host: 'web-1',
      targets: [{ id: s!.targets[0]!.id, series: [{ n: 'forged_total', v: 1 }] }],
    });
    expect(await stored(c, 'forged_total')).toEqual([]);
    const jobs = await stored(c, 'jobs_waiting');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.labels).toMatchObject({
      queue: 'mail',
      wl_server: 'db-1',
      instance: 'localhost:9400',
      wl_own: add.json().id,
    });
    expect(jobs[0]!.last).toBe(17);

    const sum = await summary(c);
    expect(sum.kind).toBe('server');
    expect(sum.servers).toEqual(['db-1', 'web-1']);
    expect(sum.sources[0]).toMatchObject({
      kind: 'scrape_address',
      owner: { kind: 'server', name: 'db-1' },
      series: 1,
      removable: true,
      by: 'panel',
    });
    // A fleet has no annotations to honour.
    const put = await api('PUT', `/clusters/${c.id}/own-metrics/settings`, {
      prometheusAnnotations: true,
    });
    expect(put.statusCode).toBe(400);
    const del = await api('DELETE', `/clusters/${c.id}/own-metrics/sources/${add.json().id}`);
    expect(del.statusCode).toBe(204);
    expect(await section(c, 'db-1')).toBeUndefined();
  });
});

describe('the write-only token', () => {
  beforeEach(() => start());

  it('is shown once, sends own metrics only, and stops when revoked', async () => {
    const c = await cluster('kubernetes');
    const t = await token(c);
    expect(t.value).toMatch(/^wl_mt_/);
    const s = await summary(c);
    expect(s.tokens).toEqual([
      {
        id: t.id,
        name: 'ci and cron',
        prefix: t.prefix,
        createdAt: expect.any(Number),
        lastUsedAt: null,
      },
    ]);
    expect(JSON.stringify(s)).not.toContain(t.value);
    const row = await ctx.db.selectFrom('own_metric_tokens').selectAll().executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(t.value);
    expect(
      (await api('POST', `/clusters/${c.id}/own-metrics/tokens`, { name: 'ci and cron' }))
        .statusCode,
    ).toBe(409);

    // Nothing but own metrics: no inventory, no events, no collector configuration.
    for (const [method, url] of [
      ['POST', '/ingest/v1/objects'],
      ['POST', '/ingest/v1/heartbeat'],
      ['GET', '/ingest/v1/integrations/config'],
      ['POST', '/ingest/v1/own-metrics/scrape'],
    ] as const) {
      const res = await ctx.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${t.value}` },
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      expect(res.statusCode, url).toBe(403);
    }
    // And never the API.
    const apiRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/clusters/${c.id}/own-metrics`,
      headers: { authorization: `Bearer ${t.value}` },
    });
    expect(apiRes.statusCode).toBe(401);
    // A cluster token doesn't push.
    expect((await push(c.token, { name: 'jobs_waiting', value: 1 })).statusCode).toBe(403);
    expect(
      (await push('wl_mt_' + 'x'.repeat(t.value.length - 6), { name: 'a', value: 1 })).statusCode,
    ).toBe(401);

    expect((await push(t.value, { name: 'jobs_waiting', value: 1 })).statusCode).toBe(200);
    const del = await api('DELETE', `/clusters/${c.id}/own-metrics/tokens/${t.id}`);
    expect(del.statusCode).toBe(204);
    expect((await push(t.value, { name: 'jobs_waiting', value: 2 })).statusCode).toBe(401);
    // Its source went with it.
    expect((await summary(c)).sources).toEqual([]);
  });

  it('only Owners and Admins make tokens and sources; a Viewer reads', async () => {
    const c = await cluster('kubernetes');
    const viewer = await createUserSession(ctx.db, { role: 'viewer', orgId: c.orgId });
    expect(
      (await api('GET', `/clusters/${c.id}/own-metrics`, undefined, viewer.cookie)).statusCode,
    ).toBe(200);
    expect(
      (await api('POST', `/clusters/${c.id}/own-metrics/tokens`, { name: 'x' }, viewer.cookie))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await api(
          'POST',
          `/clusters/${c.id}/own-metrics/sources`,
          { namespace: 'a', workloadKind: 'Deployment', workload: 'b', port: 80 },
          viewer.cookie,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await api('POST', `/clusters/${c.id}/own-metrics/find`, undefined, viewer.cookie))
        .statusCode,
    ).toBe(403);
    // Another org's user gets 404 for the cluster.
    const other = await createUserSession(ctx.db, { role: 'owner' });
    expect(
      (await api('GET', `/clusters/${c.id}/own-metrics`, undefined, other.cookie)).statusCode,
    ).toBe(404);
  });

  it('is rate-limited per token, with Retry-After', async () => {
    await closeTestContext(ctx);
    await start({}, { ingestBuckets: { metricPush: { ratePerSec: 0.01, burst: 2 } } });
    const c = await cluster('kubernetes');
    const a = await token(c, 'a');
    const b = await token(c, 'b');
    expect((await push(a.value, { name: 'jobs_waiting', value: 1 })).statusCode).toBe(200);
    expect((await push(a.value, { name: 'jobs_waiting', value: 1 })).statusCode).toBe(200);
    const limited = await push(a.value, { name: 'jobs_waiting', value: 1 });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Another token has its own allowance.
    expect((await push(b.value, { name: 'jobs_waiting', value: 1 })).statusCode).toBe(200);
  });
});

describe('remote write', () => {
  beforeEach(() => start());

  it('ties series to the workload their namespace and pod labels name; the rest to nothing', async () => {
    const c = await cluster('kubernetes');
    await pod(c, { name: 'orders-1' });
    const t = await token(c, 'prometheus');
    const at = Date.now();
    const res = await remoteWrite(t.value, [
      {
        labels: {
          __name__: 'orders_created_total',
          namespace: 'shop',
          pod: 'orders-1',
          method: 'card',
        },
        value: 40,
        timestampMs: at,
      },
      {
        labels: { __name__: 'payment_failures_total', job: 'batch', cluster_id: 'spoofed' },
        value: 2,
        timestampMs: at,
      },
      { labels: { __name__: 'watchlog_node_cpu', node: 'n1' }, value: 1, timestampMs: at },
    ]);
    expect(res.statusCode).toBe(204);
    const [orders] = await stored(c, 'orders_created_total');
    expect(orders!.labels).toMatchObject({
      namespace: 'shop',
      pod: 'orders-1',
      method: 'card',
      wl_ns: 'shop',
      wl_wkind: 'Deployment',
      wl_workload: 'orders',
    });
    const [failures] = await stored(c, 'payment_failures_total');
    expect(failures!.labels).toMatchObject({ job: 'batch', exported_cluster_id: 'spoofed' });
    expect(failures!.labels.wl_workload).toBeUndefined();
    expect(await stored(c, 'watchlog_node_cpu')).toEqual([]);

    const s = await summary(c);
    expect(s.sources).toHaveLength(1);
    expect(s.sources[0]).toMatchObject({
      kind: 'remote_write',
      label: 'token "prometheus"',
      series: 2,
      by: 'token',
      removable: false,
      dropped: { reserved: 1 },
      owners: [{ kind: 'workload', namespace: 'shop', workloadKind: 'Deployment', name: 'orders' }],
    });
    expect(s.tokens[0].lastUsedAt).not.toBeNull();
  });

  it('on a fleet, ties series to the server their instance or host label names', async () => {
    const c = await cluster('server');
    await server(c, 'db-1');
    const t = await token(c);
    const at = Date.now();
    await remoteWrite(t.value, [
      {
        labels: { __name__: 'backup_size_bytes', instance: 'db-1:9100' },
        value: 5,
        timestampMs: at,
      },
      {
        labels: { __name__: 'backup_size_bytes', host: 'db-1', kind: 'full' },
        value: 6,
        timestampMs: at,
      },
      {
        labels: { __name__: 'backup_size_bytes', instance: 'elsewhere:9100' },
        value: 7,
        timestampMs: at,
      },
    ]);
    const rows = await stored(c, 'backup_size_bytes');
    expect(rows.map((r) => r.labels.wl_server ?? null).sort()).toEqual(
      ['db-1', 'db-1', null].sort(),
    );
  });

  it('refuses a body that isn’t remote write', async () => {
    const c = await cluster('kubernetes');
    const t = await token(c);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/write',
      headers: {
        authorization: `Bearer ${t.value}`,
        'content-type': 'application/x-protobuf',
        'content-encoding': 'snappy',
      },
      payload: Buffer.from([1, 2, 3, 4]),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('pushes', () => {
  beforeEach(() => start());

  it('a counter adds to its total, a gauge keeps the last value; each belongs where it says', async () => {
    const c = await cluster('kubernetes');
    await workload(c, 'shop', 'Deployment', 'orders');
    const t = await token(c);
    const first = await push(t.value, {
      workload: 'shop/orders',
      metrics: [
        { name: 'orders_created_total', value: 3, labels: { method: 'card' } },
        { name: 'jobs_waiting', type: 'gauge', value: 12 },
        { name: 'emails_sent', type: 'counter', value: 5, workload: 'shop/unknown' },
      ],
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ stored: 3, dropped: { reserved: 0, invalid: 0 } });
    await push(t.value, {
      workload: 'shop/orders',
      metrics: [
        { name: 'orders_created_total', value: 4, labels: { method: 'card' } },
        { name: 'jobs_waiting', type: 'gauge', value: 7 },
      ],
    });
    const [orders] = await stored(c, 'orders_created_total');
    expect(orders!.last).toBe(7);
    expect(orders!.labels).toMatchObject({
      wl_ns: 'shop',
      wl_wkind: 'Deployment',
      wl_workload: 'orders',
    });
    const [jobs] = await stored(c, 'jobs_waiting');
    expect(jobs!.last).toBe(7);
    const [emails] = await stored(c, 'emails_sent');
    expect(emails!.last).toBe(5);
    // A workload WatchLog doesn't know: stored, tied to nothing.
    expect(emails!.labels.wl_workload).toBeUndefined();
    const types = await ctx.db
      .selectFrom('own_metrics')
      .select(['name', 'type'])
      .orderBy('name')
      .execute();
    expect(types).toEqual([
      { name: 'emails_sent', type: 'counter' },
      { name: 'jobs_waiting', type: 'gauge' },
      { name: 'orders_created_total', type: 'counter' },
    ]);
    // The running total survives a restart of the backend (it is kept with the series).
    await ctx.app.ownMetrics.flush();
    await ctx.app.ownMetrics.forget(c.id);
    await push(t.value, {
      name: 'orders_created_total',
      value: 1,
      labels: { method: 'card' },
      workload: 'shop/orders',
    });
    expect((await stored(c, 'orders_created_total'))[0]!.last).toBe(8);
  });

  it('on a fleet, belongs to the server it names; a timestamp is read from its name', async () => {
    const c = await cluster('server');
    await server(c, 'db-1');
    const t = await token(c, 'backup script');
    const res = await push(t.value, {
      name: 'backup_last_success_timestamp_seconds',
      value: 1_790_000_000,
      server: 'db-1',
    });
    expect(res.statusCode).toBe(200);
    const [row] = await stored(c, 'backup_last_success_timestamp_seconds');
    expect(row!.labels.wl_server).toBe('db-1');
    expect(row!.last).toBe(1_790_000_000);
    const m = await ctx.db.selectFrom('own_metrics').select(['type']).executeTakeFirstOrThrow();
    expect(m.type).toBe('timestamp');
    const s = await summary(c);
    expect(s.sources[0]).toMatchObject({
      kind: 'push',
      label: 'token "backup script"',
      owners: [{ kind: 'server', name: 'db-1' }],
    });
  });

  it('says what it dropped and why: reserved names, bad names', async () => {
    const c = await cluster('kubernetes');
    const t = await token(c);
    const res = await push(t.value, {
      metrics: [
        { name: 'watchlog_fake', value: 1 },
        { name: 'has-dash', value: 1 },
        { name: 'ok_total', value: 1 },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 1, dropped: { reserved: 1, invalid: 1 } });
    expect((await push(t.value, { name: 'x', value: 'nope' })).statusCode).toBe(400);
  });

  it('refuses a metric whose label has too many values, and names the label', async () => {
    const c = await cluster('kubernetes');
    const t = await token(c);
    const metrics = Array.from({ length: 101 }, (_, i) => ({
      name: 'logins_total',
      value: 1,
      labels: { user_id: `u${i}`, region: 'eu' },
    }));
    const res = await push(t.value, { metrics: [...metrics, { name: 'jobs_waiting', value: 3 }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().dropped.cardinality).toEqual([{ metric: 'logins_total', label: 'user_id' }]);
    // The metric stays refused; the others keep flowing.
    const again = await push(t.value, {
      metrics: [
        { name: 'logins_total', value: 1, labels: { user_id: 'u1', region: 'eu' } },
        { name: 'jobs_waiting', value: 4 },
      ],
    });
    expect(again.json()).toMatchObject({
      stored: 1,
      dropped: { cardinality: [{ metric: 'logins_total', label: 'user_id' }] },
    });
    const s = await summary(c);
    expect(s.sources[0].dropped.cardinality).toEqual([
      { metric: 'logins_total', label: 'user_id' },
    ]);
    const m = await ctx.db
      .selectFrom('own_metrics')
      .select(['refused'])
      .where('name', '=', 'logins_total')
      .executeTakeFirstOrThrow();
    expect(m.refused).toEqual({ label: 'user_id' });
  });
});

describe('the caps', () => {
  it('the installation’s cap: new series are refused, known ones keep flowing', async () => {
    await start({ ownMetricSeries: 5 });
    const c = await cluster('kubernetes');
    const t = await token(c);
    const seven = Array.from({ length: 7 }, (_, i) => ({
      name: 'queue_depth',
      value: i,
      labels: { queue: `q${i}` },
    }));
    const first = await push(t.value, { metrics: seven });
    expect(first.json()).toMatchObject({ stored: 5, dropped: { orgCap: 2, sourceCap: 0 } });
    const second = await push(t.value, {
      metrics: seven.map((m) => ({ ...m, value: m.value + 10 })),
    });
    expect(second.json()).toMatchObject({ stored: 5, dropped: { orgCap: 2 } });
    const rows = await stored(c, 'queue_depth');
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.last).sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14]);
    const s = await summary(c);
    expect(s.usage.series).toBe(5);
    expect(s.limits.series).toBe(5);
    expect(s.sources[0].dropped.orgCap).toBe(2);
    // WatchLog's own monitoring is never affected: the cluster's remote write still stores.
    const own = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/write',
      headers: {
        authorization: `Bearer ${c.token}`,
        'content-type': 'application/x-protobuf',
        'content-encoding': 'snappy',
        'x-watchlog-agent': 'node-1',
      },
      payload: encode([
        {
          labels: { __name__: 'watchlog_node_cpu_usage_cores', node: 'n1' },
          value: 1,
          timestampMs: Date.now(),
        },
      ]),
    });
    expect(own.statusCode).toBe(204);
  });

  describe('per source and per plan (the service, with a plan’s limits)', () => {
    let c: Cluster;
    let limits: OwnMetricLimits;
    let own: OwnMetrics;
    const src = (key: string): SourceRef => ({
      kind: 'push',
      key,
      label: key,
      owner: { kind: '', namespace: '', workloadKind: '', name: '' },
    });
    /** `n` series of 50 a metric, so no label has too many values. */
    const series = (name: string, n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => ({
        name: `${name}_${Math.floor((from + i) / 50)}`,
        labels: { shard: `s${from + i}` },
        samples: [[Date.now(), 1]] as [number, number][],
      }));

    beforeEach(async () => {
      await start();
      c = await cluster('kubernetes');
      limits = ownMetricLimits({ edition: 'cloud', plan: 'free', pro: false });
      own = new OwnMetrics({
        db: ctx.db,
        victoria: null,
        limits: async () => limits,
        log: ctx.app.log,
      });
    });

    it('Cloud Free: 100 series from one source, 200 in the org, 3 sources', async () => {
      const a = await own.ingest({
        orgId: c.orgId,
        clusterId: c.id,
        source: src('a'),
        series: [...series('m_a', 60), ...series('n_a', 60)],
      });
      expect(a).toMatchObject({
        stored: 100,
        sourceSeries: 100,
        dropped: { sourceCap: 20, orgCap: 0 },
      });
      const b = await own.ingest({
        orgId: c.orgId,
        clusterId: c.id,
        source: src('b'),
        series: [...series('m_b', 50), ...series('n_b', 40)],
      });
      expect(b).toMatchObject({ stored: 90, dropped: { sourceCap: 0, orgCap: 0 } });
      const third = await own.ingest({
        orgId: c.orgId,
        clusterId: c.id,
        source: src('c'),
        series: series('m_c', 30),
      });
      // 190 in use: 10 more fit, 20 are over the org's 200.
      expect(third).toMatchObject({ stored: 10, dropped: { orgCap: 20, sourceCap: 0 } });
      const fourth = await own.ingest({
        orgId: c.orgId,
        clusterId: c.id,
        source: src('d'),
        series: series('m_d', 1),
      });
      expect(fourth).toMatchObject({ stored: 0, dropped: { sources: true } });
      const usage = await own.usage(c.orgId);
      expect(usage).toMatchObject({ series: 200, sources: 3 });
      await own.flush();
      const rows = await ctx.db
        .selectFrom('own_sources')
        .select(['key', 'series', 'refused'])
        .orderBy('key')
        .execute();
      expect(rows).toEqual([
        { key: 'a', series: 100, refused: false },
        { key: 'b', series: 90, refused: false },
        { key: 'c', series: 10, refused: false },
        { key: 'd', series: 0, refused: true },
      ]);
    });

    it('the org’s cap counts every cluster and fleet of the org', async () => {
      const fleet = await cluster('server', 'fleet');
      await own.ingest({
        orgId: c.orgId,
        clusterId: c.id,
        source: src('a'),
        series: series('m_a', 100),
      });
      await own.ingest({
        orgId: c.orgId,
        clusterId: c.id,
        source: src('b'),
        series: series('m_b', 90),
      });
      const other = await own.ingest({
        orgId: c.orgId,
        clusterId: fleet.id,
        source: src('c'),
        series: series('m_c', 30),
      });
      expect(other).toMatchObject({ stored: 10, dropped: { orgCap: 20 } });
    });

    it('an upgrade lifts the caps at once; a downgrade keeps what is known and refuses the new', async () => {
      await own.ingest({
        orgId: c.orgId,
        clusterId: c.id,
        source: src('a'),
        series: series('m_a', 120),
      });
      limits = ownMetricLimits({ edition: 'cloud', plan: 'pro', pro: true, billedNodes: 6 });
      const up = await own.ingest({
        orgId: c.orgId,
        clusterId: c.id,
        source: src('a'),
        series: series('m_a', 120),
      });
      expect(up).toMatchObject({ stored: 120, dropped: { sourceCap: 0 } });
      limits = ownMetricLimits({ edition: 'cloud', plan: 'free', pro: false });
      const down = await own.ingest({
        orgId: c.orgId,
        clusterId: c.id,
        source: src('a'),
        series: series('m_a', 125),
      });
      // The 120 known keep flowing; the 5 new ones are refused.
      expect(down).toMatchObject({ stored: 120, dropped: { sourceCap: 5 } });
    });

    it('a label’s values are counted among the active series: pods that came and went don’t refuse a metric', async () => {
      let now = Date.now();
      limits = ownMetricLimits({ edition: 'community', pro: false });
      own = new OwnMetrics({
        db: ctx.db,
        victoria: null,
        limits: async () => limits,
        log: ctx.app.log,
        now: () => now,
      });
      const pods = (from: number, n: number) =>
        Array.from({ length: n }, (_, i) => ({
          name: 'requests_total',
          labels: { pod: `web-${from + i}` },
          samples: [[now, 1]] as [number, number][],
        }));
      const input = { orgId: c.orgId, clusterId: c.id, source: src('prom') };
      expect(await own.ingest({ ...input, series: pods(0, 100) })).toMatchObject({ stored: 100 });
      now += 61 * 60_000;
      await own.flush();
      // A day later the pods have other names: still 100 at once, so still fine.
      const later = await own.ingest({ ...input, series: pods(100, 100) });
      expect(later).toMatchObject({ stored: 100, dropped: { cardinality: [] } });
      // One more at the same time is one too many.
      const over = await own.ingest({ ...input, series: pods(200, 1) });
      expect(over.dropped.cardinality).toEqual([{ metric: 'requests_total', label: 'pod' }]);
    });

    it('a series not seen for an hour stops counting', async () => {
      let now = Date.now();
      own = new OwnMetrics({
        db: ctx.db,
        victoria: null,
        limits: async () => limits,
        log: ctx.app.log,
        now: () => now,
      });
      await own.ingest({
        orgId: c.orgId,
        clusterId: c.id,
        source: src('a'),
        series: series('m_a', 100),
      });
      expect((await own.usage(c.orgId)).series).toBe(100);
      now += 61 * 60_000;
      await own.flush();
      expect((await own.usage(c.orgId)).series).toBe(0);
      const next = await own.ingest({
        orgId: c.orgId,
        clusterId: c.id,
        source: src('a'),
        series: series('m_a', 100, 100),
      });
      expect(next).toMatchObject({ stored: 100, dropped: { sourceCap: 0 } });
    });
  });
});

describe('reading: the list, a metric, its line, corrections and pins', () => {
  // VictoriaMetrics answers a little behind (30 s by default, 5 s as WatchLog runs it), so a
  // value written this second is not in a query yet: the app's clock runs a minute behind
  // here, and the scrapes below end a minute ago.
  const BEHIND = 60_000;
  beforeEach(() => start({}, { now: () => Date.now() - BEHIND }));

  /** Six scrapes of one pod, 30 s apart, ending a minute ago. */
  async function scraped() {
    const c = await cluster('kubernetes');
    await pod(c, { name: 'orders-1', scrape: { by: 'watchlog' } });
    const [t] = (await section(c))!.targets;
    const now = Date.now() - BEHIND;
    const methods = ['card', 'cash', 'paypal', 'stripe', 'wire', 'gift', 'crypto'];
    for (let i = 5; i >= 0; i--) {
      const k = 5 - i;
      const res = await report(c, {
        at: now - i * 30_000,
        targets: [
          {
            id: t!.id,
            series: [
              // 6 a minute for card, less for each next method.
              ...methods.map((method, j) => ({
                n: 'orders_created_total',
                l: { method },
                v: 100 + k * (methods.length - j) * 0.5,
              })),
              { n: 'jobs_waiting', l: { queue: 'mail' }, v: 12 },
              { n: 'jobs_waiting', l: { queue: 'invoices' }, v: 30 },
              { n: 'cache_hit_ratio', l: { cache: 'a' }, v: 0.5 },
              { n: 'cache_hit_ratio', l: { cache: 'b' }, v: 0.9 },
              // Every request under 0.5 s, 2 a scrape.
              { n: 'checkout_duration_seconds_bucket', l: { le: '0.25' }, v: 0 },
              { n: 'checkout_duration_seconds_bucket', l: { le: '0.5' }, v: k * 2 },
              { n: 'checkout_duration_seconds_bucket', l: { le: '+Inf' }, v: k * 2 },
              { n: 'checkout_duration_seconds_sum', v: k * 0.8 },
              { n: 'checkout_duration_seconds_count', v: k * 2 },
              { n: 'backup_last_success_timestamp_seconds', v: Math.floor(now / 1000) - 7200 },
              { n: 'go_goroutines', v: 31 },
            ],
            types: { orders_created_total: 'counter', checkout_duration_seconds: 'histogram' },
          },
        ],
      });
      expect(res.statusCode).toBe(204);
    }
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    return c;
  }

  const list = async (c: Cluster, query = '') => {
    const res = await api('GET', `/clusters/${c.id}/own-metrics/metrics${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      hidden: number;
      metrics: {
        id: string;
        name: string;
        words: string;
        type: string;
        unit: string;
        shown: string;
        value: number | null;
        series: number;
        labels: string[];
        hidden: boolean;
        pushed: boolean;
        untied: boolean;
        owners: { kind: string; name: string }[];
        sources: { label: string; kind: string }[];
        refused: { label: string } | null;
      }[];
    };
  };

  it('lists each metric with its type, where it comes from and its value now', async () => {
    const c = await scraped();
    const l = await list(c);
    expect(l.hidden).toBe(1);
    expect(l.metrics.map((m) => m.name)).toEqual([
      'backup_last_success_timestamp_seconds',
      'cache_hit_ratio',
      'checkout_duration_seconds',
      'jobs_waiting',
      'orders_created_total',
    ]);
    const by = Object.fromEntries(l.metrics.map((m) => [m.name, m]));
    expect(by.orders_created_total).toMatchObject({
      words: 'Orders created',
      type: 'counter',
      unit: 'count',
      shown: 'rate',
      series: 7,
      labels: ['method'],
      pushed: false,
      untied: false,
      owners: [{ kind: 'workload', name: 'orders' }],
      sources: [{ label: 'orders :8080/metrics', kind: 'scrape_pod' }],
    });
    // 0.5 × (7+6+…+1) = 14 more every 30 s.
    expect(by.orders_created_total!.value!).toBeCloseTo(14 / 30, 1);
    // A count is summed over its series, a ratio averaged.
    expect(by.jobs_waiting).toMatchObject({ type: 'gauge', shown: 'as_is', value: 42 });
    expect(by.cache_hit_ratio).toMatchObject({ unit: 'ratio', value: 0.7 });
    expect(by.checkout_duration_seconds).toMatchObject({
      type: 'histogram',
      unit: 'seconds',
      shown: 'p95',
      series: 5,
    });
    expect(by.checkout_duration_seconds!.value!).toBeGreaterThan(0.25);
    expect(by.checkout_duration_seconds!.value!).toBeLessThanOrEqual(0.5);
    expect(by.backup_last_success_timestamp_seconds).toMatchObject({
      type: 'timestamp',
      unit: 'seconds',
      shown: 'time_since',
    });
    // Two hours before the last scrape, read up to a minute after it.
    expect(by.backup_last_success_timestamp_seconds!.value!).toBeGreaterThan(7190);
    expect(by.backup_last_success_timestamp_seconds!.value!).toBeLessThan(7300);

    // The list's small lines: the last hour in 12 points, asked for with the list.
    expect('spark' in l.metrics[0]!).toBe(false);
    const withSparks = (
      await api('GET', `/clusters/${c.id}/own-metrics/metrics?spark=true`)
    ).json();
    const spark = withSparks.metrics.find((m: { name: string }) => m.name === 'jobs_waiting').spark;
    expect(spark).toHaveLength(12);
    expect(spark.filter((v: number | null) => v !== null).every((v: number) => v === 42)).toBe(
      true,
    );

    const all = await list(c, '?all=true');
    expect(all.hidden).toBe(0);
    expect(all.metrics.find((m) => m.name === 'go_goroutines')).toMatchObject({
      hidden: true,
      value: 31,
    });
    // Narrowed to a page's owner; another workload has none.
    const own = await list(
      c,
      '?ownerKind=workload&namespace=shop&workloadKind=Deployment&owner=orders',
    );
    expect(own.metrics).toHaveLength(5);
    const none = await list(
      c,
      '?ownerKind=workload&namespace=shop&workloadKind=Deployment&owner=cart',
    );
    expect(none.metrics).toEqual([]);
    expect(
      (await api('GET', `/clusters/${c.id}/own-metrics/metrics?ownerKind=workload`)).statusCode,
    ).toBe(400);
  });

  it('a metric’s page: its labels, a histogram’s other quantiles, where it is pinned', async () => {
    const c = await scraped();
    const l = await list(c);
    const orders = l.metrics.find((m) => m.name === 'orders_created_total')!;
    const res = await api('GET', `/clusters/${c.id}/own-metrics/metrics/${orders.id}`);
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.metric).toMatchObject({ name: 'orders_created_total', series: 7 });
    expect(d.labels).toEqual([
      { name: 'method', values: 7, top: ['card', 'cash', 'crypto', 'gift', 'paypal'] },
      { name: 'pod', values: 1, top: ['orders-1'] },
    ]);
    expect(d.usedIn).toEqual({ pins: [], dashboards: [] });
    expect(d.p50).toBeNull();
    const checkout = l.metrics.find((m) => m.name === 'checkout_duration_seconds')!;
    const h = (await api('GET', `/clusters/${c.id}/own-metrics/metrics/${checkout.id}`)).json();
    expect(h.p50).toBeGreaterThan(0.25);
    expect(h.p99).toBeLessThanOrEqual(0.5);
    expect(h.p99).toBeGreaterThanOrEqual(h.p50);
    expect((await api('GET', `/clusters/${c.id}/own-metrics/metrics/${newId()}`)).statusCode).toBe(
      404,
    );
  });

  it('a metric’s line over a range; split by a label: the top 5 and the rest as one', async () => {
    const c = await scraped();
    const l = await list(c);
    const orders = l.metrics.find((m) => m.name === 'orders_created_total')!;
    const to = Math.floor((Date.now() - BEHIND) / 1000);
    const range = `from=${to - 900}&to=${to}&step=30`;
    const plain = await api(
      'GET',
      `/clusters/${c.id}/own-metrics/metrics/${orders.id}/series?${range}`,
    );
    expect(plain.statusCode, plain.body).toBe(200);
    const p = plain.json();
    expect(p).toMatchObject({ step: 30, unit: 'count', shown: 'rate', values: 0 });
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toMatchObject({ value: null, other: false });
    expect(p.lines[0].points.at(-1)[1]).toBeCloseTo(14 / 30, 1);

    const split = (
      await api(
        'GET',
        `/clusters/${c.id}/own-metrics/metrics/${orders.id}/series?${range}&by=method`,
      )
    ).json();
    expect(split.values).toBe(7);
    expect(split.lines.map((x: { value: string | null }) => x.value)).toEqual([
      'card',
      'cash',
      'paypal',
      'stripe',
      'wire',
      null,
    ]);
    expect(split.lines[5].other).toBe(true);
    // The rest (gift and crypto) as one line: 0.5 × (2+1) every 30 s.
    expect(split.lines[5].points.at(-1)[1]).toBeCloseTo(1.5 / 30, 2);
    expect(split.lines[0].points.at(-1)[1]).toBeCloseTo(3.5 / 30, 2);

    // A histogram's quantile, and its line for one owner.
    const checkout = l.metrics.find((m) => m.name === 'checkout_duration_seconds')!;
    const q = (
      await api(
        'GET',
        `/clusters/${c.id}/own-metrics/metrics/${checkout.id}/series?${range}&stat=p50&ownerKind=workload&namespace=shop&workloadKind=Deployment&owner=orders`,
      )
    ).json();
    expect(q).toMatchObject({ unit: 'seconds', shown: 'p95' });
    expect(q.lines[0].points.at(-1)[1]).toBeGreaterThan(0.25);
    const elsewhere = (
      await api(
        'GET',
        `/clusters/${c.id}/own-metrics/metrics/${checkout.id}/series?${range}&ownerKind=workload&namespace=shop&workloadKind=Deployment&owner=cart`,
      )
    ).json();
    expect(elsewhere.lines).toEqual([]);

    for (const bad of ['by=le', 'by=wl_own', 'by=cluster_id', 'by=bad-name']) {
      const res = await api(
        'GET',
        `/clusters/${c.id}/own-metrics/metrics/${orders.id}/series?${range}&${bad}`,
      );
      expect(res.statusCode, bad).toBe(400);
    }
    const backwards = await api(
      'GET',
      `/clusters/${c.id}/own-metrics/metrics/${orders.id}/series?from=${to}&to=${to - 60}`,
    );
    expect(backwards.statusCode).toBe(400);
  });

  it('a type or a unit can be corrected, and the correction survives the next report', async () => {
    const c = await cluster('kubernetes');
    const t = await token(c);
    await push(t.value, { name: 'queue_depth', type: 'gauge', value: 5 });
    const [m] = (await list(c)).metrics;
    expect(m).toMatchObject({
      type: 'gauge',
      unit: 'count',
      shown: 'as_is',
      pushed: true,
      untied: true,
    });
    const viewer = await createUserSession(ctx.db, { role: 'viewer', orgId: c.orgId });
    const no = await api(
      'PATCH',
      `/clusters/${c.id}/own-metrics/metrics/${m!.id}`,
      { type: 'counter' },
      viewer.cookie,
    );
    expect(no.statusCode).toBe(403);
    const fixed = await api('PATCH', `/clusters/${c.id}/own-metrics/metrics/${m!.id}`, {
      type: 'counter',
      unit: 'bytes',
    });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().metric).toMatchObject({
      type: 'counter',
      detectedType: 'gauge',
      unit: 'bytes',
      detectedUnit: 'count',
      shown: 'rate',
    });
    await push(t.value, { name: 'queue_depth', type: 'gauge', value: 6 });
    expect((await list(c)).metrics[0]).toMatchObject({ type: 'counter', unit: 'bytes' });
    // Back to what the name says.
    const back = await api('PATCH', `/clusters/${c.id}/own-metrics/metrics/${m!.id}`, {
      type: null,
      unit: null,
    });
    expect(back.json().metric).toMatchObject({ type: 'gauge', unit: 'count' });
    expect(
      (await api('PATCH', `/clusters/${c.id}/own-metrics/metrics/${m!.id}`, { type: 'nonsense' }))
        .statusCode,
    ).toBe(400);
  });

  it('a refused metric can be checked again: fine when the label has few values now', async () => {
    const c = await cluster('kubernetes');
    const t = await token(c);
    const many = Array.from({ length: 101 }, (_, i) => ({
      name: 'logins_total',
      value: 1,
      labels: { user_id: `u${i}` },
    }));
    await push(t.value, { metrics: many });
    const [m] = (await list(c)).metrics;
    expect(m!.refused).toEqual({ label: 'user_id' });
    // Still too many: refused again at the next report.
    await api('PATCH', `/clusters/${c.id}/own-metrics/metrics/${m!.id}`, { checkAgain: true });
    expect((await list(c)).metrics[0]!.refused).toBeNull();
    const again = await push(t.value, { metrics: many });
    expect(again.json().dropped.cardinality).toEqual([
      { metric: 'logins_total', label: 'user_id' },
    ]);
    expect((await list(c)).metrics[0]!.refused).toEqual({ label: 'user_id' });
  });

  it('pins: on the page of the workload a metric belongs to, six at most', async () => {
    const c = await cluster('kubernetes');
    await workload(c, 'shop', 'Deployment', 'orders');
    const t = await token(c);
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `metric_${x}`);
    await push(t.value, {
      workload: 'shop/orders',
      metrics: [
        ...names.map((name, i) => ({ name, value: i + 1 })),
        { name: 'untied_metric', value: 9, workload: 'x/y' },
      ],
    });
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const l = await list(c);
    const id = (name: string) => l.metrics.find((m) => m.name === name)!.id;
    const owner = {
      kind: 'workload',
      namespace: 'shop',
      workloadKind: 'Deployment',
      name: 'orders',
    };
    const page = '?ownerKind=workload&namespace=shop&workloadKind=Deployment&owner=orders';
    const empty = (await api('GET', `/clusters/${c.id}/own-metrics/pins${page}`)).json();
    expect(empty).toEqual({ pins: [], max: 6, metrics: 7 });

    const viewer = await createUserSession(ctx.db, { role: 'viewer', orgId: c.orgId });
    expect(
      (
        await api(
          'POST',
          `/clusters/${c.id}/own-metrics/pins`,
          { metricId: id('metric_a'), owner },
          viewer.cookie,
        )
      ).statusCode,
    ).toBe(403);
    // A metric is pinned where it belongs, nowhere else.
    const elsewhere = await api('POST', `/clusters/${c.id}/own-metrics/pins`, {
      metricId: id('untied_metric'),
      owner,
    });
    expect(elsewhere.statusCode).toBe(404);
    const pins: string[] = [];
    for (const name of names.slice(0, 6)) {
      const res = await api('POST', `/clusters/${c.id}/own-metrics/pins`, {
        metricId: id(name),
        owner,
      });
      expect(res.statusCode, res.body).toBe(201);
      pins.push(res.json().id);
    }
    const twice = await api('POST', `/clusters/${c.id}/own-metrics/pins`, {
      metricId: id('metric_a'),
      owner,
    });
    expect(twice.statusCode).toBe(409);
    const seventh = await api('POST', `/clusters/${c.id}/own-metrics/pins`, {
      metricId: id('metric_g'),
      owner,
    });
    expect(seventh.statusCode).toBe(409);
    expect(seventh.json().detail).toMatch(/at most 6/);

    const got = (
      await api('GET', `/clusters/${c.id}/own-metrics/pins${page}`, undefined, viewer.cookie)
    ).json();
    expect(got.pins.map((p: { metric: { name: string } }) => p.metric.name)).toEqual(
      names.slice(0, 6),
    );
    expect(got.pins[2]).toMatchObject({ id: pins[2], metric: { name: 'metric_c', value: 3 } });
    // The last hour's line: its points are a minute apart, so a value two seconds old has none yet.
    expect(Array.isArray(got.pins[2].spark)).toBe(true);
    const detail = (
      await api('GET', `/clusters/${c.id}/own-metrics/metrics/${id('metric_a')}`)
    ).json();
    expect(detail.usedIn.pins).toEqual([{ id: pins[0], owner }]);

    expect(
      (
        await api(
          'DELETE',
          `/clusters/${c.id}/own-metrics/pins/${pins[0]}`,
          undefined,
          viewer.cookie,
        )
      ).statusCode,
    ).toBe(403);
    expect((await api('DELETE', `/clusters/${c.id}/own-metrics/pins/${pins[0]}`)).statusCode).toBe(
      204,
    );
    expect((await api('DELETE', `/clusters/${c.id}/own-metrics/pins/${pins[0]}`)).statusCode).toBe(
      404,
    );
    expect(
      (await api('POST', `/clusters/${c.id}/own-metrics/pins`, { metricId: id('metric_g'), owner }))
        .statusCode,
    ).toBe(201);
  });

  it('on a fleet, a metric is pinned to its server’s page', async () => {
    const c = await cluster('server');
    await server(c, 'db-1');
    const t = await token(c);
    await push(t.value, {
      name: 'backup_last_success_timestamp_seconds',
      value: Math.floor(Date.now() / 1000) - 600,
      server: 'db-1',
    });
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const [m] = (await list(c)).metrics;
    expect(m!.owners).toEqual([{ kind: 'server', namespace: '', workloadKind: '', name: 'db-1' }]);
    const pin = await api('POST', `/clusters/${c.id}/own-metrics/pins`, {
      metricId: m!.id,
      owner: { kind: 'server', name: 'db-1' },
    });
    expect(pin.statusCode).toBe(201);
    const got = (
      await api('GET', `/clusters/${c.id}/own-metrics/pins?ownerKind=server&owner=db-1`)
    ).json();
    expect(got.pins).toHaveLength(1);
    expect(got.pins[0].metric.value).toBeGreaterThan(500);
    expect(got.pins[0].metric.value).toBeLessThan(700);
    expect(
      (await api('GET', `/clusters/${c.id}/own-metrics/pins?ownerKind=server&owner=web-1`)).json()
        .pins,
    ).toEqual([]);
  });
});

describe('dashboards of own metrics', () => {
  const BEHIND = 60_000;
  beforeEach(() => start({}, { now: () => Date.now() - BEHIND }));

  const widget = (c: Cluster, over: Record<string, unknown> = {}) => ({
    id: 'w1',
    clusterId: c.id,
    metric: 'jobs_waiting',
    title: '',
    shape: 'line',
    by: null,
    w: 6,
    ...over,
  });

  async function withMetrics() {
    const c = await cluster('kubernetes');
    const t = await token(c);
    await push(t.value, {
      metrics: [
        { name: 'jobs_waiting', value: 12, labels: { queue: 'mail' } },
        { name: 'orders_created_total', value: 3 },
      ],
    });
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    return c;
  }

  it('Owners and Admins build them; everyone reads; a widget shows what its metric is now', async () => {
    const c = await withMetrics();
    const viewer = await createUserSession(ctx.db, { role: 'viewer', orgId: c.orgId });
    expect((await api('POST', '/own-dashboards', { name: 'x' }, viewer.cookie)).statusCode).toBe(
      403,
    );
    const made = await api('POST', '/own-dashboards', { name: ' Shop business ' });
    expect(made.statusCode).toBe(201);
    const id = made.json().id as string;
    expect(made.json().name).toBe('Shop business');
    expect((await api('POST', '/own-dashboards', { name: 'shop BUSINESS' })).statusCode).toBe(409);

    const saved = await api('PUT', `/own-dashboards/${id}`, {
      widgets: [
        widget(c, { id: 'a', shape: 'number', w: 3 }),
        widget(c, {
          id: 'b',
          metric: 'orders_created_total',
          title: 'Orders',
          shape: 'bars',
          w: 8,
        }),
        widget(c, { id: 'c', by: 'queue', shape: 'area', w: 4 }),
        widget(c, { id: 'd', metric: 'gone_metric', w: 12 }),
      ],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const d = (await api('GET', `/own-dashboards/${id}`, undefined, viewer.cookie)).json();
    expect(d.name).toBe('Shop business');
    expect(
      d.widgets.map((w: { id: string; w: number; shape: string }) => [w.id, w.w, w.shape]),
    ).toEqual([
      ['a', 3, 'number'],
      ['b', 8, 'bars'],
      ['c', 4, 'area'],
      ['d', 12, 'line'],
    ]);
    // A title left empty starts as the metric's words.
    expect(d.widgets[0]).toMatchObject({
      title: 'Jobs waiting',
      clusterName: 'kubernetes',
      resolved: {
        name: 'jobs_waiting',
        type: 'gauge',
        shown: 'as_is',
        value: 12,
        labels: ['queue'],
      },
    });
    expect(d.widgets[1]).toMatchObject({
      title: 'Orders',
      resolved: { type: 'counter', shown: 'rate' },
    });
    expect(d.widgets[2].by).toBe('queue');
    // A metric that doesn't report: the widget stays and says so.
    expect(d.widgets[3]).toMatchObject({ title: 'Gone metric', resolved: null });

    const list = (await api('GET', '/own-dashboards', undefined, viewer.cookie)).json();
    expect(list).toEqual({
      dashboards: [{ id, name: 'Shop business', widgets: 4 }],
      limits: { dashboards: 50, widgetsPerDashboard: 24 },
    });
    // Where a metric is used.
    const metrics = (await api('GET', `/clusters/${c.id}/own-metrics/metrics`)).json().metrics;
    const jobs = metrics.find((m: { name: string }) => m.name === 'jobs_waiting');
    const detail = (await api('GET', `/clusters/${c.id}/own-metrics/metrics/${jobs.id}`)).json();
    expect(detail.usedIn.dashboards).toEqual([{ id, name: 'Shop business' }]);

    expect(
      (await api('PUT', `/own-dashboards/${id}`, { name: 'Shop' }, viewer.cookie)).statusCode,
    ).toBe(403);
    const renamed = await api('PUT', `/own-dashboards/${id}`, { name: 'Shop' });
    expect(renamed.json()).toMatchObject({ name: 'Shop' });
    expect(renamed.json().widgets).toHaveLength(4);
    expect(
      (await api('DELETE', `/own-dashboards/${id}`, undefined, viewer.cookie)).statusCode,
    ).toBe(403);
    expect((await api('DELETE', `/own-dashboards/${id}`)).statusCode).toBe(204);
    expect((await api('GET', `/own-dashboards/${id}`)).statusCode).toBe(404);
  });

  it('a widget is a metric, a shape, a label and a size: nothing else is taken', async () => {
    const c = await withMetrics();
    const id = (await api('POST', '/own-dashboards', { name: 'D' })).json().id as string;
    const put = (widgets: unknown[]) => api('PUT', `/own-dashboards/${id}`, { widgets });
    const other = await createUserSession(ctx.db, { role: 'owner' });
    const theirs = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: other.cookie },
      payload: { name: 'theirs', kind: 'kubernetes' },
    });
    for (const [bad, why] of [
      [widget(c, { clusterId: theirs.json().cluster.id }), /not yours/],
      [widget(c, { metric: 'watchlog_node_cpu_usage_cores' }), /Not one of your metrics/],
      [widget(c, { metric: 'sum(rate(x[5m]))' }), /Not one of your metrics/],
      [widget(c, { by: 'wl_own' }), /Not a label/],
      [widget(c, { by: 'a,b' }), /Not a label/],
    ] as const) {
      const res = await put([bad]);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().detail).toMatch(why);
    }
    // The schema refuses anything a widget doesn't have.
    for (const bad of [
      widget(c, { shape: 'pie' }),
      widget(c, { w: 5 }),
      widget(c, { id: 'has space' }),
      { ...widget(c), query: 'up' },
    ]) {
      const res = await put([bad]);
      // An unknown property is dropped, never stored; the rest is a 400.
      if ('query' in bad) {
        expect(res.statusCode).toBe(200);
        expect(JSON.stringify(res.json())).not.toContain('query');
      } else expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await put([widget(c), widget(c)])).json().detail).toMatch(/share the id/);
    // Another org can't read or change it.
    expect((await api('GET', `/own-dashboards/${id}`, undefined, other.cookie)).statusCode).toBe(
      404,
    );
    expect(
      (await api('PUT', `/own-dashboards/${id}`, { name: 'x' }, other.cookie)).statusCode,
    ).toBe(404);
    expect(
      (await api('GET', '/own-dashboards', undefined, other.cookie)).json().dashboards,
    ).toEqual([]);
  });

  it('a copy has the same widgets under new ids', async () => {
    const c = await withMetrics();
    const id = (await api('POST', '/own-dashboards', { name: 'Shop' })).json().id as string;
    await api('PUT', `/own-dashboards/${id}`, {
      widgets: [widget(c, { id: 'a' }), widget(c, { id: 'b', w: 12 })],
    });
    const copy = await api('POST', '/own-dashboards', { name: 'Shop copy', copyOf: id });
    expect(copy.statusCode).toBe(201);
    const d = (await api('GET', `/own-dashboards/${copy.json().id}`)).json();
    expect(d.widgets.map((w: { metric: string; w: number }) => [w.metric, w.w])).toEqual([
      ['jobs_waiting', 6],
      ['jobs_waiting', 12],
    ]);
    expect(d.widgets.map((w: { id: string }) => w.id)).not.toContain('a');
    expect(
      (await api('POST', '/own-dashboards', { name: 'Nope', copyOf: newId() })).statusCode,
    ).toBe(404);
  });

  it('Cloud Free: one dashboard of 8 widgets; a downgrade keeps what there is', async () => {
    const c = await withMetrics();
    const pro = await ctx.app.ownMetrics.usage(c.orgId);
    const many = (n: number) => Array.from({ length: n }, (_, i) => widget(c, { id: `w${i}` }));
    const first = (await api('POST', '/own-dashboards', { name: 'One' })).json().id as string;
    const second = (await api('POST', '/own-dashboards', { name: 'Two' })).json().id as string;
    expect((await api('PUT', `/own-dashboards/${second}`, { widgets: many(12) })).statusCode).toBe(
      200,
    );
    expect((await api('PUT', `/own-dashboards/${second}`, { widgets: many(25) })).statusCode).toBe(
      402,
    );

    // The org is now on Free.
    const free = ownMetricLimits({ edition: 'cloud', plan: 'free', pro: false });
    ctx.app.ownMetrics.usage = async () => ({ ...pro, limits: free });
    const third = await api('POST', '/own-dashboards', { name: 'Three' });
    expect(third.statusCode).toBe(402);
    expect(third.json()).toMatchObject({ code: 'plan-limit', limit: 'own-dashboards', max: 1 });
    const grow = await api('PUT', `/own-dashboards/${first}`, { widgets: many(9) });
    expect(grow.statusCode).toBe(402);
    expect(grow.json()).toMatchObject({ code: 'plan-limit', limit: 'own-widgets', max: 8 });
    expect((await api('PUT', `/own-dashboards/${first}`, { widgets: many(8) })).statusCode).toBe(
      200,
    );
    // What it had before stays readable and can be rearranged or shrunk, not grown.
    expect((await api('GET', `/own-dashboards/${second}`)).json().widgets).toHaveLength(12);
    expect(
      (await api('PUT', `/own-dashboards/${second}`, { widgets: many(12).reverse() })).statusCode,
    ).toBe(200);
    expect((await api('PUT', `/own-dashboards/${second}`, { widgets: many(13) })).statusCode).toBe(
      402,
    );
    expect((await api('GET', '/own-dashboards')).json().limits).toEqual({
      dashboards: 1,
      widgetsPerDashboard: 8,
    });
  });
});
