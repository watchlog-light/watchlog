// SPDX-License-Identifier: AGPL-3.0-only
// The PostgreSQL page (v0.3 slice 8, SPEC §4.12): its tabs filled from the collector's
// pg_stat_* series, statements, blocking sessions, clients, vacuum and unused indexes
// from its status, the reasons, the data volume's capacity (the PVC on Kubernetes, the
// host filesystem on Docker), the list's numbers, the default rules with one firing,
// and "can't log in" when the password is refused.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { VictoriaQueryClient } from '../src/lib/victoria.js';
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

const RUN = `postgres-page-${Date.now()}`;
const MIN = 60_000;
const NOW = Math.floor(Date.now() / 15_000) * 15_000;
const vm = new VictoriaQueryClient(TEST_VM_URL);
const GB = 2 ** 30;

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
  await ctx.db.updateTable('orgs').set({ plan: 'pro' }).execute();
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

describe('the PostgreSQL page', () => {
  it('fills every tab, says what is wrong, and names the clients (Kubernetes)', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    await pod(k8s.id, 'shop', 'checkout-7d9f', 'checkout', '10.244.1.7');
    await pod(k8s.id, 'shop', 'orders-55f', 'orders', '10.244.1.8');
    const id = (
      await api('POST', '/applications', {
        clusterId: k8s.id,
        type: 'postgres',
        target: {
          kind: 'workload',
          namespace: 'shop',
          workload_kind: 'StatefulSet',
          workload: 'postgres',
          port: 5432,
        },
        defaultAlerts: ['postgres_connections_high'],
      })
    ).json().application.id as string;
    const now = Math.floor(NOW / 1000);
    await status(k8s.token, '', [
      {
        id,
        state: 'ok',
        service_version: '13.16',
        members: [{ name: 'postgres-0', up: true }],
        permissions: [
          { tab: 'overview/slowest', missing: 'pg_stat_statements' },
          { tab: 'queries/top', missing: 'pg_stat_statements' },
          { tab: 'queries/duration', missing: 'pg_stat_statements' },
        ],
        extra: {
          clients: [
            { addr: '10.244.1.7', app: '', connections: 70, member: 'postgres-0' },
            { addr: '10.244.1.8', app: '', connections: 20, member: 'postgres-0' },
            { addr: '', app: 'psql', connections: 2, member: 'postgres-0' },
          ],
          blocking: [
            {
              blocked: '10.244.1.8',
              blocked_state: 'active',
              wait: 'Lock transactionid',
              seconds: 95,
              blocking: '10.244.1.7',
              blocking_state: 'idle in transaction',
              blocked_query: '',
              blocking_query: '',
              member: 'postgres-0',
            },
          ],
          vacuum: [
            {
              db: 'shop',
              table: 'public.orders',
              dead: 400_000,
              live: 600_000,
              last_autovacuum: now - 7200,
              autovacuum_count: 3,
              member: 'postgres-0',
            },
          ],
          unused_indexes: [
            {
              db: 'shop',
              table: 'public.orders',
              index: 'orders_note',
              size: 64 * 2 ** 20,
              since: now - 86_400 * 3,
              member: 'postgres-0',
            },
          ],
          statements: [],
        },
      },
    ]);
    const svc = (extra: Record<string, string> = {}) => ({
      service: id,
      service_type: 'postgres',
      member: 'postgres-0',
      ...extra,
    });
    const pvc = {
      namespace: 'shop',
      workload_kind: 'StatefulSet',
      workload: 'postgres',
      pod: 'postgres-0',
      persistentvolumeclaim: 'data-postgres-0',
    };
    await Promise.all([
      write(k8s.id, 'watchlog_postgres_backends', svc({ state: 'active', wait: '' }), () => 60),
      write(k8s.id, 'watchlog_postgres_backends', svc({ state: 'idle', wait: 'Client' }), () => 28),
      write(
        k8s.id,
        'watchlog_postgres_backends',
        svc({ state: 'idle in transaction', wait: 'Lock' }),
        () => 4,
      ),
      write(k8s.id, 'watchlog_postgres_setting', svc({ name: 'max_connections' }), () => 100),
      write(
        k8s.id,
        'watchlog_postgres_setting',
        svc({ name: 'superuser_reserved_connections' }),
        () => 3,
      ),
      write(k8s.id, 'watchlog_postgres_setting', svc({ name: 'max_wal_size' }), () => GB),
      write(
        k8s.id,
        'watchlog_postgres_setting',
        svc({ name: 'autovacuum_freeze_max_age' }),
        () => 200_000_000,
      ),
      write(
        k8s.id,
        'watchlog_postgres_backend_max_seconds',
        svc({ state: 'active', wait: '', kind: 'active' }),
        (i) => 200 + i * 15,
      ),
      write(
        k8s.id,
        'watchlog_postgres_backend_max_seconds',
        svc({ state: 'idle in transaction', wait: 'Lock', kind: 'idle_in_transaction' }),
        () => 600,
      ),
      write(k8s.id, 'watchlog_postgres_xact_commit_total', svc({ db: 'shop' }), (i) => i * 3000),
      write(k8s.id, 'watchlog_postgres_xact_rollback_total', svc({ db: 'shop' }), (i) => i * 30),
      write(k8s.id, 'watchlog_postgres_blks_hit_total', svc({ db: 'shop' }), (i) => i * 8000),
      write(k8s.id, 'watchlog_postgres_blks_read_total', svc({ db: 'shop' }), (i) => i * 2000),
      write(k8s.id, 'watchlog_postgres_tup_fetched_total', svc({ db: 'shop' }), (i) => i * 900),
      write(k8s.id, 'watchlog_postgres_temp_bytes_total', svc({ db: 'shop' }), (i) => i * 1e6),
      write(k8s.id, 'watchlog_postgres_deadlocks_total', svc({ db: 'shop' }), (i) =>
        i > 100 ? 2 : 0,
      ),
      write(
        k8s.id,
        'watchlog_postgres_database_size_bytes',
        svc({ db: 'shop' }),
        (i) => 5 * GB + i * 2 ** 20,
      ),
      write(k8s.id, 'watchlog_postgres_xid_age', svc({ db: 'shop' }), () => 1_600_000_000),
      write(k8s.id, 'watchlog_postgres_is_replica', svc(), () => 0),
      write(
        k8s.id,
        'watchlog_postgres_replica_lag_seconds',
        svc({ replica: 'postgres-1', state: 'streaming', sync: 'async' }),
        () => 45,
      ),
      write(k8s.id, 'watchlog_postgres_slot_active', svc({ slot: 'old_slot' }), () => 0),
      write(
        k8s.id,
        'watchlog_postgres_slot_retained_bytes',
        svc({ slot: 'old_slot' }),
        () => 3 * GB,
      ),
      write(k8s.id, 'watchlog_postgres_wal_dir_bytes', svc(), () => 0.5 * GB),
      write(k8s.id, 'watchlog_postgres_wal_bytes_total', svc(), (i) => i * 1e7),
      write(k8s.id, 'watchlog_postgres_locked_relation', svc({ table: 'orders' }), () => 5),
      write(
        k8s.id,
        'watchlog_postgres_table_size_bytes',
        svc({ db: 'shop', table: 'public.orders' }),
        () => 2 * GB,
      ),
      write(
        k8s.id,
        'watchlog_postgres_table_bloat_bytes_estimate',
        svc({ db: 'shop', table: 'public.orders' }),
        () => 0.8 * GB,
      ),
      write(
        k8s.id,
        'watchlog_postgres_table_dead_rows',
        svc({ db: 'shop', table: 'public.orders' }),
        () => 400_000,
      ),
      write(
        k8s.id,
        'watchlog_pod_volume_bytes',
        { ...pvc, state: 'used' },
        (i) => 8 * GB + i * 2 ** 22,
      ),
      write(k8s.id, 'watchlog_pod_volume_bytes', { ...pvc, state: 'capacity' }, () => 10 * GB),
    ]);
    // Lock waits over 3 hours: the heatmap's hourly cells end at the last full hour.
    const waits: TestSeries[] = [];
    for (let t = NOW - 180 * MIN; t <= NOW; t += 60_000) {
      waits.push({
        labels: { __name__: 'watchlog_postgres_lock_waits', run: RUN, ...svc() },
        value: 3,
        timestampMs: t,
      });
    }
    await vm.write({ clusterId: k8s.id }, encode(waits));
    await fetch(`${TEST_VM_URL}/internal/force_flush`);

    const d = (await api('GET', `/applications/${id}`)).json();
    expect(d.page.id).toBe('postgres');
    expect(d.page.tabs.map((t: { id: string }) => t.id)).toEqual([
      'overview',
      'connections',
      'queries',
      'locks',
      'replication',
      'tables',
      'vacuum',
      'connection',
    ]);
    const reasons = d.reasons as {
      code: string;
      severity: string;
      facts: Record<string, unknown>;
    }[];
    const codes = reasons.map((r) => r.code);
    for (const c of [
      'connections_near_max',
      'long_query',
      'idle_in_transaction',
      'lock_waits',
      'deadlocks',
      'replica_lag',
      'slot_retains_wal',
      'wraparound_risk',
      'cache_hit_low',
      'statements_unavailable',
    ]) {
      expect(codes, c).toContain(c);
    }
    expect(reasons.find((r) => r.code === 'connections_near_max')).toMatchObject({
      severity: 'warning',
      facts: { n: 92, max: 100, pct: 92, top: 'shop/checkout (70), shop/orders (20), psql (2)' },
    });
    expect(reasons.find((r) => r.code === 'lock_waits')!.facts.who).toBe('shop/checkout');
    // MCP explains each reason in a sentence; the facts carry the numbers and names.
    for (const r of reasons) expect(reasonSentence(r), r.code).not.toBe('See the facts.');
    expect(reasons.find((r) => r.code === 'wraparound_risk')).toMatchObject({
      severity: 'critical',
      facts: { db: 'shop', n: '1600 M' },
    });
    expect(reasons.find((r) => r.code === 'slot_retains_wal')!.facts).toEqual({
      slot: 'old_slot',
      size: '3.0 GB',
    });

    const tab = async (t: string) =>
      (await api('GET', `/applications/${id}/panels?tab=${t}`)).json().panels as Panel[];
    const panel = (ps: Panel[], pid: string) => ps.find((p) => p.id === pid)!;

    const ov = await tab('overview');
    const tiles = panel(ov, 'summary').tiles as {
      id: string;
      value: number;
      sub?: { values?: Record<string, unknown> };
      severity?: string;
    }[];
    expect(tiles.find((t) => t.id === 'connections')).toMatchObject({
      value: 92,
      sub: { values: { max: 100 } },
      severity: 'warning',
    });
    expect(tiles.find((t) => t.id === 'tps')!.value).toBeCloseTo(202, 0);
    expect(tiles.find((t) => t.id === 'tps')!.sub!.values!.pct).toBe(99);
    expect(tiles.find((t) => t.id === 'cache')!.value).toBeCloseTo(0.8, 2);
    expect(tiles.find((t) => t.id === 'lag')).toMatchObject({ value: 45, severity: 'warning' });
    expect(tiles.find((t) => t.id === 'longest')!.severity).toBe('critical');
    expect(panel(ov, 'slowest').state).toBe('needs_permission');
    expect(panel(ov, 'slowest').missing).toEqual({
      key: 'integrations.postgres.missing.overview.slowest',
      values: { missing: 'pg_stat_statements' },
    });
    const cap = panel(ov, 'capacity').items as {
      label?: string;
      value: number;
      max: number;
      note?: { key: string; values?: Record<string, unknown> };
    }[];
    expect(cap[0]).toMatchObject({ value: 92, max: 100, note: { values: { n: 3 } } });
    // The PVC: 8 GB of 10 GB, growing; days left at that growth.
    expect(cap[1]).toMatchObject({ label: 'data-postgres-0', max: 10 * GB });
    expect(cap[1]!.note!.key).toMatch(/daysLeft|notGrowing/);

    const conns = await tab('connections');
    expect(panel(conns, 'by-client').items).toEqual([
      { label: 'shop/checkout', value: 70 },
      { label: 'shop/orders', value: 20 },
      { label: 'psql', value: 2 },
    ]);
    expect(panel(conns, 'by-state').state).toBe('ok');
    expect(panel(conns, 'new').note).toMatchObject({ values: { version: '13.16' } });

    const q = await tab('queries');
    expect(panel(q, 'top').state).toBe('needs_permission');
    expect(panel(q, 'rows').state).toBe('ok');
    expect(panel(q, 'temp').state).toBe('ok');

    const locks = await tab('locks');
    const blocking = panel(locks, 'blocking') as unknown as { rows: { cells: unknown[] }[] };
    expect(blocking.rows[0]!.cells.slice(0, 4)).toEqual([
      'shop/orders (active)',
      'Lock transactionid',
      '2 min',
      'shop/checkout (idle in transaction)',
    ]);
    expect(panel(locks, 'locked').items).toEqual([{ label: 'orders', value: 5 }]);
    expect(panel(locks, 'waits').state).toBe('ok');
    expect(panel(locks, 'heat').state).toBe('ok');

    const rep = await tab('replication');
    expect(
      (panel(rep, 'replicas') as unknown as { rows: { cells: unknown[] }[] }).rows[0]!.cells,
    ).toEqual(['postgres-1', 'streaming', 'async', '45.00 s']);
    expect(panel(rep, 'wal').items).toEqual([
      expect.objectContaining({ value: 0.5 * GB, max: GB }),
      expect.objectContaining({ value: 0, max: 1, note: expect.anything() }),
    ]);

    const tables = await tab('tables');
    expect(panel(tables, 'largest').items).toEqual([
      { label: 'shop: public.orders', value: 2 * GB },
    ]);
    expect(panel(tables, 'bloat').note).toEqual({ key: 'integrations.postgres.panels.bloatNote' });
    expect((panel(tables, 'unused') as unknown as { rows: { cells: unknown[] }[] }).rows).toEqual([
      { cells: ['orders_note', 'public.orders', 'shop', '64 MB'] },
    ]);

    const vac = await tab('vacuum');
    expect(
      (panel(vac, 'waiting') as unknown as { rows: { cells: unknown[] }[] }).rows[0]!.cells,
    ).toEqual(['public.orders', 'shop', 400_000, '40 %', '2 h ago', 'due for vacuum']);
    expect(panel(vac, 'xid').items).toEqual([
      expect.objectContaining({ label: 'shop', value: 1_600_000_000, note: expect.anything() }),
    ]);

    const list = (await api('GET', '/applications/metrics')).json().metrics[id];
    expect(list.keyMetrics.map((m: { id: string }) => m.id)).toEqual([
      'connections',
      'tps',
      'cache',
    ]);
    expect(list.keyMetrics[0]).toMatchObject({ unit: 'ratio', severity: 'warning' });

    // The default rule started on fires on the series above, scoped to this service.
    const rules = (await api('GET', '/alert-rules')).json().rules as {
      id: string;
      defaultKey: string | null;
      enabled: boolean;
    }[];
    const mine = rules.filter((r) => r.defaultKey?.startsWith('postgres_'));
    expect(mine.map((r) => r.defaultKey).sort()).toEqual([
      'postgres_connections_high',
      'postgres_deadlocks',
      'postgres_long_query',
      'postgres_replication_lag',
      'postgres_xid_age',
    ]);
    const high = mine.find((r) => r.defaultKey === 'postgres_connections_high')!;
    expect(high.enabled).toBe(true);
    const clock = { now: NOW - 10 * MIN };
    const worker = testWorker(ctx.db, clock, lookupEvaluator, { victoria: vm });
    for (let i = 0; i < 14; i++) {
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
        labels: expect.objectContaining({ service_name: 'shop/postgres', member: 'postgres-0' }),
      }),
    ]);
  });

  it('on Docker: the host filesystem is the capacity, and a refused password reads "can\'t log in"', async () => {
    const fleet = await cluster('docker-01', 'docker');
    const id = (
      await api('POST', '/applications', {
        clusterId: fleet.id,
        type: 'postgres',
        target: {
          kind: 'compose',
          host: 'docker-01',
          compose_project: 'storefront',
          compose_service: 'db',
          port: 5432,
        },
      })
    ).json().application.id as string;
    await status(fleet.token, 'docker-01', [
      { id, state: 'ok', members: [{ name: 'storefront-db-1', up: true }], extra: {} },
    ]);
    const fs = (mount: string, state: string) => ({ host: 'docker-01', mount, state });
    await Promise.all([
      write(fleet.id, 'watchlog_node_filesystem_bytes', fs('/', 'size'), () => 100 * GB),
      write(fleet.id, 'watchlog_node_filesystem_bytes', fs('/', 'avail'), () => 40 * GB),
      write(
        fleet.id,
        'watchlog_node_filesystem_bytes',
        fs('/var/lib/docker', 'size'),
        () => 500 * GB,
      ),
      write(
        fleet.id,
        'watchlog_node_filesystem_bytes',
        fs('/var/lib/docker', 'avail'),
        () => 100 * GB,
      ),
      write(fleet.id, 'watchlog_node_filesystem_bytes', fs('/boot', 'size'), () => GB),
      write(fleet.id, 'watchlog_node_filesystem_bytes', fs('/boot', 'avail'), () => 0.1 * GB),
      write(
        fleet.id,
        'watchlog_postgres_setting',
        {
          service: id,
          service_type: 'postgres',
          member: 'storefront-db-1',
          name: 'max_connections',
        },
        () => 100,
      ),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const ov = (await api('GET', `/applications/${id}/panels?tab=overview`)).json()
      .panels as Panel[];
    const cap = ov.find((p) => p.id === 'capacity')!.items as {
      label?: string;
      value: number;
      max: number;
    }[];
    expect(cap[1]).toMatchObject({
      label: 'docker-01:/var/lib/docker',
      value: 400 * GB,
      max: 500 * GB,
    });

    await status(fleet.token, 'docker-01', [
      {
        id,
        state: 'error',
        code: 'auth_failed',
        error: 'password authentication failed for user "watchlog"',
        members: [{ name: 'storefront-db-1', up: false }],
      },
    ]);
    const d = (await api('GET', `/applications/${id}`)).json();
    expect(d.application.reason).toEqual({
      code: 'login_failed',
      facts: { error: 'password authentication failed for user "watchlog"' },
    });
    expect(d.application.health).toBe('critical');
  });
});
