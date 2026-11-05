// SPDX-License-Identifier: AGPL-3.0-only
// Channels and delivery (Phase 3 slice 4): secrets (ADR-079), message format (ADR-081),
// the outbox sender (ADR-074) and the four channel types (ADR-080), all against mock
// servers and Mailpit (ADR-082).
import { createHmac } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import {
  SecretKeyError,
  checkSecretKey,
  decryptSecret,
  encryptJson,
  encryptSecret,
} from '../src/lib/secrets.js';
import { HttpClient } from '../src/modules/alerts/channels.js';
import {
  MAX_ATTEMPTS,
  deliverDue,
  sendTest,
  type DeliveryDeps,
} from '../src/modules/alerts/delivery.js';
import type { EvaluatorLookup } from '../src/modules/alerts/engine.js';
import type { MessagePayload } from '../src/modules/alerts/outbox.js';
import { renderMessage } from '../src/modules/alerts/render.js';
import {
  pollTelegramVerifications,
  startTelegramVerification,
  telegramBotName,
} from '../src/modules/alerts/telegram.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';
import {
  T0,
  createOrgCluster,
  insertChannel,
  insertRule,
  silentLog,
  testWorker,
} from './support/alerts.js';
import {
  TEST_SMTP_URL,
  mailpitMessages,
  mailpitText,
  startMockProviders,
  type MockProviders,
} from './support/mock-providers.js';

const KEY = Buffer.alloc(32, 9);
const OTHER_KEY = Buffer.alloc(32, 8);
const PUBLIC_URL = 'https://watchlog.example.com';

let ctx: TestContext;
let mock: MockProviders;
let http: HttpClient;
let deps: DeliveryDeps;

beforeEach(async () => {
  ctx = await createTestContext();
  mock = await startMockProviders();
  http = new HttpClient();
  deps = {
    db: ctx.db,
    secretKey: KEY,
    http,
    settings: async () => ({
      publicUrl: PUBLIC_URL,
      telegramApiUrl: mock.url,
      smtp: { transport: TEST_SMTP_URL, from: 'WatchLog <alerts@watchlog.test>' },
    }),
    log: silentLog,
  };
});
afterEach(async () => {
  await http.close();
  await mock.close();
  await closeTestContext(ctx);
});

describe('channel secrets (ADR-079)', () => {
  it('encrypts with AES-256-GCM and rejects a tampered ciphertext or another key', () => {
    const c = encryptSecret(KEY, 'xoxb-secret');
    expect(c).toMatch(/^v1:[\w-]+:[\w-]+$/);
    expect(c).not.toContain('xoxb');
    expect(decryptSecret(KEY, c)).toBe('xoxb-secret');
    expect(() => decryptSecret(OTHER_KEY, c)).toThrow(SecretKeyError);
    const tampered = c.slice(0, -2) + (c.at(-2) === 'A' ? 'B' : 'A') + c.slice(-1);
    expect(() => decryptSecret(KEY, tampered)).toThrow(SecretKeyError);
  });

  it('refuses a key that cannot decrypt the canary or the stored secrets', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    await insertChannel(ctx.db, orgId, 'slack', {}, encryptJson(KEY, { webhookUrl: 'x' }));
    // Before a canary exists, every stored secret is tried.
    await expect(checkSecretKey(ctx.db, OTHER_KEY)).rejects.toThrow(
      /cannot decrypt the secrets stored/,
    );
    expect(await ctx.db.selectFrom('secret_key_check').selectAll().execute()).toEqual([]);
    await checkSecretKey(ctx.db, KEY); // writes the canary
    await checkSecretKey(ctx.db, KEY);
    await ctx.db.deleteFrom('alert_channels').execute();
    await expect(checkSecretKey(ctx.db, OTHER_KEY)).rejects.toThrow(/restore it from your backup/);
  });
});

