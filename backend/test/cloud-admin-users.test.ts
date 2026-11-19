// SPDX-License-Identifier: AGPL-3.0-only
// The internal admin API's users (ADR-179, amended in 0.9.9), read by the Cloud admin's Users
// page: the list with its search, filters, order, paging and totals; one user with their orgs
// and funnel dates; "last sign-in", which outlives the session; and that no secret is in any
// answer. Two seeded orgs with three users each, set to known states here; the clock is
// injected.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { createSession, deleteSession } from '../src/modules/auth/sessions.js';
import { STAFF_HEADER } from '../src/modules/internal/admin.js';
import { buildInternalApp } from '../src/modules/internal/app.js';
import { cloudWorld, seedOrg, type CloudWorld, type SeededOrg } from './isolation/cloud.js';

const TOKEN = 'a'.repeat(48);
const BILLING_TOKEN = 'b'.repeat(48);
const STAFF = 'grace@watchlog.test';
const DAY = 86_400_000;
const MARK = { hash: 'argon2id-MARKER-not-to-be-seen', totp: 'TOTP-MARKER-not-to-be-seen' };

let w: CloudWorld;
let A: SeededOrg;
let B: SeededOrg;
let internal: FastifyInstance;
/** The API's clock. */
let NOW: number;

interface Row {
  id: string;
  email: string;
  signedUpWith: string;
  emailVerified: boolean;
  mfa: boolean;
  orgs: { id: string; name: string; role: string; plan: string; source: string | null }[];
  nodesNow: number;
  firstAgentAt: string | null;
  lastDataAt: string | null;
  lastSignInAt: string | null;
  createdAt: string;
}
const staff = (url: string, headers: Record<string, string> = {}) =>
  internal.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${TOKEN}`, [STAFF_HEADER]: STAFF, ...headers },
  });
const list = async (query = '') => {
  const res = await staff(`/internal/admin/users${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { users: Row[]; total: number; totals: Record<string, number> };
};
const emails = async (query = '') => (await list(query)).users.map((u) => u.email);
const user = (id: string, v: Record<string, unknown>) =>
  w.owner.updateTable('users').set(v).where('id', '=', id).execute();

beforeAll(async () => {
  w = await cloudWorld();
  A = await seedOrg(w, 'zzalpha');
  B = await seedOrg(w, 'zzbeta');
  NOW = Date.now();
  internal = await buildInternalApp(
    { token: BILLING_TOKEN, adminToken: TOKEN, host: '127.0.0.1', port: 0 },
    {
      systemDb: w.owner,
      entitlements: w.app.entitlements!,
      funnel: w.app.funnel,
      logLevel: 'silent',
      now: () => NOW,
    },
  );
  await internal.ready();

  // Known states. A: Pro by staff, an agent connected 3 days ago. B: Free, no agent ever.
  await w.owner
    .updateTable('clusters')
    .set({ first_seen_at: new Date(NOW - 3 * DAY) })
    .where('org_id', '=', A.orgId)
    .execute();
  await w.owner
    .updateTable('clusters')
    .set({ first_seen_at: null })
    .where('org_id', '=', B.orgId)
    .execute();
  await w.owner.deleteFrom('agent_instances').where('org_id', '=', B.orgId).execute();
  await w.owner
    .updateTable('entitlements')
    .set({ plan: 'free', source: 'signup', pro_features: false })
    .where('org_id', '=', B.orgId)
    .execute();
  await w.owner.updateTable('orgs').set({ plan: 'pro' }).where('id', '=', A.orgId).execute();
  // People: A's Owner verified, with 2FA and secrets that must never be read out; A's Admin
  // signed up with GitHub; B's Viewer signed up 40 days ago and never came back.
  await user(A.ownerId, {
    email_verified_at: new Date(NOW - DAY),
    totp_enabled_at: new Date(NOW - DAY),
    totp_secret: MARK.totp,
    password_hash: MARK.hash,
  });
  await user(A.adminId, { signup_source: JSON.stringify({ method: 'github' }) });
  await w.owner
    .insertInto('user_identities')
    .values({
      id: newId(),
      user_id: A.adminId,
      provider: 'github',
      provider_user_id: '4242',
      email: 'admin@zzalpha.test',
    })
    .execute();
  await user(B.viewerId, { created_at: new Date(NOW - 40 * DAY), last_sign_in_at: null });
  await user(B.adminId, {
    created_at: new Date(NOW - 20 * DAY),
    last_sign_in_at: new Date(NOW - 16 * DAY),
  });
  await w.owner.deleteFrom('sessions').where('user_id', 'in', [B.viewerId, B.adminId]).execute();
}, 120_000);

