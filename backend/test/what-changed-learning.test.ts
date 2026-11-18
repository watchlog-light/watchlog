// SPDX-License-Identifier: AGPL-3.0-only
// The learning week as data (ADR-216), for a Kubernetes cluster and a Server fleet, on an
// injectable clock: the days are generated and replayed hour by hour through the worker's
// own jobs, never waited for. What the worker records with each hourly recompute (the hours
// of the week that have a baseline, the series and their objects in the kind's words), what
// GET /what-changed and GET /what-changed/learning answer on day 1, 3, 6, in the last hour
// and afterwards, a series that joins later, the one-time fill from existing baselines, and
// "email me when it's ready": the member's own choice, the one email at the right minute, and
// nothing when the org left Pro. Cloud's org scoping is the isolation suite's.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { newId } from '../src/lib/ids.js';
import type { ClusterScope, QuerySeries } from '../src/lib/victoria.js';
import { runAnomalyHour, runAnomalyMinute, type AnomalyDeps } from '../src/modules/anomaly/jobs.js';
import { queriesFor, type ClusterKind, type ScoredKey } from '../src/modules/anomaly/keys.js';
import { breakdownOf } from '../src/modules/anomaly/learning.js';
import { createSession } from '../src/modules/auth/sessions.js';
import { insertCluster } from '../src/modules/clusters/service.js';
import { sendLifecycleEmails } from '../src/modules/lifecycle/job.js';
import { whatChangedReadyEmail } from '../src/modules/lifecycle/texts.js';
import {
  closeTestContext,
  createTestContext,
  TEST_SECRET_KEY,
  type TestContext,
} from './helpers.js';
import { mailpitMessages, mailpitText, TEST_SMTP_URL } from './support/mock-providers.js';

// A week replayed hour by hour is 168 recomputes against PostgreSQL: seconds, not a wait.
vi.setConfig({ testTimeout: 60_000 });

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The upgrade to Pro: a Wednesday at 14:10 UTC, as on the design's board. */
const START = Date.UTC(2026, 10, 18, 14, 10, 0);
const UNTIL = START + 7 * DAY;
/** The hour-of-week bucket of a time (UTC; Sunday 00:00 is 0). */
const bucket = (ms: number) => new Date(ms).getUTCDay() * 24 + new Date(ms).getUTCHours();
const SITE = 'https://cloud.watchlog.test';
const FROM = 'Ada Founder <founder@watchlog.test>';

interface Series {
  key: ScoredKey;
  labels: Record<string, string>;
  /** No value before this time. */
  since?: number;
}

/** A VictoriaMetrics that answers each scored key from the cluster's series, with gaps. */
class FakeVictoria {
  series: Series[] = [];
  /** No series has a value in these ranges (the agent was down). */
  gaps: [number, number][] = [];
  /** The one cluster that sends data; any other has none. */
  clusterId = '';
  private readonly keyOf = new Map<string, ScoredKey>();
  constructor(kind: ClusterKind) {
    for (const q of queriesFor(kind, [])) this.keyOf.set(q.expr, q.key);
  }
  async queryRange(
    scope: ClusterScope,
    expr: string,
    start: number,
    end: number,
    step: number,
  ): Promise<QuerySeries[]> {
    const key = this.keyOf.get(expr);
    const out: QuerySeries[] = [];
    if (scope.clusterId !== this.clusterId) return out;
    for (const [i, s] of this.series.entries()) {
      if (s.key !== key) continue;
      const points: [number, number | null][] = [];
      for (let t = start; t <= end; t += step) {
        const ms = t * 1000;
        if (s.since !== undefined && ms < s.since) continue;
        if (this.gaps.some(([a, b]) => ms >= a && ms < b)) continue;
        points.push([t, 1 + i + 0.1 * Math.sin(t / 600)]);
      }
      if (points.length) out.push({ labels: s.labels, points });
    }
    return out;
  }
}