const payload = (over: Partial<MessagePayload> = {}): MessagePayload => ({
  version: 1,
  kind: 'firing',
  severity: 'critical',
  rule: { id: 'r1', key: 'k8s.pod.crashloop', name: 'Pod CrashLoopBackOff' },
  cluster: { id: 'c1', name: 'prod', kind: 'kubernetes' },
  items: [
    {
      alertId: 'a1',
      severity: 'critical',
      labels: { namespace: 'wl-test', workload: 'web', workload_kind: 'Deployment', pod: 'web-1' },
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
  ...over,
});

describe('message format (ADR-081, ADR-095)', () => {
  it('says what, why, where, since when, and links to the object', () => {
    const m = renderMessage(payload(), PUBLIC_URL);
    expect(m.title).toBe('🔴 CRITICAL · web is crash-looping');
    expect(m.items[0]!.why).toBe('last exit: Error (code 1) · 6 restarts');
    expect(m.items[0]!.context).toBe(
      'wl-test/web (Deployment) · cluster prod · since 12:04 UTC (5 min)',
    );
    expect(m.items[0]!.link).toBe(`${PUBLIC_URL}/pods/wl-test/web-1?cluster=c1`);
    expect(m.subject).toBe('[CRITICAL] web is crash-looping (prod)');
    expect(m.text).toBe(
      [
        '🔴 CRITICAL · web is crash-looping',
        '',
        'last exit: Error (code 1) · 6 restarts',
        'wl-test/web (Deployment) · cluster prod · since 12:04 UTC (5 min)',
        `${PUBLIC_URL}/pods/wl-test/web-1?cluster=c1`,
      ].join('\n'),
    );
  });

  it('reports the duration on resolve and "and N more" beyond 5 items', () => {
    const item = payload().items[0]!;
    const resolved = renderMessage(
      payload({ kind: 'resolved', items: [{ ...item, resolvedAt: '2026-11-01T12:18:00.000Z' }] }),
    );
    expect(resolved.title).toBe('✅ RESOLVED · web is crash-looping');
    expect(resolved.items[0]!.context).toContain('after 12 min');
    expect(resolved.items[0]!.link).toBeNull(); // no WATCHLOG_PUBLIC_URL, no links
    const many = renderMessage(payload({ items: Array(5).fill(item), total: 8 }), PUBLIC_URL);
    expect(many.more).toBe('and 3 more');
    expect(many.text).toContain(`and 3 more: ${PUBLIC_URL}/alerts?rule=r1&cluster=c1`);
    expect(many.title).toBe('🔴 CRITICAL · Pod CrashLoopBackOff (8)');
    expect(many.subject).toBe('[CRITICAL] Pod CrashLoopBackOff: 8 alerts (prod)');
    expect(many.text).toContain('web is crash-looping\nlast exit: Error (code 1) · 6 restarts');
  });
});

/** Four channels of every type pointing at the mocks and Mailpit. */
async function fourChannels(orgId: string, recipient: string) {
  return {
    slack: await insertChannel(
      ctx.db,
      orgId,
      'slack',
      {},
      encryptJson(KEY, { webhookUrl: `${mock.url}/slack/T1/B1/x` }),
    ),
    telegram: await insertChannel(
      ctx.db,
      orgId,
      'telegram',
      { chatId: 4242, botName: 'watchlog_test_bot' },
      encryptJson(KEY, { botToken: '123:abc' }),
    ),
    email: await insertChannel(ctx.db, orgId, 'email', { recipients: [recipient] }),
    webhook: await insertChannel(
      ctx.db,
      orgId,
      'webhook',
      { url: `${mock.url}/webhook` },
      encryptJson(KEY, { signingSecret: 'whsec' }),
    ),
  };
}

describe('delivery to all four channels', () => {
  it('sends exactly one firing and one resolve message per channel', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const recipient = `oncall-${newId()}@example.com`;
    const ch = await fourChannels(orgId, recipient);
    await insertRule(ctx.db, orgId, {
      name: 'Pod CrashLoopBackOff',
      severity: 'critical',
      channel_ids: Object.values(ch),
    });
    let firing = true;
    const lookup: EvaluatorLookup = () => ({
      kinds: ['kubernetes'],
      evaluate: async () =>
        firing
          ? [
              {
                fingerprint: 'pod:wl-test/Deployment/web',
                severity: 'critical',
                labels: {
                  namespace: 'wl-test',
                  workload: 'web',
                  workload_kind: 'Deployment',
                  pod: 'web-1',
                },
                details: { summary: 'main: Error (exit 1), 6 restarts' },
              },
            ]
          : [],
    });
    const clock = { now: Date.now() };
    const worker = testWorker(ctx.db, clock, lookup);
    const step = async () => {
      await worker.runCycle();
      await deliverDue(deps, clock.now);
      clock.now += 30_000;
    };
    await step();
    await step();
    firing = false;
    for (let i = 0; i < 3; i++) await step();
    await worker.stop();

    const slack = mock.to('/slack');
    const telegram = mock.to('/bot123:abc/sendMessage');
    const webhook = mock.to('/webhook');
    expect([slack.length, telegram.length, webhook.length]).toEqual([2, 2, 2]);
    expect(await mailpitMessages(recipient)).toHaveLength(2);

    // Slack: Block Kit in a coloured attachment.
    const s = slack.map(
      (r) =>
        r.json as {
          text: string;
          attachments: { color: string; blocks: { text?: { text: string } }[] }[];
        },
    );
    expect(s.map((b) => b.attachments[0]!.color)).toEqual(['danger', 'good']);
    expect(s[0]!.attachments[0]!.blocks[1]!.text!.text).toContain(
      `<${PUBLIC_URL}/pods/wl-test/web-1?cluster=`,
    );
    // Telegram: HTML to the bound chat.
    const t = telegram.map((r) => r.json as { chat_id: number; text: string; parse_mode: string });
    expect(t[0]).toMatchObject({ chat_id: 4242, parse_mode: 'HTML' });
    expect(t[0]!.text).toContain('<b>🔴 CRITICAL · Pod CrashLoopBackOff</b>');
    expect(t[1]!.text).toContain('✅ RESOLVED');
    // Webhook: versioned JSON, signed, with the notification id as idempotency key.
    const w = webhook[0]!;
    const sig = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(w.headers['x-watchlog-signature']))!;
    expect(createHmac('sha256', 'whsec').update(`${sig[1]}.${w.body}`).digest('hex')).toBe(sig[2]);
    expect(w.headers['x-watchlog-event']).toBe('firing');
    const rows = await ctx.db
      .selectFrom('notifications')
      .select(['id', 'status', 'channel_id'])
      .execute();
    expect(rows.map((r) => r.id)).toContain(w.headers['x-watchlog-delivery']);
    expect(w.json).toMatchObject({
      version: 1,
      event: 'firing',
      severity: 'critical',
      total: 1,
      alerts: [{ labels: { workload: 'web' } }],
    });
    // Email: subject and text.
    const mails = await mailpitMessages(recipient);
    expect(mails.map((m) => m.Subject)).toEqual([
      '[CRITICAL] Pod CrashLoopBackOff (prod)',
      '[RESOLVED] Pod CrashLoopBackOff (prod)',
    ]);
    expect(await mailpitText(mails[0]!.ID)).toContain('main: Error (exit 1), 6 restarts');
    // Every row is sent, every channel records it.
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
    const channels = await ctx.db
      .selectFrom('alert_channels')
      .select(['last_sent_at', 'last_error'])
      .execute();
    expect(channels.every((c) => c.last_sent_at && !c.last_error)).toBe(true);
    // Nothing is sent twice.
    await deliverDue(deps, clock.now + 3_600_000);
    expect(mock.requests.length).toBe(6);
  });

  it('"send test" reaches every channel type and returns the provider\'s error', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const recipient = `test-${newId()}@example.com`;
    const ch = await fourChannels(orgId, recipient);
    for (const id of Object.values(ch)) expect(await sendTest(deps, id)).toEqual({ ok: true });
    expect(mock.to('/slack')).toHaveLength(1);
    expect(mock.to('/bot123:abc/sendMessage')).toHaveLength(1);
    expect(mock.to('/webhook')[0]!.headers['x-watchlog-event']).toBe('test');
    expect((await mailpitMessages(recipient))[0]!.Subject).toMatch(
      /^\[TEST\] WatchLog test message/,
    );

    mock.fail('/bot123:abc/', 401, '{"ok":false,"error_code":401,"description":"Unauthorized"}');
    expect(await sendTest(deps, ch.telegram)).toEqual({
      ok: false,
      error: 'Telegram sendMessage answered 401: Unauthorized',
    });
    const noSmtp = await sendTest(
      { ...deps, settings: async () => ({ ...(await deps.settings()), smtp: undefined }) },
      ch.email,
    );
    expect(noSmtp).toEqual({
      ok: false,
      error: 'Email is not configured on this server: set WATCHLOG_SMTP_URL',
    });
  });
});

