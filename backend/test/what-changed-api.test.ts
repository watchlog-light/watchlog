// SPDX-License-Identifier: AGPL-3.0-only
// GET /api/v1/what-changed (ADR-199, ADR-202; v0.8 slice 3): the What changed page's and the
// alert card's read, for a Kubernetes cluster and a Docker fleet. Unusual periods are written
// as the anomaly-worker writes them; the clock is injected. The gate (Pro 200, Free 403
// `pro-feature`, Community 404), the windows and their bounds (24 hours, 50 rows), the demo's
// 24-hour cap, the learning state and the probable cause's subject. Cloud's org scoping under
// RLS is the isolation suite's (test/isolation/cross-org.test.ts, "what changed").
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { withOrg } from '../src/db/org-context.js';
import { newId } from '../src/lib/ids.js';
import { DEMO_RANGE_MESSAGE } from '../src/plugins/demo.js';
import { ensureDefaultRules } from '../src/modules/alerts/rules.js';
import { CausesService } from '../src/modules/causes/likely.js';
import type { CausesAnswer } from '../src/modules/causes/engine.js';
import type { Subject } from '../src/modules/causes/subject.js';
import { insertCluster } from '../src/modules/clusters/service.js';
import { ensureDemoUser } from '../src/modules/demo/service.js';
import { seriesHash } from '../src/modules/anomaly/keys.js';
import {
  alertWindow,
  chartCounts,
  chartRange,
  objectOf,
  WHAT_CHANGED_MAX_ROWS,
} from '../src/modules/anomaly/read.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The injected clock: a whole minute. */
const NOW = Math.floor(Date.now() / MIN) * MIN;
const nowS = Math.floor(NOW / 1000);

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

/** Probable cause, faked: every subject asked is recorded, and its answer is likely. */
function fakeCauses() {
  const asked: Subject[] = [];
  const causes = new CausesService({
    explainFn: async (_reader, _cluster, subject) => {
      asked.push(subject);
      return {
        subject: { kind: subject.kind, ref: 'x', name: 'x' },
        state: 'likely',
        headline: { code: 'connections_held', facts: { holder: 'reports-worker' } },
        causes: [
          { strength: 'likely', rule: 'connections_held', code: 'held', facts: {}, since: null },
        ],
        checks: [],
      } as unknown as CausesAnswer;
    },
  });
  return { causes, asked };
}

const CLOUD: Partial<Config> = {
  edition: 'cloud',
  cookieSecure: 'always',
  accounts: { turnstile: {}, supportEmail: 'support@watchlog.io', sampleUrl: 'https://x' },
};
const offline = (async () => new Response('offline', { status: 599 })) as typeof fetch;

/** A Cloud org signed up through the API (Free), made Pro unless `free`. */
async function cloudOrg(free = false) {
  const f = fakeCauses();
  ctx = await createTestContext(CLOUD, { fetch: offline, now: () => NOW, causes: f.causes });
  const c = ctx;
  const res = await c.app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email: `owner-${newId()}@acme.example`, password: 'a long enough password' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const cookie = res.cookies.find((x) => x.name === 'wl_session')!.value;
  const me = await c.app.inject({
    method: 'GET',
    url: '/api/v1/me',
    cookies: { wl_session: cookie },
  });
  const orgId = me.json().user.org.id as string;
  if (!free) await c.app.entitlements!.put(orgId, { plan: 'pro', source: 'staff' });
  return { c, cookie, orgId, asked: f.asked };
}

const get = (c: TestContext, cookie: string, query: Record<string, string>) =>
  c.app.inject({
    method: 'GET',
    url: '/api/v1/what-changed',
    query,
    cookies: { wl_session: cookie },
  });

/** The org's learning started 10 days ago, and the cluster's first series 9 days ago. */
async function learned(c: TestContext, orgId: string, clusterId: string, sinceMs = NOW - 10 * DAY) {
  await c.db
    .insertInto('anomaly_orgs')
    .values({ org_id: orgId, learning_since: new Date(sinceMs), entitled_at: new Date(NOW) })
    .onConflict((oc) => oc.column('org_id').doNothing())
    .execute();
  await c.db
    .insertInto('anomaly_baselines')
    .values({
      org_id: orgId,
      cluster_id: clusterId,
      series_hash: seriesHash('learned', { cluster: clusterId }),
      metric: 'workload.cpu.usage',
      subject: JSON.stringify({ workload: 'x' }),
      medians: Array(168).fill(1),
      mads: Array(168).fill(0.1),
      minutes: Array(168).fill(120),
      first_seen: new Date(Math.max(sinceMs, NOW - 9 * DAY)),
      last_seen: new Date(NOW),
    })
    .execute();
}

