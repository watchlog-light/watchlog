// SPDX-License-Identifier: AGPL-3.0-only
// Alerts on a user's own metrics (1.0.0, ADR-236, ADR-238): made under Your metrics, stored as
// ordinary alert rules, evaluated by the same engine against VictoriaMetrics, naming the
// workload or server the metric belongs to; what each plan refuses; "Watch with What changed"
// and the usual range.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { VictoriaQueryClient } from '../src/lib/victoria.js';
import { lookupEvaluator } from '../src/modules/alerts/rules.js';
import { alertText } from '../src/modules/alerts/text.js';
import { ownMetricLimits } from '../src/modules/entitlements/own-metrics.js';
import {
  conditionWords,
  configureOwnAlerts,
  ownSentence,
} from '../src/modules/own-metrics/alerts.js';
import { OwnUsual } from '../src/modules/own-metrics/usual.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  TEST_VM_URL,
  type TestContext,
} from './helpers.js';
import { testWorker } from './support/alerts.js';
import { encode, type TestSeries } from './support/remote-write.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const vm = new VictoriaQueryClient(TEST_VM_URL);
const COMMUNITY = ownMetricLimits({ edition: 'community', pro: false });
const PRO = ownMetricLimits({ edition: 'cloud', plan: 'pro', pro: true, billedNodes: 5 });
const FREE = ownMetricLimits({ edition: 'cloud', plan: 'free', pro: false });

let ctx: TestContext;
let cookie: string;
let clusterId: string;
let orgId: string;
let token: string;

const api = (method: string, url: string, payload?: object, as = cookie) =>
  ctx.app.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    cookies: { wl_session: as },
    ...(payload ? { payload } : {}),
  });

/** The plan the routes and the evaluator see. */
function plan(limits: typeof PRO) {
  const usage = ctx.app.ownMetrics.usage.bind(ctx.app.ownMetrics);
  ctx.app.ownMetrics.usage = async (id) => ({ ...(await usage(id)), limits });
  configureOwnAlerts({ limits: async () => limits, usual: new OwnUsual(vm) });
}

async function start(kind: 'kubernetes' | 'server' = 'kubernetes') {
  ctx = await createTestContext();
  cookie = await setupAdmin(ctx.app);
  clusterId = (await api('POST', '/clusters', { name: 'prod', kind })).json().cluster.id;
  orgId = (await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow()).id;
  token = (await api('POST', `/clusters/${clusterId}/own-metrics/tokens`, { name: 't' })).json()
    .value;
  plan(COMMUNITY);
}
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined as never;
});

/** Samples of own metrics in the past, as Prometheus would send them. */
async function write(series: TestSeries[]) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/ingest/v1/write',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-protobuf',
      'content-encoding': 'snappy',
    },
    payload: encode(series),
  });
  expect(res.statusCode, res.body).toBe(204);
  await fetch(`${TEST_VM_URL}/internal/force_flush`);
}
const line = (
  name: string,
  labels: Record<string, string>,
  from: number,
  to: number,
  value: (t: number) => number,
  step = 30_000,
): TestSeries[] => {
  const out: TestSeries[] = [];
  for (let t = from; t <= to; t += step)
    out.push({ labels: { __name__: name, ...labels }, value: value(t), timestampMs: t });
  return out;
};
const metricId = async (name: string) =>
  (await api('GET', `/clusters/${clusterId}/own-metrics/metrics`))
    .json()
    .metrics.find((m: { name: string }) => m.name === name).id as string;
async function pod(name: string, workload: string) {
  await ctx.db
    .insertInto('objects')
    .values({
      id: newId(),
      cluster_id: clusterId,
      source: 'kubernetes',
      kind: 'Pod',
      namespace: 'shop',
      name,
      uid: newId(),
      spec_summary: JSON.stringify({ workload: { kind: 'Deployment', name: workload } }),
      status_summary: JSON.stringify({ phase: 'Running' }),
    })
    .execute();
}
const states = (ruleId: string) =>
  ctx.db
    .selectFrom('alert_states')
    .select(['state', 'fingerprint', 'labels', 'details', 'severity'])
    .where('rule_id', '=', ruleId)
    .orderBy('fingerprint')
    .execute();

