// SPDX-License-Identifier: AGPL-3.0-only
// Read-only demo mode (ADR-122): one hook refuses every change, for every user, admins
// included. Only reads, the demo sign-in, sign-out and the agents' ingest get through.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../db/index.js';
import { isInternalCall } from '../lib/internal-call.js';
import { PROBLEM_CONTENT_TYPE, ProblemType, problem, sendProblem } from '../lib/problem.js';
import { SESSION_COOKIE } from '../modules/auth/sessions.js';
import {
  DEMO_READ_ONLY_CODE,
  DEMO_READ_ONLY_MESSAGE,
  DEMO_SESSION_REFRESH_MS,
} from '../modules/demo/constants.js';
import { findDemoUser, type DemoSessions } from '../modules/demo/service.js';
import { MAX_POINTS } from '../modules/query/catalog.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Requests other than GET/HEAD/OPTIONS that demo mode still serves, by route pattern.
 * Each one changes nothing a visitor could see or abuse.
 */
export const DEMO_ALLOWED: readonly { method: string; url: string; why: string }[] = [
  { method: 'POST', url: '/api/v1/demo/session', why: 'starts a read-only demo session' },
  { method: 'POST', url: '/api/v1/auth/logout', why: 'ends the session of whoever asks' },
  {
    method: 'POST',
    url: '/api/v1/query/range',
    why: 'a read: chart queries are POSTed for their JSON body',
  },
  {
    method: 'POST',
    url: '/mcp',
    why: 'the MCP server: its tools only read (ADR-127), the public demo token uses it (ADR-130)',
  },
];
/** Every route under this prefix is the agents' (token-authenticated) ingest. */
export const DEMO_ALLOWED_PREFIX = '/ingest/';

/** GET routes with side effects, refused in demo mode like a change. */
export const DEMO_BLOCKED_READS: readonly string[] = [
  // Makes an outbound request to the Telegram Bot API on every call.
  '/api/v1/settings/telegram/reachability',
];

/** Whether demo mode refuses this request (route pattern, not the raw URL). */
export function isDemoBlocked(method: string, routeUrl: string | undefined): boolean {
  if (routeUrl === undefined) return false; // no route: the 404 handler answers
  if (SAFE_METHODS.has(method)) return DEMO_BLOCKED_READS.includes(routeUrl);
  if (routeUrl.startsWith(DEMO_ALLOWED_PREFIX)) return false;
  return !DEMO_ALLOWED.some((a) => a.method === method && a.url === routeUrl);
}

/** The demo's 403: an RFC 9457 problem that also carries `code` and `message`. */
export function demoReadOnlyBody(instance: string) {
  return {
    ...problem(403, DEMO_READ_ONLY_MESSAGE, instance, ProblemType.demoReadOnly),
    code: DEMO_READ_ONLY_CODE,
    message: DEMO_READ_ONLY_MESSAGE,
  };
}

export function registerDemoGuard(app: FastifyInstance, enabled: boolean): void {
  if (!enabled) return;
  // onRequest: before authentication, rate limits and body parsing.
  app.addHook('onRequest', async (request, reply) => {
    if (!isDemoBlocked(request.method, request.routeOptions.url)) return;
    // Serialised here: a route's own 403 schema would drop `code` and `message`.
    return reply
      .code(403)
      .type(PROBLEM_CONTENT_TYPE)
      .send(JSON.stringify(demoReadOnlyBody(request.url)));
  });
}

// ---------------------------------------------------------------- sessions

/**
 * The demo cookie: the normal session cookie's name and attributes (HttpOnly,
 * SameSite=Lax, Secure when the request came over https, ADR-123).
 */
export function setDemoCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: request.secureCookie,
    expires: expiresAt,
  });
}

/**
 * Signs visitors in from a valid demo cookie (no database row). Renews the cookie at most
 * every 10 minutes, so it ends 2 hours after the last request. Out of demo mode a demo
 * cookie is not recognised, and requireUser answers 401 for it.
 */
export function registerDemoSessions(
  app: FastifyInstance,
  opts: { db: Database; sessions: DemoSessions },
): void {
  app.addHook('onRequest', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const now = Date.now();
    const valid = opts.sessions.verify(token, now);
    if (!valid) return;
    const user = await findDemoUser(opts.db);
    if (!user) return;
    request.user = user;
    if (now - valid.issuedAt > DEMO_SESSION_REFRESH_MS) {
      const renewed = opts.sessions.issue(now);
      setDemoCookie(request, reply, renewed.token, renewed.expiresAt);
    }
  });
}

