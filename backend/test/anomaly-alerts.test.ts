// SPDX-License-Identifier: AGPL-3.0-only
// Anomaly alerts (ADR-200; v0.8 slice 4) through the alert worker on an injectable clock, on
// Kubernetes and Docker: the default rule "Unusual for this hour" from the anomaly-worker's
// open periods (written here as the worker writes them), one alert per subject and metric,
// quiet for 30 minutes after a rollout (Kubernetes) or a re-create (Docker), the alert-key
// setting, the upkeep that adds the rule only for orgs with What changed and turns it off
// quietly on a downgrade; the messages in every channel; and the anomaly-worker honouring
// "normal for us" when it scores (synthetic minutes, never waited for).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db/index.js';
import { newId } from '../src/lib/ids.js';
import type { ClusterScope, QuerySeries } from '../src/lib/victoria.js';
import { slackBody, telegramText, webhookBody } from '../src/modules/alerts/channels.js';
import { ensureDefaultRules, lookupEvaluator } from '../src/modules/alerts/rules.js';
import type { NotifyCause } from '../src/modules/alerts/likely-cause.js';
import type { MessagePayload } from '../src/modules/alerts/outbox.js';
import { renderMessage } from '../src/modules/alerts/render.js';
import { alertText } from '../src/modules/alerts/text.js';
import type { AlertWorker } from '../src/modules/alerts/worker.js';
import {
  ANOMALY_RULE_KEY,
  bucketWords,
  ensureAnomalyRule,
  parseAlertKeys,
  rangeWords,
  setAnomalyAlertKeys,
  setAnomalyGate,
  valueWords,
} from '../src/modules/anomaly/alerts.js';
import { runAnomalyMinute } from '../src/modules/anomaly/jobs.js';
import { alertWindow, readPeriods } from '../src/modules/anomaly/read.js';
import { queriesFor, seriesHash, subjectOf } from '../src/modules/anomaly/keys.js';
import { bucketOf, DEFAULT_RULE, widenedSpread } from '../src/modules/anomaly/stats.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';
import { createOrgCluster, insertChannel, testWorker } from './support/alerts.js';

const MIN = 60_000;
const DAY = 86_400_000;
/** A Tuesday, 14:10 UTC. */
const T0 = Date.UTC(2026, 10, 17, 14, 10, 0);

const CHECKOUT = { namespace: 'shop', workload_kind: 'Deployment', workload: 'checkout' };
/** The per-server HTTP keys name the destination. */
const CHECKOUT_DST = {
  dst_kind: 'workload',
  dst_namespace: 'shop',
  dst_workload: 'checkout',
  dst_workload_kind: 'Deployment',
};
const WEB = { container: 'shop-web-1', host: 'docker-01' };

let ctx: TestContext;
let worker: AlertWorker | undefined;
const clock = { now: T0 };
let entitled = true;

beforeEach(async () => {
  ctx = await createTestContext();
  clock.now = T0;
  entitled = true;
  setAnomalyGate(async () => entitled);
  setAnomalyAlertKeys(parseAlertKeys(undefined));
});
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await closeTestContext(ctx);
  setAnomalyGate(async () => false);
  setAnomalyAlertKeys(parseAlertKeys(undefined));
});

async function setup(kind: 'kubernetes' | 'docker') {
  const { orgId, clusterId } = await createOrgCluster(ctx.db, kind);
  worker = testWorker(ctx.db, clock, lookupEvaluator, {
    prepareOrg: async (id) => {
      await ensureDefaultRules(ctx.db, id);
      await ensureAnomalyRule(ctx.db, id, entitled);
    },
  });
  if (kind === 'docker') {
    // The fleet's container list: shop-web-1 and shop-web-2 are the Compose service shop/web.
    for (const name of ['shop-web-1', 'shop-web-2']) {
      await ctx.db
        .insertInto('objects')
        .values({
          id: newId(),
          org_id: orgId,
          cluster_id: clusterId,
          source: 'docker',
          kind: 'DockerContainer',
          namespace: 'shop',
          name,
          node: 'docker-01',
          uid: newId(),
          spec_summary: JSON.stringify({ compose_service: 'web', image: 'shop/web:1' }),
          status_summary: JSON.stringify({ state: 'running' }),
        })
        .execute();
    }
  }
  return { orgId, clusterId };
}

interface P {
  metric: string;
  subject: Record<string, string>;
  startedAt: number;
  usual: [number, number];
  median: number;
  last: number;
  peak?: number;
}

