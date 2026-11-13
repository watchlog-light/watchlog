// SPDX-License-Identifier: AGPL-3.0-only
// Recreates the watchlog_test database and applies all migrations (ADR-031).
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { describeDbError } from '../src/db/index.js';
import { migrateUp } from '../src/db/migrate.js';

const DEFAULT_URL = 'postgres://watchlog:watchlog@127.0.0.1:54320/watchlog';
const TEST_DB = 'watchlog_test';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const baseUrl = process.env.DATABASE_URL ?? DEFAULT_URL;
  const admin = new pg.Client({ connectionString: baseUrl });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(`Backend tests need PostgreSQL. ${describeDbError(err, baseUrl)}`, {
      cause: err,
    });
  }
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${TEST_DB}`;
  await migrateUp(testUrl.toString());
  // Cloud signup opens by invitation by default (ADR-173); the suites that sign up through
  // the API test accounts, not waves, so the test database starts in public mode.
  // accounts.test.ts's invite-wave cases switch to invite mode and back.
  const db = new pg.Client({ connectionString: testUrl.toString() });
  await db.connect();
  await db.query(
    `INSERT INTO cloud_settings (key, value, updated_by) VALUES ('signup_mode', '{"mode":"public"}', 'tests')`,
  );
  await db.end();
  project.provide('databaseUrl', testUrl.toString());
}
