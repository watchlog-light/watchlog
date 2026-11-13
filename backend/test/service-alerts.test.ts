// SPDX-License-Identifier: AGPL-3.0-only
// Alert rules for monitored services (v0.3 slice 5): the service catalog keys, the
// "service" scope and its checks, default rules created per service when monitoring
// starts (on or off as the connect drawer chose), alerts that name the service and what
// its collector said, cleanup on removal, and query_metric scoped to a service, on a
// Kubernetes cluster and a Docker fleet.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorisedScope, VictoriaQueryClient } from '../src/lib/victoria.js';
import { renderMessage } from '../src/modules/alerts/render.js';
import { lookupEvaluator } from '../src/modules/alerts/rules.js';
import { alertText } from '../src/modules/alerts/text.js';
import {
  TEST_VM_URL,
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { testWorker } from './support/alerts.js';
import { mcpClient, type McpTestClient } from './support/mcp.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `svc-alerts-${Date.now()}`;
const MIN = 60_000;
const A = Math.floor((Date.now() - 30 * MIN) / 15_000) * 15_000;
const vm = new VictoriaQueryClient(TEST_VM_URL);

let ctx: TestContext;
let cookie: string;
let mcp: McpTestClient | undefined;

const api = (method: string, url: string, payload?: object) =>
  ctx.app.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    cookies: { wl_session: cookie },
    ...(payload ? { payload } : {}),
  });

beforeEach(async () => {
  ctx = await createTestContext();
  cookie = await setupAdmin(ctx.app);
});
afterEach(async () => {
  await mcp?.close().catch(() => {});
  mcp = undefined;
  await closeTestContext(ctx);
});
afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
});

async function cluster(name: string, kind: 'kubernetes' | 'docker') {
  const res = await api('POST', '/clusters', { name, kind });
  return { id: res.json().cluster.id as string, token: res.json().token.value as string };
}

async function write(
  clusterId: string,
  name: string,
  labels: Record<string, string>,
  value: number,
) {
  const series: TestSeries[] = [];
  for (let t = A; t <= A + 25 * MIN; t += 15_000) {
    series.push({ labels: { __name__: name, run: RUN, ...labels }, value, timestampMs: t });
  }
  await vm.write(authorisedScope(clusterId), encode(series));
  await fetch(`${TEST_VM_URL}/internal/force_flush`);
}

const REDIS = {
  kind: 'workload',
  namespace: 'shop',
  workload_kind: 'StatefulSet',
  workload: 'redis',
  port: 6379,
};

