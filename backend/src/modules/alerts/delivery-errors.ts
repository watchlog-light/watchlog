// SPDX-License-Identifier: AGPL-3.0-only
// What a failed delivery says (ADR-218): one short sentence a person can act on, with the
// provider's status code and, where the provider has one, its own error description. Never
// the provider's raw answer: a Telegram answer names the chat and its people, a webhook's
// answer is whatever its server wrote. These messages go to the channel's row, the alert's
// page, the "Send test" answer and the worker's log, so no chat id, username, token, address
// or URL may reach them: `redact` is applied to everything that came from outside.

export class DeliveryError extends Error {
  constructor(
    message: string,
    /** Retrying cannot help (wrong URL, revoked token, rejected recipient). */
    readonly permanent: boolean,
    /** The provider asked to wait this long before the next try (429). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** A network failure, not an answer: the host could not be reached. */
export class UnreachableError extends DeliveryError {
  constructor(
    message: string,
    /** In plain words: "timed out", "the connection was refused". */
    readonly reason: string,
  ) {
    super(message, false);
  }
}

/** 4xx other than timeouts and rate limits will fail again (ADR-074). */
export function isPermanentStatus(status: number): boolean {
  return [400, 401, 403, 404, 405, 410, 413, 422].includes(status);
}

const MAX_RETRY_AFTER_S = 3600;

/** Seconds from a Retry-After header or Telegram's `retry_after`; undefined when unusable. */
export function retryAfterMs(seconds: unknown): number | undefined {
  const s = typeof seconds === 'string' ? Number(seconds) : seconds;
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return undefined;
  return Math.min(s, MAX_RETRY_AFTER_S) * 1000;
}

/**
 * A text from outside made safe to show and to log: no URL, no bot token, no email address,
 * no @username, no long number (a chat or user id), one line, at most `max` characters.
 */
export function redact(text: string, max = 120): string {
  const clean = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[address]')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}/g, '[token]')
    .replace(/<?[\w.+-]+@[\w-]+(\.[\w-]+)+>?/g, '[address]')
    .replace(/@[A-Za-z0-9_]{3,}/g, '[name]')
    .replace(/-?\d{6,}/g, '[id]')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

const CODES: [RegExp, string][] = [
  [/TIMEOUT|ETIMEDOUT/, 'timed out'],
  [/ENOTFOUND|EAI_AGAIN/, 'its name could not be resolved'],
  [/ECONNREFUSED/, 'the connection was refused'],
  [/ECONNRESET|EPIPE|UND_ERR_SOCKET/, 'the connection was closed'],
  [/EHOSTUNREACH|ENETUNREACH/, 'there is no route to it'],
  [/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL/, 'its certificate was not accepted'],
];

/**
 * Why a request got no answer, in plain words. Only the error's code is read: its message can
 * hold the address that was called, and Telegram's has the bot token in it.
 */
export function networkReason(err: unknown): string {
  const e = err as { name?: string; code?: string; message?: string; cause?: unknown };
  const cause = e.cause as { name?: string; code?: string; message?: string } | undefined;
  if (e.name === 'TimeoutError' || cause?.name === 'TimeoutError') return 'timed out';
  const code = String(cause?.code ?? e.code ?? '');
  for (const [re, words] of CODES) if (re.test(code)) return words;
  if (/redirect/i.test(cause?.message ?? e.message ?? '')) return 'it answered with a redirect';
  return /^[A-Z][A-Z0-9_]{2,40}$/.test(code) ? `network error ${code}` : 'network error';
}

/** Who was called, as the sentence names it. */
export type Callee = 'Telegram' | 'Slack' | "the webhook's server" | 'the mail server';

export function unreachableError(who: Callee | string, err: unknown): UnreachableError {
  const reason = networkReason(err);
  return new UnreachableError(`Could not reach ${who}: ${reason}.`, reason);
}

const LATER = 'It usually passes within a few minutes.';

// ---------------------------------------------------------------- Telegram

export interface TelegramAnswer {
  ok?: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

/** Telegram's description without its "Bad Request: " or "Forbidden: " prefix. */
const telegramDescription = (a: TelegramAnswer | null): string =>
  redact((a?.description ?? '').replace(/^(Bad Request|Forbidden|Unauthorized|Not Found):\s*/, ''));

const TELEGRAM_WHY: [number[], RegExp, string, string][] = [
  [
    [403],
    /blocked by the user/,
    'the bot was blocked in the chat',
    'Unblock the bot in Telegram, or connect another chat.',
  ],
  [
    [403],
    /kicked|not a member|was deleted|chat was deleted/,
    'the bot was removed from the chat',
    'Add the bot to the chat again, or connect another chat.',
  ],
  [[403], /deactivated/, "the chat's account was deleted", 'Connect another chat.'],
  [
    [403],
    /can't initiate|can't send messages to bots/,
    'the chat has not started the bot',
    'Open the bot in Telegram and press Start, or connect another chat.',
  ],
  [
    [400, 403],
    /not enough rights|have no rights|write_forbidden|need administrator rights/,
    'the bot may not write in the chat',
    'Give the bot the right to send messages there.',
  ],
  [[400], /chat not found/, 'Telegram cannot find the chat', 'Connect the chat again.'],
  [
    [400],
    /upgraded to a supergroup/,
    'the group became a supergroup and has a new address',
    'Connect the chat again.',
  ],
];

/**
 * A Telegram call that was refused or could not be read. `answer` is the parsed body, null
 * when it was not JSON (a proxy answering in Telegram's place).
 */
export function telegramError(
  method: string,
  status: number,
  answer: TelegramAnswer | null,
): DeliveryError {
  const sending = method === 'sendMessage';
  const did = sending ? 'Telegram refused the message' : 'Telegram refused the request';
  const permanent = isPermanentStatus(status);
  if (status >= 200 && status < 300 && answer === null) {
    return new DeliveryError(
      `Telegram's answer could not be read (${status}). If a proxy is set for Telegram, check that it passes the answer on.`,
      false,
    );
  }
  // An unknown token: 401 "Unauthorized", or 404 "Not Found" when it is not shaped like one.
  if (status === 401 || status === 404) {
    return new DeliveryError(
      `Telegram did not accept the bot token (${status}). Copy the token from BotFather again.`,
      true,
    );
  }
  if (status === 429) {
    return new DeliveryError(
      `Telegram is limiting how fast this bot may send (429). ${LATER}`,
      false,
      retryAfterMs(answer?.parameters?.retry_after),
    );
  }
  if (status >= 500) {
    return new DeliveryError(`Telegram had a problem of its own (${status}). ${LATER}`, false);
  }
  const description = telegramDescription(answer);
  const known = TELEGRAM_WHY.find(
    ([codes, re]) => codes.includes(status) && re.test(answer?.description ?? ''),
  );
  if (known && sending) {
    return new DeliveryError(`${did}: ${known[2]} (${status}). ${known[3]}`, permanent);
  }
  return new DeliveryError(
    description ? `${did} (${status}: ${description}).` : `${did} (${status}).`,
    permanent,
  );
}

// ---------------------------------------------------------------- Slack

/** Slack answers an incoming webhook's error with one word (`no_service`); nothing else is kept. */
const slackCode = (body: string): string | null =>
  /^[a-z][a-z0-9_]{1,60}$/.test(body.trim()) ? body.trim() : null;

export function slackError(status: number, body: string, retryAfter?: unknown): DeliveryError {
  const code = slackCode(body);
  const permanent = isPermanentStatus(status);
  const tail = code ? `${status}: ${code}` : String(status);
  if (status === 429) {
    return new DeliveryError(
      `Slack is limiting how fast this webhook may post (429). ${LATER}`,
      false,
      retryAfterMs(retryAfter),
    );
  }
  if (status >= 500) {
    return new DeliveryError(`Slack had a problem of its own (${status}). ${LATER}`, false);
  }
  if (code === 'channel_not_found' || code === 'channel_is_archived') {
    return new DeliveryError(
      `Slack refused the message: the webhook's channel was deleted or archived (${tail}). Create an incoming webhook for another channel and paste its address here.`,
      true,
    );
  }
  if (
    status === 404 ||
    status === 410 ||
    ['no_service', 'no_active_hooks', 'invalid_token', 'no_team'].includes(code ?? '')
  ) {
    return new DeliveryError(
      `Slack refused the message: this webhook no longer exists (${tail}). Create a new incoming webhook in Slack and paste its address here.`,
      true,
    );
  }
  if (status === 403) {
    return new DeliveryError(
      `Slack refused the message: the workspace does not let this webhook post (${tail}). Ask a Slack admin, or create a new webhook.`,
      true,
    );
  }
  return new DeliveryError(`Slack refused the message (${tail}).`, permanent);
}

// ---------------------------------------------------------------- webhook

/** A webhook's answer is its server's own text: only the status is kept. */
export function webhookError(status: number, retryAfter?: unknown): DeliveryError {
  const permanent = isPermanentStatus(status);
  if (status === 401 || status === 403) {
    return new DeliveryError(
      `The webhook's server refused the request (${status}). Check what it expects: a token in the address, or the signing secret.`,
      true,
    );
  }
  if (status === 404 || status === 410) {
    return new DeliveryError(
      `The webhook's server has nothing at this address (${status}). Check the URL.`,
      true,
    );
  }
  if (status === 429) {
    return new DeliveryError(
      `The webhook's server is limiting requests (429). ${LATER}`,
      false,
      retryAfterMs(retryAfter),
    );
  }
  if (status >= 500) {
    return new DeliveryError(`The webhook's server answered with an error (${status}).`, false);
  }
  return new DeliveryError(`The webhook's server refused the message (${status}).`, permanent);
}

// ---------------------------------------------------------------- email

interface SmtpFailure {
  responseCode?: number;
  code?: string;
  command?: string;
  message?: string;
}

/** SMTP 5xx replies are final (unknown recipient, rejected sender); 4xx and network errors are not. */
export function smtpError(err: unknown): DeliveryError {
  const e = err as SmtpFailure;
  const status = e.responseCode ?? 0;
  const tail = status ? ` (${status})` : '';
  if (e.code === 'EAUTH' || status === 535 || status === 534) {
    return new DeliveryError(
      `The mail server refused WatchLog's login${tail}. Check the user and password in the email settings.`,
      true,
    );
  }
  if (e.code === 'EENVELOPE' || [550, 551, 553].includes(status)) {
    return new DeliveryError(
      `The mail server refused a recipient or the sender${tail}. Check the channel's addresses and the "from" address.`,
      true,
    );
  }
  if (status >= 500) {
    return new DeliveryError(`The mail server refused the message${tail}.`, true);
  }
  if (status >= 400) {
    return new DeliveryError(`The mail server asked to try again later${tail}. ${LATER}`, false);
  }
  // No reply at all: the connection (ECONNECTION, ETIMEDOUT, ESOCKET, EDNS, ETLS).
  const reason = /TIMEDOUT|TIMEOUT/.test(e.code ?? '')
    ? 'timed out'
    : e.code === 'EDNS'
      ? 'its name could not be resolved'
      : e.code === 'ETLS'
        ? 'its certificate was not accepted'
        : networkReason(err);
  return new UnreachableError(`Could not reach the mail server: ${reason}.`, reason);
}
