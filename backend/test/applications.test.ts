// SPDX-License-Identifier: AGPL-3.0-only
// Applications (v0.3 slice 2): discovery from images and ports on Kubernetes and Docker
// (ADR-132), Monitor and remove, health from the collectors' reports, roles.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { imagePath, imageVersion, kindOfImage } from '../src/modules/integrations/discovery.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  type TestContext,
} from './helpers.js';

describe('image matching', () => {
  it.each([
    ['postgres:16.4-alpine', 'postgres', 'postgres', '16.4'],
    ['docker.io/library/postgres:15', 'postgres', 'library/postgres', '15'],
    ['bitnami/postgresql:17.2.0-debian-12-r3', 'postgres', 'bitnami/postgresql', '17.2.0'],
    ['ghcr.io/cloudnative-pg/postgresql:16.6', 'postgres', 'cloudnative-pg/postgresql', '16.6'],
    ['timescale/timescaledb-ha:pg16', 'postgres', 'timescale/timescaledb-ha', null],
    ['redis:7.2', 'redis', 'redis', '7.2'],
    ['valkey/valkey:8.0@sha256:abc', 'redis', 'valkey/valkey', '8.0'],
    [
      'registry.k8s.io/ingress-nginx/controller:v1.11.3@sha256:d5',
      'nginx',
      'ingress-nginx/controller',
      '1.11.3',
    ],
    ['nginxinc/nginx-unprivileged:1.27', 'nginx', 'nginxinc/nginx-unprivileged', '1.27'],
    ['localhost:5000/rabbitmq:3.13-management', 'rabbitmq', 'rabbitmq', '3.13'],
  ])('%s is %s', (ref, type, path, version) => {
    expect(imagePath(ref)).toBe(path);
    expect(imageVersion(ref)).toBe(version);
    expect(kindOfImage(ref)?.type).toBe(type);
  });

  it.each([
    'prometheuscommunity/postgres-exporter:v0.15',
    'bitnami/pgbouncer:1.23',
    'oliver006/redis_exporter:v1.62',
    'bitnami/redis-sentinel:7.2',
    'nginx/nginx-prometheus-exporter:1.3',
    'busybox:1.37',
  ])('%s is not a service to monitor', (ref) => {
    expect(kindOfImage(ref)).toBeUndefined();
  });
});