describe('the words of an alert on an own metric', () => {
  const gauge = { unit: 'count' as const, shown: 'as_is' as const };
  it('says what the page says: the metric’s words, its owner, its value, the condition', () => {
    expect(
      ownSentence({
        words: 'Jobs waiting',
        owner: 'shop/worker',
        is: 'above',
        value: 612,
        threshold: 500,
        forSeconds: 900,
        showing: gauge,
      }).full,
    ).toBe('Jobs waiting on shop/worker is 612, above 500 for 15 min.');
    expect(
      ownSentence({
        words: 'Orders created',
        owner: null,
        is: 'below',
        value: 0.01,
        threshold: 0.05,
        forSeconds: 0,
        showing: { unit: 'count', shown: 'rate' },
        per: 'min',
      }).full,
    ).toBe('Orders created is 0.6 /min, below 3 /min.');
    expect(
      ownSentence({
        words: 'Backup last success',
        owner: 'db-1',
        is: 'older',
        value: 27 * 3600,
        threshold: 26 * 3600,
        forSeconds: 0,
        showing: { unit: 'seconds', shown: 'time_since' },
      }).full,
    ).toBe('Backup last success on db-1 is 27 h old, older than 26 h.');
    expect(
      ownSentence({
        words: 'Gpu temperature',
        owner: 'gpu-1',
        is: 'absent',
        value: 1200,
        threshold: 900,
        forSeconds: 0,
        showing: { unit: 'celsius', shown: 'as_is' },
      }),
    ).toEqual({
      title: 'Gpu temperature on gpu-1 has not reported for 20 min',
      why: 'alerts after 15 min',
      full: 'Gpu temperature on gpu-1 has not reported for 20 min.',
    });
    expect(
      ownSentence({
        words: 'Payment failures',
        owner: 'shop/orders',
        is: 'unusual',
        value: 2.8 / 60,
        threshold: null,
        forSeconds: 600,
        showing: { unit: 'count', shown: 'rate' },
        per: 'min',
        low: 0.1 / 60,
        high: 0.4 / 60,
      }).full,
    ).toBe(
      'Payment failures on shop/orders is 2.8 /min, outside its usual 0.1 /min – 0.4 /min for this hour for 10 min.',
    );
    expect(
      conditionWords({
        is: 'above',
        threshold: 85,
        forSeconds: 600,
        showing: { unit: 'celsius', shown: 'as_is' },
      }),
    ).toBe('above 85 °C for 10 min');
    expect(
      conditionWords({ is: 'unusual', threshold: null, forSeconds: 600, showing: gauge }),
    ).toBe('outside its usual range for 10 min');
  });

  it('is what every channel and page writes', () => {
    expect(
      alertText({
        ruleKey: null,
        ruleName: 'Queue is backing up',
        labels: {
          namespace: 'shop',
          workload: 'worker',
          workload_kind: 'Deployment',
          own_metric: 'queue_jobs_waiting',
        },
        details: {
          own: true,
          title: 'Jobs waiting on shop/worker is 612',
          why: 'above 500 for 15 min · queue_jobs_waiting',
        },
        cluster: { name: 'prod' },
        now: Date.now(),
      }),
    ).toEqual({
      title: 'Jobs waiting on shop/worker is 612',
      why: 'above 500 for 15 min · queue_jobs_waiting',
    });
  });
});

