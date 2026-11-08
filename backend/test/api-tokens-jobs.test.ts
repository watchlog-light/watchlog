// SPDX-License-Identifier: AGPL-3.0-only
// The alert-worker's hourly API token upkeep (ADR-125): expiry events, deletion after 30
// days, and the expiry reminder through the email server (Mailpit in tests).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import {
  reminderEmail,
  runApiTokenJobs,
  type TokenJobDeps,
} from '../src/modules/api-tokens/jobs.js';
import { createApiToken } from '../src/modules/api-tokens/service.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  type TestContext,
} from './helpers.js';
import { mailpitMessages, mailpitText, TEST_SMTP_URL } from './support/mock-providers.js';

const DAY = 86_400_000;
const T0 = new Date('2026-11-08T10:00:00Z').getTime();

let ctx: TestContext;
let logs: { level: string; msg: string; obj: object }[];
let smtp: TokenJobDeps['settings'] extends () => Promise<infer S> ? S : never;

beforeEach(async () => {
  ctx = await createTestContext();
  logs = [];
  smtp = { smtp: { transport: TEST_SMTP_URL, from: 'WatchLog <alerts@acme.test>' } };
});
afterEach(() => closeTestContext(ctx));

const log = (level: string) => (obj: object, msg: string) => void logs.push({ level, msg, obj });
const deps = (): TokenJobDeps => ({
  db: ctx.db,
  settings: async () => smtp,
  log: { debug: log('debug'), info: log('info'), warn: log('warn') },
});

async function user(email = `owner-${newId()}@example.com`) {
  const { userId, orgId } = await createUserSession(ctx.db, { role: 'owner', email });
  return { userId, orgId, email };
}

async function token(
  u: { userId: string; orgId: string },
  name: string,
  expiresInDays: number | null,
  createdAt = T0,
) {
  const created = await createApiToken(ctx.db, {
    ...u,
    name,
    expiresInDays,
    now: new Date(createdAt),
  });
  if (created === 'limit') throw new Error('limit');
  return created.token.id;
}

const kinds = async (id: string) =>
  (
    await ctx.db
      .selectFrom('api_token_events')
      .select('kind')
      .where('token_id', '=', id)
      .orderBy('at')
      .execute()
  ).map((e) => e.kind);
const row = (id: string) =>
  ctx.db.selectFrom('api_tokens').selectAll().where('id', '=', id).executeTakeFirst();

