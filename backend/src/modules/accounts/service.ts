// SPDX-License-Identifier: AGPL-3.0-only
// Cloud accounts (ADR-175): a new account is a user, an org named after the address's local
// part, an Owner membership and Free entitlements, in one transaction. Email verification
// links are 256-bit tokens stored as SHA-256 in `email_tokens`, valid for 24 hours.
import type { Database } from '../../db/index.js';
import { PLAN_DEFAULTS } from '../entitlements/plans.js';
import { newId } from '../../lib/ids.js';
import { randomToken, sha256 } from '../../lib/tokens.js';

export const VERIFY_TTL_MS = 24 * 3_600_000;

/** The org's name: the address's local part, as typed (renamable later). */
export function orgNameFor(email: string): string {
  const local = email.slice(0, email.lastIndexOf('@')).trim();
  return (local || 'My organization').slice(0, 100);
}

/** A slug from the name: lowercase letters, digits and dashes, 1 to 40 characters. */
export function slugFor(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'org';
}

const isUniqueViolation = (err: unknown, constraint?: string) =>
  (err as { code?: string }).code === '23505' &&
  (!constraint || (err as { constraint?: string }).constraint === constraint);

export interface NewAccount {
  email: string;
  name: string;
  passwordHash: string | null;
  emailVerified: boolean;
  /** How the account was made, for the funnel (`signup_source`). */
  method: 'password' | 'github' | 'google';
  identity?: { provider: 'github' | 'google'; providerUserId: string; email: string | null };
}

/**
 * Creates the user, their org, the Owner membership and Free entitlements. Returns null when
 * a password account with this address already exists (the caller answers as for a new one).
 */
export async function createAccount(
  systemDb: Database,
  a: NewAccount,
): Promise<{ userId: string; orgId: string } | null> {
  const orgName = orgNameFor(a.email);
  const base = slugFor(orgName);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug =
      attempt === 0
        ? base
        : `${base}-${randomToken()
            .slice(0, 6)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '0')}`;
    try {
      return await systemDb.transaction().execute(async (trx) => {
        const userId = newId();
        const orgId = newId();
        await trx
          .insertInto('users')
          .values({
            id: userId,
            email: a.email,
            name: a.name.slice(0, 100) || orgName,
            password_hash: a.passwordHash,
            email_verified_at: a.emailVerified ? new Date() : null,
            signup_source: JSON.stringify({ method: a.method }),
          })
          .execute();
        await trx
          .insertInto('orgs')
          .values({ id: orgId, name: orgName, slug, plan: 'free' })
          .execute();
        await trx
          .insertInto('memberships')
          .values({ id: newId(), org_id: orgId, user_id: userId, role: 'owner' })
          .execute();
        await trx
          .insertInto('entitlements')
          .values({ org_id: orgId, plan: 'free', source: 'signup', ...freeColumns() })
          .execute();
        if (a.identity) {
          await trx
            .insertInto('user_identities')
            .values({
              id: newId(),
              user_id: userId,
              provider: a.identity.provider,
              provider_user_id: a.identity.providerUserId,
              email: a.identity.email,
              last_used_at: new Date(),
            })
            .execute();
        }
        return { userId, orgId };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_key')) return null;
      if (isUniqueViolation(err, 'orgs_slug_key')) continue;
      throw err;
    }
  }
  throw new Error('could not find a free org slug');
}

/** A new verification link's token for the user's current address. */
export async function createVerifyToken(db: Database, userId: string, email: string) {
  const token = randomToken();
  await db
    .insertInto('email_tokens')
    .values({
      id: newId(),
      user_id: userId,
      purpose: 'verify',
      email,
      token_hash: sha256(token),
      expires_at: new Date(Date.now() + VERIFY_TTL_MS),
    })
    .execute();
  return token;
}

/**
 * Uses a verification link: marks the address verified when the token is valid, unused,
 * unexpired and still names the user's address.
 */
export async function useVerifyToken(
  db: Database,
  token: string,
): Promise<{ userId: string; orgId: string | null } | 'expired' | null> {
  return db.transaction().execute(async (trx) => {
    const t = await trx
      .selectFrom('email_tokens as t')
      .innerJoin('users as u', 'u.id', 't.user_id')
      .select(['t.id', 't.user_id', 't.email', 't.expires_at', 't.used_at', 'u.email as current'])
      .where('t.token_hash', '=', sha256(token))
      .where('t.purpose', '=', 'verify')
      .executeTakeFirst();
    if (!t || t.used_at || t.email !== t.current) return null;
    if (t.expires_at.getTime() <= Date.now()) return 'expired';
    await trx
      .updateTable('email_tokens')
      .set({ used_at: new Date() })
      .where('id', '=', t.id)
      .execute();
    await trx
      .updateTable('users')
      .set({ email_verified_at: new Date() })
      .where('id', '=', t.user_id)
      .where('email_verified_at', 'is', null)
      .execute();
    const m = await trx
      .selectFrom('memberships')
      .select('org_id')
      .where('user_id', '=', t.user_id)
      .orderBy('created_at')
      .executeTakeFirst();
    return { userId: t.user_id, orgId: m?.org_id ?? null };
  });
}

export const verifyMail = (p: { link: string; site: string }) => ({
  subject: 'Verify your WatchLog email address',
  text: [
    `Welcome to WatchLog. Please confirm this address for your account at ${p.site}:`,
    '',
    p.link,
    '',
    'The link works once and for 24 hours. You can use WatchLog meanwhile; after 7 days an unverified account can only sign in to verify.',
    '',
    "If you didn't sign up, you can ignore this email.",
  ].join('\n'),
});

/** Sent instead of a second account when someone signs up with an address that has one. */
export const existingAccountMail = (p: { site: string }) => ({
  subject: 'Someone tried to sign up with your WatchLog address',
  text: [
    `Someone, maybe you, tried to create a WatchLog account at ${p.site} with this address, which already has one.`,
    '',
    `Sign in at ${p.site}/signin, or set a new password from "Forgot your password?" there.`,
    '',
    "If it wasn't you, you can ignore this email: nothing changed.",
  ].join('\n'),
});

/** Cloud Free's limits as entitlement columns (ADR-177). */
function freeColumns() {
  const f = PLAN_DEFAULTS.free;
  return {
    clusters: f.clusters,
    nodes: f.nodes,
    users: f.users,
    retention_days: f.retentionDays,
    pro_features: f.proFeatures,
  };
}
