// SPDX-License-Identifier: AGPL-3.0-only
// The certificate and scheduled-job default rules (0.10.0, ADR-225), Servers and Kubernetes,
// against a real VictoriaMetrics with series shaped as the agents send them, evaluated on a
// fake clock in the written past (as alert-rules-metric.test.ts), enriched from stored rows.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorisedScope, VictoriaQueryClient } from '../src/lib/victoria.js';
import type { DefaultRule } from '../src/modules/alerts/defaults.js';
import { DEFAULT_RULES, ensureDefaultRules, lookupEvaluator } from '../src/modules/alerts/rules.js';
import { alertText } from '../src/modules/alerts/text.js';
import type { AlertWorker } from '../src/modules/alerts/worker.js';
import { TEST_VM_URL, closeTestContext, createTestContext, type TestContext } from './helpers.js';
import { createOrgCluster, testWorker } from './support/alerts.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `certs-jobs-${Date.now()}`;
const MIN = 60_000;
const DAY_S = 86_400;
const SCRAPE = 15_000;
const A = Math.floor((Date.now() - 40 * MIN) / SCRAPE) * SCRAPE;
const vm = new VictoriaQueryClient(TEST_VM_URL);

let ctx: TestContext;
let worker: AlertWorker;
let clusterId: string;
let orgId: string;
const clock = { now: A };

afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
});
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await worker.stop();
  await closeTestContext(ctx);
});

const rule = (key: string): DefaultRule => DEFAULT_RULES.find((r) => r.key === key)!;

async function setup(key: string, kind: 'kubernetes' | 'server' = 'server') {
  const created = await createOrgCluster(ctx.db, kind);
  clusterId = created.clusterId;
  orgId = created.orgId;
  worker = testWorker(ctx.db, clock, lookupEvaluator, {
    victoria: vm,
    prepareOrg: (id) => ensureDefaultRules(ctx.db, id, [rule(key)]),
  });
}

async function write(name: string, labels: Record<string, string>, value: (t: number) => number) {
  const series: TestSeries[] = [];
  for (let t = A; t <= A + 35 * MIN; t += SCRAPE) {
    series.push({
      labels: { __name__: name, run: RUN, ...labels },
      value: value(t),
      timestampMs: t,
    });
  }
  await vm.write(authorisedScope(clusterId), encode(series));
  await fetch(`${TEST_VM_URL}/internal/force_flush`);
}

async function evaluate(from: number, to: number) {
  for (clock.now = A + from * MIN; clock.now <= A + to * MIN; clock.now += 30_000) {
    const report = await worker.runCycle();
    expect(report.errors).toEqual([]);
  }
}

async function alerts() {
  return ctx.db
    .selectFrom('alert_states')
    .select(['state', 'fingerprint', 'severity', 'labels', 'details'])
    .orderBy('fingerprint')
    .orderBy('created_at')
    .execute();
}

async function storeCert(node: string, certId: string, name: string, notAfterS: number) {
  await ctx.db
    .insertInto('certificates')
    .values({
      org_id: orgId,
      cluster_id: clusterId,
      node,
      cert_id: certId,
      fingerprint: certId.repeat(4),
      names: [name],
      issuer: 'R11',
      issuer_org: "Let's Encrypt",
      not_before: new Date((notAfterS - 90 * DAY_S) * 1000),
      not_after: new Date(notAfterS * 1000),
      chain: 'complete',
      name_mismatch: ['www.' + name],
      endpoints: JSON.stringify([
        {
          kind: 'Service',
          workload: 'nginx.service',
          port: 443,
          proto: 'tls',
          fingerprint: certId.repeat(4),
          notAfter: notAfterS,
        },
      ]),
    })
    .execute();
}

async function storeJob(node: string, jobId: string, name: string, over: object = {}) {
  await ctx.db
    .insertInto('scheduled_jobs')
    .values({
      org_id: orgId,
      cluster_id: clusterId,
      node,
      job_id: jobId,
      kind: 'timer',
      name,
      enabled: true,
      state: 'failed',
      every_sec: DAY_S,
      last_good_at: new Date(A - 2 * DAY_S * 1000),
      ...over,
    })
    .execute();
  await ctx.db
    .insertInto('job_runs')
    .values({
      org_id: orgId,
      cluster_id: clusterId,
      node,
      job_id: jobId,
      started_at: new Date(A),
      ended_at: new Date(A + 4000),
      code: 2,
      result: 'failed',
    })
    .execute();
}

