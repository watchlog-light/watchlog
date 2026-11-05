// SPDX-License-Identifier: AGPL-3.0-only
// Telegram chat binding by deep link (ADR-080): the user opens
// https://t.me/<bot>?start=<one-time code>; the worker long-polls getUpdates while a
// verification is open (10 minutes), binds the chat that sent the code and replies.
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { decryptJson } from '../../lib/secrets.js';
import { telegramCall, type HttpClient } from './channels.js';
import type { AlertingSettings } from '../settings/service.js';

export const VERIFY_MS = 10 * 60_000;

const hash = (code: string) => createHash('sha256').update(code).digest();

/** The bot's username, which also proves the token works (getMe). */
export async function telegramBotName(
  http: HttpClient,
  apiUrl: string,
  token: string,
  proxy?: string,
): Promise<string> {
  const me = (await telegramCall(http, apiUrl, token, 'getMe', {}, proxy)) as {
    username?: string;
  };
  if (!me.username) throw new Error('Telegram getMe returned no username');
  return me.username;
}

export async function startTelegramVerification(
  db: Database,
  channelId: string,
  botName: string,
  now = Date.now(),
): Promise<{ link: string; expiresAt: Date }> {
  const code = randomBytes(12).toString('base64url');
  const expiresAt = new Date(now + VERIFY_MS);
  await db
    .insertInto('telegram_verifications')
    .values({ id: newId(), channel_id: channelId, code_hash: hash(code), expires_at: expiresAt })
    .execute();
  return { link: `https://t.me/${encodeURIComponent(botName)}?start=${code}`, expiresAt };
}

interface Update {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number; type: string; title?: string; username?: string; first_name?: string };
  };
}

export interface TelegramDeps {
  db: Database;
  secretKey: Buffer;
  http: HttpClient;
  settings: () => Promise<AlertingSettings>;
  log: { warn(obj: object, msg: string): void };
}

/** One getUpdates round for every channel with an open verification. */
export async function pollTelegramVerifications(
  deps: TelegramDeps,
  now = Date.now(),
  timeoutS = 20,
): Promise<number> {
  const { db } = deps;
  await db.deleteFrom('telegram_verifications').where('expires_at', '<', new Date(now)).execute();
  const { telegramApiUrl: apiUrl, telegramProxy: proxy } = await deps.settings();
  const open = await db
    .selectFrom('telegram_verifications as v')
    .innerJoin('alert_channels as c', 'c.id', 'v.channel_id')
    .select(['v.id', 'v.channel_id', 'v.code_hash', 'v.update_offset', 'c.secret', 'c.name'])
    .where('c.type', '=', 'telegram')
    .execute();
  const byChannel = new Map<string, typeof open>();
  for (const v of open) byChannel.set(v.channel_id, [...(byChannel.get(v.channel_id) ?? []), v]);

  let bound = 0;
  await Promise.all(
    [...byChannel].map(async ([channelId, rows]) => {
      const token = rows[0]!.secret
        ? decryptJson(deps.secretKey, rows[0]!.secret).botToken
        : undefined;
      if (!token) return;
      const offset = Math.max(...rows.map((r) => Number(r.update_offset)));
      let updates: Update[];
      try {
        updates = (await telegramCall(
          deps.http,
          apiUrl,
          token,
          'getUpdates',
          { offset, timeout: timeoutS, allowed_updates: ['message'] },
          proxy,
        )) as Update[];
      } catch (err) {
        deps.log.warn(
          { channel: channelId, err: (err as Error).message },
          'Telegram getUpdates failed',
        );
        return;
      }
      if (updates.length === 0) return;
      const codes = new Map(rows.map((r) => [Buffer.from(r.code_hash).toString('hex'), r]));
      for (const u of updates) {
        const m = /^\/start\s+([A-Za-z0-9_-]{8,64})\s*$/.exec(u.message?.text ?? '');
        if (!m || !u.message || !codes.has(hash(m[1]!).toString('hex'))) continue;
        const chat = u.message.chat;
        const chatName =
          chat.title ??
          (chat.username ? `@${chat.username}` : (chat.first_name ?? String(chat.id)));
        await db
          .updateTable('alert_channels')
          .set((eb) => ({
            config: eb.fn('jsonb_set', [
              eb.fn('jsonb_set', [
                eb.ref('config'),
                eb.val('{chatId}'),
                eb.val(JSON.stringify(chat.id)),
              ]),
              eb.val('{chatName}'),
              eb.val(JSON.stringify(chatName)),
            ]),
            verified_at: new Date(now),
          }))
          .where('id', '=', channelId)
          .execute();
        await db.deleteFrom('telegram_verifications').where('channel_id', '=', channelId).execute();
        bound++;
        await telegramCall(
          deps.http,
          apiUrl,
          token,
          'sendMessage',
          {
            chat_id: chat.id,
            text: `Connected to WatchLog. Alerts for "${rows[0]!.name}" will arrive in this chat.`,
          },
          proxy,
        ).catch((err: Error) =>
          deps.log.warn({ channel: channelId, err: err.message }, 'Telegram confirmation failed'),
        );
        return;
      }
      // Nothing matched: read past these updates next time.
      const next = Math.max(...updates.map((u) => u.update_id)) + 1;
      await db
        .updateTable('telegram_verifications')
        .set({ update_offset: String(next) })
        .where('channel_id', '=', channelId)
        .execute();
    }),
  );
  return bound;
}
