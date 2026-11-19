// SPDX-License-Identifier: AGPL-3.0-only
// Sending one WatchLog email (ADR-220): every message is drawn with the shared template
// (@watchlog/email) and goes out multipart, HTML and a written plain-text part. Headers that
// carry names are cleaned of line breaks; lifecycle emails add List-Unsubscribe, alerts their
// thread (Message-ID, In-Reply-To, References). No tracking pixel, no tracked link: the
// template has no remote image and the links are the dashboard's own.
import type { Transporter } from 'nodemailer';
import { headerText, renderEmail, type EmailSpec, type RenderedEmail } from '@watchlog/email';
import type { Edition } from '../config.js';

export type { EmailSpec, RenderedEmail };

export interface SmtpTarget {
  transport: string | Record<string, unknown>;
  from: string;
}

export interface OutgoingMail {
  to: string | string[];
  email: RenderedEmail;
  from?: string;
  replyTo?: string;
  /** Message-ID and its thread (alerts). */
  messageId?: string;
  inReplyTo?: string;
  /** Lifecycle emails only: the one-click unsubscribe (RFC 8058). */
  unsubscribeUrl?: string;
  headers?: Record<string, string>;
}

/** Renders a spec for an edition (the footer names Cloud only in Cloud). */
export function render(spec: EmailSpec, edition: Edition): RenderedEmail {
  return renderEmail({ ...spec, edition });
}

/** nodemailer's message for one email: both parts and the clean headers. */
export function message(m: OutgoingMail, smtpFrom: string) {
  const headers: Record<string, string> = { ...(m.headers ?? {}) };
  if (m.unsubscribeUrl) {
    headers['List-Unsubscribe'] = `<${m.unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return {
    from: m.from ?? smtpFrom,
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    to: m.to,
    subject: headerText(m.email.subject),
    text: m.email.text,
    html: m.email.html,
    ...(m.messageId ? { messageId: m.messageId } : {}),
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo, references: [m.inReplyTo] } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

/** Sends through a transporter (the caller's, for its timeouts and cache). */
export async function deliver(t: Transporter, smtp: SmtpTarget, m: OutgoingMail): Promise<void> {
  await t.sendMail(message(m, smtp.from));
}

/** The domain for Message-IDs: the sender's, else the dashboard's host. */
export function mailDomain(from: string, publicUrl?: string): string {
  const m = /@([A-Za-z0-9.-]+)>?\s*$/.exec(from);
  if (m) return m[1]!.toLowerCase();
  try {
    return publicUrl ? new URL(publicUrl).hostname : 'watchlog.local';
  } catch {
    return 'watchlog.local';
  }
}
