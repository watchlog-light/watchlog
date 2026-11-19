// SPDX-License-Identifier: AGPL-3.0-only
// What a failed delivery says (ADR-218): short, what failed and what to do, with the
// provider's status and its own description only. From recorded answers; no network.
import { describe, expect, it } from 'vitest';
import {
  DeliveryError,
  UnreachableError,
  networkReason,
  redact,
  slackError,
  smtpError,
  telegramError,
  unreachableError,
  webhookError,
  type TelegramAnswer,
} from '../src/modules/alerts/delivery-errors.js';
import * as tg from './support/telegram-answers.js';

const told = (r: tg.Recorded, method = 'sendMessage'): DeliveryError => {
  let answer: TelegramAnswer | null = null;
  try {
    answer = JSON.parse(r.body) as TelegramAnswer;
  } catch {
    // not JSON
  }
  return telegramError(method, r.status, answer);
};

describe('Telegram refusals, in words', () => {
  it.each([
    [
      'the bot was blocked',
      tg.BLOCKED,
      'Telegram refused the message: the bot was blocked in the chat (403). Unblock the bot in Telegram, or connect another chat.',
      true,
    ],
    [
      'the bot was removed',
      tg.KICKED,
      'Telegram refused the message: the bot was removed from the chat (403). Add the bot to the chat again, or connect another chat.',
      true,
    ],
    [
      'chat not found',
      tg.CHAT_NOT_FOUND,
      'Telegram refused the message: Telegram cannot find the chat (400). Connect the chat again.',
      true,
    ],
    [
      'the group was upgraded',
      tg.UPGRADED,
      'Telegram refused the message: the group became a supergroup and has a new address (400). Connect the chat again.',
      true,
    ],
    [
      'no right to write',
      tg.NO_RIGHTS,
      'Telegram refused the message: the bot may not write in the chat (400). Give the bot the right to send messages there.',
      true,
    ],
    [
      'a bad token',
      tg.BAD_TOKEN,
      'Telegram did not accept the bot token (401). Copy the token from BotFather again.',
      true,
    ],
    [
      'no such bot',
      tg.NO_SUCH_BOT,
      'Telegram did not accept the bot token (404). Copy the token from BotFather again.',
      true,
    ],
    [
      'too many requests',
      tg.TOO_MANY,
      'Telegram is limiting how fast this bot may send (429). It usually passes within a few minutes.',
      false,
    ],
    [
      "Telegram's own error",
      tg.BAD_GATEWAY,
      'Telegram had a problem of its own (502). It usually passes within a few minutes.',
      false,
    ],
    [
      'a refusal with no sentence of ours',
      tg.TOO_LONG,
      'Telegram refused the message (400: message is too long).',
      true,
    ],
    [
      "a proxy's page in Telegram's place",
      tg.PROXY_PAGE,
      "Telegram's answer could not be read (200). If a proxy is set for Telegram, check that it passes the answer on.",
      false,
    ],
  ])('%s', (_name, recorded, message, permanent) => {
    const err = told(recorded);
    expect(err.message).toBe(message);
    expect(err.permanent).toBe(permanent);
  });

  it('waits as long as Telegram asks after a 429, an hour at most', () => {
    expect(told(tg.TOO_MANY).retryAfterMs).toBe(35_000);
    const long = {
      ...tg.TOO_MANY,
      body: tg.TOO_MANY.body.replace('"retry_after":35', '"retry_after":86400'),
    };
    expect(told(long).retryAfterMs).toBe(3_600_000);
  });

  it('names the request, not a message, for calls that send nothing', () => {
    expect(told(tg.BLOCKED, 'getUpdates').message).toBe(
      'Telegram refused the request (403: bot was blocked by the user).',
    );
    expect(told(tg.BAD_TOKEN, 'getMe').message).toBe(
      'Telegram did not accept the bot token (401). Copy the token from BotFather again.',
    );
  });

  it('never repeats a chat, a person or a token Telegram named', () => {
    const leaky = {
      status: 400,
      body: JSON.stringify({
        ok: false,
        error_code: 400,
        description: `Bad Request: chat ${tg.PRIVATE.groupId} of @${tg.PRIVATE.username} not found, see https://api.telegram.org/bot${tg.PRIVATE.token}/getChat`,
      }),
    };
    const message = told(leaky).message;
    expect(message).toBe(
      'Telegram refused the message (400: chat [id] of [name] not found, see [address]).',
    );
    for (const secret of [String(tg.PRIVATE.groupId), tg.PRIVATE.username, tg.PRIVATE.token]) {
      expect(message).not.toContain(secret);
    }
  });
});