describe('outbox sender (ADR-074)', () => {
  async function queued(channelId: string, orgId: string, n = 1) {
    for (let i = 0; i < n; i++) {
      await ctx.db
        .insertInto('notifications')
        .values({
          id: newId(),
          org_id: orgId,
          channel_id: channelId,
          kind: 'firing',
          payload: JSON.stringify(payload()),
          dedupe_key: `k${i}-${newId()}`,
          next_attempt_at: new Date(T0),
        })
        .execute();
    }
  }
  const all = () => ctx.db.selectFrom('notifications').selectAll().orderBy('dedupe_key').execute();

  it('retries with back-off and records the last error on the channel', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const id = await insertChannel(ctx.db, orgId, 'webhook', { url: `${mock.url}/webhook` });
    await queued(id, orgId);
    mock.fail('/webhook', 503, 'busy');
    expect(await deliverDue(deps, T0)).toEqual({
      sent: 0,
      retried: 1,
      failed: 0,
      dropped: 0,
      deferred: 0,
    });
    const [n] = await all();
    expect(n).toMatchObject({
      status: 'pending',
      attempts: 1,
      error: 'Webhook answered 503: busy',
    });
    expect(new Date(n!.next_attempt_at).getTime()).toBe(T0 + 30_000);
    const ch = await ctx.db.selectFrom('alert_channels').selectAll().executeTakeFirstOrThrow();
    expect(ch.last_error).toBe('Webhook answered 503: busy');
    expect(await deliverDue(deps, T0 + 10_000)).toEqual({
      sent: 0,
      retried: 0,
      failed: 0,
      dropped: 0,
      deferred: 0,
    });
    mock.fail('/webhook', 200, 'ok');
    expect(await deliverDue(deps, T0 + 30_000)).toEqual({
      sent: 1,
      retried: 0,
      failed: 0,
      dropped: 0,
      deferred: 0,
    });
    const done = await ctx.db.selectFrom('alert_channels').selectAll().executeTakeFirstOrThrow();
    expect(done.last_error).toBeNull();
  });

  it('fails at once on a permanent error, and after the last attempt otherwise', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const gone = await insertChannel(
      ctx.db,
      orgId,
      'slack',
      {},
      encryptJson(KEY, { webhookUrl: `${mock.url}/slack/gone` }),
    );
    const busy = await insertChannel(ctx.db, orgId, 'webhook', { url: `${mock.url}/webhook` });
    await queued(gone, orgId);
    await queued(busy, orgId);
    mock.fail('/slack/gone', 404, 'no_service');
    mock.fail('/webhook', 500, 'down');
    let now = T0;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await deliverDue(deps, now);
      now += 3_600_000;
    }
    const rows = await ctx.db
      .selectFrom('notifications')
      .select(['channel_id', 'status', 'attempts'])
      .execute();
    expect(rows.find((r) => r.channel_id === gone)).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
    expect(rows.find((r) => r.channel_id === busy)).toMatchObject({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
    });
  });

  it('never sends a row twice when senders race, and reclaims an expired lease', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const id = await insertChannel(ctx.db, orgId, 'webhook', { url: `${mock.url}/webhook` });
    await queued(id, orgId, 15);
    await Promise.all([1, 2, 3].map(() => deliverDue(deps, T0)));
    expect(mock.to('/webhook')).toHaveLength(15);
    expect(new Set(mock.to('/webhook').map((r) => r.headers['x-watchlog-delivery'])).size).toBe(15);

    // A sender that claimed a row and died: the lease runs out, another sender takes over.
    await queued(id, orgId, 1);
    await sql`UPDATE notifications SET status = 'sending', attempts = 1, lease_until = ${new Date(T0 + 60_000)} WHERE status = 'pending'`.execute(
      ctx.db,
    );
    expect((await deliverDue(deps, T0 + 30_000)).sent).toBe(0);
    expect((await deliverDue(deps, T0 + 61_000)).sent).toBe(1);
  });
});

