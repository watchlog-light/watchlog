// SPDX-License-Identifier: AGPL-3.0-only
// Support sessions (ADR-179), Cloud only. Staff open one through the internal admin API for
// one org, with a reason; it lasts at most an hour and is read-only. The internal API hands
// back a one-time sign-in link (`wl_sc_` code, 2 minutes, one use); opening it in a browser
// trades the code for a `wl_support` cookie whose value is stored as SHA-256 only. The
// session belongs to one org: it binds that org for every request and nothing else.
//
// These lookups run before the request's org is known, and the records (what was opened,
// tokens read) are written while the request itself is read-only: the owner's connection
// (systemDb), allow-listed for this file.
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { randomToken, sha256 } from '../../lib/tokens.js';
import type { CurrentUser, Plan } from '../auth/sessions.js';
import { audit, type AuditAction } from '../users/service.js';

export const SUPPORT_COOKIE = 'wl_support';
export const SUPPORT_CODE_PREFIX = 'wl_sc_';
/** The longest a support session lasts (ADR-179). */
export const SUPPORT_MAX_MS = 60 * 60_000;
/** How long the sign-in link works, once. */
export const SUPPORT_CODE_TTL_MS = 2 * 60_000;
/** The name staff appear under in the org's views and audit events. */
export const STAFF_LABEL = 'WatchLog staff';

export interface SupportIdentity {
  sessionId: string;
  staffEmail: string;
  reason: string;
  expiresAt: Date;
}

declare module '../auth/sessions.js' {
  interface CurrentUser {
    /** Support mode (ADR-179): a staff member's read-only session for this org. */
    support?: SupportIdentity;
  }
}

export const staffActor = (staffEmail: string, ip: string | null = null) => ({
  id: null,
  name: `${STAFF_LABEL} (${staffEmail})`,
  ip,
});

