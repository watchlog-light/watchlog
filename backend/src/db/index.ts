// SPDX-License-Identifier: AGPL-3.0-only
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './types.js';

export type Database = Kysely<DB>;

export function createDb(databaseUrl: string): Database {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 10 }) }),
  });
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

/** True when a PostgreSQL unique constraint was violated. */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}
