// SPDX-License-Identifier: AGPL-3.0-only
// Writes the OpenAPI document to packages/api-types/openapi.json without a database connection.
import { writeFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { SetupState } from '../src/modules/setup/service.js';

const config = {
  ...loadConfig({
    DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
    WATCHLOG_SECRET_KEY: Buffer.alloc(32).toString('base64'),
  }),
  logLevel: 'silent',
  version: '0.0.0',
};
// The pool is never used: no route runs, so no connection is opened.
const db = createDb(config.databaseUrl);
const app = await buildApp(config, { db, setup: new SetupState() });
await app.ready();
const out = new URL('../../packages/api-types/openapi.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
await db.destroy();
console.log(`wrote ${out.pathname}`);