interface Platform {
  kind: ClusterKind;
  series: Series[];
  breakdown: Record<string, number>;
  /** A series that joins after the first week, and what it adds to the breakdown. */
  late: Series;
  lateBreakdown: Record<string, number>;
}
const web1 = { host: 'web-1' };
const platforms: Platform[] = [
  {
    kind: 'kubernetes',
    series: [
      { key: 'node.cpu.utilization', labels: { node: 'kind-worker' } },
      { key: 'node.memory.utilization', labels: { node: 'kind-worker' } },
      { key: 'node.cpu.utilization', labels: { node: 'kind-worker2' } },
      {
        key: 'workload.cpu.usage',
        labels: { namespace: 'shop', workload_kind: 'Deployment', workload: 'checkout' },
      },
      {
        key: 'workload.memory.working_set',
        labels: { namespace: 'shop', workload_kind: 'Deployment', workload: 'checkout' },
      },
      {
        key: 'workload.cpu.usage',
        labels: { namespace: 'shop', workload_kind: 'StatefulSet', workload: 'db' },
      },
    ],
    breakdown: { nodes: 2, workloads: 2 },
    late: {
      key: 'workload.cpu.usage',
      labels: { namespace: 'shop', workload_kind: 'Deployment', workload: 'search' },
    },
    lateBreakdown: { nodes: 2, workloads: 3 },
  },
  {
    kind: 'server',
    series: [
      { key: 'host.cpu.utilization', labels: web1 },
      { key: 'host.memory.utilization', labels: web1 },
      { key: 'unit.cpu.usage', labels: { ...web1, unit: 'nginx.service' } },
      { key: 'unit.memory.working_set', labels: { ...web1, unit: 'nginx.service' } },
      { key: 'unit.cpu.usage', labels: { ...web1, unit: 'postgresql.service' } },
      { key: 'process.cpu.usage', labels: { ...web1, group: 'java' } },
      { key: 'container.memory.working_set', labels: { ...web1, container: 'shop-api-1' } },
    ],
    breakdown: { servers: 1, services: 2, processGroups: 1, containers: 1 },
    late: { key: 'host.cpu.utilization', labels: { host: 'web-2' } },
    lateBreakdown: { servers: 2, services: 2, processGroups: 1, containers: 1 },
  },
];

const CLOUD: Partial<Config> = {
  edition: 'cloud',
  cookieSecure: 'always',
  accounts: { turnstile: {}, supportEmail: 'support@watchlog.io', sampleUrl: 'https://x' },
};
const offline = (async () => new Response('offline', { status: 599 })) as typeof fetch;

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

