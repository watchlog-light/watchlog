// SPDX-License-Identifier: AGPL-3.0-only
// Settings → General and the email server / Telegram settings (alerts redesign,
// ADR-093). Everyone signed in reads them; owners and admins change them. A setting
// that comes from the server's environment cannot be changed here (409).
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type TSchema } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import nodemailer from 'nodemailer';
import { encryptJson } from '../../lib/secrets.js';
import { redactUrl, restoreUrlPassword } from '../../lib/redact.js';
import type { HttpClient } from '../alerts/channels.js';
import { smtpTransport, type SettingsService, type SmtpConfig } from './service.js';

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
export const SourceSchema = Type.Union([
  Type.Literal('env'),
  Type.Literal('db'),
  Type.Literal('none'),
]);
const Errors = { 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema, 409: ProblemSchema };
export const FROM_ENVIRONMENT = "Set by the server's environment; change it there";

export const GeneralSchema = Type.Object({
  publicUrl: Nullable(Type.String()),
  publicUrlSource: SourceSchema,
});

export const NamespacesSchema = Type.Object({
  system: Type.Array(Type.String()),
  watchlog: Type.Boolean(),
  isDefault: Type.Boolean(),
});
// A Kubernetes namespace name (RFC 1123 label).
const NamespaceName = Type.String({ pattern: '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$', maxLength: 63 });

