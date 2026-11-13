// SPDX-License-Identifier: AGPL-3.0-only
// Multi-user (ADR-140): invites and password reset links that never depend on SMTP, the
// audit of user changes, and the rules on who may change whom. Tokens are 256 bits and
// checked by SHA-256; an open invite's link is also kept encrypted so it can be copied
// again while pending.
import type { FastifyRequest } from 'fastify';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { decryptSecret, encryptSecret } from '../../lib/secrets.js';
import { randomToken, sha256 } from '../../lib/tokens.js';
import type { Role } from '../auth/sessions.js';
import { transport } from '../alerts/channels.js';
import type { SettingsService } from '../settings/service.js';

export const INVITE_TTL_MS = 7 * 86_400_000;
export const RESET_TTL_MS = 60 * 60_000;

export type AuditAction =
  | 'invite_created'
  | 'invite_copied'
  | 'invite_renewed'
  | 'invite_revoked'
  | 'invite_accepted'
  | 'role_changed'
  | 'reset_link_created'
  | 'password_reset'
  | 'user_removed'
  | 'ownership_transferred'
  // Container logs on demand (ADR-167): who read which container, never the lines.
  | 'logs_read'
  // Cloud (ADR-179): staff's writes through the internal admin API, and support mode.
  | 'staff_entitlements_set'
  | 'staff_org_suspended'
  | 'staff_org_unsuspended'
  | 'support_session_started'
  | 'support_session_ended'
  | 'support_tokens_accessed'
  // Cloud (ADR-181): the org's data exported, its deletion asked for or undone, and the
  // inactivity warning, suspension and reactivation.
  | 'org_exported'
  | 'org_deletion_requested'
  | 'org_deletion_cancelled'
  | 'org_inactive_warned'
  | 'org_inactive_suspended'
  | 'org_reactivated';

export interface Actor {
  id: string | null;
  name: string;
  ip: string | null;
}

export const actorOf = (request: FastifyRequest): Actor => ({
  id: request.user!.id,
  name: request.user!.name || request.user!.email,
  ip: request.ip,
});

/** The command line inside the backend container (ADR-140). */
export const CLI_ACTOR: Actor = { id: null, name: 'command line', ip: null };

export async function audit(
  db: Database,
  e: {
    orgId: string;
    action: AuditAction;
    actor: Actor | null;
    subjectEmail?: string | null;
    details?: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  await db
    .insertInto('audit_events')
    .values({
      id: newId(),
      org_id: e.orgId,
      action: e.action,
      actor_id: e.actor?.id ?? null,
      actor_name: e.actor?.name.slice(0, 256) ?? null,
      subject_email: e.subjectEmail ?? null,
      ip: e.actor?.ip?.slice(0, 64) ?? null,
      details: JSON.stringify(e.details ?? {}),
    })
    .execute();
}

/** Where links point: the Public URL setting, else the request's own origin. */
export async function baseUrl(settings: SettingsService, request?: FastifyRequest) {
  const configured = (await settings.publicUrl()).value;
  const base = configured ?? (request ? `${request.protocol}://${request.host}` : null);
  return base ? base.replace(/\/+$/, '') : null;
}

/** Whether invites and resets can be emailed. */
export async function smtpConfigured(settings: SettingsService): Promise<boolean> {
  return !!(await settings.alerting()).smtp;
}

/** Sends one plain-text email through the configured server; false when there is none. */
export async function sendMail(
  settings: SettingsService,
  m: { to: string; subject: string; text: string },
): Promise<boolean> {
  const smtp = (await settings.alerting()).smtp;
  if (!smtp) return false;
  await transport(smtp.transport).sendMail({
    from: smtp.from,
    to: m.to,
    subject: m.subject,
    text: m.text,
  });
  return true;
}

/**
 * Who may act on whom (ADR-140): Owners and Admins manage Admins and Viewers; nobody
 * changes, resets or removes the Owner through the dashboard, or themselves here.
 */
export function mayManage(actor: { id: string; role: Role }, target: { id: string; role: Role }) {
  if (actor.id === target.id) return "You can't do this to your own account here.";
  if (target.role === 'owner') return 'The Owner can only be changed by handing ownership over.';
  if (actor.role !== 'owner' && actor.role !== 'admin')
    return "Viewers can't change this. Ask an Admin.";
  return null;
}

/** A new invite's token: the hash to check it, the encrypted copy for "Copy link". */
export function inviteToken(key: Buffer, inviteId: string) {
  const token = randomToken();
  return { token, hash: sha256(token), ciphertext: encryptSecret(key, token, inviteId) };
}

export function openInviteToken(key: Buffer, inviteId: string, ciphertext: string): string {
  return decryptSecret(key, ciphertext, inviteId);
}

export type InviteStatus = 'pending' | 'expired' | 'accepted' | 'revoked';

export function inviteStatus(
  i: { expires_at: Date; accepted_at: Date | null; revoked_at: Date | null },
  now = Date.now(),
): InviteStatus {
  if (i.accepted_at) return 'accepted';
  if (i.revoked_at) return 'revoked';
  return i.expires_at.getTime() <= now ? 'expired' : 'pending';
}

/** A one-hour, single-use reset link for a user; returns the token. */
export async function createResetLink(
  db: Database,
  p: { userId: string; via: 'admin' | 'email' | 'cli'; createdBy: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await db
    .insertInto('password_resets')
    .values({
      id: newId(),
      user_id: p.userId,
      token_hash: sha256(token),
      via: p.via,
      created_by: p.createdBy,
      expires_at: expiresAt,
    })
    .execute();
  return { token, expiresAt };
}

const fmtDate = (d: Date) =>
  d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

export const inviteMail = (p: {
  inviter: string;
  role: string;
  link: string;
  expires: Date;
  site: string;
}) => ({
  subject: `${p.inviter} invited you to WatchLog`,
  text: [
    `${p.inviter} invited you to WatchLog at ${p.site} as ${p.role === 'admin' ? 'an Admin' : 'a Viewer'}.`,
    '',
    `Join here: ${p.link}`,
    '',
    `The link works once and expires on ${fmtDate(p.expires)}. If you didn't expect it, you can ignore this email.`,
  ].join('\n'),
});

export const resetMail = (p: { link: string; site: string }) => ({
  subject: 'Set a new WatchLog password',
  text: [
    `A password reset was asked for your account at ${p.site}.`,
    '',
    `Set a new password here: ${p.link}`,
    '',
    "The link works once and for one hour. Your current password keeps working until you set a new one. If you didn't ask for this, you can ignore this email.",
  ].join('\n'),
});
