// SPDX-License-Identifier: AGPL-3.0-only
// A server's and a Kubernetes node's network cards (0.16.0, ADR-233): sent in the agent's
// inventory snapshot, replaced per node with each snapshot that has them, kept per org.
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

async function setup(kind: 'server' | 'kubernetes') {
  ctx = await createTestContext();
  const cookie = await setupAdmin(ctx.app);
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/clusters',
    cookies: { wl_session: cookie },
    payload: { name: kind === 'server' ? 'fleet' : 'prod', kind },
  });
  const id = created.json().cluster.id as string;
  const token = created.json().token.value as string;
  const post = (body: object) =>
    ctx!.app.inject({
      method: 'POST',
      url: '/ingest/v1/objects',
      headers: {
        authorization: `Bearer ${token}`,
        'x-watchlog-agent': kind === 'server' ? 'web-1' : 'node-1',
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: gzipSync(JSON.stringify({ source: 'inventory', ...body })),
    });
  return { id, post };
}

const rows = (clusterId: string) =>
  ctx!.db
    .selectFrom('host_interfaces')
    .select(['node', 'name', 'mac', 'addresses', 'speed_mbps', 'up'])
    .where('cluster_id', '=', clusterId)
    .orderBy('name')
    .execute();

describe('network cards in the inventory', () => {
  for (const kind of ['server', 'kubernetes'] as const) {
    it(`${kind}: stored, replaced by the next snapshot, left alone by one without them`, async () => {
      const { id, post } = await setup(kind);
      const node = kind === 'server' ? 'web-1' : 'node-1';
      const first = await post({
        node,
        interfaces: [
          {
            name: 'eno1',
            mac: '3c:ec:ef:12:34:56',
            addresses: ['10.0.10.21'],
            speedMbps: 1000,
            up: true,
          },
          { name: 'eno2', mac: '3c:ec:ef:12:34:57', up: false },
        ],
      });
      expect(first.statusCode, first.body).toBe(204);
      expect(await rows(id)).toEqual([
        {
          node,
          name: 'eno1',
          mac: '3c:ec:ef:12:34:56',
          addresses: ['10.0.10.21'],
          speed_mbps: 1000,
          up: true,
        },
        {
          node,
          name: 'eno2',
          mac: '3c:ec:ef:12:34:57',
          addresses: [],
          speed_mbps: null,
          up: false,
        },
      ]);
      // A server's certificates-only snapshot (an older agent) leaves the cards as they are.
      expect((await post({ node })).statusCode).toBe(204);
      expect(await rows(id)).toHaveLength(2);
      // The next snapshot with cards replaces them.
      await post({ node, interfaces: [{ name: 'bond0', mac: '3c:ec:ef:00:00:01', up: true }] });
      expect((await rows(id)).map((r) => r.name)).toEqual(['bond0']);
    });
  }

  it("refuses what isn't a MAC address", async () => {
    const { post } = await setup('server');
    const r = await post({
      node: 'web-1',
      interfaces: [{ name: 'eno1', mac: 'not-a-mac', up: true }],
    });
    expect(r.statusCode).toBe(400);
  });
});