const s = (t: number) => t / 1000;

describe('certificate rules (ADR-225)', () => {
  it('cert.expiring: 14 days warns, 3 days is critical, a renewal resolves; 60 days never alerts', async () => {
    await setup('cert.expiring');
    const soon = { host: 'web-1', cert: 'shop.wl.test', cert_id: 'aaaaaaaaaaaaaaaa' };
    const later = { host: 'web-1', cert: 'api.wl.test', cert_id: 'bbbbbbbbbbbbbbbb' };
    const fine = { host: 'web-1', cert: 'ok.wl.test', cert_id: 'cccccccccccccccc' };
    // shop: 2 days left, renewed at A + 20 min; api: 9 days left; ok: 60 days.
    await write('watchlog_cert_expires_at_seconds', soon, (t) =>
      t < A + 20 * MIN ? s(A) + 2 * DAY_S : s(A) + 90 * DAY_S,
    );
    await write('watchlog_cert_expires_at_seconds', later, () => s(A) + 9 * DAY_S);
    await write('watchlog_cert_expires_at_seconds', fine, () => s(A) + 60 * DAY_S);
    await storeCert('web-1', 'aaaaaaaaaaaaaaaa', 'shop.wl.test', s(A) + 2 * DAY_S);
    await evaluate(5, 6);
    const firing = await alerts();
    expect(firing).toMatchObject([
      {
        state: 'firing',
        fingerprint: 'cert:web-1/aaaaaaaaaaaaaaaa',
        severity: 'critical',
        labels: { node: 'web-1', certificate: 'shop.wl.test' },
      },
      { state: 'firing', fingerprint: 'cert:web-1/bbbbbbbbbbbbbbbb', severity: 'warning' },
    ]);
    const d = firing[0]!.details as Record<string, unknown>;
    expect(d.servedAt).toEqual(['nginx.service :443']);
    const text = alertText({
      ruleKey: 'cert.expiring',
      ruleName: 'Certificate expiring',
      labels: firing[0]!.labels as Record<string, string>,
      details: d,
      cluster: { name: 'fleet' },
      now: A + 6 * MIN,
    });
    expect(text.title).toBe('The certificate for shop.wl.test expires in 2 days');
    expect(text.why).toContain('served at nginx.service :443');
    await evaluate(21, 22);
    expect((await alerts()).map((a) => `${a.fingerprint} ${a.state}`)).toEqual([
      'cert:web-1/aaaaaaaaaaaaaaaa resolved',
      'cert:web-1/bbbbbbbbbbbbbbbb firing',
    ]);
  });

  it('cert.problem on a Kubernetes cluster: a name mismatch held 10 minutes, labelled without a server', async () => {
    await setup('cert.problem', 'kubernetes');
    await write(
      'watchlog_cert_problem',
      { cert: 'shop.wl.test', cert_id: 'dddddddddddddddd', problem: 'name' },
      () => 1,
    );
    await storeCert('', 'dddddddddddddddd', 'shop.wl.test', s(A) + 60 * DAY_S);
    await evaluate(1, 5);
    expect((await alerts()).map((a) => a.state)).toEqual(['pending']); // held 10 minutes
    await evaluate(12, 13);
    const [a] = await alerts();
    expect(a).toMatchObject({
      state: 'firing',
      labels: { certificate: 'shop.wl.test', problem: 'name' },
    });
    expect((a!.details as { mismatch: string[] }).mismatch).toEqual(['www.shop.wl.test']);
  });
});