describe('making an alert', () => {
  beforeEach(() => start());

  it('needs a metric, a condition that fits it, and a value; says what it would say now', async () => {
    const now = Date.now() - 2 * MIN;
    await pod('worker-1', 'worker');
    await write([
      ...line(
        'queue_jobs_waiting',
        { namespace: 'shop', pod: 'worker-1', queue: 'mail' },
        now - 10 * MIN,
        now,
        () => 612,
      ),
      ...line(
        'backup_last_success_timestamp',
        {},
        now - 10 * MIN,
        now,
        () => Math.floor(now / 1000) - 3 * 3600,
      ),
    ]);
    const jobs = await metricId('queue_jobs_waiting');
    const backup = await metricId('backup_last_success_timestamp');
    const base = `/clusters/${clusterId}/own-metrics/alerts`;

    const preview = await api('POST', `${base}/preview`, {
      metricId: jobs,
      is: 'above',
      value: 500,
      forSeconds: 900,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toEqual({
      sentence: 'Queue jobs waiting on shop/worker is 612, above 500 for 15 min.',
      condition: 'above 500 for 15 min',
      holds: true,
    });
    const quiet = (
      await api('POST', `${base}/preview`, { metricId: jobs, is: 'above', value: 1000 })
    ).json();
    expect(quiet).toMatchObject({
      sentence: 'Queue jobs waiting on shop/worker is 612, above 1,000 for 5 min.',
      holds: false,
    });
    const old = (
      await api('POST', `${base}/preview`, { metricId: backup, is: 'older', value: 2 * 3600 })
    ).json();
    expect(old).toMatchObject({
      sentence: 'Backup last success is 3 h old, older than 2 h.',
      holds: true,
    });

    for (const [body, why] of [
      [{ metricId: jobs, is: 'above' }, /value to compare/],
      [{ metricId: jobs, is: 'older', value: 3600 }, /for timestamps/],
      [{ metricId: backup, is: 'above', value: 5 }, /"older than"/],
      [{ metricId: jobs, is: 'absent', value: 10 }, /a minute at least/],
      [{ metricId: jobs, is: 'unusual' }, /part of Pro/],
    ] as const) {
      const res = await api('POST', base, body);
      expect(res.statusCode, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(res.json().detail).toMatch(why);
    }
    expect((await api('POST', base, { metricId: newId(), is: 'above', value: 1 })).statusCode).toBe(
      404,
    );
    expect(
      (await api('POST', base, { metricId: jobs, is: 'above', value: 1, channelIds: [newId()] }))
        .statusCode,
    ).toBe(400);

    const viewer = await createUserSession(ctx.db, { role: 'viewer', orgId });
    expect(
      (await api('POST', base, { metricId: jobs, is: 'above', value: 500 }, viewer.cookie))
        .statusCode,
    ).toBe(403);
    const made = await api('POST', base, {
      metricId: jobs,
      is: 'above',
      value: 500,
      forSeconds: 900,
      severity: 'critical',
      name: 'Queue is backing up',
    });
    expect(made.statusCode, made.body).toBe(201);
    const unnamed = await api('POST', base, { metricId: backup, is: 'older', value: 26 * 3600 });
    expect(unnamed.json().name).toBe('Backup last success too old');

    const list = (await api('GET', base, undefined, viewer.cookie)).json();
    expect(list.allowed).toBe('threshold');
    expect(list.rules).toMatchObject([
      {
        id: made.json().id,
        name: 'Queue is backing up',
        metric: 'queue_jobs_waiting',
        metricId: jobs,
        is: 'above',
        value: 500,
        forSeconds: 900,
        severity: 'critical',
        condition: 'above 500 for 15 min',
        firing: 0,
        lastFiredAt: null,
        enabled: true,
      },
      {
        metric: 'backup_last_success_timestamp',
        is: 'older',
        value: 26 * 3600,
        forSeconds: 0,
        condition: 'older than 26 h',
      },
    ]);
    // They are ordinary rules: under Alerts with every other one, changed and silenced there.
    const all = (await api('GET', '/alert-rules')).json().rules;
    const row = all.find((r: { id: string }) => r.id === made.json().id);
    expect(row).toMatchObject({
      type: 'threshold',
      name: 'Queue is backing up',
      metric: null,
      clusterId,
      own: { metric: 'queue_jobs_waiting', is: 'above', per: null },
      condition: { op: '>', value: 500 },
      severity: 'critical',
    });
    expect((await api('PATCH', `/alert-rules/${row.id}`, { enabled: false })).statusCode).toBe(200);
    expect(
      (await api('PATCH', `/alert-rules/${row.id}`, { scope: { namespaces: ['x'] } })).statusCode,
    ).toBe(400);
    expect((await api('GET', base)).json().rules[0].enabled).toBe(false);
    expect((await api('DELETE', `${base}/${row.id}`, undefined, viewer.cookie)).statusCode).toBe(
      403,
    );
    expect((await api('DELETE', `${base}/${row.id}`)).statusCode).toBe(204);
    expect((await api('GET', base)).json().rules).toHaveLength(1);
  });

  it('Cloud Free: the tab says there are none, and the server refuses too', async () => {
    await write(line('jobs_waiting', {}, Date.now() - 5 * MIN, Date.now() - MIN, () => 1));
    const id = await metricId('jobs_waiting');
    plan(FREE);
    const base = `/clusters/${clusterId}/own-metrics/alerts`;
    expect((await api('GET', base)).json()).toMatchObject({
      allowed: 'none',
      rules: [],
      watched: { used: 0, max: 0 },
    });
    const res = await api('POST', base, { metricId: id, is: 'above', value: 1 });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: 'plan-limit', limit: 'own-alerts' });
    expect(
      (await api('POST', `${base}/preview`, { metricId: id, is: 'above', value: 1 })).statusCode,
    ).toBe(402);
    const watch = await api('PUT', `/clusters/${clusterId}/own-metrics/metrics/${id}/watch`, {
      watched: true,
    });
    expect(watch.statusCode).toBe(403);
    expect(watch.json().type).toBe('urn:watchlog:problem:pro-feature');
  });
});

describe('evaluation, by the engine every other rule uses', () => {
  it('fires for the workload over the value, names it, and resolves', async () => {
    await start();
    const A = Math.floor((Date.now() - 40 * MIN) / 30_000) * 30_000;
    await pod('worker-1', 'worker');
    await pod('mailer-1', 'mailer');
    await write([
      ...line('queue_jobs_waiting', { namespace: 'shop', pod: 'worker-1' }, A, A + 30 * MIN, (t) =>
        t < A + 20 * MIN ? 612 : 40,
      ),
      ...line(
        'queue_jobs_waiting',
        { namespace: 'shop', pod: 'mailer-1' },
        A,
        A + 30 * MIN,
        () => 20,
      ),
    ]);
    const made = await api('POST', `/clusters/${clusterId}/own-metrics/alerts`, {
      metricId: await metricId('queue_jobs_waiting'),
      is: 'above',
      value: 500,
      forSeconds: 0,
      name: 'Queue is backing up',
    });
    const clock = { now: A + 10 * MIN };
    const worker = testWorker(ctx.db, clock, lookupEvaluator, { victoria: vm });
    await worker.runCycle();
    expect(await states(made.json().id)).toMatchObject([
      {
        state: 'firing',
        severity: 'warning',
        fingerprint: 'own:queue_jobs_waiting:shop/worker',
        // The labels every page reads: it shows on shop/worker's page and in its Events.
        labels: {
          namespace: 'shop',
          workload: 'worker',
          workload_kind: 'Deployment',
          own_metric: 'queue_jobs_waiting',
        },
        details: {
          own: true,
          title: 'Queue jobs waiting on shop/worker is 612',
          why: 'above 500 · queue_jobs_waiting',
          value: 612,
          threshold: 500,
        },
      },
    ]);
    const alerts = (await api('GET', `/alerts?cluster=${clusterId}`)).json();
    expect(JSON.stringify(alerts)).toContain('Queue jobs waiting on shop/worker is 612');
    const rules = (await api('GET', `/clusters/${clusterId}/own-metrics/alerts`)).json().rules;
    expect(rules[0]).toMatchObject({ firing: 1 });
    expect(rules[0].lastFiredAt).not.toBeNull();
    // The queue drains: the alert resolves like any other.
    clock.now = A + 28 * MIN;
    await worker.runCycle();
    clock.now += MIN;
    await worker.runCycle();
    clock.now += MIN;
    await worker.runCycle();
    expect((await states(made.json().id)).map((s) => s.state)).toEqual(['resolved']);
    await worker.stop();
  });

  it('on a fleet: "older than" for a backup’s timestamp and "not reported for", on the server they name', async () => {
    await start('server');
    await ctx.db
      .insertInto('agent_instances')
      .values({
        id: newId(),
        cluster_id: clusterId,
        node: 'db-1',
        mode: 'docker',
        agent_version: '1',
        last_seen_at: new Date(),
      })
      .execute();
    const A = Math.floor((Date.now() - 6 * HOUR) / 30_000) * 30_000;
    await write([
      // The last good backup was at A; the exporter kept saying so for an hour, then stopped.
      ...line(
        'backup_last_success_timestamp_seconds',
        { instance: 'db-1:9100' },
        A,
        A + HOUR,
        () => A / 1000,
        MIN,
      ),
      ...line('gpu_temperature_celsius', { host: 'db-1' }, A, A + HOUR, () => 70, MIN),
    ]);
    const base = `/clusters/${clusterId}/own-metrics/alerts`;
    const older = (
      await api('POST', base, {
        metricId: await metricId('backup_last_success_timestamp_seconds'),
        is: 'older',
        value: 2 * 3600,
        severity: 'critical',
      })
    ).json();
    const absent = (
      await api('POST', base, {
        metricId: await metricId('gpu_temperature_celsius'),
        is: 'absent',
        value: 15 * 60,
      })
    ).json();
    const clock = { now: A + 30 * MIN };
    const worker = testWorker(ctx.db, clock, lookupEvaluator, { victoria: vm });
    await worker.runCycle();
    expect(await states(older.id)).toEqual([]);
    expect(await states(absent.id)).toEqual([]);
    clock.now = A + 3 * HOUR;
    await worker.runCycle();
    expect(await states(older.id)).toMatchObject([
      {
        state: 'firing',
        severity: 'critical',
        labels: { node: 'db-1', own_metric: 'backup_last_success_timestamp_seconds' },
        details: {
          title: 'Backup last success on db-1 is 3 h old',
          why: 'older than 2 h · backup_last_success_timestamp_seconds',
        },
      },
    ]);
    expect(await states(absent.id)).toMatchObject([
      {
        state: 'firing',
        labels: { node: 'db-1' },
        details: {
          title: 'Gpu temperature on db-1 has not reported for 2 h',
          why: 'alerts after 15 min · gpu_temperature_celsius',
        },
      },
    ]);
    await worker.stop();
  });

  it('a rule rests after a downgrade to Free, and when its metric is gone', async () => {
    await start();
    const A = Math.floor((Date.now() - 20 * MIN) / 30_000) * 30_000;
    await write(line('jobs_waiting', {}, A, A + 15 * MIN, () => 900));
    const made = (
      await api('POST', `/clusters/${clusterId}/own-metrics/alerts`, {
        metricId: await metricId('jobs_waiting'),
        is: 'above',
        value: 500,
        forSeconds: 0,
      })
    ).json();
    const clock = { now: A + 10 * MIN };
    const worker = testWorker(ctx.db, clock, lookupEvaluator, { victoria: vm });
    plan(FREE);
    const report = await worker.runCycle();
    expect(report.errors).toEqual([]);
    expect(await states(made.id)).toEqual([]);
    plan(COMMUNITY);
    await worker.runCycle();
    // Tied to nothing: the alert is the metric's own, named by it.
    expect(await states(made.id)).toMatchObject([
      {
        state: 'firing',
        fingerprint: 'own:jobs_waiting:',
        labels: { own_metric: 'jobs_waiting' },
        details: { title: 'Jobs waiting is 900' },
      },
    ]);
    await worker.stop();
  });
});

describe('Watch with What changed, and the usual range (Pro)', () => {
  it('learns a week, shows the range, draws the band, and alerts outside it', async () => {
    await start();
    plan(PRO);
    // The last sample is two minutes old, so a read now still sees it.
    const now = Math.floor(Date.now() / MIN) * MIN - 2 * MIN;
    // Nine days of a metric that is about 4 every hour, then 40 for the last 20 minutes.
    await write(
      line(
        'orders_per_minute',
        {},
        now - 9 * 24 * HOUR,
        now,
        (t) => (t > now - 20 * MIN ? 40 : 4 + ((t / (5 * MIN)) % 3) * 0.1),
        5 * MIN,
      ),
    );
    const id = await metricId('orders_per_minute');
    const base = `/clusters/${clusterId}/own-metrics`;
    // Not watched: no range, and "outside its usual range" asks to watch first.
    const before = (await api('GET', `${base}/metrics/${id}`)).json();
    expect(before.metric).toMatchObject({ watched: false, usual: null });
    const early = await api('POST', `${base}/alerts`, { metricId: id, is: 'unusual' });
    expect(early.statusCode).toBe(400);
    expect(early.json().detail).toMatch(/Watch this metric/);

    const viewer = await createUserSession(ctx.db, { role: 'viewer', orgId });
    expect(
      (await api('PUT', `${base}/metrics/${id}/watch`, { watched: true }, viewer.cookie))
        .statusCode,
    ).toBe(403);
    expect((await api('PUT', `${base}/metrics/${id}/watch`, { watched: true })).json()).toEqual({
      watched: true,
    });
    const m = (await api('GET', `${base}/metrics/${id}`)).json().metric;
    expect(m.watched).toBe(true);
    expect(m.usual.learning).toBe(false);
    // About 4 at every hour: the range is around it, far below the 40 of the last minutes.
    expect(m.usual.low).toBeLessThan(4.2);
    expect(m.usual.high).toBeGreaterThan(4);
    expect(m.usual.high).toBeLessThan(20);
    const to = Math.floor(now / 1000);
    const series = (
      await api('GET', `${base}/metrics/${id}/series?from=${to - 6 * 3600}&to=${to}`)
    ).json();
    expect(series.band.length).toBeGreaterThanOrEqual(6);
    expect(series.band[0][1]).toBeLessThan(4.2);
    expect(series.band[0][2]).toBeLessThan(20);
    // A split has no band.
    expect(
      (await api('GET', `${base}/metrics/${id}/series?from=${to - 3600}&to=${to}&by=x`)).json()
        .band,
    ).toBeNull();
    expect((await api('GET', `${base}/alerts`)).json().watched).toEqual({ used: 1, max: 50 });

    const rule = await api('POST', `${base}/alerts`, {
      metricId: id,
      is: 'unusual',
      forSeconds: 0,
    });
    expect(rule.statusCode, rule.body).toBe(201);
    const preview = (
      await api('POST', `${base}/alerts/preview`, { metricId: id, is: 'unusual', forSeconds: 0 })
    ).json();
    expect(preview.holds).toBe(true);
    expect(preview.sentence).toMatch(
      /^Orders per minute is 40, outside its usual [\d.]+ – [\d.]+ for this hour\.$/,
    );
    const clock = { now: now + MIN };
    const worker = testWorker(ctx.db, clock, lookupEvaluator, { victoria: vm });
    await worker.runCycle();
    const fired = await states(rule.json().id);
    expect(fired).toMatchObject([{ state: 'firing', details: { is: 'unusual', value: 40 } }]);
    expect((fired[0]!.details as { usualHigh: number }).usualHigh).toBeLessThan(20);
    // A licence or plan without the usual range: the rule rests.
    plan(COMMUNITY);
    clock.now += MIN;
    await worker.runCycle();
    clock.now += MIN;
    await worker.runCycle();
    clock.now += MIN;
    await worker.runCycle();
    expect((await states(rule.json().id)).map((s) => s.state)).toEqual(['resolved']);
    expect((await api('GET', `${base}/metrics/${id}`)).json().metric.usual).toBeNull();
    await worker.stop();
  });

  it('a metric younger than a week is learning; 50 watched at most; a timestamp has no range', async () => {
    await start();
    plan({ ...PRO, watched: 2 });
    const now = Date.now() - 2 * MIN;
    await write([
      ...line('young_gauge', {}, now - 2 * HOUR, now, () => 5, MIN),
      ...line('b_gauge', {}, now - 10 * MIN, now, () => 5, MIN),
      ...line('c_gauge', {}, now - 10 * MIN, now, () => 5, MIN),
      ...line('backup_timestamp', {}, now - 10 * MIN, now, () => now / 1000, MIN),
    ]);
    const base = `/clusters/${clusterId}/own-metrics`;
    const young = await metricId('young_gauge');
    expect((await api('PUT', `${base}/metrics/${young}/watch`, { watched: true })).statusCode).toBe(
      200,
    );
    expect((await api('GET', `${base}/metrics/${young}`)).json().metric.usual).toEqual({
      low: null,
      high: null,
      learning: true,
    });
    const to = Math.floor(now / 1000);
    expect(
      (await api('GET', `${base}/metrics/${young}/series?from=${to - 3600}&to=${to}`)).json().band,
    ).toBeNull();
    const ts = await api('PUT', `${base}/metrics/${await metricId('backup_timestamp')}/watch`, {
      watched: true,
    });
    expect(ts.statusCode).toBe(400);
    expect(
      (await api('PUT', `${base}/metrics/${await metricId('b_gauge')}/watch`, { watched: true }))
        .statusCode,
    ).toBe(200);
    const third = await api('PUT', `${base}/metrics/${await metricId('c_gauge')}/watch`, {
      watched: true,
    });
    expect(third.statusCode).toBe(409);
    expect(third.json().detail).toMatch(/2 metrics are watched already/);
    expect((await api('PUT', `${base}/metrics/${young}/watch`, { watched: false })).json()).toEqual(
      { watched: false },
    );
    expect(
      (await api('PUT', `${base}/metrics/${await metricId('c_gauge')}/watch`, { watched: true }))
        .statusCode,
    ).toBe(200);
  });
});
