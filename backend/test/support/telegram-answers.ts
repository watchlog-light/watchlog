// SPDX-License-Identifier: AGPL-3.0-only
// Telegram Bot API answers as the API sends them (status and body), recorded from its
// documentation and from real bots, with the ids and names replaced by made-up ones. Tests
// replay them from a mock server: Telegram is never called.

export interface Recorded {
  status: number;
  body: string;
}

const json = (status: number, body: object): Recorded => ({ status, body: JSON.stringify(body) });

/** A chat, a person and a bot token that must never reach an error text or a log line. */
export const PRIVATE = {
  chatId: 5550001234,
  groupId: -1001234567890,
  username: 'mock_chat_owner',
  token: '7000000001:AAHk3-mock_Token_mock_Token_mock_Tok',
};

/** sendMessage that worked: the whole message comes back (about 700 characters here). */
export const SENT: Recorded = json(200, {
  ok: true,
  result: {
    message_id: 3,
    from: {
      id: 7000000001,
      is_bot: true,
      first_name: 'WatchLog alerts',
      username: 'watchlog_alerts_bot',
    },
    chat: {
      id: PRIVATE.chatId,
      first_name: 'Mock',
      last_name: 'Owner',
      username: PRIVATE.username,
      type: 'private',
    },
    date: 1795069860,
    text: '🧪 TEST · WatchLog test message\n\nIf you can read this, the channel works.\nThis is a test · cluster test · since 06:31 UTC\nOpen in WatchLog',
    entities: [
      { offset: 0, length: 31, type: 'bold' },
      { offset: 76, length: 48, type: 'italic' },
      {
        offset: 125,
        length: 16,
        type: 'text_link',
        url: 'https://watchlog.example.com/alerts',
      },
    ],
    link_preview_options: { is_disabled: true },
  },
});

export const BLOCKED: Recorded = json(403, {
  ok: false,
  error_code: 403,
  description: 'Forbidden: bot was blocked by the user',
});
export const KICKED: Recorded = json(403, {
  ok: false,
  error_code: 403,
  description: 'Forbidden: bot was kicked from the supergroup chat',
});
export const CHAT_NOT_FOUND: Recorded = json(400, {
  ok: false,
  error_code: 400,
  description: 'Bad Request: chat not found',
});
export const UPGRADED: Recorded = json(400, {
  ok: false,
  error_code: 400,
  description: 'Bad Request: group chat was upgraded to a supergroup chat',
  parameters: { migrate_to_chat_id: PRIVATE.groupId },
});
export const NO_RIGHTS: Recorded = json(400, {
  ok: false,
  error_code: 400,
  description: 'Bad Request: not enough rights to send text messages to the chat',
});
export const BAD_TOKEN: Recorded = json(401, {
  ok: false,
  error_code: 401,
  description: 'Unauthorized',
});
/** A token that is not shaped like one: Telegram has no such path. */
export const NO_SUCH_BOT: Recorded = json(404, {
  ok: false,
  error_code: 404,
  description: 'Not Found',
});
export const TOO_MANY: Recorded = json(429, {
  ok: false,
  error_code: 429,
  description: 'Too Many Requests: retry after 35',
  parameters: { retry_after: 35 },
});
export const TOO_LONG: Recorded = json(400, {
  ok: false,
  error_code: 400,
  description: 'Bad Request: message is too long',
});
/** Telegram's own gateway on a bad day: not JSON. */
export const BAD_GATEWAY: Recorded = {
  status: 502,
  body: '<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx/1.18.0</center></body></html>',
};
/** A proxy's sign-in page in Telegram's place: 200, and not Telegram's answer. */
export const PROXY_PAGE: Recorded = {
  status: 200,
  body: '<html><body><form action="https://proxy.corp.example/login?u=mock_chat_owner">Sign in to continue</form></body></html>',
};
