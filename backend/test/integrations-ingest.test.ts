// SPDX-License-Identifier: AGPL-3.0-only
// The integrations collector's ingest API (ADR-131): its configuration with members
// resolved for Kubernetes and Docker, the long-poll, and its status reports.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { containerAddress } from '../src/modules/integrations/collector-config.js';
import { ConfigNotifier } from '../src/modules/integrations/notifier.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

describe('integrations collector ingest', () => {
  let ctx: TestContext;
  let cookie: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    cookie = await setupAdmin(ctx.app);
  });
  afterEach(() => closeTestContext(ctx));

  async function cluster(kind: 'docker' | 'kubernetes') {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: kind === 'docker' ? 'fleet' : 'kind', kind },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const org = await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow();
    return { id: body.cluster.id as string, token: body.token.value as string, orgId: org.id };
  }

  const config = (token: string, query = '', headers: Record<string, string> = {}) =>
    ctx.app.inject({
      method: 'GET',
      url: `/ingest/v1/integrations/config${query}`,
      headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': 'integrations', ...headers },
    });

  const status = (token: string, payload: object) =>
    ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/integrations/status',
      headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': 'integrations' },
      payload,
    });

  async function addIntegration(
    c: { id: string; orgId: string },
    row: { type: string; name: string; target: object; collector_host?: string },
  ) {
    const id = newId();
    await ctx.db
      .insertInto('integrations')
      .values({
        id,
        org_id: c.orgId,
        cluster_id: c.id,
        type: row.type,
        name: row.name,
        target: JSON.stringify(row.target),
        collector_host: row.collector_host ?? '',
      })
      .execute();
    return id;
  }

  async function addObject(clusterId: string, o: Record<string, unknown>) {
    await ctx.db
      .insertInto('objects')
      .values({
        id: newId(),
        cluster_id: clusterId,
        source: o.source as string,
        kind: o.kind as string,
        namespace: (o.namespace as string) ?? '',
        name: o.name as string,
        uid: newId(),
        node: (o.node as string) ?? null,
        spec_summary: JSON.stringify(o.spec ?? {}),
        status_summary: JSON.stringify(o.status ?? {}),
      })
      .execute();
  }

  it('needs a cluster token', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/ingest/v1/integrations/config' });
    expect(res.statusCode).toBe(401);
  });

  it('serves a Docker host its targets with the containers it can reach', async () => {
    const c = await cluster('docker');
    await addObject(c.id, {
      source: 'docker',
      kind: 'DockerContainer',
      namespace: 'shop',
      name: 'shop-redis-1',
      node: 'docker-01',
      spec: {
        image: 'redis:7.2',
        compose_service: 'redis',
        ports: [{ ip: '127.0.0.1', public_port: 16379, private_port: 6379, protocol: 'tcp' }],
      },
      status: { state: 'running' },
    });
    // The same service name on another host is not this collector's.
    await addObject(c.id, {
      source: 'docker',
      kind: 'DockerContainer',
      namespace: 'shop',
      name: 'shop-redis-1',
      node: 'docker-02',
      spec: { image: 'redis:7.2', compose_service: 'redis', ips: ['172.18.0.9'] },
      status: { state: 'running' },
    });
    const id = await addIntegration(c, {
      type: 'redis',
      name: 'shop/redis',
      collector_host: 'docker-01',
      target: {
        kind: 'compose',
        host: 'docker-01',
        compose_project: 'shop',
        compose_service: 'redis',
        port: 6379,
      },
    });
    const res = await config(c.token, '?host=docker-01');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.scrape).toEqual({ interval_s: 15, heavy_every: 2 });
    expect(body.targets).toEqual([
      {
        id,
        type: 'redis',
        name: 'shop/redis',
        members: [{ name: 'shop-redis-1', address: '127.0.0.1:16379' }],
        settings: { query_text: true },
      },
    ]);
    expect(res.headers.etag).toBe(`"${body.version}"`);

    // Another host's collector gets nothing.
    expect((await config(c.token, '?host=docker-02')).json().targets).toEqual([]);
  });

  it('resolves a Kubernetes workload to its pods', async () => {
    const c = await cluster('kubernetes');
    for (const [name, ip] of [
      ['postgres-1', '10.244.1.9'],
      ['postgres-0', '10.244.0.7'],
      ['postgres-2', undefined],
    ] as const) {
      await addObject(c.id, {
        source: 'kubernetes',
        kind: 'Pod',
        namespace: 'payments',
        name,
        node: 'kind-worker',
        spec: { workload: { kind: 'StatefulSet', name: 'postgres' } },
        status: ip ? { pod_ip: ip, phase: 'Running' } : { phase: 'Pending' },
      });
    }
    await addObject(c.id, {
      source: 'kubernetes',
      kind: 'Pod',
      namespace: 'payments',
      name: 'api-5d9c',
      node: 'kind-worker',
      spec: { workload: { kind: 'Deployment', name: 'api' } },
      status: { pod_ip: '10.244.0.8', phase: 'Running' },
    });
    await addIntegration(c, {
      type: 'postgres',
      name: 'payments/postgres',
      target: {
        kind: 'workload',
        namespace: 'payments',
        workload_kind: 'StatefulSet',
        workload: 'postgres',
        port: 5432,
      },
    });
    const body = (await config(c.token)).json();
    expect(body.targets[0].members).toEqual([
      { name: 'postgres-0', address: '10.244.0.7:5432' },
      { name: 'postgres-1', address: '10.244.1.9:5432' },
    ]);
  });

  it('answers 304 to an unchanged configuration and long-polls until a change', async () => {
    const c = await cluster('docker');
    const first = await config(c.token, '?host=docker-01');
    const etag = first.headers.etag as string;
    const same = await config(c.token, '?host=docker-01', { 'if-none-match': etag });
    expect(same.statusCode).toBe(304);

    // Nothing changes: 304 after the wait.
    const started = Date.now();
    const idle = await config(c.token, '?host=docker-01&wait=1', { 'if-none-match': etag });
    expect(idle.statusCode).toBe(304);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    // A change while waiting wakes the request at once with the new configuration.
    const woken = Date.now();
    const pending = config(c.token, '?host=docker-01&wait=20', { 'if-none-match': etag });
    while (ctx.app.collectorNotifier.pending(c.id) === 0)
      await new Promise((r) => setTimeout(r, 10));
    await addIntegration(c, {
      type: 'nginx',
      name: 'edge',
      collector_host: 'docker-01',
      target: { kind: 'address', address: '10.0.0.5:80' },
    });
    ctx.app.collectorNotifier.notify(c.id);
    const res = await pending;
    expect(Date.now() - woken).toBeLessThan(5_000);
    expect(res.statusCode).toBe(200);
    expect(res.json().targets[0].members).toEqual([
      { name: '10.0.0.5:80', address: '10.0.0.5:80' },
    ]);
  });

  it('records the collector and each target it reports, for its own targets only', async () => {
    const c = await cluster('docker');
    const mine = await addIntegration(c, {
      type: 'redis',
      name: 'shop/redis',
      collector_host: 'docker-01',
      target: { kind: 'address', address: '127.0.0.1:6379' },
    });
    const elsewhere = await addIntegration(c, {
      type: 'redis',
      name: 'cache',
      collector_host: 'docker-02',
      target: { kind: 'address', address: '127.0.0.1:6379' },
    });
    const res = await status(c.token, {
      host: 'docker-01',
      mode: 'docker',
      version: '0.3.0',
      config_version: 'abc',
      self: { rss_bytes: 21_000_000, cpu_seconds: 1.5, series: 40 },
      targets: [
        {
          id: mine,
          state: 'ok',
          service_version: '7.2.4',
          members: [{ name: 'shop-redis-1', up: true }],
        },
        { id: elsewhere, state: 'error', error: 'connection refused' },
      ],
    });
    expect(res.statusCode).toBe(204);
    const collectors = await ctx.db.selectFrom('integration_collectors').selectAll().execute();
    expect(collectors).toHaveLength(1);
    expect(collectors[0]).toMatchObject({ host: 'docker-01', mode: 'docker', version: '0.3.0' });
    const rows = await ctx.db
      .selectFrom('integrations')
      .select(['id', 'status', 'version', 'status_details', 'last_report_at'])
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(mine)).toMatchObject({ status: 'ok', version: '7.2.4' });
    expect(byId.get(mine)!.last_report_at).not.toBeNull();
    expect(byId.get(mine)!.status_details).toEqual({
      members: [{ name: 'shop-redis-1', up: true }],
      permissions: [],
    });
    // docker-02's integration isn't docker-01's to report.
    expect(byId.get(elsewhere)).toMatchObject({ status: 'pending', last_report_at: null });
  });

  it('refuses a Kubernetes report that names a host', async () => {
    const c = await cluster('kubernetes');
    const res = await status(c.token, {
      host: 'node-1',
      mode: 'kubernetes',
      version: '0.3.0',
      config_version: '',
      self: {},
      targets: [],
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('collector config helpers', () => {
  it('reaches a container by its bridge address, else by a port it publishes', () => {
    expect(containerAddress({ ips: ['172.18.0.4'] }, 5432)).toBe('172.18.0.4:5432');
    expect(
      containerAddress(
        { ports: [{ ip: '0.0.0.0', public_port: 15432, private_port: 5432, protocol: 'tcp' }] },
        5432,
      ),
    ).toBe('127.0.0.1:15432');
    expect(containerAddress({ ports: [] }, 5432)).toBeNull();
    expect(containerAddress({ ips: ['fd00::4'] }, 6379)).toBe('[fd00::4]:6379');
  });

  it('wakes waiters on a change, once, and forgets them', async () => {
    const n = new ConfigNotifier();
    let woke = 0;
    const p = n.wait('c1', 10_000).then(() => woke++);
    expect(n.pending('c1')).toBe(1);
    n.notify('c2');
    expect(n.pending('c1')).toBe(1);
    n.notify('c1');
    await p;
    expect(woke).toBe(1);
    expect(n.pending('c1')).toBe(0);
    const aborted = new AbortController();
    const q = n.wait('c1', 10_000, aborted.signal);
    aborted.abort();
    await q;
    expect(n.pending('c1')).toBe(0);
  });
});
