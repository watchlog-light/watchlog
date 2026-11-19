// SPDX-License-Identifier: AGPL-3.0-only
// Telegram deliveries against a mock Bot API that answers as Telegram does (ADR-218):
//   - a sent message comes back whole, longer than the 500 characters that were read until
//     0.9.8, so every delivered message was recorded as refused and sent again, up to 8 times;
//   - refusals, a 429 and a timeout from recorded answers: what is retried, when, and what the
//     channel, the notification and the log then say (never the chat, a name or the token);
//   - the migration that settles the rows the old sender left.
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { encryptJson } from '../src/lib/secrets.js';
import { HttpClient, MAX_ANSWER_BYTES } from '../src/modules/alerts/channels.js';
import {
  MAX_ATTEMPTS,
  deliverDue,
  sendTest,
  type DeliveryDeps,
} from '../src/modules/alerts/delivery.js';
import type { MessagePayload } from '../src/modules/alerts/outbox.js';
import {
  pollTelegramVerifications,
  startTelegramVerification,
} from '../src/modules/alerts/telegram.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';
import { T0, createOrgCluster, insertChannel } from './support/alerts.js';
import { startMockProviders, type MockProviders } from './support/mock-providers.js';
import * as tg from './support/telegram-answers.js';

const KEY = Buffer.alloc(32, 9);
const SEND = `/bot${tg.PRIVATE.token}/sendMessage`;

let ctx: TestContext;
let mock: MockProviders;
let http: HttpClient;
let deps: DeliveryDeps;
/** Everything the sender logged, as text. */
let logged: string[];

beforeEach(async () => {
  ctx = await createTestContext();
  mock = await startMockProviders();
  http = new HttpClient();
  logged = [];
  const log = (o: object, m: string) => logged.push(`${m} ${JSON.stringify(o)}`);
  deps = {
    db: ctx.db,
    secretKey: KEY,
    http,
    settings: async () => ({ publicUrl: 'https://watchlog.example.com', telegramApiUrl: mock.url }),
    log: { warn: log, info: log },
  };
});
afterEach(async () => {
  await http.close();
  await mock.close();
  await closeTestContext(ctx);
});

const payload = (): MessagePayload => ({
  version: 1,
  kind: 'firing',
  severity: 'critical',
  rule: { id: 'r1', key: 'k8s.pod.crashloop', name: 'Pod CrashLoopBackOff' },
  cluster: { id: 'c1', name: 'prod', kind: 'kubernetes' },
  items: [
    {
      alertId: 'a1',
      severity: 'critical',
      labels: { namespace: 'shop', workload: 'web', workload_kind: 'Deployment', pod: 'web-1' },
      details: {
        summary: 'main: Error (exit 1), 6 restarts',
        reason: 'Error',
        exitCode: 1,
        restarts: 6,
      },
      startedAt: '2026-11-01T12:04:00.000Z',
      firedAt: '2026-11-01T12:06:00.000Z',
      resolvedAt: null,
    },
  ],
  total: 1,
  at: '2026-11-01T12:09:00.000Z',
});

async function telegramChannel(): Promise<{ orgId: string; channelId: string }> {
  const { orgId } = await createOrgCluster(ctx.db);
  const channelId = await insertChannel(
    ctx.db,
    orgId,
    'telegram',
    {
      chatId: tg.PRIVATE.chatId,
      botName: 'watchlog_alerts_bot',
      chatName: `@${tg.PRIVATE.username}`,
    },
    encryptJson(KEY, { botToken: tg.PRIVATE.token }),
  );
  return { orgId, channelId };
}

async function queue(orgId: string, channelId: string): Promise<string> {
  const id = newId();
  await ctx.db
    .insertInto('notifications')
    .values({
      id,
      org_id: orgId,
      channel_id: channelId,
      kind: 'firing',
      payload: JSON.stringify(payload()),
      dedupe_key: `k-${id}`,
      next_attempt_at: new Date(T0),
    })
    .execute();
  return id;
}

const notification = (id: string) =>
  ctx.db.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const channel = (id: string) =>
  ctx.db.selectFrom('alert_channels').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const replay = (r: tg.Recorded, headers?: Record<string, string>) =>
  mock.fail(SEND, r.status, r.body, headers);