describe('alert rules for services', () => {
  it('creates the defaults when monitoring starts, on or off as chosen', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    const defaults = (await api('GET', '/applications/alert-defaults?type=redis')).json().defaults;
    expect(defaults.map((d: { key: string }) => d.key)).toEqual([
      'unreachable',
      'slow_connect',
      'redis_memory_high',
      'redis_evicting',
      'redis_replica_down',
      'redis_save_failed',
      'redis_blocked_clients',
    ]);
    // A type without its own defaults (Elasticsearch, after the launch) gets the generic two.
    expect(
      (await api('GET', '/applications/alert-defaults?type=elasticsearch'))
        .json()
        .defaults.map((d: { key: string }) => d.key),
    ).toEqual(['unreachable', 'slow_connect']);
    const created = await api('POST', '/applications', {
      clusterId: k8s.id,
      type: 'redis',
      target: REDIS,
      defaultAlerts: ['unreachable'],
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().application.id as string;
    const rules = (await api('GET', '/alert-rules'))
      .json()
      .rules.filter((r: { service?: unknown }) => r.service);
    expect(rules).toHaveLength(7);
    expect(
      rules
        .filter((r: { enabled: boolean }) => r.enabled)
        .map((r: { defaultKey: string }) => r.defaultKey),
    ).toEqual(['unreachable']);
    expect(
      rules.find((r: { defaultKey: string }) => r.defaultKey === 'redis_replica_down'),
    ).toMatchObject({
      severity: 'critical',
      metric: 'redis.replica.down',
    });
    expect(
      rules.find((r: { metric: string }) => r.metric === 'service.reachable.ratio'),
    ).toMatchObject({
      type: 'threshold',
      enabled: true,
      clusterId: k8s.id,
      scope: { service: id },
      service: { id, name: 'shop/redis', type: 'redis' },
      appliesTo: ['kubernetes', 'docker'],
      condition: { op: '<', value: 1, critical: 0.01 },
    });
    expect(
      rules.find((r: { metric: string }) => r.metric === 'service.connect.time'),
    ).toMatchObject({
      enabled: false,
      unit: 'seconds',
    });

    // Removing the service removes its rules.
    expect((await api('DELETE', `/applications/${id}`)).statusCode).toBe(204);
    const left = (await api('GET', '/alert-rules'))
      .json()
      .rules.filter((r: { scope: { service?: string } }) => r.scope.service);
    expect(left).toEqual([]);
  });

  it('checks a service scope', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    const other = await cluster('other', 'kubernetes');
    const id = (
      await api('POST', '/applications', { clusterId: k8s.id, type: 'redis', target: REDIS })
    ).json().application.id as string;
    const rule = (over: object) => ({
      name: 'r',
      metric: 'service.reachable.ratio',
      clusterId: k8s.id,
      scope: { service: id },
      condition: { op: '<', value: 1 },
      forSeconds: 0,
      severity: 'warning',
      channelIds: [],
      ...over,
    });
    expect((await api('POST', '/alert-rules', rule({}))).statusCode).toBe(201);
    const bad: [object, RegExp][] = [
      [{ metric: 'pod.cpu.usage' }, /Scope "service" does not apply/],
      [{ scope: { service: id, host: 'h' } }, /Scope "host" does not apply to a service metric/],
      [{ clusterId: other.id }, /not in this cluster/],
      [{ scope: { service: '01a1c000-0000-7000-8000-00000000dead' } }, /not monitored/],
    ];
    for (const [over, msg] of bad) {
      const res = await api('POST', '/alert-rules', rule(over));
      expect(res.statusCode, JSON.stringify(over)).toBe(400);
      expect(res.json().detail).toMatch(msg);
    }
  });

  it('fires naming the service and what its collector said, on Kubernetes and Docker', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    const fleet = await cluster('docker-01', 'docker');
    const kid = (
      await api('POST', '/applications', {
        clusterId: k8s.id,
        type: 'redis',
        target: REDIS,
        defaultAlerts: ['unreachable', 'slow_connect'],
      })
    ).json().application.id as string;
    const did = (
      await api('POST', '/applications', {
        clusterId: fleet.id,
        type: 'postgres',
        target: {
          kind: 'compose',
          host: 'docker-01',
          compose_project: 'billing',
          compose_service: 'db',
          port: 5432,
        },
        defaultAlerts: ['unreachable'],
      })
    ).json().application.id as string;
    // The collectors' reports: one Redis pod down; the Postgres container unreachable.
    const status = (token: string, host: string, targets: object[]) =>
      ctx.app.inject({
        method: 'POST',
        url: '/ingest/v1/integrations/status',
        headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': 'integrations' },
        payload: {
          host,
          mode: host ? 'docker' : 'kubernetes',
          version: 't',
          config_version: '',
          self: {},
          targets,
        },
      });
    await status(k8s.token, '', [
      {
        id: kid,
        state: 'ok',
        members: [
          { name: 'redis-0', up: true },
          { name: 'redis-1', up: false, error: 'i/o timeout' },
        ],
      },
    ]);
    await status(fleet.token, 'docker-01', [
      { id: did, state: 'error', error: 'connection refused', members: [] },
    ]);
    const svc = (id: string, type: string) => ({ service: id, service_type: type });
    await write(k8s.id, 'watchlog_integration_up', { ...svc(kid, 'redis'), member: 'redis-0' }, 1);
    await write(k8s.id, 'watchlog_integration_up', { ...svc(kid, 'redis'), member: 'redis-1' }, 0);
    await write(
      k8s.id,
      'watchlog_integration_connect_seconds',
      { ...svc(kid, 'redis'), member: 'redis-0' },
      0.8,
    );
    await write(
      fleet.id,
      'watchlog_integration_up',
      { ...svc(did, 'postgres'), member: 'billing-db-1' },
      0,
    );

    const clock = { now: A + 10 * MIN };
    const worker = testWorker(ctx.db, clock, lookupEvaluator, { victoria: vm });
    // Past the rules' `for` (2 and 5 minutes).
    for (let i = 0; i < 12; i++) {
      await worker.runCycle();
      clock.now += 30_000;
    }
    await worker.stop();
    const states = await ctx.db
      .selectFrom('alert_states as s')
      .innerJoin('alert_rules as r', 'r.id', 's.rule_id')
      .select([
        'r.metric',
        'r.name',
        's.state',
        's.severity',
        's.labels',
        's.details',
        's.cluster_id',
      ])
      .where('s.state', '=', 'firing')
      .orderBy('r.metric')
      .execute();
    const byCluster = (id: string) => states.filter((s) => s.cluster_id === id);
    expect(
      byCluster(k8s.id)
        .map((s) => s.metric)
        .sort(),
    ).toEqual(['service.connect.time', 'service.reachable.ratio']);
    const half = byCluster(k8s.id).find((s) => s.metric === 'service.reachable.ratio')!;
    expect(half).toMatchObject({
      severity: 'warning',
      labels: { service: kid, service_type: 'redis', service_name: 'shop/redis' },
      details: { value: 0.5, reason: 'redis-1: i/o timeout' },
    });
    const down = byCluster(fleet.id)[0]!;
    expect(down).toMatchObject({
      severity: 'critical',
      labels: { service: did, service_type: 'postgres', service_name: 'billing/db' },
      details: { value: 0, reason: 'connection refused' },
    });

    // The words: the service by name, its value and threshold, and the collector's error.
    const text = alertText({
      ruleKey: null,
      ruleName: down.name,
      metric: down.metric,
      labels: down.labels as Record<string, string>,
      details: down.details as Record<string, unknown>,
      cluster: { name: 'docker-01' },
      now: clock.now,
    });
    expect(text).toEqual({
      title: 'Service unreachable: billing/db at 0 %',
      why: 'below 100 % · for 2 min · connection refused',
    });
    const msg = renderMessage(
      {
        kind: 'firing',
        severity: 'critical',
        at: new Date(clock.now).toISOString(),
        rule: { id: 'r', key: null, name: down.name, metric: down.metric },
        cluster: { id: fleet.id, name: 'docker-01', kind: 'docker' },
        items: [
          {
            labels: down.labels as Record<string, string>,
            details: down.details as Record<string, unknown>,
            startedAt: new Date(clock.now - 5 * MIN).toISOString(),
          },
        ],
        total: 1,
      } as Parameters<typeof renderMessage>[0],
      'https://watchlog.example.com',
    );
    expect(msg.items[0]!.where).toBe('PostgreSQL billing/db');
    expect(msg.items[0]!.link).toBe(
      `https://watchlog.example.com/applications/${did}?cluster=${fleet.id}`,
    );
  });

  it('answers query_metric for a service', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    const id = (
      await api('POST', '/applications', { clusterId: k8s.id, type: 'redis', target: REDIS })
    ).json().application.id as string;
    const now = Math.floor(Date.now() / 15_000) * 15_000;
    const series: TestSeries[] = [];
    for (let t = now - 20 * MIN; t <= now; t += 15_000) {
      series.push({
        labels: {
          __name__: 'watchlog_integration_connect_seconds',
          run: RUN,
          service: id,
          service_type: 'redis',
          member: 'redis-0',
        },
        value: 0.003,
        timestampMs: t,
      });
    }
    await vm.write(authorisedScope(k8s.id), encode(series));
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    mcp = await mcpClient(ctx, cookie);
    const res = await mcp.call('query_metric', {
      metric: 'service.connect.time',
      scope: { service: id },
      minutes: 30,
    });
    expect(res.isError, res.text).toBe(false);
    expect(res.data.series[0]).toMatchObject({ labels: { service: id, service_type: 'redis' } });
    expect(res.data.series[0].last).toBeCloseTo(0.003);
  });
});
