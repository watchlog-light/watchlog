// SPDX-License-Identifier: AGPL-3.0-only
// Container logs on demand (ADR-167): the in-memory meeting point between a reader (the
// REST route, its event stream, an MCP tool) and the agent that can read the container.
// The backend never connects into a cluster (SPEC §5.2): it registers the request here,
// the cluster-agent's leader or the Docker host's agent long-polls for it, and posts the
// lines back, which are handed to the reader and dropped. Nothing here is written to disk
// or the database, and the lines are never logged.
import { randomUUID } from 'node:crypto';

/** A request the agent picks up (SPEC §8.2). */
export interface LogSpec {
  /** Kubernetes only. */
  namespace?: string;
  pod?: string;
  container: string;
  /** Kubernetes only: the container's last run. */
  previous: boolean;
  lines: number;
  follow: boolean;
}

export interface LogLine {
  ts: string | null;
  stream?: 'stdout' | 'stderr';
  text: string;
}

/** What the agent posts for a request (redacted in the agent). */
export interface LogChunk {
  lines: LogLine[];
  redacted?: number;
  cut?: number;
  truncated?: boolean;
  done?: boolean;
  error?: { code: string; detail?: string };
}

/** The reader's side: it receives the chunks, then the end. */
export interface LogSink {
  chunk(c: LogChunk): void;
  end(error?: { code: string; detail?: string }): void;
}

interface Pending {
  id: string;
  key: string;
  clusterId: string;
  host: string;
  spec: LogSpec;
  sink: LogSink;
  picked: boolean;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** How long a request waits for an agent before the reader gets 504 (ADR-167). */
export const PICKUP_TIMEOUT_MS = 10_000;

const keyOf = (clusterId: string, host: string) => `${clusterId}\u0000${host}`;

export class LogBroker {
  private readonly queued = new Map<string, Pending[]>();
  private readonly open = new Map<string, Pending>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly pickupMs = PICKUP_TIMEOUT_MS) {}

  /**
   * Registers a request for the agent of `host` ('' for a Kubernetes cluster's
   * cluster-agent). Returns a function the reader calls when it leaves.
   */
  submit(clusterId: string, host: string, spec: LogSpec, sink: LogSink): () => void {
    const key = keyOf(clusterId, host);
    const p: Pending = {
      id: randomUUID(),
      key,
      clusterId,
      host,
      spec,
      sink,
      picked: false,
      closed: false,
      timer: null,
    };
    p.timer = setTimeout(() => {
      if (p.picked || p.closed) return;
      this.close(p, { code: 'no_agent' });
    }, this.pickupMs);
    p.timer.unref?.();
    this.open.set(p.id, p);
    const list = this.queued.get(key) ?? [];
    list.push(p);
    this.queued.set(key, list);
    for (const wake of this.waiters.get(key) ?? []) wake();
    return () => this.leave(p.id);
  }

  /** The requests queued for an agent, handed over once. */
  take(clusterId: string, host: string): { id: string; spec: LogSpec }[] {
    const key = keyOf(clusterId, host);
    const list = (this.queued.get(key) ?? []).filter((p) => !p.closed);
    this.queued.delete(key);
    for (const p of list) {
      p.picked = true;
      if (p.timer) clearTimeout(p.timer);
      p.timer = null;
    }
    return list.map((p) => ({ id: p.id, spec: p.spec }));
  }

  /** Waits until a request is queued for this agent, the time is up or the poll ends. */
  async wait(clusterId: string, host: string, ms: number, signal?: AbortSignal): Promise<void> {
    const key = keyOf(clusterId, host);
    if ((this.queued.get(key) ?? []).some((p) => !p.closed)) return;
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(key) ?? new Set();
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) this.waiters.delete(key);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      set.add(done);
      this.waiters.set(key, set);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * Lines from the agent. 'gone' when the reader left (the agent stops a follow), 'unknown'
   * when no such request exists for this cluster.
   */
  deliver(clusterId: string, id: string, chunk: LogChunk): 'ok' | 'gone' | 'unknown' {
    const p = this.open.get(id);
    if (!p || p.clusterId !== clusterId) return 'unknown';
    if (p.closed) return 'gone';
    if (chunk.lines.length || chunk.redacted || chunk.cut || chunk.truncated) p.sink.chunk(chunk);
    if (chunk.error) this.close(p, chunk.error);
    else if (chunk.done) this.close(p);
    return 'ok';
  }

  /** The reader left: the next post for it answers 410. */
  leave(id: string): void {
    const p = this.open.get(id);
    if (!p || p.closed) return;
    p.closed = true;
    if (p.timer) clearTimeout(p.timer);
    // Kept a little, so the agent's next post learns it with 410 instead of 404.
    setTimeout(() => this.open.delete(id), 60_000).unref?.();
  }

  private close(p: Pending, error?: { code: string; detail?: string }) {
    if (p.closed) return;
    this.leave(p.id);
    p.sink.end(error);
  }

  /** Open requests (for tests). */
  get size(): number {
    return [...this.open.values()].filter((p) => !p.closed).length;
  }
}