describe('message order (ADR-090)', () => {
  /** A webhook channel, a rule on it and a fake source of the given fingerprints. */
  async function scenario() {
    const { orgId } = await createOrgCluster(ctx.db);
    const channel = await insertChannel(ctx.db, orgId, 'webhook', { url: `${mock.url}/webhook` });
    await insertRule(ctx.db, orgId, { channel_ids: [channel] });
    const active = new Set<string>();
    const lookup: EvaluatorLookup = () => ({
      kinds: ['kubernetes'],
      evaluate: async () =>
        [...active].map((fp) => ({
          fingerprint: fp,
          severity: 'warning' as const,
          labels: { node: fp },
          details: {},
        })),
    });
    const clock = { now: T0 };
    const worker = testWorker(ctx.db, clock, lookup);
    const cycle = async () => {
      await worker.runCycle();
      clock.now += 30_000;
    };
    const sent = () =>
      mock.to('/webhook').map((r) => {
        const b = r.json as { event: string; alerts: { labels: { node: string } }[] };
        return `${b.event}:${b.alerts.map((a) => a.labels.node).join(',')}`;
      });
    const statuses = async () =>
      (
        await ctx.db
          .selectFrom('notifications')
          .select(['kind', 'status'])
          .orderBy('created_at')
          .execute()
      ).map((n) => `${n.kind}:${n.status}`);
    return { active, clock, worker, cycle, sent, statuses };
  }

  it('sends neither when the firing and its resolve are both still queued', async () => {
    const s = await scenario();
    s.active.add('a');
    await s.cycle();
    s.active.clear();
    await s.cycle();
    await s.cycle(); // resolved: both messages are queued, none sent yet
    await deliverDue(deps, s.clock.now);
    await deliverDue(deps, s.clock.now + 60_000);
    await s.worker.stop();
    expect(s.sent()).toEqual([]);
    expect(await s.statuses()).toEqual(['firing:dropped', 'resolved:dropped']);
  });

  it('holds a resolve that comes due before its retried firing, then drops both', async () => {
    const s = await scenario();
    s.active.add('a');
    await s.cycle();
    mock.fail('/webhook', 503, 'busy');
    await deliverDue(deps, s.clock.now); // the firing fails, retried in 30 s
    mock.fail('/webhook', 200, 'ok');
    s.active.clear();
    await s.cycle();
    await s.cycle(); // resolve queued, due now
    // The firing's next retry comes later.
    await sql`UPDATE notifications SET next_attempt_at = ${new Date(s.clock.now + 600_000)} WHERE kind = 'firing'`.execute(
      ctx.db,
    );
    const first = await deliverDue(deps, s.clock.now);
    expect(first).toMatchObject({ sent: 0, deferred: 1 });
    await deliverDue(deps, s.clock.now + 601_000);
    await deliverDue(deps, s.clock.now + 700_000);
    await s.worker.stop();
    expect(s.sent()).toEqual(['firing:a']); // only the failed attempt reached the server
    expect(await s.statuses()).toEqual(['firing:dropped', 'resolved:dropped']);
  });

  it('waits for a firing message in flight, then sends the resolve after it', async () => {
    const s = await scenario();
    s.active.add('a');
    await s.cycle();
    // Another sender holds the firing message right now.
    await sql`UPDATE notifications SET status = 'sending', attempts = 1, lease_until = ${new Date(s.clock.now + 600_000)}`.execute(
      ctx.db,
    );
    s.active.clear();
    await s.cycle();
    await s.cycle();
    expect(await deliverDue(deps, s.clock.now)).toMatchObject({ sent: 0, deferred: 1 });
    // That sender delivers it.
    await sql`UPDATE notifications SET status = 'sent', sent_at = now() WHERE kind = 'firing'`.execute(
      ctx.db,
    );
    expect(await deliverDue(deps, s.clock.now + 10_000)).toMatchObject({ sent: 1 });
    await s.worker.stop();
    expect(s.sent()).toEqual(['resolved:a']);
  });

  it('leaves resolved alerts out of a firing message and resolves only what was delivered', async () => {
    const s = await scenario();
    s.active.add('a');
    s.active.add('b');
    await s.cycle(); // one firing message for a and b, not sent yet
    s.active.delete('a');
    await s.cycle();
    await s.cycle(); // a resolved: its resolve message is queued too
    await deliverDue(deps, s.clock.now);
    await deliverDue(deps, s.clock.now + 60_000);
    s.active.clear();
    await s.cycle();
    await s.cycle();
    await deliverDue(deps, s.clock.now + 120_000);
    await s.worker.stop();
    console.log(
      'DBG',
      mock.requests.map((r) => r.path + ' ' + r.body.slice(0, 120)),
    );
    expect(s.sent()).toEqual(['firing:b', 'resolved:b']);
  });
});

