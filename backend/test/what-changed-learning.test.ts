// SPDX-License-Identifier: AGPL-3.0-only
// The learning week as data (ADR-216, ADR-217), for a Kubernetes cluster and a Server fleet,
// on an injectable clock: the days are generated and replayed hour by hour through the
// worker's own jobs, never waited for. Every case checks the page against the worker's own
// decision: the answer says "learning" exactly while the worker scores nothing, and "ready
// on" is when it starts.
//   - a week without gaps (day 1, 3, 6, the last hour), and one with an hour of no data;
//   - Pro, Free for 2 days, Pro again; two hours of Pro, two days off, Pro again (WatchLog
//     Cloud's own fleet on 18 November, from a row as 0.9.5 left it);
//   - a cancel and a resubscribe, within the 30 days the baselines are kept and after them;
//   - a server that joins late;
//   - "email me when it's ready": the member's own choice, one email when the worker says
//     ready, nothing when the org left Pro.
// Cloud's org scoping is the isolation suite's.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { newId } from '../src/lib/ids.js';
import type { ClusterScope, QuerySeries } from '../src/lib/victoria.js';
import { runAnomalyHour, runAnomalyMinute, type AnomalyDeps } from '../src/modules/anomaly/jobs.js';
import { queriesFor, type ClusterKind, type ScoredKey } from '../src/modules/anomaly/keys.js';
import { RECOMPUTE_LAG_MS } from '../src/modules/anomaly/coverage.js';
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
  /** The worker's own decision at `at`: how many series it scores in that minute. */
  const scored = async (at = clock.now) => (await runAnomalyMinute(d, at)).series;
  /**
   * The page against the worker: the answer says "learning" exactly while the worker scores
   * nothing. Returns the answer.
   */
  const agree = async (what: string, as?: string) => {
    const l = await read(as);
    const n = await scored();
    expect(
      l.learning,
      `${what}: the page says learning=${l.learning}, the worker scores ${n}`,
    ).toBe(n === 0);
    return l;
  };
  const setPlan = async (plan: 'pro' | 'free', source: 'staff' | 'billing' = 'staff') => {
    await c.app.entitlements!.put(orgId, { plan, source });
  };
  return {
    scored,
    agree,
    setPlan,
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
  const N = p.series.length;

  it('a week without a gap: day 1, 3 and 6, the last hour, and ready at exactly 7 days', async () => {
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
      resumedAt: null,
      series: { total: null, learning: 0, readyAt: iso(UNTIL), breakdown: {} },
      emailWhenReady: false,
    });
    expect(await w.scored()).toBe(0);

    // Day 1, 17:20: the worker read 14:10–15:00, 15:00–16:00 and 16:00–17:00.
    await w.advance(START + 3 * HOUR + 10 * MIN);
    let l = await w.agree('day 1');
    expect(l).toMatchObject({ learning: true, day: 1, hoursLearned: 3, until: iso(UNTIL) });
    expect(ones(l.week)).toEqual([bucket(START), bucket(START) + 1, bucket(START) + 2]);
    expect(l.series).toEqual({
      total: N,
      learning: N,
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

    // Day 3, 03:10: 61 hours in, 61 learned. Day 6, 20:10: 126.
    await w.advance(START + 2 * DAY + 13 * HOUR);
    expect(await w.agree('day 3')).toMatchObject({ day: 3, hoursLearned: 61, until: iso(UNTIL) });
    await w.advance(START + 5 * DAY + 6 * HOUR);
    expect(await w.agree('day 6')).toMatchObject({ day: 6, hoursLearned: 126, until: iso(UNTIL) });

    // The last hour, and the minute before: still learning, and the worker scores nothing.
    await w.advance(UNTIL - 38 * MIN);
    expect(await w.agree('the last hour')).toMatchObject({ day: 7, hoursLearned: 167 });
    await w.advance(UNTIL - MIN);
    l = await w.agree('a minute before');
    expect(l).toMatchObject({
      learning: true,
      hoursLearned: 168,
      until: iso(UNTIL),
      resumedAt: null,
    });

    // Exactly 7 days after the first series: the list is on, and the worker scores all of them.
    await w.advance(UNTIL);
    l = await w.agree('ready');
    expect(l).toMatchObject({
      learning: false,
      until: iso(UNTIL),
      day: 7,
      hoursLearned: 168,
      week: '1'.repeat(168),
      series: { total: N, learning: 0, readyAt: null, breakdown: p.breakdown },
    });
    expect(await w.scored()).toBe(N);
  });

  it('an hour with no data is not learned: the list waits until that hour of the week comes round', async () => {
    const w = await world(p);
    // Day 4: the agents are down from Sunday 09:00 to 10:00.
    const gap = Math.floor((START + 3 * DAY + 19 * HOUR) / HOUR) * HOUR;
    w.vm.gaps.push([gap, gap + HOUR]);
    await w.advance(START + 5 * DAY + 6 * HOUR);
    // The worker looked at that hour and found nothing: it comes round in a week.
    const made = gap + 7 * DAY + HOUR + RECOMPUTE_LAG_MS;
    let l = await w.agree('day 6, an hour missing');
    expect(l).toMatchObject({ learning: true, day: 6, hoursLearned: 125, until: iso(made) });
    expect(l.week[bucket(gap)]).toBe('0');
    expect(l.week[bucket(gap) - 1]).toBe('1');
    // 7 days on the calendar are not 7 days of data: still learning, and nothing is scored.
    await w.advance(UNTIL + HOUR);
    l = await w.agree('7 days after the start');
    expect(l).toMatchObject({ learning: true, day: 7, hoursLearned: 167, until: iso(made) });
    // The hour comes round and is learned: ready, within a minute of what the page said.
    await w.advance(made - 2 * MIN);
    expect((await w.agree('just before')).learning).toBe(true);
    await w.advance(made);
    l = await w.agree('made up');
    expect(l).toMatchObject({ learning: false, hoursLearned: 168 });
    expect(Math.abs(Date.parse(l.until) - made)).toBeLessThanOrEqual(MIN);
    expect(await w.scored()).toBe(N);
  });

  it('an hour that is silent every week is settled after two looks, not learned forever', async () => {
    const w = await world(p);
    // The fleet is off every Sunday 09:00–10:00.
    const quiet = Math.floor((START + 3 * DAY + 19 * HOUR) / HOUR) * HOUR;
    w.vm.gaps.push([quiet, quiet + HOUR], [quiet + 7 * DAY, quiet + 7 * DAY + HOUR]);
    await w.advance(quiet + 7 * DAY + HOUR + 4 * MIN);
    expect((await w.agree('before the second look')).learning).toBe(true);
    await w.advance(quiet + 7 * DAY + HOUR + 5 * MIN);
    const l = await w.agree('after the second look');
    expect(l).toMatchObject({ learning: false, hoursLearned: 167 });
    // Looked at twice, nothing to learn there: neither learned nor "not seen yet".
    expect(l.week[bucket(quiet)]).toBe('2');
    expect(await w.scored()).toBe(N);
  });

  it('Pro, Free for 2 days, Pro again: the two days are not learned, what was learned before still counts, and the page says it resumed', async () => {
    const w = await world(p);
    // A day of Pro: 24 hours of the week learned.
    await w.advance(START + DAY);
    expect(await w.agree('before the downgrade')).toMatchObject({ day: 2, hoursLearned: 24 });
    await w.setPlan('free');
    // Free: the worker stops; the page is the upgrade page (403).
    await w.advance(START + 3 * DAY);
    expect(await w.scored()).toBe(0);
    expect(
      (
        await w.c.app.inject({
          method: 'GET',
          url: '/api/v1/what-changed/learning',
          query: { cluster: w.cluster.id },
          cookies: { wl_session: w.cookie },
        })
      ).statusCode,
    ).toBe(403);
    await w.setPlan('pro');
    // Pro again, the same minute: the 24 hours are still there (the worker kept the
    // baselines and scores with them), and the 48 hours of the gap are still to learn. They
    // come round a week after the gap: 10 days after the start, not 7.
    const ready = START + 10 * DAY - HOUR - 10 * MIN + HOUR + RECOMPUTE_LAG_MS;
    let l = await w.agree('Pro again');
    expect(l).toMatchObject({
      learning: true,
      since: iso(START),
      day: 2,
      hoursLearned: 24,
      until: iso(ready),
      resumedAt: null,
    });
    // Two hours later it has learned two more, and says when it resumed.
    await w.advance(START + 3 * DAY + 2 * HOUR);
    l = await w.agree('resumed');
    const resumed = Math.floor((START + 3 * DAY) / HOUR) * HOUR;
    expect(l).toMatchObject({
      day: 2,
      hoursLearned: 26,
      until: iso(ready),
      resumedAt: iso(resumed),
    });
    // 7 days after the first sighting, where the rule before 0.9.6 turned the list on: 5 days
    // of data, still learning, and the worker scores nothing.
    await w.advance(UNTIL);
    l = await w.agree('7 days after the first sighting');
    expect(l).toMatchObject({ learning: true, day: 6, hoursLearned: 120, until: iso(ready) });
    // The gap's last hour comes round: ready, and the worker scores every series.
    await w.advance(ready - 2 * MIN);
    expect((await w.agree('just before')).learning).toBe(true);
    await w.advance(ready);
    l = await w.agree('ready');
    expect(l).toMatchObject({ learning: false, hoursLearned: 168, resumedAt: null });
    expect(Math.abs(Date.parse(l.until) - ready)).toBeLessThanOrEqual(MIN);
    expect(await w.scored()).toBe(N);
  });

  it('two hours of Pro, two days off, Pro again, from a row as 0.9.5 left it (WatchLog Cloud’s fleet on 18 November)', async () => {
    const w = await world(p);
    // Pro from 14:10: the hours from 14:00 and 15:00 are learned; then no Pro features.
    await w.advance(START + 2 * HOUR);
    await w.setPlan('free');
    await w.advance(START + 2 * DAY);
    await w.setPlan('pro');
    // 0.9.4 and 0.9.5 recorded the hours learned, not when the worker looked.
    await w.c.db
      .updateTable('anomaly_learning')
      .set({
        looked_at: Array(168).fill(null),
        looks: Array(168).fill(0),
        ready_at: null,
        resumed_at: null,
      })
      .where('cluster_id', '=', w.cluster.id)
      .execute();
    // The page before 0.9.6: day 3 of 7, ready 7 days after the first sighting. Now: day 1,
    // 2 of 168 hours, and ready a week after it really resumed.
    const ready = START + 9 * DAY - HOUR - 10 * MIN + HOUR + RECOMPUTE_LAG_MS;
    let l = await w.agree('from the old row');
    expect(l).toMatchObject({
      learning: true,
      since: iso(START),
      day: 1,
      hoursLearned: 2,
      until: iso(ready),
    });
    expect(ones(l.week)).toEqual([bucket(START), bucket(START) + 1]);
    // The next hourly run stores the looks; the answer is the same, plus the resume.
    await w.advance(START + 2 * DAY + HOUR);
    l = await w.agree('after the next run');
    expect(l).toMatchObject({ day: 1, hoursLearned: 3, until: iso(ready) });
    expect(l.resumedAt).toBe(iso(Math.floor((START + 2 * DAY) / HOUR) * HOUR));
    const row = await w.c.db
      .selectFrom('anomaly_learning')
      .select(['looked_at', 'looks'])
      .where('cluster_id', '=', w.cluster.id)
      .executeTakeFirstOrThrow();
    expect(row.looked_at.filter((t) => t !== null)).toHaveLength(3);
    expect(row.looks.filter((n) => n > 0)).toHaveLength(3);
    // At the old date the worker scores nothing; a week after the resume it scores all.
    await w.advance(UNTIL);
    expect(await w.agree('the old date')).toMatchObject({ learning: true, hoursLearned: 122 });
    await w.advance(ready);
    l = await w.agree('ready');
    expect(l).toMatchObject({ learning: false, hoursLearned: 168 });
    expect(await w.scored()).toBe(N);
  });

  it('a cancel and a resubscribe within 30 days: the list is back at once, as the worker scores at once', async () => {
    const w = await world(p);
    // Read as a Viewer: the Owner of a billed org must first set up 2FA (ADR-175).
    const viewer = (await w.member('viewer')).cookie;
    await w.advance(UNTIL + DAY);
    expect(await w.agree('ready', viewer)).toMatchObject({ learning: false });
    await w.setPlan('free', 'billing');
    await w.advance(UNTIL + 4 * DAY);
    expect(await w.scored()).toBe(0);
    await w.setPlan('pro', 'billing');
    // The baselines were kept (ADR-198) and the worker scores with them from this minute.
    const l = await w.agree('resubscribed', viewer);
    expect(l).toMatchObject({
      learning: false,
      since: iso(START),
      until: iso(UNTIL),
      resumedAt: null,
    });
    expect(await w.scored()).toBe(N);
  });

  it('a cancel and a resubscribe after the 30 days: the worker starts over, and so does the page, at day 1', async () => {
    const w = await world(p);
    const viewer = (await w.member('viewer')).cookie;
    await w.advance(UNTIL + DAY);
    await w.setPlan('free', 'billing');
    // 31 days later the hourly housekeeping has deleted the baselines and the learning row.
    const back = UNTIL + 32 * DAY + 20 * MIN;
    await w.advance(back);
    expect(await w.c.db.selectFrom('anomaly_learning').select('cluster_id').execute()).toHaveLength(
      0,
    );
    await w.setPlan('pro', 'billing');
    expect(await w.scored(back)).toBe(0);
    let l = await w.agree('started over', viewer);
    expect(l).toMatchObject({
      learning: true,
      since: iso(back),
      until: iso(back + 7 * DAY),
      day: 1,
      hoursLearned: 0,
      resumedAt: null,
    });
    await w.advance(back + 7 * DAY - MIN);
    expect((await w.agree('a minute before', viewer)).learning).toBe(true);
    await w.advance(back + 7 * DAY);
    l = await w.agree('ready again', viewer);
    expect(l).toMatchObject({ learning: false, hoursLearned: 168 });
    expect(await w.scored()).toBe(N);
  });

  it('a server or workload that joins late: the list is on, its own series wait 7 days, and the answer counts them as the worker does', async () => {
    const w = await world(p);
    await w.advance(UNTIL + DAY);
    expect(await w.agree('ready')).toMatchObject({ learning: false, series: { learning: 0 } });
    const joined = UNTIL + DAY + 30 * MIN;
    w.vm.series.push({ ...p.late, since: joined });
    await w.advance(UNTIL + DAY + 3 * HOUR);
    let l = await w.agree('one joined');
    expect(l).toMatchObject({ learning: false, since: iso(START), until: iso(UNTIL) });
    expect(l.series).toEqual({
      total: N + 1,
      learning: 1,
      readyAt: iso(joined + 7 * DAY),
      breakdown: p.lateBreakdown,
    });
    // The worker scores the old series and not the new one, until its own 7 days are up.
    expect(await w.scored()).toBe(N);
    await w.advance(joined + 7 * DAY - MIN);
    expect(await w.scored()).toBe(N);
    await w.advance(joined + 7 * DAY);
    expect(await w.scored()).toBe(N + 1);
    // The count on the page is the last hourly run's: none learning from the next one.
    await w.advance(joined + 7 * DAY + 2 * HOUR);
    l = await w.read();
    expect(l.series).toMatchObject({ total: N + 1, learning: 0, readyAt: null });
  });

  it('a cluster that learned before the learning row existed: the answer comes from its baselines at once, and the row once', async () => {
    const w = await world(p);
    await w.advance(START + 2 * DAY);
    const before = await w.agree('before');
    expect(before.hoursLearned).toBe(48);
    // As after an upgrade from 0.9.3: baselines, no learning row.
    await w.c.db.deleteFrom('anomaly_learning').where('cluster_id', '=', w.cluster.id).execute();
    const bare = await w.agree('no row');
    expect(bare).toMatchObject({
      learning: true,
      since: before.since,
      until: before.until,
      day: 3,
      hoursLearned: 48,
      week: before.week,
      series: { total: null },
    });
    await w.advance(START + 2 * DAY + HOUR);
    const after = await w.agree('after the next run');
    expect(after.hoursLearned).toBe(49);
    expect(ones(after.week)).toEqual(
      [...ones(before.week), bucket(START + 2 * DAY)].sort((a, b) => a - b),
    );
    expect(after.series).toMatchObject({ total: N, breakdown: p.breakdown });
    expect(after.until).toBe(before.until);
    // A cluster that was already listing under the rule before 0.9.6 goes on listing.
    await w.advance(UNTIL + 2 * DAY);
    await w.c.db
      .updateTable('anomaly_learning')
      .set({ looked_at: Array(168).fill(null), looks: Array(168).fill(0), ready_at: null })
      .where('cluster_id', '=', w.cluster.id)
      .execute();
    expect(await w.agree('an old ready row')).toMatchObject({ learning: false, until: iso(UNTIL) });
    expect(await w.scored()).toBe(N);
  });

  it('“email me when it’s ready”: the member’s own choice, one email when the worker says ready, never twice', async () => {
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

    // Ready by the worker's rule: one each to the two who asked, none to the Admin who undid it.
    await w.advance(UNTIL);
    expect((await w.agree('ready')).learning).toBe(false);
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

  it('the email follows the worker, not the calendar: nothing while the org is off Pro or still making up a gap, nothing for a cluster that never sent data', async () => {
    const w = await world(p);
    await w.verify(w.owner.id);
    expect((await w.choose(true)).statusCode).toBe(200);
    // A second cluster with no agent: asked for too.
    const empty = await insertCluster(w.c.db, w.orgId, 'no-data-yet', p.kind);
    const asked = await w.c.app.inject({
      method: 'PUT',
      url: '/api/v1/what-changed/ready-email',
      payload: { cluster: empty.id, enabled: true },
      cookies: { wl_session: w.cookie },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    await w.advance(START + 6 * DAY);
    // The org leaves Pro on day 6, for two days.
    await w.setPlan('free');
    expect((await w.choose(true)).statusCode).toBe(403);
    await w.advance(UNTIL + DAY);
    expect(await w.mail(w.clock.now)).toBe(0);
    // Back on Pro: 7 days have passed on the calendar, but two of them were not learned.
    await w.setPlan('pro');
    await w.advance(UNTIL + DAY + 2 * HOUR);
    expect((await w.agree('back, a gap to make up')).learning).toBe(true);
    expect(await w.mail(w.clock.now)).toBe(0);
    expect(await mailpitMessages(w.owner.email)).toHaveLength(0);
    // A week after the gap began its hours have come round: ready, and the email goes out,
    // once, for the cluster with data only.
    const ready = UNTIL + DAY + 7 * DAY - HOUR - 10 * MIN + HOUR + RECOMPUTE_LAG_MS;
    await w.advance(ready);
    expect((await w.agree('ready')).learning).toBe(false);
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
