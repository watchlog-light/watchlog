// SPDX-License-Identifier: AGPL-3.0-only
// Channel senders (ADR-080): Slack incoming webhook, Telegram bot, email over SMTP and
// a signed JSON webhook. HTTP goes through one client that honours the outbound proxy.
import { createHmac } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch, type Dispatcher } from 'undici';
import { EgressRefused, type EgressPolicy } from '../../lib/egress.js';
import {
  DeliveryError,
  slackError,
  smtpError,
  telegramError,
  unreachableError,
  webhookError,
  type Callee,
  type TelegramAnswer,
} from './delivery-errors.js';
import type { NotifyCause } from './likely-cause.js';
import type { MessagePayload } from './outbox.js';
import { renderMessage, type RenderedMessage } from './render.js';

export type ChannelType = 'slack' | 'telegram' | 'email' | 'webhook';

/** A channel with its secrets decrypted, ready to send. */
export interface ChannelTarget {
  id: string;
  type: ChannelType;
  name: string;
  config: Record<string, unknown>;
  secret: Record<string, string>;
}

export { DeliveryError, UnreachableError, isPermanentStatus } from './delivery-errors.js';

export interface DeliveryContext {
  http: HttpClient;
  publicUrl?: string;
  telegramApiUrl: string;
  telegramProxy?: string;
  /** A URL or nodemailer transport options, and the sender (ADR-080, ADR-093). */
  smtp?: { transport: string | Record<string, unknown>; from: string };
  /** The notification id: idempotency key for webhooks (ADR-074). */
  deliveryId: string;
  now?: () => number;
}

export const TIMEOUT_MS = 10_000;
/**
 * How much of an answer is read. Telegram's answers are JSON that must be read whole to be
 * understood (a sent message comes back with its chat and its text: more than 500 characters,
 * which was the limit until 0.9.8 and made every delivered message look refused); a webhook's
 * server may answer with anything, so the rest is not read.
 */
export const MAX_ANSWER_BYTES = 1024 * 1024;
const USER_AGENT = 'WatchLog-Alerts/1';

export interface HttpResponse {
  status: number;
  /** The answer's text, up to MAX_ANSWER_BYTES. */
  body: string;
  /** The answer was longer than that. */
  truncated: boolean;
  /** The Retry-After header, in seconds, when the server sent one. */
  retryAfter?: string;
}

/** How a request's address came to us. */
export interface PostOptions {
  /**
   * A user gave the URL (a Slack or webhook channel): in Cloud it goes through the egress
   * policy (ADR-181): checked, connected only to a checked address, never via the proxy.
   */
  userUrl?: boolean;
  /** Who is called, as a failure names it ("Could not reach Telegram: timed out."). */
  who?: Callee;
}

