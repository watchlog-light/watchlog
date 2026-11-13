// SPDX-License-Identifier: AGPL-3.0-only
// The MySQL and MariaDB page (v0.5 slice 1, SPEC §4.12, ADR-163): its tabs from the
// collector's status-variable series, the lock waits, clients and statements from its
// status (shapes as MySQL 8.4 and MariaDB 11.4 gave them on the e2e VM), the reasons with
// the lock holder for probable cause, the list's numbers, and MariaDB without
// performance_schema.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { VictoriaQueryClient } from '../src/lib/victoria.js';
import type { Evidence } from '../src/modules/causes/evidence.js';
import { findingStep, linksOf } from '../src/modules/causes/rules/application-finding.js';
import { foldPermissions } from '../src/modules/integrations/pages/reasons.js';
import { reasonSentence } from '../src/modules/mcp/tools/applications.js';
import {
  TEST_VM_URL,
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `mysql-page-${Date.now()}`;
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

const TABS = ['overview', 'connections', 'queries', 'locks', 'storage', 'replication'];

describe('the MySQL page', () => {
  it('fills every tab, says what is wrong, and names the lock holder (Kubernetes, MySQL 8.4)', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    await pod(k8s.id, 'shop', 'locker-7d9f', 'locker', '10.244.2.61');
    await pod(k8s.id, 'shop', 'writer-55f', 'writer', '10.244.2.62');
    await pod(k8s.id, 'shop', 'leak-1', 'leak', '10.244.2.63');
    const id = (
      await api('POST', '/applications', {
        clusterId: k8s.id,
        type: 'mysql',
        target: {
          kind: 'workload',
          namespace: 'shop',
          workload_kind: 'StatefulSet',
          workload: 'mysql',
          port: 3306,
        },
        defaultAlerts: ['mysql_connections_high'],
      })
    ).json().application.id as string;
    await status(k8s.token, '', [
      {
        id,
        state: 'ok',
        service_version: '8.4.13',
        members: [{ name: 'mysql-0', up: true }],
        extra: {
          clients: [
            { addr: '10.244.2.63', user: 'app', connections: 36, member: 'mysql-0' },
            { addr: '10.244.2.61', user: 'app', connections: 1, member: 'mysql-0' },
            { addr: '10.244.2.62', user: 'app', connections: 1, member: 'mysql-0' },
          ],
          blocking: [
            {
              blocked: '10.244.2.62',
              blocked_user: 'app',
              blocking: '10.244.2.61',
              blocking_user: 'app',
              blocking_state: 'Query',
              seconds: 21,
              held: 23,
              table: 'shop.stock',
              member: 'mysql-0',
            },
          ],
          statements: [
            {
              digest: '22bc66860cad28e8',
              db: 'shop',
              calls: 4,
              total: 50.01,
              mean: 12.5,
              max: 50.01,
              rows_examined: 4,
              rows_sent: 0,
              query: 'UPDATE `shop` . `stock` SET `n` = `n` + ? WHERE `id` = ?',
            },
          ],
          replica: [],
        },
      },
    ]);
    const svc = (extra: Record<string, string> = {}) => ({
      service: id,
      service_type: 'mysql',
      member: 'mysql-0',
      ...extra,
    });
    await Promise.all([
      write(k8s.id, 'watchlog_mysql_threads_connected', svc(), () => 38),
      write(k8s.id, 'watchlog_mysql_threads_running', svc(), () => 3),
      write(k8s.id, 'watchlog_mysql_setting', svc({ name: 'max_connections' }), () => 40),
      write(k8s.id, 'watchlog_mysql_max_used_connections', svc(), () => 39),
      write(k8s.id, 'watchlog_mysql_questions_total', svc(), (i) => i * 300),
      write(k8s.id, 'watchlog_mysql_slow_queries_total', svc(), (i) => i),
      write(k8s.id, 'watchlog_mysql_buffer_pool_read_requests_total', svc(), (i) => i * 1000),
      write(k8s.id, 'watchlog_mysql_buffer_pool_reads_total', svc(), (i) => i * 10),
      write(k8s.id, 'watchlog_mysql_longest_query_seconds', svc(), (i) => 200 + i * 15),
      write(k8s.id, 'watchlog_mysql_row_lock_current_waits', svc(), () => 1),
      write(k8s.id, 'watchlog_mysql_row_lock_waits_total', svc(), (i) => i),
      write(k8s.id, 'watchlog_mysql_row_lock_wait_seconds_total', svc(), (i) => i * 15),
      write(k8s.id, 'watchlog_mysql_deadlocks_total', svc(), (i) => (i > 110 ? 2 : 0)),
      write(k8s.id, 'watchlog_mysql_commands_total', svc({ command: 'select' }), (i) => i * 200),
      write(k8s.id, 'watchlog_mysql_commands_total', svc({ command: 'update' }), (i) => i * 50),
      write(k8s.id, 'watchlog_mysql_rows_total', svc({ op: 'read' }), (i) => i * 900),
      write(k8s.id, 'watchlog_mysql_tmp_disk_tables_total', svc(), (i) => i * 30),
      write(k8s.id, 'watchlog_mysql_select_scan_total', svc(), (i) => i * 20),
      write(k8s.id, 'watchlog_mysql_buffer_pool_pages', svc({ state: 'total' }), () => 8192),
      write(k8s.id, 'watchlog_mysql_buffer_pool_pages', svc({ state: 'data' }), () => 1194),
      write(k8s.id, 'watchlog_mysql_buffer_pool_pages', svc({ state: 'dirty' }), () => 10),
      write(k8s.id, 'watchlog_mysql_redo_written_bytes_total', svc(), (i) => i * 4096),
      write(k8s.id, 'watchlog_mysql_is_replica', svc(), () => 0),
      write(
        k8s.id,
        'watchlog_mysql_table_size_bytes_estimate',
        svc({ db: 'shop', table: 'stock' }),
        () => 16384,
      ),
      ...['0.001', '0.01', '0.1', '1', '10', '+Inf'].map((le, j) =>
        write(k8s.id, 'watchlog_mysql_statement_latency_bucket', svc({ le }), (i) => i * (j + 1)),
      ),
      write(
        k8s.id,
        'watchlog_mysql_statement_calls_total',
        svc({ digest: '22bc66860cad28e8' }),
        (i) => i,
      ),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);

    const d = (await api('GET', `/applications/${id}`)).json();
    expect(d.page.id).toBe('mysql');
    expect(d.page.tabs.map((t: { id: string }) => t.id)).toEqual([...TABS, 'connection']);
    const reasons = d.reasons as { code: string; facts: Record<string, unknown> }[];
    const codes = reasons.map((r) => r.code);
    for (const c of [
      'connections_near_max',
      'long_query',
      'lock_waits',
      'deadlocks',
      'tmp_disk_tables_high',
    ])
      expect(codes, c).toContain(c);
    expect(reasons.find((r) => r.code === 'connections_near_max')!.facts).toMatchObject({
      n: 38,
      max: 40,
      pct: 95,
      top: 'shop/leak (36), shop/locker (1), shop/writer (1)',
    });
    // The holder as probable cause follows it: a workload "namespace/name" (ADR-163).
    expect(reasons.find((r) => r.code === 'lock_waits')!.facts).toMatchObject({
      who: 'shop/locker',
      holder: 'shop/locker',
      waiting: 'shop/writer',
      table: 'shop.stock',
      held: '23 s',
    });
    for (const r of reasons) expect(reasonSentence(r), r.code).not.toBe('See the facts.');

    const panels = async (tab: string) =>
      (await api('GET', `/applications/${id}/panels?tab=${tab}`)).json().panels as Panel[];
    for (const tab of TABS) {
      const ps = await panels(tab);
      expect(
        ps.filter((p) => p.state === 'needs_permission' || p.state === 'error'),
        tab,
      ).toEqual([]);
    }
    const overview = await panels('overview');
    const tiles = (
      overview.find((p) => p.id === 'summary') as unknown as {
        tiles: { id: string; value: number | null; severity?: string }[];
      }
    ).tiles;
    expect(tiles.find((t) => t.id === 'connections')).toMatchObject({
      value: 38,
      severity: 'warning',
    });
    expect(tiles.find((t) => t.id === 'buffer')!.value).toBeCloseTo(0.99, 2);
    expect(tiles.find((t) => t.id === 'longest')!.severity).toBe('critical');
    const blocking = (await panels('locks')).find((p) => p.id === 'blocking') as unknown as {
      rows: { cells: unknown[] }[];
    };
    expect(blocking.rows[0]!.cells).toEqual([
      'shop/writer',
      'shop.stock',
      '21 s',
      'shop/locker (Query)',
      '23 s',
    ]);
    const hist = (await panels('queries')).find((p) => p.id === 'duration') as unknown as {
      note: { key: string };
      buckets: { share: number }[];
    };
    expect(hist.note.key).toBe('integrations.mysql.panels.fromHistogram');
    expect(hist.buckets.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1, 5);
    const replication = await panels('replication');
    expect(replication.find((p) => p.id === 'threads')!.note).toEqual({
      key: 'integrations.mysql.panels.notReplicaNote',
    });

    const row = (await api('GET', '/applications/metrics')).json().metrics[id] as {
      keyMetrics: { id: string; value: number | null }[];
    };
    expect(row.keyMetrics[0]!.value).toBeCloseTo(0.95, 2);
  });

  it('MariaDB on Docker without performance_schema: the hint, and lock waits name the container', async () => {
    const docker = await cluster('fleet', 'docker');
    await ctx.db
      .insertInto('objects')
      .values({
        id: newId(),
        cluster_id: docker.id,
        source: 'docker',
        kind: 'DockerContainer',
        namespace: 'shop',
        name: 'shop-locker-1',
        uid: newId(),
        node: 'h1',
        spec_summary: JSON.stringify({ ips: ['172.18.0.5'], compose_service: 'locker' }),
        status_summary: JSON.stringify({ state: 'running' }),
      })
      .execute();
    const id = (
      await api('POST', '/applications', {
        clusterId: docker.id,
        type: 'mysql',
        target: {
          kind: 'compose',
          host: 'h1',
          compose_project: 'shop',
          compose_service: 'mariadb',
          port: 3306,
        },
      })
    ).json().application.id as string;
    await status(docker.token, 'h1', [
      {
        id,
        state: 'ok',
        service_version: '11.4.13',
        product: 'mariadb',
        members: [{ name: 'shop-mariadb-1', up: true }],
        permissions: [
          { tab: 'overview/slowest', missing: 'performance_schema' },
          { tab: 'queries/top', missing: 'performance_schema' },
        ],
        extra: {
          blocking: [
            {
              blocked: '172.18.0.6',
              blocked_user: 'app',
              blocking: '172.18.0.5',
              blocking_user: 'app',
              blocking_state: 'Query',
              seconds: 14,
              held: 16,
              table: 'shop.stock',
              member: 'shop-mariadb-1',
            },
          ],
          clients: [],
        },
      },
    ]);
    await write(
      docker.id,
      'watchlog_mysql_row_lock_current_waits',
      { service: id, service_type: 'mysql', member: 'shop-mariadb-1' },
      () => 1,
    );
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const d = (await api('GET', `/applications/${id}`)).json();
    expect(d.application.product).toBe('mariadb');
    const reasons = d.reasons as { code: string; facts: Record<string, unknown> }[];
    expect(reasons.map((r) => r.code)).toContain('performance_schema_off');
    // The hint says it all: no "needs permission" line for what performance_schema empties.
    expect(reasons.filter((r) => r.code === 'needs_permission')).toEqual([]);
    expect(reasons.find((r) => r.code === 'lock_waits')!.facts).toMatchObject({
      holder: 'shop-locker-1',
      waiting: '172.18.0.6',
    });
    const top = (
      (await api('GET', `/applications/${id}/panels?tab=queries`)).json().panels as Panel[]
    ).find((p) => p.id === 'top')!;
    expect(top.state).toBe('needs_permission');
    expect((top as unknown as { missing: { key: string } }).missing.key).toBe(
      'integrations.mysql.missing.queries.top',
    );
  });
});

describe('probable cause follows the finding to the holder', () => {
  const ev = (platform: string, code: string, facts: Record<string, string | number | null>) =>
    ({
      platform,
      application: {
        id: 'a',
        type: 'mysql',
        name: 'shop/mysql',
        health: 'warning',
        reason: { code: 'connected', facts: {} },
        target: {},
        reasons: [{ severity: 'warning', code, facts }],
      },
    }) as unknown as Evidence;

  it('lock_waits: the holder, a workload on Kubernetes and a container on Docker', () => {
    expect(linksOf(ev('kubernetes', 'lock_waits', { holder: 'shop/locker' }))[0]).toMatchObject({
      name: 'shop/locker',
      target: { kind: 'workload', namespace: 'shop', name: 'locker' },
    });
    expect(linksOf(ev('docker', 'lock_waits', { holder: 'shop-locker-1' }))[0]).toMatchObject({
      target: { kind: 'container', name: 'shop-locker-1' },
    });
    // An address the IP map doesn't know: no holder to follow.
    expect(linksOf(ev('kubernetes', 'lock_waits', { holder: null, who: '10.0.0.9' }))).toEqual([]);
  });

  it('connections_near_max with several clients: the first, holding most (measured: 36, 1, 1)', () => {
    expect(
      linksOf(
        ev('kubernetes', 'connections_near_max', {
          top: 'mysql-e2e/leak (36), mysql-e2e/locker (1), mysql-e2e/writer (1)',
        }),
      )[0],
    ).toMatchObject({ name: 'mysql-e2e/leak', n: 36 });
  });

  it('a step under MariaDB carries the product, so it says MariaDB, not MySQL', () => {
    const e = ev('docker', 'lock_waits', { holder: 'shop-locker-1' });
    const f = e.application!.reasons[0]!;
    expect(findingStep(e, e.application!, f, null).object.product).toBeUndefined();
    const maria = { ...e, application: { ...e.application!, product: 'mariadb' } } as Evidence;
    expect(findingStep(maria, maria.application!, f, null).object).toMatchObject({
      type: 'mysql',
      product: 'mariadb',
    });
  });
});

describe('a hint replaces the needs-permission lines it covers', () => {
  it('performance_schema off and innodb_table_stats; other permissions stay', () => {
    const perm = (tab: string, missing: string) => ({
      severity: 'info' as const,
      code: 'needs_permission',
      facts: { tab, missing },
    });
    const all = [
      perm('overview/slowest', 'performance_schema'),
      perm('queries/top', 'performance_schema'),
      perm('storage/tables', 'SELECT on mysql.innodb_table_stats'),
      perm('replication/status', 'REPLICATION CLIENT'),
    ];
    expect(foldPermissions(all)).toEqual(all);
    const hints = [
      { severity: 'info' as const, code: 'performance_schema_off', facts: {} },
      { severity: 'info' as const, code: 'table_stats_unavailable', facts: {} },
    ];
    expect(foldPermissions([...all, ...hints]).map((r) => r.facts.tab ?? r.code)).toEqual([
      'replication/status',
      'performance_schema_off',
      'table_stats_unavailable',
    ]);
  });
});
