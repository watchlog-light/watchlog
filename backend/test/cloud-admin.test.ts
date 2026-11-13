// SPDX-License-Identifier: AGPL-3.0-only
// The funnel (funnel_events, one-time events unique in the database, day7_active) and the
// internal admin API (orgs, members, usage, entitlements by staff, suspension, the funnel
// by week), ADR-179. The app runs as in Cloud (watchlog_app under Row-Level Security).
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInternalApp } from '../src/modules/internal/app.js';
import { STAFF_HEADER } from '../src/modules/internal/admin.js';
import { recordDay7Active } from '../src/modules/funnel/day7.js';
import { FunnelRecorder, onceKey } from '../src/modules/funnel/recorder.js';
import { CLIENT_FUNNEL_EVENT_NAMES } from '../src/modules/funnel/events.js';
import { cloudWorld, seedOrg, type CloudWorld, type SeededOrg } from './isolation/cloud.js';

const TOKEN = 'a'.repeat(48);
const STAFF = 'grace@watchlog.test';
const quiet = { warn: () => {} };

let w: CloudWorld;
let A: SeededOrg;
let B: SeededOrg;
let internal: FastifyInstance;

beforeAll(async () => {
  w = await cloudWorld();
  A = await seedOrg(w, 'zzalpha');
  B = await seedOrg(w, 'zzbeta');
  internal = await buildInternalApp(
    { token: TOKEN, host: '127.0.0.1', port: 0 },
    {
      systemDb: w.owner,
      entitlements: w.app.entitlements!,
      funnel: w.app.funnel,
      logLevel: 'silent',
    },
  );
  await internal.ready();
}, 120_000);

afterAll(async () => {
  await internal?.close();
  await w?.close();
});

const staff = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  internal.inject({
    method,
    url,
    headers: { authorization: `Bearer ${TOKEN}`, [STAFF_HEADER]: STAFF },
    ...(payload ? { payload } : {}),
  });

const events = (orgId: string, name?: string) => {
  let q = w.owner.selectFrom('funnel_events').selectAll().where('org_id', '=', orgId);
  if (name) q = q.where('name', '=', name);
  return q.execute();
};

describe('the funnel (funnel_events)', () => {
  it('one-time events are unique in the database: per org, user or cluster', async () => {
    // Two recorders: two processes (or replicas) that each think the event is new.
    const one = new FunnelRecorder(w.appDb, quiet);
    const two = new FunnelRecorder(w.appDb, quiet);
    for (const r of [one, two, one]) {
      await r.record({ name: 'teammate_invited', orgId: A.orgId, userId: A.ownerId });
      await r.record({ name: 'sample_opened', orgId: A.orgId, userId: A.ownerId });
      await r.record({ name: 'sample_opened', orgId: A.orgId, userId: A.viewerId });
      await r.record({ name: 'day7_active', orgId: A.orgId, clusterId: A.k8s.id });
      await r.record({ name: 'install_command_copied', orgId: A.orgId, userId: A.ownerId });
    }
    expect(await events(A.orgId, 'teammate_invited')).toHaveLength(1);
    expect(await events(A.orgId, 'sample_opened')).toHaveLength(2);
    expect(await events(A.orgId, 'day7_active')).toHaveLength(1);
    expect(await events(A.orgId, 'install_command_copied')).toHaveLength(3);
    expect(onceKey({ name: 'pro_started', orgId: A.orgId })).toBe('');
    expect(onceKey({ name: 'cluster_created', orgId: A.orgId })).toBeNull();
    await w.owner.deleteFrom('funnel_events').where('name', '=', 'day7_active').execute();
  });

  it("writes under the event's org only (Row-Level Security)", async () => {
    const r = new FunnelRecorder(w.appDb, quiet);
    // An event naming B's org from A's request scope still lands in B's rows, never A's.
    expect(await r.record({ name: 'pro_started', orgId: B.orgId })).toBe(true);
    expect(await events(B.orgId, 'pro_started')).toHaveLength(1);
    expect(await events(A.orgId, 'pro_started')).toHaveLength(0);
  });

  it('the first heartbeat of each cluster comes from ingest, once', async () => {
    for (const [token, node, mode] of [
      [A.k8s.token, A.node, 'node'],
      [A.docker.token, A.host, 'docker'],
      [A.docker.token, A.host, 'docker'],
    ] as const) {
      const r = await w.app.inject({
        method: 'POST',
        url: '/ingest/v1/heartbeat',
        headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': node },
        payload: { node, mode, agent_version: '0.6.0', capabilities: {}, series: 1 },
      });
      expect(r.statusCode).toBe(204);
    }
    // Recorded after the answer (off the ingest path).
    await new Promise((r) => setTimeout(r, 200));
    const hb = await events(A.orgId, 'agent_first_heartbeat');
    expect(hb.map((e) => e.once_key).sort()).toEqual(
      [`cluster:${A.docker.id}`, `cluster:${A.k8s.id}`].sort(),
    );
  });

  it('POST /funnel takes only the allow-list', async () => {
    expect(CLIENT_FUNNEL_EVENT_NAMES).toEqual(
      expect.arrayContaining(['install_command_copied', 'sample_opened', 'dashboard_first_view']),
    );
    const cookie = await A.session();
    const send = (name: string) =>
      w.app.inject({
        method: 'POST',
        url: '/api/v1/funnel',
        cookies: { wl_session: cookie },
        payload: { name },
      });
    expect((await send('pro_started')).statusCode).toBe(400);
    expect((await send('signup_completed')).statusCode).toBe(400);
    expect((await send('dashboard_first_view')).statusCode).toBe(204);
    expect((await send('dashboard_first_view')).statusCode).toBe(204);
    expect(await events(A.orgId, 'dashboard_first_view')).toHaveLength(1);
  });

  it('day7_active: a cluster still sending 7 days after its first heartbeat, once', async () => {
    const now = Date.now();
    await w.owner
      .updateTable('clusters')
      .set({ first_seen_at: new Date(now - 8 * 86_400_000), last_seen_at: new Date(now - 60_000) })
      .where('id', '=', A.k8s.id)
      .execute();
    await w.owner
      .updateTable('clusters')
      .set({
        first_seen_at: new Date(now - 8 * 86_400_000),
        last_seen_at: new Date(now - 3 * 86_400_000),
      })
      .where('id', '=', A.docker.id)
      .execute();
    const funnel = new FunnelRecorder(w.appDb, quiet);
    expect(await recordDay7Active({ systemDb: w.owner, funnel }, now)).toBe(1);
    expect(
      await recordDay7Active(
        { systemDb: w.owner, funnel: new FunnelRecorder(w.appDb, quiet) },
        now,
      ),
    ).toBe(0);
    const rows = await events(A.orgId, 'day7_active');
    expect(rows.map((r) => r.once_key)).toEqual([`cluster:${A.k8s.id}`]);
    expect(rows[0]!.props).toMatchObject({ kind: 'kubernetes', days: '8' });
  });
});

