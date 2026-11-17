// SPDX-License-Identifier: AGPL-3.0-only
// The demo's shared answer cache, single-flight and load shedding (ADR-206). Demo mode only:
// every demo visitor is the same read-only viewer of the same org (ADR-122), so one answer
// serves them all. Community and Cloud never register this; Cloud is multi-tenant, and an
// answer cache across requests there would be a cross-org leak.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isInternalCall } from '../lib/internal-call.js';
import { PROBLEM_CONTENT_TYPE, ProblemType, problem } from '../lib/problem.js';
import { DEMO_USER_EMAIL } from '../modules/demo/constants.js';
import { chooseStep } from '../modules/query/catalog.js';

/**
 * Whether this backend may share answers across requests: demo mode, and never Cloud, even
 * if demo mode were switched on there (Cloud is multi-tenant). Community without demo mode
 * never caches either.
 */
export const demoCacheEnabled = (config: { demoMode: boolean; edition: string }): boolean =>
  config.demoMode && config.edition !== 'cloud';

/** One stored or shared answer: never a header other than its content type. */
export interface CachedAnswer {
  status: number;
  contentType: string;
  body: string;
  /** Only on a shared (not stored) 429 or 503: when to try again. */
  retryAfter?: string;
}

interface Entry {
  answer: CachedAnswer;
  expiresAt: number;
  bytes: number;
}

/** The longest answer kept, in bytes: a bigger one is shared in flight but not stored. */
export const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
/** Seconds a shed request is asked to wait. */
export const DEMO_BUSY_RETRY_AFTER_S = 5;
export const DEMO_BUSY_MESSAGE =
  'The live demo is busy right now. It retries by itself in a few seconds.';
/** Response header for the load test and the runbook: hit, shared or miss. */
export const DEMO_CACHE_HEADER = 'x-watchlog-demo-cache';

export interface AnswerCacheStats {
  hits: number;
  shared: number;
  misses: number;
  shed: number;
  entries: number;
  bytes: number;
}

/**
 * A memory-capped LRU of answers with a time-to-live, on an injected clock. A Map keeps
 * insertion order: a hit moves its entry to the end, and the oldest entries go first when
 * the bytes exceed the cap.
 */
export class AnswerCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): CachedAnswer | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.delete(key, e);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.answer;
  }

  set(key: string, answer: CachedAnswer, ttlMs: number): boolean {
    const bytes = Buffer.byteLength(answer.body) + key.length;
    if (bytes > MAX_ANSWER_BYTES || bytes > this.maxBytes) return false;
    const old = this.entries.get(key);
    if (old) this.delete(key, old);
    this.entries.set(key, { answer, expiresAt: this.now() + ttlMs, bytes });
    this.bytes += bytes;
    for (const [k, e] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.delete(k, e);
    }
    return true;
  }

  size(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.bytes };
  }

  private delete(key: string, e: Entry): void {
    this.entries.delete(key);
    this.bytes -= e.bytes;
  }
}