describe('Telegram deep-link verification (ADR-080)', () => {
  it('binds the chat that sends the one-time code and confirms in that chat', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    expect(await telegramBotName(http, mock.url, '123:abc')).toBe('watchlog_test_bot');
    const id = await insertChannel(
      ctx.db,
      orgId,
      'telegram',
      { botName: 'watchlog_test_bot' },
      encryptJson(KEY, { botToken: '123:abc' }),
    );
    const { link } = await startTelegramVerification(ctx.db, id, 'watchlog_test_bot', T0);
    const code = /^https:\/\/t\.me\/watchlog_test_bot\?start=([\w-]{16})$/.exec(link)![1]!;

    mock.telegramUpdates.push({
      update_id: 10,
      message: { text: '/start wrong-code-123', chat: { id: 1, type: 'private' } },
    });
    expect(await pollTelegramVerifications(deps, T0, 0)).toBe(0);
    const v = await ctx.db
      .selectFrom('telegram_verifications')
      .select('update_offset')
      .executeTakeFirstOrThrow();
    expect(Number(v.update_offset)).toBe(11);

    mock.telegramUpdates.push({
      update_id: 11,
      message: { text: `/start ${code}`, chat: { id: -100777, type: 'group', title: 'On-call' } },
    });
    expect(await pollTelegramVerifications(deps, T0 + 1000, 0)).toBe(1);
    const ch = await ctx.db
      .selectFrom('alert_channels')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(ch.config).toMatchObject({
      chatId: -100777,
      chatName: 'On-call',
      botName: 'watchlog_test_bot',
    });
    expect(ch.verified_at).not.toBeNull();
    expect(mock.to('/bot123:abc/sendMessage')[0]!.json).toMatchObject({ chat_id: -100777 });
    expect(await ctx.db.selectFrom('telegram_verifications').selectAll().execute()).toEqual([]);
  });

  it('drops a verification after 10 minutes', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const id = await insertChannel(
      ctx.db,
      orgId,
      'telegram',
      {},
      encryptJson(KEY, { botToken: '123:abc' }),
    );
    await startTelegramVerification(ctx.db, id, 'bot', T0);
    await pollTelegramVerifications(deps, T0 + 10 * 60_000 + 1, 0);
    expect(await ctx.db.selectFrom('telegram_verifications').selectAll().execute()).toEqual([]);
    expect(mock.to('/bot123:abc/getUpdates')).toEqual([]);
  });
});