/** Opens a session and returns its one-time code; the caller records and announces it. */
export async function openSupportSession(
  systemDb: Database,
  input: { orgId: string; staffEmail: string; reason: string; minutes: number; now?: Date },
) {
  const now = input.now ?? new Date();
  const minutes = Math.min(Math.max(Math.round(input.minutes), 5), SUPPORT_MAX_MS / 60_000);
  const code = `${SUPPORT_CODE_PREFIX}${randomToken()}`;
  const row = await systemDb
    .insertInto('support_sessions')
    .values({
      id: newId(),
      org_id: input.orgId,
      staff_email: input.staffEmail,
      reason: input.reason,
      code_hash: sha256(code),
      code_expires_at: new Date(now.getTime() + SUPPORT_CODE_TTL_MS),
      started_at: now,
      expires_at: new Date(now.getTime() + minutes * 60_000),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { session: row, code };
}

/**
 * Trades a sign-in code for the browser token: once, within 2 minutes, while the session
 * hasn't ended. The code is cleared in the same statement, so a second use finds nothing.
 */
export async function enterSupportSession(systemDb: Database, code: string, now = new Date()) {
  if (!code.startsWith(SUPPORT_CODE_PREFIX) || code.length > 80) return null;
  const token = randomToken();
  const row = await systemDb
    .updateTable('support_sessions')
    .set({ code_hash: null, token_hash: sha256(token), entered_at: now })
    .where('code_hash', '=', sha256(code))
    .where('code_expires_at', '>', now)
    .where('expires_at', '>', now)
    .where('ended_at', 'is', null)
    .returning(['id', 'org_id', 'expires_at'])
    .executeTakeFirst();
  return row ? { token, sessionId: row.id, orgId: row.org_id, expiresAt: row.expires_at } : null;
}

/** The support user for a browser token: a viewer of the session's org, or null. */
export async function findSupportUser(
  systemDb: Database,
  token: string,
  now = new Date(),
): Promise<CurrentUser | null> {
  const row = await systemDb
    .selectFrom('support_sessions as s')
    .innerJoin('orgs as o', 'o.id', 's.org_id')
    .select([
      's.id',
      's.staff_email',
      's.reason',
      's.expires_at',
      'o.id as org_id',
      'o.name as org_name',
      'o.slug as org_slug',
      'o.plan as org_plan',
    ])
    .where('s.token_hash', '=', sha256(token))
    .where('s.expires_at', '>', now)
    .where('s.ended_at', 'is', null)
    .executeTakeFirst();
  if (!row) return null;
  return {
    // The session's id: it matches no user, so nothing of any user's is found by it.
    id: row.id,
    email: row.staff_email,
    name: STAFF_LABEL,
    locale: 'en',
    role: 'viewer',
    org: { id: row.org_id, name: row.org_name, slug: row.org_slug, plan: row.org_plan as Plan },
    support: {
      sessionId: row.id,
      staffEmail: row.staff_email,
      reason: row.reason,
      expiresAt: row.expires_at,
    },
  };
}

/** Ends a session (staff leaving, or the internal API); recorded in the org's audit events. */
export async function endSupportSession(
  systemDb: Database,
  sessionId: string,
  orgId: string,
  by: { staffEmail: string; ip?: string | null },
  now = new Date(),
): Promise<boolean> {
  const row = await systemDb
    .updateTable('support_sessions')
    .set({ ended_at: now, token_hash: null, code_hash: null })
    .where('id', '=', sessionId)
    .where('org_id', '=', orgId)
    .where('ended_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (!row) return false;
  await audit(systemDb, {
    orgId,
    action: 'support_session_ended',
    actor: staffActor(by.staffEmail, by.ip ?? null),
    details: { sessionId },
  });
  return true;
}

/** Most distinct paths one session records (the rest still count in its total). */
const MAX_VIEWS = 500;

/**
 * Records an API path the session opened; returns true the first time this session opened
 * it (the caller records token reads once per session).
 */
export async function recordSupportView(
  systemDb: Database,
  s: { sessionId: string; orgId: string },
  path: string,
): Promise<boolean> {
  const { n } = await systemDb
    .selectFrom('support_session_views')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('session_id', '=', s.sessionId)
    .executeTakeFirstOrThrow();
  const row = await systemDb
    .insertInto('support_session_views')
    .values({ session_id: s.sessionId, org_id: s.orgId, path: path.slice(0, 300) })
    .onConflict((oc) =>
      oc
        .columns(['session_id', 'path'])
        .doUpdateSet((eb) => ({ count: eb('support_session_views.count', '+', 1) })),
    )
    .returning('count')
    .executeTakeFirst()
    .catch(() => undefined);
  if (Number(n) >= MAX_VIEWS && row?.count === 1) {
    await systemDb
      .deleteFrom('support_session_views')
      .where('session_id', '=', s.sessionId)
      .where('path', '=', path.slice(0, 300))
      .execute();
    return false;
  }
  return row?.count === 1;
}

/**
 * Tokens read in support mode (ADR-179): "accessed by WatchLog staff". Cluster tokens (their
 * prefixes, on a cluster's page) go to the org's audit events; API tokens (the Users page's
 * counts, a token's page) also get a `staff_access` event in the token's own history.
 */
export async function recordTokenAccess(
  systemDb: Database,
  s: SupportIdentity & { orgId: string },
  read: { clusterId: string } | { apiTokens: true },
): Promise<void> {
  const actor = staffActor(s.staffEmail);
  if ('clusterId' in read) {
    const tokens = await systemDb
      .selectFrom('cluster_tokens')
      .select('prefix')
      .where('cluster_id', '=', read.clusterId)
      .where('org_id', '=', s.orgId)
      .execute();
    if (!tokens.length) return;
    await audit(systemDb, {
      orgId: s.orgId,
      action: 'support_tokens_accessed' satisfies AuditAction,
      actor,
      details: {
        sessionId: s.sessionId,
        kind: 'cluster',
        clusterId: read.clusterId,
        prefixes: tokens.map((t) => t.prefix).join(', '),
      },
    });
    return;
  }
  const tokens = await systemDb
    .selectFrom('api_tokens')
    .select(['id', 'prefix'])
    .where('org_id', '=', s.orgId)
    .where('revoked_at', 'is', null)
    .execute();
  if (!tokens.length) return;
  await systemDb
    .insertInto('api_token_events')
    .values(
      tokens.map((t) => ({
        id: newId(),
        token_id: t.id,
        org_id: s.orgId,
        kind: 'staff_access',
        detail: JSON.stringify({ sessionId: s.sessionId, by: STAFF_LABEL }),
      })),
    )
    .execute();
  await audit(systemDb, {
    orgId: s.orgId,
    action: 'support_tokens_accessed',
    actor,
    details: {
      sessionId: s.sessionId,
      kind: 'api',
      prefixes: tokens.map((t) => t.prefix).join(', '),
    },
  });
}

/** An org's support sessions, newest first, with what each opened (the Owners' view). */
export async function listSupportSessions(db: Database, orgId: string, limit = 50) {
  const sessions = await db
    .selectFrom('support_sessions')
    .select(['id', 'staff_email', 'reason', 'started_at', 'expires_at', 'entered_at', 'ended_at'])
    .where('org_id', '=', orgId)
    .orderBy('started_at', 'desc')
    .limit(limit)
    .execute();
  return withViews(db, sessions);
}

/** Across orgs, for the Cloud admin (the owner's connection only). */
export async function listRecentSupportSessions(systemDb: Database, limit = 50) {
  const sessions = await systemDb
    .selectFrom('support_sessions as s')
    .innerJoin('orgs as o', 'o.id', 's.org_id')
    .select([
      's.id',
      's.staff_email',
      's.reason',
      's.started_at',
      's.expires_at',
      's.entered_at',
      's.ended_at',
      's.org_id',
      'o.name as org_name',
    ])
    .orderBy('s.started_at', 'desc')
    .limit(limit)
    .execute();
  const listed = await withViews(systemDb, sessions);
  return listed.map((v, i) => ({
    ...v,
    orgId: sessions[i]!.org_id,
    orgName: sessions[i]!.org_name,
  }));
}

async function withViews(
  db: Database,
  sessions: {
    id: string;
    staff_email: string;
    reason: string;
    started_at: Date;
    expires_at: Date;
    entered_at: Date | null;
    ended_at: Date | null;
  }[],
) {
  const views = sessions.length
    ? await db
        .selectFrom('support_session_views')
        .select(['session_id', 'path', 'count', 'first_at'])
        .where(
          'session_id',
          'in',
          sessions.map((s) => s.id),
        )
        .orderBy('first_at')
        .execute()
    : [];
  return sessions.map((s) => ({
    id: s.id,
    staffEmail: s.staff_email,
    reason: s.reason,
    startedAt: s.started_at.toISOString(),
    expiresAt: s.expires_at.toISOString(),
    enteredAt: s.entered_at?.toISOString() ?? null,
    endedAt: s.ended_at?.toISOString() ?? null,
    opened: views
      .filter((v) => v.session_id === s.id)
      .map((v) => ({ path: v.path, count: v.count, at: v.first_at.toISOString() })),
  }));
}
