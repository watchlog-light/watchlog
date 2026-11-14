// SPDX-License-Identifier: AGPL-3.0-only
// A per-org cap on concurrent VictoriaMetrics queries (security review SR-9), Cloud only.
// Every org shares the metrics stores' CPU; the per-org request bucket (plugins/org-limits.ts)
// bounds how often an org asks, this bounds how much it asks at once. Each org runs at most
// ORG_QUERIES.running queries at a time; more wait in a queue, in order, up to
// ORG_QUERIES.queued of them and ORG_QUERIES.waitMs each. Beyond either, the query fails with
// OrgQueriesBusy, which the routes answer as 429 with Retry-After. An overview asks for
// about 20 series at once: they queue behind each other within the org, not behind
// other orgs'. In memory, per backend process; the alert worker has none.

export interface OrgQueryLimits {
  /** Queries of one org running at once. */
  running: number;
  /** Queries of one org waiting for a slot; beyond it: busy. */
  queued: number;
  /** The longest a query waits for a slot; beyond it: busy. */
  waitMs: number;
}

export const ORG_QUERIES: OrgQueryLimits = { running: 8, queued: 64, waitMs: 5_000 };
/** Seconds the answer asks the caller to wait. */
export const BUSY_RETRY_AFTER_S = 2;

/** Too many metric queries of one org at once: answered 429 with Retry-After. */
export class OrgQueriesBusy extends Error {
  readonly statusCode = 429;
  readonly retryAfter = BUSY_RETRY_AFTER_S;
  constructor() {
    super('Too many metric queries for this organization at once; try again in a few seconds.');
    this.name = 'OrgQueriesBusy';
  }
}

interface Waiter {
  start: () => void;
  timer: ReturnType<typeof setTimeout>;
}

interface OrgState {
  running: number;
  queue: Waiter[];
}

export class OrgQueryLimiter {
  private readonly orgs = new Map<string, OrgState>();

  constructor(private readonly limits: OrgQueryLimits = ORG_QUERIES) {}

  /** Queries of an org running and waiting now (tests, metrics). */
  load(orgId: string): { running: number; queued: number } {
    const s = this.orgs.get(orgId);
    return { running: s?.running ?? 0, queued: s?.queue.length ?? 0 };
  }

  /** Runs fn within the org's share, waiting for a slot or failing with OrgQueriesBusy. */
  async run<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(orgId);
    try {
      return await fn();
    } finally {
      this.release(orgId);
    }
  }

  private acquire(orgId: string): Promise<void> {
    let s = this.orgs.get(orgId);
    if (!s) {
      s = { running: 0, queue: [] };
      this.orgs.set(orgId, s);
    }
    if (s.running < this.limits.running) {
      s.running++;
      return Promise.resolve();
    }
    if (s.queue.length >= this.limits.queued) return Promise.reject(new OrgQueriesBusy());
    const state = s;
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        // release() hands its slot over: running stays the same.
        start: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        timer: setTimeout(() => {
          const i = state.queue.indexOf(waiter);
          if (i >= 0) state.queue.splice(i, 1);
          reject(new OrgQueriesBusy());
        }, this.limits.waitMs),
      };
      state.queue.push(waiter);
    });
  }

  private release(orgId: string): void {
    const s = this.orgs.get(orgId);
    if (!s) return;
    const next = s.queue.shift();
    if (next) return next.start();
    s.running--;
    if (s.running <= 0) this.orgs.delete(orgId);
  }
}
