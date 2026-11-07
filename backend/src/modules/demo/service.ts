// SPDX-License-Identifier: AGPL-3.0-only
// The demo viewer account and its sessions (ADR-122). Demo sessions are stateless: a
// cookie signed with a key derived from WATCHLOG_SECRET_KEY, with its expiry inside.
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import type { CurrentUser, Plan, Role } from '../auth/sessions.js';
import {
  DEMO_PASSWORD_HASH,
  DEMO_SESSION_IDLE_MS,
  DEMO_TOKEN_PREFIX,
  DEMO_USER_EMAIL,
  DEMO_USER_NAME,
} from './constants.js';

/**
 * Makes sure the demo viewer exists, with the viewer role and no usable password, in the
 * installation's org (created when there is none yet, so a Helm bootstrap cluster has
 * one to join). Returns its user id.
 */
export async function ensureDemoUser(db: Database): Promise<string> {
  return db.transaction().execute(async (trx) => {
    // The same lock as first-run setup: the two never create the default org twice.
    await sql`SELECT pg_advisory_xact_lock(hashtext('watchlog:setup'))`.execute(trx);
    let org = await trx
      .selectFrom('orgs')
      .select('id')
      .orderBy('created_at')
      .limit(1)
      .executeTakeFirst();
    if (!org) {
      org = { id: newId() };
      await trx
        .insertInto('orgs')
        .values({ id: org.id, name: 'Default', slug: 'default', plan: 'community' })
        .execute();
    }
    const existing = await trx
      .selectFrom('users')
      .select('id')
      .where('email', '=', DEMO_USER_EMAIL)
      .executeTakeFirst();
    const userId = existing?.id ?? newId();
    if (existing) {
      // Whatever happened to the row, it never gets a password.
      await trx
        .updateTable('users')
        .set({ password_hash: DEMO_PASSWORD_HASH })
        .where('id', '=', userId)
        .execute();
    } else {
      await trx
        .insertInto('users')
        .values({
          id: userId,
          email: DEMO_USER_EMAIL,
          name: DEMO_USER_NAME,
          password_hash: DEMO_PASSWORD_HASH,
        })
        .execute();
    }
    // Exactly one membership, as a viewer.
    await trx.deleteFrom('memberships').where('user_id', '=', userId).execute();
    await trx
      .insertInto('memberships')
      .values({ id: newId(), org_id: org.id, user_id: userId, role: 'viewer' })
      .execute();
    return userId;
  });
}

/** The demo viewer as a signed-in user, or null when the account does not exist. */
export async function findDemoUser(db: Database): Promise<CurrentUser | null> {
  const row = await db
    .selectFrom('users as u')
    .innerJoin('memberships as m', 'm.user_id', 'u.id')
    .innerJoin('orgs as o', 'o.id', 'm.org_id')
    .select([
      'u.id',
      'u.email',
      'u.name',
      'u.locale',
      'm.role',
      'o.id as org_id',
      'o.name as org_name',
      'o.slug as org_slug',
      'o.plan as org_plan',
    ])
    .where('u.email', '=', DEMO_USER_EMAIL)
    .orderBy('m.created_at')
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    locale: row.locale,
    role: row.role as Role,
    org: { id: row.org_id, name: row.org_name, slug: row.org_slug, plan: row.org_plan as Plan },
  };
}

/** Signs demo session tokens: `wl_demo.<issued>.<expires>.<HMAC-SHA256>` (unix ms). */
export class DemoSessions {
  private readonly key: Buffer;

  constructor(secretKey: Buffer) {
    // Its own key: a demo token can never be confused with anything else the key protects.
    this.key = Buffer.from(hkdfSync('sha256', secretKey, '', 'watchlog demo session v1', 32));
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }

  issue(now = Date.now()): { token: string; issuedAt: number; expiresAt: Date } {
    const expires = now + DEMO_SESSION_IDLE_MS;
    const body = `${DEMO_TOKEN_PREFIX}${now}.${expires}`;
    return { token: `${body}.${this.sign(body)}`, issuedAt: now, expiresAt: new Date(expires) };
  }

  /** The token's issue time when it is genuine and not expired, else null. */
  verify(token: string, now = Date.now()): { issuedAt: number } | null {
    if (!token.startsWith(DEMO_TOKEN_PREFIX) || token.length > 128) return null;
    const parts = token.slice(DEMO_TOKEN_PREFIX.length).split('.');
    if (parts.length !== 3) return null;
    const [iat, exp, sig] = parts as [string, string, string];
    if (!/^\d{1,15}$/.test(iat) || !/^\d{1,15}$/.test(exp)) return null;
    const expected = Buffer.from(this.sign(`${DEMO_TOKEN_PREFIX}${iat}.${exp}`));
    const given = Buffer.from(sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    if (Number(exp) <= now || Number(iat) > now + 60_000) return null;
    return { issuedAt: Number(iat) };
  }
}
