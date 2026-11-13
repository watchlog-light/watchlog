// SPDX-License-Identifier: AGPL-3.0-only
// The lifecycle emails (ADR-179): which one is due, the texts, the job against the test
// Mailpit (from the founder's address, List-Unsubscribe, one a day, none twice, written
// under Row-Level Security), the beta notice only when billing asked, and the one-click
// unsubscribe.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import {
  dueKind,
  sendLifecycleEmails,
  senderName,
  type Candidate,
} from '../src/modules/lifecycle/job.js';
import { lifecycleEmail, type LifecycleKind } from '../src/modules/lifecycle/texts.js';
import { unsubscribeToken, verifyUnsubscribeToken } from '../src/modules/lifecycle/unsubscribe.js';
import { cloudWorld, type CloudWorld } from './isolation/cloud.js';
import { TEST_SECRET_KEY } from './helpers.js';
import { mailpitMessages, TEST_MAILPIT_URL, TEST_SMTP_URL } from './support/mock-providers.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FROM = 'Ada Founder <founder@watchlog.test>';
const SITE = 'https://cloud.watchlog.test';
const key = Buffer.from(TEST_SECRET_KEY, 'base64');

const base = (over: Partial<Candidate> = {}): Candidate => ({
  userCreatedAt: new Date(Date.now() - 10 * 60_000),
  sentKinds: [],
  sentToday: false,
  hasData: false,
  firstAlertAt: null,
  plan: 'free',
  nodes: 0,
  nodeLimit: 5,
  ...over,
});

describe('which email is due', () => {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms);
  it('welcome first; nothing on a day one was sent', () => {
    expect(dueKind(base(), now)).toBe('welcome');
    expect(dueKind(base({ sentToday: true }), now)).toBeNull();
  });
  it('no data after an hour, within the first week', () => {
    const c = base({ sentKinds: ['welcome'] });
    expect(dueKind({ ...c, userCreatedAt: ago(30 * 60_000) }, now)).toBeNull();
    expect(dueKind({ ...c, userCreatedAt: ago(2 * HOUR) }, now)).toBe('no_data');
    expect(dueKind({ ...c, userCreatedAt: ago(2 * HOUR), hasData: true }, now)).toBeNull();
    expect(dueKind({ ...c, userCreatedAt: ago(8 * DAY) }, now)).toBeNull();
  });
  it('the first alert, within 3 days of it', () => {
    const c = base({ sentKinds: ['welcome'], hasData: true, userCreatedAt: ago(DAY) });
    expect(dueKind({ ...c, firstAlertAt: ago(HOUR) }, now)).toBe('first_alert');
    expect(dueKind({ ...c, firstAlertAt: ago(4 * DAY) }, now)).toBeNull();
  });
  it('near the Free node limit: one node from it, Free only', () => {
    const c = base({ sentKinds: ['welcome'], hasData: true, userCreatedAt: ago(DAY) });
    expect(dueKind({ ...c, nodes: 3 }, now)).toBeNull();
    expect(dueKind({ ...c, nodes: 4 }, now)).toBe('near_limit');
    expect(dueKind({ ...c, nodes: 4, plan: 'pro', nodeLimit: null }, now)).toBeNull();
  });
  it('day 3 tips with data, days 3 to 10; each kind once', () => {
    const c = base({ sentKinds: ['welcome'], hasData: true });
    expect(dueKind({ ...c, userCreatedAt: ago(2 * DAY) }, now)).toBeNull();
    expect(dueKind({ ...c, userCreatedAt: ago(4 * DAY) }, now)).toBe('day3_tips');
    expect(
      dueKind({ ...c, userCreatedAt: ago(4 * DAY), sentKinds: ['welcome', 'day3_tips'] }, now),
    ).toBeNull();
    expect(dueKind({ ...c, userCreatedAt: ago(11 * DAY) }, now)).toBeNull();
  });
});