describe('outbound proxy (ADR-080)', () => {
  let proxy: Server;
  let tunnels: string[];
  beforeEach(async () => {
    tunnels = [];
    // Plain http:// targets are forwarded (absolute-form requests), https:// ones tunnelled.
    proxy = createServer((req, res) => {
      const target = new URL(req.url ?? '');
      tunnels.push(target.host);
      const up = request(
        {
          host: target.hostname,
          port: target.port,
          path: target.pathname,
          method: req.method,
          headers: req.headers,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      req.pipe(up);
    });
    proxy.on('connect', (req, client, head) => {
      tunnels.push(req.url ?? '');
      const [host, port] = (req.url ?? '').split(':');
      const upstream = connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  });
  afterEach(() => new Promise<void>((r) => proxy.close(() => r())));

  it('goes through HTTP(S)_PROXY and skips hosts in NO_PROXY', async () => {
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const via = new HttpClient({ http: proxyUrl, https: proxyUrl });
    expect((await via.post(`${mock.url}/webhook`, '{}')).status).toBe(200);
    expect(tunnels).toEqual([new URL(mock.url).host]);
    await via.close();
    const direct = new HttpClient({ http: proxyUrl, https: proxyUrl, no: '127.0.0.1' });
    expect((await direct.post(`${mock.url}/webhook`, '{}')).status).toBe(200);
    expect(tunnels).toHaveLength(1);
    await direct.close();
  });
});
