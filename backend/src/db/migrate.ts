// SPDX-License-Identifier: AGPL-3.0-only
// Forward-only SQL migrations with node-pg-migrate (ADR-005).
import { runner } from 'node-pg-migrate';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/**
 * Where the Enterprise modules' migrations are (ADR-233), for the file running now: beside
 * dist/ in the image (/app/ee/backend/migrations), or in the repository. They run after the
 * core's, in their own table, only when ee/ is there.
 */
export function eeMigrationsDir(here = import.meta.url): string | null {
  const rel = here.endsWith('.ts')
    ? ['../../../ee/backend/migrations']
    : ['../../ee/backend/migrations', '../../../ee/backend/migrations'];
  return rel.map((r) => fileURLToPath(new URL(r, here))).find((p) => existsSync(p)) ?? null;
}

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

/** Applies the Enterprise modules' migrations, when ee/ is there; returns the names that ran. */
export async function migrateEeUp(
  databaseUrl: string,
  logger?: MigrateLogger,
  dir = eeMigrationsDir(),
): Promise<string[]> {
  if (!dir) return [];
  const ran = await runner({
    databaseUrl,
    dir,
    direction: 'up',
    migrationsTable: 'pgmigrations_ee',
    ignorePattern: '\\..*|.*\\.md',
    checkOrder: true,
    singleTransaction: true,
    logger: logger ?? { info: () => {}, warn: console.warn, error: console.error, debug: () => {} },
  });
  return ran.map((m) => m.name);
}