interface P {
  metric: string;
  subject: Record<string, string>;
  startedAgo: number;
  endedAgo?: number;
  peak: number;
  usual: [number, number];
  last: number;
  peakValue?: number;
}

async function period(c: TestContext, orgId: string, clusterId: string, p: P) {
  await c.db
    .insertInto('anomaly_periods')
    .values({
      org_id: orgId,
      cluster_id: clusterId,
      series_hash: seriesHash(p.metric, p.subject),
      metric: p.metric,
      subject: JSON.stringify(p.subject),
      started_at: new Date(NOW - p.startedAgo),
      ended_at: p.endedAgo === undefined ? null : new Date(NOW - p.endedAgo),
      bucket: 0,
      median: (p.usual[0] + p.usual[1]) / 2,
      usual_low: p.usual[0],
      usual_high: p.usual[1],
      peak_score: p.peak,
      peak_value: p.peakValue ?? p.last * 2,
      peak_at: new Date(NOW - p.startedAgo + 2 * MIN),
      last_value: p.last,
      last_at: new Date(NOW - MIN),
    })
    .execute();
}

const K8S: P[] = [
  {
    metric: 'edge.connections.rate',
    subject: {
      namespace: 'shop',
      workload_kind: 'Deployment',
      workload: 'reports-worker',
      dst_kind: 'workload',
      dst_namespace: 'shop',
      dst_workload_kind: 'StatefulSet',
      dst_workload: 'postgres',
    },
    startedAgo: 30 * MIN,
    peak: 40,
    usual: [0, 2],
    last: 85,
  },
  {
    metric: 'workload.http.latency.p95',
    subject: {
      dst_kind: 'workload',
      dst_namespace: 'shop',
      dst_workload_kind: 'Deployment',
      dst_workload: 'checkout',
    },
    startedAgo: 28 * MIN,
    peak: 90,
    usual: [0.12, 0.18],
    last: 2.4,
  },
  {
    metric: 'node.cpu.utilization',
    subject: { node: 'kind-worker' },
    startedAgo: 20 * MIN,
    endedAgo: 5 * MIN,
    peak: 6,
    usual: [0.2, 0.4],
    last: 0.5,
    peakValue: 0.71,
  },
];
const DOCKER: P[] = [
  {
    metric: 'container.memory.working_set',
    subject: { host: 'docker-01', container: 'shop-api-1' },
    startedAgo: 40 * MIN,
    peak: 12,
    usual: [200e6, 260e6],
    last: 900e6,
  },
  {
    metric: 'workload.http.errors.ratio',
    subject: { dst_kind: 'container', dst: 'shop-web-1' },
    startedAgo: 35 * MIN,
    peak: 30,
    usual: [0, 0.01],
    last: 0.4,
  },
  {
    metric: 'host.cpu.utilization',
    subject: { host: 'docker-01' },
    startedAgo: 33 * MIN,
    peak: 5,
    usual: [0.1, 0.3],
    last: 0.6,
  },
];

/** The Compose project and service of the fleet's containers, as the container list has them. */
async function containers(c: TestContext, orgId: string, clusterId: string) {
  for (const [name, service] of [
    ['shop-api-1', 'api'],
    ['shop-web-1', 'web'],
  ] as const) {
    await c.db
      .insertInto('objects')
      .values({
        id: newId(),
        org_id: orgId,
        cluster_id: clusterId,
        source: 'docker',
        kind: 'DockerContainer',
        namespace: 'shop',
        name,
        uid: newId(),
        spec_summary: JSON.stringify({ compose_service: service }),
        status_summary: JSON.stringify({}),
      })
      .execute();
  }
}

