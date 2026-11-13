// SPDX-License-Identifier: AGPL-3.0-only
// Logs on demand's limits (ADR-167): 30 reads a minute and 3 open follows per user, 50
// open follows per installation. In memory, like the requests themselves.

export const READS_PER_MINUTE = 30;
export const FOLLOWS_PER_USER = 3;
export const FOLLOWS_TOTAL = 50;

export type LimitAnswer =
  { ok: true; done: () => void } | { ok: false; detail: string; retryAfter: number };

export class LogLimiter {
  private readonly reads = new Map<string, number[]>();
  private readonly follows = new Map<string, number>();
  private followsTotal = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits = {
      perMinute: READS_PER_MINUTE,
      followsPerUser: FOLLOWS_PER_USER,
      followsTotal: FOLLOWS_TOTAL,
    },
  ) {}

  /** Counts a read; for a follow also holds a place until `done` is called. */
  start(userId: string, follow: boolean): LimitAnswer {
    const now = this.now();
    const recent = (this.reads.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.limits.perMinute) {
      this.reads.set(userId, recent);
      const retryAfter = Math.max(1, Math.ceil((recent[0]! + 60_000 - now) / 1000));
      return {
        ok: false,
        detail: `At most ${this.limits.perMinute} log reads a minute`,
        retryAfter,
      };
    }
    if (follow) {
      const mine = this.follows.get(userId) ?? 0;
      if (mine >= this.limits.followsPerUser) {
        return {
          ok: false,
          detail: `At most ${this.limits.followsPerUser} logs followed at once; close one first`,
          retryAfter: 5,
        };
      }
      if (this.followsTotal >= this.limits.followsTotal) {
        return {
          ok: false,
          detail: 'Too many logs are followed on this server right now',
          retryAfter: 30,
        };
      }
    }
    recent.push(now);
    this.reads.set(userId, recent);
    if (!follow) return { ok: true, done: () => {} };
    this.follows.set(userId, (this.follows.get(userId) ?? 0) + 1);
    this.followsTotal++;
    let released = false;
    return {
      ok: true,
      done: () => {
        if (released) return;
        released = true;
        const n = (this.follows.get(userId) ?? 1) - 1;
        if (n > 0) this.follows.set(userId, n);
        else this.follows.delete(userId);
        this.followsTotal--;
      },
    };
  }
}
