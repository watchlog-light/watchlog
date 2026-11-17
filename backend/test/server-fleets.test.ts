// SPDX-License-Identifier: AGPL-3.0-only
// Server fleets replace Docker fleets (ADR-207): the migration keeps every row, the API
// answers `server` and still takes `docker` as an input, and the seed file takes either.
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeKind } from '../src/modules/clusters/schemas.js';
import { applySeed } from '../src/modules/seed/seed.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

const MIGRATION = readFileSync(
  new URL('../migrations/1796100000000_server-fleets.sql', import.meta.url),
  'utf8',
);

describe('the kind migration (ADR-207)', () => {
  it('turns a 0.8 Docker fleet into a Server fleet and keeps its id, tokens and rules', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: 'edge-fleet', kind: 'server' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ cluster: { id: string } }>().cluster.id;
    const tokensBefore = await ctx.db
      .selectFrom('cluster_tokens')
      .select('id')
      .where('cluster_id', '=', id)
      .execute();
    expect(tokensBefore).toHaveLength(1);

    // As a 0.8 database holds it.
    await sql`ALTER TABLE clusters DROP CONSTRAINT clusters_kind_check`.execute(ctx.db);
    await sql`UPDATE clusters SET kind = 'docker' WHERE id = ${id}`.execute(ctx.db);
    await sql.raw(MIGRATION.replace(/^-- Up Migration\n/, '')).execute(ctx.db);

    const row = await ctx.db
      .selectFrom('clusters')
      .select(['id', 'kind', 'name'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ id, kind: 'server', name: 'edge-fleet' });
    const tokensAfter = await ctx.db
      .selectFrom('cluster_tokens')
      .select('id')
      .where('cluster_id', '=', id)
      .execute();
    expect(tokensAfter).toEqual(tokensBefore);
    // The CHECK is back, and refuses the old name.
    await expect(
      sql`UPDATE clusters SET kind = 'docker' WHERE id = ${id}`.execute(ctx.db),
    ).rejects.toThrow(/clusters_kind_check/);
  });
});

describe('docker as an input alias of server (ADR-207)', () => {
  it('creates a Server fleet from kind docker and answers server everywhere', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: 'old-script', kind: 'docker' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ cluster: { name: 'old-script', kind: 'server' } });
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
    });
    expect(list.json<{ clusters: { name: string; kind: string }[] }>().clusters).toEqual([
      expect.objectContaining({ name: 'old-script', kind: 'server' }),
    ]);
    // Anything else is still refused.
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: 'nope', kind: 'podman' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('normalizes the kind of a seed file written for 0.8', async () => {
    expect(normalizeKind('docker')).toBe('server');
    expect(normalizeKind('server')).toBe('server');
    expect(normalizeKind('kubernetes')).toBe('kubernetes');
    ctx = await createTestContext();
    await setupAdmin(ctx.app);
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    await applySeed(
      ctx.db,
      {
        clusters: [
          {
            name: 'demo-docker',
            kind: 'docker',
            tokenSha256: 'a'.repeat(64),
            tokenPrefix: 'abcdefgh',
          },
        ],
      } as never,
      log as never,
    );
    const row = await ctx.db
      .selectFrom('clusters')
      .select(['kind'])
      .where('name', '=', 'demo-docker')
      .executeTakeFirst();
    expect(row?.kind).toBe('server');
  });
});