describe('the pure parts', () => {
  it('around an alert: 60 minutes before to 15 after, or now; the chart adds an hour before', () => {
    const start = NOW - 10 * MIN;
    expect(alertWindow(start, NOW)).toEqual({ fromMs: start - HOUR, toMs: NOW });
    const old = NOW - 5 * HOUR;
    const w = alertWindow(old, NOW);
    expect(w).toEqual({ fromMs: old - HOUR, toMs: old + 15 * MIN });
    const r = chartRange(w, true);
    expect(r.fromMs).toBe(old - 2 * HOUR);
    expect(r.stepS).toBe(60);
    // The demo cuts it at its 24 hours.
    expect(alertWindow(NOW - 30 * HOUR, NOW, NOW - DAY).fromMs).toBe(NOW - DAY);
  });

  it('the chart counts each period in every step it overlaps, open ones until now', () => {
    const range = { fromMs: NOW - 10 * MIN, toMs: NOW, stepS: 60 };
    const counts = chartCounts(
      [
        { started_at: new Date(NOW - 5 * MIN), ended_at: null },
        { started_at: new Date(NOW - 8 * MIN), ended_at: new Date(NOW - 6 * MIN) },
      ],
      range,
      NOW,
    );
    expect(counts).toEqual([0, 0, 1, 1, 0, 1, 1, 1, 1, 1]);
    // A 24-hour window has at most 360 points.
    const day = chartRange({ fromMs: NOW - DAY, toMs: NOW }, false);
    expect(day.stepS).toBe(240);
  });

  it('names rows in each platform’s words', () => {
    expect(objectOf('edge.connections.rate', K8S[0]!.subject)).toEqual({
      object: {
        kind: 'workload',
        name: 'reports-worker',
        namespace: 'shop',
        workloadKind: 'Deployment',
      },
      peer: 'postgres',
    });
    expect(objectOf('node.cpu.utilization', { node: 'n1' }).object).toEqual({
      kind: 'node',
      name: 'n1',
    });
    const compose = new Map([['shop-web-1', { project: 'shop', service: 'web' }]]);
    expect(objectOf('workload.http.errors.ratio', DOCKER[1]!.subject, compose).object).toEqual({
      kind: 'container',
      name: 'shop-web-1',
      composeProject: 'shop',
      composeService: 'web',
    });
    // A Docker edge's destination container reads as its Compose service.
    expect(
      objectOf(
        'edge.connections.rate',
        {
          container: 'shop-api-1',
          compose_project: 'shop',
          compose_service: 'api',
          dst_kind: 'container',
          dst: 'shop-web-1',
        },
        compose,
      ),
    ).toEqual({
      object: {
        kind: 'container',
        name: 'shop-api-1',
        composeProject: 'shop',
        composeService: 'api',
      },
      peer: 'web',
    });
    expect(objectOf('host.disk.io', { host: 'h1' }).object).toEqual({ kind: 'host', name: 'h1' });
    expect(objectOf('redis.ops.rate', { service: 'cache', service_type: 'redis' }).object).toEqual({
      kind: 'service',
      name: 'cache',
    });
  });
});

