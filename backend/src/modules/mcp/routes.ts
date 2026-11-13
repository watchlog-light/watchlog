// SPDX-License-Identifier: AGPL-3.0-only
// /mcp (ADR-127): the MCP server over Streamable HTTP, through the official SDK's
// createMcpHandler. It serves the 2026-07-28 protocol and, for clients still on the 2025
// versions, the SDK's stateless fallback: no server-held sessions, so any backend replica
// answers any request. Only API tokens get in (plugins/api-token.ts verifies them).
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { MCP_PATH } from '../api-tokens/scope.js';
import type { DemoMcpLimits } from '../demo/mcp-token.js';
import { ApiReader } from './reader.js';
import { buildMcpServer, type McpRequestContext } from './server.js';

export const MCP_TOKEN_MISSING =
  'The MCP server needs a WatchLog API token: send `Authorization: Bearer wl_pat_…` (Settings → API tokens).';

export interface McpRoutesOptions {
  db: Database;
  version: string;
  callsPerMinute: number;
  /** In demo mode: the public token's limits per visitor and in total (ADR-130). */
  demo?: DemoMcpLimits;
  now?: () => Date;
}

type LimitResult = Awaited<ReturnType<ReturnType<FastifyInstance['createRateLimit']>>>;

/** Seconds to wait when a rate limit refused the call; null when it was allowed. */
const retryAfter = (l: LimitResult): number | null =>
  !l.isAllowed && l.isExceeded ? l.ttlInSeconds : null;

/** The JSON-RPC method of an /mcp request, and the tool it calls: for the demo's access log. */
export function mcpCallLabel(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { method, params } = body as { method?: unknown; params?: { name?: unknown } };
  const safe = (v: unknown) =>
    typeof v === 'string' && /^[A-Za-z0-9_./-]{1,64}$/.test(v) ? v : null;
  const m = safe(method);
  if (!m) return null;
  const tool = m === 'tools/call' || m === 'prompts/get' ? safe(params?.name) : null;
  return tool ? `${m} ${tool}` : m;
}

export async function registerMcpRoutes(
  app: FastifyInstance,
  opts: McpRoutesOptions,
): Promise<void> {
  const now = opts.now ?? (() => new Date());
  const callLimit = app.createRateLimit({
    max: opts.callsPerMinute,
    timeWindow: 60_000,
    keyGenerator: (request) => `mcp-call:${request.apiToken!.id}`,
  });
  const demo = opts.demo;
  const visitorLimit = demo
    ? app.createRateLimit({
        max: demo.visitorCallsPerMinute,
        timeWindow: 60_000,
        keyGenerator: (request) => `mcp-demo-visitor:${request.clientIp}`,
      })
    : undefined;
  const totalLimit = demo
    ? app.createRateLimit({
        max: demo.totalCallsPerMinute,
        timeWindow: 60_000,
        keyGenerator: () => 'mcp-demo-total',
      })
    : undefined;
  const handler = createMcpHandler(
    (ctx) =>
      buildMcpServer((ctx.authInfo?.extra as { mcp: McpRequestContext }).mcp, {
        db: opts.db,
        version: opts.version,
        callsPerMinute: opts.callsPerMinute,
        now,
        log: app.log,
        funnel: app.funnel,
      }),
    {
      legacy: 'stateless',
      // 'auto': one JSON body, since the tools send no progress or log notifications.
      onerror: (err) => app.log.debug({ err: err.message }, 'MCP request refused'),
    },
  );
  app.addHook('onClose', () => handler.close());

  const serve = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.apiToken;
    if (!token || !request.user) {
      reply.header('www-authenticate', 'Bearer realm="WatchLog", scope="read"');
      return sendProblem(reply, 401, MCP_TOKEN_MISSING);
    }
    const mcp: McpRequestContext = {
      token,
      orgId: request.user.org.id,
      api: new ApiReader(app, request.headers.authorization!),
      takeCall: async () => {
        if (token.public && visitorLimit && totalLimit) {
          const visitor = retryAfter(await visitorLimit(request));
          if (visitor !== null) {
            return {
              allowed: false,
              retryAfterSeconds: visitor,
              limit: `Rate limited: the live demo allows ${demo!.visitorCallsPerMinute} tool calls a minute per visitor.`,
            };
          }
          const total = retryAfter(await totalLimit(request));
          if (total !== null) {
            return {
              allowed: false,
              retryAfterSeconds: total,
              limit: `The live demo is busy: it answers ${demo!.totalCallsPerMinute} tool calls a minute in all.`,
            };
          }
          return { allowed: true };
        }
        const wait = retryAfter(await callLimit(request));
        return wait !== null
          ? {
              allowed: false,
              retryAfterSeconds: wait,
              limit: `Rate limited: an API token may make ${opts.callsPerMinute} tool calls a minute.`,
            }
          : { allowed: true };
      },
      logCalls: !token.public,
    };
    const authInfo: AuthInfo = {
      token: token.prefix,
      clientId: token.id,
      scopes: [token.scope],
      extra: { mcp },
    };
    const headers = new Headers();
    for (const [k, v] of Object.entries(request.headers)) {
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    }
    const hasBody = request.method === 'POST' && request.body !== undefined;
    const res = await handler.fetch(
      new Request(`http://${request.host}${request.url}`, {
        method: request.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
      }),
      { authInfo, ...(hasBody ? { parsedBody: request.body } : {}) },
    );
    reply.code(res.status);
    const label = mcpCallLabel(request.body);
    if (label) reply.header('x-watchlog-mcp', label);
    res.headers.forEach((value, key) => {
      if (key !== 'content-length' && key !== 'transfer-encoding') reply.header(key, value);
    });
    return reply.send(Buffer.from(await res.arrayBuffer()));
  };

  const schema = { hide: true };
  app.post(MCP_PATH, { schema }, serve);
  // 2025 session operations: the stateless server answers 405, as the SDK decides.
  app.get(MCP_PATH, { schema }, serve);
  app.delete(MCP_PATH, { schema }, serve);
}