// ---------------------------------------------------------------- query cost

/** The longest range a demo request may ask for, in seconds. */
export const DEMO_MAX_RANGE_S = 86_400;
/** How far a client's clock may run behind the server's. */
const CLOCK_SLACK_S = 15 * 60;
export const DEMO_RANGE_MESSAGE = 'The demo shows at most the last 24 hours.';
export const DEMO_STEP_MESSAGE = `The demo draws at most ${MAX_POINTS} points per series; ask for a larger step.`;
/** Requests per minute per visitor to the routes that query VictoriaMetrics. */
export const DEMO_QUERY_RATE = 120;

/** Routes that query VictoriaMetrics: they share one rate limit per visitor in the demo. */
export const DEMO_QUERY_ROUTES: readonly string[] = [
  'POST /api/v1/query/range',
  'GET /api/v1/alerts/:id/chart',
  'GET /api/v1/clusters/:id/overview',
  'GET /api/v1/clusters/:id/nodes',
  'GET /api/v1/clusters/:id/nodes/:name',
  'GET /api/v1/clusters/:id/workloads',
  'GET /api/v1/clusters/:id/pods',
  'GET /api/v1/clusters/:id/pods/:namespace/:name',
  'GET /api/v1/clusters/:id/docker/hosts',
  'GET /api/v1/clusters/:id/docker/containers',
  'GET /api/v1/clusters/:id/service-map',
  'GET /api/v1/clusters/:id/service-map/edge',
  // Probable cause reads several of the above in-process (ADR-155).
  'GET /api/v1/causes',
];

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Why a demo request asks for too much, or null. Every `range`, `from`/`to` and `step` a
 * request can carry, in its query string or JSON body (unix seconds): at most the last
 * 24 hours, and at most MAX_POINTS points per series.
 */
export function demoRangeProblem(sources: unknown[], nowS = Date.now() / 1000): string | null {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    const o = src as Record<string, unknown>;
    const range = num(o.range);
    if (range !== undefined && range > DEMO_MAX_RANGE_S) return DEMO_RANGE_MESSAGE;
    const from = num(o.from);
    const to = num(o.to);
    if (from !== undefined) {
      if ((to ?? nowS) - from > DEMO_MAX_RANGE_S) return DEMO_RANGE_MESSAGE;
      if (nowS - from > DEMO_MAX_RANGE_S + CLOCK_SLACK_S) return DEMO_RANGE_MESSAGE;
    }
    const step = num(o.step);
    if (step !== undefined && from !== undefined && to !== undefined && step > 0) {
      if ((to - from) / step > MAX_POINTS) return DEMO_STEP_MESSAGE;
    }
  }
  return null;
}

/**
 * Keeps the public's queries small (ADR-122): ranges of at most 24 hours (400), and one
 * rate limit per visitor for every route that queries VictoriaMetrics (429). The query
 * timeout is the VictoriaMetrics client's (10 s in demo mode).
 */
export function registerDemoQueryLimits(app: FastifyInstance): void {
  const limit = app.rateLimit({
    max: DEMO_QUERY_RATE,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) => `demo-query:${request.clientIp}`,
  });
  const queryRoutes = new Set(DEMO_QUERY_ROUTES);
  app.addHook('onRequest', async (request, reply) => {
    // An in-process read (MCP, probable cause) is part of a request already counted: the
    // visitor's, not the backend's own address shared by every visitor.
    if (isInternalCall(request)) return;
    if (queryRoutes.has(`${request.method} ${request.routeOptions.url}`)) {
      await limit.call(app, request, reply);
    }
  });
  // After validation: query strings are numbers by now.
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const why = demoRangeProblem([request.query, request.body]);
    if (why) return sendProblem(reply, 400, why);
  });
}

// ---------------------------------------------------------------- hidden facts

/**
 * Facts the demo never shows (ADR-122): the kernel version. The demo's nodes are
 * containers on a shared host, so their kernel is the host's, and its exact version tells
 * a visitor the host's patch level. Blanked in every JSON answer: the dashboard, the REST
 * API and the MCP tools, which read through the API.
 */
export const DEMO_HIDDEN_KEYS = ['kernelVersion'] as const;
const HIDDEN = new RegExp(`"(${DEMO_HIDDEN_KEYS.join('|')})":"(?:[^"\\\\]|\\\\.)*"`, 'g');

export function registerDemoHiddenFacts(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    if (typeof payload !== 'string') return payload;
    if (!String(reply.getHeader('content-type') ?? '').includes('json')) return payload;
    return payload.replace(HIDDEN, '"$1":null');
  });
}