afterAll(async () => {
  await internal?.close();
  await w?.close();
});

describe('GET /internal/admin/users', () => {
  it('lists every user with how they signed up, their orgs, plans and agents, newest first', async () => {
    const out = await list();
    expect(out.total).toBe(6);
    expect(out.users).toHaveLength(6);
    const owner = out.users.find((u) => u.id === A.ownerId)!;
    expect(owner).toMatchObject({
      email: 'owner@zzalpha.test',
      signedUpWith: 'email',
      emailVerified: true,
      mfa: true,
      orgs: [{ id: A.orgId, name: 'zzalpha Org', role: 'owner', plan: 'pro', source: 'staff' }],
    });
    expect(owner.firstAgentAt).toBe(new Date(NOW - 3 * DAY).toISOString());
    expect(owner.lastDataAt).not.toBeNull();
    expect(owner.lastSignInAt).not.toBeNull();
    const admin = out.users.find((u) => u.id === A.adminId)!;
    expect(admin).toMatchObject({ signedUpWith: 'github', emailVerified: false, mfa: false });
    const viewerB = out.users.find((u) => u.id === B.viewerId)!;
    expect(viewerB).toMatchObject({
      orgs: [{ id: B.orgId, role: 'viewer', plan: 'free', source: 'signup' }],
      nodesNow: 0,
      firstAgentAt: null,
      lastDataAt: null,
      lastSignInAt: null,
    });
    // Newest first: the two that signed up 20 and 40 days ago come last, in that order.
    expect(out.users.slice(-2).map((u) => u.id)).toEqual([B.adminId, B.viewerId]);
  });

  it('totals count every user, whatever the filters', async () => {
    const want = { users: 6, verified: 1, withAgent: 3, onPro: 3, newThisWeek: 4 };
    expect((await list()).totals).toEqual(want);
    expect((await list('?plan=free&q=viewer')).totals).toEqual(want);
  });

  it('searches the email, the name and the orgs', async () => {
    expect(await emails('?q=VIEWER@zzbeta')).toEqual(['viewer@zzbeta.test']);
    expect((await emails('?q=zzalpha-org')).sort()).toEqual([
      'admin@zzalpha.test',
      'owner@zzalpha.test',
      'viewer@zzalpha.test',
    ]);
    expect(await emails('?q=zzbeta%20Admin')).toEqual(['admin@zzbeta.test']);
    // A % or _ in the search is a character, not a wildcard.
    expect(await emails('?q=%25')).toEqual([]);
    expect((await list('?q=nobody-at-all')).total).toBe(0);
  });

  it('filters by plan, by an agent connected or not, by sign-up date and by 14 days of silence', async () => {
    const of = (o: SeededOrg) => [o.ownerId, o.adminId, o.viewerId].sort();
    const ids = async (q: string) => (await list(q)).users.map((u) => u.id).sort();
    expect(await ids('?plan=pro')).toEqual(of(A));
    expect(await ids('?plan=free')).toEqual(of(B));
    expect(await ids('?plan=enterprise')).toEqual([]);
    expect(await ids('?agent=yes')).toEqual(of(A));
    expect(await ids('?agent=no')).toEqual(of(B));
    // Signed up in the last 7 days: all but B's Admin (20 days) and Viewer (40 days).
    expect(await ids('?signedUpDays=7')).toEqual([...of(A), B.ownerId].sort());
    expect(await ids('?signedUpDays=30')).toEqual([...of(A), B.ownerId, B.adminId].sort());
    // Inactive: signed in 16 days ago, and never since signing up 40 days ago.
    expect(await ids('?inactiveDays=14')).toEqual([B.adminId, B.viewerId].sort());
    // Together.
    expect(await ids('?plan=free&signedUpDays=30&inactiveDays=14')).toEqual([B.adminId]);
  });

  it('orders by any column, both ways, with missing values last', async () => {
    expect(await emails('?sort=email')).toEqual([
      'admin@zzalpha.test',
      'admin@zzbeta.test',
      'owner@zzalpha.test',
      'owner@zzbeta.test',
      'viewer@zzalpha.test',
      'viewer@zzbeta.test',
    ]);
    expect((await emails('?sort=email&dir=desc'))[0]).toBe('viewer@zzbeta.test');
    expect((await list('?sort=createdAt&dir=asc')).users[0]!.id).toBe(B.viewerId);
    expect(
      (await list('?sort=plan&dir=desc')).users.slice(0, 3).every((u) => u.orgs[0]!.plan === 'pro'),
    ).toBe(true);
    expect((await list('?sort=mfa&dir=desc')).users[0]!.id).toBe(A.ownerId);
    expect((await list('?sort=signedUpWith&dir=desc')).users[0]!.id).toBe(A.adminId);
    // Never signed in is last in both directions.
    for (const dir of ['asc', 'desc']) {
      expect((await list(`?sort=lastSignInAt&dir=${dir}`)).users.at(-1)!.id).toBe(B.viewerId);
    }
    for (const sort of [
      'name',
      'emailVerified',
      'orgs',
      'nodesNow',
      'firstAgentAt',
      'lastDataAt',
    ]) {
      expect((await staff(`/internal/admin/users?sort=${sort}`)).statusCode, sort).toBe(200);
    }
    // Nothing else can be put in the ORDER BY.
    for (const sort of ['password_hash', 'totp_secret', 'id; DROP TABLE users']) {
      expect(
        (await staff(`/internal/admin/users?sort=${encodeURIComponent(sort)}`)).statusCode,
      ).toBe(400);
    }
  });

  it('pages, and says how many match in all', async () => {
    const first = await list('?sort=email&limit=4');
    const second = await list('?sort=email&limit=4&offset=4');
    expect([first.total, second.total]).toEqual([6, 6]);
    expect([first.users.length, second.users.length]).toEqual([4, 2]);
    expect(new Set([...first.users, ...second.users].map((u) => u.id)).size).toBe(6);
    // A page past the end is empty and still knows the count.
    expect(await list('?limit=4&offset=40')).toMatchObject({ users: [], total: 6 });
    expect((await staff('/internal/admin/users?limit=500')).statusCode).toBe(400);
  });

  it('never answers a password hash, a TOTP secret, a token or a session', async () => {
    const res = await staff('/internal/admin/users?limit=200');
    const one = await staff(`/internal/admin/users/${A.ownerId}`);
    for (const body of [res.body, one.body]) {
      expect(body).not.toContain(MARK.hash);
      expect(body).not.toContain(MARK.totp);
      expect(body).not.toContain(A.kept.token);
      expect(body).not.toMatch(/password_hash|totp_secret|token_hash|recovery|"token"|"secret"/i);
    }
  });

  it('needs the admin token and a staff member, like the rest of /internal/admin', async () => {
    const noStaff = await internal.inject({
      method: 'GET',
      url: '/internal/admin/users',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(noStaff.statusCode).toBe(400);
    for (const url of ['/internal/admin/users', `/internal/admin/users/${A.ownerId}`]) {
      const billing = await internal.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${BILLING_TOKEN}`, [STAFF_HEADER]: STAFF },
      });
      expect(billing.statusCode, url).toBe(401);
      expect((await internal.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
    // And it is not on the public listener.
    const pub = await w.app.inject({ method: 'GET', url: '/internal/admin/users' });
    expect(pub.statusCode).toBe(404);
  });
});

describe('GET /internal/admin/users/:id', () => {
  it('answers one user, their ways to sign in, and each org’s funnel steps with dates', async () => {
    const at = (days: number) => new Date(NOW - days * DAY);
    await w.owner.deleteFrom('funnel_events').where('org_id', '=', A.orgId).execute();
    await w.owner
      .insertInto('funnel_events')
      .values([
        { id: newId(), org_id: A.orgId, user_id: A.ownerId, name: 'signup_completed', ts: at(5) },
        { id: newId(), org_id: A.orgId, user_id: A.ownerId, name: 'cluster_created', ts: at(4) },
        { id: newId(), org_id: A.orgId, name: 'agent_first_heartbeat', ts: at(3) },
        // Not one of the funnel's steps: it stays out.
        { id: newId(), org_id: A.orgId, name: 'mcp_first_call', ts: at(2) },
      ])
      .execute();
    const res = await staff(`/internal/admin/users/${A.adminId}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.user).toMatchObject({
      id: A.adminId,
      email: 'admin@zzalpha.test',
      signedUpWith: 'github',
      orgs: [{ id: A.orgId, role: 'admin', plan: 'pro', source: 'staff' }],
    });
    expect(body.signIn.password).toBe(true);
    expect(body.signIn.providers).toEqual([
      { provider: 'github', linkedAt: expect.any(String), lastUsedAt: null },
    ]);
    expect(body.funnel).toHaveLength(1);
    expect(body.funnel[0].orgId).toBe(A.orgId);
    expect(body.funnel[0].steps.slice(0, 4)).toEqual([
      { name: 'signup_completed', at: at(5).toISOString() },
      { name: 'cluster_created', at: at(4).toISOString() },
      { name: 'agent_first_heartbeat', at: at(3).toISOString() },
      { name: 'first_metrics_received', at: null },
    ]);
    expect(body.funnel[0].steps.map((s: { name: string }) => s.name)).not.toContain(
      'mcp_first_call',
    );
  });

  it('answers 404 for a user that does not exist, and for anything that is not an id', async () => {
    expect((await staff(`/internal/admin/users/${newId()}`)).statusCode).toBe(404);
    expect((await staff('/internal/admin/users/not-an-id')).statusCode).toBe(404);
  });
});

describe('last sign-in', () => {
  it('is set when a full session is made, and stays after signing out', async () => {
    const before = await list(`?q=viewer@zzbeta`);
    expect(before.users[0]!.lastSignInAt).toBeNull();
    const at = new Date(NOW - 60_000);
    const { token } = await createSession(w.owner, B.viewerId, { now: at });
    expect((await list(`?q=viewer@zzbeta`)).users[0]!.lastSignInAt).toBe(at.toISOString());
    await deleteSession(w.owner, token);
    const after = (await list(`?q=viewer@zzbeta`)).users[0]!;
    expect(after.lastSignInAt).toBe(at.toISOString());
    // The step before the 2FA code is not a sign-in yet.
    await user(B.viewerId, { last_sign_in_at: null });
    await createSession(w.owner, B.viewerId, { stage: 'mfa' });
    expect((await list(`?q=viewer@zzbeta`)).users[0]!.lastSignInAt).toBeNull();
    // And they are no longer "inactive for 14 days" once they have signed in.
    await createSession(w.owner, B.viewerId, { now: new Date(NOW) });
    expect((await list('?inactiveDays=14')).users.map((u) => u.id)).toEqual([B.adminId]);
  });
});
