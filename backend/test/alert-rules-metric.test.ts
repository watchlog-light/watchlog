// SPDX-License-Identifier: AGPL-3.0-only
// One trigger + resolve test per metric default rule against a real VictoriaMetrics
// (ADR-072, ADR-086). Series are written for the last 40 minutes and evaluated on a
// fake clock in that past, so VictoriaMetrics' latency offset (30 s in CI) never hides
// the newest samples.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VictoriaQueryClient } from '../src/lib/victoria.js';
import type { DefaultRule } from '../src/modules/alerts/defaults.js';
import { DEFAULT_RULES, ensureDefaultRules, lookupEvaluator } from '../src/modules/alerts/rules.js';
import type { AlertWorker } from '../src/modules/alerts/worker.js';
import { TEST_VM_URL, closeTestContext, createTestContext, type TestContext } from './helpers.js';
import { createOrgCluster, testWorker } from './support/alerts.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `alerts-${Date.now()}`;
const MIN = 60_000;
const SCRAPE = 15_000;
/** Start of the written history; tests evaluate between A and A + 35 min. */
const A = Math.floor((Date.now() - 40 * MIN) / SCRAPE) * SCRAPE;
const vm = new VictoriaQueryClient(TEST_VM_URL);

let ctx: TestContext;
let worker: AlertWorker;
let clusterId: string;
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

async function setup(key: string, kind: 'kubernetes' | 'docker' = 'kubernetes') {
  const created = await createOrgCluster(ctx.db, kind);
  clusterId = created.clusterId;
  worker = testWorker(ctx.db, clock, lookupEvaluator, {
    victoria: vm,
    prepareOrg: (id) => ensureDefaultRules(ctx.db, id, [rule(key)]),
  });
}

/** Writes one series per label set, a sample every 15 s from A to A + 35 min. */
async function write(
  name: string,
  labels: Record<string, string>,
  value: (t: number) => number,
): Promise<void> {
  const series: TestSeries[] = [];
  for (let t = A; t <= A + 35 * MIN; t += SCRAPE) {
    series.push({
      labels: { __name__: name, run: RUN, ...labels },
      value: value(t),
      timestampMs: t,
    });
  }
  await vm.write({ clusterId }, encode(series));
  await fetch(`${TEST_VM_URL}/internal/force_flush`); // make fresh samples searchable
}

/** A counter growing at `rate(t)` per second. */
function counter(rate: (t: number) => number): (t: number) => number {
  return (t) => {
    let v = 0;
    for (let s = A; s < t; s += SCRAPE) v += rate(s) * (SCRAPE / 1000);
    return v;
  };
}

/** Runs cycles every 30 s from `from` to `to` (minutes after A). */
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