/** A Cloud org on Pro with one cluster of the kind, the worker's jobs and a clock to move. */
async function world(p: Platform) {
  const clock = { now: START };
  ctx = await createTestContext(CLOUD, { fetch: offline, now: () => clock.now });
  const c = ctx;
  const email = `owner-${newId()}@acme.example`;
  const res = await c.app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email, password: 'a long enough password' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const cookie = res.cookies.find((x) => x.name === 'wl_session')!.value;
  const me = (
    await c.app.inject({ method: 'GET', url: '/api/v1/me', cookies: { wl_session: cookie } })
  ).json().user as { id: string; org: { id: string } };
  const orgId = me.org.id;
  await c.app.entitlements!.put(orgId, { plan: 'pro', source: 'staff' });
  const cluster = await insertCluster(
    c.db,
    orgId,
    p.kind === 'server' ? 'acme-servers' : 'acme-prod',
    p.kind,
  );
  const vm = new FakeVictoria(p.kind);
  vm.series = p.series.map((s) => ({ ...s }));
  vm.clusterId = cluster.id;
  const d: AnomalyDeps = {
    db: c.db,
    systemDb: c.db,
    victoria: vm,
    orgs: async () =>
      (
        await c.db
          .selectFrom('entitlements')
          .select('org_id')
          .where('pro_features', '=', true)
          .execute()
      ).map((r) => r.org_id),
    log: { warn: () => {} },
  };
  // The worker sees the org with Pro: learning starts.
  await runAnomalyMinute(d, START);
  let learnedTo = Math.floor(START / HOUR) * HOUR;
  /** Runs every hourly recompute due by `to`, then sets the clock there. */
  const advance = async (to: number) => {
    for (let h = learnedTo + HOUR; h + 5 * MIN <= to; h += HOUR) {
      await runAnomalyHour(d, h + 5 * MIN);
      learnedTo = h;
    }
    clock.now = to;
  };
  const read = async (as = cookie) => {
    const r = await c.app.inject({
      method: 'GET',
      url: '/api/v1/what-changed/learning',
      query: { cluster: cluster.id },
      cookies: { wl_session: as },
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().learning;
  };
  const choose = (enabled: boolean, as = cookie) =>
    c.app.inject({
      method: 'PUT',
      url: '/api/v1/what-changed/ready-email',
      payload: { cluster: cluster.id, enabled },
      cookies: { wl_session: as },
    });
  const verify = (userId: string) =>
    c.db
      .updateTable('users')
      // Verified, and unsubscribed from the getting-started emails: only the asked-for one.
      .set({ email_verified_at: new Date(START), lifecycle_unsubscribed_at: new Date(START) })
      .where('id', '=', userId)
      .execute();
  const member = async (role: 'admin' | 'viewer') => {
    const id = newId();
    const address = `${role}-${id}@acme.example`;
    await c.db
      .insertInto('users')
      .values({
        id,
        email: address,
        name: `${role} Person`,
        password_hash: 'x',
        email_verified_at: new Date(START),
        lifecycle_unsubscribed_at: new Date(START),
      })
      .execute();
    await c.db
      .insertInto('memberships')
      .values({ id: newId(), org_id: orgId, user_id: id, role })
      .execute();
    return { id, email: address, cookie: (await createSession(c.db, id)).token };
  };
  const mail = (now: number) =>
    sendLifecycleEmails(
      {
        systemDb: c.db,
        db: c.db,
        secretKey: Buffer.from(TEST_SECRET_KEY, 'base64'),
        from: FROM,
        settings: async () => ({
          smtp: { transport: TEST_SMTP_URL, from: 'WatchLog <alerts@watchlog.test>' },
          publicUrl: SITE,
        }),
        log: { info: () => {}, warn: () => {} },
      },
      now,
    );
  return {
    c,
    clock,
    cookie,
    orgId,
    cluster,
    vm,
    d,
    advance,
    read,
    choose,
    verify,
    member,
    mail,
    owner: { id: me.id, email },
  };
}

const ones = (week: string) => [...week].flatMap((ch, i) => (ch === '1' ? [i] : []));
const iso = (ms: number) => new Date(ms).toISOString();

describe('the objects behind the series, in the kind’s words', () => {
  it.each(platforms)('$kind', (p) => {
    expect(breakdownOf(p.series.map((s) => ({ key: s.key, subject: s.labels })))).toEqual(
      p.breakdown,
    );
  });
  it('a map edge counts as its source; an integration’s series as an application', () => {
    expect(
      breakdownOf([
        {
          key: 'edge.connections.rate',
          subject: { namespace: 'shop', workload: 'api', workload_kind: 'Deployment', dst: 'db' },
        },
        { key: 'workload.cpu.usage', subject: { namespace: 'shop', workload: 'api' } },
        { key: 'redis.ops.rate', subject: { service: 'c0ffee' } },
        { key: 'redis.hit.ratio', subject: { service: 'c0ffee' } },
        { key: 'edge.connections.rate', subject: { dst: 'db' } },
      ]),
    ).toEqual({ workloads: 2, applications: 1 });
  });
});

describe.each(platforms)('$kind: the learning week, hour by hour', (p) => {
  it('day 1, 3 and 6, an hour without data, the last hour, and the minute it is ready', async () => {
    const w = await world(p);
    // The minute of the upgrade: started, nothing read yet.
    expect(await w.read()).toEqual({
      learning: true,
      since: iso(START),
      until: iso(UNTIL),
      day: 1,
      hoursLearned: 0,
      hoursTotal: 168,
      week: '0'.repeat(168),
      series: { total: null, learning: 0, readyAt: iso(UNTIL), breakdown: {} },
      emailWhenReady: false,
    });

    // Day 1, 17:20: the worker read 14:10–15:00, 15:00–16:00 and 16:00–17:00.
    await w.advance(START + 3 * HOUR + 10 * MIN);
    let l = await w.read();
    expect(l).toMatchObject({ learning: true, day: 1, hoursLearned: 3, since: iso(START) });
    expect(ones(l.week)).toEqual([bucket(START), bucket(START) + 1, bucket(START) + 2]);
    expect(l.series).toEqual({
      total: p.series.length,
      learning: p.series.length,
      readyAt: iso(UNTIL),
      breakdown: p.breakdown,
    });
    // GET /what-changed carries the same answer, and lists nothing.
    const page = (
      await w.c.app.inject({
        method: 'GET',
        url: '/api/v1/what-changed',
        query: { cluster: w.cluster.id },
        cookies: { wl_session: w.cookie },
      })
    ).json();
    expect(page.learning).toEqual(l);
    expect(page.rows).toEqual([]);

    // Day 3, 03:10: 61 hours in, 61 learned.
    await w.advance(START + 2 * DAY + 13 * HOUR);
    l = await w.read();
    expect(l).toMatchObject({ learning: true, day: 3, hoursLearned: 61 });

    // Day 4: the agents are down from 09:00 to 10:00. That hour of the week isn't learned.
    const gap = Math.floor((START + 3 * DAY + 19 * HOUR) / HOUR) * HOUR;
    w.vm.gaps.push([gap, gap + HOUR]);
    // Day 6, 20:10.
    await w.advance(START + 5 * DAY + 6 * HOUR);
    l = await w.read();
    expect(l).toMatchObject({ learning: true, day: 6, hoursLearned: 5 * 24 + 6 - 1 });
    expect(l.week[bucket(gap)]).toBe('0');
    expect(l.week[bucket(gap) - 1]).toBe('1');
    expect(l.week[bucket(gap) + 1]).toBe('1');

    // The last hour: 20 minutes to go, still nothing listed.
    await w.advance(UNTIL - 20 * MIN);
    l = await w.read();
    expect(l).toMatchObject({ learning: true, day: 7, until: iso(UNTIL), hoursLearned: 166 });
    // The current hour of the week (Wednesday 14:00) is the one it started in, already seen.
    expect(l.week[bucket(UNTIL)]).toBe('1');

    // The minute it is ready.
    await w.advance(UNTIL);
    l = await w.read();
    expect(l).toMatchObject({
      learning: false,
      day: 7,
      hoursLearned: 167,
      series: { total: p.series.length, learning: 0, readyAt: null, breakdown: p.breakdown },
    });
  });

  it('a series that joins later: the list is on, and the answer says how many still learn and until when', async () => {
    const w = await world(p);
    await w.advance(UNTIL + DAY);
    expect(await w.read()).toMatchObject({ learning: false, series: { learning: 0 } });
    const joined = UNTIL + DAY + 30 * MIN;
    w.vm.series.push({ ...p.late, since: joined });
    await w.advance(UNTIL + DAY + 3 * HOUR);
    let l = await w.read();
    expect(l).toMatchObject({ learning: false, since: iso(START), until: iso(UNTIL) });
    expect(l.series).toEqual({
      total: p.series.length + 1,
      learning: 1,
      readyAt: iso(joined + 7 * DAY),
      breakdown: p.lateBreakdown,
    });
    // Its own 7 days later, nothing is learning any more (the row is up to an hour old).
    await w.advance(joined + 7 * DAY + 2 * HOUR);
    l = await w.read();
    expect(l.series).toMatchObject({ total: p.series.length + 1, learning: 0, readyAt: null });
  });

  it('a cluster that was learning before the learning row existed: its hours are filled from the baselines, once', async () => {
    const w = await world(p);
    await w.advance(START + 2 * DAY);
    const before = await w.read();
    expect(before.hoursLearned).toBe(48);
    // As after the upgrade to 0.9.4: baselines, no learning row.
    await w.c.db.deleteFrom('anomaly_learning').where('cluster_id', '=', w.cluster.id).execute();
    const bare = await w.read();
    expect(bare).toMatchObject({
      learning: true,
      since: before.since,
      until: before.until,
      day: 3,
      hoursLearned: 0,
      series: { total: null },
    });
    await w.advance(START + 2 * DAY + HOUR);
    const after = await w.read();
    expect(after.hoursLearned).toBe(49);
    expect(ones(after.week)).toEqual(
      [...ones(before.week), bucket(START + 2 * DAY)].sort((a, b) => a - b),
    );
    expect(after.series).toMatchObject({ total: p.series.length, breakdown: p.breakdown });
    expect(after.since).toBe(before.since);
  });

  it('“email me when it’s ready”: the member’s own choice, one email at the minute it is ready, never twice', async () => {
    const w = await world(p);
    // Cloud: not before the address is verified.
    let r = await w.choose(true);
    expect(r.statusCode).toBe(409);
    expect(r.json().detail ?? r.json().title).toContain('Verify');
    await w.verify(w.owner.id);
    r = await w.choose(true);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ emailWhenReady: true });
    expect((await w.read()).emailWhenReady).toBe(true);
    // Asking twice is the same; a Viewer asks for themselves; an Admin asks and undoes it.
    expect((await w.choose(true)).statusCode).toBe(200);
    const viewer = await w.member('viewer');
    const admin = await w.member('admin');
    expect((await w.read(viewer.cookie)).emailWhenReady).toBe(false);
    expect((await w.choose(true, viewer.cookie)).json()).toEqual({ emailWhenReady: true });
    expect((await w.choose(true, admin.cookie)).statusCode).toBe(200);
    expect((await w.choose(false, admin.cookie)).json()).toEqual({ emailWhenReady: false });
    expect((await w.read(admin.cookie)).emailWhenReady).toBe(false);
    expect((await w.read(viewer.cookie)).emailWhenReady).toBe(true);
    expect((await w.read()).emailWhenReady).toBe(true);

    // During the week, and a minute before: nothing.
    await w.advance(START + 3 * DAY);
    expect(await w.mail(w.clock.now)).toBe(0);
    await w.advance(UNTIL - MIN);
    expect(await w.mail(w.clock.now)).toBe(0);
    expect(await mailpitMessages(w.owner.email)).toHaveLength(0);

    // Ready: one each to the two who asked, none to the Admin who undid it.
    await w.advance(UNTIL);
    expect(await w.mail(w.clock.now)).toBe(2);
    const [msg] = await mailpitMessages(w.owner.email);
    expect(msg!.Subject).toBe(`What changed is ready for ${w.cluster.name}`);
    const text = await mailpitText(msg!.ID);
    expect(text).toContain(`${SITE}/what-changed?cluster=${w.cluster.id}`);
    expect(text).toContain('You asked for this email');
    expect(text).toContain('Ada Founder, WatchLog');
    expect(text).toContain(
      p.kind === 'server' ? 'A server, service or container' : 'A workload or node',
    );
    expect(await mailpitMessages(viewer.email)).toHaveLength(1);
    expect(await mailpitMessages(admin.email)).toHaveLength(0);
    // Never twice, and the page no longer shows a pending choice.
    expect(await w.mail(w.clock.now + HOUR)).toBe(0);
    expect(await mailpitMessages(w.owner.email)).toHaveLength(1);
    expect((await w.read()).emailWhenReady).toBe(false);
    // Once it is ready there is nothing left to ask for.
    expect((await w.choose(true, admin.cookie)).statusCode).toBe(409);
  });

  it('nothing is sent while the org is without Pro, or for a cluster that never sent data', async () => {
    const w = await world(p);
    await w.verify(w.owner.id);
    expect((await w.choose(true)).statusCode).toBe(200);
    // A second cluster with no agent: asked for too, never ready.
    const empty = await insertCluster(w.c.db, w.orgId, 'no-data-yet', p.kind);
    const asked = await w.c.app.inject({
      method: 'PUT',
      url: '/api/v1/what-changed/ready-email',
      payload: { cluster: empty.id, enabled: true },
      cookies: { wl_session: w.cookie },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    await w.advance(START + 6 * DAY);
    // The org leaves Pro on day 6: the worker stops, and the week isn't finished.
    await w.c.app.entitlements!.put(w.orgId, { plan: 'free', source: 'staff' });
    expect((await w.choose(true)).statusCode).toBe(403);
    await w.advance(UNTIL + DAY);
    expect(await w.mail(w.clock.now)).toBe(0);
    expect(await mailpitMessages(w.owner.email)).toHaveLength(0);
    // Back on Pro within 30 days: the kept baselines resume, and the email goes out, once,
    // for the cluster with data only.
    await w.c.app.entitlements!.put(w.orgId, { plan: 'pro', source: 'staff' });
    await w.advance(UNTIL + DAY + 2 * HOUR);
    expect(await w.mail(w.clock.now)).toBe(1);
    const got = await mailpitMessages(w.owner.email);
    expect(got.map((m) => m.Subject)).toEqual([`What changed is ready for ${w.cluster.name}`]);
    expect(await w.mail(w.clock.now + 30 * DAY)).toBe(0);
  });
});

describe('the email’s text', () => {
  it('is short, plain, names the cluster once per line it needs, and can’t be bent by its name', () => {
    const m = whatChangedReadyEmail({
      site: SITE,
      name: 'Sam',
      signature: 'Ada Founder, WatchLog',
      cluster: { id: 'c1', name: 'prod\r\nBcc: someone@else.test', kind: 'kubernetes' },
    });
    expect(m.subject).toBe('What changed is ready for prod Bcc: someone@else.test');
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text.split('\n').length).toBeLessThan(16);
    expect(m.text).not.toMatch(/<[a-z]+[ >]/i);
    expect(m.text).not.toContain('unsubscribe');
  });
});