/** Nothing private in what the channel, the notification or the log says. */
function expectNothingPrivate(...texts: (string | null)[]): void {
  const all = [...texts, ...logged].join('\n');
  for (const secret of [
    String(tg.PRIVATE.chatId),
    String(tg.PRIVATE.groupId),
    tg.PRIVATE.username,
    tg.PRIVATE.token,
    mock.url,
  ]) {
    expect(all).not.toContain(secret);
  }
}

describe('a delivered Telegram message', () => {
  it('is recorded as sent and is never sent again', async () => {
    const { orgId, channelId } = await telegramChannel();
    const id = await queue(orgId, channelId);
    // The mock answers as Telegram does: the whole message back.
    expect(await deliverDue(deps, T0)).toMatchObject({ sent: 1, retried: 0, failed: 0 });
    expect(await notification(id)).toMatchObject({ status: 'sent', attempts: 1, error: null });
    expect(await channel(channelId)).toMatchObject({ last_error: null, last_error_at: null });
    expect((await channel(channelId)).last_sent_at).not.toBeNull();
    // Every later round of the sender, over more than the whole back-off: not one more message.
    for (let i = 1; i <= MAX_ATTEMPTS + 2; i++) await deliverDue(deps, T0 + i * 3_600_000);
    expect(mock.to(SEND)).toHaveLength(1);
    expect(logged).toEqual([]);
  });

  it('is read whole: the real answer is longer than the 500 characters read before 0.9.8', async () => {
    expect(tg.SENT.body.length).toBeGreaterThan(500);
    expect(JSON.parse(tg.SENT.body).ok).toBe(true);
    expect(() => JSON.parse(tg.SENT.body.slice(0, 500))).toThrow();
    const { channelId } = await telegramChannel();
    replay(tg.SENT);
    expect(await sendTest(deps, channelId)).toEqual({ ok: true });
  });

  it('counts as sent even when the answer is longer than what is read', async () => {
    const { orgId, channelId } = await telegramChannel();
    const id = await queue(orgId, channelId);
    const huge = JSON.stringify({
      ok: true,
      result: { message_id: 4, text: 'x'.repeat(MAX_ANSWER_BYTES + 10) },
    });
    mock.fail(SEND, 200, huge);
    expect(await deliverDue(deps, T0)).toMatchObject({ sent: 1 });
    expect(await notification(id)).toMatchObject({ status: 'sent', error: null });
  });

  it("is not counted when a proxy answers 200 in Telegram's place", async () => {
    const { orgId, channelId } = await telegramChannel();
    const id = await queue(orgId, channelId);
    replay(tg.PROXY_PAGE);
    expect(await deliverDue(deps, T0)).toMatchObject({ sent: 0, retried: 1 });
    const n = await notification(id);
    expect(n.error).toBe(
      "Telegram's answer could not be read (200). If a proxy is set for Telegram, check that it passes the answer on.",
    );
    expectNothingPrivate(n.error);
  });
});

