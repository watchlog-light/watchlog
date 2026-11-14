// SPDX-License-Identifier: AGPL-3.0-only
// Plans and entitlements in Cloud (ADR-177): the defaults and the p95, the service and its
// grace, the limits (409 for clusters and invites, 402 for a new node at ingest, never for
// one already sending), the downgrade's 14 days, the usage job, the Owners' email, the
// plan route, and the merge of the two retention tiers. Scenarios 9–11 of the Cloud plan.
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { sendLimitEmails } from '../src/modules/entitlements/limit-mail.js';
import { NodeGate, isNodeAgent } from '../src/modules/entitlements/node-gate.js';
import {
  DOWNGRADE_GRACE_MS,
  daysLeft,
  defaultEntitlement,
  percentile95,
} from '../src/modules/entitlements/plans.js';
import { EntitlementsService, placementOf } from '../src/modules/entitlements/service.js';
import { hourOf, recordUsage, usageReport } from '../src/modules/entitlements/usage.js';
import { mergeSeries } from '../src/lib/victoria-tiers.js';
import { isIngestError } from '../src/modules/ingest/errors.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';
import { mailpitMessages, mailpitText, TEST_SMTP_URL } from './support/mock-providers.js';
import { encode } from './support/remote-write.js';

const CLOUD: Partial<Config> = {
  edition: 'cloud',
  cookieSecure: 'always',
  ingestUrl: 'https://ingest.watchlog.example',
};
const offline = (async () => new Response('offline', { status: 599 })) as typeof fetch;
const RUN = `entitlements-${Date.now()}`;
const silent = { warn: () => {}, info: () => {} };

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

/** A Cloud app with one signed-up Owner (Free, from signup). */
async function cloud(email = `owner-${Date.now()}@acme.example`) {
  ctx = await createTestContext(
    {
      ...CLOUD,
      accounts: {
        turnstile: {},
        supportEmail: 'support@watchlog.io',
        sampleUrl: 'https://demo.watchlog.io',
      },
    },
    { fetch: offline },
  );
  const c = ctx;
  const res = await c.app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email, password: 'a long enough password' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const cookie = res.cookies.find((x) => x.name === 'wl_session')!.value;
  const call = (method: string, url: string, payload?: object) =>
    c.app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      cookies: { wl_session: cookie },
      ...(payload ? { payload } : {}),
    });
  const orgId = (await call('GET', '/me')).json().user.org.id as string;
  return { c, call, orgId, email };
}

async function newCluster(
  call: Awaited<ReturnType<typeof cloud>>['call'],
  name: string,
  kind: 'kubernetes' | 'docker' = 'kubernetes',
) {
  const r = await call('POST', '/clusters', { name, kind });
  expect(r.statusCode, r.body).toBe(201);
  return { id: r.json().cluster.id as string, token: r.json().token.value as string };
}

const heartbeat = (c: TestContext, token: string, node: string, mode = 'node') =>
  c.app.inject({
    method: 'POST',
    url: '/ingest/v1/heartbeat',
    headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': node },
    payload: { agent_version: '0.6.0', mode, node, capabilities: {}, series: 10 },
  });

const write = (c: TestContext, token: string, agent: string) =>
  c.app.inject({
    method: 'POST',
    url: '/ingest/v1/write',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-protobuf',
      'content-encoding': 'snappy',
      'x-watchlog-agent': agent,
    },
    payload: encode([
      {
        labels: { __name__: 'watchlog_node_load1', node: agent, run: RUN },
        value: 1,
        timestampMs: Date.now() - 30_000,
      },
    ]),
  });

// ----------------------------------------------------------------------------- the plans

