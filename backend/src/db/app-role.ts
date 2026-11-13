// SPDX-License-Identifier: AGPL-3.0-only
// Cloud's request-path role (ADR-174). The Cloud kit creates it once, with its own password:
//
//   CREATE ROLE watchlog_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS;
//
// `migrate` (as the owner, DATABASE_SYSTEM_URL) then grants it the tables after every run,
// and the backend refuses to start in Cloud when DATABASE_URL's role could bypass Row-Level
// Security. Community never creates or needs this role.
import { sql } from 'kysely';
import pg from 'pg';
import type { Database } from './index.js';

/** The role DATABASE_URL names in Cloud, or watchlog_app when the URL names none. */
export function appRoleName(databaseUrl: string): string {
  const user = URL.canParse(databaseUrl) ? decodeURIComponent(new URL(databaseUrl).username) : '';
  return user || 'watchlog_app';
}

/**
 * Grants the app role what the request path needs: rows of every table (RLS decides which),
 * never the migrations' bookkeeping, never DDL. Idempotent; run by `migrate` in Cloud.
 */
export async function grantAppRole(ownerUrl: string, role: string): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const found = await client.query<{ bypass: boolean; superuser: boolean }>(
      'SELECT rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = $1',
      [role],
    );
    const r = found.rows[0];
    if (!r) {
      throw new Error(
        `The role ${role} does not exist. Create it once as a superuser: CREATE ROLE ${role} LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS`,
      );
    }
    if (r.bypass || r.superuser) {
      throw new Error(`The role ${role} can bypass Row-Level Security; it must be NOBYPASSRLS`);
    }
    const id = client.escapeIdentifier(role);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${id}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${id}`,
    );
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${id}`);
    await client.query(`REVOKE ALL ON pgmigrations FROM ${id}`);
  } finally {
    await client.end();
  }
}

/**
 * Cloud: refuses a request-path connection that RLS doesn't apply to: a superuser, a role
 * with BYPASSRLS, or the tables' owner (RLS isn't forced, ADR-174).
 */
export async function assertAppRole(db: Database): Promise<void> {
  const res = await sql<{ role: string; superuser: boolean; bypass: boolean; owner: boolean }>`
    SELECT r.rolname AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
           pg_has_role(current_user, c.relowner, 'USAGE') AS owner
      FROM pg_roles r, pg_class c
     WHERE r.rolname = current_user AND c.oid = 'public.clusters'::regclass`.execute(db);
  const row = res.rows[0];
  if (!row) throw new Error('Cannot read the database role (are the migrations applied?)');
  if (row.superuser || row.bypass || row.owner) {
    throw new Error(
      `WATCHLOG_EDITION=cloud: DATABASE_URL's role ${row.role} bypasses Row-Level Security (${
        row.superuser ? 'superuser' : row.bypass ? 'BYPASSRLS' : 'owns the tables'
      }); use watchlog_app, and the owner in DATABASE_SYSTEM_URL`,
    );
  }
}