/** Reads an answer's body up to `max` bytes and lets go of the rest. */
async function readAnswer(
  body: AsyncIterable<Uint8Array> | null,
  max: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: '', truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of body) {
    if (size + chunk.length > max) {
      chunks.push(chunk.subarray(0, max - size));
      truncated = true;
      break; // leaving the loop cancels the stream
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

export class HttpClient {
  private readonly dispatcher: Dispatcher;
  /** Agents for proxies set per call (Telegram's proxy from Settings, ADR-093). */
  private readonly proxies = new Map<string, Dispatcher>();

  constructor(
    proxy: { http?: string; https?: string; no?: string } = {},
    /** Cloud's egress policy for users' URLs (ADR-181); Community has none (ADR-091). */
    readonly egress: EgressPolicy | null = null,
    /** How long a request may take, answer included. */
    private readonly timeoutMs = TIMEOUT_MS,
  ) {
    this.dispatcher =
      proxy.http || proxy.https
        ? new EnvHttpProxyAgent({
            httpProxy: proxy.http,
            httpsProxy: proxy.https,
            noProxy: proxy.no,
          })
        : new Agent();
  }

  private via(proxy?: string): Dispatcher {
    if (!proxy) return this.dispatcher;
    let d = this.proxies.get(proxy);
    if (!d) {
      d = new ProxyAgent(proxy);
      this.proxies.set(proxy, d);
    }
    return d;
  }

  async post(
    url: string,
    body: string,
    headers: Record<string, string> = {},
    proxy?: string,
    opts: PostOptions = {},
  ): Promise<HttpResponse> {
    const guarded = opts.userUrl && this.egress;
    if (guarded) {
      try {
        await guarded.assertUrl(url);
      } catch (err) {
        throw refused(url, err as EgressRefused);
      }
    }
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, ...headers },
        dispatcher: guarded ? guarded.dispatcher : this.via(proxy),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof EgressRefused) throw refused(url, cause);
      throw unreachableError(opts.who ?? hostOf(url), err);
    }
    let answer;
    try {
      answer = await readAnswer(res.body, MAX_ANSWER_BYTES);
    } catch (err) {
      // The status came, the body did not (the time ran out, or the connection dropped).
      throw unreachableError(opts.who ?? hostOf(url), err);
    }
    return {
      status: res.status,
      body: answer.text,
      truncated: answer.truncated,
      retryAfter: res.headers.get('retry-after') ?? undefined,
    };
  }

  /** Whether a host answers at all (any HTTP status), within 5 s. */
  async probe(url: string, proxy?: string): Promise<void> {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'user-agent': USER_AGENT },
        dispatcher: this.via(proxy),
        signal: AbortSignal.timeout(5_000),
        redirect: 'manual',
      });
      await res.body?.cancel();
    } catch (err) {
      throw unreachableError(hostOf(url), err);
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.dispatcher, ...this.proxies.values()].map((d) => d.close()));
    this.proxies.clear();
    await this.egress?.close();
  }
}

/** A user's URL the egress policy refused: retrying can't help. */
function refused(url: string, err: EgressRefused): DeliveryError {
  return new DeliveryError(
    `${hostOf(url)} refused: ${err.message}; WatchLog Cloud sends only to public addresses`,
    true,
  );
}

function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).host : 'the server';
}

/** Any 2xx is delivered: Slack answers 200 "ok", a webhook's server whatever it likes. */
const delivered = (res: HttpResponse): boolean => res.status >= 200 && res.status < 300;

// ---------------------------------------------------------------- Slack

const escSlack = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SLACK_COLOR: Record<string, string> = {
  critical: 'danger',
  warning: 'warning',
  resolved: 'good',
};

/**
 * Escapes a line and sets the names from outside it holds as code (ADR-187: destination names
 * come from DNS answers anyone can register, so they never become links).
 */
function withCode(
  text: string,
  code: string[] | undefined,
  esc: (s: string) => string,
  wrap: (s: string) => string,
): string {
  let out = esc(text);
  for (const c of new Set(code ?? [])) out = out.split(esc(c)).join(wrap(esc(c)));
  return out;
}
const slackCode = (s: string, code?: string[]) => withCode(s, code, escSlack, (c) => `\`${c}\``);

