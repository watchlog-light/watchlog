// SPDX-License-Identifier: AGPL-3.0-only
// GET /api/v1/clusters/:id/right-sizing (ADR-168) on the kind fixtures: sign-in, 404, the
// answer's shape, system namespaces left out unless asked, the filters, and a workload with
// no history listed under notEnoughHistory rather than judged.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';
import { container, dockerFleet, kindCluster } from './support/mcp-fixtures.js';

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

const get = (cookie: string | null, url: string) =>
  ctx!.app.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    ...(cookie ? { cookies: { wl_session: cookie } } : {}),
  });

describe('GET /clusters/:id/right-sizing', () => {
  it('answers with codes and facts, and lists workloads without history apart', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const kube = await kindCluster(ctx, cookie);
    expect((await get(null, `/clusters/${kube.id}/right-sizing`)).statusCode).toBe(401);
    expect((await get(cookie, `/clusters/${randomUUID()}/right-sizing`)).statusCode).toBe(404);

    const res = await get(cookie, `/clusters/${kube.id}/right-sizing`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.window).toEqual({ hours: 168, minHistoryHours: 24 });
    expect(body.hints).toEqual([]);
    expect(body.summary).toEqual({
      objects: 0,
      giveBackObjects: 0,
      giveBack: { cores: 0, bytes: 0 },
      oomRisk: 0,
    });
    const names = body.notEnoughHistory.map(
      (n: { object: { namespace: string; name: string }; container: string }) =>
        `${n.object.namespace}/${n.object.name}/${n.container}`,
    );
    expect(names).toContain('wl-test/web/nginx');
    expect(names.some((n: string) => n.startsWith('kube-system/'))).toBe(false);
    expect(body.notEnoughHistory[0]).toMatchObject({ hours: 0, needed: 24 });

    const all = (await get(cookie, `/clusters/${kube.id}/right-sizing?system=true`)).json();
    expect(
      all.notEnoughHistory.some(
        (n: { object: { namespace: string } }) => n.object.namespace === 'kube-system',
      ),
    ).toBe(true);
    const one = (
      await get(cookie, `/clusters/${kube.id}/right-sizing?namespace=wl-test&workload=web`)
    ).json();
    expect(
      new Set(one.notEnoughHistory.map((n: { object: { name: string } }) => n.object.name)),
    ).toEqual(new Set(['web']));
  });

  it('answers for a Docker fleet', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const fleet = await dockerFleet(ctx, cookie, { 'docker-01': [container('a', 'shop-web-1')] });
    const res = await get(cookie, `/clusters/${fleet.id}/right-sizing?host=docker-01`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hints: [], notEnoughHistory: [] });
  });
});
