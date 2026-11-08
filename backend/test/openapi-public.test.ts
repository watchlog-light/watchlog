// SPDX-License-Identifier: AGPL-3.0-only
// The public REST API (ADR-126). GET /api/v1/openapi.json serves only the routes tagged
// `public`, and it must match the committed snapshot (packages/api-types/
// openapi.public.json): a public route's request or response can't change without the
// spec changing with it, deliberately. Breaking changes are named, so they are never
// committed by accident.
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { tokenAllows } from '../src/modules/api-tokens/scope.js';
import { breakingChanges } from '../src/openapi/compat.js';
import { SNAPSHOT_PATH, snapshotOf } from '../src/openapi/public.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: Record<string, unknown>;
  security: unknown;
};

const snapshotFile = new URL(`../${SNAPSHOT_PATH}`, import.meta.url);

async function servedSpec(): Promise<Spec> {
  ctx = await createTestContext();
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const operations = (spec: Spec) =>
  Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, op]) => ({ path, method, op })),
  );

describe('public API spec', () => {
  it('matches the committed snapshot', async () => {
    const served = await servedSpec();
    expect(existsSync(snapshotFile), `missing ${SNAPSHOT_PATH}`).toBe(true);
    const committed = JSON.parse(readFileSync(snapshotFile, 'utf8')) as Spec;
    const current = snapshotOf(served) as Spec;
    if (JSON.stringify(current) === JSON.stringify(committed)) return;
    const breaking = breakingChanges(committed, current);
    const message = breaking.length
      ? 'Breaking changes to the public API (ADR-126): they need /api/v2 or a deprecation ' +
        'that lasted two minor versions.\n' +
        breaking.map((b) => `  - ${b}`).join('\n')
      : 'The public API changed (additions only): run `pnpm -C backend openapi:snapshot` ' +
        'and commit packages/api-types/openapi.public.json.';
    expect.fail(message);
  });

  it('lists only public routes a token may read, with the bearer scheme', async () => {
    const spec = await servedSpec();
    const ops = operations(spec);
    expect(ops.length).toBeGreaterThanOrEqual(24);
    expect(spec.components).toEqual({
      securitySchemes: { bearerAuth: expect.objectContaining({ type: 'http', scheme: 'bearer' }) },
    });
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
    for (const { path, method, op } of ops) {
      const name = `${method.toUpperCase()} ${path}`;
      // Internal routes never appear (ADR-126).
      expect(path, name).not.toMatch(
        /\/(setup|auth|demo|settings|alert-channels|api-tokens|ingest)(\/|$)/,
      );
      expect(op.tags, name).not.toContain('public');
      expect(op.security, name).toEqual([{ bearerAuth: [] }]);
      // A token may call it, by the same rule the guard applies.
      const url = path.replace(/\{(\w+)\}/g, ':$1');
      expect(
        tokenAllows('read', { method: method.toUpperCase(), url, tags: ['public'] }),
        name,
      ).toBe(true);
      // Every public route documents what it answers.
      const responses = op.responses as Record<string, { content?: Record<string, unknown> }>;
      const ok = Object.entries(responses).find(([status]) => status.startsWith('2'));
      expect(ok?.[1].content?.['application/json'], `${name}: no documented 2xx body`).toBeTruthy();
    }
  });

  it('is readable with an API token and without a session', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      cookies: { wl_session: cookie },
      payload: { name: 'spec' },
    });
    const token = created.json().value as string;
    const byToken = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/openapi.json',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(byToken.statusCode).toBe(200);
    expect(Object.keys(byToken.json().paths)).not.toContain('/api/v1/settings/general');
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(anonymous.json()).toEqual(byToken.json());
  });

  it('documents every API path the API page uses', async () => {
    const spec = await servedSpec();
    const doc = readFileSync(new URL('../../docs/site/api.md', import.meta.url), 'utf8');
    const used = new Set(
      [...doc.matchAll(/\/api\/v1(\/[A-Za-z0-9_\-/.$:{}]+)/g)].map((m) => m[1]!.replace(/\/$/, '')),
    );
    expect(used.size).toBeGreaterThan(8);
    const patterns = Object.keys(spec.paths).map(
      (p) => new RegExp(`^${p.replace('/api/v1', '').replace(/\{\w+\}/g, '[^/]+')}$`),
    );
    for (const path of used) {
      if (path === '/openapi.json') continue;
      const bare = path.split('?')[0]!;
      expect(
        patterns.some((re) => re.test(bare)),
        `docs/site/api.md uses ${path}, not in the public spec`,
      ).toBe(true);
    }
  });
});

