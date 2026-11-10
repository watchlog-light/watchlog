// SPDX-License-Identifier: AGPL-3.0-only
// The read scope of API tokens (ADR-125), route by route. It is an allowlist: the routes
// tagged `public` (ADR-126). Every route the app registers is called with a token, for a
// Kubernetes cluster and a Docker fleet: anything not public answers 403 `token-scope`, and
// the public set is pinned below, so making a route public is a decision made here too.
import type { RouteOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { insertCluster } from '../src/modules/clusters/service.js';
import { tokenAllows } from '../src/modules/api-tokens/scope.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(() => closeTestContext(ctx));

const SAMPLE_ID = '01a18f0e-a6c2-71ef-a7b4-42d765746d40';

/** Everything a read token may call: the public API, its spec and the MCP server. */
const ALLOWED = [
  'DELETE /mcp',
  'GET /mcp',
  'POST /mcp',
  'GET /api/v1/alert-rules',
  'GET /api/v1/alerts',
  'GET /api/v1/alerts/:id',
  'GET /api/v1/alerts/:id/chart',
  'GET /api/v1/applications',
  'GET /api/v1/applications/:id',
  'GET /api/v1/applications/collectors',
  'GET /api/v1/applications/discovered',
  'GET /api/v1/causes',
  'GET /api/v1/clusters',
  'GET /api/v1/clusters/:id',
  'GET /api/v1/clusters/:id/change-markers',
  'GET /api/v1/clusters/:id/docker/containers',
  'GET /api/v1/clusters/:id/docker/hosts',
  'GET /api/v1/clusters/:id/events',
  'GET /api/v1/clusters/:id/events/summary',
  'GET /api/v1/clusters/:id/namespaces',
  'GET /api/v1/clusters/:id/nodes',
  'GET /api/v1/clusters/:id/nodes/:name',
  'GET /api/v1/clusters/:id/overview',
  'GET /api/v1/clusters/:id/pods',
  'GET /api/v1/clusters/:id/pods/:namespace/:name',
  'GET /api/v1/clusters/:id/service-map',
  'GET /api/v1/clusters/:id/service-map/edge',
  'GET /api/v1/clusters/:id/workloads',
  'GET /api/v1/health',
  'GET /api/v1/me',
  'GET /api/v1/openapi.json',
  'GET /api/v1/silences',
  'POST /api/v1/query/range',
];

async function walk(kind: 'kubernetes' | 'docker') {
  const routes: { method: string; url: string; tags?: string[] }[] = [];
  const onRoute = (r: RouteOptions) => {
    const tags = (r.schema as { tags?: string[] } | undefined)?.tags;
    for (const method of [r.method].flat()) routes.push({ method, url: r.url, tags });
  };
  ctx = await createTestContext(
    { apiTokenLimits: { restPerMinute: 10_000, mcpCallsPerMinute: 60 } },
    { onRoute },
  );
  const cookie = await setupAdmin(ctx.app);
  const orgId = (
    await ctx.app.inject({ method: 'GET', url: '/api/v1/me', cookies: { wl_session: cookie } })
  ).json().user.org.id;
  // Path parameters name a real cluster of this kind, so its routes answer for real.
  const cluster = await insertCluster(ctx.db, orgId, `walk-${kind}`, kind);
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/api-tokens',
    cookies: { wl_session: cookie },
    payload: { name: 'walk' },
  });
  const token = created.json().value as string;

  const allowed: string[] = [];
  for (const r of routes) {
    const url = r.url
      .replace('/clusters/:id', `/clusters/${cluster.id}`)
      .replace(/:[A-Za-z]+/g, (p) => (p === ':id' ? SAMPLE_ID : 'x'));
    const res = await ctx.app.inject({
      method: r.method as 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(r.method === 'GET' || r.method === 'HEAD' ? {} : { payload: {} }),
    });
    const name = `${r.method} ${r.url} (${kind})`;
    if (r.url.startsWith('/ingest/')) {
      // An API token is not an agent's token.
      expect(res.statusCode, name).toBe(401);
      continue;
    }
    // HEAD answers have no body: the header tells a scope refusal.
    const scopeRefusal =
      res.statusCode === 403 &&
      String(res.headers['www-authenticate'] ?? '').includes('insufficient_scope');
    if (tokenAllows('read', r)) {
      expect(scopeRefusal, `${name}: ${res.body}`).toBe(false);
      // Signed in as the token's user: never 401, never a server error.
      expect(res.statusCode, `${name}: ${res.body}`).not.toBe(401);
      expect(res.statusCode, `${name}: ${res.body}`).toBeLessThan(500);
      if (r.method !== 'HEAD') allowed.push(`${r.method} ${r.url}`);
    } else {
      expect(res.statusCode, name).toBe(403);
      expect(res.headers['content-type'], name).toMatch(/^application\/problem\+json/);
      expect(scopeRefusal, name).toBe(true);
      if (r.method !== 'HEAD') {
        expect(res.json().type, name).toBe('urn:watchlog:problem:token-scope');
      }
    }
  }
  return { routes, allowed, cluster, token, cookie };
}