describe('a refused or unanswered Telegram message', () => {
  it('a blocked bot fails at once and is not sent again', async () => {
    const { orgId, channelId } = await telegramChannel();
    const id = await queue(orgId, channelId);
    replay(tg.BLOCKED);
    expect(await deliverDue(deps, T0)).toMatchObject({ sent: 0, retried: 0, failed: 1 });
    const said =
      'Telegram refused the message: the bot was blocked in the chat (403). Unblock the bot in Telegram, or connect another chat.';
    expect(await notification(id)).toMatchObject({ status: 'failed', attempts: 1, error: said });
    expect(await channel(channelId)).toMatchObject({ last_error: said });
    for (let i = 1; i <= 3; i++) await deliverDue(deps, T0 + i * 3_600_000);
    expect(mock.to(SEND)).toHaveLength(1);
    expectNothingPrivate(said);
  });

  it('a chat that is gone, and a token that is not accepted, fail at once too', async () => {
    const { orgId, channelId } = await telegramChannel();
    const gone = await queue(orgId, channelId);
    replay(tg.CHAT_NOT_FOUND);
    await deliverDue(deps, T0);
    expect(await notification(gone)).toMatchObject({
      status: 'failed',
      error:
        'Telegram refused the message: Telegram cannot find the chat (400). Connect the chat again.',
    });
    const token = await queue(orgId, channelId);
    replay(tg.BAD_TOKEN);
    await deliverDue(deps, T0);
    expect(await notification(token)).toMatchObject({
      status: 'failed',
      error: 'Telegram did not accept the bot token (401). Copy the token from BotFather again.',
    });
    expect(await sendTest(deps, channelId)).toEqual({
      ok: false,
      error: 'Telegram did not accept the bot token (401). Copy the token from BotFather again.',
    });
  });

  it('after a 429 the next try waits as long as Telegram asked, then the message goes once', async () => {
    const { orgId, channelId } = await telegramChannel();
    const id = await queue(orgId, channelId);
    replay(tg.TOO_MANY);
    expect(await deliverDue(deps, T0)).toMatchObject({ retried: 1 });
    const waiting = await notification(id);
    expect(waiting).toMatchObject({ status: 'pending', attempts: 1 });
    // 35 s from Telegram, not the 30 s of the first back-off.
    expect(new Date(waiting.next_attempt_at).getTime()).toBe(T0 + 35_000);
    expect(await deliverDue(deps, T0 + 30_000)).toMatchObject({ sent: 0, retried: 0 });
    replay(tg.SENT);
    expect(await deliverDue(deps, T0 + 35_000)).toMatchObject({ sent: 1 });
    expect(await notification(id)).toMatchObject({ status: 'sent', attempts: 2, error: null });
    expect(await channel(channelId)).toMatchObject({ last_error: null });
    expect(mock.to(SEND)).toHaveLength(2);
  });

  it('a timeout is retried, and says so without the address that was called', async () => {
    const { orgId, channelId } = await telegramChannel();
    const id = await queue(orgId, channelId);
    mock.hang(SEND);
    // The same client with a short limit: no test waits on a real timeout.
    const quick = new HttpClient({}, null, 150);
    expect(await deliverDue({ ...deps, http: quick }, T0)).toMatchObject({ retried: 1 });
    await quick.close();
    const n = await notification(id);
    expect(n).toMatchObject({
      status: 'pending',
      attempts: 1,
      error: 'Could not reach Telegram: timed out.',
    });
    expect(new Date(n.next_attempt_at).getTime()).toBe(T0 + 30_000);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('notification will be retried');
    expectNothingPrivate(n.error, (await channel(channelId)).last_error);
  });

  it('whatever Telegram or a webhook server writes back, none of it is stored or logged', async () => {
    const { orgId, channelId } = await telegramChannel();
    const id = await queue(orgId, channelId);
    mock.fail(
      SEND,
      400,
      JSON.stringify({
        ok: false,
        error_code: 400,
        description: `Bad Request: chat ${tg.PRIVATE.groupId} (@${tg.PRIVATE.username}) is restricted`,
        result: { chat: { id: tg.PRIVATE.chatId, username: tg.PRIVATE.username } },
      }),
    );
    await deliverDue(deps, T0);
    const n = await notification(id);
    expect(n.error).toBe('Telegram refused the message (400: chat [id] ([name]) is restricted).');

    const hook = await insertChannel(ctx.db, orgId, 'webhook', { url: `${mock.url}/webhook` });
    const hookId = await queue(orgId, hook);
    mock.fail(
      '/webhook',
      500,
      `Traceback: POST ${mock.url}/webhook?token=${tg.PRIVATE.token} for @${tg.PRIVATE.username} failed`,
    );
    await deliverDue(deps, T0);
    const h = await notification(hookId);
    expect(h.error).toBe("The webhook's server answered with an error (500).");
    expectNothingPrivate(
      n.error,
      h.error,
      (await channel(channelId)).last_error,
      (await channel(hook)).last_error,
    );
    expect(logged).toHaveLength(2);
  });
});

describe('connecting a chat', () => {
  it('binds from an update as long as a real one (a group, with its people)', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const id = await insertChannel(
      ctx.db,
      orgId,
      'telegram',
      { botName: 'watchlog_alerts_bot' },
      encryptJson(KEY, { botToken: tg.PRIVATE.token }),
    );
    const { link } = await startTelegramVerification(ctx.db, id, 'watchlog_alerts_bot', T0);
    const code = new URL(link).searchParams.get('start')!;
    const from = {
      id: 5550009999,
      is_bot: false,
      first_name: 'A person with a long first name',
      last_name: 'And an even longer family name, as people have',
      username: 'a_person_with_a_long_username',
      language_code: 'en',
    };
    const chat = {
      id: tg.PRIVATE.groupId,
      title: 'Platform on-call: production incidents and deploys',
      type: 'supergroup',
    };
    // Other people's messages in the same group, then the code.
    for (let i = 0; i < 4; i++) {
      mock.telegramUpdates.push({
        update_id: 100 + i,
        message: { message_id: 10 + i, from, chat, date: 1795069800 + i, text: `message ${i}` },
      });
    }
    mock.telegramUpdates.push({
      update_id: 104,
      message: {
        message_id: 14,
        from,
        chat,
        date: 1795069860,
        text: `/start ${code}`,
        entities: [{ offset: 0, length: 6, type: 'bot_command' }],
      },
    });
    expect(JSON.stringify(mock.telegramUpdates).length).toBeGreaterThan(500);
    const bound = await pollTelegramVerifications(
      { db: ctx.db, secretKey: KEY, http, settings: deps.settings, log: deps.log },
      T0 + 1000,
      0,
    );
    expect(bound).toBe(1);
    expect((await channel(id)).config).toMatchObject({ chatId: tg.PRIVATE.groupId });
    expect(logged).toEqual([]);
  });
});

