// SPDX-License-Identifier: AGPL-3.0-only
// Server-side sessions in PostgreSQL (ADR-033).
import type { FastifyReply, FastifyRequest } from 'fastify';
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
}

export async function createSession(db: Database, userId: string, now = new Date()) {
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db
    .insertInto('sessions')
    .values({
      id: newId(),
      user_id: userId,
      token_hash: sha256(token),
      expires_at: expiresAt,
      last_seen_at: now,
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
    .select([
      's.id as session_id',
      's.last_seen_at',
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
