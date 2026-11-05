// SPDX-License-Identifier: AGPL-3.0-only
// Forward-only SQL migrations with node-pg-migrate (ADR-005).
import { runner } from 'node-pg-migrate';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

export interface MigrateLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** Applies all pending migrations and returns the names that ran. */
export async function migrateUp(databaseUrl: string, logger?: MigrateLogger): Promise<string[]> {
  const ran = await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    // Only .sql files are migrations; README.md and dotfiles are ignored.
    ignorePattern: '\\..*|.*\\.md',
    checkOrder: true,
    singleTransaction: true,
    logger: logger ?? { info: () => {}, warn: console.warn, error: console.error, debug: () => {} },
  });
  return ran.map((m) => m.name);
}
