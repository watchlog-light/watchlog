// SPDX-License-Identifier: AGPL-3.0-only
// Accounts in Cloud (ADR-175), registered only with WATCHLOG_EDITION=cloud: signup, email
// verification, GitHub and Google sign-in, TOTP, sessions, the org switcher and joining an
// org from an invite with an existing account. Most of it runs before the org is known or
// across the user's orgs, so on the owner's connection (systemDb, ADR-174); nothing here
// reads an org's tenant data.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../../lib/passwords.js';
import { sha256 } from '../../lib/tokens.js';
import { requireUser } from '../../plugins/auth.js';
import { Email, NewPassword, ProblemSchema, UserEnvelope } from '../auth/schemas.js';
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  findSessionUser,
  MFA_PENDING_TTL_MS,
  restrictionOf,
  SESSION_COOKIE,
  setSessionCookie,
  VERIFY_GRACE_MS,
  type CurrentUser,
} from '../auth/sessions.js';
import type { SettingsService } from '../settings/service.js';
import { audit, baseUrl, inviteStatus, sendMail } from '../users/service.js';
import { emailDomain, isBreachedPassword, isDisposable, sendCode } from './checks.js';
import type { CloudAccounts } from './context.js';
import {
  authorizeUrl,
  fetchProfile,
  newFlow,
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  OAUTH_STATE_TTL_MS,
  OAuthError,
  oauthClient,
  openState,
  safeNext,
  sealState,
  stateMatches,
  type Provider,
} from './oauth.js';
import {
  createAccount,
  createVerifyToken,
  existingAccountMail,
  recordFunnelEvent,
  useVerifyToken,
  verifyMail,
} from './service.js';
import {
  acceptSecondFactor,
  encryptTotpSecret,
  decryptTotpSecret,
  newRecoveryCodes,
  newTotpSecret,
  recoveryCodesLeft,
  totpStep,
  totpUri,
} from './totp.js';

/** The cookie of a session waiting for its TOTP code (ADR-175). */
export const MFA_COOKIE = 'wl_mfa';
const MFA_COOKIE_PATH = '/api/v1/auth/2fa';
const MFA_MAX_ATTEMPTS = 5;

