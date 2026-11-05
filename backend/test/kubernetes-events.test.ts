// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'kysely';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureEventPartitions } from '../src/modules/events/partitions.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

// Shaped like the cluster-agent's records for the kind fixtures (agent/internal/k8s):
// kubelet BackOff events carry the cumulative count of one Kubernetes Event object.
const now = new Date();
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const backoff = (uid: string, count: number, last = minutesAgo(1)) => ({
  uid,
  namespace: 'wl-test',
  involved: { kind: 'Pod', namespace: 'wl-test', name: 'crashloop', uid: 'pod-crashloop' },
  type: 'Warning',
  reason: 'BackOff',
  message: `Back-off restarting failed container main (${count})`,
  count,
  first_ts: minutesAgo(60),
  last_ts: last,
  reporting_controller: 'kubelet',
});

describe('Kubernetes events and change markers', () => {
  let ctx: TestContext;
  let token: string;
  let clusterId: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    await ctx.app.ready();
    const cookie = await setupAdmin(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: 'kind', kind: 'docker' },
    });
    token = res.json().token.value;
    clusterId = res.json().cluster.id;
  });
  afterEach(() => closeTestContext(ctx));

  const post = (path: string, body: object) =>
    ctx.app.inject({
      method: 'POST',
      url: `/ingest/v1/${path}`,
      headers: {
        authorization: `Bearer ${token}`,
        'x-watchlog-agent': 'cluster-agent',
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: gzipSync(JSON.stringify(body)),
    });
  const events = () =>
    ctx.db
      .selectFrom('k8s_events')
      .selectAll()
      .where('cluster_id', '=', clusterId)
      .orderBy('reason')
      .execute();

  it('keeps daily partitions from the retention start to three days ahead', async () => {
    const parts = await sql<{ n: number }>`
      select count(*)::int as n from pg_inherits i join pg_class p on p.oid = i.inhparent
      where p.relname = 'k8s_events'`.execute(ctx.db);
    expect(parts.rows[0]!.n).toBe(15 + 1 + 3);
    await sql`create table if not exists k8s_events_20000101 partition of k8s_events
      for values from ('2000-01-01') to ('2000-01-02')`.execute(ctx.db);
    const { dropped } = await ensureEventPartitions(ctx.db, 15);
    expect(dropped).toEqual(['k8s_events_20000101']);
  });

  it('de-duplicates by involved object and reason without counting re-sent events twice', async () => {
    expect(
      (await post('events', { events: [backoff('ev-1', 54), backoff('ev-2', 3)] })).statusCode,
    ).toBe(204);
    let rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reason: 'BackOff',
      type: 'Warning',
      count: 57,
      involved_kind: 'Pod',
      involved_name: 'crashloop',
    });

    // The agent restarts and re-sends both; then ev-2's count grows.
    await post('events', { events: [backoff('ev-1', 54), backoff('ev-2', 3)] });
    await post('events', { events: [backoff('ev-2', 7, minutesAgo(0))] });
    rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(61);
    expect(rows[0]!.message).toContain('(7)');

    // Past retention: skipped; a future timestamp (clock skew) lands on today.
    const old = {
      ...backoff('ev-3', 1, '2000-01-01T00:00:00Z'),
      first_ts: '2000-01-01T00:00:00Z',
      reason: 'Old',
    };
    const future = {
      ...backoff('ev-4', 1, new Date(now.getTime() + 2 * 86_400_000).toISOString()),
      reason: 'Skewed',
    };
    expect((await post('events', { events: [old, future] })).statusCode).toBe(204);
    expect((await events()).map((r) => r.reason)).toEqual(['BackOff', 'Skewed']);
  });

  it('rejects invalid event batches', async () => {
    expect((await post('events', { events: [{ ...backoff('x', 1), count: 0 }] })).statusCode).toBe(
      400,
    );
    expect(
      (
        await post('events', {
          events: Array.from({ length: 1001 }, (_, i) => backoff(`e${i}`, 1)),
        })
      ).statusCode,
    ).toBe(400);
  });

  it('derives rollout, image, scale, node and namespace markers from object changes', async () => {
    const dep = (revision: string, image: string, replicas: number) => ({
      kind: 'Deployment',
      uid: 'dep-web',
      namespace: 'wl-test',
      name: 'web',
      spec: { replicas, revision, containers: [{ name: 'nginx', image }] },
      status: {},
    });
    const node = (name: string, extra: object = {}) => ({
      kind: 'Node',
      uid: `node-${name}`,
      name,
      node: name,
      spec: {},
      status: {},
      ...extra,
    });
    const objects = (kind: string, objs: object[], extra: object = {}) =>
      post('objects', { source: 'kubernetes', kind, snapshot_id: 's1', objects: objs, ...extra });

    // A first snapshot is not a change.
    await objects('snapshot', [dep('1', 'nginx:1.29', 2), node('a')], {
      final: true,
      kinds: ['Deployment', 'Node'],
    });
    await objects('delta', [dep('2', 'nginx:1.30', 2)]);
    await objects('delta', [dep('2', 'nginx:1.30', 3)]);
    await objects('delta', [node('b'), { ...node('a'), deleted: true }]);
    // A namespace created after the first snapshot (ADR-110); the delta must be stored.
    const created = await objects('delta', [
      { kind: 'Namespace', uid: 'ns-shop', name: 'shop', spec: {}, status: {} },
    ]);
    expect(created.statusCode, created.body).toBe(204);
    const markers = await ctx.db
      .selectFrom('change_markers')
      .select(['kind', 'target', 'details'])
      .where('cluster_id', '=', clusterId)
      .orderBy('created_at')
      .orderBy('kind')
      .orderBy('target')
      .execute();
    expect(markers.map((m) => `${m.kind} ${m.target}`)).toEqual([
      'image Deployment/wl-test/web',
      'rollout Deployment/wl-test/web',
      'scale Deployment/wl-test/web',
      'node Node/a',
      'node Node/b',
      'namespace Namespace/shop',
    ]);
    expect(markers[0]!.details).toEqual({ from: ['nginx=nginx:1.29'], to: ['nginx=nginx:1.30'] });
    expect(markers[2]!.details).toEqual({ from: 2, to: 3 });
    expect(
      markers
        .slice(3, 5)
        .map((m) => (m.details as { action: string }).action)
        .sort(),
    ).toEqual(['added', 'removed']);
    expect(markers[5]!.details).toEqual({ action: 'created' });
  });
});
