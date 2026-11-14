// SPDX-License-Identifier: AGPL-3.0-only
// Support mode (ADR-179), scenario 16: staff open a support session through the internal
// admin API; it is read-only for at most an hour; the org's Owners see it in Settings ›
// Security and get an email; tokens read in it show "accessed by WatchLog staff". The app
// runs as in Cloud (watchlog_app under Row-Level Security, isolation/cloud.ts); the emails
// go to the test Mailpit.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInternalApp } from '../src/modules/internal/app.js';
import { STAFF_HEADER } from '../src/modules/internal/admin.js';
import { SUPPORT_COOKIE } from '../src/modules/support/service.js';
import { cloudWorld, seedOrg, type CloudWorld, type SeededOrg } from './isolation/cloud.js';
import { mailpitMessages, mailpitText, TEST_SMTP_URL } from './support/mock-providers.js';

const TOKEN = 's'.repeat(48);
const BILLING_TOKEN = 'b'.repeat(48);
const SITE = 'https://cloud.watchlog.test';
const STAFF = 'ada@watchlog.test';

let w: CloudWorld;
let A: SeededOrg;
let B: SeededOrg;
let internal: FastifyInstance;

beforeAll(async () => {
  w = await cloudWorld();
  A = await seedOrg(w, 'zzalpha');
  B = await seedOrg(w, 'zzbeta');
  // Each run's own Owner address, so Mailpit's earlier messages don't count.
  await w.owner
    .updateTable('users')
    .set({ email: `owner-${Date.now()}@zzalpha.test` })
    .where('id', '=', A.ownerId)
    .execute();
  internal = await buildInternalApp(
    // The Cloud admin's own token (SR-5); billing's is another.
    { token: BILLING_TOKEN, adminToken: TOKEN, host: '127.0.0.1', port: 0 },
    {
      systemDb: w.owner,
      entitlements: w.app.entitlements!,
      logLevel: 'silent',
      settings: async () => ({
        smtp: { transport: TEST_SMTP_URL, from: 'WatchLog <alerts@watchlog.test>' },
        publicUrl: SITE,
      }),
    },
  );
  await internal.ready();
}, 120_000);

afterAll(async () => {
  await internal?.close();
  await w?.close();
});

const staff = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  internal.inject({
    method,
    url,
    headers: { authorization: `Bearer ${TOKEN}`, [STAFF_HEADER]: STAFF },
    ...(payload ? { payload } : {}),
  });

