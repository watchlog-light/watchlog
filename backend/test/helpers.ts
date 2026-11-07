// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'kysely';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { inject } from 'vitest';
import { buildApp, type AppDeps } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, type Database } from '../src/db/index.js';
import { newId } from '../src/lib/ids.js';
import { createSession, type Role } from '../src/modules/auth/sessions.js';
import { SetupState } from '../src/modules/setup/service.js';

export const TEST_SETUP_CODE = 'ABCD-EFGH-JKMN';
/** Real VictoriaMetrics for ingest/query tests (compose.dev locally, a service container in CI). */
export const TEST_VM_URL = process.env.WATCHLOG_TEST_VM_URL ?? 'http://127.0.0.1:8428';

/** A fixed test key for channel secrets (ADR-079). */
export const TEST_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');

export const ADMIN = {
  email: 'admin@example.com',
  name: 'Ada Admin',
  password: 'correct horse battery',
};

export interface TestContext {
  app: FastifyInstance;
  db: Database;
  setup: SetupState;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      DATABASE_URL: inject('databaseUrl'),
      VICTORIAMETRICS_URL: TEST_VM_URL,
      WATCHLOG_SECRET_KEY: TEST_SECRET_KEY,
    }),
    logLevel: process.env.TEST_LOG_LEVEL ?? 'silent',
    version: '1.2.3-test',
    ...overrides,
  };
}

/** Builds an app against the test database after emptying all tables. */
export async function createTestContext(
  overrides: Partial<Config> = {},
  deps: Partial<Pick<AppDeps, 'ingestBuckets' | 'onRoute' | 'seed'>> = {},
): Promise<TestContext> {
  const db = createDb(inject('databaseUrl'));
  await sql`TRUNCATE orgs, users, memberships, sessions, clusters, cluster_tokens, retired_cluster_tokens, agent_instances, objects, alert_worker_heartbeats, alerting_periods, secret_key_check, server_settings CASCADE`.execute(
    db,
  );
  const setup = new SetupState(() => TEST_SETUP_CODE);
  await setup.initialize(db, {}, { info: () => {}, warn: () => {} });
  const app = await buildApp(testConfig(overrides), { db, setup, ...deps });
  await app.ready();
  return { app, db, setup };
}

export async function closeTestContext(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.db.destroy();
}

/** Runs first-run setup through the API and returns the session cookie value. */
export async function setupAdmin(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/setup',
    payload: { code: TEST_SETUP_CODE, ...ADMIN },
  });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  return sessionCookie(res)!;
}

export function sessionCookie(res: LightMyRequestResponse): string | undefined {
  return res.cookies.find((c) => c.name === 'wl_session')?.value;
}

/** Inserts an org (optional) and a user with a role, returning a session cookie for them. */
export async function createUserSession(
  db: Database,
  opts: { role: Role; orgId?: string; email?: string },
): Promise<{ cookie: string; orgId: string; userId: string }> {
  const orgId = opts.orgId ?? newId();
  if (!opts.orgId) {
    await db
      .insertInto('orgs')
      .values({ id: orgId, name: 'Other', slug: `org-${orgId.slice(-8)}`, plan: 'community' })
      .execute();
  }
  const userId = newId();
  await db
    .insertInto('users')
    .values({
      id: userId,
      email: opts.email ?? `${userId}@example.com`,
      name: 'Test User',
      password_hash: 'unused',
    })
    .execute();
  await db
    .insertInto('memberships')
    .values({ id: newId(), org_id: orgId, user_id: userId, role: opts.role })
    .execute();
  const { token } = await createSession(db, userId);
  return { cookie: token, orgId, userId };
}
