// SPDX-License-Identifier: AGPL-3.0-only
// Change events from outside (1.0.0, ADR-238): POST /api/v1/events with an own-metrics token.
// A marker for charts and "Changed around then", a row in Events on what it belongs to,
// labelled with the token's name; rate-limited; never an alert.
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { readChanges } from '../src/modules/anomaly/story-read.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

let ctx: TestContext;
let cookie: string;
afterEach(() => closeTestContext(ctx));

const api = (method: string, url: string, payload?: object) =>
  ctx.app.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    cookies: { wl_session: cookie },
    ...(payload ? { payload } : {}),
  });
const send = (token: string, payload: object) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/events',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });

async function start(
  kind: 'kubernetes' | 'server',
  deps: Parameters<typeof createTestContext>[1] = {},
) {
  ctx = await createTestContext({}, deps);
  cookie = await setupAdmin(ctx.app);
  const made = (await api('POST', '/clusters', { name: 'prod', kind })).json();
  const clusterId = made.cluster.id as string;
  const token = (
    await api('POST', `/clusters/${clusterId}/own-metrics/tokens`, { name: 'your CI' })
  ).json().value as string;
  return { clusterId, token, clusterToken: made.token.value as string };
}

describe('change events from outside', () => {
  it('in a cluster: on the workload it names, in Events, on charts and around what changed', async () => {
    const { clusterId, token, clusterToken } = await start('kubernetes');
    await ctx.db
      .insertInto('objects')
      .values({
        id: newId(),
        cluster_id: clusterId,
        source: 'kubernetes',
        kind: 'Deployment',
        namespace: 'shop',
        name: 'orders',
        uid: newId(),
        spec_summary: '{}',
        status_summary: '{}',
      })
      .execute();
    const res = await send(token, {
      title: 'Deployed orders 2.15.0',
      workload: 'shop/orders',
      link: 'https://ci.example.com/runs/812',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ id: expect.any(String), belongsTo: 'shop/orders' });

    const now = Math.floor(Date.now() / 1000);
    const markers = (
      await api('GET', `/clusters/${clusterId}/change-markers?from=${now - 600}&to=${now + 60}`)
    ).json();
    expect(markers.markers).toMatchObject([
      {
        kind: 'external',
        target: 'Deployment/shop/orders',
        namespace: 'shop',
        details: {
          title: 'Deployed orders 2.15.0',
          what: 'deploy',
          source: 'your CI',
          link: 'https://ci.example.com/runs/812',
        },
      },
    ]);
    // A workload's charts ask for its own markers.
    const own = (
      await api(
        'GET',
        `/clusters/${clusterId}/change-markers?from=${now - 600}&to=${now + 60}&target=${encodeURIComponent('Deployment/shop/orders')}`,
      )
    ).json();
    expect(own.markers).toHaveLength(1);

    const events = (await api('GET', `/clusters/${clusterId}/events`)).json().events;
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain(
      'Deployed orders 2.15.0 · https://ci.example.com/runs/812',
    );
    expect(events[0]).toMatchObject({ reason: 'Deployed', type: 'Normal' });
    const row = await ctx.db.selectFrom('k8s_events').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      involved_kind: 'Change',
      involved_name: 'shop/orders',
      namespace: 'shop',
      reporting_controller: 'token "your CI"',
    });

    // What changed reads it as a change about that workload, in its own words.
    const changes = await readChanges(ctx.db, clusterId, Date.now() - 600_000, Date.now() + 60_000);
    expect(changes).toMatchObject([
      {
        kind: 'external',
        name: 'orders',
        namespace: 'shop',
        facts: { title: 'Deployed orders 2.15.0', what: 'deploy', source: 'your CI' },
      },
    ]);
    // It is a fact, never an alert.
    expect(await ctx.db.selectFrom('alert_states').select('id').execute()).toEqual([]);

    // Only an own-metrics token sends one.
    expect((await send(clusterToken, { title: 'x' })).statusCode).toBe(401);
    expect((await send(`wl_mt_${'x'.repeat(token.length - 6)}`, { title: 'x' })).statusCode).toBe(
      401,
    );
    const withSession = await api('POST', '/events', { title: 'x' });
    expect(withSession.statusCode).toBe(401);
    const none = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: { title: 'x' },
    });
    expect(none.statusCode).toBe(401);
  });

  it('on a fleet: on the server it names; one tied to nothing still shows in Events', async () => {
    const { clusterId, token } = await start('server');
    await ctx.db
      .insertInto('agent_instances')
      .values({
        id: newId(),
        cluster_id: clusterId,
        node: 'db-1',
        mode: 'docker',
        agent_version: '1',
        last_seen_at: new Date(),
      })
      .execute();
    const at = Math.floor(Date.now() / 1000) - 3600;
    const tied = await send(token, {
      title: 'Ran migration 0042',
      kind: 'migration',
      server: 'db-1',
      time: at,
    });
    expect(tied.json().belongsTo).toBe('db-1');
    const loose = await send(token, {
      title: 'Turned on new-checkout',
      kind: 'flag',
      time: new Date((at + 60) * 1000).toISOString(),
    });
    expect(loose.statusCode).toBe(201);
    expect(loose.json().belongsTo).toBeNull();
    const markers = await ctx.db
      .selectFrom('change_markers')
      .select(['target', 'ts', 'details'])
      .orderBy('ts')
      .execute();
    expect(markers.map((m) => m.target)).toEqual(['Node/db-1', 'External/your CI']);
    expect(markers[0]!.ts.getTime()).toBe(at * 1000);
    const rows = await ctx.db
      .selectFrom('k8s_events')
      .select(['reason', 'host', 'involved_name'])
      .orderBy('last_ts')
      .execute();
    expect(rows).toEqual([
      { reason: 'Migrated', host: 'db-1', involved_name: 'db-1' },
      { reason: 'FlagChanged', host: '', involved_name: 'your CI' },
    ]);
    const changes = await readChanges(ctx.db, clusterId, (at - 60) * 1000, Date.now());
    expect(changes[0]).toMatchObject({
      kind: 'external',
      host: 'db-1',
      facts: { what: 'migration' },
    });
  });

  it('refuses a body that isn’t an event, and a time too far away', async () => {
    const { token } = await start('kubernetes');
    const now = Math.floor(Date.now() / 1000);
    for (const bad of [
      {},
      { title: '' },
      { title: 'x', kind: 'incident' },
      { title: 'x', link: 'javascript:alert(1)' },
      { title: 'x', time: 'yesterday' },
      { title: 'x', time: now - 8 * 86400 },
      { title: 'x', time: now + 3600 },
    ]) {
      expect((await send(token, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await ctx.db.selectFrom('change_markers').select('id').execute()).toEqual([]);
  });

  it('is rate-limited per token, with Retry-After', async () => {
    const { token } = await start('kubernetes', {
      ingestBuckets: { changeEvents: { ratePerSec: 0.01, burst: 2 } },
    });
    expect((await send(token, { title: 'one' })).statusCode).toBe(201);
    expect((await send(token, { title: 'two' })).statusCode).toBe(201);
    const third = await send(token, { title: 'three' });
    expect(third.statusCode).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
  });
});
