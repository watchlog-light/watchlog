// SPDX-License-Identifier: AGPL-3.0-only
// Advisory locks per org bucket on a dedicated connection outside the pool (ADR-073).
// The locks live exactly as long as that session: when it drops, every bucket counts
// as lost and the worker stops evaluating until it has reconnected and re-acquired.
import { createHash } from 'node:crypto';
import pg from 'pg';

export const BUCKETS = 64;
/** First key of the two-key advisory lock: "WLA". */
export const LOCK_CLASS = 0x574c41;

export function bucketOf(orgId: string): number {
  return createHash('sha256').update(orgId).digest().readUInt32BE(0) % BUCKETS;
}

export interface LockLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export class LockSession {
  private client: pg.Client | null = null;
  private held = new Set<number>();
  /** The session's backend pid while connected; other workers check it is alive. */
  pid: number | null = null;

  constructor(
    private readonly databaseUrl: string,
    private readonly log: LockLogger,
  ) {}

  get connected(): boolean {
    return this.client !== null;
  }

  holds(bucket: number): boolean {
    return this.client !== null && this.held.has(bucket);
  }

  get count(): number {
    return this.client ? this.held.size : 0;
  }

  /** Connects when needed and confirms the session's locks from pg_locks. */
  async ensure(): Promise<boolean> {
    if (!this.client) {
      const client = new pg.Client({
        connectionString: this.databaseUrl,
        keepAlive: true,
        query_timeout: 5_000,
        connectionTimeoutMillis: 5_000,
        application_name: 'watchlog-alert-worker-locks',
      });
      client.on('error', (err) => this.drop(client, err));
      client.on('end', () => this.drop(client));
      try {
        await client.connect();
        const res = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        this.pid = res.rows[0]!.pid;
        this.client = client;
        this.held.clear();
        this.log.info({ pid: this.pid }, 'lock connection established');
      } catch (err) {
        await client.end().catch(() => {});
        this.log.warn({ err: (err as Error).message }, 'lock connection failed');
        return false;
      }
    }
    const client = this.client;
    try {
      const res = await client.query<{ objid: number }>(
        `SELECT objid::int AS objid FROM pg_locks
          WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()
            AND classid::int = $1 AND objsubid = 2`,
        [LOCK_CLASS],
      );
      this.held = new Set(res.rows.map((r) => r.objid));
      return true;
    } catch (err) {
      this.drop(client, err as Error);
      return false;
    }
  }

  /** Holds `target` buckets: releases the surplus, then tries free ones in order. */
  async rebalance(target: number, order: number[]): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const surplus = [...this.held]
        .sort((a, b) => b - a)
        .slice(0, Math.max(0, this.held.size - target));
      for (const b of surplus) {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_CLASS, b]);
        this.held.delete(b);
      }
      for (const b of order) {
        if (this.held.size >= target) break;
        if (this.held.has(b)) continue;
        const res = await client.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_lock($1, $2) AS ok',
          [LOCK_CLASS, b],
        );
        if (res.rows[0]!.ok) this.held.add(b);
      }
    } catch (err) {
      this.drop(client, err as Error);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.held.clear();
    this.pid = null;
    // Ending the session releases its advisory locks.
    await client?.end().catch(() => {});
  }

  private drop(client: pg.Client, err?: Error): void {
    if (this.client !== client) return;
    this.log.warn(
      { err: err?.message },
      'lock connection lost; evaluation stops until re-acquired',
    );
    this.client = null;
    this.held.clear();
    this.pid = null;
    client.end().catch(() => {});
  }
}