export function slackBody(m: RenderedMessage, p: MessagePayload): object {
  const headCode = m.single ? m.items[0]?.code : undefined;
  const blocks: object[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${slackCode(m.title, headCode)}*` } },
  ];
  for (const it of m.items) {
    const lines = [
      m.single ? null : `*${slackCode(it.title, it.code)}*`,
      it.why ? slackCode(it.why, it.code) : null,
      `_${escSlack(it.context)}_`,
      it.cause ? escSlack(it.cause) : null,
      it.link ? `<${it.link}|Open in WatchLog>` : null,
    ].filter(Boolean);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  }
  if (m.more) {
    const more = m.alertsLink ? `<${m.alertsLink}|${m.more}>` : m.more;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: more }] });
  }
  const color = p.kind === 'resolved' ? SLACK_COLOR.resolved : SLACK_COLOR[p.severity];
  const first = m.items[0];
  return {
    text: `${m.title}${first?.why ? ` — ${first.why}` : ''}`,
    attachments: [{ color, blocks }],
  };
}

async function sendSlack(
  ch: ChannelTarget,
  m: RenderedMessage,
  p: MessagePayload,
  ctx: DeliveryContext,
) {
  const url = ch.secret.webhookUrl;
  if (!url) throw new DeliveryError('Slack webhook URL is not set', true);
  const res = await ctx.http.post(url, JSON.stringify(slackBody(m, p)), {}, undefined, {
    userUrl: true,
    who: 'Slack',
  });
  if (!delivered(res)) throw slackError(res.status, res.body, res.retryAfter);
}

// ---------------------------------------------------------------- Telegram

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const htmlCode = (s: string, code?: string[]) =>
  withCode(s, code, escHtml, (c) => `<code>${c}</code>`);

export function telegramText(m: RenderedMessage): string {
  const lines = [`<b>${htmlCode(m.title, m.single ? m.items[0]?.code : undefined)}</b>`];
  for (const it of m.items) {
    lines.push('');
    if (!m.single) lines.push(`<b>${htmlCode(it.title, it.code)}</b>`);
    if (it.why) lines.push(htmlCode(it.why, it.code));
    lines.push(`<i>${escHtml(it.context)}</i>`);
    if (it.cause) lines.push(escHtml(it.cause));
    if (it.link) lines.push(`<a href="${escHtml(it.link)}">Open in WatchLog</a>`);
  }
  if (m.more) {
    lines.push('', m.alertsLink ? `<a href="${escHtml(m.alertsLink)}">${m.more}</a>` : m.more);
  }
  return lines.join('\n');
}

export async function telegramCall(
  http: HttpClient,
  apiUrl: string,
  token: string,
  method: string,
  body: object,
  proxy?: string,
): Promise<unknown> {
  const res = await http.post(
    `${apiUrl.replace(/\/+$/, '')}/bot${token}/${method}`,
    JSON.stringify(body),
    {},
    proxy,
    { who: 'Telegram' },
  );
  let answer: TelegramAnswer | null = null;
  try {
    const parsed: unknown = JSON.parse(res.body);
    if (parsed && typeof parsed === 'object') answer = parsed as TelegramAnswer;
  } catch {
    // Not JSON, or longer than what is read: decided below.
  }
  // Telegram's own rule: a call worked when it answers 2xx with "ok": true.
  if (delivered(res)) {
    if (answer?.ok === true) return answer.result;
    // Longer than what is read (never a sent message; a full page of updates could be): it
    // still begins with Telegram's "ok".
    if (res.truncated && /^\s*\{\s*"ok"\s*:\s*true\b/.test(res.body)) return undefined;
  }
  throw telegramError(method, res.status, answer);
}

async function sendTelegram(ch: ChannelTarget, m: RenderedMessage, ctx: DeliveryContext) {
  const token = ch.secret.botToken;
  const chatId = ch.config.chatId;
  if (!token) throw new DeliveryError('Telegram bot token is not set', true);
  if (chatId === undefined || chatId === null) {
    throw new DeliveryError(
      'Telegram chat is not connected yet: open the connect link first',
      true,
    );
  }
  await telegramCall(
    ctx.http,
    ctx.telegramApiUrl,
    token,
    'sendMessage',
    {
      chat_id: chatId,
      text: telegramText(m),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    },
    ctx.telegramProxy,
  );
}

// ---------------------------------------------------------------- Email

const transports = new Map<string, Transporter>();

/** A cached transporter per server: a URL (environment) or options (settings, ADR-093). */
export function transport(server: string | Record<string, unknown>): Transporter {
  const key = typeof server === 'string' ? server : JSON.stringify(server);
  let t = transports.get(key);
  if (!t) {
    if (typeof server === 'string') {
      // Timeouts as query parameters: nodemailer reads transport options from the URL.
      const u = new URL(server);
      for (const k of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) {
        if (!u.searchParams.has(k)) u.searchParams.set(k, String(TIMEOUT_MS));
      }
      t = nodemailer.createTransport(u.toString());
    } else {
      t = nodemailer.createTransport({
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS,
        ...server,
      });
    }
    transports.set(key, t);
  }
  return t;
}

async function sendEmail(ch: ChannelTarget, m: RenderedMessage, ctx: DeliveryContext) {
  if (!ctx.smtp) {
    throw new DeliveryError('Email is not configured on this server: set WATCHLOG_SMTP_URL', true);
  }
  const to = (ch.config.recipients as string[] | undefined) ?? [];
  if (to.length === 0) throw new DeliveryError('The email channel has no recipients', true);
  try {
    await transport(ctx.smtp.transport).sendMail({
      from: ctx.smtp.from,
      to,
      subject: m.subject,
      text: m.text,
      headers: { 'X-WatchLog-Delivery': ctx.deliveryId },
    });
  } catch (err) {
    throw smtpError(err);
  }
}

// ---------------------------------------------------------------- Webhook

export function webhookBody(p: MessagePayload, m: RenderedMessage, at: number): object {
  return {
    version: 1,
    event: p.kind,
    severity: p.severity,
    rule: p.rule,
    cluster: { id: p.cluster.id, name: p.cluster.name },
    alerts: p.items.map((it, i) => ({
      id: it.alertId,
      severity: it.severity,
      labels: it.labels,
      title: m.items[i]?.title ?? null,
      why: m.items[i]?.why ?? null,
      summary: typeof it.details.summary === 'string' ? it.details.summary : null,
      started_at: it.startedAt,
      fired_at: it.firedAt,
      resolved_at: it.resolvedAt,
      link: m.items[i]?.link ?? null,
      // ADR-148, ADR-157: only when it fired with a likely cause; additive.
      ...(it.likelyCause ? { likelyCause: webhookCause(it.likelyCause) } : {}),
    })),
    total: p.total,
    alerts_link: m.alertsLink,
    sent_at: new Date(at).toISOString(),
  };
}

/**
 * The likely cause in the webhook's documented key order (the stored message is jsonb, which
 * sorts keys).
 */
function webhookCause(lc: NotifyCause): NotifyCause {
  return {
    rule: lc.rule,
    code: lc.code,
    facts: lc.facts,
    since: lc.since,
    headline: { code: lc.headline.code, facts: lc.headline.facts },
    subject: lc.subject,
    text: lc.text,
    chain: lc.chain.map((s) => ({
      subject: s.subject,
      name: s.name,
      fact: s.fact,
      facts: s.facts,
      ...(s.since ? { since: s.since } : {}),
      ...(s.at ? { at: s.at } : {}),
    })),
  };
}

/** `t=<unix>,v1=<hex HMAC-SHA256 of "<unix>.<body>">` (ADR-080). */
export function signWebhook(secret: string, body: string, unix: number): string {
  const mac = createHmac('sha256', secret).update(`${unix}.${body}`).digest('hex');
  return `t=${unix},v1=${mac}`;
}

async function sendWebhook(
  ch: ChannelTarget,
  m: RenderedMessage,
  p: MessagePayload,
  ctx: DeliveryContext,
) {
  const url = ch.config.url as string | undefined;
  if (!url) throw new DeliveryError('Webhook URL is not set', true);
  const now = ctx.now?.() ?? Date.now();
  const body = JSON.stringify(webhookBody(p, m, now));
  const headers: Record<string, string> = {
    'x-watchlog-event': p.kind,
    'x-watchlog-delivery': ctx.deliveryId,
  };
  if (ch.secret.signingSecret) {
    headers['x-watchlog-signature'] = signWebhook(
      ch.secret.signingSecret,
      body,
      Math.floor(now / 1000),
    );
  }
  const res = await ctx.http.post(url, body, headers, undefined, {
    userUrl: true,
    who: "the webhook's server",
  });
  if (!delivered(res)) throw webhookError(res.status, res.retryAfter);
}

/** Sends one message to one channel; throws a DeliveryError that says what failed (ADR-218). */
export async function deliver(
  ch: ChannelTarget,
  p: MessagePayload,
  ctx: DeliveryContext,
): Promise<void> {
  const m = renderMessage(p, ctx.publicUrl);
  switch (ch.type) {
    case 'slack':
      return sendSlack(ch, m, p, ctx);
    case 'telegram':
      return sendTelegram(ch, m, ctx);
    case 'email':
      return sendEmail(ch, m, ctx);
    case 'webhook':
      return sendWebhook(ch, m, p, ctx);
  }
}