/** A JSON value with its object keys sorted, so equal requests make equal keys. */
export function stableJson(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Rounds a request's absolute range (`from`/`to`, unix seconds) down to the bucket, or to the
 * query's step when that is larger, in place: the handler then answers for the rounded range,
 * and the key names it. VictoriaMetrics aligns a range to its step anyway. Integers stay
 * integers. A range shorter than the unit keeps one unit.
 */
export function roundRange(src: unknown, bucketS: number, rangeQuery: boolean): void {
  if (!src || typeof src !== 'object') return;
  const o = src as Record<string, unknown>;
  const { from, to } = o;
  if (!isNum(from) && !isNum(to)) return;
  let unit = bucketS;
  if (isNum(o.step) && o.step > unit) unit = o.step;
  if (rangeQuery && isNum(from) && isNum(to) && to > from) {
    unit = Math.max(unit, chooseStep(to - from, isNum(o.step) ? o.step : undefined));
  }
  const down = (v: number) => Math.floor(v / unit) * unit;
  if (isNum(from)) o.from = down(from);
  if (isNum(to)) o.to = down(to);
  if (isNum(o.from) && isNum(o.to) && o.to <= o.from) o.to = o.from + unit;
}

/** Routes that never go through the cache: sessions and sign-in. */
const NEVER = ['/api/v1/auth/', '/api/v1/demo/'];
const RANGE_QUERY = '/api/v1/query/range';

export interface DemoCacheOptions {
  /** The cache bucket, seconds (ADR-206: 15 by default). */
  bucketS: number;
  /** The stored answers' cap, bytes. */
  maxBytes: number;
  /** Cache misses to the VictoriaMetrics-backed routes that may run at once. */
  maxUpstream: number;
  /** `METHOD /route/:pattern` of the routes that query VictoriaMetrics. */
  upstreamRoutes: readonly string[];
  /** The visitor's VictoriaMetrics rate limit, applied to misses only (sends its own 429). */
  limit?: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  now?: () => number;
}

interface RequestState {
  key: string;
  upstream: boolean;
  settled: boolean;
  /** A visitor's own 429: never shared with the requests waiting on this one. */
  ownAnswer?: boolean;
  resolve: (a: CachedAnswer | null) => void;
}

declare module 'fastify' {
  interface FastifyRequest {
    demoCache?: RequestState;
  }
  interface FastifyInstance {
    /** Set only where the demo's answer cache is registered (tests prove where it isn't). */
    demoCacheOn?: boolean;
  }
}

/** Whether a request may be served from, or into, the shared cache. */
function cacheable(request: FastifyRequest): boolean {
  const user = request.user;
  if (!user || user.email !== DEMO_USER_EMAIL) return false;
  const url = request.url;
  if (!url.startsWith('/api/v1/')) return false;
  if (NEVER.some((p) => url.startsWith(p))) return false;
  if ((request.headers.accept ?? '').includes('text/event-stream')) return false;
  if (request.method === 'GET') return true;
  return request.method === 'POST' && request.routeOptions.url === RANGE_QUERY;
}

function send(reply: FastifyReply, answer: CachedAnswer, how: 'hit' | 'shared'): FastifyReply {
  reply.code(answer.status).type(answer.contentType).header(DEMO_CACHE_HEADER, how);
  if (answer.retryAfter) reply.header('retry-after', answer.retryAfter);
  return reply.send(answer.body);
}

/**
 * Registers the cache, single-flight and load shedding. Call it after the demo's other hooks
 * (sessions, the range check, the hidden facts), so a stored answer is the filtered one and a
 * request's rounded range has passed the 24-hour check.
 */
export function registerDemoCache(
  app: FastifyInstance,
  opts: DemoCacheOptions,
): { stats: () => AnswerCacheStats & { upstream: number } } {
  app.decorate('demoCacheOn', true);
  const now = opts.now ?? Date.now;
  const cache = new AnswerCache(opts.maxBytes, now);
  const inFlight = new Map<string, Promise<CachedAnswer | null>>();
  const upstreamRoutes = new Set(opts.upstreamRoutes);
  const ttlMs = opts.bucketS * 1000;
  let upstream = 0;
  const stats = { hits: 0, shared: 0, misses: 0, shed: 0 };

  const isUpstream = (request: FastifyRequest) =>
    upstreamRoutes.has(`${request.method} ${request.routeOptions.url}`) && !isInternalCall(request);

  /** Admits a miss to a VictoriaMetrics-backed route, or answers it: 429 or 503. */
  async function admit(
    request: FastifyRequest,
    reply: FastifyReply,
    state?: RequestState,
  ): Promise<boolean> {
    if (!isUpstream(request)) return true;
    if (opts.limit) {
      if (state) state.ownAnswer = true;
      await opts.limit(request, reply);
      if (reply.sent) return false;
      if (state) state.ownAnswer = false;
    }
    if (upstream >= opts.maxUpstream) {
      stats.shed++;
      reply
        .code(503)
        .type(PROBLEM_CONTENT_TYPE)
        .header('retry-after', String(DEMO_BUSY_RETRY_AFTER_S))
        .send(JSON.stringify(problem(503, DEMO_BUSY_MESSAGE, request.url, ProblemType.demoBusy)));
      return false;
    }
    upstream++;
    return true;
  }

  /** Follows a request to its end; `upstream` is set once it holds a slot. */
  function track(
    request: FastifyRequest,
    reply: FastifyReply,
    key: string,
    resolve: (a: CachedAnswer | null) => void,
    settled: boolean,
  ): RequestState {
    const state: RequestState = { key, upstream: false, settled, resolve };
    request.demoCache = state;
    reply.raw.once('close', () => release(state));
    return state;
  }

  app.addHook('preHandler', async (request, reply) => {
    if (!cacheable(request)) {
      // Not shared: counted and shed as before (an API token's other reads, say).
      if (!(await admit(request, reply))) return reply;
      if (isUpstream(request)) track(request, reply, '', () => {}, true).upstream = true;
      return;
    }
    const rangeQuery = request.routeOptions.url === RANGE_QUERY;
    roundRange(request.query, opts.bucketS, false);
    roundRange(request.body, opts.bucketS, rangeQuery);
    const path = request.url.split('?')[0];
    const key = [
      request.apiToken ? 'token' : 'cookie',
      request.method,
      path,
      stableJson(request.query),
      stableJson(request.body),
    ].join(' ');

    const hit = cache.get(key);
    if (hit) {
      stats.hits++;
      return send(reply, hit, 'hit');
    }
    const pending = inFlight.get(key);
    if (pending) {
      const answer = await pending;
      if (answer) {
        stats.shared++;
        return send(reply, answer, 'shared');
      }
      // The first request's answer couldn't be shared (a stream, an abort): ask ourselves.
    }
    // In flight before anything awaits, so an identical request waits for this one. A 429
    // or 503 from admit() is this request's answer, and its waiters'.
    let resolve!: (a: CachedAnswer | null) => void;
    inFlight.set(key, new Promise<CachedAnswer | null>((r) => (resolve = r)));
    const state = track(request, reply, key, resolve, false);
    if (!(await admit(request, reply, state))) return reply;
    state.upstream = isUpstream(request);
    stats.misses++;
    reply.header(DEMO_CACHE_HEADER, 'miss');
  });

  const settle = (state: RequestState, answer: CachedAnswer | null) => {
    if (state.settled) return;
    state.settled = true;
    inFlight.delete(state.key);
    state.resolve(answer);
  };

  app.addHook('onSend', async (request, reply, payload) => {
    const state = request.demoCache;
    if (!state || state.settled) return payload;
    if (state.ownAnswer) {
      settle(state, null);
      return payload;
    }
    const body =
      typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString() : null;
    const contentType = String(reply.getHeader('content-type') ?? '');
    if (body === null) {
      settle(state, null);
      return payload;
    }
    const retryAfter = reply.getHeader('retry-after');
    const answer: CachedAnswer = {
      status: reply.statusCode,
      contentType,
      body,
      ...(retryAfter === undefined ? {} : { retryAfter: String(retryAfter) }),
    };
    if (reply.statusCode === 200 && contentType.includes('json')) {
      cache.set(state.key, { status: 200, contentType, body }, ttlMs);
    }
    settle(state, answer);
    return payload;
  });

  /** Frees a miss's upstream slot once: on the response, or when the socket closes first. */
  const release = (state: RequestState) => {
    if (state.upstream) upstream--;
    state.upstream = false;
    settle(state, null);
  };
  app.addHook('onResponse', async (request) => {
    if (request.demoCache) release(request.demoCache);
  });

  const current = (): AnswerCacheStats & { upstream: number } => ({
    ...stats,
    ...cache.size(),
    upstream,
  });
  // Once a minute: what the cache saved, for the runbook and the load test (ADR-206).
  const timer = setInterval(() => app.log.info({ demoCache: current() }, 'demo cache'), 60_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
  return { stats: current };
}
