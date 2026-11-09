// SPDX-License-Identifier: AGPL-3.0-only
// Wakes collectors waiting on their configuration (ADR-131): a change to a cluster's
// integrations or probes answers its pending long-polls at once instead of after 25 s.
// In-process only; with several backend replicas a collector still sees the change at
// its next poll.

type Waiter = () => void;

declare module 'fastify' {
  interface FastifyInstance {
    /** Wakes integrations collectors after a configuration change (ADR-131). */
    collectorNotifier: ConfigNotifier;
  }
}

export class ConfigNotifier {
  private readonly waiters = new Map<string, Set<Waiter>>();

  /** Resolves when the cluster's configuration changes, or after `ms`, or on abort. */
  wait(clusterId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiters.get(clusterId);
      if (!set) {
        set = new Set();
        this.waiters.set(clusterId, set);
      }
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        const s = this.waiters.get(clusterId);
        s?.delete(done);
        if (s && s.size === 0) this.waiters.delete(clusterId);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      signal?.addEventListener('abort', done, { once: true });
      set.add(done);
    });
  }

  /** Wakes every collector of the cluster. */
  notify(clusterId: string): void {
    const set = this.waiters.get(clusterId);
    if (!set) return;
    for (const done of [...set]) done();
  }

  /** Pending waits, for tests. */
  pending(clusterId: string): number {
    return this.waiters.get(clusterId)?.size ?? 0;
  }
}