const TurnstileToken = Type.Optional(
  Type.String({ maxLength: 2048, description: 'The Turnstile widget token (when it is on)' }),
);
const Token = Type.String({ minLength: 20, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' });
const Code = Type.String({ minLength: 6, maxLength: 16, description: 'TOTP or recovery code' });
const ProviderParam = Type.Union([Type.Literal('github'), Type.Literal('google')]);
const Restriction = Type.Union([
  Type.Literal('mfa-setup-required'),
  Type.Literal('email-verification-required'),
  Type.Null(),
]);
const OrgRow = Type.Object({
  id: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  role: Type.Union([Type.Literal('owner'), Type.Literal('admin'), Type.Literal('viewer')]),
  current: Type.Boolean(),
});
const SessionRow = Type.Object({
  id: Type.String(),
  current: Type.Boolean(),
  createdAt: Type.String(),
  lastSeenAt: Type.String(),
  expiresAt: Type.String(),
  ip: Type.Union([Type.String(), Type.Null()]),
  userAgent: Type.Union([Type.String(), Type.Null()]),
  mfa: Type.Boolean({ description: 'Signed in with the second factor' }),
});
const RecoveryCodes = Type.Object({
  recoveryCodes: Type.Array(Type.String(), { description: 'Shown once' }),
});
const limit = (max: number, timeWindow = '1 minute') => ({ rateLimit: { max, timeWindow } });

export interface AccountRouteOptions extends Record<string, unknown> {
  db: Database;
  /** Before the org is known and across the user's orgs (ADR-174). */
  systemDb: Database;
  config: Config;
  settings: SettingsService;
  accounts: CloudAccounts;
}

export const accountRoutes: FastifyPluginAsyncTypebox<AccountRouteOptions> = async (
  app,
  { systemDb, config, settings, accounts },
) => {
  const key = config.secretKey;
  const site = async (request: FastifyRequest) =>
    (await baseUrl(settings, request)) ?? `${request.protocol}://${request.host}`;
  const sessionOpts = (request: FastifyRequest) => ({
    ip: request.clientIp,
    userAgent: request.headers['user-agent'] ?? null,
  });

  /** Ends the session the browser came with, if any: sessions rotate at sign-in. */
  async function dropCurrent(request: FastifyRequest) {
    const old = request.cookies[SESSION_COOKIE];
    if (old) await deleteSession(systemDb, old);
  }

  /** A full session for the user, in the given org; sets the cookie. */
  async function signIn(
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    opts: { orgId?: string | null; mfaPassedAt?: Date | null } = {},
  ): Promise<CurrentUser | null> {
    await dropCurrent(request);
    const { token, expiresAt } = await createSession(systemDb, userId, {
      ...sessionOpts(request),
      orgId: opts.orgId ?? null,
      mfaPassedAt: opts.mfaPassedAt ?? null,
    });
    setSessionCookie(request, reply, token, expiresAt);
    return findSessionUser(systemDb, token);
  }

  async function sendVerification(request: FastifyRequest, userId: string, email: string) {
    const token = await createVerifyToken(systemDb, userId, email);
    const base = await site(request);
    try {
      return await sendMail(settings, {
        to: email,
        ...verifyMail({ link: `${base}/verify-email/${token}`, site: base }),
      });
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, 'verification email not sent');
      return false;
    }
  }

  const userRow = (id: string) =>
    systemDb
      .selectFrom('users')
      .select(['id', 'email', 'password_hash', 'totp_secret', 'totp_enabled_at', 'disabled_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  // ------------------------------------------------------------------ public configuration

  app.get(
    '/auth/config',
    {
      schema: {
        summary: 'What the sign-up and sign-in pages offer: providers, Turnstile, rules',
        tags: ['auth'],
        response: {
          200: Type.Object({
            signup: Type.Boolean(),
            providers: Type.Object({ github: Type.Boolean(), google: Type.Boolean() }),
            turnstileSiteKey: Type.Union([Type.String(), Type.Null()]),
            passwordMinLength: Type.Integer(),
            verifyGraceDays: Type.Integer(),
            /** Onboarding (ADR-176): "Get help installing" and the sample organisation. */
            supportEmail: Type.String(),
            sampleUrl: Type.String(),
          }),
        },
      },
    },
    async () => ({
      signup: true,
      providers: { github: !!config.accounts.github, google: !!config.accounts.google },
      // The site key only when the server checks the token too.
      turnstileSiteKey: config.accounts.turnstile.secretKey
        ? (config.accounts.turnstile.siteKey ?? null)
        : null,
      passwordMinLength: MIN_PASSWORD_LENGTH,
      verifyGraceDays: VERIFY_GRACE_MS / 86_400_000,
      supportEmail: config.accounts.supportEmail,
      sampleUrl: config.accounts.sampleUrl,
    }),
  );

  // ------------------------------------------------------------------------------ signup

  app.post(
    '/auth/signup',
    {
      config: limit(10),
      schema: {
        summary:
          'Create an account, its org and a Free plan; the same answer whether the address has an account or not',
        tags: ['auth'],
        body: Type.Object(
          {
            email: Email,
            password: NewPassword,
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
            turnstileToken: TurnstileToken,
          },
          { additionalProperties: false },
        ),
        response: {
          201: Type.Object({
            accepted: Type.Literal(true),
            verificationSent: Type.Boolean({
              description: 'A verification (or notice) email went out; false without SMTP',
            }),
          }),
          400: ProblemSchema,
          429: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const email = request.body.email.trim().toLowerCase();
      const domain = emailDomain(email);
      if (accounts.signupsPerIp.full(request.clientIp)) {
        return sendCode(reply, 429, 'rate-limited', 'Too many signups from here. Try again later.');
      }
      if (accounts.signupsPerDomain.full(domain)) {
        return sendCode(
          reply,
          429,
          'rate-limited',
          'Too many signups for this email domain today.',
        );
      }
      if (!(await accounts.turnstile(request, request.body.turnstileToken))) {
        return sendCode(
          reply,
          400,
          'turnstile-failed',
          "We couldn't check you're human. Try again.",
        );
      }
      if (isDisposable(accounts.disposable, email)) {
        return sendCode(
          reply,
          400,
          'email-disposable',
          'Use a work or personal address: disposable email addresses are not accepted.',
        );
      }
      const breached = await isBreachedPassword(accounts.fetch, request.body.password, request.log);
      if (breached) {
        return sendCode(
          reply,
          400,
          'password-breached',
          'This password appears in known data breaches. Choose another one.',
        );
      }
      accounts.signupsPerIp.hit(request.clientIp);
      accounts.signupsPerDomain.hit(domain);
      const created = await createAccount(systemDb, {
        email,
        name: request.body.name?.trim() || email.slice(0, email.indexOf('@')),
        passwordHash: await hashPassword(request.body.password),
        emailVerified: false,
        method: 'password',
      });
      if (!created) {
        // The address has an account: the same answer, no session, and a notice to it.
        const base = await site(request);
        let sent = false;
        try {
          sent = await sendMail(settings, { to: email, ...existingAccountMail({ site: base }) });
        } catch (err) {
          request.log.warn({ err: (err as Error).message }, 'signup notice not sent');
        }
        return reply.code(201).send({ accepted: true as const, verificationSent: sent });
      }
      const sent = await sendVerification(request, created.userId, email);
      recordFunnelEvent(request.log, {
        name: 'signup_completed',
        userId: created.userId,
        orgId: created.orgId,
        props: { method: 'password' },
      });
      await signIn(request, reply, created.userId, { orgId: created.orgId });
      return reply.code(201).send({ accepted: true as const, verificationSent: sent });
    },
  );

  // ------------------------------------------------------------------ email verification

  app.post(
    '/auth/verify-email',
    {
      config: limit(10),
      schema: {
        summary: 'Confirm an email address with the link from the verification email',
        tags: ['auth'],
        body: Type.Object({ token: Token }, { additionalProperties: false }),
        response: {
          200: Type.Object({ verified: Type.Literal(true) }),
          400: ProblemSchema,
          410: ProblemSchema,
          429: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const used = await useVerifyToken(systemDb, request.body.token);
      if (used === 'expired') {
        return sendCode(reply, 410, 'token-expired', 'This link has expired. Ask for a new one.');
      }
      if (!used) {
        return sendCode(reply, 400, 'invalid-token', "This link doesn't work. Ask for a new one.");
      }
      recordFunnelEvent(request.log, {
        name: 'email_verified',
        userId: used.userId,
        orgId: used.orgId,
      });
      return { verified: true as const };
    },
  );

  app.post(
    '/auth/verify-email/resend',
    {
      preHandler: requireUser({ allowRestricted: true }),
      schema: {
        summary: 'Send the verification email again',
        tags: ['auth'],
        body: Type.Object({ turnstileToken: TurnstileToken }, { additionalProperties: false }),
        response: {
          202: Type.Object({ emailed: Type.Boolean() }),
          400: ProblemSchema,
          401: ProblemSchema,
          409: ProblemSchema,
          429: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      if (user.account?.emailVerifiedAt) {
        return sendCode(reply, 409, 'already-verified', 'Your address is already verified.');
      }
      if (accounts.resendPerUser.full(user.id) || accounts.resendPerIp.full(request.clientIp)) {
        return sendCode(reply, 429, 'rate-limited', 'Too many emails sent. Try again in an hour.');
      }
      if (!(await accounts.turnstile(request, request.body?.turnstileToken))) {
        return sendCode(
          reply,
          400,
          'turnstile-failed',
          "We couldn't check you're human. Try again.",
        );
      }
      accounts.resendPerUser.hit(user.id);
      accounts.resendPerIp.hit(request.clientIp);
      return reply
        .code(202)
        .send({ emailed: await sendVerification(request, user.id, user.email) });
    },
  );

  // ----------------------------------------------------------------------------- account

  app.get(
    '/auth/account',
    {
      preHandler: requireUser({ allowRestricted: true }),
      schema: {
        summary: "The signed-in account's security: verification, 2FA, sign-in methods",
        tags: ['auth'],
        response: {
          200: Type.Object({
            email: Type.String(),
            emailVerified: Type.Boolean(),
            verifyBy: Type.Union([Type.String(), Type.Null()]),
            restriction: Restriction,
            password: Type.Boolean({ description: 'The account has a password' }),
            mfa: Type.Object({
              enabled: Type.Boolean(),
              required: Type.Boolean(),
              recoveryCodesLeft: Type.Integer(),
            }),
            identities: Type.Array(
              Type.Object({
                provider: ProviderParam,
                email: Type.Union([Type.String(), Type.Null()]),
                linkedAt: Type.String(),
              }),
            ),
          }),
          401: ProblemSchema,
        },
      },
    },
    async (request) => {
      const user = request.user!;
      const row = await userRow(user.id);
      const identities = await systemDb
        .selectFrom('user_identities')
        .select(['provider', 'email', 'created_at'])
        .where('user_id', '=', user.id)
        .orderBy('provider')
        .execute();
      const a = user.account;
      return {
        email: user.email,
        emailVerified: !!a?.emailVerifiedAt,
        verifyBy:
          a && !a.emailVerifiedAt
            ? new Date(a.createdAt.getTime() + VERIFY_GRACE_MS).toISOString()
            : null,
        restriction: restrictionOf(user),
        password: row.password_hash !== null,
        mfa: {
          enabled: row.totp_enabled_at !== null,
          required: !!a?.ownsBilledOrg,
          recoveryCodesLeft: row.totp_enabled_at ? await recoveryCodesLeft(systemDb, user.id) : 0,
        },
        identities: identities.map((i) => ({
          provider: i.provider as Provider,
          email: i.email,
          linkedAt: i.created_at.toISOString(),
        })),
      };
    },
  );

  // -------------------------------------------------------------------------------- TOTP

  const sessionOnly = (request: FastifyRequest, reply: FastifyReply) =>
    request.user?.session
      ? null
      : sendCode(reply, 400, 'not-found', 'This needs a browser session, not an API token.');

  app.post(
    '/auth/2fa/setup',
    {
      preHandler: requireUser({ allowRestricted: true }),
      config: limit(10),
      schema: {
        summary: 'Start setting up TOTP: a new secret for the authenticator app',
        tags: ['auth'],
        response: {
          200: Type.Object({
            secret: Type.String({ description: 'Base32, for typing it in' }),
            uri: Type.String({ description: 'otpauth:// URI for the QR code' }),
          }),
          400: ProblemSchema,
          401: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      if (sessionOnly(request, reply)) return reply;
      const user = request.user!;
      const row = await userRow(user.id);
      if (row.totp_enabled_at) {
        return sendCode(
          reply,
          409,
          'mfa-already-enabled',
          'Two-factor authentication is already on.',
        );
      }
      const secret = newTotpSecret();
      await systemDb
        .updateTable('users')
        .set({ totp_secret: encryptTotpSecret(key, user.id, secret), totp_last_step: null })
        .where('id', '=', user.id)
        .where('totp_enabled_at', 'is', null)
        .execute();
      return { secret, uri: totpUri(secret, user.email) };
    },
  );

  app.post(
    '/auth/2fa/enable',
    {
      preHandler: requireUser({ allowRestricted: true }),
      config: limit(10),
      schema: {
        summary: 'Turn TOTP on with a first code; returns 10 recovery codes, shown once',
        tags: ['auth'],
        body: Type.Object({ code: Code }, { additionalProperties: false }),
        response: {
          200: RecoveryCodes,
          400: ProblemSchema,
          401: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      if (sessionOnly(request, reply)) return reply;
      const user = request.user!;
      const row = await userRow(user.id);
      if (row.totp_enabled_at) {
        return sendCode(
          reply,
          409,
          'mfa-already-enabled',
          'Two-factor authentication is already on.',
        );
      }
      if (!row.totp_secret) {
        return sendCode(reply, 409, 'mfa-not-enabled', 'Start the setup first.');
      }
      const step = totpStep(decryptTotpSecret(key, user.id, row.totp_secret), request.body.code);
      if (step === null) {
        return sendCode(
          reply,
          400,
          'mfa-invalid',
          "That code isn't right. Check your app's clock.",
        );
      }
      const on = await systemDb
        .updateTable('users')
        .set({ totp_enabled_at: new Date(), totp_last_step: step })
        .where('id', '=', user.id)
        .where('totp_enabled_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!on) {
        return sendCode(
          reply,
          409,
          'mfa-already-enabled',
          'Two-factor authentication is already on.',
        );
      }
      const recoveryCodes = await newRecoveryCodes(systemDb, user.id);
      // The session rotates at the 2FA step, and records it.
      await signIn(request, reply, user.id, { orgId: user.org.id, mfaPassedAt: new Date() });
      reply.header('cache-control', 'no-store');
      return { recoveryCodes };
    },
  );

  app.post(
    '/auth/2fa/disable',
    {
      preHandler: requireUser(),
      config: limit(10),
      schema: {
        summary: 'Turn TOTP off with a current code or a recovery code',
        tags: ['auth'],
        body: Type.Object({ code: Code }, { additionalProperties: false }),
        response: { 204: Type.Null(), 400: ProblemSchema, 401: ProblemSchema, 409: ProblemSchema },
      },
    },
    async (request, reply) => {
      if (sessionOnly(request, reply)) return reply;
      const user = request.user!;
      const row = await userRow(user.id);
      if (!row.totp_enabled_at) {
        return sendCode(reply, 409, 'mfa-not-enabled', 'Two-factor authentication is off.');
      }
      if (user.account?.ownsBilledOrg) {
        return sendCode(
          reply,
          409,
          'mfa-required',
          'Owners of a paid organization must keep two-factor authentication on.',
        );
      }
      if (!(await acceptSecondFactor(systemDb, key, row, request.body.code))) {
        return sendCode(reply, 400, 'mfa-invalid', "That code isn't right.");
      }
      await systemDb.transaction().execute(async (trx) => {
        await trx
          .updateTable('users')
          .set({ totp_secret: null, totp_enabled_at: null, totp_last_step: null })
          .where('id', '=', user.id)
          .execute();
        await trx.deleteFrom('recovery_codes').where('user_id', '=', user.id).execute();
      });
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/auth/2fa/recovery-codes',
    {
      preHandler: requireUser({ allowRestricted: true }),
      config: limit(10),
      schema: {
        summary: 'Replace the recovery codes, with a current code',
        tags: ['auth'],
        body: Type.Object({ code: Code }, { additionalProperties: false }),
        response: {
          200: RecoveryCodes,
          400: ProblemSchema,
          401: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      if (sessionOnly(request, reply)) return reply;
      const user = request.user!;
      const row = await userRow(user.id);
      if (!row.totp_enabled_at) {
        return sendCode(reply, 409, 'mfa-not-enabled', 'Two-factor authentication is off.');
      }
      if (!(await acceptSecondFactor(systemDb, key, row, request.body.code))) {
        return sendCode(reply, 400, 'mfa-invalid', "That code isn't right.");
      }
      reply.header('cache-control', 'no-store');
      return { recoveryCodes: await newRecoveryCodes(systemDb, user.id) };
    },
  );

  app.post(
    '/auth/2fa/verify',
    {
      config: limit(10),
      schema: {
        summary: 'The second sign-in step: a TOTP or recovery code after the password or OAuth',
        tags: ['auth'],
        body: Type.Object({ code: Code }, { additionalProperties: false }),
        response: { 200: UserEnvelope, 400: ProblemSchema, 401: ProblemSchema, 429: ProblemSchema },
      },
    },
    async (request, reply) => {
      const pending = request.cookies[MFA_COOKIE];
      const clear = () =>
        reply.clearCookie(MFA_COOKIE, {
          path: MFA_COOKIE_PATH,
          httpOnly: true,
          sameSite: 'lax',
          secure: request.secureCookie,
        });
      const s = pending
        ? await systemDb
            .selectFrom('sessions')
            .select(['id', 'user_id', 'current_org_id', 'mfa_attempts'])
            .where('token_hash', '=', sha256(pending))
            .where('stage', '=', 'mfa')
            .where('expires_at', '>', new Date())
            .executeTakeFirst()
        : undefined;
      if (!s) {
        clear();
        return sendCode(reply, 401, 'invalid-token', 'Sign in again: this step has expired.');
      }
      const row = await userRow(s.user_id);
      const ok = row.disabled_at
        ? null
        : await acceptSecondFactor(systemDb, key, row, request.body.code);
      if (!ok) {
        const attempts = s.mfa_attempts + 1;
        if (attempts >= MFA_MAX_ATTEMPTS) {
          await systemDb.deleteFrom('sessions').where('id', '=', s.id).execute();
          clear();
          return sendCode(reply, 401, 'invalid-token', 'Too many wrong codes. Sign in again.');
        }
        await systemDb
          .updateTable('sessions')
          .set({ mfa_attempts: attempts })
          .where('id', '=', s.id)
          .execute();
        return sendCode(reply, 400, 'mfa-invalid', "That code isn't right.");
      }
      await systemDb.deleteFrom('sessions').where('id', '=', s.id).execute();
      clear();
      const user = await signIn(request, reply, s.user_id, {
        orgId: s.current_org_id,
        mfaPassedAt: new Date(),
      });
      if (!user) return sendCode(reply, 401, 'invalid-credentials', 'Sign in again.');
      return { user };
    },
  );

  // ---------------------------------------------------------------------------- sessions

  app.get(
    '/auth/sessions',
    {
      preHandler: requireUser({ allowRestricted: true }),
      schema: {
        summary: "The signed-in user's sessions",
        tags: ['auth'],
        response: { 200: Type.Object({ sessions: Type.Array(SessionRow) }), 401: ProblemSchema },
      },
    },
    async (request) => {
      const user = request.user!;
      const rows = await systemDb
        .selectFrom('sessions')
        .select([
          'id',
          'created_at',
          'last_seen_at',
          'expires_at',
          'ip',
          'user_agent',
          'mfa_passed_at',
        ])
        .where('user_id', '=', user.id)
        .where('stage', '=', 'full')
        .where('expires_at', '>', new Date())
        .orderBy('last_seen_at', 'desc')
        .execute();
      return {
        sessions: rows.map((r) => ({
          id: r.id,
          current: r.id === user.session?.id,
          createdAt: r.created_at.toISOString(),
          lastSeenAt: r.last_seen_at.toISOString(),
          expiresAt: r.expires_at.toISOString(),
          ip: r.ip,
          userAgent: r.user_agent,
          mfa: r.mfa_passed_at !== null,
        })),
      };
    },
  );

  app.delete(
    '/auth/sessions/:id',
    {
      preHandler: requireUser({ allowRestricted: true }),
      schema: {
        summary: 'Sign one of your sessions out (yours only)',
        tags: ['auth'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 204: Type.Null(), 401: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const gone = await systemDb
        .deleteFrom('sessions')
        .where('id', '=', request.params.id)
        .where('user_id', '=', user.id)
        .returning('id')
        .executeTakeFirst();
      if (!gone) return sendCode(reply, 404, 'not-found', 'No such session.');
      if (gone.id === user.session?.id) clearSessionCookie(request, reply);
      return reply.code(204).send(null);
    },
  );

  app.delete(
    '/auth/sessions',
    {
      preHandler: requireUser({ allowRestricted: true }),
      schema: {
        summary: 'Sign out every other session of yours',
        tags: ['auth'],
        response: { 200: Type.Object({ revoked: Type.Integer() }), 401: ProblemSchema },
      },
    },
    async (request) => {
      const user = request.user!;
      let q = systemDb.deleteFrom('sessions').where('user_id', '=', user.id);
      if (user.session) q = q.where('id', '!=', user.session.id);
      const res = await q.executeTakeFirst();
      return { revoked: Number(res.numDeletedRows) };
    },
  );

  // -------------------------------------------------------------------------------- orgs

  const memberships = (userId: string) =>
    systemDb
      .selectFrom('memberships as m')
      .innerJoin('orgs as o', 'o.id', 'm.org_id')
      .select(['o.id', 'o.name', 'o.slug', 'm.role'])
      .where('m.user_id', '=', userId)
      .orderBy('m.created_at')
      .execute();

  app.get(
    '/orgs',
    {
      preHandler: requireUser(),
      schema: {
        summary: 'The orgs you belong to, and the current one',
        tags: ['auth'],
        response: { 200: Type.Object({ orgs: Type.Array(OrgRow) }), 401: ProblemSchema },
      },
    },
    async (request) => {
      const user = request.user!;
      return {
        orgs: (await memberships(user.id)).map((m) => ({
          id: m.id,
          name: m.name,
          slug: m.slug,
          role: m.role as 'owner',
          current: m.id === user.org.id,
        })),
      };
    },
  );

  app.post(
    '/orgs/:id/switch',
    {
      preHandler: requireUser(),
      schema: {
        summary: 'Make another of your orgs the current one for this session',
        tags: ['auth'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: {
          200: Type.Object({ org: OrgRow }),
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      if (sessionOnly(request, reply)) return reply;
      const user = request.user!;
      const m = (await memberships(user.id)).find((x) => x.id === request.params.id);
      if (!m) return sendCode(reply, 404, 'not-found', 'No such organization.');
      await systemDb
        .updateTable('sessions')
        .set({ current_org_id: m.id })
        .where('id', '=', user.session!.id)
        .execute();
      return {
        org: { id: m.id, name: m.name, slug: m.slug, role: m.role as 'owner', current: true },
      };
    },
  );

  // ------------------------------------------------------------------------------ invites

  app.post(
    '/invites/:token/join',
    {
      preHandler: requireUser(),
      config: limit(10),
      schema: {
        summary: 'Join the org of an invite with the signed-in account (one click)',
        tags: ['users'],
        params: Type.Object({ token: Token }),
        response: {
          200: Type.Object({ org: OrgRow }),
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          410: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const i = await systemDb
        .selectFrom('invites as i')
        .innerJoin('orgs as o', 'o.id', 'i.org_id')
        .select([
          'i.id',
          'i.org_id',
          'i.email',
          'i.role',
          'i.expires_at',
          'i.accepted_at',
          'i.revoked_at',
          'o.name',
          'o.slug',
        ])
        .where('i.token_hash', '=', sha256(request.params.token))
        .executeTakeFirst();
      if (!i) return sendCode(reply, 404, 'invalid-token', "This invite link doesn't work.");
      const status = inviteStatus(i);
      if (status !== 'pending') {
        return sendCode(
          reply,
          410,
          status === 'expired' ? 'token-expired' : 'invalid-token',
          status === 'expired'
            ? 'This invite has expired. Ask for a new link.'
            : 'This invite link has been used or revoked.',
        );
      }
      if (i.email !== user.email) {
        return sendCode(
          reply,
          403,
          'invite-other-email',
          'This invite is for another email address. Sign in with that account.',
        );
      }
      const joined = await systemDb.transaction().execute(async (trx) => {
        const added = await trx
          .insertInto('memberships')
          .values({ id: newId(), org_id: i.org_id, user_id: user.id, role: i.role })
          .onConflict((oc) => oc.columns(['org_id', 'user_id']).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!added) return false;
        await trx
          .updateTable('invites')
          .set({ accepted_at: new Date(), token_ciphertext: null })
          .where('id', '=', i.id)
          .execute();
        return true;
      });
      if (!joined) return sendCode(reply, 409, 'already-member', 'You are already a member.');
      await audit(systemDb, {
        orgId: i.org_id,
        action: 'invite_accepted',
        actor: { id: user.id, name: user.name || user.email, ip: request.ip },
        subjectEmail: i.email,
        details: { role: i.role, existingAccount: true },
      });
      if (user.session) {
        await systemDb
          .updateTable('sessions')
          .set({ current_org_id: i.org_id })
          .where('id', '=', user.session.id)
          .execute();
      }
      return {
        org: { id: i.org_id, name: i.name, slug: i.slug, role: i.role as 'owner', current: true },
      };
    },
  );

  // ------------------------------------------------------------------------------- OAuth

  const redirectUri = async (request: FastifyRequest, p: Provider) =>
    `${await site(request)}/api/v1/auth/oauth/${p}/callback`;

  app.get(
    '/auth/oauth/:provider/start',
    {
      config: limit(20),
      schema: {
        summary: 'Go to GitHub or Google to sign in, sign up, or link the account (intent=link)',
        tags: ['auth'],
        params: Type.Object({ provider: ProviderParam }),
        querystring: Type.Object({
          intent: Type.Optional(Type.Union([Type.Literal('signin'), Type.Literal('link')])),
          next: Type.Optional(Type.String({ maxLength: 512 })),
        }),
        response: { 302: Type.Null(), 401: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const p = request.params.provider;
      const client = oauthClient(config.accounts, p);
      if (!client) return sendCode(reply, 404, 'oauth-disabled', 'This sign-in method is off.');
      const intent = request.query.intent ?? 'signin';
      let userId: string | undefined;
      if (intent === 'link') {
        const token = request.cookies[SESSION_COOKIE];
        const user = token ? await findSessionUser(systemDb, token) : null;
        if (!user) return sendCode(reply, 401, 'invalid-credentials', 'Sign in to continue');
        userId = user.id;
      }
      const flow = newFlow(p, intent, { userId, next: safeNext(request.query.next) });
      reply.setCookie(OAUTH_COOKIE, sealState(key, flow), {
        path: OAUTH_COOKIE_PATH,
        httpOnly: true,
        sameSite: 'lax',
        secure: request.secureCookie,
        maxAge: OAUTH_STATE_TTL_MS / 1000,
      });
      return reply.redirect(authorizeUrl(client, flow, await redirectUri(request, p)), 302);
    },
  );

  app.get(
    '/auth/oauth/:provider/callback',
    {
      config: limit(20),
      schema: {
        summary: "The provider's redirect back: signs in, signs up or links, then redirects",
        tags: ['auth'],
        params: Type.Object({ provider: ProviderParam }),
        querystring: Type.Object({
          code: Type.Optional(Type.String({ maxLength: 2048 })),
          state: Type.Optional(Type.String({ maxLength: 256 })),
          error: Type.Optional(Type.String({ maxLength: 256 })),
        }),
        response: { 302: Type.Null() },
      },
    },
    async (request, reply) => {
      const p = request.params.provider;
      const s = openState(key, request.cookies[OAUTH_COOKIE]);
      reply.clearCookie(OAUTH_COOKIE, {
        path: OAUTH_COOKIE_PATH,
        httpOnly: true,
        sameSite: 'lax',
        secure: request.secureCookie,
      });
      const back = s?.intent === 'link' ? '/settings/security' : '/signin';
      const fail = (code: string) => reply.redirect(`${back}?error=${code}`, 302);
      const client = oauthClient(config.accounts, p);
      if (!client) return fail('oauth-disabled');
      if (!s || s.provider !== p || !stateMatches(s, request.query.state))
        return fail('oauth-state');
      if (request.query.error || !request.query.code) return fail('oauth-cancelled');

      let profile;
      try {
        profile = await fetchProfile(
          accounts.fetch,
          client,
          s,
          request.query.code,
          await redirectUri(request, p),
        );
      } catch (err) {
        request.log.warn({ provider: p, err: (err as Error).message }, 'oauth: sign-in failed');
        return fail(err instanceof OAuthError ? err.code : 'oauth-failed');
      }
      const identity = await systemDb
        .selectFrom('user_identities as i')
        .innerJoin('users as u', 'u.id', 'i.user_id')
        .select(['i.id', 'i.user_id', 'u.disabled_at', 'u.totp_enabled_at'])
        .where('i.provider', '=', p)
        .where('i.provider_user_id', '=', profile.id)
        .executeTakeFirst();

      if (s.intent === 'link') {
        // Only for the signed-in user who started it (ADR-175: linking needs a sign-in).
        const token = request.cookies[SESSION_COOKIE];
        const user = token ? await findSessionUser(systemDb, token) : null;
        if (!user || user.id !== s.userId) return fail('oauth-state');
        if (identity) {
          return identity.user_id === user.id
            ? reply.redirect(`${back}?linked=${p}`, 302)
            : fail('identity-taken');
        }
        const linked = await systemDb
          .insertInto('user_identities')
          .values({
            id: newId(),
            user_id: user.id,
            provider: p,
            provider_user_id: profile.id,
            email: profile.email,
            last_used_at: new Date(),
          })
          .onConflict((oc) => oc.columns(['user_id', 'provider']).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!linked) return fail('identity-taken');
        return reply.redirect(`${back}?linked=${p}`, 302);
      }

      let userId: string;
      let mfa = false;
      if (identity) {
        if (identity.disabled_at) return fail('account-disabled');
        userId = identity.user_id;
        mfa = identity.totp_enabled_at !== null;
        await systemDb
          .updateTable('user_identities')
          .set({ last_used_at: new Date() })
          .where('id', '=', identity.id)
          .execute();
      } else {
        // A new account: never linked to an existing one by its address (ADR-175).
        const email = profile.email!;
        if (isDisposable(accounts.disposable, email)) return fail('email-disposable');
        if (
          accounts.signupsPerIp.full(request.clientIp) ||
          accounts.signupsPerDomain.full(emailDomain(email))
        ) {
          return fail('rate-limited');
        }
        accounts.signupsPerIp.hit(request.clientIp);
        accounts.signupsPerDomain.hit(emailDomain(email));
        const created = await createAccount(systemDb, {
          email,
          name: profile.name?.trim() || email.slice(0, email.indexOf('@')),
          passwordHash: null,
          emailVerified: true,
          method: p,
          identity: { provider: p, providerUserId: profile.id, email },
        });
        if (!created) return fail('oauth-failed');
        recordFunnelEvent(request.log, {
          name: 'signup_completed',
          userId: created.userId,
          orgId: created.orgId,
          props: { method: p },
        });
        userId = created.userId;
      }
      if (mfa) {
        await dropCurrent(request);
        await startMfaSession(systemDb, request, reply, userId);
        return reply.redirect('/signin/2fa', 302);
      }
      await signIn(request, reply, userId);
      return reply.redirect(s.next ?? '/', 302);
    },
  );

  app.delete(
    '/auth/identities/:provider',
    {
      preHandler: requireUser(),
      schema: {
        summary: 'Unlink GitHub or Google from your account',
        tags: ['auth'],
        params: Type.Object({ provider: ProviderParam }),
        response: { 204: Type.Null(), 401: ProblemSchema, 404: ProblemSchema, 409: ProblemSchema },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const row = await userRow(user.id);
      const ids = await systemDb
        .selectFrom('user_identities')
        .select(['id', 'provider'])
        .where('user_id', '=', user.id)
        .execute();
      const it = ids.find((i) => i.provider === request.params.provider);
      if (!it) return sendCode(reply, 404, 'not-found', 'That account is not linked.');
      if (row.password_hash === null && ids.length === 1) {
        return sendCode(
          reply,
          409,
          'last-sign-in-method',
          'This is your only way to sign in. Set a password first.',
        );
      }
      await systemDb.deleteFrom('user_identities').where('id', '=', it.id).execute();
      return reply.code(204).send(null);
    },
  );
};

/** The login route's second step in Cloud: a pending session and its cookie. */
export async function startMfaSession(
  systemDb: Database,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<void> {
  const { token, expiresAt } = await createSession(systemDb, userId, {
    ip: request.clientIp,
    userAgent: request.headers['user-agent'] ?? null,
    stage: 'mfa',
  });
  reply.setCookie(MFA_COOKIE, token, {
    path: MFA_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure: request.secureCookie,
    expires: new Date(Math.min(expiresAt.getTime(), Date.now() + MFA_PENDING_TTL_MS)),
  });
}
