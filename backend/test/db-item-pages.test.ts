// SPDX-License-Identifier: AGPL-3.0-only
// A database's statement and table pages (1.2, ADR-245), from the collector's statement
// series and status as the agent sends them: a statement far slower than its usual mean for
// the last 14 minutes, sent mostly by one workload or container, the tables it names opening
// their own pages, and a table's page listing the statements that name it. PostgreSQL on a
// Kubernetes cluster, MySQL on a server fleet. Seven hours of series written at full speed.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { authorisedScope, VictoriaQueryClient } from '../src/lib/victoria.js';
import {
  TEST_VM_URL,
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `db-item-pages-${Date.now()}`;
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

/** Seven hours of a counter or gauge, every 30 s, from `value(t)` (ms before NOW). */
async function write(
  clusterId: string,
  name: string,
  labels: Record<string, string>,
  value: (ago: number) => number,
) {
  const series: TestSeries[] = [];
  for (let t = NOW - 7 * 60 * MIN; t <= NOW; t += 30_000) {
    series.push({
      labels: { __name__: name, run: RUN, ...labels },
      value: value(NOW - t),
      timestampMs: t,
    });
  }
  await vm.write(authorisedScope(clusterId), encode(series));
}

/**
 * A statement's counters: 10 calls a second for 7 hours, 1 ms each until 14 minutes ago and
 * `slow` seconds each since (inside the last 15 minutes the page reads, after the 6 hours of
 * its usual mean); the counters' values at `ago` ms before NOW.
 */
function counters(slow: number) {
  const calls = (ago: number) => (7 * 3600 - ago / 1000) * 10;
  const seconds = (ago: number) => {
    const t = 7 * 3600 - ago / 1000;
    const fastFor = 7 * 3600 - 14 * 60;
    return Math.min(t, fastFor) * 10 * 0.001 + Math.max(0, t - fastFor) * 10 * slow;
  };
  return { calls, seconds };
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

async function object(
  clusterId: string,
  o: { kind: string; namespace: string; name: string; node: string; spec: object; status: object },
) {
  await ctx.db
    .insertInto('objects')
    .values({
      id: newId(),
      cluster_id: clusterId,
      source: o.kind === 'Pod' ? 'kubernetes' : 'docker',
      kind: o.kind,
      namespace: o.namespace,
      name: o.name,
      uid: newId(),
      node: o.node,
      spec_summary: JSON.stringify(o.spec),
      status_summary: JSON.stringify(o.status),
    })
    .execute();
}

type Panel = { id: string; kind: string; state: string; [k: string]: unknown };
const panels = async (id: string, query: string) =>
  (await api('GET', `/applications/${id}/panels?${query}&range=3600`)).json().panels as Panel[];
const find = (ps: Panel[], id: string) => ps.find((p) => p.id === id)!;

describe("a database's statement and table pages", () => {
  it('PostgreSQL on Kubernetes: slower than usual, sent by checkout, its table one click away', async () => {
    const c = await api('POST', '/clusters', { name: 'prod', kind: 'kubernetes' });
    const k8s = { id: c.json().cluster.id as string, token: c.json().token.value as string };
    await object(k8s.id, {
      kind: 'Pod',
      namespace: 'shop',
      name: 'checkout-7d9f',
      node: 'w1',
      spec: { workload: { kind: 'Deployment', name: 'checkout' } },
      status: { pod_ip: '10.244.1.7', phase: 'Running' },
    });
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
      })
    ).json().application.id as string;
    await status(k8s.token, '', [
      {
        id,
        state: 'ok',
        service_version: '16.4',
        members: [{ name: 'postgres-0', up: true }],
        extra: {
          statements: [
            {
              queryid: '111',
              query: 'update shop.stock set qty = qty - $1 where sku = $2',
              calls: 252000,
              blocks: 4,
              rows: 1,
              member: 'postgres-0',
            },
            {
              queryid: '222',
              query: 'select count(*) from shop.events where created_at > $1',
              calls: 2520,
              blocks: 290000,
              rows: 1,
              member: 'postgres-0',
            },
          ],
        },
      },
    ]);
    const svc = { service: id, service_type: 'postgres', member: 'postgres-0' };
    const slow = counters(0.5);
    const steady = counters(0.001);
    await Promise.all([
      write(
        k8s.id,
        'watchlog_postgres_statement_calls_total',
        { ...svc, queryid: '111' },
        slow.calls,
      ),
      write(
        k8s.id,
        'watchlog_postgres_statement_seconds_total',
        { ...svc, queryid: '111' },
        slow.seconds,
      ),
      write(
        k8s.id,
        'watchlog_postgres_statement_rows_total',
        { ...svc, queryid: '111' },
        slow.calls,
      ),
      write(
        k8s.id,
        'watchlog_postgres_statement_calls_total',
        { ...svc, queryid: '222' },
        steady.calls,
      ),
      write(
        k8s.id,
        'watchlog_postgres_statement_seconds_total',
        { ...svc, queryid: '222' },
        steady.seconds,
      ),
      // checkout ran it last in each sample: "sent mostly by".
      write(
        k8s.id,
        'watchlog_postgres_statement_client_sessions',
        { ...svc, queryid: '111', addr: '10.244.1.7' },
        () => 1,
      ),
      // shop.stock and shop.events in the catalog, events read by sequential scans.
      write(
        k8s.id,
        'watchlog_postgres_table_seq_rows_read_total',
        { ...svc, db: 'shop', table: 'shop.stock' },
        () => 0,
      ),
      write(
        k8s.id,
        'watchlog_postgres_table_seq_rows_read_total',
        { ...svc, db: 'shop', table: 'shop.events' },
        (ago) => (7 * 3600e3 - ago) * 100,
      ),
      write(
        k8s.id,
        'watchlog_postgres_table_size_bytes',
        { ...svc, db: 'shop', table: 'shop.stock' },
        () => 8 << 20,
      ),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);

    // The costly statements: 111 first, far slower than usual, sent by shop/checkout.
    const queries = find(await panels(id, 'tab=queries'), 'top');
    const rows = queries.rows as {
      id: string;
      mean: number;
      usual: number;
      sentBy: { name: string } | null;
      hint?: { key: string; values: Record<string, unknown> };
    }[];
    expect(rows[0]).toMatchObject({ id: '111', sentBy: { name: 'shop/checkout' } });
    expect(rows[0]!.mean).toBeGreaterThan(0.4);
    expect(rows[0]!.usual).toBeCloseTo(0.001, 3);
    expect(rows[0]!.hint).toMatchObject({ key: 'integrations.db.panels.hint.slower' });
    // 222 reads 290,000 blocks a row on a table full scans read: probably missing an index.
    expect(rows.find((r) => r.id === '222')!.hint).toEqual({
      key: 'integrations.db.panels.hint.index',
      values: { table: 'shop.events' },
    });

    // Its own page: the senders, the tables it names opening theirs, its alerts.
    const page = await panels(id, 'tab=statement&statement=111');
    expect(find(page, 'senders').state).toBe('ok');
    const tables = find(page, 'tables') as unknown as {
      rows: { cells: unknown[]; link?: { kind: string; id: string } }[];
    };
    expect(tables.rows[0]).toMatchObject({
      cells: ['shop: shop.stock', '0'],
      link: { kind: 'table', id: 'shop/shop.stock' },
    });
    expect(find(page, 'alerts')).toMatchObject({
      kind: 'scoped_alerts',
      scope: { statement: '111' },
    });

    // The table's page lists the statements that name it.
    const table = await panels(id, 'tab=table&table=shop/shop.stock');
    const naming = find(table, 'statements') as unknown as { rows: { id: string }[] };
    expect(naming.rows.map((r) => r.id)).toEqual(['111']);
    expect(find(table, 'alerts')).toMatchObject({ scope: { table: 'shop/shop.stock' } });
  });

  it('MySQL on a server fleet: a container sends it, the digest names its table', async () => {
    const c = await api('POST', '/clusters', { name: 'office', kind: 'server' });
    const fleet = { id: c.json().cluster.id as string, token: c.json().token.value as string };
    await object(fleet.id, {
      kind: 'DockerContainer',
      namespace: 'billing',
      name: 'billing-report-1',
      node: 'db-01',
      spec: { image: 'report:1', compose_service: 'report', ips: ['172.18.0.9'] },
      status: { state: 'running' },
    });
    const id = (
      await api('POST', '/applications', {
        clusterId: fleet.id,
        type: 'mysql',
        target: { kind: 'native', host: 'db-01', source: 'service', workload: 'mysql', port: 3306 },
      })
    ).json();
    expect(id.application?.id, JSON.stringify(id)).toBeTruthy();
    const app = id.application.id as string;
    await status(fleet.token, 'db-01', [
      {
        id: app,
        state: 'ok',
        service_version: '8.4.3',
        members: [{ name: '127.0.0.1:3306', up: true }],
        extra: {
          statements: [
            {
              digest: 'abc',
              query: 'SELECT COUNT ( * ) FROM EVENTS WHERE `created_at` > ?',
              calls: 2520,
              rows_examined: 5_000_000,
              rows_sent: 1,
              no_index: 2520,
              member: '127.0.0.1:3306',
            },
          ],
        },
      },
    ]);
    const svc = { service: app, service_type: 'mysql', member: '127.0.0.1:3306' };
    const slow = counters(0.04);
    await Promise.all([
      write(
        fleet.id,
        'watchlog_mysql_statement_calls_total',
        { ...svc, digest: 'abc' },
        slow.calls,
      ),
      write(
        fleet.id,
        'watchlog_mysql_statement_seconds_total',
        { ...svc, digest: 'abc' },
        slow.seconds,
      ),
      write(
        fleet.id,
        'watchlog_mysql_statement_rows_sent_total',
        { ...svc, digest: 'abc' },
        slow.calls,
      ),
      write(
        fleet.id,
        'watchlog_mysql_statement_client_sessions',
        { ...svc, digest: 'abc', addr: '172.18.0.9' },
        () => 1,
      ),
      write(
        fleet.id,
        'watchlog_mysql_table_full_scan_rows_total',
        { ...svc, db: 'billing', table: 'events' },
        (ago) => (7 * 3600e3 - ago) * 50,
      ),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);

    const top = find(await panels(app, 'tab=queries'), 'top');
    const row = (
      top.rows as { id: string; sentBy: { name: string } | null; hint?: { key: string } }[]
    )[0]!;
    expect(row).toMatchObject({ id: 'abc', sentBy: { name: 'billing-report-1' } });
    expect(row.hint?.key).toBe('integrations.db.panels.hint.slower');

    const page = await panels(app, 'tab=statement&statement=abc');
    const tables = find(page, 'tables') as unknown as {
      rows: { cells: unknown[]; link?: { id: string } }[];
    };
    // FROM EVENTS (the digest's capitals) is billing.events, which full scans read.
    expect(tables.rows[0]).toMatchObject({
      cells: ['billing.events', expect.any(String)],
      link: { id: 'billing/events' },
    });
    const naming = find(
      await panels(app, 'tab=table&table=billing/events'),
      'statements',
    ) as unknown as { rows: { id: string }[] };
    expect(naming.rows.map((r) => r.id)).toEqual(['abc']);
  });
});
