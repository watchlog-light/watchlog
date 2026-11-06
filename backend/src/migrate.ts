// SPDX-License-Identifier: AGPL-3.0-only
// One-shot migration entry point: `node dist/migrate.js` (SPEC §5.5 `backend migrate`).
import { loadDatabaseUrl } from './config.js';
import pg from 'pg';
import { describeDbError, waitForDatabase } from './db/index.js';
import { migrateUp } from './db/migrate.js';

const config = { databaseUrl: loadDatabaseUrl() };
try {
  // PostgreSQL may still be starting (a fresh install): wait instead of failing (ADR-118).
  await waitForDatabase(
    async () => {
      const client = new pg.Client({ connectionString: config.databaseUrl });
      try {
        await client.connect();
        await client.query('select 1');
      } finally {
        await client.end().catch(() => undefined);
      }
    },
    { log: (msg) => console.log(msg) },
  );
  const ran = await migrateUp(config.databaseUrl);
  console.log(ran.length ? `applied migrations: ${ran.join(', ')}` : 'database is up to date');
} catch (err) {
  console.error(`migration failed: ${describeDbError(err, config.databaseUrl)}`);
  process.exit(1);
}
