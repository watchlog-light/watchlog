// SPDX-License-Identifier: AGPL-3.0-only
// Personal API tokens on requests (ADR-125). `Authorization: Bearer wl_pat_…` is checked
// before the session cookie, on every request and without a cache:
//   - a token and a session cookie on one request: 400, so it is never ambiguous which applies;
//   - unknown, expired or revoked: 401 with WWW-Authenticate: Bearer;
//   - outside the token's scope: 403 `token-scope` (modules/api-tokens/scope.ts);
//   - above 300 requests a minute per token (REST and /mcp): 429 with Retry-After;
//   - in-process reads of an MCP tool (lib/internal-call.ts) are neither limited nor recorded.
// Otherwise the request acts as the token's user in the token's org. Token requests skip
// the cookie CSRF check (plugins/csrf.ts): they carry no cookie a browser could add.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../db/index.js';
import { isInternalCall } from '../lib/internal-call.js';
import { ProblemType, sendProblem } from '../lib/problem.js';
import { SESSION_COOKIE } from '../modules/auth/sessions.js';
import { isTokenPath, MCP_PATH, tokenAllows } from '../modules/api-tokens/scope.js';
import { TokenUsage, verifyApiToken, type RequestToken } from '../modules/api-tokens/service.js';
import { storableIp } from '../modules/api-tokens/tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The API token this request was authenticated with; null for sessions. */
    apiToken: RequestToken | null;
  }
}

/** The credentials of an `Authorization: Bearer …` header, or undefined without one. */
export function bearerToken(request: FastifyRequest): string | undefined {
  const raw = request.headers.authorization;
  if (typeof raw !== 'string') return undefined;
  const match = /^Bearer(?:\s+(.*))?$/i.exec(raw.trim());
  return match ? (match[1] ?? '').trim() : undefined;
}

export const TOKEN_INVALID_MESSAGE = 'The API token is invalid, expired or revoked';
export const TOKEN_WITH_SESSION_MESSAGE = 'Send either an API token or a session cookie, not both';
export const TOKEN_SCOPE_MESSAGE = 'API tokens are read-only and cannot use this endpoint';

export interface ApiTokenAuthOptions {
  db: Database;
  /** REST requests per token and minute (ADR-125: 300). */
  restPerMinute: number;
  /** The demo's public token works only in demo mode (ADR-130). */
  demoMode?: boolean;
  now?: () => Date;
}

export function registerApiTokenAuth(app: FastifyInstance, opts: ApiTokenAuthOptions): void {
  const now = opts.now ?? (() => new Date());
  const usage = new TokenUsage(opts.db);
  // The shared rate-limit store, keyed by the token: one bucket per token, wherever it
  // comes from. Separate from route limits, which still key by the visitor.
  const restLimit = app.createRateLimit({
    max: opts.restPerMinute,
    timeWindow: 60_000,
    // The demo's public token is everyone's: one bucket per visitor (ADR-130).
    keyGenerator: (request) =>
      request.apiToken!.public
        ? `api-token:${request.apiToken!.id}:${request.clientIp}`
        : `api-token:${request.apiToken!.id}`,
  });

  app.decorateRequest('apiToken', null);
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isTokenPath(request.url)) return;
    const value = bearerToken(request);
    if (value === undefined) return;
    if (request.cookies[SESSION_COOKIE] !== undefined) {
      return sendProblem(reply, 400, TOKEN_WITH_SESSION_MESSAGE, ProblemType.tokenWithSession);
    }
    const at = now();
    const found = await verifyApiToken(opts.db, value, at);
    if (!found || (found.token.public && !opts.demoMode)) {
      reply.header('www-authenticate', 'Bearer error="invalid_token"');
      return sendProblem(reply, 401, TOKEN_INVALID_MESSAGE);
    }
    const route = request.routeOptions.url;
    const tags = (request.routeOptions.schema as { tags?: string[] } | undefined)?.tags;
    // No route: the 404 handler answers.
    if (
      route !== undefined &&
      !tokenAllows(found.token.scope, { method: request.method, url: route, tags })
    ) {
      reply.header('www-authenticate', 'Bearer error="insufficient_scope", scope="read"');
      return sendProblem(reply, 403, TOKEN_SCOPE_MESSAGE, ProblemType.tokenScope);
    }
    request.apiToken = found.token;
    request.user = found.user;

    // An MCP tool reading through the API in-process: the MCP call is counted and logged.
    if (isInternalCall(request)) return;
    const rest = !request.url.startsWith(MCP_PATH);
    // Every request, REST or MCP: tool calls have their own, lower limit on top (ADR-127).
    const limit = await restLimit(request);
    if (!limit.isAllowed && limit.isExceeded) {
      reply.header('retry-after', String(limit.ttlInSeconds));
      return sendProblem(
        reply,
        429,
        `An API token may make ${opts.restPerMinute} requests a minute. Retry in ${limit.ttlInSeconds} s.`,
      );
    }
    // The public token's visitors leave no address or use behind (ADR-130).
    if (found.token.public) return;
    try {
      await usage.record(
        found.token,
        { ip: storableIp(request.clientIp), country: request.clientCountry, rest },
        at,
      );
    } catch (err) {
      // The last use is bookkeeping: the request is served anyway.
      request.log.warn(
        { tokenPrefix: found.token.prefix, err: (err as Error).message },
        'could not record API token use',
      );
    }
  });
}
