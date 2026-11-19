// SPDX-License-Identifier: AGPL-3.0-only
// In-process stand-ins for Slack, Telegram and webhook receivers (ADR-082), plus a
// Mailpit client. No test reaches a real provider.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

export const TEST_SMTP_URL = process.env.WATCHLOG_TEST_SMTP_URL ?? 'smtp://127.0.0.1:1025';
export const TEST_MAILPIT_URL = process.env.WATCHLOG_TEST_MAILPIT_URL ?? 'http://127.0.0.1:8025';

export interface Recorded {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  json: unknown;
}

export interface MockProviders {
  url: string;
  requests: Recorded[];
  /** Requests to one path prefix (`/slack`, `/webhook`, `/bot<token>/sendMessage`). */
  to(prefix: string): Recorded[];
  /** Status (and body) answered for a path prefix; default 200. */
  fail(prefix: string, status: number, body?: string, headers?: Record<string, string>): void;
  /** Requests to a path prefix get no answer at all (a timeout for the caller). */
  hang(prefix: string): void;
  /** Telegram updates returned by getUpdates (filtered by offset). */
  telegramUpdates: object[];
  close(): Promise<void>;
}

export async function startMockProviders(): Promise<MockProviders> {
  const requests: Recorded[] = [];
  const failures = new Map<
    string,
    { status: number; body: string; headers: Record<string, string> }
  >();
  const hanging = new Set<string>();
  const telegramUpdates: { update_id: number }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const path = req.url ?? '/';
      let json: unknown = null;
      try {
        json = JSON.parse(body);
      } catch {
        // not JSON
      }
      requests.push({ path, headers: req.headers, body, json });
      // No answer: the caller's own timeout ends it.
      for (const prefix of hanging) if (path.startsWith(prefix)) return;
      for (const [prefix, f] of failures) {
        if (path.startsWith(prefix)) {
          res.writeHead(f.status, { 'content-type': 'application/json', ...f.headers }).end(f.body);
          return;
        }
      }
      const tg = /^\/bot[^/]+\/(\w+)$/.exec(path);
      if (tg) {
        const method = tg[1];
        const offset = (json as { offset?: number } | null)?.offset ?? 0;
        const result =
          method === 'getMe'
            ? { id: 1, is_bot: true, username: 'watchlog_test_bot' }
            : method === 'getUpdates'
              ? telegramUpdates.filter((u) => u.update_id >= offset)
              : telegramMessage(requests.length, json as { chat_id?: number; text?: string });
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, result }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    to: (prefix) => requests.filter((r) => r.path.startsWith(prefix)),
    fail: (prefix, status, body = '{"ok":false,"description":"mock failure"}', headers = {}) =>
      failures.set(prefix, { status, body, headers }),
    hang: (prefix) => hanging.add(prefix),
    telegramUpdates,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The chat every mock message is "sent" to: none of this may reach an error or a log. */
export const MOCK_CHAT = { id: 5550001234, username: 'mock_chat_owner', firstName: 'Mock' };

/**
 * What Telegram answers to sendMessage, in its real shape: the whole message back, with the
 * bot, the chat and the text's entities. It is longer than 500 characters for any real
 * message, which is what the sender has to read to find "ok": true.
 */
export function telegramMessage(id: number, sent: { chat_id?: number; text?: string }): object {
  const html = sent.text ?? '';
  const text = html.replace(/<[^>]+>/g, '');
  const entities: object[] = [];
  let offset = 0;
  for (const m of html.matchAll(/<(b|i|code|a)\b[^>]*>([^<]*)<\/\1>/g)) {
    const at = text.indexOf(m[2]!, offset);
    offset = at + m[2]!.length;
    entities.push({
      offset: at,
      length: m[2]!.length,
      type: { b: 'bold', i: 'italic', code: 'code', a: 'text_link' }[m[1]!],
      ...(m[1] === 'a' ? { url: /href="([^"]*)"/.exec(m[0])?.[1] } : {}),
    });
  }
  return {
    message_id: id,
    from: {
      id: 7000000001,
      is_bot: true,
      first_name: 'WatchLog test',
      username: 'watchlog_test_bot',
    },
    chat: {
      id: sent.chat_id ?? MOCK_CHAT.id,
      first_name: MOCK_CHAT.firstName,
      username: MOCK_CHAT.username,
      type: 'private',
    },
    date: 1795000000,
    text,
    entities,
    link_preview_options: { is_disabled: true },
  };
}

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

/** Messages in Mailpit sent to `to`, oldest first. */
export async function mailpitMessages(to: string): Promise<MailpitMessage[]> {
  const res = await fetch(
    `${TEST_MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  if (!res.ok) throw new Error(`Mailpit search failed: ${res.status}`);
  const body = (await res.json()) as { messages: MailpitMessage[] };
  return body.messages.reverse();
}

export async function mailpitText(id: string): Promise<string> {
  const res = await fetch(`${TEST_MAILPIT_URL}/api/v1/message/${id}`);
  return ((await res.json()) as { Text: string }).Text;
}
