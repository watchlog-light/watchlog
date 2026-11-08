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
import { ApiReader } from './reader.js';
import { buildMcpServer, type McpRequestContext } from './server.js';

export const MCP_TOKEN_MISSING =
  'The MCP server needs a WatchLog API token: send `Authorization: Bearer wl_pat_…` (Settings → API tokens).';

export interface McpRoutesOptions {
  db: Database;
  version: string;
  callsPerMinute: number;
  now?: () => Date;
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
  const handler = createMcpHandler(
    (ctx) =>
      buildMcpServer((ctx.authInfo?.extra as { mcp: McpRequestContext }).mcp, {
        db: opts.db,
        version: opts.version,
        callsPerMinute: opts.callsPerMinute,
        now,
        log: app.log,
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
        const limit = await callLimit(request);
        return !limit.isAllowed && limit.isExceeded
          ? { allowed: false, retryAfterSeconds: limit.ttlInSeconds }
          : { allowed: true };
      },
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