describe('API token read scope', () => {
  for (const kind of ['kubernetes', 'docker'] as const) {
    it(`refuses every route outside the read scope (${kind} cluster)`, async () => {
      const { routes, allowed } = await walk(kind);
      // The app has many routes; an empty list would mean the hook saw nothing.
      expect(routes.length).toBeGreaterThan(90);
      expect(allowed.sort()).toEqual([...ALLOWED].sort());
      // Both kinds' pages are among them (ADR-124).
      expect(allowed).toContain('GET /api/v1/clusters/:id/docker/containers');
      expect(allowed).toContain('GET /api/v1/clusters/:id/workloads');
    });
  }

  it('allows only public reads: an untagged route or a public write stays closed', () => {
    const pub = ['public'];
    // A new GET route is closed until it is tagged public.
    expect(tokenAllows('read', { method: 'GET', url: '/api/v1/clusters/:id/new-page' })).toBe(
      false,
    );
    expect(
      tokenAllows('read', { method: 'GET', url: '/api/v1/settings/general', tags: ['settings'] }),
    ).toBe(false);
    expect(tokenAllows('read', { method: 'GET', url: '/api/v1/x', tags: pub })).toBe(true);
    expect(tokenAllows('read', { method: 'HEAD', url: '/api/v1/x', tags: pub })).toBe(true);
    // Public or not, a change is refused; only the chart query is read with POST.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(tokenAllows('read', { method, url: '/api/v1/x', tags: pub }), method).toBe(false);
    }
    expect(tokenAllows('read', { method: 'POST', url: '/api/v1/query/range', tags: pub })).toBe(
      true,
    );
    expect(tokenAllows('read', { method: 'POST', url: '/api/v1/query/range' })).toBe(false);
    // The spec itself, and the MCP server reserved for the read scope (v0.2 slice 4).
    expect(tokenAllows('read', { method: 'GET', url: '/api/v1/openapi.json' })).toBe(true);
    expect(tokenAllows('read', { method: 'POST', url: '/mcp' })).toBe(true);
    expect(tokenAllows('read', { method: 'GET', url: '/ingest/v1/write', tags: pub })).toBe(false);
  });

  it('shows no cluster token prefixes to an API token', async () => {
    const { cluster, token, cookie } = await walk('kubernetes');
    await ctx.db
      .insertInto('cluster_tokens')
      .values({
        id: SAMPLE_ID,
        cluster_id: cluster.id,
        token_hash: Buffer.alloc(32, 1),
        prefix: 'abcdefgh',
      })
      .execute();
    const url = `/api/v1/clusters/${cluster.id}`;
    const bySession = await ctx.app.inject({ method: 'GET', url, cookies: { wl_session: cookie } });
    expect(bySession.json().tokens).toHaveLength(1);
    const byToken = await ctx.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(byToken.statusCode).toBe(200);
    expect(byToken.json().tokens).toEqual([]);
    expect(byToken.body).not.toContain('abcdefgh');
  });
});