describe('API token upkeep', () => {
  it('records expiry once and keeps only the network of the last address', async () => {
    smtp = {}; // no reminders in this test
    const u = await user();
    const id = await token(u, 'short', 30);
    const live = await token(u, 'live', null);
    await ctx.db
      .updateTable('api_tokens')
      .set({ last_used_ip: '203.0.113.42', last_used_at: new Date(T0) })
      .execute();
    expect((await runApiTokenJobs(deps(), T0 + 29 * DAY)).expired).toBe(0);
    expect((await runApiTokenJobs(deps(), T0 + 31 * DAY)).expired).toBe(1);
    expect((await runApiTokenJobs(deps(), T0 + 32 * DAY)).expired).toBe(0);
    expect(await kinds(id)).toEqual(['created', 'expired']);
    const expired = await ctx.db
      .selectFrom('api_token_events')
      .select('at')
      .where('token_id', '=', id)
      .where('kind', '=', 'expired')
      .executeTakeFirstOrThrow();
    expect(expired.at.getTime()).toBe(T0 + 30 * DAY);
    expect((await row(id))!.last_used_ip).toBe('203.0.113.0/24');
    expect((await row(live))!.last_used_ip).toBe('203.0.113.42');

    // IPv6: the /48.
    await ctx.db
      .updateTable('api_tokens')
      .set({ last_used_ip: '2001:db8:1234:5678::1' })
      .where('id', '=', live)
      .execute();
    await ctx.db
      .updateTable('api_tokens')
      .set({ expires_at: new Date(T0 + DAY) })
      .where('id', '=', live)
      .execute();
    await runApiTokenJobs(deps(), T0 + 2 * DAY);
    expect((await row(live))!.last_used_ip).toBe('2001:db8:1234::/48');
  });

  it('deletes tokens and their history 30 days after they expired or were revoked', async () => {
    const u = await user();
    const expiring = await token(u, 'expiring', 30);
    const revoked = await token(u, 'revoked', null);
    const kept = await token(u, 'kept', 365);
    await ctx.db
      .updateTable('api_tokens')
      .set({ revoked_at: new Date(T0 + 10 * DAY), revoked_by: u.userId })
      .where('id', '=', revoked)
      .execute();
    expect((await runApiTokenJobs(deps(), T0 + 39 * DAY)).deleted).toBe(0);
    expect((await runApiTokenJobs(deps(), T0 + 41 * DAY)).deleted).toBe(1);
    expect(await row(revoked)).toBeUndefined();
    expect((await runApiTokenJobs(deps(), T0 + 61 * DAY)).deleted).toBe(1);
    expect(await row(expiring)).toBeUndefined();
    expect(await row(kept)).toBeDefined();
    const orphans = await ctx.db
      .selectFrom('api_token_events')
      .select('token_id')
      .where('token_id', 'in', [expiring, revoked])
      .execute();
    expect(orphans).toEqual([]);
  });

  it('emails the owner once, 7 days before the expiry', async () => {
    const u = await user();
    const id = await token(u, 'Cursor', 30);
    await token(u, 'never', null);
    const revoked = await token(u, 'gone', 30);
    await ctx.db
      .updateTable('api_tokens')
      .set({ revoked_at: new Date(T0 + DAY) })
      .where('id', '=', revoked)
      .execute();
    expect((await runApiTokenJobs(deps(), T0 + 22 * DAY)).reminded).toBe(0);
    expect((await runApiTokenJobs(deps(), T0 + 23 * DAY + 60_000)).reminded).toBe(1);
    expect((await runApiTokenJobs(deps(), T0 + 24 * DAY)).reminded).toBe(0);

    const mails = await mailpitMessages(u.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.Subject).toBe('Your WatchLog API token "Cursor" expires on Dec 8, 2026');
    const text = await mailpitText(mails[0]!.ID);
    expect(text).toContain('Settings → API tokens');
    expect(text).toContain('Create a new token');
    expect(text).not.toMatch(/wl_pat_[A-Za-z0-9_-]{43}/);
    expect(await kinds(id)).toEqual(['created', 'reminder_sent']);
    expect((await row(id))!.reminded_at).not.toBeNull();
  });

  it('waits without an email server, and retries a failed send the next hour', async () => {
    const u = await user();
    const id = await token(u, 'CI', 30);
    const soon = T0 + 25 * DAY;

    smtp = {};
    const skipped = await runApiTokenJobs(deps(), soon);
    expect(skipped).toMatchObject({ reminded: 0, failed: 0 });
    expect(logs.some((l) => l.level === 'debug' && /email server/.test(l.msg))).toBe(true);
    expect((await row(id))!.reminded_at).toBeNull();

    // Nothing listens on port 1: the send fails, the worker goes on.
    smtp = { smtp: { transport: 'smtp://127.0.0.1:1', from: 'WatchLog <alerts@acme.test>' } };
    const failed = await runApiTokenJobs(deps(), soon + 3_600_000);
    expect(failed).toMatchObject({ reminded: 0, failed: 1 });
    expect(logs.some((l) => l.level === 'warn' && /retrying/.test(l.msg))).toBe(true);
    expect((await row(id))!.reminded_at).toBeNull();
    expect(await kinds(id)).toEqual(['created']);

    smtp = { smtp: { transport: TEST_SMTP_URL, from: 'WatchLog <alerts@acme.test>' } };
    expect((await runApiTokenJobs(deps(), soon + 2 * 3_600_000)).reminded).toBe(1);
    expect(await mailpitMessages(u.email)).toHaveLength(1);
  });

  it('writes a short plain-text reminder with a link when the public address is known', () => {
    const mail = reminderEmail({
      tokenName: 'Claude Code · laptop',
      prefix: 'wl_pat_7Kq2',
      expiresAt: new Date('2027-01-31T09:30:00Z'),
      userName: 'Ada',
      publicUrl: 'https://watchlog.example.com/',
    });
    expect(mail.subject).toBe(
      'Your WatchLog API token "Claude Code · laptop" expires on Jan 31, 2027',
    );
    expect(mail.text).toContain('(wl_pat_7Kq2…) expires on Jan 31, 2027 at 09:30 UTC');
    expect(mail.text).toContain('https://watchlog.example.com/settings');
  });
});
