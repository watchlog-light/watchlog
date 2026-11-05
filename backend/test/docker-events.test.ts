// SPDX-License-Identifier: AGPL-3.0-only
// Docker events (Docker parity): stored with the Kubernetes events, with their host;
// listed, faceted by host and Compose project, and summed up like Kubernetes events.
import { afterEach, describe, expect, it } from 'vitest';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(() => closeTestContext(ctx));

describe('Docker events', () => {
  it('are stored per host and listed, grouped and faceted like Kubernetes events', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: 'fleet', kind: 'docker' },
    });
    const id = created.json().cluster.id as string;
    const token = created.json().token.value as string;
    const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
    const ev = (
      host: string,
      name: string,
      reason: string,
      type: string,
      minAgo: number,
      over: object = {},
    ) => ({
      uid: `${host}:${name}:${reason}:${minAgo}`,
      host,
      involved: { kind: 'Container', name, uid: `${name}-${minAgo}` },
      type,
      reason,
      message: reason === 'Died' ? 'Exited with code 1' : reason,
      count: 1,
      first_ts: at(minAgo),
      last_ts: at(minAgo),
      reporting_controller: 'docker',
      ...over,
    });
    const post = (events: object[], agent: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/ingest/v1/events',
        headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': agent },
        payload: { events },
      });
    expect(
      (
        await post(
          [
            ev('h1', 'demo-web-1', 'Died', 'Warning', 5, { namespace: 'demo' }),
            // Re-created: a new container ID, the same name and host: the same row.
            ev('h1', 'demo-web-1', 'Died', 'Warning', 3, { namespace: 'demo' }),
            ev('h1', 'fx-crashloop', 'Died', 'Warning', 2),
            ev('h1', 'fx-crashloop', 'Started', 'Normal', 2),
          ],
          'h1',
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await post(
          [
            ev('h2', 'demo-web-1', 'Unhealthy', 'Warning', 1, { namespace: 'demo' }),
            {
              ...ev('h2', 'busybox:1.37', 'Pulled', 'Normal', 1),
              involved: { kind: 'Image', name: 'busybox:1.37' },
            },
          ],
          'h2',
        )
      ).statusCode,
    ).toBe(204);

    const get = async (url: string) => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/clusters/${id}${url}`,
        cookies: { wl_session: cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };
    const all = await get('/events?limit=50');
    expect(all.events).toHaveLength(5);
    const web = all.events.find(
      (e: { host: string; involvedName: string; reason: string }) =>
        e.host === 'h1' && e.involvedName === 'demo-web-1',
    );
    expect(web).toMatchObject({ count: 2, namespace: 'demo', involvedKind: 'Container' });

    const h2 = await get('/events?hosts=h2');
    expect(h2.events.map((e: { reason: string }) => e.reason).sort()).toEqual([
      'Pulled',
      'Unhealthy',
    ]);
    const standalone = await get('/events?ns=-&types=Warning');
    expect(standalone.events.map((e: { involvedName: string }) => e.involvedName)).toEqual([
      'fx-crashloop',
    ]);

    const now = Math.floor(Date.now() / 1000);
    const sum = await get(`/events/summary?from=${now - 3600}&to=${now}`);
    expect(sum.total).toBe(6);
    expect(sum.facets.hosts).toEqual([
      { value: 'h1', count: 4 },
      { value: 'h2', count: 2 },
    ]);
    expect(sum.facets.namespaces).toEqual(
      expect.arrayContaining([
        { value: 'demo', count: 3 },
        { value: '-', count: 3 },
      ]),
    );
    expect(sum.markers.map((m: { reason: string }) => m.reason)).toContain('Died');
  });
});
