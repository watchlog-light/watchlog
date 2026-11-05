// SPDX-License-Identifier: AGPL-3.0-only
// One-shot migration entry point: `node dist/migrate.js` (SPEC §5.5 `backend migrate`).
import { loadDatabaseUrl } from './config.js';
import { describeDbError } from './db/index.js';
import { migrateUp } from './db/migrate.js';

const config = { databaseUrl: loadDatabaseUrl() };
try {
  const ran = await migrateUp(config.databaseUrl);
  console.log(ran.length ? `applied migrations: ${ran.join(', ')}` : 'database is up to date');
} catch (err) {
  console.error(`migration failed: ${describeDbError(err, config.databaseUrl)}`);
  process.exit(1);
}
