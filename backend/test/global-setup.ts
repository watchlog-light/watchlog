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
  project.provide('databaseUrl', testUrl.toString());
}
