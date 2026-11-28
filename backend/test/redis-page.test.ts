// SPDX-License-Identifier: AGPL-3.0-only
// The Redis page (v0.3 slice 7, SPEC §4.12): its tabs filled from the collector's Redis
// series, the slow log and clients from its status mapped to workloads and containers,
// the reasons, per-panel permission notes, the list's numbers, the Redis default rules
// with "Reset to default", and one of them firing, on Kubernetes and Docker.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { authorisedScope, VictoriaQueryClient } from '../src/lib/victoria.js';
import { lookupEvaluator } from '../src/modules/alerts/rules.js';
import { reasonSentence } from '../src/modules/mcp/tools/applications.js';
import {
  TEST_VM_URL,
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { testWorker } from './support/alerts.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `redis-page-${Date.now()}`;
const MIN = 60_000;
const NOW = Math.floor(Date.now() / 15_000) * 15_000;
const vm = new VictoriaQueryClient(TEST_VM_URL);

let ctx: TestContext;
let cookie: string;

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
afterEach(() => closeTestContext(ctx));
afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
});

async function cluster(name: string, kind: 'kubernetes' | 'server') {
  const res = await api('POST', '/clusters', { name, kind });
  return { id: res.json().cluster.id as string, token: res.json().token.value as string };
}

/** 30 minutes of a series, every 15 s, from `value(i)`. */
async function write(
  clusterId: string,
  name: string,
  labels: Record<string, string>,
  value: (i: number) => number,
) {
  const series: TestSeries[] = [];
  for (let i = 0, t = NOW - 30 * MIN; t <= NOW; i++, t += 15_000) {
    series.push({
      labels: { __name__: name, run: RUN, ...labels },
      value: value(i),
      timestampMs: t,
    });
  }
  await vm.write(authorisedScope(clusterId), encode(series));
}