describe('GET /what-changed on a Pro org', () => {
  it('Kubernetes: the last hour, first to move and furthest out, the chart, the cause', async () => {
    const { c, cookie, orgId, asked } = await cloudOrg();
    const k8s = await insertCluster(c.db, orgId, 'acme-prod', 'kubernetes');
    await learned(c, orgId, k8s.id);
    for (const p of K8S) await period(c, orgId, k8s.id, p);
    // Before the window: not a row, but on no chart either (the last hour has no context).
    await period(c, orgId, k8s.id, {
      ...K8S[1]!,
      metric: 'workload.cpu.usage',
      subject: { namespace: 'shop', workload_kind: 'Deployment', workload: 'api' },
      startedAgo: 3 * HOUR,
      endedAgo: 2 * HOUR,
    });

    const res = await get(c, cookie, { cluster: k8s.id });
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json();
    expect(a.cluster).toEqual({ id: k8s.id, name: 'acme-prod', kind: 'kubernetes' });
    expect(a.window).toEqual({
      from: new Date(NOW - HOUR).toISOString(),
      to: new Date(NOW).toISOString(),
      alert: null,
    });
    expect(a.learning.learning).toBe(false);
    expect(a.rows.map((r: { key: string }) => r.key)).toEqual([
      'edge.connections.rate',
      'workload.http.latency.p95',
      'node.cpu.utilization',
    ]);
    const [edge, p95, node] = a.rows;
    expect(edge).toMatchObject({
      object: { kind: 'workload', name: 'reports-worker' },
      peer: 'postgres',
      usualLow: 0,
      usualHigh: 2,
      value: 85,
      until: null,
      unit: 'per_second',
    });
    expect(p95).toMatchObject({
      object: { kind: 'workload', name: 'checkout', namespace: 'shop' },
      unit: 'seconds',
      value: 2.4,
    });
    // Ended: the furthest value, and its end.
    expect(node).toMatchObject({
      object: { kind: 'node', name: 'kind-worker' },
      value: 0.71,
      until: new Date(NOW - 5 * MIN).toISOString(),
    });
    expect(a.total).toBe(3);
    expect(a.truncated).toBe(false);
    // The chart: one point a minute over the hour; three unusual 20 to 5 minutes ago.
    expect(a.chart.step).toBe(60);
    expect(a.chart.counts).toHaveLength(60);
    expect(a.chart.counts[45]).toBe(3);
    expect(a.chart.counts[59]).toBe(2);
    expect(a.chart.counts[0]).toBe(0);
    // The cause: the first row probable cause can explain, the source workload.
    expect(a.cause.subject).toBe('workload:shop/Deployment/reports-worker');
    expect(a.cause.likely).toMatchObject({ rule: 'connections_held' });
    expect(asked).toEqual([
      { kind: 'workload', namespace: 'shop', workloadKind: 'Deployment', name: 'reports-worker' },
    ]);

    const far = (await get(c, cookie, { cluster: k8s.id, sort: 'furthest' })).json();
    expect(far.sort).toBe('furthest');
    expect(far.rows.map((r: { peakScore: number }) => r.peakScore)).toEqual([90, 40, 6]);
    // The cause stays the first to move, whatever the order.
    expect(far.cause.subject).toBe('workload:shop/Deployment/reports-worker');
  });

  it('Docker: containers with their Compose service, hosts, the cause on the container', async () => {
    const { c, cookie, orgId } = await cloudOrg();
    const fleet = await insertCluster(c.db, orgId, 'acme-hosts', 'docker');
    await learned(c, orgId, fleet.id);
    await containers(c, orgId, fleet.id);
    for (const p of DOCKER) await period(c, orgId, fleet.id, p);
    const a = (await get(c, cookie, { cluster: fleet.id })).json();
    expect(a.cluster.kind).toBe('docker');
    expect(a.rows.map((r: { object: object }) => r.object)).toEqual([
      {
        kind: 'container',
        name: 'shop-api-1',
        host: 'docker-01',
        composeProject: 'shop',
        composeService: 'api',
      },
      { kind: 'container', name: 'shop-web-1', composeProject: 'shop', composeService: 'web' },
      { kind: 'host', name: 'docker-01' },
    ]);
    expect(a.rows[0].unit).toBe('bytes');
    expect(a.cause.subject).toBe('container:docker-01/shop-api-1');
  });

  it('around an alert: its window, the chart an hour wider, the cause the alert’s own', async () => {
    const { c, cookie, orgId, asked } = await cloudOrg();
    const k8s = await insertCluster(c.db, orgId, 'acme-prod', 'kubernetes');
    await learned(c, orgId, k8s.id);
    for (const p of K8S) await period(c, orgId, k8s.id, p);
    await withOrg(orgId, () => ensureDefaultRules(c.db, orgId));
    const rule = await c.db
      .selectFrom('alert_rules')
      .select('id')
      .where('org_id', '=', orgId)
      .where('rule_key', '=', 'k8s.pod.crashloop')
      .executeTakeFirstOrThrow();
    const alertId = newId();
    await c.db
      .insertInto('alert_states')
      .values({
        id: alertId,
        org_id: orgId,
        rule_id: rule.id,
        cluster_id: k8s.id,
        fingerprint: 'fp',
        state: 'firing',
        severity: 'warning',
        labels: JSON.stringify({ namespace: 'shop', workload: 'checkout' }),
        details: JSON.stringify({}),
        started_at: new Date(NOW - 26 * MIN),
        fired_at: new Date(NOW - 25 * MIN),
      })
      .execute();
    const a = (await get(c, cookie, { cluster: k8s.id, alert: alertId })).json();
    expect(a.window).toEqual({
      from: new Date(NOW - 86 * MIN).toISOString(),
      to: new Date(NOW - 11 * MIN).toISOString(),
      alert: { id: alertId, startedAt: new Date(NOW - 26 * MIN).toISOString() },
    });
    expect(a.chart.from).toBe(new Date(NOW - 146 * MIN).toISOString());
    expect(a.rows).toHaveLength(3);
    expect(a.cause.subject).toBe(`alert:${alertId}`);
    expect(asked).toEqual([{ kind: 'alert', id: alertId }]);
    // Another cluster's alert, an unknown alert, and alert with a range: refused.
    const other = await insertCluster(c.db, orgId, 'other', 'kubernetes');
    expect((await get(c, cookie, { cluster: other.id, alert: alertId })).statusCode).toBe(404);
    expect((await get(c, cookie, { cluster: k8s.id, alert: newId() })).statusCode).toBe(404);
    expect(
      (await get(c, cookie, { cluster: k8s.id, alert: alertId, from: String(nowS - 60) }))
        .statusCode,
    ).toBe(400);
  });

  it('bounds: 24 hours at most, `from` before `to`, no future; at most 50 rows with the total', async () => {
    const { c, cookie, orgId } = await cloudOrg();
    const k8s = await insertCluster(c.db, orgId, 'acme-prod', 'kubernetes');
    await learned(c, orgId, k8s.id);
    for (let i = 0; i < 55; i++) {
      await period(c, orgId, k8s.id, {
        metric: 'workload.cpu.usage',
        subject: { namespace: 'shop', workload_kind: 'Deployment', workload: `w-${i}` },
        startedAgo: (50 - (i % 50)) * MIN,
        peak: 5 + i,
        usual: [0.1, 0.2],
        last: 1,
      });
    }
    const a = (await get(c, cookie, { cluster: k8s.id })).json();
    expect(a.rows).toHaveLength(WHAT_CHANGED_MAX_ROWS);
    expect(a.total).toBe(55);
    expect(a.truncated).toBe(true);
    const day = await get(c, cookie, {
      cluster: k8s.id,
      from: String(nowS - 86_400),
      to: String(nowS),
    });
    expect(day.statusCode).toBe(200);
    expect(day.json().chart.counts.length).toBeLessThanOrEqual(360);
    const detail = async (q: Record<string, string>) => {
      const r = await get(c, cookie, { cluster: k8s.id, ...q });
      expect(r.statusCode).toBe(400);
      return r.json().detail;
    };
    expect(await detail({ from: String(nowS - 86_401), to: String(nowS) })).toBe(
      'The window is at most 24 hours',
    );
    expect(await detail({ from: String(nowS), to: String(nowS - 60) })).toBe(
      '`from` must be before `to`',
    );
    expect(await detail({ from: String(nowS), to: String(nowS + 3600) })).toBe(
      '`to` is in the future',
    );
    expect((await get(c, cookie, { cluster: k8s.id, sort: 'nope' })).statusCode).toBe(400);
    expect((await get(c, cookie, { cluster: newId() })).statusCode).toBe(404);
  });

  it('learning (ADR-204): nothing listed for 7 days from the upgrade, with its end; a Viewer reads it', async () => {
    const { c, cookie, orgId } = await cloudOrg();
    const k8s = await insertCluster(c.db, orgId, 'acme-prod', 'kubernetes');
    // Not seen by the worker yet.
    let a = (await get(c, cookie, { cluster: k8s.id })).json();
    expect(a.learning).toEqual({ learning: true, since: null, until: null });
    const since = NOW - 2 * DAY;
    await learned(c, orgId, k8s.id, since);
    for (const p of K8S) await period(c, orgId, k8s.id, p);
    a = (await get(c, cookie, { cluster: k8s.id })).json();
    expect(a.learning).toEqual({
      learning: true,
      since: new Date(since).toISOString(),
      until: new Date(since + 7 * DAY).toISOString(),
    });
    expect(a.rows).toEqual([]);
    expect(a.chart.counts.every((n: number) => n === 0)).toBe(true);
    expect(a.cause.subject).toBeNull();

    const { createSession } = await import('../src/modules/auth/sessions.js');
    const viewerId = newId();
    await c.db
      .insertInto('users')
      .values({ id: viewerId, email: `${viewerId}@x.test`, name: 'V', password_hash: 'x' })
      .execute();
    await c.db
      .insertInto('memberships')
      .values({ id: newId(), org_id: orgId, user_id: viewerId, role: 'viewer' })
      .execute();
    const viewer = (await createSession(c.db, viewerId)).token;
    expect((await get(c, viewer, { cluster: k8s.id })).statusCode).toBe(200);
  });
});

