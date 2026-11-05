// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/lib/tokens.js';
import { verifyClusterToken } from '../src/modules/clusters/tokens.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  type TestContext,
} from './helpers.js';

describe('clusters and tokens API', () => {
  let ctx: TestContext;
  let cookie: string;

  beforeEach(async () => {
    ctx = await createTestContext({ publicUrl: 'https://watchlog.example.com' });
    cookie = await setupAdmin(ctx.app);
  });

  afterEach(() => closeTestContext(ctx));

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    as = cookie,
  ) => ctx.app.inject({ method, url: `/api/v1${url}`, cookies: { wl_session: as }, payload });

  const createFleet = (name = 'prod-hosts') => call('POST', '/clusters', { name, kind: 'docker' });

  it('requires a session', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/clusters' });
    expect(res.statusCode).toBe(401);
  });

  it('creates a Docker fleet and returns its token once with the install command', async () => {
    const res = await createFleet();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.cluster).toMatchObject({
      name: 'prod-hosts',
      kind: 'docker',
      status: 'pending',
      nodeCount: 0,
    });
    expect(body.token.value).toMatch(/^wl_ct_[A-Za-z0-9_-]{43}$/);
    expect(body.token.prefix).toBe(body.token.value.slice(6, 14));
    expect(body.install.dockerRun).toContain(`WATCHLOG_TOKEN=${body.token.value}`);
    expect(body.install.dockerRun).toContain('WATCHLOG_ENDPOINT=https://watchlog.example.com');

    // Only the SHA-256 hash is stored, and later reads never include the value.
    const row = await ctx.db.selectFrom('cluster_tokens').selectAll().executeTakeFirstOrThrow();
    expect(row.token_hash.equals(sha256(body.token.value))).toBe(true);
    const detail = await call('GET', `/clusters/${body.cluster.id}`);
    expect(detail.json().tokens).toEqual([
      {
        id: body.token.id,
        prefix: body.token.prefix,
        createdAt: body.token.createdAt,
        revokedAt: null,
      },
    ]);
    expect(detail.body).not.toContain(body.token.value);
  });

  it('uses the request origin for the endpoint when no public URL is configured', async () => {
    await closeTestContext(ctx);
    ctx = await createTestContext();
    cookie = await setupAdmin(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      headers: { host: 'watchlog.lan:8080' },
      cookies: { wl_session: cookie },
      payload: { name: 'lab', kind: 'docker' },
    });
    expect(res.json().install.dockerRun).toContain('WATCHLOG_ENDPOINT=http://watchlog.lan:8080');
  });

  it('lists clusters', async () => {
    await createFleet();
    const res = await call('GET', '/clusters');
    expect(res.json().clusters.map((c: { name: string }) => c.name)).toEqual(['prod-hosts']);
  });

  it('validates names and kinds (docker or kubernetes)', async () => {
    expect((await createFleet('Prod Hosts')).statusCode).toBe(400);
    expect((await createFleet('-bad')).statusCode).toBe(400);
    expect((await createFleet('a'.repeat(64))).statusCode).toBe(400);
    expect((await call('POST', '/clusters', { name: 'swarm', kind: 'swarm' })).statusCode).toBe(
      400,
    );
  });

  it('allows one cluster in Community (ADR-039)', async () => {
    expect((await createFleet()).statusCode).toBe(201);
    const second = await createFleet('staging');
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ type: 'urn:watchlog:problem:cluster-limit' });
    expect(second.json().detail).toContain('one cluster or Docker fleet');
  });

  it('rejects duplicate names when the plan allows several clusters', async () => {
    await ctx.db.updateTable('orgs').set({ plan: 'pro' }).execute();
    expect((await createFleet()).statusCode).toBe(201);
    const duplicate = await createFleet();
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().type).toBe('urn:watchlog:problem:name-taken');
    expect((await createFleet('staging')).statusCode).toBe(201);
  });

  it('renames and deletes a cluster', async () => {
    const id = (await createFleet()).json().cluster.id;
    const renamed = await call('PATCH', `/clusters/${id}`, { name: 'production' });
    expect(renamed.json().cluster.name).toBe('production');
    expect((await call('DELETE', `/clusters/${id}`)).statusCode).toBe(204);
    expect((await call('GET', `/clusters/${id}`)).statusCode).toBe(404);
    expect(await ctx.db.selectFrom('cluster_tokens').selectAll().execute()).toEqual([]);
  });

  it('rotates without downtime: a new token works alongside the old until it is revoked', async () => {
    const created = (await createFleet()).json();
    const id = created.cluster.id;
    const old = created.token.value;

    const issued = await call('POST', `/clusters/${id}/tokens`);
    expect(issued.statusCode).toBe(201);
    const fresh = issued.json().token.value;
    expect(fresh).not.toBe(old);
    expect(issued.json().install.dockerRun).toContain(fresh);
    expect(await verifyClusterToken(ctx.db, old)).toMatchObject({ clusterId: id });
    expect(await verifyClusterToken(ctx.db, fresh)).toMatchObject({ clusterId: id });

    const revoke = await call('DELETE', `/clusters/${id}/tokens/${created.token.id}`);
    expect(revoke.statusCode).toBe(204);
    expect(await verifyClusterToken(ctx.db, old)).toBeNull();
    expect(await verifyClusterToken(ctx.db, fresh)).toMatchObject({ clusterId: id });
    // Revoking twice is fine.
    expect((await call('DELETE', `/clusters/${id}/tokens/${created.token.id}`)).statusCode).toBe(
      204,
    );

    const tokens = (await call('GET', `/clusters/${id}`)).json().tokens;
    expect(tokens.find((t: { id: string }) => t.id === created.token.id).revokedAt).not.toBeNull();
  });

  it('limits active tokens per cluster', async () => {
    const id = (await createFleet()).json().cluster.id;
    for (let i = 0; i < 4; i++)
      expect((await call('POST', `/clusters/${id}/tokens`)).statusCode).toBe(201);
    const limited = await call('POST', `/clusters/${id}/tokens`);
    expect(limited.statusCode).toBe(409);
    expect(limited.json().type).toBe('urn:watchlog:problem:token-limit');
  });

  it('rejects malformed, unknown and tampered tokens', async () => {
    const token: string = (await createFleet()).json().token.value;
    expect(await verifyClusterToken(ctx.db, '')).toBeNull();
    expect(await verifyClusterToken(ctx.db, 'wl_pat_' + token.slice(6))).toBeNull();
    expect(await verifyClusterToken(ctx.db, token.slice(0, -1))).toBeNull();
    // Same prefix, different secret.
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(await verifyClusterToken(ctx.db, tampered)).toBeNull();
  });

  it("hides other orgs' clusters", async () => {
    const id = (await createFleet()).json().cluster.id;
    const other = await createUserSession(ctx.db, { role: 'owner' });
    expect((await call('GET', '/clusters', undefined, other.cookie)).json().clusters).toEqual([]);
    expect((await call('GET', `/clusters/${id}`, undefined, other.cookie)).statusCode).toBe(404);
    expect((await call('PATCH', `/clusters/${id}`, { name: 'x' }, other.cookie)).statusCode).toBe(
      404,
    );
    expect((await call('DELETE', `/clusters/${id}`, undefined, other.cookie)).statusCode).toBe(404);
    expect((await call('POST', `/clusters/${id}/tokens`, undefined, other.cookie)).statusCode).toBe(
      404,
    );
  });

  it('lets viewers read but not change clusters', async () => {
    const id = (await createFleet()).json().cluster.id;
    const org = await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow();
    const viewer = await createUserSession(ctx.db, { role: 'viewer', orgId: org.id });
    expect((await call('GET', `/clusters/${id}`, undefined, viewer.cookie)).statusCode).toBe(200);
    expect(
      (await call('POST', `/clusters/${id}/tokens`, undefined, viewer.cookie)).statusCode,
    ).toBe(403);
    expect((await call('DELETE', `/clusters/${id}`, undefined, viewer.cookie)).statusCode).toBe(
      403,
    );
  });

  it('returns 404 for an unknown token id', async () => {
    const id = (await createFleet()).json().cluster.id;
    const res = await call('DELETE', `/clusters/${id}/tokens/01a18f0e-a6c2-71ef-a7b4-42d765746d40`);
    expect(res.statusCode).toBe(404);
  });
});
