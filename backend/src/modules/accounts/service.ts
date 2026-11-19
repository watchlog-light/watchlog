// SPDX-License-Identifier: AGPL-3.0-only
// Cloud accounts (ADR-175): a new account is a user, an org named after the address's local
// part, an Owner membership and Free entitlements, in one transaction. Email verification
// links are 256-bit tokens stored as SHA-256 in `email_tokens`, valid for 24 hours.
import type { Database } from '../../db/index.js';
import { PLAN_DEFAULTS } from '../entitlements/plans.js';
import { newId } from '../../lib/ids.js';
import { randomInt } from 'node:crypto';
import { randomToken, sha256 } from '../../lib/tokens.js';
import { spendInvite } from '../signup-invites/service.js';

export const VERIFY_TTL_MS = 24 * 3_600_000;
/** The code in a verification email (ADR-220): 15 minutes, 5 wrong tries. */
export const VERIFY_CODE_TTL_MS = 15 * 60_000;
export const VERIFY_CODE_TRIES = 5;

/** Six digits, as the email shows them: "482 913". */
export const formatCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;
const codeHash = (userId: string, code: string) => sha256(`verify-code:${userId}:${code}`);

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
  /** The signup invite this account spends (ADR-173); throws InviteUnavailableError if spent. */
  inviteId?: string;
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
        if (a.inviteId) await spendInvite(trx, a.inviteId, userId);
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
/**
 * A verification link and its code (ADR-220). Each new email voids the codes sent before it
 * for this user, so only the newest code works.
 */
export async function createVerifyToken(
  db: Database,
  userId: string,
  email: string,
  now = new Date(),
): Promise<{ token: string; code: string }> {
  const token = randomToken();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('email_tokens')
      .set({ code_hash: null, code_expires_at: null })
      .where('user_id', '=', userId)
      .where('purpose', '=', 'verify')
      .where('code_hash', 'is not', null)
      .execute();
    await trx
      .insertInto('email_tokens')
      .values({
        id: newId(),
        user_id: userId,
        purpose: 'verify',
        email,
        token_hash: sha256(token),
        expires_at: new Date(now.getTime() + VERIFY_TTL_MS),
        code_hash: codeHash(userId, code),
        code_expires_at: new Date(now.getTime() + VERIFY_CODE_TTL_MS),
      })
      .execute();
  });
  return { token, code };
}

/**
 * Uses the code from the newest verification email of a signed-in user: 'ok' (the address is
 * verified), 'wrong', 'expired' (15 minutes passed, or 5 wrong tries), or 'none' (no code).
 */
export async function useVerifyCode(
  db: Database,
  userId: string,
  typed: string,
  now = new Date(),
): Promise<{ result: 'ok'; orgId: string | null } | { result: 'wrong' | 'expired' | 'none' }> {
  const code = typed.replace(/\D/g, '');
  return db.transaction().execute(async (trx) => {
    const t = await trx
      .selectFrom('email_tokens as t')
      .innerJoin('users as u', 'u.id', 't.user_id')
      .select([
        't.id',
        't.email',
        't.code_hash',
        't.code_expires_at',
        't.code_attempts',
        't.used_at',
        'u.email as current',
      ])
      .where('t.user_id', '=', userId)
      .where('t.purpose', '=', 'verify')
      .where('t.code_hash', 'is not', null)
      .orderBy('t.created_at', 'desc')
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
    if (!t || t.used_at || t.email !== t.current || !t.code_hash) return { result: 'none' };
    if (
      !t.code_expires_at ||
      t.code_expires_at.getTime() <= now.getTime() ||
      t.code_attempts >= VERIFY_CODE_TRIES
    ) {
      return { result: 'expired' };
    }
    if (code.length !== 6 || !codeHash(userId, code).equals(t.code_hash)) {
      await trx
        .updateTable('email_tokens')
        .set({ code_attempts: t.code_attempts + 1 })
        .where('id', '=', t.id)
        .execute();
      return { result: t.code_attempts + 1 >= VERIFY_CODE_TRIES ? 'expired' : 'wrong' };
    }
    await trx.updateTable('email_tokens').set({ used_at: now }).where('id', '=', t.id).execute();
    await trx
      .updateTable('users')
      .set({ email_verified_at: now })
      .where('id', '=', userId)
      .where('email_verified_at', 'is', null)
      .execute();
    const m = await trx
      .selectFrom('memberships')
      .select('org_id')
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .executeTakeFirst();
    return { result: 'ok', orgId: m?.org_id ?? null };
  });
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
