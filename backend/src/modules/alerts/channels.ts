// SPDX-License-Identifier: AGPL-3.0-only
// Channel senders (ADR-080): Slack incoming webhook, Telegram bot, email over SMTP and
// a signed JSON webhook. HTTP goes through one client that honours the outbound proxy.
import { createHmac } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch, type Dispatcher } from 'undici';
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

export class DeliveryError extends Error {
  constructor(
    message: string,
    /** Retrying cannot help (wrong URL, revoked token, rejected recipient). */
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

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
const USER_AGENT = 'WatchLog-Alerts/1';

export interface HttpResponse {
  status: number;
  body: string;
}

/** A network failure, not an answer: the host could not be reached. */
export class UnreachableError extends DeliveryError {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message, false);
  }
}

export class HttpClient {
  private readonly dispatcher: Dispatcher;
  /** Agents for proxies set per call (Telegram's proxy from Settings, ADR-093). */
  private readonly proxies = new Map<string, Dispatcher>();

  constructor(proxy: { http?: string; https?: string; no?: string } = {}) {
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
  ): Promise<HttpResponse> {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, ...headers },
        dispatcher: this.via(proxy),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (err) {
      throw unreachable(url, err);
    }
    return { status: res.status, body: (await res.text()).slice(0, 500) };
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
      throw unreachable(url, err);
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.dispatcher, ...this.proxies.values()].map((d) => d.close()));
    this.proxies.clear();
  }
}

function unreachable(url: string, err: unknown): UnreachableError {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const reason =
    (err as Error).name === 'TimeoutError'
      ? 'timed out'
      : (cause?.code ?? cause?.message ?? (err as Error).message);
  return new UnreachableError(`${hostOf(url)} unreachable: ${reason}`, reason);
}

function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).host : 'endpoint';
}

/** 4xx other than timeouts and rate limits will fail again (ADR-074). */
export function isPermanentStatus(status: number): boolean {
  return [400, 401, 403, 404, 405, 410, 413, 422].includes(status);
}

function check(res: HttpResponse, what: string): void {
  if (res.status >= 200 && res.status < 300) return;
  throw new DeliveryError(
    `${what} answered ${res.status}: ${res.body.slice(0, 200)}`,
    isPermanentStatus(res.status),
  );
}

// ---------------------------------------------------------------- Slack

const escSlack = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SLACK_COLOR: Record<string, string> = {
  critical: 'danger',
  warning: 'warning',
  resolved: 'good',
};

export function slackBody(m: RenderedMessage, p: MessagePayload): object {
  const blocks: object[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${escSlack(m.title)}*` } },
  ];
  for (const it of m.items) {
    const lines = [
      m.single ? null : `*${escSlack(it.title)}*`,
      it.why ? escSlack(it.why) : null,
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
  check(await ctx.http.post(url, JSON.stringify(slackBody(m, p))), 'Slack');
}

// ---------------------------------------------------------------- Telegram

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function telegramText(m: RenderedMessage): string {
  const lines = [`<b>${escHtml(m.title)}</b>`];
  for (const it of m.items) {
    lines.push('');
    if (!m.single) lines.push(`<b>${escHtml(it.title)}</b>`);
    if (it.why) lines.push(escHtml(it.why));
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
  );
  let parsed: { ok?: boolean; result?: unknown; description?: string } = {};
  try {
    parsed = JSON.parse(res.body) as typeof parsed;
  } catch {
    // reported below
  }
  if (res.status >= 200 && res.status < 300 && parsed.ok) return parsed.result;
  throw new DeliveryError(
    `Telegram ${method} answered ${res.status}: ${parsed.description ?? res.body.slice(0, 200)}`,
    isPermanentStatus(res.status),
  );
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
    const e = err as { responseCode?: number; code?: string; message: string };
    // SMTP 5xx replies are final (unknown recipient, rejected sender); 4xx and network errors are not.
    const permanent = (e.responseCode ?? 0) >= 500 || e.code === 'EENVELOPE';
    throw new DeliveryError(`SMTP: ${e.message.slice(0, 200)}`, permanent);
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
      ...(it.likelyCause ? { likelyCause: it.likelyCause } : {}),
    })),
    total: p.total,
    alerts_link: m.alertsLink,
    sent_at: new Date(at).toISOString(),
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
  check(await ctx.http.post(url, body, headers), 'Webhook');
}

/** Sends one message to one channel; throws DeliveryError with the provider's answer. */
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
