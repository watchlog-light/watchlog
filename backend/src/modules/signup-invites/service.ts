// SPDX-License-Identifier: AGPL-3.0-only
// Invite waves, then public signup (ADR-173), Cloud only. The signup mode is installation-
// wide (`cloud_settings`, no row = `invite`); staff switch it through the internal admin
// API. In `invite` mode a new account (email or GitHub/Google) needs a signup invite: a
// `wl_si_` code issued by staff for one address, single use, valid 14 days, stored as
// SHA-256 only. The code is spent inside the transaction that creates the account, so two
// signups can't both use it.
//
// Signup runs before any org exists: the owner's connection (systemDb), allow-listed.
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { newId } from '../../lib/ids.js';
import { randomToken, sha256 } from '../../lib/tokens.js';

export type SignupMode = 'invite' | 'public';
export const SIGNUP_MODES: SignupMode[] = ['invite', 'public'];
export const DEFAULT_SIGNUP_MODE: SignupMode = 'invite';
export const SIGNUP_INVITE_PREFIX = 'wl_si_';
/** How long an invite works (ADR-173 "As built"). */
export const SIGNUP_INVITE_TTL_MS = 14 * 86_400_000;

const hashOf = (code: string) => sha256(code).toString('hex');

export interface SignupModeView {
  mode: SignupMode;
  changedAt: string | null;
  changedBy: string | null;
}

export async function getSignupMode(systemDb: Database): Promise<SignupModeView> {
  const row = await systemDb
    .selectFrom('cloud_settings')
    .select(['value', 'updated_at', 'updated_by'])
    .where('key', '=', 'signup_mode')
    .executeTakeFirst();
  const mode = (row?.value as { mode?: string } | undefined)?.mode;
  return {
    mode: mode === 'public' ? 'public' : DEFAULT_SIGNUP_MODE,
    changedAt: row?.updated_at.toISOString() ?? null,
    changedBy: row?.updated_by ?? null,
  };
}

export async function setSignupMode(
  systemDb: Database,
  mode: SignupMode,
  staffEmail: string,
): Promise<SignupModeView> {
  const value = JSON.stringify({ mode });
  await systemDb
    .insertInto('cloud_settings')
    .values({ key: 'signup_mode', value, updated_by: staffEmail })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({ value, updated_by: staffEmail, updated_at: new Date() }),
    )
    .execute();
  return getSignupMode(systemDb);
}

export type InviteStatus = 'pending' | 'used' | 'expired' | 'revoked';

export interface SignupInviteView {
  id: string;
  email: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  status: InviteStatus;
}

type InviteRow = {
  id: string;
  email: string;
  created_at: Date;
  created_by: string;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
};

export function inviteView(r: InviteRow, now = Date.now()): SignupInviteView {
  return {
    id: r.id,
    email: r.email,
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by,
    expiresAt: r.expires_at.toISOString(),
    usedAt: r.used_at?.toISOString() ?? null,
    revokedAt: r.revoked_at?.toISOString() ?? null,
    status: r.used_at
      ? 'used'
      : r.revoked_at
        ? 'revoked'
        : r.expires_at.getTime() <= now
          ? 'expired'
          : 'pending',
  };
}

const COLUMNS = [
  'id',
  'email',
  'created_at',
  'created_by',
  'expires_at',
  'used_at',
  'revoked_at',
] as const;

/**
 * A new invite for the address (lower-cased); an earlier unused one for it stops working.
 * Returns the code once: only its hash is kept.
 */
export async function issueSignupInvite(
  systemDb: Database,
  p: { email: string; staffEmail: string; now?: Date },
): Promise<{ invite: SignupInviteView; code: string }> {
  const now = p.now ?? new Date();
  const email = p.email.trim().toLowerCase();
  const code = `${SIGNUP_INVITE_PREFIX}${randomToken()}`;
  const row = await systemDb.transaction().execute(async (trx) => {
    await trx
      .updateTable('signup_invites')
      .set({ revoked_at: now })
      .where('email', '=', email)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .execute();
    return trx
      .insertInto('signup_invites')
      .values({
        id: newId(),
        email,
        code_hash: hashOf(code),
        created_by: p.staffEmail,
        created_at: now,
        expires_at: new Date(now.getTime() + SIGNUP_INVITE_TTL_MS),
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
  });
  return { invite: inviteView(row, now.getTime()), code };
}

/** The invite a code names, while it can still be used; null otherwise. */
export async function findUsableInvite(
  systemDb: Database,
  code: string | undefined,
  now = new Date(),
): Promise<{ id: string; email: string; expiresAt: Date } | null> {
  if (!code || !code.startsWith(SIGNUP_INVITE_PREFIX) || code.length > 128) return null;
  const row = await systemDb
    .selectFrom('signup_invites')
    .select(['id', 'email', 'expires_at'])
    .where('code_hash', '=', hashOf(code))
    .where('used_at', 'is', null)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .executeTakeFirst();
  return row ? { id: row.id, email: row.email, expiresAt: row.expires_at } : null;
}

/** Thrown inside the account's transaction when the invite was spent meanwhile. */
export class InviteUnavailableError extends Error {
  constructor() {
    super('signup invite no longer usable');
  }
}

/** Spends the invite for the new user, inside the transaction that creates them. */
export async function spendInvite(
  trx: Transaction<DB> | Kysely<DB>,
  inviteId: string,
  userId: string,
): Promise<void> {
  const now = new Date();
  const spent = await trx
    .updateTable('signup_invites')
    .set({ used_at: now, used_by: userId })
    .where('id', '=', inviteId)
    .where('used_at', 'is', null)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .returning('id')
    .executeTakeFirst();
  if (!spent) throw new InviteUnavailableError();
}

export async function listSignupInvites(
  systemDb: Database,
  p: { email?: string; limit?: number; now?: number } = {},
): Promise<SignupInviteView[]> {
  let q = systemDb.selectFrom('signup_invites').select(COLUMNS);
  if (p.email) q = q.where('email', '=', p.email.trim().toLowerCase());
  const rows = await q
    .orderBy('created_at', 'desc')
    .limit(p.limit ?? 200)
    .execute();
  return rows.map((r) => inviteView(r, p.now));
}