describe('Applications API', () => {
  let ctx: TestContext;
  let cookie: string;
  let orgId: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    cookie = await setupAdmin(ctx.app);
    orgId = (await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow()).id;
  });
  afterEach(() => closeTestContext(ctx));

  const api = (method: string, url: string, payload?: object, as = cookie) =>
    ctx.app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      cookies: { wl_session: as },
      ...(payload ? { payload } : {}),
    });

  async function cluster(name: string, kind: 'kubernetes' | 'docker') {
    const res = await api('POST', '/clusters', { name, kind });
    expect(res.statusCode).toBe(201);
    return { id: res.json().cluster.id as string, token: res.json().token.value as string };
  }

  async function pod(
    clusterId: string,
    ns: string,
    name: string,
    workload: [string, string],
    containers: { image: string; ports?: number[] }[],
  ) {
    await ctx.db
      .insertInto('objects')
      .values({
        id: newId(),
        cluster_id: clusterId,
        source: 'kubernetes',
        kind: 'Pod',
        namespace: ns,
        name,
        uid: newId(),
        node: 'kind-worker',
        spec_summary: JSON.stringify({
          workload: { kind: workload[0], name: workload[1] },
          containers: containers.map((c, i) => ({
            name: `c${i}`,
            image: c.image,
            ports: (c.ports ?? []).map((p) => ({ port: p, protocol: 'TCP' })),
          })),
        }),
        status_summary: JSON.stringify({ pod_ip: '10.244.0.9', phase: 'Running' }),
      })
      .execute();
  }

  async function container(
    clusterId: string,
    host: string,
    name: string,
    image: string,
    opts: { project?: string; service?: string; exposed?: number[]; state?: string } = {},
  ) {
    await ctx.db
      .insertInto('objects')
      .values({
        id: newId(),
        cluster_id: clusterId,
        source: 'docker',
        kind: 'DockerContainer',
        namespace: opts.project ?? '',
        name,
        uid: newId().replace(/-/g, ''),
        node: host,
        spec_summary: JSON.stringify({
          image,
          compose_service: opts.service,
          exposed: opts.exposed ?? [],
          ips: ['172.18.0.4'],
        }),
        status_summary: JSON.stringify({ state: opts.state ?? 'running' }),
      })
      .execute();
  }

  it('discovers services on Kubernetes and Docker, by image first, then by port', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    const docker = await cluster('docker-01', 'docker');
    // Two replicas of one StatefulSet: one service with two members.
    await pod(
      k8s.id,
      'payments',
      'postgres-0',
      ['StatefulSet', 'postgres'],
      [
        { image: 'postgres:16.4', ports: [5432] },
        { image: 'prometheuscommunity/postgres-exporter:v0.15', ports: [9187] },
      ],
    );
    await pod(
      k8s.id,
      'payments',
      'postgres-1',
      ['StatefulSet', 'postgres'],
      [{ image: 'postgres:16.4', ports: [5432] }],
    );
    await pod(
      k8s.id,
      'ingress',
      'ingress-nginx-controller-5c',
      ['Deployment', 'ingress-nginx-controller'],
      [{ image: 'registry.k8s.io/ingress-nginx/controller:v1.11.3', ports: [80, 443, 10254] }],
    );
    // A port alone: offered with a lower confidence.
    await pod(
      k8s.id,
      'shop',
      'cache-7f',
      ['Deployment', 'cache'],
      [{ image: 'example.com/team/kv-store:2', ports: [6379] }],
    );
    await pod(
      k8s.id,
      'shop',
      'api-1',
      ['Deployment', 'api'],
      [{ image: 'example.com/shop/api:1.0' }],
    );
    // A stopped container and a pod that isn't running aren't offered.
    await container(docker.id, 'docker-01', 'old-redis', 'redis:6', {
      exposed: [6379],
      state: 'exited',
    });
    await ctx.db
      .updateTable('objects')
      .set({ status_summary: JSON.stringify({ phase: 'Succeeded' }) })
      .where('name', '=', 'api-1')
      .execute();
    // MongoDB ships in v0.3.1: not offered yet.
    await pod(k8s.id, 'billing', 'mongo-0', ['StatefulSet', 'mongo'], [{ image: 'mongo:7.0' }]);
    await container(docker.id, 'docker-01', 'analytics-redis-1', 'redis:7.2', {
      project: 'analytics',
      service: 'redis',
      exposed: [6379],
    });
    await container(docker.id, 'docker-01', 'mq', 'rabbitmq:3.13-management', {
      exposed: [5672, 15672, 15692],
    });

    const res = await api('GET', '/applications/discovered');
    expect(res.statusCode).toBe(200);
    const found = res.json().discovered as {
      name: string;
      type: string;
      confidence: string;
      members: number;
      version: string | null;
      port: number;
      cluster: { kind: string };
      target: Record<string, unknown>;
    }[];
    expect(found.map((d) => [d.type, d.name, d.confidence])).toEqual([
      ['redis', 'analytics/redis', 'image'],
      ['nginx', 'ingress/ingress-nginx-controller', 'image'],
      ['rabbitmq', 'mq', 'image'],
      ['postgres', 'payments/postgres', 'image'],
      ['redis', 'shop/cache', 'port'],
    ]);
    const pg = found.find((d) => d.type === 'postgres')!;
    expect(pg).toMatchObject({
      members: 2,
      version: '16.4',
      port: 5432,
      cluster: { kind: 'kubernetes' },
    });
    expect(pg.target).toEqual({
      kind: 'workload',
      namespace: 'payments',
      workload_kind: 'StatefulSet',
      workload: 'postgres',
      port: 5432,
    });
    expect(found.find((d) => d.type === 'rabbitmq')!.target).toEqual({
      kind: 'container',
      host: 'docker-01',
      container: 'mq',
      port: 5672,
    });

    // Monitoring one takes it off the list.
    const created = await api('POST', '/applications', {
      clusterId: k8s.id,
      type: 'postgres',
      target: pg.target,
    });
    expect(created.statusCode).toBe(201);
    const after = (await api('GET', '/applications/discovered')).json().discovered;
    expect(after.map((d: { name: string }) => d.name)).not.toContain('payments/postgres');
    // Filtered to one cluster.
    const dockerOnly = (await api('GET', `/applications/discovered?cluster=${docker.id}`)).json();
    expect(dockerOnly.discovered.map((d: { name: string }) => d.name)).toEqual([
      'analytics/redis',
      'mq',
    ]);
  });

  it('monitors a service, wakes its collector and reports its health', async () => {
    const docker = await cluster('docker-01', 'docker');
    const target = {
      kind: 'compose',
      host: 'docker-01',
      compose_project: 'shop',
      compose_service: 'redis',
      port: 6379,
    };
    const waiting = ctx.app.collectorNotifier.wait(docker.id, 10_000);
    const res = await api('POST', '/applications', { clusterId: docker.id, type: 'redis', target });
    expect(res.statusCode).toBe(201);
    await waiting; // woken by the change, not the 10 s timeout
    const app = res.json().application;
    expect(app).toMatchObject({
      type: 'redis',
      name: 'shop/redis',
      cluster: { name: 'docker-01', kind: 'docker' },
      where: { group: 'shop', host: 'docker-01', address: null },
      health: 'unknown',
      reason: { code: 'collector_missing', facts: { host: 'docker-01' } },
    });
    // The same service twice: refused.
    expect(
      (await api('POST', '/applications', { clusterId: docker.id, type: 'redis', target }))
        .statusCode,
    ).toBe(409);

    // The host's collector reports it unreachable, then connected.
    const report = (state: string, extra: object = {}) =>
      ctx.app.inject({
        method: 'POST',
        url: '/ingest/v1/integrations/status',
        headers: {
          authorization: `Bearer ${docker.token}`,
          'x-watchlog-agent': 'integrations:docker-01',
        },
        payload: {
          host: 'docker-01',
          mode: 'docker',
          version: '0.3.0',
          config_version: 'x',
          self: {},
          targets: [{ id: app.id, state, ...extra }],
        },
      });
    expect(
      (
        await report('error', {
          error: 'connection refused',
          members: [{ name: 'shop-redis-1', up: false }],
        })
      ).statusCode,
    ).toBe(204);
    let list = (await api('GET', '/applications')).json().applications;
    expect(list[0]).toMatchObject({
      health: 'critical',
      reason: { code: 'unreachable', facts: { error: 'connection refused', up: 0, members: 1 } },
    });
    await report('ok', { service_version: '7.2.4', members: [{ name: 'shop-redis-1', up: true }] });
    list = (await api('GET', '/applications')).json().applications;
    expect(list[0]).toMatchObject({
      version: '7.2.4',
      health: 'ok',
      reason: { code: 'connected' },
      members: { up: 1, total: 1 },
    });

    // The collector goes silent.
    await ctx.db
      .updateTable('integration_collectors')
      .set({ last_seen_at: new Date(Date.now() - 10 * 60_000) })
      .execute();
    const silent = (await api(`GET`, `/applications/${app.id}`)).json().application;
    expect(silent).toMatchObject({ health: 'critical', reason: { code: 'collector_silent' } });
    const collectors = (await api('GET', '/applications/collectors')).json().collectors;
    expect(collectors).toEqual([
      expect.objectContaining({ host: 'docker-01', reporting: false, version: '0.3.0' }),
    ]);

    expect((await api('DELETE', `/applications/${app.id}`)).statusCode).toBe(204);
    expect((await api('GET', `/applications/${app.id}`)).statusCode).toBe(404);
  });

  it('checks targets against the cluster and the version', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    const docker = await cluster('docker-01', 'docker');
    const post = (body: object) => api('POST', '/applications', body);
    const compose = {
      kind: 'compose',
      host: 'h',
      compose_project: 'p',
      compose_service: 's',
      port: 6379,
    };
    expect((await post({ clusterId: k8s.id, type: 'redis', target: compose })).statusCode).toBe(
      400,
    );
    expect(
      (await post({ clusterId: docker.id, type: 'mongodb', target: { ...compose, port: 27017 } }))
        .statusCode,
    ).toBe(400);
    // An address on Docker needs the host whose collector reaches it.
    const address = { kind: 'address', address: 'db.internal:5432' };
    expect(
      (await post({ clusterId: docker.id, type: 'postgres', target: address })).statusCode,
    ).toBe(400);
    const ok = await post({
      clusterId: docker.id,
      type: 'postgres',
      target: address,
      collectorHost: 'docker-01',
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().application.where).toEqual({
      group: null,
      host: null,
      address: 'db.internal:5432',
    });
    expect(
      (
        await post({
          clusterId: docker.id,
          type: 'postgres',
          target: { kind: 'address', address: 'not a host' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await post({ clusterId: newId(), type: 'redis', target: compose })).statusCode).toBe(
      404,
    );
  });

  it('ignores one discovered service or a whole namespace or project, and restores them', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    const docker = await cluster('docker-01', 'docker');
    await pod(k8s.id, 'shop', 'redis-0', ['StatefulSet', 'redis'], [{ image: 'redis:7.2' }]);
    await pod(k8s.id, 'pg-e2e', 'pg-0', ['StatefulSet', 'pg'], [{ image: 'postgres:17' }]);
    await pod(k8s.id, 'pg-e2e', 'pg2-0', ['StatefulSet', 'pg2'], [{ image: 'postgres:13' }]);
    await container(docker.id, 'docker-01', 'cache-1', 'valkey/valkey:8.0', {
      project: 'storefront',
      service: 'cache',
    });
    const list = async () =>
      (await api('GET', '/applications/discovered')).json() as {
        discovered: { key: string; name: string; product: string | null; version: string }[];
        ignored: { id: string; scope: string; label: string }[];
      };
    const first = await list();
    expect(first.discovered.map((d) => d.name).sort()).toEqual([
      'pg-e2e/pg',
      'pg-e2e/pg2',
      'shop/redis',
      'storefront/cache',
    ]);
    // Valkey is read by the Redis integration and says so.
    expect(first.discovered.find((d) => d.name === 'storefront/cache')).toMatchObject({
      product: 'valkey',
      version: '8.0',
    });
    expect(first.discovered.find((d) => d.name === 'shop/redis')!.product).toBeNull();

    const viewer = await createUserSession(ctx.db, { role: 'viewer', orgId });
    const shop = first.discovered.find((d) => d.name === 'shop/redis')!;
    expect(
      (
        await api(
          'POST',
          '/applications/discovered/ignore',
          { clusterId: k8s.id, key: shop.key },
          viewer.cookie,
        )
      ).statusCode,
    ).toBe(403);
    const one = await api('POST', '/applications/discovered/ignore', {
      clusterId: k8s.id,
      key: shop.key,
    });
    expect(one.statusCode, one.body).toBe(201);
    const ns = await api('POST', '/applications/discovered/ignore', {
      clusterId: k8s.id,
      group: 'pg-e2e',
    });
    expect(ns.json().ignored).toMatchObject({ scope: 'group', label: 'namespace pg-e2e' });
    expect(
      (await api('POST', '/applications/discovered/ignore', { clusterId: k8s.id, group: 'nope' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api('POST', '/applications/discovered/ignore', { clusterId: k8s.id })).statusCode,
    ).toBe(400);
    const after = await list();
    expect(after.discovered.map((d) => d.name)).toEqual(['storefront/cache']);
    expect(after.ignored.map((i) => i.label).sort()).toEqual([
      'namespace pg-e2e',
      'redis shop/redis',
    ]);
    // A new pod in an ignored namespace stays out too.
    await pod(k8s.id, 'pg-e2e', 'pg3-0', ['StatefulSet', 'pg3'], [{ image: 'postgres:16' }]);
    expect((await list()).discovered.map((d) => d.name)).toEqual(['storefront/cache']);
    // Restored: back in the list.
    expect(
      (await api('DELETE', `/applications/discovered/ignore/${ns.json().ignored.id}`)).statusCode,
    ).toBe(204);
    expect((await list()).discovered.map((d) => d.name)).toEqual([
      'pg-e2e/pg',
      'pg-e2e/pg2',
      'pg-e2e/pg3',
      'storefront/cache',
    ]);
  });

  it('says who paused a service and when', async () => {
    const docker = await cluster('docker-01', 'docker');
    const target = { kind: 'container', host: 'docker-01', container: 'redis', port: 6379 };
    const id = (
      await api('POST', '/applications', { clusterId: docker.id, type: 'redis', target })
    ).json().application.id as string;
    expect((await api('PATCH', `/applications/${id}`, { paused: true })).statusCode).toBe(204);
    const a = (await api('GET', `/applications/${id}`)).json().application;
    expect(a.reason.code).toBe('paused');
    expect(a.reason.facts.by).toBeTruthy();
    expect(Date.parse(a.reason.facts.at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('lets viewers read and only owners and admins change', async () => {
    const docker = await cluster('docker-01', 'docker');
    const viewer = await createUserSession(ctx.db, { role: 'viewer', orgId });
    expect((await api('GET', '/applications', undefined, viewer.cookie)).statusCode).toBe(200);
    expect(
      (await api('GET', '/applications/discovered', undefined, viewer.cookie)).statusCode,
    ).toBe(200);
    const target = { kind: 'container', host: 'docker-01', container: 'redis', port: 6379 };
    expect(
      (
        await api(
          'POST',
          '/applications',
          { clusterId: docker.id, type: 'redis', target },
          viewer.cookie,
        )
      ).statusCode,
    ).toBe(403);
    const created = (
      await api('POST', '/applications', { clusterId: docker.id, type: 'redis', target })
    ).json();
    expect(
      (await api('DELETE', `/applications/${created.application.id}`, undefined, viewer.cookie))
        .statusCode,
    ).toBe(403);
  });
});
