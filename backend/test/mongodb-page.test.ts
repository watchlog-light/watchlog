// SPDX-License-Identifier: AGPL-3.0-only
// The MongoDB page (v0.5 slice 2, SPEC §4.12, ADR-164): its tabs from the collector's
// serverStatus series, the members, slow operations, clients and unused indexes from its
// status (shapes as MongoDB 7.0 and 8.0 gave them on the e2e VM), the reasons with the
// client sending collection scans for probable cause, and the list's numbers.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { authorisedScope, VictoriaQueryClient } from '../src/lib/victoria.js';
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

async function cluster(name: string, kind: 'kubernetes' | 'server') {
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

type Panel = { id: string; state: string; [k: string]: unknown };

const TABS = [
  'overview',
  'operations',
  'waits',
  'clients',
  'replica',
  'collections',
  'storage',
  'alerts',
];
const SHAPE = 'f4cca5f6a9615ca6';

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
    // What the 1.4 collector sends (Step 0's 8.0.38 replica set, broken).
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
              votes: 1,
              priority: 1,
            },
            {
              name: 'mongo-1',
              state: '(not reachable/healthy)',
              health: 0,
              lag: 0,
              uptime: 0,
              seen_by: 'mongo-0',
              set: 'rs0',
              votes: 1,
              priority: 1,
              ping: 0.002,
            },
          ],
          shapes: [
            {
              shape: SHAPE,
              ns: 'shop.events',
              op: 'find',
              plan: 'COLLSCAN',
              collscan: true,
              calls: 240,
              examined: 72e6,
              keys: 0,
              returned: 12e6,
              member: 'mongo-0',
              query: '{createdAt: {$gt: ?}, type: ?}',
              fields: 'createdAt,type',
            },
            {
              shape: 'aa01',
              ns: 'shop.orders',
              op: 'update',
              plan: 'IXSCAN { _id: 1 }',
              collscan: false,
              calls: 2,
              examined: 2,
              keys: 2,
              returned: 0,
              member: 'mongo-0',
            },
          ],
          clients: [
            {
              addr: '10.244.2.70',
              app: 'analytics',
              connections: 54,
              member: 'mongo-0',
              opened: 1,
            },
            { addr: '10.244.2.71', app: 'api', connections: 2, member: 'mongo-0', opened: 0 },
          ],
          // Unused on both members: unused. customer_1 is used on the primary: not unused.
          unused_indexes: [
            {
              ns: 'shop.orders',
              index: 'total_1',
              since: 1794529933,
              bytes: 655360,
              member: 'mongo-0',
            },
            {
              ns: 'shop.orders',
              index: 'total_1',
              since: 1794529933,
              bytes: 684032,
              member: 'mongo-1',
            },
            {
              ns: 'shop.orders',
              index: 'customer_1',
              since: 1794529933,
              bytes: 1507328,
              member: 'mongo-1',
            },
          ],
          redundant_indexes: [
            {
              ns: 'shop.orders',
              index: 'customer_1',
              covered_by: 'customer_1_createdAt_-1',
              bytes: 1511424,
              member: 'mongo-0',
            },
          ],
          transactions: [
            {
              addr: '10.244.2.71',
              app: 'api',
              age: 45,
              idle: 44,
              state: 'idleSession',
              member: 'mongo-0',
            },
          ],
          cursors: [{ ns: 'shop.events', idle: 900, age: 900, member: 'mongo-0' }],
          settings: [
            {
              name: 'featureCompatibilityVersion',
              value: '8.0',
              version: '8.0.38',
              member: 'mongo-0',
            },
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
      write(k8s.id, 'watchlog_mongodb_voting_members', svc(), () => 3),
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
      write(
        k8s.id,
        'watchlog_mongodb_member_ping_seconds',
        svc({ rs_member: 'mongo-1' }),
        () => 0.002,
      ),
      write(k8s.id, 'watchlog_mongodb_slow_ops_total', svc({ plan: 'collscan' }), (i) => i * 4),
      write(k8s.id, 'watchlog_mongodb_slow_ops_total', svc({ plan: 'other' }), () => 2),
      write(k8s.id, 'watchlog_mongodb_collection_scans_total', svc(), (i) => i * 30),
      write(k8s.id, 'watchlog_mongodb_cache_bytes', svc({ state: 'used' }), () => 250e6),
      write(k8s.id, 'watchlog_mongodb_cache_bytes', svc({ state: 'dirty' }), () => 9e6),
      write(k8s.id, 'watchlog_mongodb_cache_bytes', svc({ state: 'max' }), () => 268435456),
      write(k8s.id, 'watchlog_mongodb_app_eviction_seconds_total', svc(), (i) => i * 0.2),
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
        'watchlog_mongodb_collection_data_bytes',
        svc({ ns: 'shop.events' }),
        () => 52e6,
      ),
      write(
        k8s.id,
        'watchlog_mongodb_collection_documents',
        svc({ ns: 'shop.events' }),
        () => 300000,
      ),
      write(
        k8s.id,
        'watchlog_mongodb_collection_time_seconds_total',
        svc({ ns: 'shop.events' }),
        (i) => i * 2,
      ),
      write(
        k8s.id,
        'watchlog_mongodb_collection_ops_total',
        svc({ ns: 'shop.events' }),
        (i) => i * 20,
      ),
      // The shape: 4 calls a scrape, 0.15 s each, 300 k documents examined, 50 k returned.
      write(k8s.id, 'watchlog_mongodb_statement_calls_total', svc({ shape: SHAPE }), (i) => i * 4),
      write(
        k8s.id,
        'watchlog_mongodb_statement_seconds_total',
        svc({ shape: SHAPE }),
        (i) => i * 0.6,
      ),
      write(
        k8s.id,
        'watchlog_mongodb_statement_docs_examined_total',
        svc({ shape: SHAPE }),
        (i) => i * 1.2e6,
      ),
      write(
        k8s.id,
        'watchlog_mongodb_statement_docs_returned_total',
        svc({ shape: SHAPE }),
        (i) => i * 2e5,
      ),
      write(
        k8s.id,
        'watchlog_mongodb_statement_keys_examined_total',
        svc({ shape: SHAPE }),
        () => 0,
      ),
      write(
        k8s.id,
        'watchlog_mongodb_statement_client_sessions',
        svc({ shape: SHAPE, addr: '10.244.2.70' }),
        () => 2,
      ),
      write(k8s.id, 'watchlog_mongodb_shape_source', svc({ source: 'slowlog' }), () => 1),
      // What the operations wait on: mostly running, the scans; a ticket queue now and then.
      ...['running', 'lock', 'ticket', 'flow_control', 'other'].map((wait) =>
        write(k8s.id, 'watchlog_mongodb_active_sessions', svc({ wait }), () =>
          wait === 'running' ? 3 : wait === 'ticket' ? 1 : 0,
        ),
      ),
      write(
        k8s.id,
        'watchlog_mongodb_statement_active_sessions',
        svc({ shape: SHAPE, wait: 'running' }),
        () => 2,
      ),
      write(
        k8s.id,
        'watchlog_mongodb_client_active_sessions',
        svc({ addr: '10.244.2.70', wait: 'running' }),
        () => 2,
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
      'collscan_fills_cache',
      'connections_near_max',
      'oplog_window_short',
      'long_transaction',
      'cursors_no_timeout',
    ])
      expect(codes, c).toContain(c);
    expect(codes).not.toContain('no_primary');
    // Cause first: the shape's collection and fields, who sends it (a workload, for probable
    // cause), and what it does to the cache.
    expect(reasons.find((r) => r.code === 'collscan_fills_cache')!.facts).toMatchObject({
      ns: 'shop.events',
      fields: 'createdAt, type',
      client: 'shop/analytics',
      holder: 'shop/analytics',
      cachePct: 93,
      examined: '300 k',
    });
    expect(reasons.find((r) => r.code === 'long_transaction')!.facts).toMatchObject({
      who: 'shop/api',
      age: '45 s',
    });
    expect(reasons.find((r) => r.code === 'connections_near_max')!.facts).toMatchObject({
      pct: 93,
      top: 'shop/analytics (54), shop/api (2)',
    });
    for (const r of reasons) expect(reasonSentence(r), r.code).not.toBe('See the facts.');

    const panels = async (tab: string, q = '') =>
      (await api('GET', `/applications/${id}/panels?tab=${tab}${q}`)).json().panels as Panel[];
    const overview = await panels('overview');
    expect(overview.map((p) => p.id)).toEqual([
      'flow',
      'summary',
      'ops',
      'latency',
      'cache',
      'checks',
      'slow',
      'cpu',
      'memory',
      'disk',
    ]);
    for (const pid of ['flow', 'summary', 'ops', 'latency', 'cache', 'checks', 'slow'])
      expect(overview.find((p) => p.id === pid)!.state, pid).toBe('ok');
    const flow = overview.find((p) => p.id === 'flow') as unknown as {
      columns: { id: string; rows: { name: string; text?: { key: string } }[] }[];
    };
    // The client sending the scans comes first in the flow, said.
    expect(flow.columns[0]!.rows[0]).toMatchObject({
      name: 'shop/analytics',
      text: { key: 'integrations.mongodb.panels.flow.sendsScans' },
    });
    const tiles = (
      overview.find((p) => p.id === 'summary') as unknown as {
        tiles: { id: string; value: number | null; severity?: string; sub?: { key: string } }[];
      }
    ).tiles;
    expect(tiles.find((t) => t.id === 'connections')!.value).toBeCloseTo(0.933, 2);
    expect(tiles.find((t) => t.id === 'cache')).toMatchObject({
      severity: 'warning',
      sub: { key: 'integrations.mongodb.panels.tiles.evicting' },
    });
    const slow = overview.find((p) => p.id === 'slow') as unknown as {
      rows: { cells: unknown[]; severity?: string; link?: { kind: string; id: string } }[];
    };
    expect(slow.rows[0]!.cells.slice(0, 2)).toEqual([
      'find {createdAt: {$gt: ?}, type: ?}',
      'shop.events',
    ]);
    expect(slow.rows[0]!.cells.slice(5)).toEqual(['COLLSCAN', 'shop/analytics']);
    expect(slow.rows[0]!.cells[4]).toBe('300 k');
    expect(slow.rows[0]).toMatchObject({
      severity: 'warning',
      link: { kind: 'statement', id: SHAPE },
    });
    const checks = overview.find((p) => p.id === 'checks') as unknown as {
      items: { id: string; state: string }[];
    };
    expect(Object.fromEntries(checks.items.map((c) => [c.id, c.state]))).toMatchObject({
      collscan: 'fail',
      cache: 'warn',
      members: 'fail',
      oplog: 'fail',
      primary: 'pass',
    });

    const ops = await panels('operations');
    const top = ops.find((p) => p.id === 'top') as unknown as {
      note: { key: string };
      rows: { id: string; sentBy: { name: string } | null; hint?: { values: { table: string } } }[];
    };
    expect(top.note.key).toBe('integrations.mongodb.panels.shapes.source.slowlog');
    expect(top.rows[0]).toMatchObject({
      id: SHAPE,
      sentBy: { name: 'shop/analytics' },
      hint: { values: { table: 'shop.events (createdAt, type)' } },
    });
    expect(ops.find((p) => p.id === 'indexes')!.state).toBe('ok');

    const waits = await panels('waits');
    expect(waits.find((p) => p.id === 'waits')!.state).toBe('ok');
    expect(
      (waits.find((p) => p.id === 'by-statement') as unknown as { rows: { id: string }[] }).rows[0]!
        .id,
    ).toBe(SHAPE);

    const clients = await panels('clients');
    const txns = clients.find((p) => p.id === 'transactions') as unknown as {
      rows: { cells: unknown[]; severity?: string }[];
    };
    expect(txns.rows[0]).toEqual({
      cells: ['shop/api', 'idleSession', '45 s', '44 s'],
      severity: 'warning',
    });

    const replica = await panels('replica');
    const members = replica.find((p) => p.id === 'members') as unknown as {
      rows: { cells: unknown[]; severity?: string }[];
    };
    expect(members.rows[1]).toEqual({
      cells: ['mongo-1', '(not reachable/healthy)', 'down', '–', '2 ms', 1, 1],
      severity: 'critical',
    });

    const colls = await panels('collections');
    const unused = colls.find((p) => p.id === 'unused') as unknown as {
      rows: { cells: unknown[] }[];
    };
    expect(unused.rows.map((r) => r.cells[1])).toEqual(['total_1']);
    const redundant = colls.find((p) => p.id === 'redundant') as unknown as {
      rows: { cells: unknown[] }[];
    };
    expect(redundant.rows[0]!.cells.slice(0, 3)).toEqual([
      'shop.orders',
      'customer_1',
      'customer_1_createdAt_-1',
    ]);

    const shape = await panels('statement', `&statement=${SHAPE}`);
    expect(shape.find((p) => p.id === 'facts')!.state).toBe('ok');
    const senders = shape.find((p) => p.id === 'senders') as unknown as {
      items: { label: string }[];
    };
    expect(senders.items[0]!.label).toBe('shop/analytics');
    const coll = await panels('table', '&table=shop%2Fevents');
    expect(coll.find((p) => p.id === 'facts')!.state).toBe('ok');
    expect(
      (coll.find((p) => p.id === 'statements') as unknown as { rows: { id: string }[] }).rows[0]!
        .id,
    ).toBe(SHAPE);

    const row = (await api('GET', '/applications/metrics')).json().metrics[id] as {
      keyMetrics: { id: string; value: number | null }[];
    };
    expect(row.keyMetrics[1]!.value).toBeCloseTo(0.933, 2);
  });

  it('a user without clusterMonitor: the panels say so; a standalone server has no members', async () => {
    const docker = await cluster('fleet', 'server');
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
        permissions: [{ tab: 'operations/top', missing: 'clusterMonitor' }],
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
    const top = ops.find((p) => p.id === 'top')!;
    expect(top.state).toBe('needs_permission');
    expect((top as unknown as { missing: { key: string } }).missing.key).toBe(
      'integrations.mongodb.missing.operations.top',
    );
    const replica = (await api('GET', `/applications/${id}/panels?tab=replica`)).json()
      .panels as Panel[];
    expect(replica.find((p) => p.id === 'members')!.note).toEqual({
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
      sub?: { values: { n: number; max: number } };
    }[];
    expect(tiles.find((t) => t.id === 'connections')).toMatchObject({
      value: 1,
      sub: { values: { n: 100, max: 100 } },
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
