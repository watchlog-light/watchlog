// SPDX-License-Identifier: AGPL-3.0-only
// One-click unsubscribe from the lifecycle emails (ADR-179, RFC 8058), Cloud only. The link
// carries a signed token (the user's id and an HMAC-SHA-256 under a key derived from
// WATCHLOG_SECRET_KEY), so it works without signing in and can't be forged for another
// user. GET shows a page with one button (a link scanner opening the URL changes nothing);
// POST, from that button or from the mail client's List-Unsubscribe-Post, unsubscribes.
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function macKey(secretKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', secretKey, '', 'watchlog lifecycle unsubscribe', 32));
}

const mac = (secretKey: Buffer, userId: string) =>
  createHmac('sha256', macKey(secretKey)).update(userId).digest().subarray(0, 18);

/** `<userId>.<mac>`: the token in the unsubscribe link. */
export function unsubscribeToken(secretKey: Buffer, userId: string): string {
  return `${userId}.${mac(secretKey, userId).toString('base64url')}`;
}

/** The user id a token was signed for, or null. */
export function verifyUnsubscribeToken(secretKey: Buffer, token: string): string | null {
  const [userId, sig, extra] = token.split('.');
  if (!userId || !sig || extra !== undefined || !UUID.test(userId)) return null;
  // Compared as text: base64url decoding would ignore extra characters.
  const given = Buffer.from(sig);
  const want = Buffer.from(mac(secretKey, userId).toString('base64url'));
  return given.length === want.length && timingSafeEqual(given, want) ? userId : null;
}

/** The link in the email and in List-Unsubscribe (the API's address on the dashboard's host). */
export function unsubscribeUrl(site: string, secretKey: Buffer, userId: string): string {
  return `${site}/api/v1/email/unsubscribe?token=${encodeURIComponent(unsubscribeToken(secretKey, userId))}`;
}

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.25rem">${title}</h1>${body}</body></html>`;

function html(reply: FastifyReply, code: number, title: string, body: string) {
  return reply
    .code(code)
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(page(title, body));
}

export const unsubscribeRoutes: FastifyPluginAsyncTypebox<{
  systemDb: Database;
  secretKey: Buffer;
}> = async (app, { systemDb, secretKey }) => {
  // RFC 8058's one-click POST is a form body (`List-Unsubscribe=One-Click`); this route only.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 1024 },
    (_req, body, done) => done(null, body),
  );
  const Query = Type.Object({ token: Type.String({ maxLength: 120 }) });
  const invalid = (reply: FastifyReply) =>
    html(
      reply,
      400,
      'This link does not work',
      '<p>The unsubscribe link is incomplete or was changed. Use the link from the latest email, or reply to it and we will stop them for you.</p>',
    );

  app.get(
    '/email/unsubscribe',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        summary: 'Cloud: the lifecycle emails’ unsubscribe page (one button)',
        tags: ['cloud'],
        hide: true,
        querystring: Query,
      },
    },
    async (request, reply) => {
      const token = request.query.token;
      if (!verifyUnsubscribeToken(secretKey, token)) return invalid(reply);
      return html(
        reply,
        200,
        'Stop the getting-started emails?',
        `<p>WatchLog sends a few emails while you are getting started. Alerts, security emails and notices about your plan still arrive.</p>
<form method="post" action="/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}"><button type="submit" style="font-size:1rem;padding:.5rem 1rem">Unsubscribe</button></form>`,
      );
    },
  );

  app.post(
    '/email/unsubscribe',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        summary: 'Cloud: unsubscribe from the lifecycle emails (RFC 8058 one-click)',
        tags: ['cloud'],
        hide: true,
        querystring: Query,
      },
    },
    async (request, reply) => {
      const userId = verifyUnsubscribeToken(secretKey, request.query.token);
      if (!userId) return invalid(reply);
      // Users are global (a user spans orgs): the owner's connection, the token names the user.
      await systemDb
        .updateTable('users')
        .set({ lifecycle_unsubscribed_at: new Date() })
        .where('id', '=', userId)
        .where('lifecycle_unsubscribed_at', 'is', null)
        .execute();
      request.log.info({ userId }, 'lifecycle emails unsubscribed');
      return html(
        reply,
        200,
        'You are unsubscribed',
        '<p>You will not get any more getting-started emails from WatchLog. Alerts, security emails and notices about your plan still arrive.</p>',
      );
    },
  );
};