describe('the gate (ADR-195, ADR-202)', () => {
  it('Cloud Free: 403 pro-feature, on both kinds of cluster, before anything is read', async () => {
    const { c, cookie, orgId } = await cloudOrg(true);
    for (const kind of ['kubernetes', 'docker'] as const) {
      const cl = await insertCluster(c.db, orgId, kind, kind);
      const r = await get(c, cookie, { cluster: cl.id });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({
        type: 'urn:watchlog:problem:pro-feature',
        detail: 'What changed is part of Pro',
      });
    }
    // Pro, then Free again: the entitlement decides at once.
    await c.app.entitlements!.put(orgId, { plan: 'pro', source: 'staff' });
    const cl = await insertCluster(c.db, orgId, 'again', 'kubernetes');
    expect((await get(c, cookie, { cluster: cl.id })).statusCode).toBe(200);
    await c.app.entitlements!.put(orgId, { plan: 'free', source: 'staff' });
    expect((await get(c, cookie, { cluster: cl.id })).statusCode).toBe(403);
  });

  it('Community: 404, on both kinds of cluster, as if the route weren’t there', async () => {
    ctx = await createTestContext({}, { now: () => NOW });
    const cookie = await setupAdmin(ctx.app);
    const org = await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow();
    for (const kind of ['kubernetes', 'docker'] as const) {
      const cl = await insertCluster(ctx.db, org.id, kind, kind);
      const r = await get(ctx, cookie, { cluster: cl.id });
      expect(r.statusCode).toBe(404);
    }
    // The 404 is the same with any cluster id, the org's or not.
    expect((await get(ctx, cookie, { cluster: newId() })).statusCode).toBe(404);
  });

  it('signed out: 401', async () => {
    const { c } = await cloudOrg();
    expect(
      (await c.app.inject({ method: 'GET', url: `/api/v1/what-changed?cluster=${newId()}` }))
        .statusCode,
    ).toBe(401);
  });
});