describe('metric rules: trigger and resolve', () => {
  it('network.connections.failed: half of the connections failing for 5 min fires, recovery resolves', async () => {
    await setup('network.connections.failed');
    const edge = {
      namespace: 'shop',
      workload_kind: 'Deployment',
      workload: 'frontend',
      dst_kind: 'workload',
      dst_namespace: 'shop',
      dst_workload_kind: 'Deployment',
      dst_workload: 'cart',
      dst_service: 'cart',
      dst_port: '8080',
    };
    // 2 connections a second; half of them refused for the first 15 minutes (cart
    // scaled to 0), none afterwards.
    await write(
      'watchlog_flow_connections_total',
      edge,
      counter(() => 2),
    );
    await write(
      'watchlog_flow_connect_failed_total',
      edge,
      counter((t) => (t < A + 15 * MIN ? 1 : 0)),
    );
    // An idle edge whose only connection fails is not an outage.
    const idle = { ...edge, dst_workload: 'audit', dst_service: 'audit' };
    await write(
      'watchlog_flow_connections_total',
      idle,
      counter(() => 0.01),
    );
    await write(
      'watchlog_flow_connect_failed_total',
      idle,
      counter(() => 0.01),
    );
    await evaluate(3, 6);
    expect((await alerts()).map((a) => a.state)).toEqual(['pending']);
    await evaluate(8.5, 12);
    expect(await alerts()).toMatchObject([
      {
        state: 'firing',
        fingerprint: 'flow:shop/frontend>workload:shop/cart',
        labels: { workload: 'frontend', dst_workload: 'cart', dst_kind: 'workload' },
        details: { value: 0.5, threshold: 0.05 },
      },
    ]);
    await evaluate(16, 21);
    expect((await alerts()).map((a) => a.state)).toEqual(['resolved']);
  });

  it('node.cpu.high: a node above 90 % for 10 min fires, below resolves', async () => {
    await setup('node.cpu.high');
    // Busy 95 % for the first 20 minutes, then 10 %.
    const busy = (t: number) => (t < A + 20 * MIN ? 0.95 : 0.1);
    await write(
      'watchlog_node_cpu_seconds_total',
      { node: 'worker-1', mode: 'user' },
      counter(busy),
    );
    await write(
      'watchlog_node_cpu_seconds_total',
      { node: 'worker-1', mode: 'idle' },
      counter((t) => 1 - busy(t)),
    );
    await write(
      'watchlog_node_cpu_seconds_total',
      { node: 'worker-2', mode: 'idle' },
      counter(() => 1),
    );
    await evaluate(3, 12);
    expect((await alerts()).map((a) => a.state)).toEqual(['pending']);
    await evaluate(13.5, 19);
    expect(await alerts()).toMatchObject([
      {
        state: 'firing',
        fingerprint: 'node:worker-1',
        severity: 'warning',
        labels: { node: 'worker-1' },
        details: { summary: 'CPU 95 %' },
      },
    ]);
    await evaluate(20, 25);
    expect((await alerts()).map((a) => a.state)).toEqual(['resolved']);
  });

  it('node.disk.usage: warning above 85 %, escalates above 95 %, per mount, on a Docker host', async () => {
    await setup('node.disk.usage', 'docker');
    const avail = (t: number) => (t < A + 10 * MIN ? 10 : t < A + 20 * MIN ? 3 : 50);
    for (const mount of ['/', '/data']) {
      await write(
        'watchlog_node_filesystem_bytes',
        { host: 'host-1', mount, state: 'size' },
        () => 100,
      );
      await write(
        'watchlog_node_filesystem_bytes',
        { host: 'host-1', mount, state: 'avail' },
        mount === '/' ? avail : () => 60,
      );
    }
    await evaluate(5, 6);
    expect(await alerts()).toMatchObject([
      {
        state: 'firing',
        fingerprint: 'host:host-1:/',
        severity: 'warning',
        labels: { node: 'host-1', mount: '/' },
        details: { summary: '/ 90 % used' },
      },
    ]);
    await evaluate(15, 16);
    expect(await alerts()).toMatchObject([{ state: 'firing', severity: 'critical' }]);
    const sent = await ctx.db
      .selectFrom('alert_states')
      .select('notify_seq')
      .executeTakeFirstOrThrow();
    expect(sent.notify_seq).toBe(2); // firing, then escalated
    await evaluate(25, 26);
    expect((await alerts()).map((a) => a.state)).toEqual(['resolved']);
  });

  it('node.disk.usage: a disk filling steadily says when it will be full (ADR-095)', async () => {
    await setup('node.disk.usage');
    // 86 % at A rising 6 points an hour: 89.5 % after 35 min.
    const used = (t: number) => 0.86 + (0.06 * (t - A)) / 3_600_000;
    await write(
      'watchlog_node_filesystem_bytes',
      { node: 'worker-7', mount: '/var', state: 'size' },
      () => 1e9,
    );
    await write(
      'watchlog_node_filesystem_bytes',
      { node: 'worker-7', mount: '/var', state: 'avail' },
      (t) => 1e9 * (1 - used(t)),
    );
    await evaluate(30, 30);
    const [a] = await alerts();
    expect(a!.details).toMatchObject({ risePerHour: 6, threshold: 0.85 });
    // (1 - 0.89) / 6 % per hour ≈ 1.8 h, in 10-minute steps.
    expect((a!.details as { fullInSeconds: number }).fullInSeconds).toBeGreaterThanOrEqual(6000);
    expect((a!.details as { fullInSeconds: number }).fullInSeconds).toBeLessThanOrEqual(7200);
  });

  it('k8s.pvc.usage: a PVC above 85 % fires and resolves when space is freed', async () => {
    await setup('k8s.pvc.usage');
    const pvc = { namespace: 'wl-test', persistentvolumeclaim: 'data-db-0' };
    await write('watchlog_pod_volume_bytes', { ...pvc, state: 'capacity' }, () => 1000);
    await write('watchlog_pod_volume_bytes', { ...pvc, state: 'used' }, (t) =>
      t < A + 10 * MIN ? 900 : 500,
    );
    await evaluate(5, 6);
    expect(await alerts()).toMatchObject([
      {
        state: 'firing',
        fingerprint: 'pvc:wl-test/data-db-0',
        labels: { namespace: 'wl-test', pvc: 'data-db-0' },
        details: { summary: '90 % used' },
      },
    ]);
    await evaluate(15, 16);
    expect((await alerts()).map((a) => a.state)).toEqual(['resolved']);
  });

  it('k8s.container.throttling: throttled > 25 % for 15 min fires per workload container', async () => {
    await setup('k8s.container.throttling');
    const labels = {
      namespace: 'wl-test',
      workload_kind: 'Deployment',
      workload: 'web',
      container: 'nginx',
    };
    for (const pod of ['web-1', 'web-2']) {
      await write(
        'watchlog_container_cpu_seconds_total',
        { ...labels, pod },
        counter(() => 0.5),
      );
      await write(
        'watchlog_container_cpu_throttled_seconds_total',
        { ...labels, pod },
        counter((t) => (t < A + 25 * MIN ? 0.2 : 0)),
      );
    }
    await evaluate(3, 17);
    expect((await alerts()).map((a) => a.state)).toEqual(['pending']);
    await evaluate(18.5, 24);
    expect(await alerts()).toMatchObject([
      {
        state: 'firing',
        fingerprint: 'pod:wl-test/Deployment/web:nginx',
        details: { summary: 'nginx: throttled 40 % of its CPU time' },
      },
    ]);
    await evaluate(25, 30);
    expect((await alerts()).map((a) => a.state)).toEqual(['resolved']);
  });

  it('docker.container.restarts: more than 3 restarts in 10 min fires, a quiet container resolves', async () => {
    await setup('docker.container.restarts', 'docker');
    // One restart a minute until A + 15 min, then none.
    const restarts = (t: number) => Math.floor((Math.min(t, A + 15 * MIN) - A) / MIN);
    await write(
      'watchlog_container_restarts_total',
      { host: 'host-1', container: 'fx-crashloop' },
      restarts,
    );
    await write(
      'watchlog_container_restarts_total',
      { host: 'host-1', container: 'steady' },
      () => 2,
    );
    await evaluate(10, 11);
    expect(await alerts()).toMatchObject([
      {
        state: 'firing',
        fingerprint: 'docker:host-1/fx-crashloop',
        labels: { node: 'host-1', container: 'fx-crashloop' },
      },
    ]);
    await evaluate(25, 26);
    expect((await alerts()).map((a) => a.state)).toEqual(['resolved']);
  });

  it('keeps alerts when VictoriaMetrics is unreachable and reports the error', async () => {
    await setup('k8s.pvc.usage');
    const pvc = { namespace: 'wl-test', persistentvolumeclaim: 'data' };
    await write('watchlog_pod_volume_bytes', { ...pvc, state: 'capacity' }, () => 100);
    await write('watchlog_pod_volume_bytes', { ...pvc, state: 'used' }, () => 99);
    await evaluate(5, 5);
    await worker.stop();
    worker = testWorker(ctx.db, clock, lookupEvaluator, {
      victoria: new VictoriaQueryClient('http://127.0.0.1:9', 1000, 1000),
    });
    for (let i = 0; i < 3; i++) {
      const report = await worker.runCycle();
      expect(report.errors[0]).toMatch(/VictoriaMetrics unreachable/);
      clock.now += 30_000;
    }
    expect((await alerts()).map((a) => a.state)).toEqual(['firing']);
  });
});