describe('the plans (ADR-177)', () => {
  it('bills the 95th percentile: 10 nodes most of the month and 40 for a day is 10', () => {
    const month = [...new Array<number>(696).fill(10), ...new Array<number>(24).fill(40)];
    expect(percentile95(month)).toBe(10);
    // Two busy days (48 hours of 720, 6.7 %) are more than 5 %: billed as 40.
    expect(
      percentile95([...new Array<number>(672).fill(10), ...new Array<number>(48).fill(40)]),
    ).toBe(40);
    expect(percentile95([])).toBe(0);
    expect(percentile95([3])).toBe(3);
  });

  it("gives an org without a row Free's limits, and counts days up", () => {
    expect(defaultEntitlement('o')).toMatchObject({
      plan: 'free',
      clusters: 1,
      nodes: 5,
      users: 1,
      retentionDays: 3,
      stored: false,
    });
    const now = new Date('2026-11-14T12:00:00Z');
    expect(daysLeft(new Date(now.getTime() + DOWNGRADE_GRACE_MS), now)).toBe(14);
    expect(daysLeft(new Date(now.getTime() + 3_600_000), now)).toBe(1);
    expect(daysLeft(new Date(now.getTime() - 1), now)).toBe(0);
  });

  it('reads both tiers until the old one’s retention runs out', () => {
    const at = new Date('2026-11-01T00:00:00Z');
    const pro = {
      ...defaultEntitlement('o'),
      plan: 'pro' as const,
      retentionDays: 30,
      previousRetentionDays: 3,
      retentionChangedAt: at,
    };
    expect(placementOf(pro, new Date('2026-11-02T00:00:00Z'))).toEqual({
      current: '30d',
      previous: '3d',
    });
    expect(placementOf(pro, new Date('2026-11-04T00:00:01Z'))).toEqual({
      current: '30d',
      previous: null,
    });
    const free = { ...pro, retentionDays: 3, previousRetentionDays: 30 };
    expect(placementOf(free, new Date('2026-11-30T00:00:00Z')).previous).toBe('30d');
    expect(placementOf(free, new Date('2026-12-01T00:00:01Z')).previous).toBeNull();
  });

  it('only node and Docker host agents count, and 402 is not "data delayed"', () => {
    expect(isNodeAgent('web-01')).toBe(true);
    expect(isNodeAgent('cluster-agent')).toBe(false);
    expect(isNodeAgent('integrations')).toBe(false);
    expect(isNodeAgent('integrations:db-host')).toBe(false);
    expect(isIngestError(402)).toBe(false);
    expect(isIngestError(413)).toBe(true);
  });
});

describe('configuration', () => {
  const base = {
    DATABASE_URL: 'postgres://a@h/db',
    WATCHLOG_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
  };
  const cloudEnv = {
    ...base,
    WATCHLOG_EDITION: 'cloud',
    DATABASE_URL: 'postgres://watchlog_app@h/db',
    DATABASE_SYSTEM_URL: 'postgres://owner@h/db',
    WATCHLOG_PUBLIC_URL: 'https://cloud.watchlog.example',
  };
  it('reads the internal API and the two tiers in Cloud only, both URLs or neither', () => {
    expect(() => loadConfig({ ...base, WATCHLOG_INTERNAL_TOKEN: 'x'.repeat(40) })).toThrow(
      /only read with WATCHLOG_EDITION=cloud/,
    );
    expect(() => loadConfig({ ...base, VICTORIAMETRICS_URL_3D: 'http://vm3:8428' })).toThrow(
      /only read with WATCHLOG_EDITION=cloud/,
    );
    expect(() => loadConfig({ ...cloudEnv, VICTORIAMETRICS_URL_3D: 'http://vm3:8428' })).toThrow(
      /set together/,
    );
    expect(() => loadConfig({ ...cloudEnv, WATCHLOG_INTERNAL_TOKEN: 'short' })).toThrow(
      /at least 32/,
    );
    const c = loadConfig({
      ...cloudEnv,
      WATCHLOG_INTERNAL_TOKEN: 'x'.repeat(40),
      VICTORIAMETRICS_URL_3D: 'http://vm3:8428',
      VICTORIAMETRICS_URL_30D: 'http://vm30:8428',
    });
    expect(c.internalApi).toEqual({
      token: 'x'.repeat(40),
      previousToken: undefined,
      adminToken: undefined,
      previousAdminToken: undefined,
      host: '127.0.0.1',
      port: 4082,
    });
    expect(c.victoriaMetricsTiers).toEqual({ '3d': 'http://vm3:8428', '30d': 'http://vm30:8428' });
    // SR-5: the Cloud admin's own token, never billing's, and the staff it may name.
    const withAdmin = {
      ...cloudEnv,
      WATCHLOG_INTERNAL_TOKEN: 'x'.repeat(40),
      WATCHLOG_INTERNAL_ADMIN_TOKEN: 'y'.repeat(40),
      WATCHLOG_STAFF_EMAILS: ' Grace@watchlog.io, ada@watchlog.io ',
    };
    expect(loadConfig(withAdmin).internalApi).toMatchObject({
      adminToken: 'y'.repeat(40),
      staffEmails: ['grace@watchlog.io', 'ada@watchlog.io'],
    });
    expect(() =>
      loadConfig({ ...withAdmin, WATCHLOG_INTERNAL_ADMIN_TOKEN: 'x'.repeat(40) }),
    ).toThrow(/must differ/);
    expect(() =>
      loadConfig({ ...cloudEnv, WATCHLOG_INTERNAL_ADMIN_TOKEN: 'y'.repeat(40) }),
    ).toThrow(/needs WATCHLOG_INTERNAL_TOKEN/);
    expect(() => loadConfig({ ...base, WATCHLOG_INTERNAL_ADMIN_TOKEN: 'y'.repeat(40) })).toThrow(
      /only read with WATCHLOG_EDITION=cloud/,
    );
    // Community: unchanged, none of it.
    const community = loadConfig(base);
    expect(community.internalApi).toBeUndefined();
    expect(community.victoriaMetricsTiers).toBeUndefined();
  });
});