describe('the demo (ADR-203, ADR-122)', () => {
  async function demo() {
    ctx = await createTestContext(
      { demoMode: true },
      { now: () => NOW, causes: fakeCauses().causes },
    );
    const userId = await ensureDemoUser(ctx.db);
    const { org_id: orgId } = await ctx.db
      .selectFrom('memberships')
      .select('org_id')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/demo/session' });
    const cookie = res.cookies.find((x) => x.name === 'wl_session')!.value;
    return { c: ctx, cookie, orgId };
  }

  it('reads What changed for both kinds; ranges over the last 24 hours are refused', async () => {
    const { c, cookie, orgId } = await demo();
    const k8s = await insertCluster(c.db, orgId, 'demo', 'kubernetes');
    const fleet = await insertCluster(c.db, orgId, 'demo-docker', 'docker');
    for (const [cl, ps] of [
      [k8s, K8S],
      [fleet, DOCKER],
    ] as const) {
      await learned(c, orgId, cl.id);
      for (const p of ps) await period(c, orgId, cl.id, p);
      const ok = await get(c, cookie, { cluster: cl.id });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().rows).toHaveLength(3);
      // 6 hours and 24 hours: the windows the demo offers.
      for (const h of [6, 24]) {
        const r = await get(c, cookie, {
          cluster: cl.id,
          from: String(nowS - h * 3600),
          to: String(nowS),
        });
        expect(r.statusCode, `${h} h`).toBe(200);
      }
      const old = await get(c, cookie, {
        cluster: cl.id,
        from: String(nowS - 48 * 3600),
        to: String(nowS - 47 * 3600),
      });
      expect(old.statusCode).toBe(400);
      expect(old.json().detail).toBe(DEMO_RANGE_MESSAGE);
    }
  });

  it('an alert older than a day: its window is cut at the demo’s 24 hours', async () => {
    const { c, cookie, orgId } = await demo();
    const k8s = await insertCluster(c.db, orgId, 'demo', 'kubernetes');
    await learned(c, orgId, k8s.id);
    await withOrg(orgId, () => ensureDefaultRules(c.db, orgId));
    const rule = await c.db
      .selectFrom('alert_rules')
      .select('id')
      .where('org_id', '=', orgId)
      .executeTakeFirstOrThrow();
    const alertId = newId();
    await c.db
      .insertInto('alert_states')
      .values({
        id: alertId,
        org_id: orgId,
        rule_id: rule.id,
        cluster_id: k8s.id,
        fingerprint: 'fp',
        state: 'resolved',
        severity: 'warning',
        labels: JSON.stringify({}),
        details: JSON.stringify({}),
        started_at: new Date(NOW - DAY - 30 * MIN),
        resolved_at: new Date(NOW - DAY),
      })
      .execute();
    const a = (await get(c, cookie, { cluster: k8s.id, alert: alertId })).json();
    expect(a.window.from).toBe(new Date(NOW - DAY).toISOString());
    expect(new Date(a.chart.from).getTime()).toBeGreaterThanOrEqual(NOW - DAY);
  });
});