async function open(org: SeededOrg, reason = 'Customer asked why the map is empty') {
  const res = await staff('POST', `/internal/admin/orgs/${org.orgId}/support-sessions`, {
    reason,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as {
    session: { id: string; expiresAt: string; startedAt: string };
    url: string;
    ownersEmailed: number;
  };
}

async function enter(url: string) {
  const u = new URL(url);
  expect(u.origin).toBe(SITE);
  const res = await w.app.inject({ method: 'GET', url: `${u.pathname}${u.search}` });
  return { res, cookie: res.cookies.find((c) => c.name === SUPPORT_COOKIE) };
}

const asSupport = (
  cookie: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  url: string,
  payload?: object,
) =>
  w.app.inject({
    method,
    url,
    cookies: { [SUPPORT_COOKIE]: cookie },
    ...(payload ? { payload } : {}),
  });

describe('scenario 16: staff opens a support session', () => {
  it('is opened for one org with a reason, recorded, and its Owners are emailed', async () => {
    const opened = await open(A);
    const minutes =
      (Date.parse(opened.session.expiresAt) - Date.parse(opened.session.startedAt)) / 60_000;
    expect(minutes).toBe(60);
    expect(opened.ownersEmailed).toBe(1);
    const owner = await w.owner
      .selectFrom('users')
      .select('email')
      .where('id', '=', A.ownerId)
      .executeTakeFirstOrThrow();
    const mails = await mailpitMessages(owner.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.Subject).toBe('WatchLog staff opened a support session in zzalpha Org');
    const text = await mailpitText(mails[0]!.ID);
    expect(text).toContain(STAFF);
    expect(text).toContain('Why: Customer asked why the map is empty');
    expect(text).toContain(`${SITE}/settings?tab=security`);
    const audit = await w.owner
      .selectFrom('audit_events')
      .select(['action', 'actor_name', 'details'])
      .where('org_id', '=', A.orgId)
      .where('action', '=', 'support_session_started')
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_name).toBe(`WatchLog staff (${STAFF})`);
  });

  it('the link works once, within 2 minutes, and sets a strict, HttpOnly cookie', async () => {
    const opened = await open(A);
    const first = await enter(opened.url);
    expect(first.res.statusCode).toBe(302);
    expect(first.res.headers.location).toBe('/');
    expect(first.cookie).toMatchObject({
      httpOnly: true,
      sameSite: 'Strict',
      secure: true,
      path: '/',
    });
    expect(
      Math.abs(first.cookie!.expires!.getTime() - Date.parse(opened.session.expiresAt)),
    ).toBeLessThan(1000);
    expect((await enter(opened.url)).res.statusCode).toBe(400);
    // An expired code: 400 too.
    const late = await open(A);
    await w.owner
      .updateTable('support_sessions')
      .set({ code_expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', late.session.id)
      .execute();
    expect((await enter(late.url)).res.statusCode).toBe(400);
  });

  it('reads the org as a viewer and refuses every change (403 support-read-only)', async () => {
    const { cookie } = await enter((await open(A)).url);
    const current = await asSupport(cookie!.value, 'GET', '/api/v1/support/current');
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ staffEmail: STAFF, org: { id: A.orgId } });
    const clusters = await asSupport(cookie!.value, 'GET', '/api/v1/clusters');
    expect(clusters.statusCode).toBe(200);
    expect(clusters.body).toContain(A.k8s.id);
    const me = await asSupport(cookie!.value, 'GET', '/api/v1/me');
    expect(me.json().user).toMatchObject({ role: 'viewer', name: 'WatchLog staff' });
    for (const [method, url, body] of [
      ['POST', '/api/v1/clusters', { name: 'x', kind: 'docker' }],
      ['PATCH', `/api/v1/clusters/${A.k8s.id}`, { name: 'renamed' }],
      ['DELETE', `/api/v1/alert-channels/${A.channelId}`, undefined],
      ['POST', '/api/v1/api-tokens', { name: 'staff' }],
      ['POST', '/api/v1/auth/logout', undefined],
    ] as const) {
      const r = await asSupport(cookie!.value, method, url, body);
      expect(r.statusCode, url).toBe(403);
      expect(r.json().code).toBe('support-read-only');
    }
    // Container logs stay out of support mode.
    const logs = await asSupport(
      cookie!.value,
      'GET',
      `/api/v1/clusters/${A.k8s.id}/pods/${A.pod.namespace}/${A.pod.name}/logs`,
    );
    expect(logs.statusCode).toBe(403);
  });

  it("can't reach another org: B's ids answer 404", async () => {
    const { cookie } = await enter((await open(A)).url);
    for (const url of [
      `/api/v1/clusters/${B.k8s.id}`,
      `/api/v1/alerts/${B.alertId}`,
      `/api/v1/applications/${B.serviceId}`,
    ]) {
      const r = await asSupport(cookie!.value, 'GET', url);
      expect(r.statusCode, url).toBe(404);
      expect(r.body).not.toContain('zzbeta');
    }
  });

  it('records what was opened, and tokens read show "accessed by WatchLog staff"', async () => {
    const opened = await open(A, 'Tokens check');
    const { cookie } = await enter(opened.url);
    await asSupport(cookie!.value, 'GET', `/api/v1/clusters/${A.k8s.id}`);
    await asSupport(cookie!.value, 'GET', `/api/v1/clusters/${A.k8s.id}`);
    const users = await asSupport(cookie!.value, 'GET', '/api/v1/users');
    expect(users.statusCode, users.body).toBe(200);
    // The records are written after each answer has gone out (onResponse).
    await new Promise((r) => setTimeout(r, 300));
    const views = await w.owner
      .selectFrom('support_session_views')
      .select(['path', 'count'])
      .where('session_id', '=', opened.session.id)
      .orderBy('path')
      .execute();
    expect(views).toEqual([
      { path: `/api/v1/clusters/${A.k8s.id}`, count: 2 },
      { path: '/api/v1/users', count: 1 },
    ]);
    const tokenAudit = await w.owner
      .selectFrom('audit_events')
      .select(['details'])
      .where('org_id', '=', A.orgId)
      .where('action', '=', 'support_tokens_accessed')
      .execute();
    const kinds = tokenAudit.map((a) => a.details as { kind: string; sessionId: string });
    expect(
      kinds
        .filter((k) => k.sessionId === opened.session.id)
        .map((k) => k.kind)
        .sort(),
    ).toEqual(['api', 'cluster']);
    const events = await w.owner
      .selectFrom('api_token_events')
      .select(['kind', 'detail'])
      .where('token_id', '=', A.apiToken.id)
      .where('kind', '=', 'staff_access')
      .execute();
    expect(events.length).toBeGreaterThanOrEqual(1);
    // The token's own page (its Owner's) lists it.
    const page = await w.app.inject({
      method: 'GET',
      url: `/api/v1/api-tokens/${A.apiToken.id}`,
      cookies: { wl_session: await A.session() },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('staff_access');
  });

  it("the Owners see every session (who, when, why, what); others in the org don't", async () => {
    const res = await w.app.inject({
      method: 'GET',
      url: '/api/v1/support-sessions',
      cookies: { wl_session: await A.session() },
    });
    expect(res.statusCode).toBe(200);
    const sessions = res.json().sessions as {
      staffEmail: string;
      reason: string;
      opened: { path: string }[];
    }[];
    expect(sessions.length).toBeGreaterThanOrEqual(5);
    expect(sessions.every((s) => s.staffEmail === STAFF)).toBe(true);
    expect(sessions.some((s) => s.reason === 'Tokens check' && s.opened.length === 2)).toBe(true);
    // B's Owner sees B's sessions only (none).
    const b = await w.app.inject({
      method: 'GET',
      url: '/api/v1/support-sessions',
      cookies: { wl_session: await B.session() },
    });
    expect(b.json().sessions).toEqual([]);
  });

  it('ends after its hour, when staff leave, or when the admin ends it', async () => {
    const one = await open(A);
    const { cookie } = await enter(one.url);
    await w.owner
      .updateTable('support_sessions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', one.session.id)
      .execute();
    expect((await asSupport(cookie!.value, 'GET', '/api/v1/clusters')).statusCode).toBe(401);

    const two = await enter((await open(A)).url);
    const left = await asSupport(two.cookie!.value, 'DELETE', '/api/v1/support/session');
    expect(left.statusCode).toBe(204);
    expect((await asSupport(two.cookie!.value, 'GET', '/api/v1/clusters')).statusCode).toBe(401);

    const three = await open(A);
    const t = await enter(three.url);
    expect(
      (await staff('DELETE', `/internal/admin/support-sessions/${three.session.id}`)).statusCode,
    ).toBe(204);
    expect((await asSupport(t.cookie!.value, 'GET', '/api/v1/clusters')).statusCode).toBe(401);
    // Never longer than an hour: the API refuses more, the database too.
    const long = await staff('POST', `/internal/admin/orgs/${A.orgId}/support-sessions`, {
      reason: 'long',
      minutes: 61,
    });
    expect(long.statusCode).toBe(400);
    await expect(
      w.owner
        .updateTable('support_sessions')
        .set({ expires_at: new Date(Date.now() + 2 * 3_600_000) })
        .where('id', '=', three.session.id)
        .execute(),
    ).rejects.toThrow(/check constraint/);
  });

  it('needs the staff header: no write without a named staff member', async () => {
    const res = await internal.inject({
      method: 'POST',
      url: `/internal/admin/orgs/${A.orgId}/support-sessions`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { reason: 'nobody' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(STAFF_HEADER);
  });
});
