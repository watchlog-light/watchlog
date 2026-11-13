// SPDX-License-Identifier: AGPL-3.0-only
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import pg from 'pg';
import { currentOrgId } from './org-context.js';
import type { DB } from './types.js';

export type Database = Kysely<DB>;

export interface DbOptions {
  /**
   * Cloud's request path (ADR-174): every checkout first sets `watchlog.org_id` to the
   * current org (db/org-context.ts), or to '' outside one, for Row-Level Security under
   * watchlog_app. Off in Community and for systemDb: 0.5.0's pool, no extra round trip.
   */
  orgScoped?: boolean;
}

export function createDb(databaseUrl: string, opts: DbOptions = {}): Database {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: opts.orgScoped ? orgScopedPool(pool) : pool }),
  });
}

const SET_ORG = "SELECT set_config('watchlog.org_id', $1, false)";

/**
 * A pool that sets the org on every checkout. Session-level (not `SET LOCAL`): it is set
 * before Kysely's BEGIN, so a transaction keeps the org it started with, and the next
 * checkout overwrites it, so nothing leaks from one org's use of a connection to another's.
 */
export function orgScopedPool(pool: pg.Pool): PostgresPool {
  return {
    options: pool.options,
    async connect() {
      const client = await pool.connect();
      try {
        await client.query(SET_ORG, [currentOrgId() ?? '']);
      } catch (err) {
        client.release(err as Error);
        throw err;
      }
      return client;
    },
    end: () => pool.end(),
  };
}

/** Turns connection errors into an actionable message. */
export function describeDbError(err: unknown, databaseUrl: string): string {
  const code = (err as { code?: string }).code;
  const target = URL.canParse(databaseUrl) ? new URL(databaseUrl).host : 'the configured host';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return `PostgreSQL is not reachable at ${target}. For local development run \`pnpm infra:up\`.`;
  }
  if (code === '3D000') {
    return `The database in DATABASE_URL does not exist on ${target}.`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Errors that mean "not ready yet", not "misconfigured": the server is starting or not
 * resolvable yet (a fresh install, a restarting node), or the migrations have not run.
 * 57P03: the database system is starting up; 42P01: a table does not exist yet.
 */
const NOT_READY = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  '57P03',
  '42P01',
]);

export function isNotReady(err: unknown): boolean {
  return NOT_READY.has((err as { code?: string }).code ?? '');
}

export interface WaitOptions {
  /** Give up after this long (default 5 minutes, WATCHLOG_DB_WAIT_SECONDS). */
  timeoutMs?: number;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Runs `check` until the database answers it, retrying while it is not ready yet with a
 * backoff of 1 s doubling to 10 s, and logging "waiting for database" (ADR-118). A fresh
 * install starts every process at once, before PostgreSQL accepts connections; exiting
 * would only make Kubernetes count restarts. Any other error, or the timeout, is thrown.
 */
export async function waitForDatabase<T>(
  check: () => Promise<T>,
  opts: WaitOptions = {},
): Promise<T> {
  const env = Number(process.env.WATCHLOG_DB_WAIT_SECONDS);
  const timeout = opts.timeoutMs ?? (env > 0 ? env * 1000 : 5 * 60_000);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  let delay = 1000;
  let logged = -Infinity;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (!isNotReady(err) || now() - start >= timeout) throw err;
      // Once, then every 30 s: one line per retry would flood a slow start.
      if (now() - logged >= 30_000) {
        const why =
          (err as { code?: string }).code === '42P01'
            ? 'migrations not applied yet'
            : 'not accepting connections yet';
        opts.log?.(`waiting for database (${why}); retrying`);
        logged = now();
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
  }
}

/** True when a PostgreSQL unique constraint was violated. */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}