describe('scheduled job rules (ADR-225)', () => {
  it('job.failed: warns on a failure, critical at 3 in a row, resolves on a good run; a frequent job only at 3', async () => {
    await setup('job.failed');
    const backup = {
      host: 'worker-1',
      job: 'backup.timer',
      job_id: '1111111111111111',
      kind: 'timer',
    };
    const queue = { host: 'worker-1', job: 'queue', job_id: '2222222222222222', kind: 'cron' };
    await write('watchlog_job_failed_streak', backup, (t) =>
      t < A + 5 * MIN ? 0 : t < A + 15 * MIN ? 1 : t < A + 25 * MIN ? 3 : 0,
    );
    await write('watchlog_job_failed_streak', queue, (t) => (t < A + 15 * MIN ? 1 : 3));
    await storeJob('worker-1', '1111111111111111', 'backup.timer');
    await storeJob('worker-1', '2222222222222222', 'queue', {
      kind: 'cron',
      frequent: true,
      every_sec: 60,
    });
    await evaluate(6, 7);
    let all = await alerts();
    expect(all).toMatchObject([
      {
        state: 'firing',
        fingerprint: 'job:worker-1/1111111111111111',
        severity: 'warning',
        labels: { node: 'worker-1', job: 'backup.timer' },
      },
    ]);
    await evaluate(16, 17);
    all = await alerts();
    expect(all.map((a) => `${a.fingerprint} ${a.severity}`)).toEqual([
      'job:worker-1/1111111111111111 critical',
      'job:worker-1/2222222222222222 critical',
    ]);
    const text = alertText({
      ruleKey: 'job.failed',
      ruleName: 'Scheduled job failed',
      labels: all[0]!.labels as Record<string, string>,
      details: all[0]!.details as Record<string, unknown>,
      cluster: { name: 'fleet' },
      now: A + 17 * MIN,
    });
    expect(text.title).toBe('backup.timer failed 3 times in a row on worker-1');
    expect(text.why).toMatch(/^exit code 2 · last good run 2 d ago/);
    await evaluate(26, 27);
    expect((await alerts()).find((a) => a.fingerprint.includes('1111'))?.state).toBe('resolved');
  });

  it('job.failed on Kubernetes: a CronJob, by namespace', async () => {
    await setup('job.failed', 'kubernetes');
    await write(
      'watchlog_job_failed_streak',
      { namespace: 'shop', job: 'nightly', job_id: '3333333333333333', kind: 'cronjob' },
      () => 1,
    );
    await storeJob('', '3333333333333333', 'shop/nightly', { kind: 'cronjob' });
    await evaluate(2, 3);
    const [a] = await alerts();
    expect(a).toMatchObject({
      labels: { namespace: 'shop', workload: 'nightly', workload_kind: 'CronJob' },
      details: { exitCode: 2 },
    });
    expect(
      alertText({
        ruleKey: 'job.failed',
        ruleName: 'Scheduled job failed',
        labels: a!.labels as Record<string, string>,
        details: a!.details as Record<string, unknown>,
        cluster: { name: 'prod' },
        now: A + 3 * MIN,
      }).title,
    ).toBe('nightly failed in shop');
  });

  it('job.missed and job.slow fire with their facts', async () => {
    await setup('job.missed');
    const j = { host: 'worker-1', job: 'report.timer', job_id: '4444444444444444', kind: 'timer' };
    await write('watchlog_job_missed_runs', j, () => 1);
    await storeJob('worker-1', '4444444444444444', 'report.timer', {
      state: 'missed',
      schedule: '*-*-* 02:00:00',
      missed_at: new Date(A - 10 * MIN),
    });
    await evaluate(1, 2);
    const [m] = await alerts();
    expect(m).toMatchObject({ state: 'firing', details: { schedule: '*-*-* 02:00:00' } });
    expect(
      alertText({
        ruleKey: 'job.missed',
        ruleName: 'Scheduled job missed',
        labels: m!.labels as Record<string, string>,
        details: m!.details as Record<string, unknown>,
        cluster: { name: 'fleet' },
        now: A + 2 * MIN,
      }).title,
    ).toBe('report.timer missed its run on worker-1');

    await worker.stop();
    await closeTestContext(ctx);
    ctx = await createTestContext();
    await setup('job.slow');
    await write(
      'watchlog_job_slow',
      { ...j, job: 'export.php', job_id: '5555555555555555' },
      () => 1,
    );
    await storeJob('worker-1', '5555555555555555', 'export.php', {
      state: 'slow',
      usual_seconds: 60,
    });
    await evaluate(1, 2);
    const [sl] = await alerts();
    expect(sl).toMatchObject({ state: 'firing', details: { usualSeconds: 60, seconds: 4 } });
  });
});