describe('breaking changes between two specs', () => {
  type Schema = { properties: Record<string, Record<string, unknown>>; required: string[] };
  type Param = { name: string; in: string; required: boolean; schema: Record<string, unknown> };
  type Op = {
    parameters: Param[];
    responses: Record<string, { content: Record<string, { schema: Schema }> }>;
  };
  type Fixture = { paths: Record<string, { get: Op }> };

  const base: Fixture = {
    paths: {
      '/api/v1/x': {
        get: {
          parameters: [
            {
              name: 'range',
              in: 'query',
              required: false,
              schema: { type: 'integer', maximum: 604800 },
            },
          ],
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    properties: {
                      items: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: { name: { type: 'string' } },
                          required: ['name'],
                        },
                      },
                      status: { anyOf: [{ const: 'active' }, { const: 'pending' }] },
                      lastSeenAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    },
                    required: ['items', 'status', 'lastSeenAt'],
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const op = (f: Fixture) => f.paths['/api/v1/x']!.get;
  const body = (f: Fixture) => op(f).responses['200']!.content['application/json']!.schema;

  it('finds nothing between a spec and itself, or after additions', () => {
    expect(breakingChanges(base, base)).toEqual([]);
    const added = structuredClone(base);
    body(added).properties.extra = { type: 'number' };
    body(added).properties.status = {
      anyOf: [{ const: 'active' }, { const: 'pending' }, { const: 'paused' }],
    };
    added.paths['/api/v1/y'] = { get: op(base) };
    op(added).parameters.push({
      name: 'limit',
      in: 'query',
      required: false,
      schema: { type: 'integer' },
    });
    expect(breakingChanges(base, added)).toEqual([]);
  });

  it('names removed routes, fields, new requirements and narrower types', () => {
    expect(breakingChanges(base, { paths: {} })).toEqual(['GET /api/v1/x: removed']);
    const next = structuredClone(base);
    const schema = body(next);
    delete schema.properties.status;
    schema.properties.lastSeenAt = { type: 'number' };
    (schema.properties.items!.items as { required: string[] }).required = [];
    op(next).parameters = [
      { name: 'range', in: 'query', required: true, schema: { type: 'integer', maximum: 3600 } },
    ];
    expect(breakingChanges(base, next).sort()).toEqual(
      [
        'GET /api/v1/x 200.items[].name: no longer always sent',
        'GET /api/v1/x 200.lastSeenAt: type string|null became number',
        'GET /api/v1/x 200.status: removed',
        'GET /api/v1/x query range: maximum 604800 became 3600',
        'GET /api/v1/x: query parameter range now required',
      ].sort(),
    );
  });

  it('counts a field that may now be null as breaking', () => {
    const next = structuredClone(base);
    body(next).properties.items = { anyOf: [body(base).properties.items, { type: 'null' }] };
    expect(breakingChanges(base, next)).toEqual([
      'GET /api/v1/x 200.items: type array became array|null',
    ]);
  });
});

describe('GET /me', () => {
  it('names the API token a request came with, and none for a session', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      cookies: { wl_session: cookie },
      payload: { name: 'Claude Code', expiresInDays: 30 },
    });
    const { value, token } = created.json();
    const bySession = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: { wl_session: cookie },
    });
    expect(bySession.json().token).toBeNull();
    const byToken = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${value}` },
    });
    expect(byToken.statusCode).toBe(200);
    expect(byToken.json()).toEqual({
      user: bySession.json().user,
      token: {
        name: 'Claude Code',
        prefix: token.prefix,
        scope: 'read',
        expiresAt: token.expiresAt,
      },
    });
  });
});
