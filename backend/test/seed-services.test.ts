// SPDX-License-Identifier: AGPL-3.0-only
// Services from the seed file (ADR-142): the demo's Redis and PostgreSQL are monitored as
// soon as the agents report them, with a password referenced from a Secret or a host file,
// once per cluster: a service someone stops monitoring stays stopped, and one monitored
// by hand without access gets the seeded access.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { loadSeedFile } from '../src/modules/seed/seed.js';
import { applySeedServices, type SeedService } from '../src/modules/seed/services.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

const SERVICES: SeedService[] = [
  { clusterKind: 'kubernetes', type: 'redis', name: 'shop/redis' },
  {
    clusterKind: 'kubernetes',
    type: 'postgres',
    name: 'shop/postgres',
    access: { username: 'watchlog', secret: { name: 'shop-postgres-watchlog', key: 'password' } },
    defaultAlerts: ['postgres_connections_high'],
  },
  { clusterKind: 'docker', type: 'redis', name: 'storefront/cache' },
  {
    clusterKind: 'docker',
    type: 'postgres',
    name: 'storefront/db',
    access: { username: 'watchlog', file: 'storefront-db' },
  },
];
const log = { info: () => {}, warn: () => {} };

describe('seeded services', () => {
  let ctx: TestContext;
  let cookie: string;
  beforeEach(async () => {
    ctx = await createTestContext();
    cookie = await setupAdmin(ctx.app);
    await ctx.db.updateTable('orgs').set({ plan: 'pro' }).execute();
  });
  afterEach(() => closeTestContext(ctx));

  const api = (method: string, url: string, payload?: object) =>
    ctx.app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      cookies: { wl_session: cookie },
      ...(payload ? { payload } : {}),
    });

  async function object(clusterId: string, o: Record<string, unknown>) {
    await ctx.db
      .insertInto('objects')
      .values({
        id: newId(),
        cluster_id: clusterId,
        source: o.kind === 'Pod' ? 'kubernetes' : 'docker',
        kind: o.kind as string,
        namespace: o.namespace as string,
        name: o.name as string,
        uid: newId().replace(/-/g, ''),
        node: (o.node as string) ?? 'n1',
        spec_summary: JSON.stringify(o.spec),
        status_summary: JSON.stringify(o.status),
      })
      .execute();
  }

  it('monitors the demo services once they are reported, once', async () => {
    const k8s = (await api('POST', '/clusters', { name: 'kind-demo', kind: 'kubernetes' })).json()
      .cluster.id as string;
    const docker = (await api('POST', '/clusters', { name: 'my-cluster', kind: 'docker' })).json()
      .cluster.id as string;
    // Nothing reported yet: nothing monitored, and nothing marked as done.
    expect((await applySeedServices(ctx.db, SERVICES, undefined, log)).monitored).toEqual([]);

    for (const [name, image] of [
      ['redis', 'redis:7-alpine'],
      ['postgres', 'postgres:16-alpine'],
    ]) {
      await object(k8s, {
        kind: 'Pod',
        namespace: 'shop',
        name: `${name}-0`,
        spec: { workload: { kind: 'StatefulSet', name }, containers: [{ image }] },
        status: { phase: 'Running', pod_ip: '10.244.0.5' },
      });
    }
    for (const [service, image] of [
      ['cache', 'redis:7-alpine'],
      ['db', 'postgres:16-alpine'],
    ]) {
      await object(docker, {
        kind: 'DockerContainer',
        namespace: 'storefront',
        name: `storefront-${service}-1`,
        node: 'lima-demo',
        spec: { image, compose_service: service, ips: ['172.18.0.3'] },
        status: { state: 'running' },
      });
    }
    // storefront/cache was monitored by hand already, with no password: it is kept.
    const manual = (
      await api('POST', '/applications', {
        clusterId: docker,
        type: 'redis',
        target: {
          kind: 'compose',
          host: 'lima-demo',
          compose_project: 'storefront',
          compose_service: 'cache',
          port: 6379,
        },
      })
    ).json().application.id as string;

    const r = await applySeedServices(ctx.db, SERVICES, undefined, log);
    expect(r.monitored.sort()).toEqual([
      'kind-demo shop/postgres',
      'kind-demo shop/redis',
      'my-cluster storefront/db',
    ]);
    const rows = await ctx.db
      .selectFrom('integrations as i')
      .leftJoin('integration_credentials as c', 'c.integration_id', 'i.id')
      .select(['i.id', 'i.name', 'i.collector_host', 'c.method', 'c.username', 'c.reference'])
      .orderBy('i.name')
      .execute();
    expect(rows.map((x) => [x.name, x.method, x.username, x.reference])).toEqual([
      [
        'shop/postgres',
        'reference',
        'watchlog',
        { secret: { namespace: 'watchlog', name: 'shop-postgres-watchlog', key: 'password' } },
      ],
      ['shop/redis', null, null, null],
      ['storefront/cache', null, null, null],
      ['storefront/db', 'reference', 'watchlog', { file: 'storefront-db' }],
    ]);
    expect(rows.find((x) => x.name === 'storefront/db')!.collector_host).toBe('lima-demo');
    expect(rows.find((x) => x.name === 'storefront/cache')!.id).toBe(manual);
    // Default rules for both PostgreSQL services.
    const rules = await ctx.db
      .selectFrom('alert_rules')
      .select(['default_key', 'enabled'])
      .where('default_key', '=', 'postgres_connections_high')
      .execute();
    // shop/postgres asks for it on; storefront/db gets it off.
    expect(rules.map((x) => x.enabled).sort()).toEqual([false, true]);

    // Applied once: stopping a seeded service keeps it stopped.
    const pg = rows.find((x) => x.name === 'shop/postgres')!.id;
    expect((await api('DELETE', `/applications/${pg}`)).statusCode).toBe(204);
    expect((await applySeedServices(ctx.db, SERVICES, undefined, log)).monitored).toEqual([]);
    expect(
      await ctx.db
        .selectFrom('integrations')
        .select('name')
        .where('name', '=', 'shop/postgres')
        .execute(),
    ).toEqual([]);
  });

  it('gives a service monitored by hand without access the seeded access', async () => {
    const docker = (await api('POST', '/clusters', { name: 'my-cluster', kind: 'docker' })).json()
      .cluster.id as string;
    const id = (
      await api('POST', '/applications', {
        clusterId: docker,
        type: 'postgres',
        target: {
          kind: 'compose',
          host: 'lima-demo',
          compose_project: 'storefront',
          compose_service: 'db',
          port: 5432,
        },
      })
    ).json().application.id as string;
    const r = await applySeedServices(ctx.db, SERVICES, undefined, log);
    expect(r.accessAdded).toEqual(['storefront/db']);
    const c = await ctx.db
      .selectFrom('integration_credentials')
      .select(['method', 'reference'])
      .where('integration_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(c).toEqual({ method: 'reference', reference: { file: 'storefront-db' } });
  });

  it('reads the demo seed file shipped with the repository', async () => {
    const seed = await loadSeedFile(
      new URL('../../deploy/test/demo/seed.json', import.meta.url).pathname,
    );
    expect(seed.services?.map((s) => `${s.clusterKind} ${s.type} ${s.name}`)).toEqual([
      'kubernetes redis shop/redis',
      'kubernetes postgres shop/postgres',
      'docker redis storefront/cache',
      'docker postgres storefront/db',
    ]);
  });
});