describe('the texts', () => {
  const ctx = {
    site: SITE,
    orgName: 'acme',
    name: 'Sam',
    signature: 'Ada Founder, WatchLog',
    unsubscribeUrl: `${SITE}/api/v1/email/unsubscribe?token=x`,
    clusterId: 'c1',
    nodes: 4,
    nodeLimit: 5,
    billingStartsAt: new Date('2027-02-01T00:00:00Z'),
  };
  const kinds: LifecycleKind[] = [
    'welcome',
    'no_data',
    'first_alert',
    'day3_tips',
    'near_limit',
    'beta_notice',
  ];
  it('are short, plain, signed, and end with the unsubscribe (not the service notice)', () => {
    for (const k of kinds) {
      const m = lifecycleEmail(k, ctx);
      expect(m.subject.length, k).toBeLessThan(60);
      expect(m.text.split('\n').length, k).toBeLessThan(25);
      expect(m.text, k).toContain('Ada Founder, WatchLog');
      expect(m.text, k).not.toMatch(/<[a-z]+[ >]/i);
      if (k === 'beta_notice') expect(m.text).not.toContain('unsubscribe');
      else expect(m.text, k).toContain(ctx.unsubscribeUrl);
    }
    expect(lifecycleEmail('no_data', ctx).text).toContain(`${SITE}/onboarding?id=c1`);
    expect(lifecycleEmail('near_limit', ctx).text).toContain(
      'has 4 nodes sending data. Cloud Free includes 5.',
    );
    expect(lifecycleEmail('beta_notice', ctx).text).toContain('1 February 2027');
    expect(senderName(FROM)).toBe('Ada Founder');
    expect(senderName('founder@watchlog.test')).toBe('WatchLog');
  });
});

describe('the unsubscribe token', () => {
  it('is signed for one user and refuses a changed one', () => {
    const id = newId();
    const t = unsubscribeToken(key, id);
    expect(verifyUnsubscribeToken(key, t)).toBe(id);
    expect(verifyUnsubscribeToken(key, t.replace(id, newId()))).toBeNull();
    expect(verifyUnsubscribeToken(key, `${t}x`)).toBeNull();
    expect(verifyUnsubscribeToken(Buffer.alloc(32, 9), t)).toBeNull();
    expect(verifyUnsubscribeToken(key, 'nonsense')).toBeNull();
  });
});