const SmtpFields = {
  host: Type.String({ minLength: 1, maxLength: 253, pattern: '^[A-Za-z0-9.-]+$' }),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  security: Type.Union([Type.Literal('starttls'), Type.Literal('tls'), Type.Literal('none')]),
  username: Type.String({ maxLength: 254 }),
  from: Type.String({ minLength: 3, maxLength: 254, pattern: '@' }),
};
export const SmtpSchema = Type.Object({
  ...SmtpFields,
  passwordSet: Type.Boolean(),
  passwordEnds: Nullable(Type.String()),
  source: SourceSchema,
});
const SmtpBody = Type.Object(
  {
    ...SmtpFields,
    /** Omitted: keep the stored password. Empty: remove it. */
    password: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);

/** An http(s) address without a trailing slash, or null when it is not one. */
export function normaliseUrl(v: string): string | null {
  if (!URL.canParse(v)) return null;
  const u = new URL(v);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.search || u.hash || u.username || u.password) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export const settingsRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  settings: SettingsService;
  http: HttpClient;
}> = async (app, { db, settings, http }) => {
  const signedIn = requireUser(db);
  // Read-only demo (ADR-122): no mail server or proxy details at all.
  const demoMode = settings.config.demoMode;
  const canManage = [signedIn, requireRole('owner', 'admin')];

  async function general() {
    const p = await settings.publicUrl();
    return { publicUrl: p.value, publicUrlSource: p.source };
  }

  app.get(
    '/settings/general',
    {
      preHandler: signedIn,
      schema: {
        summary: "This installation's public address (used in alert links and install commands)",
        tags: ['settings'],
        response: { 200: GeneralSchema, 401: ProblemSchema },
      },
    },
    general,
  );

  app.put(
    '/settings/general',
    {
      preHandler: canManage,
      schema: {
        summary: 'Set or clear the public address',
        tags: ['settings'],
        body: Type.Object(
          { publicUrl: Nullable(Type.String({ maxLength: 2048 })) },
          { additionalProperties: false },
        ),
        response: { 200: GeneralSchema, ...Errors },
      },
    },
    async (request, reply) => {
      if ((await settings.publicUrl()).source === 'env') {
        return sendProblem(reply, 409, FROM_ENVIRONMENT);
      }
      const raw = request.body.publicUrl?.trim();
      if (!raw) {
        await settings.remove('general');
        return general();
      }
      const url = normaliseUrl(raw);
      if (!url) {
        return sendProblem(reply, 400, 'Enter an address that starts with http:// or https://');
      }
      await settings.save('general', { publicUrl: url }, null, request.user!.id);
      return general();
    },
  );

  // ---------------------------------------------------------------- system namespaces

  app.get(
    '/settings/namespaces',
    {
      preHandler: signedIn,
      schema: {
        summary: 'The system namespaces, hidden by default on the Workloads page',
        tags: ['settings'],
        response: { 200: NamespacesSchema, 401: ProblemSchema },
      },
    },
    () => settings.namespaces(),
  );

  app.put(
    '/settings/namespaces',
    {
      preHandler: canManage,
      schema: {
        summary: 'Set the system namespaces, or go back to the default (null)',
        tags: ['settings'],
        body: Type.Object(
          {
            system: Nullable(Type.Array(NamespaceName, { maxItems: 200 })),
            watchlog: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: { 200: NamespacesSchema, ...Errors },
      },
    },
    async (request) => {
      const { system, watchlog } = request.body;
      if (system === null) await settings.remove('namespaces');
      else
        await settings.save(
          'namespaces',
          { system: [...new Set(system)].sort(), watchlog: watchlog ?? true },
          null,
          request.user!.id,
        );
      return settings.namespaces();
    },
  );

  // ---------------------------------------------------------------- email server

  app.get(
    '/settings/smtp',
    {
      preHandler: signedIn,
      schema: {
        summary: 'The email server for email alert channels; the password is never returned',
        tags: ['settings'],
        response: { 200: Type.Object({ smtp: Nullable(SmtpSchema) }), 401: ProblemSchema },
      },
    },
    async () => ({ smtp: demoMode ? null : await settings.smtp() }),
  );

  /** The stored password when the request leaves it out. */
  async function passwordFor(given: string | undefined): Promise<string | undefined> {
    if (given !== undefined) return given || undefined;
    const row = await settings.row('smtp');
    return settings.smtpPassword(row?.secret ?? null);
  }

  app.put(
    '/settings/smtp',
    {
      preHandler: canManage,
      schema: {
        summary: 'Save the email server (the password is encrypted, ADR-079)',
        tags: ['settings'],
        body: SmtpBody,
        response: { 200: Type.Object({ smtp: Nullable(SmtpSchema) }), ...Errors },
      },
    },
    async (request, reply) => {
      if ((await settings.smtp())?.source === 'env')
        return sendProblem(reply, 409, FROM_ENVIRONMENT);
      const { password, ...cfg } = request.body;
      const pass = await passwordFor(password);
      await settings.save(
        'smtp',
        cfg,
        pass ? encryptJson(settings.config.secretKey, { password: pass }) : null,
        request.user!.id,
      );
      return { smtp: await settings.smtp() };
    },
  );

  app.delete(
    '/settings/smtp',
    {
      preHandler: canManage,
      schema: {
        summary: 'Remove the email server',
        tags: ['settings'],
        response: { 204: Type.Null(), ...Errors },
      },
    },
    async (_request, reply) => {
      if ((await settings.smtp())?.source === 'env')
        return sendProblem(reply, 409, FROM_ENVIRONMENT);
      await settings.remove('smtp');
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/settings/smtp/test',
    {
      preHandler: canManage,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        summary:
          "Send a test email to you with these settings (or the environment's), before saving",
        tags: ['settings'],
        body: Type.Optional(SmtpBody),
        response: {
          200: Type.Object({
            ok: Type.Boolean(),
            to: Type.String(),
            ms: Type.Integer(),
            error: Nullable(Type.String()),
          }),
          ...Errors,
        },
      },
    },
    async (request, reply) => {
      const to = request.user!.email;
      const env = settings.config.smtp;
      let transport: string | Record<string, unknown>;
      let from: string;
      if (env) {
        transport = env.url;
        from = env.from;
      } else if (request.body) {
        const { password, ...cfg } = request.body;
        transport = smtpTransport(cfg as SmtpConfig, await passwordFor(password));
        from = cfg.from;
      } else {
        return sendProblem(reply, 400, 'Enter the email server first');
      }
      const started = Date.now();
      const transporter =
        typeof transport === 'string'
          ? nodemailer.createTransport(transport)
          : nodemailer.createTransport({
              connectionTimeout: 10_000,
              greetingTimeout: 10_000,
              socketTimeout: 10_000,
              ...transport,
            });
      try {
        await transporter.sendMail({
          from,
          to,
          subject: 'WatchLog test email',
          text: 'This is a test from WatchLog. Email alerts will be sent this way.',
        });
        return { ok: true, to, ms: Date.now() - started, error: null };
      } catch (err) {
        // The provider's own answer, e.g. "Invalid login: 535 5.7.8 Username and Password not accepted".
        return {
          ok: false,
          to,
          ms: Date.now() - started,
          error: (err as Error).message.slice(0, 500),
        };
      } finally {
        transporter.close();
      }
    },
  );

  // ---------------------------------------------------------------- Telegram

  const TelegramSchema = Type.Object({ proxyUrl: Nullable(Type.String()), source: SourceSchema });

  /** The proxy as the API shows it: never its password (in any mode), nothing in a demo. */
  async function telegramView() {
    if (demoMode) return { proxyUrl: null, source: 'none' as const };
    const t = await settings.telegram();
    return { ...t, proxyUrl: t.proxyUrl === null ? null : redactUrl(t.proxyUrl) };
  }

  app.get(
    '/settings/telegram',
    {
      preHandler: signedIn,
      schema: {
        summary: "Telegram's outbound proxy; a password in it is never returned",
        tags: ['settings'],
        response: { 200: TelegramSchema, 401: ProblemSchema },
      },
    },
    telegramView,
  );

  app.put(
    '/settings/telegram',
    {
      preHandler: canManage,
      schema: {
        summary: 'Set or clear the HTTPS proxy used to reach Telegram',
        tags: ['settings'],
        body: Type.Object(
          { proxyUrl: Nullable(Type.String({ maxLength: 2048 })) },
          { additionalProperties: false },
        ),
        response: { 200: TelegramSchema, ...Errors },
      },
    },
    async (request, reply) => {
      const current = await settings.telegram();
      if (current.source === 'env') {
        return sendProblem(reply, 409, FROM_ENVIRONMENT);
      }
      // The form shows the password masked; saving it unchanged keeps the stored one.
      const given = request.body.proxyUrl?.trim();
      const raw = given ? restoreUrlPassword(given, current.proxyUrl ?? undefined) : given;
      if (!raw) await settings.remove('telegram');
      else {
        const u = URL.canParse(raw) ? new URL(raw) : null;
        if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
          return sendProblem(
            reply,
            400,
            'Enter a proxy address such as http://proxy.example.com:3128',
          );
        }
        await settings.save('telegram', { proxyUrl: raw }, null, request.user!.id);
      }
      return telegramView();
    },
  );

  app.get(
    '/settings/telegram/reachability',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Whether this server reaches the Telegram Bot API (through the proxy if set)',
        tags: ['settings'],
        response: {
          200: Type.Object({ reachable: Type.Boolean(), error: Nullable(Type.String()) }),
          401: ProblemSchema,
        },
      },
    },
    async () => {
      const s = await settings.alerting();
      try {
        await http.probe(s.telegramApiUrl, s.telegramProxy);
        return { reachable: true, error: null };
      } catch (err) {
        return { reachable: false, error: (err as Error).message };
      }
    },
  );
};
