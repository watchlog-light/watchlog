// SPDX-License-Identifier: AGPL-3.0-only
// The app's full OpenAPI document, built without a database connection: no route runs,
// so the pool never opens one.
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { SetupState } from '../src/modules/setup/service.js';

export async function appSpec(): Promise<Record<string, unknown>> {
  const config = {
    ...loadConfig({
      DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
      WATCHLOG_SECRET_KEY: Buffer.alloc(32).toString('base64'),
    }),
    logLevel: 'silent',
    version: '0.0.0',
  };
  const db = createDb(config.databaseUrl);
  const app = await buildApp(config, { db, setup: new SetupState() });
  await app.ready();
  const spec = app.swagger() as unknown as Record<string, unknown>;
  await app.close();
  await db.destroy();
  return spec;
}