describe('the internal admin API', () => {
  it('needs the staff member in X-WatchLog-Staff, besides the token', async () => {
    for (const headers of [
      { authorization: `Bearer ${TOKEN}` },
      { authorization: `Bearer ${TOKEN}`, [STAFF_HEADER]: 'not an email' },
    ]) {
      const r = await internal.inject({ method: 'GET', url: '/internal/admin/orgs', headers });
      expect(r.statusCode).toBe(400);
    }
    const r = await internal.inject({
      method: 'GET',
      url: '/internal/admin/orgs',
      headers: { [STAFF_HEADER]: STAFF },
    });
    expect(r.statusCode).toBe(401);
  });

  it('lists and searches orgs with plan, status, nodes now and last data', async () => {
    const all = await staff('GET', '/internal/admin/orgs');
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBeGreaterThanOrEqual(2);
    const found = await staff('GET', '/internal/admin/orgs?q=owner@zzbeta.test');
    expect(found.json().orgs.map((o: { id: string }) => o.id)).toEqual([B.orgId]);
    const row = found.json().orgs[0];
    expect(row).toMatchObject({
      plan: 'free',
      source: 'staff',
      status: 'active',
      clusters: 2,
      members: 2,
    });
    expect(row.nodesNow).toBeGreaterThanOrEqual(1);
    expect(row.lastDataAt).not.toBeNull();
    const byId = await staff('GET', `/internal/admin/orgs?q=${A.orgId}`);
    expect(byId.json().orgs.map((o: { id: string }) => o.id)).toEqual([A.orgId]);
  });

  it('one org: entitlements, members with their emails, clusters, usage', async () => {
    const r = await staff('GET', `/internal/admin/orgs/${A.orgId}`);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.members.map((m: { email: string }) => m.email).sort()).toEqual([
      'owner@zzalpha.test',
      'viewer@zzalpha.test',
    ]);
    expect(body.clusters).toHaveLength(2);
    expect(body.entitlements.orgId).toBe(A.orgId);
    expect(body).not.toHaveProperty('password_hash');
    expect(r.body).not.toContain('zzbeta');
    const members = await staff('GET', `/internal/admin/orgs/${A.orgId}/members`);
    expect(members.json().members).toHaveLength(2);
    const usage = await staff('GET', `/internal/admin/orgs/${A.orgId}/usage`);
    expect(usage.statusCode).toBe(200);
    expect(usage.json()).toMatchObject({ orgId: A.orgId, p95: 0 });
    expect(
      (await staff('GET', '/internal/admin/orgs/00000000-0000-4000-8000-000000000000')).statusCode,
    ).toBe(404);
  });

  it('staff set entitlements as `staff`, recorded in the org audit events, and Pro reaches the funnel', async () => {
    await w.owner.deleteFrom('funnel_events').where('name', '=', 'pro_started').execute();
    await staff('PUT', `/internal/admin/orgs/${A.orgId}/entitlements`, { plan: 'free' });
    const r = await staff('PUT', `/internal/admin/orgs/${A.orgId}/entitlements`, {
      plan: 'pro',
      nodes: 40,
      note: 'design partner',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ plan: 'pro', source: 'staff', nodes: 40 });
    // Staff can't write another source: anything else in the body is dropped.
    const extra = await staff('PUT', `/internal/admin/orgs/${A.orgId}/entitlements`, {
      plan: 'pro',
      nodes: 40,
      source: 'billing',
    });
    expect(extra.json().source).toBe('staff');
    const audit = await w.owner
      .selectFrom('audit_events')
      .select(['actor_name', 'details', 'actor_id'])
      .where('org_id', '=', A.orgId)
      .where('action', '=', 'staff_entitlements_set')
      .orderBy('at', 'desc')
      .execute();
    expect(audit).toHaveLength(3);
    const partner = audit.find((a) => (a.details as { note?: string }).note === 'design partner');
    expect(partner).toMatchObject({ actor_name: `WatchLog staff (${STAFF})`, actor_id: null });
    expect(partner!.details).toMatchObject({ plan: 'pro', planBefore: 'free' });
    expect(await events(A.orgId, 'pro_started')).toHaveLength(1);
  });

  it('suspends an org: its ingest answers 402; unsuspending lets it send again', async () => {
    const hb = () =>
      w.app.inject({
        method: 'POST',
        url: '/ingest/v1/heartbeat',
        headers: { authorization: `Bearer ${B.docker.token}`, 'x-watchlog-agent': B.host },
        payload: {
          node: B.host,
          mode: 'docker',
          agent_version: '0.6.0',
          capabilities: {},
          series: 1,
        },
      });
    expect((await hb()).statusCode).toBe(204);
    const s = await staff('POST', `/internal/admin/orgs/${B.orgId}/suspend`, {
      reason: 'abuse report',
    });
    expect(s.json()).toMatchObject({ status: 'suspended' });
    const refused = await hb();
    expect(refused.statusCode).toBe(402);
    expect(refused.json().type).toBe('urn:watchlog:problem:org-suspended');
    // Its Owner can still sign in and read.
    const me = await w.app.inject({
      method: 'GET',
      url: '/api/v1/clusters',
      cookies: { wl_session: await B.session() },
    });
    expect(me.statusCode).toBe(200);
    const list = await staff('GET', '/internal/admin/orgs?status=suspended');
    expect(list.json().orgs.map((o: { id: string }) => o.id)).toEqual([B.orgId]);
    await staff('POST', `/internal/admin/orgs/${B.orgId}/unsuspend`, { reason: 'resolved' });
    expect((await hb()).statusCode).toBe(204);
    const audit = await w.owner
      .selectFrom('audit_events')
      .select('action')
      .where('org_id', '=', B.orgId)
      .where('action', 'in', ['staff_org_suspended', 'staff_org_unsuspended'])
      .execute();
    expect(audit.map((a) => a.action).sort()).toEqual([
      'staff_org_suspended',
      'staff_org_unsuspended',
    ]);
  });

  it('the funnel by signup week, with the conversion between steps', async () => {
    const r1 = new FunnelRecorder(w.appDb, quiet);
    const now = Date.now();
    await r1.record({
      name: 'signup_completed',
      orgId: A.orgId,
      userId: A.ownerId,
      at: new Date(now),
    });
    await r1.record({
      name: 'signup_completed',
      orgId: B.orgId,
      userId: B.ownerId,
      at: new Date(now),
    });
    await r1.record({ name: 'cluster_created', orgId: A.orgId, at: new Date(now) });
    await r1.record({ name: 'cluster_created', orgId: B.orgId, at: new Date(now) });
    const r = await staff('GET', '/internal/admin/funnel?weeks=4');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.steps[0]).toBe('signup_completed');
    const week = body.weeks[0];
    const step = (n: string) => week.steps.find((s: { name: string }) => s.name === n);
    expect(step('signup_completed')).toEqual({
      name: 'signup_completed',
      orgs: 2,
      conversion: null,
    });
    expect(step('cluster_created')).toEqual({ name: 'cluster_created', orgs: 2, conversion: 1 });
    expect(step('agent_first_heartbeat')).toMatchObject({ orgs: 2, conversion: 1 });
    expect(step('pro_started').orgs).toBeGreaterThanOrEqual(1);
  });

  it('records a beta-to-billing notice request from billing (no staff header needed)', async () => {
    const r = await internal.inject({
      method: 'POST',
      url: `/internal/orgs/${A.orgId}/beta-notice`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { billingStartsAt: '2027-02-01T00:00:00Z' },
    });
    expect(r.statusCode).toBe(202);
    const row = await w.owner
      .selectFrom('beta_notices')
      .selectAll()
      .where('org_id', '=', A.orgId)
      .executeTakeFirst();
    expect(row?.billing_starts_at.toISOString()).toBe('2027-02-01T00:00:00.000Z');
  });
});
