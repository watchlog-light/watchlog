// SPDX-License-Identifier: AGPL-3.0-only
// Per-org limits on what signed-in people and API tokens ask for (security review SR-9),
// Cloud only. Every org shares the backend's database pool and the metrics stores, so one
// org looping heavy reads or opening many streams would slow every other. Two limits, in
// memory, checked as soon as the request's org is known (requireUser):
//
//   - requests: a token bucket per org, ORG_REQUESTS (20 a second, bursts of 300; a page
//     load asks for 10 to 30 things at once), 429 with Retry-After beyond it;
//   - streams (Server-Sent Events: onboarding status, logs follow): ORG_STREAMS open at once
//     per org, 429 beyond it, so a few orgs can't hold the installation's 50 log follows.
//
// Community has none of it (one org: nobody else to protect).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sendProblem } from '../lib/problem.js';
import { TokenBuckets, type BucketSpec } from '../modules/ingest/rate-limit.js';

export const ORG_REQUESTS: BucketSpec = { ratePerSec: 20, burst: 300 };
export const ORG_STREAMS = 8;
const PRUNE_EVERY = 10_000;

declare module 'fastify' {
  interface FastifyInstance {
    /** Cloud's per-org request and stream limits (SR-9); null in Community. */
    orgLimits: OrgLimits | null;
  }
}

export class OrgLimits {
  private readonly buckets: TokenBuckets;
  private readonly streams = new Map<string, number>();
  private calls = 0;

  constructor(
    spec: BucketSpec = ORG_REQUESTS,
    private readonly maxStreams = ORG_STREAMS,
    now: () => number = Date.now,
  ) {
    this.buckets = new TokenBuckets(spec, now);
  }

  /** Open streams of an org (tests). */
  openStreams(orgId: string): number {
    return this.streams.get(orgId) ?? 0;
  }

  /** Counts the request against its org; answers 429 and returns true when it is over. */
  refuse(request: FastifyRequest, reply: FastifyReply, orgId: string): boolean {
    if (++this.calls % PRUNE_EVERY === 0) this.buckets.prune();
    const wait = this.buckets.take(orgId);
    if (wait > 0) {
      reply.header('retry-after', String(wait));
      sendProblem(reply, 429, 'Too many requests for this organization; try again shortly.');
      return true;
    }
    if (!(request.headers.accept ?? '').includes('text/event-stream')) return false;
    const open = this.streams.get(orgId) ?? 0;
    if (open >= this.maxStreams) {
      reply.header('retry-after', '30');
      sendProblem(
        reply,
        429,
        `At most ${this.maxStreams} live views (streams) are open at once per organization; close one first.`,
      );
      return true;
    }
    this.streams.set(orgId, open + 1);
    let released = false;
    reply.raw.once('close', () => {
      if (released) return;
      released = true;
      const n = (this.streams.get(orgId) ?? 1) - 1;
      if (n > 0) this.streams.set(orgId, n);
      else this.streams.delete(orgId);
    });
    return false;
  }
}
