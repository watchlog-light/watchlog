// SPDX-License-Identifier: AGPL-3.0-only
// The live demo's public MCP token (ADR-130): made from the seed file, offered by
// GET /setup, limited per visitor and in total, leaving no visitor address or call log,
// and refused outside demo mode.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { syncDemoMcpToken } from '../src/modules/demo/mcp-token.js';
import { ensureDemoUser } from '../src/modules/demo/service.js';
import { mcpCallLabel } from '../src/modules/mcp/routes.js';
import { insertCluster } from '../src/modules/clusters/service.js';
import type { Seed } from '../src/modules/seed/seed.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';

const TOKEN = 'wl_pat_demoPublicReadOnlyToken0123456789abcdefABCD';
const log = { info: () => {} };
let ctx: TestContext | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

async function demo(seed: Seed['demoMcp']) {
  ctx = await createTestContext(
    { demoMode: true, clientIpHeader: 'x-real-ip', trustedProxies: ['127.0.0.1/32'] },
    { seed: { demoMcp: seed } },
  );
  await ensureDemoUser(ctx.db);
  await syncDemoMcpToken(ctx.db, { demoMode: true, token: seed?.token }, log);
  const org = await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow();
  await insertCluster(ctx.db, org.id, 'demo', 'kubernetes');
  return new URL('/mcp', await ctx.app.listen({ port: 0, host: '127.0.0.1' }));
}

/** A visitor at an address, as the trusted proxy says. */
async function visitor(url: URL, ip: string) {
  const client = new Client(
    { name: 'visitor', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, 'x-real-ip': ip } },
    }),
  );
  clients.push(client);
  return async () => {
    const res = await client.callTool({ name: 'list_clusters', arguments: {} });
    return {
      isError: res.isError === true,
      data: JSON.parse((res.content as { text: string }[])[0]!.text) as Record<string, unknown>,
    };
  };
}

describe('the demo public MCP token', () => {
  it('is offered by GET /setup and reads the demo', async () => {
    await demo({ token: TOKEN });
    expect((await ctx!.app.inject({ method: 'GET', url: '/api/v1/setup' })).json()).toEqual({
      required: false,
      demoMode: true,
      demoMcpToken: TOKEN,
      smtp: false,
    });
    const me = await ctx!.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json()).toMatchObject({
      user: { email: 'demo@watchlog.invalid', role: 'viewer' },
      token: { name: 'Live demo: public MCP token', scope: 'read', expiresAt: null },
    });
  });

  it('allows a few calls per visitor and a total for everyone, with no trace of the visitor', async () => {
    const url = await demo({ token: TOKEN, visitorCallsPerMinute: 2, totalCallsPerMinute: 3 });
    const a = await visitor(url, '203.0.113.10');
    const b = await visitor(url, '198.51.100.20');
    expect((await a()).isError).toBe(false);
    expect((await a()).isError).toBe(false);
    expect(await a()).toMatchObject({
      isError: true,
      data: { error: 'Rate limited: the live demo allows 2 tool calls a minute per visitor.' },
    });
    // Another visitor is served, until the demo's total is used up.
    expect((await b()).isError).toBe(false);
    expect(await b()).toMatchObject({
      isError: true,
      data: {
        error: 'The live demo is busy: it answers 3 tool calls a minute in all.',
        retryAfterSeconds: expect.any(Number),
      },
    });
    // No call log, no last use, no address.
    expect(await ctx!.db.selectFrom('mcp_calls').selectAll().execute()).toEqual([]);
    const row = await ctx!.db
      .selectFrom('api_tokens')
      .select(['last_used_at', 'last_used_ip'])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ last_used_at: null, last_used_ip: null });
    expect(await ctx!.db.selectFrom('api_token_events').selectAll().execute()).toEqual([]);
  });

  it('labels each /mcp answer with its method and tool, for the demo access log', async () => {
    const url = await demo({ token: TOKEN });
    const call = (body: object) =>
      fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
      });
    const init = await call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'curl', version: '1' },
      },
    });
    expect(init.headers.get('x-watchlog-mcp')).toBe('initialize');
    const tool = await call({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_clusters', arguments: {} },
    });
    expect(tool.headers.get('x-watchlog-mcp')).toBe('tools/call list_clusters');
    expect(mcpCallLabel({ method: 'tools/call', params: { name: 'a b"c' } })).toBe('tools/call');
    expect(mcpCallLabel({ method: '\n<script>' })).toBeNull();
    expect(mcpCallLabel([{ method: 'tools/list' }])).toBeNull();
  });

  it('a new value replaces the old one, and outside demo mode there is none', async () => {
    await demo({ token: TOKEN });
    const NEW = TOKEN.replace('demoPublic', 'rotatedNew');
    await syncDemoMcpToken(ctx!.db, { demoMode: true, token: NEW }, log);
    const rows = await ctx!.db.selectFrom('api_tokens').select('prefix').execute();
    expect(rows).toEqual([{ prefix: 'wl_pat_rota' }]);
    await syncDemoMcpToken(ctx!.db, { demoMode: false, token: NEW }, log);
    expect(await ctx!.db.selectFrom('api_tokens').selectAll().execute()).toEqual([]);
  });

  it('is refused by a backend that is not in demo mode', async () => {
    ctx = await createTestContext({ demoMode: false });
    await ensureDemoUser(ctx.db);
    // As if the row were left over: the plugin refuses it anyway.
    await syncDemoMcpToken(ctx.db, { demoMode: true, token: TOKEN }, log);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