async function status(token: string, host: string, targets: object[]) {
  const r = await ctx.app.inject({
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
  expect(r.statusCode, r.body).toBe(204);
}

async function pod(clusterId: string, ns: string, name: string, workload: string, ip: string) {
  await ctx.db
    .insertInto('objects')
    .values({
      id: newId(),
      cluster_id: clusterId,
      source: 'kubernetes',
      kind: 'Pod',
      namespace: ns,
      name,
      uid: newId(),
      node: 'w1',
      spec_summary: JSON.stringify({ workload: { kind: 'Deployment', name: workload } }),
      status_summary: JSON.stringify({ pod_ip: ip, phase: 'Running' }),
    })
    .execute();
}

const REDIS = {
  kind: 'workload',
  namespace: 'shop',
  workload_kind: 'StatefulSet',
  workload: 'redis',
  port: 6379,
};

describe('the Redis page', () => {
  it('fills every tab, says what is wrong, and names the clients (Kubernetes)', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    await pod(k8s.id, 'shop', 'checkout-7d9f', 'checkout', '10.244.1.7');
    const id = (
      await api('POST', '/applications', {
        clusterId: k8s.id,
        type: 'redis',
        target: REDIS,
        defaultAlerts: ['redis_memory_high'],
      })
    ).json().application.id as string;
    const slowlog = [
      {
        at: Math.floor(NOW / 1000) - 120,
        usec: 250_000,
        member: 'redis-0',
        command: 'KEYS session:*',
        client: '10.244.1.7',
      },
      {
        at: Math.floor(NOW / 1000) - 60,
        usec: 1500,
        member: 'redis-0',
        command: 'GET cart:*',
        client: '10.244.9.9',
      },
    ];
    await status(k8s.token, '', [
      {
        id,
        state: 'ok',
        service_version: '7.2.5',
        members: [
          { name: 'redis-0', up: true },
          { name: 'redis-1', up: true },
        ],
        permissions: [{ tab: 'memory/prefixes', missing: '+scan +memory|usage ~*' }],
        extra: {
          slowlog,
          clients: [
            { addr: '10.244.1.7', connections: 12, member: 'redis-0' },
            { addr: '10.244.9.9', connections: 3, member: 'redis-0' },
          ],
          // CLIENT LIST per address (1.4): a subscriber near its pubsub buffer limit.
          client_detail: [
            {
              addr: '10.244.1.7',
              connections: 12,
              blocked: 0,
              subscribed: 0,
              young: 1,
              idle: 0,
              omem: 0,
              limit: 0,
              class: 'normal',
              cmd: 'get',
              name: '',
              member: 'redis-0',
            },
            {
              addr: '10.244.9.9',
              connections: 3,
              blocked: 1,
              subscribed: 1,
              young: 0,
              idle: 4,
              omem: 30e6,
              limit: 33554432,
              class: 'pubsub',
              cmd: 'subscribe',
              name: 'notifier',
              member: 'redis-0',
            },
          ],
        },
      },
    ]);
    const svc = (member: string, extra: Record<string, string> = {}) => ({
      service: id,
      service_type: 'redis',
      member,
      ...extra,
    });
    const GB = 2 ** 30;
    await Promise.all([
      write(k8s.id, 'watchlog_redis_memory_used_bytes', svc('redis-0'), () => 0.95 * GB),
      write(k8s.id, 'watchlog_redis_memory_max_bytes', svc('redis-0'), () => GB),
      write(k8s.id, 'watchlog_redis_memory_rss_bytes', svc('redis-0'), () => 1.1 * GB),
      write(k8s.id, 'watchlog_redis_memory_dataset_bytes', svc('redis-0'), () => 0.8 * GB),
      write(k8s.id, 'watchlog_redis_memory_overhead_bytes', svc('redis-0'), () => 0.15 * GB),
      write(k8s.id, 'watchlog_redis_mem_fragmentation_ratio', svc('redis-0'), () => 1.16),
      write(
        k8s.id,
        'watchlog_redis_maxmemory_policy_info',
        svc('redis-0', { policy: 'allkeys-lru' }),
        () => 1,
      ),
      write(k8s.id, 'watchlog_redis_keyspace_hits_total', svc('redis-0'), (i) => i * 900),
      write(k8s.id, 'watchlog_redis_keyspace_misses_total', svc('redis-0'), (i) => i * 100),
      write(k8s.id, 'watchlog_redis_commands_processed_total', svc('redis-0'), (i) => i * 1500),
      write(k8s.id, 'watchlog_redis_evicted_keys_total', svc('redis-0'), (i) => i * 10),
      write(k8s.id, 'watchlog_redis_connected_clients', svc('redis-0'), () => 15),
      write(k8s.id, 'watchlog_redis_blocked_clients', svc('redis-0'), () => 2),
      write(k8s.id, 'watchlog_redis_maxclients', svc('redis-0'), () => 100),
      write(k8s.id, 'watchlog_redis_keys', svc('redis-0', { db: 'db0' }), () => 1000),
      write(k8s.id, 'watchlog_redis_keys_expiring', svc('redis-0', { db: 'db0' }), () => 250),
      write(
        k8s.id,
        'watchlog_redis_command_calls_total',
        svc('redis-0', { command: 'get' }),
        (i) => i * 1000,
      ),
      write(
        k8s.id,
        'watchlog_redis_command_usec_total',
        svc('redis-0', { command: 'get' }),
        (i) => i * 2000,
      ),
      write(
        k8s.id,
        'watchlog_redis_command_calls_total',
        svc('redis-0', { command: 'keys' }),
        (i) => i,
      ),
      write(
        k8s.id,
        'watchlog_redis_command_usec_total',
        svc('redis-0', { command: 'keys' }),
        (i) => i * 250_000,
      ),
      write(
        k8s.id,
        'watchlog_redis_command_latency_bucket',
        svc('redis-0', { le: '1e-06' }),
        () => 10,
      ),
      write(
        k8s.id,
        'watchlog_redis_command_latency_bucket',
        svc('redis-0', { le: '8e-06' }),
        () => 90,
      ),
      write(
        k8s.id,
        'watchlog_redis_command_latency_bucket',
        svc('redis-0', { le: '0.001' }),
        () => 100,
      ),
      write(k8s.id, 'watchlog_redis_rdb_last_save_ok', svc('redis-0'), () => 0),
      write(
        k8s.id,
        'watchlog_redis_rdb_last_save_timestamp_seconds',
        svc('redis-0'),
        () => NOW / 1000 - 3600,
      ),
      write(k8s.id, 'watchlog_redis_is_primary', svc('redis-0'), () => 1),
      write(
        k8s.id,
        'watchlog_redis_replica_online',
        svc('redis-0', { replica: 'slave0' }),
        () => 0,
      ),
      write(
        k8s.id,
        'watchlog_redis_replica_offset_lag_bytes',
        svc('redis-0', { replica: 'slave0' }),
        (i) => i * 100,
      ),
      write(k8s.id, 'watchlog_redis_is_primary', svc('redis-1'), () => 0),
      write(k8s.id, 'watchlog_redis_master_link_up', svc('redis-1'), () => 0),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);

    const d = (await api('GET', `/applications/${id}`)).json();
    expect(d.page.id).toBe('redis');
    // No stream seen: no Streams tab (1.4).
    expect(d.page.tabs.map((t: { id: string }) => t.id)).toEqual([
      'overview',
      'memory',
      'commands',
      'clients',
      'persistence',
      'replication',
      'alerts',
      'connection',
    ]);
    const codes = d.reasons.map((r: { code: string }) => r.code);
    for (const c of [
      'memory_near_max',
      'evicting',
      'slow_keys_command',
      'replica_down',
      'save_failed',
      'clients_blocked',
    ]) {
      expect(codes, c).toContain(c);
    }
    expect(d.reasons.find((r: { code: string }) => r.code === 'memory_near_max').facts.pct).toBe(
      95,
    );

    const tab = async (t: string) =>
      (await api('GET', `/applications/${id}/panels?tab=${t}`)).json().panels as {
        id: string;
        state: string;
        [k: string]: unknown;
      }[];
    const panel = (ps: Awaited<ReturnType<typeof tab>>, pid: string) =>
      ps.find((p) => p.id === pid)!;
    const ov = await tab('overview');
    const tiles = panel(ov, 'summary').tiles as {
      id: string;
      value: unknown;
      sub?: { values?: Record<string, unknown> };
      severity?: string;
    }[];
    expect(tiles.find((t) => t.id === 'memory')).toMatchObject({
      sub: { values: { max: '1.0 GB' } },
      severity: 'warning',
    });
    expect(tiles.find((t) => t.id === 'memory')!.value).toBeCloseTo(0.95, 2);
    expect(tiles.find((t) => t.id === 'hit')!.value).toBeCloseTo(0.9, 2);
    expect(tiles.find((t) => t.id === 'ttl')!.value).toBeCloseTo(0.25, 2);
    expect(ov.map((p) => p.id)).toEqual([
      'flow',
      'summary',
      'memory',
      'hits',
      'checks',
      'prefixes',
    ]);
    const checks = panel(ov, 'checks').items as { id: string; state: string }[];
    expect(Object.fromEntries(checks.map((c) => [c.id, c.state]))).toMatchObject({
      memory: 'warn',
      slowlog: 'warn',
      save: 'fail',
      maxmemory: 'pass',
    });
    const slow = panel(await tab('commands'), 'slowlog') as unknown as {
      rows: { cells: unknown[]; severity?: string }[];
    };
    expect(slow.rows[0]!.cells.slice(0, 3)).toEqual(['GET cart:*', '1.5 ms', '10.244.9.9']);
    expect(slow.rows[1]).toMatchObject({
      cells: ['KEYS session:*', '250.0 ms', 'shop/checkout', 'redis-0', '2 min ago'],
      severity: 'warning',
    });

    const mem = await tab('memory');
    expect(panel(mem, 'prefixes').state).toBe('needs_permission');
    expect(panel(mem, 'prefixes').missing).toEqual({
      key: 'integrations.redis.missing.memory.prefixes',
      values: { missing: '+scan +memory|usage ~*' },
    });
    expect(panel(mem, 'breakdown').state).toBe('ok');
    expect(panel(mem, 'capacity')).toMatchObject({
      state: 'ok',
      note: { values: { policy: 'allkeys-lru' } },
    });

    const cmds = await tab('commands');
    const table = panel(cmds, 'commands').rows as {
      cells: unknown[];
      severity?: string;
      link?: object;
    }[];
    expect(table.find((r) => r.cells[0] === 'KEYS')).toMatchObject({
      severity: 'warning',
      link: { kind: 'item', tab: 'command', id: 'keys' },
    });
    expect(
      (panel(cmds, 'latency').buckets as { share: number }[]).map((b) => +b.share.toFixed(2)),
    ).toEqual([0.1, 0.8, 0.1]);

    const cl = await tab('clients');
    const byWorkload = panel(cl, 'by-workload').rows as { cells: unknown[]; severity?: string }[];
    expect(byWorkload.map((r) => r.cells.slice(0, 2))).toEqual([
      ['shop/checkout', 12],
      ['10.244.9.9', 3],
    ]);
    // Near its output-buffer limit: about to be disconnected.
    expect(byWorkload[1]).toMatchObject({ severity: 'critical' });
    expect(byWorkload[1]!.cells[5]).toBe('29 MB / 32 MB');
    expect(panel(cl, 'capacity').items).toEqual([expect.objectContaining({ value: 15, max: 100 })]);

    const pers = await tab('persistence');
    const ptiles = panel(pers, 'state').tiles as {
      id: string;
      value: unknown;
      severity?: string;
    }[];
    expect(ptiles.find((t) => t.id === 'rdb')).toMatchObject({
      value: 'failed',
      severity: 'critical',
    });
    expect(panel(await tab('replication'), 'lag').state).toBe('ok');

    const list = (await api('GET', '/applications/metrics')).json().metrics[id];
    expect(list.keyMetrics.map((m: { id: string }) => m.id)).toEqual(['memory', 'hit', 'ops']);
    expect(list.keyMetrics[0]).toMatchObject({ unit: 'ratio', severity: 'warning' });
    expect(list.keyMetrics[0].value).toBeCloseTo(0.95, 2);

    // A light scrape (no extra) keeps the slow log the heavy scrape sent.
    await status(k8s.token, '', [{ id, state: 'ok', members: [{ name: 'redis-0', up: true }] }]);
    expect(
      ((await tab('commands')).find((p) => p.id === 'slowlog') as unknown as { rows: unknown[] })
        .rows,
    ).toHaveLength(2);

    // A Redis default rule, edited then reset; it fires on the series above.
    const rules = (await api('GET', '/alert-rules')).json().rules as {
      id: string;
      defaultKey: string;
      enabled: boolean;
      condition: { value: number };
    }[];
    const high = rules.find((r) => r.defaultKey === 'redis_memory_high')!;
    expect(high.enabled).toBe(true);
    expect(
      (await api('PATCH', `/alert-rules/${high.id}`, { condition: { op: '>', value: 0.99 } }))
        .statusCode,
    ).toBe(200);
    const reset = await api('POST', `/alert-rules/${high.id}/reset`);
    expect(reset.json()).toMatchObject({
      condition: { op: '>', value: 0.9 },
      enabled: true,
      defaultKey: 'redis_memory_high',
    });
    const clock = { now: NOW - 10 * MIN };
    const worker = testWorker(ctx.db, clock, lookupEvaluator, { victoria: vm });
    for (let i = 0; i < 12; i++) {
      await worker.runCycle();
      clock.now += 30_000;
    }
    await worker.stop();
    const firing = await ctx.db
      .selectFrom('alert_states')
      .select(['labels', 'state'])
      .where('rule_id', '=', high.id)
      .execute();
    expect(firing).toEqual([
      expect.objectContaining({
        state: 'firing',
        labels: expect.objectContaining({ service_name: 'shop/redis', member: 'redis-0' }),
      }),
    ]);
  });

  it('names Docker clients by container, and a Compose Redis gets the Redis page', async () => {
    const fleet = await cluster('docker-01', 'server');
    await ctx.db
      .insertInto('objects')
      .values({
        id: newId(),
        cluster_id: fleet.id,
        source: 'docker',
        kind: 'DockerContainer',
        namespace: 'storefront',
        name: 'storefront-web-1',
        uid: newId().replace(/-/g, ''),
        node: 'docker-01',
        spec_summary: JSON.stringify({
          image: 'shop/web:1',
          compose_service: 'web',
          ips: ['172.18.0.5'],
        }),
        status_summary: JSON.stringify({ state: 'running' }),
      })
      .execute();
    const id = (
      await api('POST', '/applications', {
        clusterId: fleet.id,
        type: 'redis',
        target: {
          kind: 'compose',
          host: 'docker-01',
          compose_project: 'storefront',
          compose_service: 'cache',
          port: 6379,
        },
      })
    ).json().application.id as string;
    await status(fleet.token, 'docker-01', [
      {
        id,
        state: 'ok',
        members: [{ name: 'storefront-cache-1', up: true }],
        extra: {
          slowlog: [],
          clients: [{ addr: '172.18.0.5', connections: 4, member: 'storefront-cache-1' }],
          client_detail: [
            {
              addr: '172.18.0.5',
              connections: 4,
              blocked: 0,
              subscribed: 0,
              young: 0,
              idle: 1,
              omem: 0,
              limit: 0,
              class: 'normal',
              cmd: 'get',
              name: '',
              member: 'storefront-cache-1',
            },
          ],
        },
      },
    ]);
    expect((await api('GET', `/applications/${id}`)).json().page.id).toBe('redis');
    const cl = (await api('GET', `/applications/${id}/panels?tab=clients`)).json().panels;
    expect(
      cl
        .find((p: { id: string }) => p.id === 'by-workload')
        .rows.map((r: { cells: unknown[] }) => r.cells.slice(0, 2)),
    ).toEqual([['storefront-web-1', 4]]);
  });

  it('1.4 on a server: what fills the memory, the main thread, a group nobody serves, the next save', async () => {
    const fleet = await cluster('web-01', 'server');
    const container = async (name: string, ip: string) =>
      ctx.db
        .insertInto('objects')
        .values({
          id: newId(),
          cluster_id: fleet.id,
          source: 'docker',
          kind: 'DockerContainer',
          namespace: 'shop',
          name,
          uid: newId().replace(/-/g, ''),
          node: 'web-01',
          spec_summary: JSON.stringify({ image: 'shop/x:1', compose_service: name, ips: [ip] }),
          status_summary: JSON.stringify({ state: 'running' }),
        })
        .execute();
    await container('report-cron', '172.20.0.9');
    await container('billing-worker', '172.20.0.10');
    const id = (
      await api('POST', '/applications', {
        clusterId: fleet.id,
        type: 'redis',
        target: {
          kind: 'compose',
          host: 'web-01',
          compose_project: 'shop',
          compose_service: 'redis',
          port: 6379,
        },
      })
    ).json().application.id as string;
    await status(fleet.token, 'web-01', [
      {
        id,
        state: 'ok',
        service_version: '7.2.17',
        members: [{ name: 'shop-redis-1', up: true }],
        extra: {
          slowlog: [
            {
              at: Math.floor(NOW / 1000) - 30,
              usec: 80_000,
              member: 'shop-redis-1',
              command: 'KEYS session:*',
              client: '172.20.0.9',
            },
          ],
          clients: [],
          prefixes: [
            { prefix: 'session:', type: 'string', ttl_share: 0.08, member: 'shop-redis-1' },
            { prefix: 'cart:', type: 'hash', ttl_share: 1, member: 'shop-redis-1' },
          ],
          stream_consumers: [
            {
              stream: 'orders',
              group: 'billing',
              consumer: 'billing-worker-1',
              pending: 1,
              idle: 1100,
              inactive: 1100,
              member: 'shop-redis-1',
            },
          ],
          settings: [
            { name: 'save', value: '3600 1', member: 'shop-redis-1' },
            { name: 'appendonly', value: 'no', member: 'shop-redis-1' },
            { name: 'bind', value: '127.0.0.1 -::1', member: 'shop-redis-1' },
          ],
        },
      },
    ]);
    const svc = (extra: Record<string, string> = {}) => ({
      service: id,
      service_type: 'redis',
      member: 'shop-redis-1',
      ...extra,
    });
    const GB = 2 ** 30;
    await Promise.all([
      write(fleet.id, 'watchlog_redis_memory_used_bytes', svc(), () => 3.9 * GB),
      write(fleet.id, 'watchlog_redis_memory_max_bytes', svc(), () => 4 * GB),
      write(fleet.id, 'watchlog_redis_memory_rss_bytes', svc(), () => 4.2 * GB),
      write(
        fleet.id,
        'watchlog_redis_maxmemory_policy_info',
        svc({ policy: 'allkeys-lru' }),
        () => 1,
      ),
      write(fleet.id, 'watchlog_redis_evicted_keys_total', svc(), (i) => i * 300),
      // session: at 58% of memory, 92% without a TTL (only 30 min written: no growth over 2 h is known).
      write(
        fleet.id,
        'watchlog_redis_prefix_memory_bytes',
        svc({ prefix: 'session:' }),
        () => 2.2 * GB,
      ),
      write(
        fleet.id,
        'watchlog_redis_prefix_memory_bytes',
        svc({ prefix: 'cart:' }),
        () => 1.6 * GB,
      ),
      write(fleet.id, 'watchlog_redis_prefix_keys', svc({ prefix: 'session:' }), () => 4.1e6),
      write(fleet.id, 'watchlog_redis_prefix_ttl_keys', svc({ prefix: 'session:' }), () => 0.33e6),
      write(fleet.id, 'watchlog_redis_prefix_keys', svc({ prefix: 'cart:' }), () => 610e3),
      write(fleet.id, 'watchlog_redis_prefix_ttl_keys', svc({ prefix: 'cart:' }), () => 610e3),
      write(fleet.id, 'watchlog_redis_keys', svc({ db: 'db0' }), () => 4.71e6),
      write(fleet.id, 'watchlog_redis_keys_expiring', svc({ db: 'db0' }), () => 0.94e6),
      // The main thread busy 97% of a core.
      write(fleet.id, 'watchlog_redis_main_thread_cpu_seconds_total', svc(), (i) => i * 15 * 0.97),
      write(fleet.id, 'watchlog_redis_rdb_cow_bytes', svc(), () => 3.1 * GB),
      write(
        fleet.id,
        'watchlog_service_memory_limit_bytes',
        { host: 'web-01', unit: 'x' },
        () => 0,
      ),
      write(
        fleet.id,
        'watchlog_redis_stream_length',
        svc({ stream: 'orders' }),
        (i) => 5000 + i * 75,
      ),
      write(
        fleet.id,
        'watchlog_redis_stream_group_lag',
        svc({ stream: 'orders', group: 'billing' }),
        (i) => i * 60,
      ),
      write(
        fleet.id,
        'watchlog_redis_stream_group_pending',
        svc({ stream: 'orders', group: 'billing' }),
        () => 1,
      ),
      write(
        fleet.id,
        'watchlog_redis_stream_group_consumers',
        svc({ stream: 'orders', group: 'billing' }),
        () => 1,
      ),
      write(
        fleet.id,
        'watchlog_redis_stream_group_active_consumers',
        svc({ stream: 'orders', group: 'billing' }),
        () => 0,
      ),
      write(fleet.id, 'watchlog_redis_host_thp_always', svc(), () => 1),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const d = (await api('GET', `/applications/${id}`)).json();
    // Streams seen: the tab is there.
    expect(d.page.tabs.map((t: { id: string }) => t.id)).toContain('streams');
    const reasons = d.reasons as {
      code: string;
      facts: Record<string, unknown>;
      links?: { name: string }[];
    }[];
    const by = (c: string) => reasons.find((r) => r.code === c);
    expect(by('main_thread_saturated')?.facts).toMatchObject({
      pct: 97,
      cmd: 'KEYS',
      client: 'report-cron',
      holder: 'report-cron',
    });
    expect(by('stream_group_orphaned')?.facts).toMatchObject({
      stream: 'orders',
      group: 'billing',
      consumer: 'billing-worker-1',
      holder: 'billing-worker',
    });
    // Only 30 minutes written: no share two hours ago, so the prefix "holds" rather than "grew".
    expect(by('memory_near_max')).toBeUndefined();
    expect(by('prefix_holds_memory')?.facts).toMatchObject({
      prefix: 'session:*',
      pct: 58,
      noTtl: 92,
      policy: 'allkeys-lru',
    });
    expect(by('thp_always')).toBeTruthy();
    // A bind to loopback only: no "no password" finding.
    expect(by('no_password')).toBeUndefined();
    for (const r of reasons) expect(reasonSentence(r), r.code).not.toBe('See the facts.');
    const panels = async (tab: string, q = '') =>
      (await api('GET', `/applications/${id}/panels?tab=${tab}${q}`)).json().panels as {
        id: string;
        state: string;
        [k: string]: unknown;
      }[];
    const ov = await panels('overview');
    const prefixes = ov.find((p) => p.id === 'prefixes') as unknown as {
      rows: { cells: unknown[]; link?: object }[];
    };
    expect(prefixes.rows[0]).toMatchObject({
      cells: ['session:*', '58%', '4.1 M', '8%', '–', 'string'],
      link: { kind: 'item', tab: 'prefix', id: 'session:' },
    });
    const streams = await panels('streams');
    const groups = streams.find((p) => p.id === 'groups') as unknown as {
      rows: { cells: unknown[]; severity?: string }[];
    };
    expect(groups.rows[0]).toMatchObject({ severity: 'critical' });
    expect(groups.rows[0]!.cells.slice(0, 3)).toEqual(['orders', 'billing', '0 / 1']);
    const prefix = await panels('prefix', '&prefix=session%3A');
    expect(prefix.find((p) => p.id === 'facts')!.state).toBe('ok');
    const group = await panels('group', `&group=${encodeURIComponent('orders\u0000billing')}`);
    expect(group.find((p) => p.id === 'facts')!.state).toBe('ok');
    const cmd = await panels('command', '&command=keys');
    expect(
      (cmd.find((p) => p.id === 'slowlog') as unknown as { rows: { cells: unknown[] }[] }).rows[0]!
        .cells[2],
    ).toBe('report-cron');
  });
});