describe('redact', () => {
  it('takes out addresses, tokens, names and ids, and keeps the rest short', () => {
    expect(redact(`token ${tg.PRIVATE.token} was revoked`)).toBe('token [token] was revoked');
    expect(redact('mail to <ops@example.com> bounced')).toBe('mail to [address] bounced');
    expect(redact('see http://10.0.0.5:8080/hook?key=abc now')).toBe('see [address] now');
    expect(redact('retry after 35')).toBe('retry after 35');
    expect(redact('line one\n\tline two')).toBe('line one line two');
    expect(redact('x'.repeat(300)).length).toBe(120);
  });
});

describe('no answer at all', () => {
  const fetchFailed = (code: string, message = 'boom') =>
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(message), { code }),
    });

  it('says why in plain words, from the error code only', () => {
    expect(networkReason(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(
      'timed out',
    );
    expect(networkReason(fetchFailed('UND_ERR_CONNECT_TIMEOUT'))).toBe('timed out');
    expect(networkReason(fetchFailed('ENOTFOUND'))).toBe('its name could not be resolved');
    expect(networkReason(fetchFailed('ECONNREFUSED'))).toBe('the connection was refused');
    expect(networkReason(fetchFailed('ECONNRESET'))).toBe('the connection was closed');
    expect(networkReason(fetchFailed('CERT_HAS_EXPIRED'))).toBe('its certificate was not accepted');
    expect(networkReason(fetchFailed('EWHATEVER'))).toBe('network error EWHATEVER');
  });

  it('never quotes the error message: it can hold the address, and the token in it', () => {
    const err = new TypeError(
      `Failed to parse URL from htp://api.telegram.org/bot${tg.PRIVATE.token}/sendMessage`,
    );
    const e = unreachableError('Telegram', err);
    expect(e).toBeInstanceOf(UnreachableError);
    expect(e.message).toBe('Could not reach Telegram: network error.');
    expect(e.permanent).toBe(false);
  });
});

describe('Slack, a webhook and the mail server', () => {
  it('Slack: its one-word error is kept, nothing else of the answer', () => {
    expect(slackError(404, 'no_service').message).toBe(
      'Slack refused the message: this webhook no longer exists (404: no_service). Create a new incoming webhook in Slack and paste its address here.',
    );
    expect(slackError(404, 'no_service').permanent).toBe(true);
    expect(slackError(404, 'channel_not_found').message).toMatch(
      /the webhook's channel was deleted or archived \(404: channel_not_found\)/,
    );
    expect(slackError(400, 'invalid_payload').message).toBe(
      'Slack refused the message (400: invalid_payload).',
    );
    expect(
      slackError(400, '<html>https://hooks.slack.com/services/T1/B1/secret</html>').message,
    ).toBe('Slack refused the message (400).');
    const limited = slackError(429, '', '30');
    expect(limited.message).toMatch(/^Slack is limiting how fast this webhook may post \(429\)/);
    expect([limited.permanent, limited.retryAfterMs]).toEqual([false, 30_000]);
    expect(slackError(503, 'busy').permanent).toBe(false);
  });

  it('a webhook: the status only, whatever its server wrote', () => {
    expect(webhookError(401).message).toBe(
      "The webhook's server refused the request (401). Check what it expects: a token in the address, or the signing secret.",
    );
    expect(webhookError(404).message).toBe(
      "The webhook's server has nothing at this address (404). Check the URL.",
    );
    expect(webhookError(500).message).toBe("The webhook's server answered with an error (500).");
    expect(webhookError(422).message).toBe("The webhook's server refused the message (422).");
    expect([webhookError(404).permanent, webhookError(500).permanent]).toEqual([true, false]);
    expect(webhookError(429, '120').retryAfterMs).toBe(120_000);
  });

  it('SMTP: the reply code, never the addresses in the reply', () => {
    const rejected = smtpError({
      responseCode: 550,
      code: 'EENVELOPE',
      message:
        "Can't send mail - all recipients were rejected: 550 5.1.1 <ops@example.com>: Recipient address rejected",
    });
    expect(rejected.message).toBe(
      'The mail server refused a recipient or the sender (550). Check the channel\'s addresses and the "from" address.',
    );
    expect(rejected.permanent).toBe(true);
    expect(smtpError({ responseCode: 535, code: 'EAUTH', message: 'Invalid login' }).message).toBe(
      "The mail server refused WatchLog's login (535). Check the user and password in the email settings.",
    );
    const later = smtpError({ responseCode: 451, message: '451 4.7.1 try again later' });
    expect([later.message, later.permanent]).toEqual([
      'The mail server asked to try again later (451). It usually passes within a few minutes.',
      false,
    ]);
    const down = smtpError({ code: 'ETIMEDOUT', message: 'Connection timeout' });
    expect([down.message, down.permanent]).toEqual([
      'Could not reach the mail server: timed out.',
      false,
    ]);
    const refused = smtpError({ code: 'ESOCKET', message: 'connect ECONNREFUSED 10.0.0.9:25' });
    expect(refused.message).not.toContain('10.0.0.9');
  });
});