describe('the job (test SMTP)', () => {
  let w: CloudWorld;
  const run = `${Date.now()}`;
  const email = (n: string) => `${n}-${run}@lifecycle.test`;
  const settings = async () => ({
    smtp: { transport: TEST_SMTP_URL, from: 'WatchLog <alerts@watchlog.test>' },
    publicUrl: SITE,
  });
  const job = (now = Date.now(), opts: { from?: string } = { from: FROM }) =>
    sendLifecycleEmails(
      {
        systemDb: w.owner,
        db: w.appDb,
        secretKey: key,
        from: opts.from,
        settings,
        log: { info: () => {}, warn: () => {} },
      },
      now,
    );

  async function owner(name: string, createdAgo: number, verified = true) {
    const orgId = newId();
    const userId = newId();
    await w.owner
      .insertInto('orgs')
      .values({ id: orgId, name: `${name} org`, slug: `${name}-${run}`, plan: 'free' })
      .execute();
    await w.owner
      .insertInto('users')
      .values({
        id: userId,
        email: email(name),
        name: `${name} Person`,
        password_hash: 'x',
        created_at: new Date(Date.now() - createdAgo),
        email_verified_at: verified ? new Date() : null,
      })
      .execute();
    await w.owner
      .insertInto('memberships')
      .values({ id: newId(), org_id: orgId, user_id: userId, role: 'owner' })
      .execute();
    return { orgId, userId };
  }

  beforeAll(async () => {
    w = await cloudWorld();
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });

  it('sends nothing without the founder address', async () => {
    await owner('nofrom', 10 * 60_000);
    expect(await job(Date.now(), {})).toBe(0);
    expect(await mailpitMessages(email('nofrom'))).toHaveLength(0);
  });

  it('welcome from the founder, with one-click unsubscribe headers; then nothing that day', async () => {
    const u = await owner('sam', 10 * 60_000);
    await owner('unverified', 10 * 60_000, false);
    await job();
    const mails = await mailpitMessages(email('sam'));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.Subject).toBe('Welcome to WatchLog');
    expect(await mailpitMessages(email('unverified'))).toHaveLength(0);
    const msg = (await (
      await fetch(`${TEST_MAILPIT_URL}/api/v1/message/${mails[0]!.ID}`)
    ).json()) as {
      From: { Address: string; Name: string };
      ReplyTo: { Address: string }[];
      Text: string;
    };
    expect(msg.From).toMatchObject({ Address: 'founder@watchlog.test', Name: 'Ada Founder' });
    expect(msg.ReplyTo[0]!.Address).toBe('founder@watchlog.test');
    const headers = (await (
      await fetch(`${TEST_MAILPIT_URL}/api/v1/message/${mails[0]!.ID}/headers`)
    ).json()) as Record<string, string[]>;
    expect(headers['List-Unsubscribe']![0]).toBe(
      `<${SITE}/api/v1/email/unsubscribe?token=${encodeURIComponent(unsubscribeToken(key, u.userId))}>`,
    );
    expect(headers['List-Unsubscribe-Post']![0]).toBe('List-Unsubscribe=One-Click');
    // Recorded under its org; a second run the same day sends nothing more.
    const rows = await w.owner
      .selectFrom('lifecycle_emails')
      .selectAll()
      .where('user_id', '=', u.userId)
      .execute();
    expect(rows).toMatchObject([{ kind: 'welcome', org_id: u.orgId }]);
    await job(Date.now() + 2 * HOUR);
    expect(await mailpitMessages(email('sam'))).toHaveLength(1);
    // The next day: no data after an hour, with the install page's checks.
    await job(Date.now() + 25 * HOUR);
    const next = await mailpitMessages(email('sam'));
    expect(next.map((m) => m.Subject)).toEqual([
      'Welcome to WatchLog',
      'Need help installing WatchLog?',
    ]);
  });

  it('the one-click unsubscribe stops them (POST); a GET only shows the button', async () => {
    const u = await owner('leaver', 10 * 60_000);
    const token = unsubscribeToken(key, u.userId);
    const url = `/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`;
    const page = await w.app.inject({ method: 'GET', url });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<form method="post"');
    const still = await w.owner
      .selectFrom('users')
      .select('lifecycle_unsubscribed_at')
      .where('id', '=', u.userId)
      .executeTakeFirstOrThrow();
    expect(still.lifecycle_unsubscribed_at).toBeNull();
    // As a mail client sends it (RFC 8058): a form body, no Origin.
    const post = await w.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(post.statusCode).toBe(200);
    const bad = await w.app.inject({
      method: 'POST',
      url: `${url}x`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(bad.statusCode).toBe(400);
    await job();
    expect(await mailpitMessages(email('leaver'))).toHaveLength(0);
  });

  it('the beta notice goes only when billing asked, to every Owner, even after an unsubscribe', async () => {
    const u = await owner('beta', 20 * DAY);
    await w.owner
      .insertInto('entitlements')
      .values({ org_id: u.orgId, plan: 'pro', source: 'beta', users: 10, retention_days: 30 })
      .execute();
    await w.owner
      .updateTable('users')
      .set({ lifecycle_unsubscribed_at: new Date() })
      .where('id', '=', u.userId)
      .execute();
    await job();
    expect(await mailpitMessages(email('beta'))).toHaveLength(0);
    await w.owner
      .insertInto('beta_notices')
      .values({ org_id: u.orgId, billing_starts_at: new Date(Date.now() + 14 * DAY) })
      .execute();
    await job();
    await job();
    const mails = await mailpitMessages(email('beta'));
    expect(mails.map((m) => m.Subject)).toEqual(['WatchLog Pro: billing starts in 14 days']);
  });
});
