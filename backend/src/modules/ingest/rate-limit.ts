// SPDX-License-Identifier: AGPL-3.0-only
// In-memory token buckets for ingest (ADR-027): per agent instance and per cluster.

export interface BucketSpec {
  ratePerSec: number;
  burst: number;
}

export const AGENT_BUCKET: BucketSpec = { ratePerSec: 1, burst: 20 };
/**
 * The cluster-agent (X-WatchLog-Agent: cluster-agent) sends snapshot chunks, state
 * metric batches and event batches at once on start: ~25 requests at 15k pods
 * (measured). Its own bucket keeps that burst free of 429s (ADR-067).
 */
export const CLUSTER_AGENT_BUCKET: BucketSpec = { ratePerSec: 5, burst: 100 };
/** X-WatchLog-Agent value of the cluster-agent (agent/cmd/watchlog-cluster-agent). */
export const CLUSTER_AGENT_ID = 'cluster-agent';
export const CLUSTER_BUCKET: BucketSpec = { ratePerSec: 250, burst: 500 };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly spec: BucketSpec,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one token; returns 0 when allowed, else the seconds until one is available. */
  take(key: string): number {
    const now = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.spec.burst, updatedAt: now };
    b.tokens = Math.min(
      this.spec.burst,
      b.tokens + ((now - b.updatedAt) / 1000) * this.spec.ratePerSec,
    );
    b.updatedAt = now;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / this.spec.ratePerSec));
  }

  /** Forgets buckets that have refilled completely; call periodically. */
  prune(): void {
    const now = this.now();
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((now - b.updatedAt) / 1000) * this.spec.ratePerSec >= this.spec.burst) {
        this.buckets.delete(key);
      }
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
