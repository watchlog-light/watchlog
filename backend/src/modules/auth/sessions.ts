// SPDX-License-Identifier: AGPL-3.0-only
// Server-side sessions in PostgreSQL (ADR-033).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { randomToken, sha256 } from '../../lib/tokens.js';

export const SESSION_COOKIE = 'wl_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding expiry is refreshed at most this often to avoid a write per request. */
export const SESSION_REFRESH_MS = 60 * 60 * 1000;

export type Role = 'owner' | 'admin' | 'viewer';
export type Plan = 'community' | 'free' | 'pro' | 'enterprise';

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  locale: string;
  role: Role;
  org: { id: string; name: string; slug: string; plan: Plan };
  /**
   * The session and account facts Cloud's gates read (ADR-175); not part of the API's
   * user object (the response schemas leave them out). Absent for API tokens and the demo.
   */
  session?: { id: string; mfaPassedAt: Date | null };
  account?: {
    emailVerifiedAt: Date | null;
    createdAt: Date;
    totpEnabled: boolean;
    /** Owner of an org whose entitlements come from billing: 2FA is required. */
    ownsBilledOrg: boolean;
  };
}

/** An unverified account can sign in only to verify after this long (ADR-175). */
export const VERIFY_GRACE_MS = 7 * 86_400_000;

/** What a Cloud session must do before anything else (ADR-175), or null. */
export type Restriction = 'mfa-setup-required' | 'email-verification-required';

export function restrictionOf(user: CurrentUser, now = Date.now()): Restriction | null {
  const a = user.account;
  if (!a) return null;
  if (a.ownsBilledOrg && !a.totpEnabled) return 'mfa-setup-required';
  if (!a.emailVerifiedAt && now - a.createdAt.getTime() > VERIFY_GRACE_MS) {
    return 'email-verification-required';
  }
  return null;
}

/** A session waiting for its TOTP code lives this long (ADR-175). */
export const MFA_PENDING_TTL_MS = 10 * 60_000;

export interface SessionOptions {
  now?: Date;
  /** The org the session works in (Cloud's org switcher); null: the first membership. */
  orgId?: string | null;
  /** `mfa`: the first step passed, the TOTP code not yet (ADR-175). */
  stage?: 'full' | 'mfa';
  mfaPassedAt?: Date | null;
  ip?: string | null;
  userAgent?: string | null;
}

export async function createSession(db: Database, userId: string, opts: SessionOptions = {}) {
  const now = opts.now ?? new Date();
  const token = randomToken();
  const stage = opts.stage ?? 'full';
  const expiresAt = new Date(
    now.getTime() + (stage === 'mfa' ? MFA_PENDING_TTL_MS : SESSION_TTL_MS),
  );
  await db
    .insertInto('sessions')
    .values({
      id: newId(),
      user_id: userId,
      token_hash: sha256(token),
      expires_at: expiresAt,
      last_seen_at: now,
      ...(opts.orgId ? { current_org_id: opts.orgId } : {}),
      ...(stage === 'mfa' ? { stage } : {}),
      ...(opts.mfaPassedAt ? { mfa_passed_at: opts.mfaPassedAt } : {}),
      ...(opts.ip ? { ip: opts.ip.slice(0, 64) } : {}),
      ...(opts.userAgent ? { user_agent: opts.userAgent.slice(0, 256) } : {}),
    })
    .execute();
  return { token, expiresAt };
}

export async function deleteSession(db: Database, token: string): Promise<void> {
  await db.deleteFrom('sessions').where('token_hash', '=', sha256(token)).execute();
}

/** Resolves a session token to the signed-in user and refreshes the sliding expiry. */
export async function findSessionUser(
  db: Database,
  token: string,
  now = new Date(),
): Promise<CurrentUser | null> {
  const row = await db
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .innerJoin('memberships as m', 'm.user_id', 'u.id')
    .innerJoin('orgs as o', 'o.id', 'm.org_id')
    .select((eb) => [
      's.id as session_id',
      's.last_seen_at',
      's.mfa_passed_at',
      'u.email_verified_at',
      'u.created_at as user_created_at',
      'u.totp_enabled_at',
      eb
        .exists(
          eb
            .selectFrom('memberships as om')
            .innerJoin('entitlements as e', 'e.org_id', 'om.org_id')
            .select(sql.lit(1).as('one'))
            .whereRef('om.user_id', '=', 'u.id')
            .where('om.role', '=', 'owner')
            .where('e.source', '=', 'billing'),
        )
        .as('owns_billed_org'),
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
    .where('s.token_hash', '=', sha256(token))
    .where('s.expires_at', '>', now)
    // A session waiting for its TOTP code is not signed in yet (ADR-175).
    .where('s.stage', '=', 'full')
    .where('u.disabled_at', 'is', null)
    // The session's current org (Cloud's switcher) while the user is still a member of it,
    // otherwise the first membership.
    .orderBy(sql`m.org_id IS NOT DISTINCT FROM s.current_org_id`, 'desc')
    .orderBy('m.created_at')
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;

  if (now.getTime() - row.last_seen_at.getTime() > SESSION_REFRESH_MS) {
    await db
      .updateTable('sessions')
      .set({ last_seen_at: now, expires_at: new Date(now.getTime() + SESSION_TTL_MS) })
      .where('id', '=', row.session_id)
      .execute();
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    locale: row.locale,
    role: row.role as Role,
    org: { id: row.org_id, name: row.org_name, slug: row.org_slug, plan: row.org_plan as Plan },
    session: { id: row.session_id, mfaPassedAt: row.mfa_passed_at },
    account: {
      emailVerifiedAt: row.email_verified_at,
      createdAt: row.user_created_at,
      totpEnabled: row.totp_enabled_at !== null,
      ownsBilledOrg: Boolean(row.owns_billed_org),
    },
  };
}

export function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Per request, from the socket or a trusted proxy (ADR-123).
    secure: request.secureCookie,
    expires: expiresAt,
  });
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Per request, from the socket or a trusted proxy (ADR-123).
    secure: request.secureCookie,
  });
}