describe('merging the two tiers', () => {
  it('merges series by labels; the current tier’s point wins, the old one fills gaps', () => {
    const merged = mergeSeries(
      [
        {
          labels: { node: 'a', __name__: 'x' },
          points: [
            [30, 3],
            [40, 4],
            [50, null],
          ],
        },
        { labels: { node: 'c' }, points: [[40, 9]] },
      ],
      [
        {
          labels: { __name__: 'x', node: 'a' },
          points: [
            [10, 1],
            [20, 2],
            [30, 99],
            [50, 5],
          ],
        },
        { labels: { node: 'b' }, points: [[10, 7]] },
      ],
    );
    const by = Object.fromEntries(merged.map((s) => [s.labels.node, s.points]));
    expect(by.a).toEqual([
      [10, 1],
      [20, 2],
      [30, 3],
      [40, 4],
      [50, 5],
    ]);
    expect(by.b).toEqual([[10, 7]]);
    expect(by.c).toEqual([[40, 9]]);
    expect(merged).toHaveLength(3);
  });
});

// ------------------------------------------------------------------------- the service

describe('the entitlements service', () => {
  it('starts the 14-day grace on a downgrade, keeps it, ends it on an upgrade; records the tier', async () => {
    const { c, orgId } = await cloud();
    let now = Date.parse('2026-11-01T00:00:00Z');
    const svc = new EntitlementsService(c.db, () => now);
    const pro = await svc.put(orgId, { plan: 'pro', source: 'beta' });
    expect(pro).toMatchObject({ plan: 'pro', nodes: null, users: 10, retentionDays: 30 });
    expect(pro.graceUntil).toBeNull();
    expect(pro.previousRetentionDays).toBe(3);
    expect(
      (await c.db.selectFrom('orgs').select('plan').where('id', '=', orgId).executeTakeFirst())
        ?.plan,
    ).toBe('pro');
    now += 86_400_000;
    const free = await svc.put(orgId, { plan: 'free', source: 'billing' });
    expect(free.graceUntil?.toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(free.previousRetentionDays).toBe(30);
    expect(free.retentionChangedAt?.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    now += 86_400_000;
    // Another lower change during the grace keeps its end.
    const lower = await svc.put(orgId, { plan: 'free', source: 'staff', nodes: 3 });
    expect(lower.graceUntil?.toISOString()).toBe('2026-11-16T00:00:00.000Z');
    const up = await svc.put(orgId, { plan: 'pro', source: 'beta' });
    expect(up.graceUntil).toBeNull();
  });

  it('caches for 60 seconds; a change in this process is seen at once', async () => {
    const { c, orgId } = await cloud();
    let now = 0;
    const svc = new EntitlementsService(c.db, () => now);
    expect((await svc.get(orgId)).plan).toBe('free');
    await c.db
      .updateTable('entitlements')
      .set({ plan: 'pro' })
      .where('org_id', '=', orgId)
      .execute();
    expect((await svc.get(orgId)).plan).toBe('free');
    now = 60_001;
    expect((await svc.get(orgId)).plan).toBe('pro');
    await svc.put(orgId, { plan: 'free', source: 'staff' });
    expect((await svc.get(orgId)).plan).toBe('free');
  });
});

// --------------------------------------------------------------------------- the limits

describe('limits (scenarios 9 and 10)', () => {
  it('scenario 10: a second cluster on Free answers 409 plan-limit with the way out', async () => {
    const { c, call, orgId } = await cloud();
    await newCluster(call, 'prod');
    const second = await call('POST', '/clusters', { name: 'fleet', kind: 'docker' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      type: 'urn:watchlog:problem:plan-limit',
      code: 'plan-limit',
      limit: 'clusters',
      max: 1,
    });
    expect(second.json().detail).toContain('/settings?tab=billing');
    const hits = await c.db
      .selectFrom('plan_limit_hits')
      .selectAll()
      .where('org_id', '=', orgId)
      .execute();
    expect(hits.map((h) => h.kind)).toEqual(['clusters']);
    // Pro: unlimited.
    await c.app.entitlements!.put(orgId, { plan: 'pro', source: 'beta' });
    expect((await call('POST', '/clusters', { name: 'fleet', kind: 'docker' })).statusCode).toBe(
      201,
    );
  });

  it('invites count members and open invites against the plan’s users', async () => {
    const { c, call, orgId } = await cloud();
    const free = await call('POST', '/users/invites', { email: 'a@x.example', role: 'viewer' });
    expect(free.statusCode).toBe(409);
    expect(free.json()).toMatchObject({ code: 'plan-limit', limit: 'users', max: 1 });
    await c.app.entitlements!.put(orgId, { plan: 'pro', source: 'beta', users: 3 });
    expect(
      (await call('POST', '/users/invites', { email: 'a@x.example', role: 'viewer' })).statusCode,
    ).toBe(201);
    expect(
      (await call('POST', '/users/invites', { email: 'b@x.example', role: 'viewer' })).statusCode,
    ).toBe(201);
    const third = await call('POST', '/users/invites', { email: 'c@x.example', role: 'viewer' });
    expect(third.statusCode).toBe(409);
    expect(third.json().max).toBe(3);
  });

  it('scenario 9: the 6th node gets 402, the other five keep sending; banner and one Owner email', async () => {
    const { c, call, orgId, email } = await cloud();
    const k = await newCluster(call, 'prod');
    for (const n of ['n1', 'n2', 'n3', 'n4', 'n5']) {
      expect((await heartbeat(c, k.token, n)).statusCode).toBe(204);
      expect((await write(c, k.token, n)).statusCode).toBe(204);
    }
    // The cluster-agent and integrations collectors aren't nodes.
    expect((await heartbeat(c, k.token, 'cluster-agent', 'cluster')).statusCode).toBe(204);
    expect((await write(c, k.token, 'integrations:db')).statusCode).toBe(204);
    const sixth = await heartbeat(c, k.token, 'n6');
    expect(sixth.statusCode).toBe(402);
    expect(sixth.json()).toMatchObject({ code: 'plan-limit', limit: 'nodes' });
    expect((await write(c, k.token, 'n6')).statusCode).toBe(402);
    for (const n of ['n1', 'n2', 'n3', 'n4', 'n5']) {
      expect((await write(c, k.token, n)).statusCode).toBe(204);
      expect((await heartbeat(c, k.token, n)).statusCode).toBe(204);
    }
    // n6 was never registered; nothing reads as "data delayed".
    const agents = await c.db
      .selectFrom('agent_instances')
      .select('node')
      .where('mode', '=', 'node')
      .execute();
    expect(agents.map((a) => a.node).sort()).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(await c.db.selectFrom('ingest_errors').selectAll().execute()).toEqual([]);
    await new Promise((r) => setTimeout(r, 50)); // the hit is recorded off the request
    const plan = (await call('GET', '/plan')).json();
    expect(plan).toMatchObject({
      plan: 'free',
      limits: { clusters: 1, nodes: 5, users: 1, retentionDays: 3 },
      usage: { clusters: 1, nodes: 5, kubernetesNodes: 5, dockerHosts: 0, users: 1 },
      refusedNodes: 1,
      downgrade: null,
    });
    // One email to the Owners per limit and day.
    const deps = {
      systemDb: c.db,
      settings: async () => ({
        smtp: { transport: TEST_SMTP_URL, from: 'WatchLog <cloud@watchlog.test>' },
        publicUrl: 'https://cloud.watchlog.example',
      }),
      log: silent,
    };
    expect(await sendLimitEmails(deps, Date.now())).toBe(1);
    expect(await sendLimitEmails(deps, Date.now())).toBe(0);
    const mails = await mailpitMessages(email);
    const limitMail = mails.find((m) => m.Subject.includes('node limit'))!;
    expect(limitMail).toBeDefined();
    const text = await mailpitText(limitMail.ID);
    expect(text).toContain('A new node tried to send data');
    expect(text).toContain('https://cloud.watchlog.example/settings?tab=billing');
    expect(
      await c.db
        .selectFrom('plan_limit_emails')
        .select('kind')
        .where('org_id', '=', orgId)
        .execute(),
    ).toEqual([{ kind: 'nodes' }]);
  });

  it('Pro has no node limit; a Docker host counts as a node', async () => {
    const { c, call, orgId } = await cloud();
    await c.app.entitlements!.put(orgId, { plan: 'pro', source: 'beta' });
    const d = await newCluster(call, 'fleet', 'docker');
    for (let i = 0; i < 8; i++) {
      expect((await heartbeat(c, d.token, `host-${i}`, 'docker')).statusCode).toBe(204);
    }
    expect((await call('GET', '/plan')).json().usage).toMatchObject({ nodes: 8, dockerHosts: 8 });
  });

  it('Community: no gate, no row, no plan route', async () => {
    ctx = await createTestContext();
    expect(ctx.app.entitlements).toBeNull();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/plan' })).statusCode).toBe(404);
  });
});

// ------------------------------------------------------------- the downgrade (scenario 11)

describe('scenario 11: Pro → Free with 8 nodes', () => {
  it('all 8 keep sending for 14 days, then the 3 newest get 402', async () => {
    const { c, call, orgId } = await cloud();
    await c.app.entitlements!.put(orgId, { plan: 'pro', source: 'beta' });
    const k = await newCluster(call, 'prod');
    const nodes = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
    for (const n of nodes) expect((await heartbeat(c, k.token, n)).statusCode).toBe(204);
    // First seen one minute apart: a8 is the newest.
    for (const [i, n] of nodes.entries()) {
      await c.db
        .updateTable('agent_instances')
        .set({ created_at: new Date(Date.now() - (60 - i) * 60_000) })
        .where('node', '=', n)
        .execute();
    }
    let now = Date.now();
    const svc = new EntitlementsService(c.db, () => now);
    const gate = new NodeGate(c.db, svc, silent, () => now);
    // Staff's (a billed source would ask the Owner for 2FA first, ADR-175).
    const free = await svc.put(orgId, { plan: 'free', source: 'staff' });
    expect(free.graceUntil!.getTime()).toBe(now + DOWNGRADE_GRACE_MS);
    for (const n of nodes) expect(await gate.admit(orgId, k.id, n), n).toBe(true);
    // A ninth, new node is over the plan already.
    expect(await gate.admit(orgId, k.id, 'a9')).toBe(false);
    // The banner counts the days.
    await c.app.entitlements!.invalidate(orgId);
    const duringRes = await call('GET', '/plan');
    expect(duringRes.statusCode, duringRes.body).toBe(200);
    const during = duringRes.json();
    expect(during.downgrade).toMatchObject({ daysLeft: 14, ended: false, nodesOver: 3 });
    // 14 days later (their heartbeats kept them seen): the newest three get 402.
    now += DOWNGRADE_GRACE_MS + 1;
    await c.db
      .updateTable('agent_instances')
      .set({ last_seen_at: new Date(now - 10_000) })
      .execute();
    gate.forget(orgId);
    svc.invalidate(orgId);
    const allowed = [];
    for (const n of nodes) if (await gate.admit(orgId, k.id, n)) allowed.push(n);
    expect(allowed).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });
});

// --------------------------------------------------------------------- the hot path

describe('the node gate on the ingest hot path', () => {
  it('reads PostgreSQL once per org and minute, not per write; measured', async () => {
    const { c, call, orgId } = await cloud();
    const k = await newCluster(call, 'prod');
    for (const n of ['n1', 'n2', 'n3']) await heartbeat(c, k.token, n);
    let now = Date.now();
    const gate = new NodeGate(c.db, new EntitlementsService(c.db, () => now), silent, () => now);
    expect(await gate.admit(orgId, k.id, 'n1')).toBe(true);
    expect(gate.loads).toBe(1);
    const N = 200_000;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) await gate.admit(orgId, k.id, `n${(i % 3) + 1}`);
    const ns = Number(process.hrtime.bigint() - t0) / N;
    expect(gate.loads).toBe(1);
    console.log(`node gate: ${ns.toFixed(0)} ns per check (${N} checks, 1 PostgreSQL read)`);
    expect(ns).toBeLessThan(20_000);
    // After a minute the set is refreshed in the background; the write doesn't wait.
    now += 61_000;
    expect(await gate.admit(orgId, k.id, 'n1')).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(gate.loads).toBe(2);
  });
});

// ---------------------------------------------------------------------- the usage job

describe('usage_hourly and the 95th percentile', () => {
  it('counts distinct sending nodes and Docker hosts per org and hour, keeping the highest', async () => {
    const { c, call, orgId } = await cloud();
    await c.app.entitlements!.put(orgId, { plan: 'pro', source: 'beta' });
    const k = await newCluster(call, 'prod');
    const d = await newCluster(call, 'fleet', 'docker');
    for (const n of ['n1', 'n2', 'n3']) await heartbeat(c, k.token, n);
    await heartbeat(c, d.token, 'h1', 'docker');
    await heartbeat(c, k.token, 'cluster-agent', 'cluster');
    const now = Date.now();
    expect(await recordUsage({ systemDb: c.db, db: c.db }, now)).toBe(1);
    // An agent that stopped keeps its count for the hour; a run with fewer doesn't lower it.
    await c.db
      .updateTable('agent_instances')
      .set({ last_seen_at: new Date(hourOf(now).getTime() - 1) })
      .where('node', '=', 'n3')
      .execute();
    await recordUsage({ systemDb: c.db, db: c.db }, now);
    const rows = await c.db
      .selectFrom('usage_hourly')
      .selectAll()
      .where('org_id', '=', orgId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nodes: 3, docker_hosts: 1 });
    expect(new Date(rows[0]!.hour).getTime()).toBe(hourOf(now).getTime());
  });

  it('reports the hours and the p95, with hours without a row as 0', async () => {
    const { c, orgId } = await cloud();
    const from = new Date('2026-11-01T00:00:00Z');
    const rows = [];
    for (let h = 0; h < 100; h++) {
      rows.push({
        org_id: orgId,
        hour: new Date(from.getTime() + h * 3_600_000),
        nodes: h < 96 ? 10 : 40,
        docker_hosts: 2,
      });
    }
    await c.db.insertInto('usage_hourly').values(rows).execute();
    const to = new Date('2026-12-01T00:00:00Z');
    // 100 recorded hours, 720 in the month (all past): 620 zeros pull the p95 down.
    const month = await usageReport(c.db, orgId, from, to, Date.parse('2026-12-05T00:00:00Z'));
    expect(month).toMatchObject({ hoursInPeriod: 720, peak: 42, p95: 12 });
    expect(month.hours).toHaveLength(100);
    expect(month.hours[0]).toEqual({
      hour: from.toISOString(),
      nodes: 10,
      dockerHosts: 2,
      total: 12,
    });
    // So far, 100 hours into the period: 4 busy hours of 100 stay under 5 %.
    const soFar = await usageReport(c.db, orgId, from, to, Date.parse('2026-11-05T03:30:00Z'));
    expect(soFar).toMatchObject({ hoursInPeriod: 100, p95: 12, peak: 42 });
  });
});