/** An open unusual period, as the anomaly-worker writes it. */
async function period(db: Database, orgId: string, clusterId: string, p: P) {
  const subject = subjectOf(p.subject);
  const row = await db
    .insertInto('anomaly_periods')
    .values({
      org_id: orgId,
      cluster_id: clusterId,
      series_hash: seriesHash(p.metric, subject),
      metric: p.metric,
      subject: JSON.stringify(subject),
      started_at: new Date(p.startedAt),
      bucket: bucketOf(p.startedAt),
      median: p.median,
      usual_low: p.usual[0],
      usual_high: p.usual[1],
      peak_score: 12,
      peak_value: p.peak ?? p.last,
      peak_at: new Date(p.startedAt + 5 * MIN),
      last_value: p.last,
      last_at: new Date(p.startedAt + 9 * MIN),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

const P95: Omit<P, 'startedAt'> = {
  metric: 'workload.http.latency.p95',
  subject: CHECKOUT_DST,
  usual: [0.12, 0.18],
  median: 0.15,
  last: 2.4,
};
const DOCKER_MEM: Omit<P, 'startedAt'> = {
  metric: 'container.memory.working_set',
  subject: WEB,
  usual: [200 * 2 ** 20, 260 * 2 ** 20],
  median: 230 * 2 ** 20,
  last: 900 * 2 ** 20,
};

async function anomalyAlerts(clusterId: string) {
  return ctx.db
    .selectFrom('alert_states as s')
    .innerJoin('alert_rules as r', 'r.id', 's.rule_id')
    .select(['s.id', 's.fingerprint', 's.state', 's.labels', 's.details', 's.started_at'])
    .where('r.rule_key', '=', ANOMALY_RULE_KEY)
    .where('s.cluster_id', '=', clusterId)
    .orderBy('s.fingerprint')
    .execute();
}

async function cycle(at: number) {
  clock.now = at;
  const r = await worker!.runCycle();
  // The metric rules have no VictoriaMetrics here; the anomaly rule reads PostgreSQL only.
  expect(r.errors.filter((e) => !e.includes('VictoriaMetrics is not configured'))).toEqual([]);
}

async function anomalyRule(orgId: string) {
  return ctx.db
    .selectFrom('alert_rules')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('rule_key', '=', ANOMALY_RULE_KEY)
    .executeTakeFirst();
}

function words(a: { labels: unknown; details: unknown }) {
  return alertText({
    ruleKey: ANOMALY_RULE_KEY,
    ruleName: 'Unusual for this hour',
    labels: a.labels as Record<string, string>,
    details: a.details as Record<string, unknown>,
    cluster: { name: 'prod' },
    now: clock.now,
  });
}

describe('the rule: one alert per subject and metric', () => {
  it('Kubernetes: an unusual p95 opens "Unusual for this hour" once, in the workload\'s labels; it ends with its period', async () => {
    const { orgId, clusterId } = await setup('kubernetes');
    const hook = await insertChannel(ctx.db, orgId, 'webhook', { url: 'https://x.test/h' });
    await cycle(T0);
    const rule = (await anomalyRule(orgId))!;
    expect(rule).toMatchObject({
      name: 'Unusual for this hour',
      severity: 'warning',
      enabled: true,
    });
    await ctx.db
      .updateTable('alert_rules')
      .set({ channel_ids: [hook] })
      .where('id', '=', rule.id)
      .execute();
    const id = await period(ctx.db, orgId, clusterId, { ...P95, startedAt: T0 - 10 * MIN });
    // Another metric of the same workload is its own alert.
    await period(ctx.db, orgId, clusterId, {
      metric: 'workload.cpu.usage',
      subject: CHECKOUT,
      usual: [0.1, 0.3],
      median: 0.2,
      last: 1.6,
      startedAt: T0 - 10 * MIN,
    });
    await cycle(T0 + MIN);
    await cycle(T0 + 2 * MIN);
    await cycle(T0 + 3 * MIN);
    const list = await anomalyAlerts(clusterId);
    expect(list.map((a) => [a.fingerprint, a.state])).toEqual([
      ['anomaly:shop/checkout/Deployment:workload.cpu.usage', 'firing'],
      ['anomaly:workload/shop/checkout/Deployment:workload.http.latency.p95', 'firing'],
    ]);
    const p95 = list[1]!;
    expect(p95.labels).toEqual({
      namespace: 'shop',
      workload_kind: 'Deployment',
      workload: 'checkout',
      metric: 'workload.http.latency.p95',
    });
    // The period's start is the alert's (probable cause's symptom time).
    expect(p95.started_at.getTime()).toBe(T0 - 10 * MIN);
    expect(words(p95)).toEqual({
      title: 'checkout (shop): p95 response time unusual for a Tuesday at 14:00 UTC',
      why: 'usual for Tuesday 14:00 UTC: 120–180 ms; now 2.4 s',
    });
    // Fired once: one message for each alert, however many cycles.
    const sent = await ctx.db
      .selectFrom('notifications')
      .select(['kind'])
      .where('rule_id', '=', rule.id)
      .execute();
    expect(sent.map((n) => n.kind)).toEqual(['firing']);

    // The period ends: the alert resolves.
    await ctx.db
      .updateTable('anomaly_periods')
      .set({ ended_at: new Date(T0 + 4 * MIN) })
      .where('id', '=', id)
      .execute();
    await cycle(T0 + 5 * MIN);
    await cycle(T0 + 6 * MIN);
    const after = await anomalyAlerts(clusterId);
    expect(after.find((a) => a.fingerprint.endsWith('latency.p95'))!.state).toBe('resolved');
  });

  it('Docker: a container named with its Compose service and its host', async () => {
    const { orgId, clusterId } = await setup('docker');
    await cycle(T0);
    await period(ctx.db, orgId, clusterId, { ...DOCKER_MEM, startedAt: T0 - 10 * MIN });
    await cycle(T0 + MIN);
    await cycle(T0 + 2 * MIN);
    const [a] = await anomalyAlerts(clusterId);
    expect(a!.state).toBe('firing');
    expect(a!.fingerprint).toBe('anomaly:shop-web-1/docker-01:container.memory.working_set');
    expect(a!.labels).toEqual({
      node: 'docker-01',
      container: 'shop-web-1',
      metric: 'container.memory.working_set',
    });
    expect(a!.details).toMatchObject({ compose: { project: 'shop', service: 'web' } });
    expect(words(a!)).toEqual({
      title: 'web (shop): memory unusual for a Tuesday at 14:00 UTC',
      why: 'usual for Tuesday 14:00 UTC: 200–260 MiB; now 900 MiB',
    });
  });
});

describe('quiet for 30 minutes after a rollout (ADR-200)', () => {
  it('Kubernetes: a rollout 10 minutes before keeps it quiet until 30 minutes after the rollout', async () => {
    const { orgId, clusterId } = await setup('kubernetes');
    const rollout = T0 - 10 * MIN;
    await ctx.db
      .insertInto('change_markers')
      .values({
        id: newId(),
        org_id: orgId,
        cluster_id: clusterId,
        kind: 'rollout',
        target: 'Deployment/shop/checkout',
        namespace: 'shop',
        details: JSON.stringify({ from: 4, to: 5 }),
        ts: new Date(rollout),
      })
      .execute();
    // Another workload's rollout doesn't count.
    await ctx.db
      .insertInto('change_markers')
      .values({
        id: newId(),
        org_id: orgId,
        cluster_id: clusterId,
        kind: 'rollout',
        target: 'Deployment/shop/payments',
        namespace: 'shop',
        ts: new Date(rollout),
      })
      .execute();
    await period(ctx.db, orgId, clusterId, { ...P95, startedAt: rollout + 2 * MIN });
    await period(ctx.db, orgId, clusterId, {
      metric: 'node.cpu.utilization',
      subject: { node: 'worker-1' },
      usual: [0.2, 0.4],
      median: 0.3,
      last: 0.95,
      startedAt: rollout + 2 * MIN,
    });
    await cycle(T0);
    await cycle(T0 + 10 * MIN);
    expect((await anomalyAlerts(clusterId)).map((a) => a.fingerprint)).toEqual([
      'anomaly:worker-1:node.cpu.utilization',
    ]);
    // 30 minutes after the rollout, still unusual: it opens, from the period's start.
    await cycle(rollout + 30 * MIN + 30_000);
    const list = await anomalyAlerts(clusterId);
    const p95 = list.find((a) => a.fingerprint.endsWith('latency.p95'))!;
    expect(p95.state).toBe('firing');
    expect(p95.started_at.getTime()).toBe(rollout + 2 * MIN);
    // An open alert stays open through a later rollout.
    await ctx.db
      .insertInto('change_markers')
      .values({
        id: newId(),
        org_id: orgId,
        cluster_id: clusterId,
        kind: 'image',
        target: 'Deployment/shop/checkout',
        namespace: 'shop',
        ts: new Date(clock.now),
      })
      .execute();
    await cycle(clock.now + MIN);
    expect((await anomalyAlerts(clusterId)).find((a) => a.id === p95.id)!.state).toBe('firing');
  });

  it('Docker: a re-created container of the same Compose service, or a Compose change, keeps it quiet', async () => {
    const { orgId, clusterId } = await setup('docker');
    // The other replica of shop/web was re-created: the service changed.
    const recreate = T0 - 5 * MIN;
    await ctx.db
      .insertInto('change_markers')
      .values({
        id: newId(),
        org_id: orgId,
        cluster_id: clusterId,
        kind: 'recreate',
        target: 'Container/docker-01/shop-web-2',
        namespace: 'shop',
        details: JSON.stringify({ image: 'shop/web:2' }),
        ts: new Date(recreate),
      })
      .execute();
    await period(ctx.db, orgId, clusterId, { ...DOCKER_MEM, startedAt: T0 - 10 * MIN });
    await cycle(T0);
    await cycle(T0 + 20 * MIN);
    expect(await anomalyAlerts(clusterId)).toEqual([]);
    await cycle(recreate + 31 * MIN);
    expect((await anomalyAlerts(clusterId)).map((a) => a.state)).toEqual(['firing']);

    // A Compose change of the project quiets a new period of another container in it.
    await ctx.db
      .insertInto('change_markers')
      .values({
        id: newId(),
        org_id: orgId,
        cluster_id: clusterId,
        kind: 'compose',
        target: 'Compose/docker-01/shop',
        namespace: 'shop',
        ts: new Date(clock.now),
      })
      .execute();
    await period(ctx.db, orgId, clusterId, {
      ...DOCKER_MEM,
      subject: { container: 'shop-web-2', host: 'docker-01' },
      startedAt: clock.now - 10 * MIN,
    });
    await cycle(clock.now + MIN);
    expect(await anomalyAlerts(clusterId)).toHaveLength(1);
  });
});

/** Another rule's alert firing on a subject (no evaluator here, so the cycles leave it). */
async function otherAlert(
  orgId: string,
  clusterId: string,
  labels: Record<string, string>,
  startedAt: number,
) {
  const ruleId = newId();
  await ctx.db
    .insertInto('alert_rules')
    .values({
      id: ruleId,
      org_id: orgId,
      name: 'Queue growing',
      type: 'default',
      rule_key: `test.other.${ruleId.slice(-6)}`,
      severity: 'critical',
    })
    .execute();
  const id = newId();
  await ctx.db
    .insertInto('alert_states')
    .values({
      id,
      org_id: orgId,
      rule_id: ruleId,
      cluster_id: clusterId,
      fingerprint: `other:${id}`,
      state: 'firing',
      severity: 'critical',
      labels: JSON.stringify(labels),
      started_at: new Date(startedAt),
      fired_at: new Date(startedAt + 5 * MIN),
    })
    .execute();
  return {
    id,
    resolve: (at: number) =>
      ctx.db
        .updateTable('alert_states')
        .set({ state: 'resolved', resolved_at: new Date(at) })
        .where('id', '=', id)
        .execute(),
  };
}

/** The rows the other alert's "What changed around it" card lists (its window, now). */
async function cardRows(
  orgId: string,
  clusterId: string,
  kind: 'kubernetes' | 'docker',
  since: number,
) {
  const w = alertWindow(since, clock.now);
  const r = await readPeriods(
    ctx.db,
    orgId,
    { id: clusterId, kind },
    w,
    { fromMs: w.fromMs, toMs: w.toMs, stepS: 60 },
    'first',
    clock.now,
    false,
  );
  return r.rows.map((row) => row.key);
}

describe('no anomaly alert while another alert fires on the subject (ADR-200, slice 7b)', () => {
  it("Kubernetes: the workload's crash-loop alert holds back its unusual p95; it opens when that resolves; a monitored service the same", async () => {
    const { orgId, clusterId } = await setup('kubernetes');
    await cycle(T0);
    const since = T0 - 20 * MIN;
    const crash = await otherAlert(
      orgId,
      clusterId,
      { ...CHECKOUT, pod: 'checkout-7d9-abc', node: 'worker-1' },
      since,
    );
    // RabbitMQ (slice 7's 47.7 duplicates a day): the queue's alert and its own series.
    const queue = await otherAlert(orgId, clusterId, { service: 'int-rabbit' }, since);
    // A node alert is about the node, not the workloads on it.
    await otherAlert(orgId, clusterId, { node: 'worker-1' }, since);
    await period(ctx.db, orgId, clusterId, { ...P95, startedAt: T0 - 10 * MIN });
    await period(ctx.db, orgId, clusterId, {
      metric: 'rabbitmq.messages.ready',
      subject: { service: 'int-rabbit' },
      usual: [0, 20],
      median: 5,
      last: 4000,
      startedAt: T0 - 10 * MIN,
    });
    const PAYMENTS = { namespace: 'shop', workload_kind: 'Deployment', workload: 'payments' };
    await period(ctx.db, orgId, clusterId, {
      metric: 'workload.cpu.usage',
      subject: PAYMENTS,
      usual: [0.1, 0.3],
      median: 0.2,
      last: 1.6,
      startedAt: T0 - 10 * MIN,
    });
    await cycle(T0 + MIN);
    await cycle(T0 + 2 * MIN);
    expect((await anomalyAlerts(clusterId)).map((a) => a.fingerprint)).toEqual([
      'anomaly:shop/payments/Deployment:workload.cpu.usage',
    ]);
    // Still listed: on the page's window and on the crash-loop alert's card.
    expect((await cardRows(orgId, clusterId, 'kubernetes', since)).sort()).toEqual([
      'rabbitmq.messages.ready',
      'workload.cpu.usage',
      'workload.http.latency.p95',
    ]);

    // The crash loop resolves while the p95 stays unusual: its alert opens, from the
    // period's start; the queue's alert still holds back the queue's.
    await crash.resolve(T0 + 4 * MIN);
    await cycle(T0 + 5 * MIN);
    const list = await anomalyAlerts(clusterId);
    expect(list.map((a) => [a.fingerprint, a.state])).toEqual([
      ['anomaly:shop/payments/Deployment:workload.cpu.usage', 'firing'],
      ['anomaly:workload/shop/checkout/Deployment:workload.http.latency.p95', 'firing'],
    ]);
    expect(list[1]!.started_at.getTime()).toBe(T0 - 10 * MIN);
    await queue.resolve(T0 + 6 * MIN);
    await cycle(T0 + 7 * MIN);
    expect((await anomalyAlerts(clusterId)).map((a) => a.fingerprint)).toContain(
      'anomaly:int-rabbit:rabbitmq.messages.ready',
    );

    // An anomaly alert already open stays open when another alert starts on its subject.
    await otherAlert(orgId, clusterId, PAYMENTS, T0 + 7 * MIN);
    await cycle(T0 + 13 * MIN);
    expect((await anomalyAlerts(clusterId)).every((a) => a.state === 'firing')).toBe(true);
  });

  it("Docker: an alert on the container, on another container of its Compose service, or on the Compose service holds it back; a host alert doesn't", async () => {
    const { orgId, clusterId } = await setup('docker');
    await cycle(T0);
    const since = T0 - 20 * MIN;
    // shop-web-2 is the other replica of the Compose service shop/web.
    const replica = await otherAlert(
      orgId,
      clusterId,
      { node: 'docker-01', container: 'shop-web-2' },
      since,
    );
    const service = await otherAlert(
      orgId,
      clusterId,
      { compose_project: 'shop', compose_service: 'web' },
      since,
    );
    await otherAlert(orgId, clusterId, { node: 'docker-01', mount: '/' }, since);
    await period(ctx.db, orgId, clusterId, { ...DOCKER_MEM, startedAt: T0 - 10 * MIN });
    // A plain container on the same host: only the host alert names it, and that doesn't count.
    await period(ctx.db, orgId, clusterId, {
      ...DOCKER_MEM,
      subject: { container: 'cron-1', host: 'docker-01' },
      startedAt: T0 - 10 * MIN,
    });
    await cycle(T0 + MIN);
    expect((await anomalyAlerts(clusterId)).map((a) => a.fingerprint)).toEqual([
      'anomaly:cron-1/docker-01:container.memory.working_set',
    ]);
    expect(await cardRows(orgId, clusterId, 'docker', since)).toHaveLength(2);

    // One of the two resolves: the other still holds it back.
    await replica.resolve(T0 + 2 * MIN);
    await cycle(T0 + 3 * MIN);
    expect(await anomalyAlerts(clusterId)).toHaveLength(1);
    await service.resolve(T0 + 4 * MIN);
    await cycle(T0 + 5 * MIN);
    const list = await anomalyAlerts(clusterId);
    expect(list.map((a) => [a.fingerprint, a.state])).toEqual([
      ['anomaly:cron-1/docker-01:container.memory.working_set', 'firing'],
      ['anomaly:shop-web-1/docker-01:container.memory.working_set', 'firing'],
    ]);
    expect(list[1]!.started_at.getTime()).toBe(T0 - 10 * MIN);
  });
});

describe('the alert-key setting (ADR-200: narrow which keys alert, no daily cap)', () => {
  it('parses patterns; the default leaves the map edges out', () => {
    const def = parseAlertKeys(undefined);
    expect(def('workload.http.latency.p95')).toBe(true);
    expect(def('container.memory.working_set')).toBe(true);
    expect(def('redis.ops.rate')).toBe(true);
    expect(def('edge.connections.rate')).toBe(false);
    const only = parseAlertKeys('workload.http.*, container.*');
    expect(only('workload.http.errors.ratio')).toBe(true);
    expect(only('node.cpu.utilization')).toBe(false);
    expect(parseAlertKeys('*')('edge.http.latency.p95')).toBe(true);
    expect(() => parseAlertKeys('workload.{cpu}')).toThrow(/WATCHLOG_ANOMALY_ALERT_KEYS/);
  });

  for (const kind of ['kubernetes', 'docker'] as const) {
    it(`${kind}: an edge's period is listed but doesn't alert by default; a narrowed list holds back the rest`, async () => {
      const { orgId, clusterId } = await setup(kind);
      const edge: Record<string, string> =
        kind === 'kubernetes'
          ? {
              ...CHECKOUT,
              dst_kind: 'workload',
              dst_namespace: 'shop',
              dst_workload: 'db',
              dst_workload_kind: 'StatefulSet',
            }
          : { container: 'shop-web-1', dst_kind: 'container', dst: 'shop-db-1' };
      await period(ctx.db, orgId, clusterId, {
        metric: 'edge.connections.rate',
        subject: edge,
        usual: [1, 3],
        median: 2,
        last: 80,
        startedAt: T0 - 10 * MIN,
      });
      const main = kind === 'kubernetes' ? P95 : DOCKER_MEM;
      await period(ctx.db, orgId, clusterId, { ...main, startedAt: T0 - 10 * MIN });
      await cycle(T0);
      expect((await anomalyAlerts(clusterId)).map((a) => a.labels)).toEqual([
        expect.objectContaining({ metric: main.metric }),
      ]);
      setAnomalyAlertKeys(parseAlertKeys('*'));
      await cycle(T0 + MIN);
      expect(await anomalyAlerts(clusterId)).toHaveLength(2);
    });
  }
});

describe('the upkeep (ADR-200, ADR-204): Pro only, no manual step', () => {
  for (const kind of ['kubernetes', 'docker'] as const) {
    it(`${kind}: Pro gets the rule; Free never; a downgrade turns it off and ends its alerts without a message; Pro again turns it back on`, async () => {
      const { orgId, clusterId } = await setup(kind);
      // Free (or Community): the default rules, never the anomaly rule.
      entitled = false;
      await cycle(T0);
      expect(await anomalyRule(orgId)).toBeUndefined();
      expect(
        (await ctx.db.selectFrom('alert_rules').select('id').where('org_id', '=', orgId).execute())
          .length,
      ).toBeGreaterThan(5);
      // An upgrade (or the 0.8.0 deploy for a Pro org): added on the next cycle.
      entitled = true;
      await cycle(T0 + MIN);
      const rule = (await anomalyRule(orgId))!;
      expect(rule.enabled).toBe(true);
      const hook = await insertChannel(ctx.db, orgId, 'webhook', { url: 'https://x.test/h' });
      await ctx.db
        .updateTable('alert_rules')
        .set({ channel_ids: [hook] })
        .where('id', '=', rule.id)
        .execute();
      await period(ctx.db, orgId, clusterId, {
        ...(kind === 'kubernetes' ? P95 : DOCKER_MEM),
        startedAt: T0 - 10 * MIN,
      });
      await cycle(T0 + 2 * MIN);
      expect((await anomalyAlerts(clusterId)).map((a) => a.state)).toEqual(['firing']);
      // A downgrade: turned off, the alert ends, no resolved message.
      entitled = false;
      await cycle(T0 + 3 * MIN);
      expect(await anomalyRule(orgId)).toMatchObject({ enabled: false, plan_paused: true });
      expect((await anomalyAlerts(clusterId)).map((a) => a.state)).toEqual(['resolved']);
      const kinds = await ctx.db
        .selectFrom('notifications')
        .select('kind')
        .where('rule_id', '=', rule.id)
        .execute();
      expect(kinds.map((k) => k.kind)).toEqual(['firing']);
      // Pro again: back on. A rule the org turned off itself stays off.
      entitled = true;
      await cycle(T0 + 4 * MIN);
      expect(await anomalyRule(orgId)).toMatchObject({ enabled: true, plan_paused: false });
      await ctx.db
        .updateTable('alert_rules')
        .set({ enabled: false })
        .where('id', '=', rule.id)
        .execute();
      await cycle(T0 + 5 * MIN);
      expect((await anomalyRule(orgId))!.enabled).toBe(false);
    });
  }

  it('the evaluator itself refuses an org without What changed (a Free org that turned the row on)', async () => {
    const { orgId, clusterId } = await setup('kubernetes');
    await cycle(T0);
    entitled = false;
    await period(ctx.db, orgId, clusterId, { ...P95, startedAt: T0 - 10 * MIN });
    // The upkeep would turn it off; skip it and turn the row on by hand.
    await worker!.stop();
    worker = testWorker(ctx.db, clock, lookupEvaluator);
    await ctx.db
      .updateTable('alert_rules')
      .set({ enabled: true })
      .where('org_id', '=', orgId)
      .where('rule_key', '=', ANOMALY_RULE_KEY)
      .execute();
    await cycle(T0 + MIN);
    expect(await anomalyAlerts(clusterId)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------ messages

const BASE = 'https://watchlog.example.com';
const AT = '2026-11-17T14:15:00.000Z';
const cause: NotifyCause = {
  rule: 'connections_held',
  code: 'connections_held',
  facts: {},
  since: '2026-11-17T13:58:00.000Z',
  headline: { code: 'connections_held', facts: {} },
  subject: 'workload:shop/Deployment/checkout',
  text: "reports-worker holds 85 of postgres's 100 connections.",
  chain: [],
};

function payload(
  kind: 'kubernetes' | 'docker',
  labels: Record<string, string>,
  details: Record<string, unknown>,
  withCause = true,
): MessagePayload {
  return {
    version: 1,
    kind: 'firing',
    severity: 'warning',
    rule: { id: 'rule-1', key: ANOMALY_RULE_KEY, name: 'Unusual for this hour' },
    cluster: { id: 'c-1', name: kind === 'docker' ? 'edge-fleet' : 'acme-prod', kind },
    items: [
      {
        alertId: 'a-1',
        severity: 'warning',
        labels,
        details,
        startedAt: '2026-11-17T14:02:00.000Z',
        firedAt: '2026-11-17T14:02:00.000Z',
        resolvedAt: null,
        ...(withCause ? { likelyCause: cause } : {}),
      },
    ],
    total: 1,
    at: AT,
  };
}

const KUBE_LABELS = { ...CHECKOUT, metric: 'workload.http.latency.p95' };
const KUBE_DETAILS = {
  key: 'workload.http.latency.p95',
  unit: 'seconds',
  bucket: 2 * 24 + 14,
  usualLow: 0.12,
  usualHigh: 0.18,
  value: 2.4,
  subject: 'checkout (shop)',
};
const DOCKER_LABELS = {
  node: 'docker-01',
  container: 'shop-web-1',
  metric: 'container.memory.working_set',
};
const DOCKER_DETAILS = {
  key: 'container.memory.working_set',
  unit: 'bytes',
  bucket: 2 * 24 + 14,
  usualLow: 200 * 2 ** 20,
  usualHigh: 260 * 2 ** 20,
  value: 900 * 2 ** 20,
  subject: 'web (shop)',
};

describe('messages in every channel (ADR-200, ADR-095)', () => {
  it('words: weekday and hour of the bucket, values in their units', () => {
    expect(bucketWords(0)).toEqual({ day: 'Sunday', hour: '00:00' });
    expect(bucketWords(2 * 24 + 14)).toEqual({ day: 'Tuesday', hour: '14:00' });
    expect(bucketWords(167)).toEqual({ day: 'Saturday', hour: '23:00' });
    expect(rangeWords(0.12, 0.18, 'seconds')).toBe('120–180 ms');
    expect(rangeWords(0.5, 1.5, 'seconds')).toBe('500 ms–1.5 s');
    expect(valueWords(2.4, 'seconds')).toBe('2.4 s');
    expect(rangeWords(0.02, 0.05, 'ratio')).toBe('2–5 %');
    expect(rangeWords(1.5, 3, 'per_second')).toBe('1.5–3/s');
    expect(valueWords(0.25, 'cores')).toBe('0.25 cores');
  });

  it('Kubernetes, email: the title, "usual for …; now …", where and since, the likely cause, the alert link', () => {
    const p = payload('kubernetes', KUBE_LABELS, KUBE_DETAILS);
    const m = renderMessage(p, BASE);
    expect(m.subject).toBe(
      '[WARNING] checkout (shop): p95 response time unusual for a Tuesday at 14:00 UTC (acme-prod)',
    );
    expect(m.text).toBe(
      [
        '🟠 WARNING · checkout (shop): p95 response time unusual for a Tuesday at 14:00 UTC',
        '',
        'usual for Tuesday 14:00 UTC: 120–180 ms; now 2.4 s',
        'shop/checkout (Deployment) · cluster acme-prod · since 14:02 UTC (13 min)',
        "Likely cause: reports-worker holds 85 of postgres's 100 connections.",
        `${BASE}/alerts/a-1`,
      ].join('\n'),
    );
  });

  it('Kubernetes, Slack, Telegram and webhook: the same words', () => {
    const p = payload('kubernetes', KUBE_LABELS, KUBE_DETAILS);
    const m = renderMessage(p, BASE);
    const slack = JSON.stringify(slackBody(m, p));
    expect(slack).toContain(
      'checkout (shop): p95 response time unusual for a Tuesday at 14:00 UTC',
    );
    expect(slack).toContain('usual for Tuesday 14:00 UTC: 120–180 ms; now 2.4 s');
    expect(slack).toContain('Likely cause:');
    const tg = telegramText(m);
    expect(tg).toContain(
      '<b>🟠 WARNING · checkout (shop): p95 response time unusual for a Tuesday at 14:00 UTC</b>',
    );
    expect(tg).toContain('usual for Tuesday 14:00 UTC: 120–180 ms; now 2.4 s');
    expect(tg).toContain(`<a href="${BASE}/alerts/a-1"`);
    const w = webhookBody(p, m, Date.parse(AT)) as { alerts: Record<string, unknown>[] };
    expect(w.alerts[0]).toMatchObject({
      labels: KUBE_LABELS,
      title: 'checkout (shop): p95 response time unusual for a Tuesday at 14:00 UTC',
      why: 'usual for Tuesday 14:00 UTC: 120–180 ms; now 2.4 s',
      likelyCause: { rule: 'connections_held' },
    });
  });

  it('Docker: the Compose service in the title, the host and container in where, every channel', () => {
    const p = payload('docker', DOCKER_LABELS, DOCKER_DETAILS, false);
    const m = renderMessage(p, BASE);
    expect(m.items[0]).toMatchObject({
      title: 'web (shop): memory unusual for a Tuesday at 14:00 UTC',
      why: 'usual for Tuesday 14:00 UTC: 200–260 MiB; now 900 MiB',
      where: 'docker-01/shop-web-1',
      context: 'docker-01/shop-web-1 · cluster edge-fleet · since 14:02 UTC (13 min)',
      cause: null,
      link: `${BASE}/alerts/a-1`,
    });
    expect(m.subject).toBe(
      '[WARNING] web (shop): memory unusual for a Tuesday at 14:00 UTC (edge-fleet)',
    );
    expect(JSON.stringify(slackBody(m, p))).toContain('200–260 MiB; now 900 MiB');
    expect(telegramText(m)).toContain('docker-01/shop-web-1');
    const w = webhookBody(p, m, Date.parse(AT)) as { alerts: Record<string, unknown>[] };
    expect(w.alerts[0]).toMatchObject({ labels: DOCKER_LABELS });
  });

  it('a plain container and a host read in Docker words; a node in Kubernetes words', () => {
    const t = (labels: Record<string, string>, d: Record<string, unknown>) =>
      alertText({
        ruleKey: ANOMALY_RULE_KEY,
        ruleName: 'Unusual for this hour',
        labels,
        details: d,
        cluster: { name: 'x' },
        now: 0,
      });
    const base = { bucket: 1 * 24 + 9, usualLow: 0.2, usualHigh: 0.4, value: 0.95, unit: 'ratio' };
    expect(
      t(
        { node: 'docker-01', metric: 'host.cpu.utilization' },
        { ...base, key: 'host.cpu.utilization' },
      ).title,
    ).toBe('host docker-01: CPU unusual for a Monday at 09:00 UTC');
    expect(
      t(
        { node: 'worker-1', metric: 'node.cpu.utilization' },
        { ...base, key: 'node.cpu.utilization' },
      ).title,
    ).toBe('node worker-1: CPU unusual for a Monday at 09:00 UTC');
    expect(
      t(
        { node: 'docker-01', container: 'redis', metric: 'container.cpu.usage' },
        { ...base, unit: 'cores', key: 'container.cpu.usage' },
      ),
    ).toEqual({
      title: 'redis: CPU unusual for a Monday at 09:00 UTC',
      why: 'usual for Monday 09:00 UTC: 0.20–0.40 cores; now 0.95 cores',
    });
  });
});

// ------------------------------------------------------------------------------ the worker

/** A VictoriaMetrics answering one series of one key with a value per minute. */
function oneSeries(key: string, labels: Record<string, string>, valueAt: (t: number) => number) {
  return {
    async queryRange(
      _scope: ClusterScope,
      expr: string,
      start: number,
      end: number,
    ): Promise<QuerySeries[]> {
      const q = queriesFor('kubernetes', []).concat(queriesFor('docker', []));
      if (!q.some((x) => x.key === key && x.expr === expr)) return [];
      const points: [number, number | null][] = [];
      for (let t = start; t <= end; t += 60) points.push([t, valueAt(t * 1000)]);
      return [{ labels, points }];
    },
  };
}

describe('"normal for us" in the scoring (ADR-200)', () => {
  for (const kind of ['kubernetes', 'docker'] as const) {
    it(`${kind}: the widening keeps the same value from scoring past 4 in that hour only; undone, it opens again`, async () => {
      const { orgId, clusterId } = await setup(kind);
      const [key, labels, med, mad, value] =
        kind === 'kubernetes'
          ? (['workload.http.latency.p95', CHECKOUT_DST, 0.15, 0.01, 2.4] as const)
          : ([
              'container.memory.working_set',
              WEB,
              230 * 2 ** 20,
              5 * 2 ** 20,
              900 * 2 ** 20,
            ] as const);
      const subject = subjectOf(labels);
      const hash = seriesHash(key, subject);
      await ctx.db
        .insertInto('anomaly_baselines')
        .values({
          org_id: orgId,
          cluster_id: clusterId,
          series_hash: hash,
          metric: key,
          subject: JSON.stringify(subject),
          medians: Array(168).fill(med),
          mads: Array(168).fill(mad),
          minutes: Array(168).fill(120),
          first_seen: new Date(T0 - 10 * DAY),
          last_seen: new Date(T0),
        })
        .execute();
      const deps = {
        db: ctx.db,
        systemDb: ctx.db,
        victoria: oneSeries(key, labels, () => value),
        orgs: async () => [orgId],
        log: { warn: () => {} },
      };
      const open = () =>
        ctx.db
          .selectFrom('anomaly_periods')
          .select(['id', 'bucket'])
          .where('cluster_id', '=', clusterId)
          .where('ended_at', 'is', null)
          .execute();
      // Unusual: a period opens.
      const now = T0 + 20 * MIN;
      expect((await runAnomalyMinute(deps, now)).opened).toBe(1);
      const [p] = await open();
      const bucket = bucketOf(now);
      expect(p!.bucket).toBe(bucket);
      // "Normal for us": the spread to keep, then the period ends (the route does both).
      const fb = await ctx.db
        .insertInto('anomaly_feedback')
        .values({
          org_id: orgId,
          cluster_id: clusterId,
          series_hash: hash,
          metric: key,
          subject: JSON.stringify(subject),
          bucket,
          answer: 'normal',
          value,
          median: med,
          min_spread: widenedSpread(value, med, DEFAULT_RULE),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await ctx.db
        .updateTable('anomaly_periods')
        .set({ ended_at: new Date(now) })
        .where('id', '=', p!.id)
        .execute();
      expect((await runAnomalyMinute(deps, now + MIN)).opened).toBe(0);
      expect((await runAnomalyMinute(deps, now + 5 * MIN)).opened).toBe(0);
      // Exactly that bucket: the next hour's scoring isn't widened.
      const nextHour = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000 + 15 * MIN;
      expect((await runAnomalyMinute(deps, nextHour)).opened).toBe(1);
      await ctx.db.deleteFrom('anomaly_periods').where('cluster_id', '=', clusterId).execute();
      // Undo: the same value in the same hour opens again.
      await ctx.db
        .updateTable('anomaly_feedback')
        .set({ undone_at: new Date(now + 6 * MIN) })
        .where('id', '=', fb.id)
        .execute();
      expect((await runAnomalyMinute(deps, now + 7 * MIN)).opened).toBe(1);
    });
  }
});
