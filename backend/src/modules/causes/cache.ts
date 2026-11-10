// SPDX-License-Identifier: AGPL-3.0-only
// Answers are kept 15 s per subject (ADR-146), as the application findings are: the panel,
// the overview line and MCP asking about the same subject read the same answer, and a
// burst of requests computes it once (the first request's promise is shared).
export const CAUSES_CACHE_MS = 15_000;
const MAX_ENTRIES = 500;

export class AnswerCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>();

  constructor(
    private readonly ttlMs = CAUSES_CACHE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** The cached answer for `key`, else `compute()`'s (a failure is not kept). */
  get(key: string, compute: () => Promise<T>): Promise<T> {
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit && t - hit.at < this.ttlMs) return hit.value;
    const value = compute();
    this.entries.set(key, { at: t, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    if (this.entries.size > MAX_ENTRIES) {
      for (const [k, v] of this.entries) if (t - v.at >= this.ttlMs) this.entries.delete(k);
    }
    return value;
  }

  get size(): number {
    return this.entries.size;
  }
}
