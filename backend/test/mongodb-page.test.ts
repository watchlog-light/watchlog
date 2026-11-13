// SPDX-License-Identifier: AGPL-3.0-only
// The MongoDB page (v0.5 slice 2, SPEC §4.12, ADR-164): its tabs from the collector's
// serverStatus series, the members, slow operations, clients and unused indexes from its
// status (shapes as MongoDB 7.0 and 8.0 gave them on the e2e VM), the reasons with the
// client sending collection scans for probable cause, and the list's numbers.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { VictoriaQueryClient } from '../src/lib/victoria.js';
import type { Evidence } from '../src/modules/causes/evidence.js';
import { linksOf } from '../src/modules/causes/rules/application-finding.js';
import { reasonSentence } from '../src/modules/mcp/tools/applications.js';
import {
  TEST_VM_URL,
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `mongodb-page-${Date.now()}`;
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

async function cluster(name: string, kind: 'kubernetes' | 'docker') {
  const res = await api('POST', '/clusters', { name, kind });
  return { id: res.json().cluster.id as string, token: res.json().token.value as string };
}

/** 30 minutes of a series, every 15 s, from `value(i)` (i = 0…120). */
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
  await vm.write({ clusterId }, encode(series));
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

type Panel = { id: string; state: string; [k: string]: unknown };

const TABS = ['overview', 'operations', 'storage'];

describe('the MongoDB page', () => {
  it('fills every tab, says what is wrong, and names the client sending scans (Kubernetes, 8.0)', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    await pod(k8s.id, 'shop', 'analytics-5c7d', 'analytics', '10.244.2.70');
    await pod(k8s.id, 'shop', 'api-1', 'api', '10.244.2.71');
    const id = (
      await api('POST', '/applications', {
        clusterId: k8s.id,
        type: 'mongodb',
        target: {
          kind: 'workload',
          namespace: 'shop',
          workload_kind: 'StatefulSet',
          workload: 'mongo',
          port: 27017,
        },
        defaultAlerts: ['mongodb_slow_ops'],
      })
    ).json().application.id as string;
    await status(k8s.token, '', [
      {
        id,
        state: 'ok',
        service_version: '8.0.38',
        members: [
          { name: 'mongo-0', up: true },
          { name: 'mongo-1', up: false, error: 'connection refused' },
        ],
        extra: {
          members: [
            {
              name: 'mongo-0',
              state: 'PRIMARY',
              health: 1,
              lag: 0,
              uptime: 225,
              seen_by: 'mongo-0',
              set: 'rs0',
            },
            {
              name: 'mongo-1',
              state: '(not reachable/healthy)',
              health: 0,
              lag: 0,
              uptime: 0,
              seen_by: 'mongo-0',
              set: 'rs0',
            },
          ],
          slow: [
            {
              ns: 'shop.events',
              op: 'find',
              plan: 'COLLSCAN',
              count: 240,
              mean_ms: 37,
              max_ms: 61,
              collscan: true,
              remote: '10.244.2.70',
              last: Math.floor(NOW / 1000),
              member: 'mongo-0',
              shape: '{amount: {$gt: ?}, kind: ?}',
              hash: 'C117D0022998A24F',
            },
            {
              ns: 'shop.orders',
              op: 'update',
              plan: 'IXSCAN { _id: 1 }',
              count: 2,
              mean_ms: 120,
              max_ms: 130,
              collscan: false,
              remote: '10.244.2.71',
              last: Math.floor(NOW / 1000),
              member: 'mongo-0',
            },
          ],
          clients: [
            { addr: '10.244.2.70', app: '', connections: 54, member: 'mongo-0' },
            { addr: '10.244.2.71', app: 'api', connections: 2, member: 'mongo-0' },
          ],
          unused_indexes: [
            { ns: 'shop.events', index: 'at_1', since: 1794529933, member: 'mongo-0' },
          ],
        },
      },
    ]);
    const svc = (extra: Record<string, string> = {}) => ({
      service: id,
      service_type: 'mongodb',
      member: 'mongo-0',
      ...extra,
    });
    await Promise.all([
      write(k8s.id, 'watchlog_mongodb_connections', svc({ state: 'current' }), () => 56),
      write(k8s.id, 'watchlog_mongodb_connections', svc({ state: 'available' }), () => 4),
      ...['query', 'insert', 'update', 'getmore', 'command'].map((op, j) =>
        write(k8s.id, 'watchlog_mongodb_ops_total', svc({ op }), (i) => i * 30 * (j + 1)),
      ),
      write(k8s.id, 'watchlog_mongodb_replica_set', svc(), () => 1),
      write(k8s.id, 'watchlog_mongodb_primary_seen', svc(), () => 1),
      write(k8s.id, 'watchlog_mongodb_member_health', svc({ rs_member: 'mongo-0' }), () => 1),
      write(k8s.id, 'watchlog_mongodb_member_health', svc({ rs_member: 'mongo-1' }), (i) =>
        i > 100 ? 0 : 1,
      ),
      write(
        k8s.id,
        'watchlog_mongodb_replication_lag_seconds',
        svc({ rs_member: 'mongo-1' }),
        (i) => (i > 100 ? 45 : 1),
      ),
      write(k8s.id, 'watchlog_mongodb_slow_ops_total', svc({ plan: 'collscan' }), (i) => i * 4),
      write(k8s.id, 'watchlog_mongodb_slow_ops_total', svc({ plan: 'other' }), () => 2),
      write(k8s.id, 'watchlog_mongodb_cache_bytes', svc({ state: 'used' }), () => 64e6),
      write(k8s.id, 'watchlog_mongodb_cache_bytes', svc({ state: 'dirty' }), () => 9e6),
      write(k8s.id, 'watchlog_mongodb_cache_bytes', svc({ state: 'max' }), () => 268435456),
      write(k8s.id, 'watchlog_mongodb_fs_bytes', svc({ state: 'used' }), () => 20e9),
      write(k8s.id, 'watchlog_mongodb_fs_bytes', svc({ state: 'total' }), () => 30e9),
      write(k8s.id, 'watchlog_mongodb_tickets', svc({ op: 'read', state: 'available' }), () => 4),
      write(k8s.id, 'watchlog_mongodb_tickets', svc({ op: 'write', state: 'available' }), () => 4),
      write(k8s.id, 'watchlog_mongodb_oplog_window_seconds', svc(), () => 3600),
      write(k8s.id, 'watchlog_mongodb_oplog_bytes', svc({ state: 'used' }), () => 990e6),
      write(k8s.id, 'watchlog_mongodb_oplog_bytes', svc({ state: 'max' }), () => 1000e6),
      write(
        k8s.id,
        'watchlog_mongodb_collection_size_bytes',
        svc({ ns: 'shop.events' }),
        () => 17461248,
      ),
      write(
        k8s.id,
        'watchlog_mongodb_collection_time_seconds_total',
        svc({ ns: 'shop.events' }),
        (i) => i * 2,
      ),
      ...['0.001', '0.01', '0.1', '1', '10', '+Inf'].map((le, j) =>
        write(
          k8s.id,
          'watchlog_mongodb_op_latency_bucket',
          svc({ type: 'reads', le }),
          (i) => i * (j + 1),
        ),
      ),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);

    const d = (await api('GET', `/applications/${id}`)).json();
    expect(d.page.id).toBe('mongodb');
    expect(d.page.tabs.map((t: { id: string }) => t.id)).toEqual([...TABS, 'connection']);
    const reasons = d.reasons as { code: string; facts: Record<string, unknown> }[];
    const codes = reasons.map((r) => r.code);
    for (const c of [
      'member_down',
      'replica_lag',
      'slow_collscan',
      'connections_near_max',
      'oplog_window_short',
    ])
      expect(codes, c).toContain(c);
    expect(codes).not.toContain('no_primary');
    // The client as probable cause follows it: a workload "namespace/name" (ADR-164).
    expect(reasons.find((r) => r.code === 'slow_collscan')!.facts).toMatchObject({
      ns: 'shop.events',
      client: 'shop/analytics',
      holder: 'shop/analytics',
      mean: '37 ms',
    });
    expect(reasons.find((r) => r.code === 'member_down')!.facts).toMatchObject({
      member: 'mongo-1',
      n: 1,
    });
    expect(reasons.find((r) => r.code === 'connections_near_max')!.facts).toMatchObject({
      pct: 93,
      top: 'shop/analytics (54), shop/api (2)',
    });
    for (const r of reasons) expect(reasonSentence(r), r.code).not.toBe('See the facts.');

    const panels = async (tab: string) =>
      (await api('GET', `/applications/${id}/panels?tab=${tab}`)).json().panels as Panel[];
    for (const tab of TABS) {
      const ps = await panels(tab);
      expect(
        ps.filter((p) => p.state !== 'ok'),
        tab,
      ).toEqual([]);
    }
    const tiles = (
      (await panels('overview')).find((p) => p.id === 'summary') as unknown as {
        tiles: { id: string; value: number | null; severity?: string }[];
      }
    ).tiles;
    expect(tiles.find((t) => t.id === 'connections')).toMatchObject({
      value: 56,
      severity: 'warning',
    });
    expect(tiles.find((t) => t.id === 'cache')!.value).toBeCloseTo(0.238, 2);
    const members = (await panels('overview')).find((p) => p.id === 'members') as unknown as {
      rows: { cells: unknown[]; severity?: string }[];
    };
    expect(members.rows[1]).toEqual({
      cells: ['mongo-1', '(not reachable/healthy)', 'down', '–'],
      severity: 'critical',
    });
    const slow = (await panels('operations')).find((p) => p.id === 'slow') as unknown as {
      rows: { cells: unknown[]; severity?: string }[];
    };
    expect(slow.rows[0]).toEqual({
      cells: [
        'find {amount: {$gt: ?}, kind: ?}',
        'shop.events',
        '37 ms',
        240,
        'COLLSCAN',
        'shop/analytics',
      ],
      severity: 'warning',
    });
    const row = (await api('GET', '/applications/metrics')).json().metrics[id] as {
      keyMetrics: { id: string; value: number | null }[];
    };
    expect(row.keyMetrics[1]!.value).toBeCloseTo(0.933, 2);
  });

  it('a user without clusterMonitor: the panels say so; a standalone server has no members', async () => {
    const docker = await cluster('fleet', 'docker');
    const id = (
      await api('POST', '/applications', {
        clusterId: docker.id,
        type: 'mongodb',
        target: {
          kind: 'compose',
          host: 'h1',
          compose_project: 'shop',
          compose_service: 'mongo',
          port: 27017,
        },
      })
    ).json().application.id as string;
    await status(docker.token, 'h1', [
      {
        id,
        state: 'ok',
        service_version: '7.0.48',
        members: [{ name: 'shop-mongo-1', up: true }],
        permissions: [{ tab: 'operations/slow', missing: 'clusterMonitor' }],
        extra: { clients: [] },
      },
    ]);
    await write(
      docker.id,
      'watchlog_mongodb_replica_set',
      { service: id, service_type: 'mongodb', member: 'shop-mongo-1' },
      () => 0,
    );
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const reasons = (await api('GET', `/applications/${id}`)).json().reasons as { code: string }[];
    expect(reasons.map((r) => r.code)).not.toContain('no_primary');
    const ops = (await api('GET', `/applications/${id}/panels?tab=operations`)).json()
      .panels as Panel[];
    const slow = ops.find((p) => p.id === 'slow')!;
    expect(slow.state).toBe('needs_permission');
    expect((slow as unknown as { missing: { key: string } }).missing.key).toBe(
      'integrations.mongodb.missing.operations.slow',
    );
    const overview = (await api('GET', `/applications/${id}/panels?tab=overview`)).json()
      .panels as Panel[];
    expect(overview.find((p) => p.id === 'members')!.note).toEqual({
      key: 'integrations.mongodb.panels.standaloneNote',
    });
  });

  it('a full primary beside an idle secondary is near its limit (each member its own)', async () => {
    // Measured on the e2e replica set: the primary at 100 of maxConns 100, the secondary at
    // 10 with 90 available. max() of each state apart read 100 of 190 (53 %).
    const k8s = await cluster('kind-rs', 'kubernetes');
    const id = (
      await api('POST', '/applications', {
        clusterId: k8s.id,
        type: 'mongodb',
        target: {
          kind: 'workload',
          namespace: 'db',
          workload_kind: 'StatefulSet',
          workload: 'mongo',
          port: 27017,
        },
      })
    ).json().application.id as string;
    await status(k8s.token, '', [
      {
        id,
        state: 'ok',
        service_version: '8.0.38',
        members: [
          { name: 'mongo-0', up: true },
          { name: 'mongo-1', up: true },
        ],
        extra: { clients: [] },
      },
    ]);
    const m = (member: string, state: string) => ({
      service: id,
      service_type: 'mongodb',
      member,
      state,
    });
    await Promise.all([
      write(k8s.id, 'watchlog_mongodb_connections', m('mongo-0', 'current'), () => 100),
      write(k8s.id, 'watchlog_mongodb_connections', m('mongo-0', 'available'), () => 0),
      write(k8s.id, 'watchlog_mongodb_connections', m('mongo-1', 'current'), () => 10),
      write(k8s.id, 'watchlog_mongodb_connections', m('mongo-1', 'available'), () => 90),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const reasons = (await api('GET', `/applications/${id}`)).json().reasons as {
      code: string;
      facts: Record<string, unknown>;
    }[];
    expect(reasons.find((r) => r.code === 'connections_near_max')?.facts).toMatchObject({
      n: 100,
      max: 100,
      pct: 100,
    });
    const overview = (await api('GET', `/applications/${id}/panels?tab=overview`)).json()
      .panels as Panel[];
    const tiles = overview.find((p) => p.id === 'summary')!.tiles as {
      id: string;
      value: unknown;
      sub?: { values: { max: number } };
    }[];
    expect(tiles.find((t) => t.id === 'connections')).toMatchObject({
      value: 100,
      sub: { values: { max: 100 } },
    });
    const list = (await api('GET', '/applications/metrics')).json().metrics[id];
    expect(list.keyMetrics.find((k: { id: string }) => k.id === 'connections')).toMatchObject({
      value: 1,
      unit: 'ratio',
    });
  });
});

describe('probable cause follows slow_collscan to the client', () => {
  const ev = (platform: string, facts: Record<string, string | number | null>) =>
    ({
      platform,
      application: {
        id: 'a',
        type: 'mongodb',
        name: 'shop/mongo',
        health: 'warning',
        reason: { code: 'connected', facts: {} },
        target: {},
        reasons: [{ severity: 'warning', code: 'slow_collscan', facts }],
      },
    }) as unknown as Evidence;

  it('a workload on Kubernetes, a container on Docker, nothing for an unknown address', () => {
    expect(
      linksOf(ev('kubernetes', { holder: 'shop/analytics', ns: 'shop.events' }))[0],
    ).toMatchObject({
      name: 'shop/analytics',
      finding: 'slow_collscan',
      target: { kind: 'workload', namespace: 'shop', name: 'analytics' },
    });
    expect(linksOf(ev('docker', { holder: 'mongodb-e2e-analytics-1' }))[0]).toMatchObject({
      target: { kind: 'container', name: 'mongodb-e2e-analytics-1' },
    });
    expect(linksOf(ev('kubernetes', { holder: null, client: '10.0.0.9' }))).toEqual([]);
  });
});
