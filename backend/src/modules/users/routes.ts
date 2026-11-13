// SPDX-License-Identifier: AGPL-3.0-only
// Users, invites and password resets (ADR-140). Signed-in routes under /users for the
// Users page; public routes for the links (/invites/:token, /password-resets/:token) and
// "Forgot your password?". Every change is audited, never with a token or password.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { sql } from 'kysely';
import { Type } from 'typebox';
import { refuseInvite } from '../entitlements/limits.js';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { hashPassword } from '../../lib/passwords.js';
import { sendProblem } from '../../lib/problem.js';
import { sendCode } from '../accounts/checks.js';
import { sha256 } from '../../lib/tokens.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { Email, NewPassword, ProblemSchema, UserEnvelope } from '../auth/schemas.js';
import { createSession, findSessionUser, setSessionCookie, type Role } from '../auth/sessions.js';
import type { SettingsService } from '../settings/service.js';
import {
  actorOf,
  audit,
  baseUrl,
  createResetLink,
  INVITE_TTL_MS,
  inviteMail,
  inviteStatus,
  inviteToken,
  mayManage,
  openInviteToken,
  resetMail,
  sendMail,
  smtpConfigured,
} from './service.js';

const Id = Type.String({ format: 'uuid' });
const Token = Type.String({ minLength: 20, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' });
const InviteRole = Type.Union([Type.Literal('admin'), Type.Literal('viewer')]);
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) =>
  Type.Union([t, Type.Null()]);

const UserRow = Type.Object({
  id: Type.String(),
  name: Type.String(),
  email: Type.String(),
  role: Type.Union([Type.Literal('owner'), Type.Literal('admin'), Type.Literal('viewer')]),
  you: Type.Boolean(),
  lastActiveAt: Nullable(Type.String()),
  tokens: Type.Integer({ description: 'Active API tokens' }),
});
const InviteRow = Type.Object({
  id: Type.String(),
  email: Type.String(),
  role: InviteRole,
  status: Type.Union([Type.Literal('pending'), Type.Literal('expired')]),
  invitedBy: Nullable(Type.String()),
  createdAt: Type.String(),
  expiresAt: Type.String(),
  emailed: Type.Boolean(),
});
const AuditRow = Type.Object({
  action: Type.String(),
  actor: Nullable(Type.String()),
  subject: Nullable(Type.String()),
  ip: Nullable(Type.String()),
  at: Type.String(),
  details: Type.Record(Type.String(), Type.Unknown()),
});
const LinkResponse = Type.Object({
  link: Type.String({ description: 'Single-use; shown to the person who made it' }),
  expiresAt: Type.String(),
  emailed: Type.Boolean({ description: 'Also sent by email (SMTP is set up)' }),
});

export const userRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  /**
   * The owner's connection (ADR-174) for the public links below: invites, password resets
   * and forgot-password run before anyone is signed in, so before the org is known.
   */
  systemDb: Database;
  settings: SettingsService;
  secretKey: Buffer;
}> = async (app, { db, systemDb, settings, secretKey }) => {
  const signedIn = requireUser();
  const canManage = [signedIn, requireRole('owner', 'admin')];
  const ownerOnly = [signedIn, requireRole('owner')];
  const site = async (request: Parameters<typeof baseUrl>[1]) =>
    (await baseUrl(settings, request)) ?? '';

  async function member(orgId: string, userId: string) {
    return db
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.id', 'u.email', 'u.name', 'm.role', 'm.id as membership_id'])
      .where('m.org_id', '=', orgId)
      .where('u.id', '=', userId)
      .executeTakeFirst();
  }

  app.get(
    '/users',
    {
      preHandler: signedIn,
      schema: {
        summary:
          'The people who can open this WatchLog, open invites, and (Owners and Admins) the log',
        tags: ['users'],
        response: {
          200: Type.Object({
            users: Type.Array(UserRow),
            invites: Type.Array(InviteRow),
            smtp: Type.Boolean(),
            audit: Type.Array(AuditRow),
          }),
          401: ProblemSchema,
        },
      },
    },
    async (request) => {
      const me = request.user!;
      const orgId = me.org.id;
      const now = new Date();
      const [users, invites, audits] = await Promise.all([
        db
          .selectFrom('memberships as m')
          .innerJoin('users as u', 'u.id', 'm.user_id')
          .select((eb) => [
            'u.id',
            'u.name',
            'u.email',
            'm.role',
            eb
              .selectFrom('sessions as s')
              .select((e) => e.fn.max('s.last_seen_at').as('at'))
              .whereRef('s.user_id', '=', 'u.id')
              .as('last_active'),
            eb
              .selectFrom('api_tokens as t')
              .select((e) => e.fn.countAll<string>().as('n'))
              .whereRef('t.user_id', '=', 'u.id')
              .where('t.revoked_at', 'is', null)
              .where((w) => w.or([w('t.expires_at', 'is', null), w('t.expires_at', '>', now)]))
              .as('tokens'),
          ])
          .where('m.org_id', '=', orgId)
          .orderBy(sql`case m.role when 'owner' then 0 when 'admin' then 1 else 2 end`)
          .orderBy('u.email')
          .execute(),
        db
          .selectFrom('invites')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('accepted_at', 'is', null)
          .where('revoked_at', 'is', null)
          .orderBy('created_at', 'desc')
          .execute(),
        me.role === 'viewer'
          ? Promise.resolve([])
          : db
              .selectFrom('audit_events')
              .select(['action', 'actor_name', 'subject_email', 'ip', 'at', 'details'])
              .where('org_id', '=', orgId)
              // "Recent changes" lists user changes; log reads are audited apart (ADR-167).
              .where('action', '<>', 'logs_read')
              .orderBy('at', 'desc')
              .limit(50)
              .execute(),
      ]);
      return {
        users: users.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role as Role,
          you: u.id === me.id,
          lastActiveAt: u.last_active
            ? new Date(u.last_active as unknown as string).toISOString()
            : null,
          tokens: Number(u.tokens ?? 0),
        })),
        invites: invites.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role as 'admin' | 'viewer',
          status:
            inviteStatus(i, now.getTime()) === 'expired'
              ? ('expired' as const)
              : ('pending' as const),
          invitedBy: i.invited_by_name,
          createdAt: i.created_at.toISOString(),
          expiresAt: i.expires_at.toISOString(),
          emailed: !!i.emailed_at,
        })),
        smtp: await smtpConfigured(settings),
        audit: audits.map((a) => ({
          action: a.action,
          actor: a.actor_name,
          subject: a.subject_email,
          ip: a.ip,
          at: a.at.toISOString(),
          details: a.details as Record<string, unknown>,
        })),
      };
    },
  );

  /** Makes the link of an open invite, emailing it when SMTP is set up. */
  async function issueInvite(
    request: Parameters<typeof actorOf>[0],
    invite: { id: string; email: string; role: string },
    token: string,
    expiresAt: Date,
  ) {
    const base = await site(request);
    const link = `${base}/invite/${token}`;
    let emailed = false;
    try {
      emailed = await sendMail(settings, {
        to: invite.email,
        ...inviteMail({
          inviter: request.user!.name || request.user!.email,
          role: invite.role,
          link,
          expires: expiresAt,
          site: base,
        }),
      });
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, 'invite email not sent');
    }
    if (emailed) {
      await db
        .updateTable('invites')
        .set({ emailed_at: new Date() })
        .where('id', '=', invite.id)
        .execute();
    }
    return { link, expiresAt: expiresAt.toISOString(), emailed };
  }

  app.post(
    '/users/invites',
    {
      preHandler: canManage,
      schema: {
        summary: 'Invite someone: a single-use link for 7 days, also emailed when SMTP is set up',
        tags: ['users'],
        body: Type.Object({ email: Email, role: InviteRole }, { additionalProperties: false }),
        response: {
          201: Type.Object({ invite: InviteRow, ...LinkResponse.properties }),
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      // Cloud: an invite over the plan's users (members and open invites) answers 409
      // plan-limit; Free has one user, so inviting asks to try Pro first (ADR-177).
      const entitlements = request.server.entitlements;
      if (entitlements && (await refuseInvite(db, entitlements, orgId, reply))) return reply;
      const email = request.body.email.trim().toLowerCase();
      const existing = await db
        .selectFrom('users as u')
        .innerJoin('memberships as m', 'm.user_id', 'u.id')
        .select('u.id')
        .where('u.email', '=', email)
        .where('m.org_id', '=', orgId)
        .executeTakeFirst();
      if (existing) return sendProblem(reply, 409, `${email} already has an account here`);
      const open = await db
        .selectFrom('invites')
        .select(['id', 'expires_at', 'accepted_at', 'revoked_at'])
        .where('org_id', '=', orgId)
        .where('email', '=', email)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (open && inviteStatus(open) === 'pending') {
        return sendProblem(
          reply,
          409,
          `${email} is already invited: copy their link or revoke it from their row`,
        );
      }
      // An expired one gives way to the new invite.
      if (open)
        await db
          .updateTable('invites')
          .set({ revoked_at: new Date() })
          .where('id', '=', open.id)
          .execute();
      const id = newId();
      const t = inviteToken(secretKey, id);
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      await db
        .insertInto('invites')
        .values({
          id,
          org_id: orgId,
          email,
          role: request.body.role,
          token_hash: t.hash,
          token_ciphertext: t.ciphertext,
          invited_by: request.user!.id,
          invited_by_name: request.user!.name || request.user!.email,
          expires_at: expiresAt,
        })
        .execute();
      await audit(db, {
        orgId,
        action: 'invite_created',
        actor: actorOf(request),
        subjectEmail: email,
        details: { role: request.body.role },
      });
      const issued = await issueInvite(
        request,
        { id, email, role: request.body.role },
        t.token,
        expiresAt,
      );
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({
        invite: {
          id,
          email,
          role: request.body.role,
          status: 'pending' as const,
          invitedBy: request.user!.name || request.user!.email,
          createdAt: new Date().toISOString(),
          expiresAt: issued.expiresAt,
          emailed: issued.emailed,
        },
        ...issued,
      });
    },
  );

  const openInvite = (orgId: string, id: string) =>
    db
      .selectFrom('invites')
      .selectAll()
      .where('id', '=', id)
      .where('org_id', '=', orgId)
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

  app.post(
    '/users/invites/:id/link',
    {
      preHandler: canManage,
      schema: {
        summary: "Copy a pending invite's link again",
        tags: ['users'],
        params: Type.Object({ id: Id }),
        response: {
          200: Type.Object({ link: Type.String(), expiresAt: Type.String() }),
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const invite = await openInvite(orgId, request.params.id);
      if (!invite) return sendProblem(reply, 404, 'Invite not found');
      if (inviteStatus(invite) !== 'pending' || !invite.token_ciphertext) {
        return sendProblem(reply, 409, 'This invite has expired: make a new link');
      }
      const token = openInviteToken(secretKey, invite.id, invite.token_ciphertext);
      await audit(db, {
        orgId,
        action: 'invite_copied',
        actor: actorOf(request),
        subjectEmail: invite.email,
      });
      reply.header('cache-control', 'no-store');
      return {
        link: `${await site(request)}/invite/${token}`,
        expiresAt: invite.expires_at.toISOString(),
      };
    },
  );

  app.post(
    '/users/invites/:id/renew',
    {
      preHandler: canManage,
      schema: {
        summary: 'New link for an invite: a new token, valid for 7 more days',
        tags: ['users'],
        params: Type.Object({ id: Id }),
        response: { 200: LinkResponse, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const invite = await openInvite(orgId, request.params.id);
      if (!invite) return sendProblem(reply, 404, 'Invite not found');
      const t = inviteToken(secretKey, invite.id);
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      await db
        .updateTable('invites')
        .set({
          token_hash: t.hash,
          token_ciphertext: t.ciphertext,
          expires_at: expiresAt,
          emailed_at: null,
        })
        .where('id', '=', invite.id)
        .execute();
      await audit(db, {
        orgId,
        action: 'invite_renewed',
        actor: actorOf(request),
        subjectEmail: invite.email,
      });
      reply.header('cache-control', 'no-store');
      return issueInvite(request, invite, t.token, expiresAt);
    },
  );

  app.delete(
    '/users/invites/:id',
    {
      preHandler: canManage,
      schema: {
        summary: 'Revoke a pending invite, or remove an expired one',
        tags: ['users'],
        params: Type.Object({ id: Id }),
        response: { 204: Type.Null(), 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const invite = await openInvite(orgId, request.params.id);
      if (!invite) return sendProblem(reply, 404, 'Invite not found');
      await db
        .updateTable('invites')
        .set({ revoked_at: new Date(), token_ciphertext: null })
        .where('id', '=', invite.id)
        .execute();
      await audit(db, {
        orgId,
        action: 'invite_revoked',
        actor: actorOf(request),
        subjectEmail: invite.email,
      });
      return reply.code(204).send(null);
    },
  );

  app.patch(
    '/users/:id',
    {
      preHandler: canManage,
      schema: {
        summary: "Change an Admin's or a Viewer's role",
        tags: ['users'],
        params: Type.Object({ id: Id }),
        body: Type.Object({ role: InviteRole }, { additionalProperties: false }),
        response: { 204: Type.Null(), 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const me = request.user!;
      const target = await member(me.org.id, request.params.id);
      if (!target) return sendProblem(reply, 404, 'User not found');
      const refused = mayManage(me, { id: target.id, role: target.role as Role });
      if (refused) return sendProblem(reply, 403, refused);
      if (target.role !== request.body.role) {
        await db
          .updateTable('memberships')
          .set({ role: request.body.role })
          .where('id', '=', target.membership_id)
          .execute();
        await audit(db, {
          orgId: me.org.id,
          action: 'role_changed',
          actor: actorOf(request),
          subjectEmail: target.email,
          details: { from: target.role, to: request.body.role },
        });
      }
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/users/:id/reset-link',
    {
      preHandler: canManage,
      schema: {
        summary: 'A single-use password reset link for one hour, also emailed when SMTP is set up',
        tags: ['users'],
        params: Type.Object({ id: Id }),
        response: { 200: LinkResponse, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const me = request.user!;
      const target = await member(me.org.id, request.params.id);
      if (!target) return sendProblem(reply, 404, 'User not found');
      const refused = mayManage(me, { id: target.id, role: target.role as Role });
      if (refused) return sendProblem(reply, 403, refused);
      const { token, expiresAt } = await createResetLink(db, {
        userId: target.id,
        via: 'admin',
        createdBy: me.id,
      });
      const base = await site(request);
      const link = `${base}/reset/${token}`;
      let emailed = false;
      try {
        emailed = await sendMail(settings, {
          to: target.email,
          ...resetMail({ link, site: base }),
        });
      } catch (err) {
        request.log.warn({ err: (err as Error).message }, 'reset email not sent');
      }
      await audit(db, {
        orgId: me.org.id,
        action: 'reset_link_created',
        actor: actorOf(request),
        subjectEmail: target.email,
      });
      reply.header('cache-control', 'no-store');
      return { link, expiresAt: expiresAt.toISOString(), emailed };
    },
  );

  app.delete(
    '/users/:id',
    {
      preHandler: canManage,
      schema: {
        summary: 'Remove a user: signed out at once, API tokens revoked; what they set up stays',
        tags: ['users'],
        params: Type.Object({ id: Id }),
        response: { 204: Type.Null(), 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const me = request.user!;
      const target = await member(me.org.id, request.params.id);
      if (!target) return sendProblem(reply, 404, 'User not found');
      const refused = mayManage(me, { id: target.id, role: target.role as Role });
      if (refused) return sendProblem(reply, 403, refused);
      const tokens = await db
        .selectFrom('api_tokens')
        .select((e) => e.fn.countAll<string>().as('n'))
        .where('user_id', '=', target.id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (request.server.edition === 'cloud') {
        // Cloud: a user may belong to other orgs (ADR-175), so removing them here ends
        // their membership, their API tokens and sessions in this org only; the account
        // goes when this was its last org.
        await removeFromCloudOrg(me.org.id, target.id);
      } else {
        // The account goes with its sessions and tokens (cascade); rules, silences and
        // services they made keep working (their creator becomes empty).
        await db.deleteFrom('users').where('id', '=', target.id).execute();
      }
      await audit(db, {
        orgId: me.org.id,
        action: 'user_removed',
        actor: actorOf(request),
        subjectEmail: target.email,
        details: { role: target.role, tokensRevoked: Number(tokens?.n ?? 0) },
      });
      return reply.code(204).send(null);
    },
  );

  async function removeFromCloudOrg(orgId: string, userId: string) {
    await db
      .updateTable('api_tokens')
      .set({ revoked_at: new Date() })
      .where('org_id', '=', orgId)
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
    await db
      .deleteFrom('memberships')
      .where('org_id', '=', orgId)
      .where('user_id', '=', userId)
      .execute();
    // Across orgs: the owner's connection.
    const left = await systemDb
      .selectFrom('memberships')
      .select('id')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!left) {
      await systemDb.deleteFrom('users').where('id', '=', userId).execute();
      return;
    }
    await systemDb
      .deleteFrom('sessions')
      .where('user_id', '=', userId)
      .where((eb) => eb.or([eb('current_org_id', '=', orgId), eb('current_org_id', 'is', null)]))
      .execute();
  }

  app.post(
    '/users/:id/owner',
    {
      preHandler: ownerOnly,
      schema: {
        summary: 'Hand ownership to an Admin; the Owner becomes an Admin',
        tags: ['users'],
        params: Type.Object({ id: Id }),
        response: {
          204: Type.Null(),
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const me = request.user!;
      const target = await member(me.org.id, request.params.id);
      if (!target) return sendProblem(reply, 404, 'User not found');
      if (target.role !== 'admin') return sendProblem(reply, 400, 'Ownership goes to an Admin');
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('memberships')
          .set({ role: 'admin' })
          .where('org_id', '=', me.org.id)
          .where('user_id', '=', me.id)
          .execute();
        await trx
          .updateTable('memberships')
          .set({ role: 'owner' })
          .where('id', '=', target.membership_id)
          .execute();
      });
      await audit(db, {
        orgId: me.org.id,
        action: 'ownership_transferred',
        actor: actorOf(request),
        subjectEmail: target.email,
      });
      return reply.code(204).send(null);
    },
  );

  // ------------------------------------------------------------ public: the links
  // Signed out, before the org is known: these use systemDb (ADR-174).

  const limited = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  async function findInvite(token: string) {
    return systemDb
      .selectFrom('invites as i')
      .innerJoin('orgs as o', 'o.id', 'i.org_id')
      .select([
        'i.id',
        'i.org_id',
        'i.email',
        'i.role',
        'i.invited_by_name',
        'i.expires_at',
        'i.accepted_at',
        'i.revoked_at',
      ])
      .where('i.token_hash', '=', sha256(token))
      .executeTakeFirst();
  }

  app.get(
    '/invites/:token',
    {
      config: limited,
      schema: {
        summary: 'What an invite link is for, and whether it still works',
        tags: ['users'],
        params: Type.Object({ token: Token }),
        response: {
          200: Type.Object({
            email: Type.String(),
            role: InviteRole,
            invitedBy: Nullable(Type.String()),
            expiresAt: Type.String(),
            status: Type.Union([
              Type.Literal('pending'),
              Type.Literal('expired'),
              Type.Literal('accepted'),
              Type.Literal('revoked'),
            ]),
            site: Type.String(),
          }),
          404: ProblemSchema,
          429: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const i = await findInvite(request.params.token);
      if (!i) return sendProblem(reply, 404, "This invite link doesn't work. Ask for a new one.");
      return {
        email: i.email,
        role: i.role as 'admin' | 'viewer',
        invitedBy: i.invited_by_name,
        expiresAt: i.expires_at.toISOString(),
        status: inviteStatus(i),
        site: (await site(request)).replace(/^https?:\/\//, ''),
      };
    },
  );

  app.post(
    '/invites/:token/accept',
    {
      config: limited,
      schema: {
        summary: 'Accept an invite: create the account and sign in',
        tags: ['users'],
        params: Type.Object({ token: Token }),
        body: Type.Object(
          { name: Type.String({ minLength: 1, maxLength: 100 }), password: NewPassword },
          { additionalProperties: false },
        ),
        response: {
          201: UserEnvelope,
          404: ProblemSchema,
          409: ProblemSchema,
          410: ProblemSchema,
          429: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const i = await findInvite(request.params.token);
      if (!i) return sendProblem(reply, 404, "This invite link doesn't work. Ask for a new one.");
      const status = inviteStatus(i);
      if (status !== 'pending') {
        return sendProblem(
          reply,
          410,
          status === 'expired'
            ? 'This invite has expired. Ask for a new link.'
            : 'This invite link has been used or revoked.',
        );
      }
      const taken = await systemDb
        .selectFrom('users')
        .select('id')
        .where('email', '=', i.email)
        .executeTakeFirst();
      if (taken)
        return sendProblem(reply, 409, `${i.email} already has an account: sign in instead`);
      const userId = newId();
      const passwordHash = await hashPassword(request.body.password);
      await systemDb.transaction().execute(async (trx) => {
        await trx
          .insertInto('users')
          .values({
            id: userId,
            email: i.email,
            name: request.body.name.trim(),
            password_hash: passwordHash,
          })
          .execute();
        await trx
          .insertInto('memberships')
          .values({ id: newId(), org_id: i.org_id, user_id: userId, role: i.role })
          .execute();
        await trx
          .updateTable('invites')
          .set({ accepted_at: new Date(), token_ciphertext: null })
          .where('id', '=', i.id)
          .execute();
      });
      await audit(systemDb, {
        orgId: i.org_id,
        action: 'invite_accepted',
        actor: { id: userId, name: request.body.name.trim(), ip: request.ip },
        subjectEmail: i.email,
        details: { role: i.role },
      });
      const { token, expiresAt } = await createSession(systemDb, userId);
      setSessionCookie(request, reply, token, expiresAt);
      return reply.code(201).send({ user: (await findSessionUser(systemDb, token))! });
    },
  );

  async function findReset(token: string) {
    return systemDb
      .selectFrom('password_resets as r')
      .innerJoin('users as u', 'u.id', 'r.user_id')
      .innerJoin('memberships as m', 'm.user_id', 'u.id')
      .select(['r.id', 'r.user_id', 'r.expires_at', 'r.used_at', 'r.via', 'u.email', 'm.org_id'])
      .where('r.token_hash', '=', sha256(token))
      .executeTakeFirst();
  }

  app.get(
    '/password-resets/:token',
    {
      config: limited,
      schema: {
        summary: 'Whether a password reset link still works',
        tags: ['users'],
        params: Type.Object({ token: Token }),
        response: {
          200: Type.Object({
            email: Type.String(),
            status: Type.Union([
              Type.Literal('valid'),
              Type.Literal('expired'),
              Type.Literal('used'),
            ]),
            expiresAt: Type.String(),
          }),
          404: ProblemSchema,
          429: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const r = await findReset(request.params.token);
      if (!r) return sendProblem(reply, 404, "This reset link doesn't work. Ask for a new one.");
      return {
        email: r.email,
        status: r.used_at
          ? ('used' as const)
          : r.expires_at.getTime() <= Date.now()
            ? ('expired' as const)
            : ('valid' as const),
        expiresAt: r.expires_at.toISOString(),
      };
    },
  );

  app.post(
    '/password-resets/:token',
    {
      config: limited,
      schema: {
        summary: 'Set a new password: every session ends, then this one signs in',
        tags: ['users'],
        params: Type.Object({ token: Token }),
        body: Type.Object({ password: NewPassword }, { additionalProperties: false }),
        response: { 200: UserEnvelope, 404: ProblemSchema, 410: ProblemSchema, 429: ProblemSchema },
      },
    },
    async (request, reply) => {
      const r = await findReset(request.params.token);
      if (!r) return sendProblem(reply, 404, "This reset link doesn't work. Ask for a new one.");
      if (r.used_at || r.expires_at.getTime() <= Date.now()) {
        return sendProblem(
          reply,
          410,
          r.used_at
            ? 'This reset link has been used.'
            : 'This reset link has expired. Ask for a new one.',
        );
      }
      const passwordHash = await hashPassword(request.body.password);
      const used = await systemDb.transaction().execute(async (trx) => {
        const claimed = await trx
          .updateTable('password_resets')
          .set({ used_at: new Date() })
          .where('id', '=', r.id)
          .where('used_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!claimed) return false;
        await trx
          .updateTable('users')
          .set({ password_hash: passwordHash })
          .where('id', '=', r.user_id)
          .execute();
        // Signed out everywhere (ADR-140); this browser signs in below.
        await trx.deleteFrom('sessions').where('user_id', '=', r.user_id).execute();
        // Other open links for this account stop working too.
        await trx
          .updateTable('password_resets')
          .set({ used_at: new Date() })
          .where('user_id', '=', r.user_id)
          .where('used_at', 'is', null)
          .execute();
        return true;
      });
      if (!used) return sendProblem(reply, 410, 'This reset link has been used.');
      await audit(systemDb, {
        orgId: r.org_id,
        action: 'password_reset',
        actor: { id: r.user_id, name: r.email, ip: request.ip },
        subjectEmail: r.email,
        details: { via: r.via },
      });
      const { token, expiresAt } = await createSession(systemDb, r.user_id);
      setSessionCookie(request, reply, token, expiresAt);
      return { user: (await findSessionUser(systemDb, token))! };
    },
  );

  app.post(
    '/auth/forgot-password',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        summary:
          'Email a reset link (SMTP set up); the same answer whether the account exists or not',
        tags: ['users'],
        body: Type.Object(
          {
            email: Email,
            /** Cloud: the Turnstile widget's token, when Turnstile is on (ADR-175). */
            turnstileToken: Type.Optional(Type.String({ maxLength: 2048 })),
          },
          { additionalProperties: false },
        ),
        response: {
          202: Type.Object({ emailed: Type.Boolean() }),
          400: ProblemSchema,
          409: ProblemSchema,
          429: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cloud = request.server.accounts;
      if (cloud && !(await cloud.turnstile(request, request.body.turnstileToken))) {
        return sendCode(
          reply,
          400,
          'turnstile-failed',
          "We couldn't check you're human. Try again.",
        );
      }
      if (!(await smtpConfigured(settings))) {
        return sendProblem(
          reply,
          409,
          "Email isn't set up: the Owner resets a password with `watchlog admin reset-password` in the backend container.",
        );
      }
      const email = request.body.email.trim().toLowerCase();
      const user = await systemDb
        .selectFrom('users as u')
        .innerJoin('memberships as m', 'm.user_id', 'u.id')
        .select(['u.id', 'u.email'])
        .where('u.email', '=', email)
        // Accounts made with GitHub or Google sign in there (Cloud).
        .where('u.password_hash', 'is not', null)
        .executeTakeFirst();
      // Cloud: 3 emails an hour per account; the answer stays the same (ADR-175).
      if (user && (!cloud || cloud.resetsPerEmail.hit(email))) {
        const { token } = await createResetLink(systemDb, {
          userId: user.id,
          via: 'email',
          createdBy: null,
        });
        const base = await site(request);
        try {
          await sendMail(settings, {
            to: user.email,
            ...resetMail({ link: `${base}/reset/${token}`, site: base }),
          });
        } catch (err) {
          request.log.warn({ err: (err as Error).message }, 'reset email not sent');
        }
      }
      return reply.code(202).send({ emailed: true });
    },
  );
};