describe('the migration for rows written before 0.9.8', () => {
  const migration = readFileSync(
    new URL('../migrations/1796700000000_delivery-errors.sql', import.meta.url),
    'utf8',
  );
  const RAW = `Telegram sendMessage answered 200: {"ok":true,"result":{"message_id":3,"from":{"id":7000000001,"is_bot":true},"chat":{"id":${tg.PRIVATE.chatId},"username":"${tg.PRIVATE.username}"`;

  it('settles delivered messages, clears the false failure, and takes raw answers out', async () => {
    const { orgId, channelId } = await telegramChannel();
    const at = new Date(T0);
    await ctx.db
      .updateTable('alert_channels')
      .set({ last_error: RAW, last_error_at: at })
      .where('id', '=', channelId)
      .execute();
    const hook = await insertChannel(ctx.db, orgId, 'webhook', { url: 'https://example.com/h' });
    await ctx.db
      .updateTable('alert_channels')
      .set({
        last_error: 'Webhook answered 500: secret=abc at https://example.com/h',
        last_error_at: at,
      })
      .where('id', '=', hook)
      .execute();
    const row = async (status: string, error: string | null, attempts: number) => {
      const id = await queue(orgId, channelId);
      await ctx.db
        .updateTable('notifications')
        .set({ status, error, attempts, next_attempt_at: new Date(T0 + 60_000) })
        .where('id', '=', id)
        .execute();
      return id;
    };
    const retrying = await row('pending', RAW, 3);
    const gaveUp = await row('failed', RAW, 8);
    const blocked = await row(
      'failed',
      'Telegram sendMessage answered 403: Forbidden: bot was blocked by the user',
      1,
    );
    const rawRefusal = await row(
      'failed',
      'Telegram sendMessage answered 502: <html>nginx</html>',
      8,
    );
    const mail = await row(
      'failed',
      'SMTP: 550 5.1.1 <ops@example.com>: Recipient address rejected',
      1,
    );
    const net = await row(
      'pending',
      'api.telegram.org unreachable: connect ECONNREFUSED 10.0.0.9:443',
      2,
    );
    const fresh = await row('pending', null, 0);

    await sql.raw(migration).execute(ctx.db);

    expect(await notification(retrying)).toMatchObject({ status: 'sent', error: null });
    expect((await notification(retrying)).sent_at).not.toBeNull();
    expect(await notification(gaveUp)).toMatchObject({ status: 'sent', error: null });
    expect(await notification(blocked)).toMatchObject({
      status: 'failed',
      error: 'Telegram sendMessage answered 403: Forbidden: bot was blocked by the user',
    });
    expect(await notification(rawRefusal)).toMatchObject({
      status: 'failed',
      error: 'Telegram sendMessage answered 502.',
    });
    expect((await notification(mail)).error).toBe('The mail server did not accept the message.');
    expect(await notification(net)).toMatchObject({
      status: 'pending',
      error: 'Could not reach api.telegram.org.',
    });
    expect(await notification(fresh)).toMatchObject({ status: 'pending', error: null });

    const ch = await channel(channelId);
    expect(ch).toMatchObject({ last_error: null, last_error_at: null });
    expect(new Date(ch.last_sent_at!).getTime()).toBe(T0);
    expect(new Date(ch.verified_at!).getTime()).toBe(T0);
    expect((await channel(hook)).last_error).toBe('Webhook answered 500.');

    // The settled message is not sent again by the new sender.
    await deliverDue(deps, T0 + 3_600_000);
    expect(mock.to(SEND).length).toBe(2); // only `net` and `fresh`
  });
});
