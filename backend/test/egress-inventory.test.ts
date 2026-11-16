// SPDX-License-Identifier: AGPL-3.0-only
// Egress watch's inventory (ADR-185, v0.7 slice 2): the minute job, the first-seen look-back
// and the 90-day forgetting, on an injectable clock; never by waiting. The series are the
// shapes slice 1 recorded on the e2e kind cluster and Docker host, answered by a fake
// VictoriaMetrics; the PromQL itself runs against the real test VictoriaMetrics below
// (keep-alive bytes, an idle edge, a gap and its reset, the look-back by day).
import { sql } from 'kysely';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { createDb, type Database } from '../src/db/index.js';
import { MIGRATIONS_DIR, migrateUp } from '../src/db/migrate.js';
import { newId } from '../src/lib/ids.js';
import {
  authorisedScope,
  VictoriaQueryClient,
  type ClusterScope,
  type QuerySeries,
} from '../src/lib/victoria.js';
import {
  classifyDestination,
  EGRESS_LOOKBACK_DAYS,
  minuteQuery,
  runEgressBackfill,
  runEgressForget,
  runEgressMinute,
  sourceOf,
  type EgressDeps,
} from '../src/modules/egress/inventory.js';
import { TEST_VM_URL } from './helpers.js';
import { appUrlOf, ensureAppRole } from './isolation/cloud.js';
import { encode, type TestSeries } from './support/remote-write.js';

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 15, 8, 0, 0);
const silent = { warn: () => {} };

// ------------------------------------------------------------------------------ fakes

type Answer = (clusterId: string, expr: string, timeSec: number) => QuerySeries[];

/** A VictoriaMetrics that answers from recorded series and keeps the queries it was asked. */
class FakeVictoria {
  queries: { clusterId: string; expr: string; time: number }[] = [];
  answer: Answer = () => [];
  async query(scope: ClusterScope, expr: string, time?: number): Promise<QuerySeries[]> {
    this.queries.push({ clusterId: scope.clusterId, expr, time: time ?? 0 });
    return this.answer(scope.clusterId, expr, time ?? 0);
  }
}

const row = (labels: Record<string, string>, value: number): QuerySeries => ({
  labels,
  points: [[0, value]],
});

/** Kubernetes labels as the minute query returns them (node summed away). */
const k8s = (workload: string, dst: string, port: string | null, extra = {}) => ({
  namespace: 'shop',
  workload_kind: 'Deployment',
  workload,
  dst_kind: dst === 'Internet' ? 'internet' : 'external',
  dst,
  ...(port ? { dst_port: port } : {}),
  ...extra,
});

/** Docker labels: host and container always, Compose when the container has it. */
const docker = (
  container: string,
  dst: string,
  port: string | null,
  compose?: { project: string; service: string },
) => ({
  host: 'docker-host-1',
  container,
  ...(compose ? { compose_project: compose.project, compose_service: compose.service } : {}),
  dst_kind: dst === 'Internet' ? 'internet' : 'external',
  dst,
  ...(port ? { dst_port: port } : {}),
});

// ------------------------------------------------------------------------------ database

let db: Database;

beforeAll(() => {
  db = createDb(inject('databaseUrl'));
});
afterAll(async () => {
  await db.destroy();
});

async function orgWith(
  kind: 'kubernetes' | 'docker',
  firstSeenAt: number | null = T0 - 60 * DAY,
): Promise<{ orgId: string; clusterId: string }> {
  const orgId = newId();
  const clusterId = newId();
  await db
    .insertInto('orgs')
    .values({ id: orgId, name: 'Acme', slug: `acme-${orgId.slice(-8)}`, plan: 'community' })
    .execute();
  await db
    .insertInto('clusters')
    .values({
      id: clusterId,
      org_id: orgId,
      name: kind,
      kind,
      first_seen_at: firstSeenAt === null ? null : new Date(firstSeenAt),
    })
    .execute();
  return { orgId, clusterId };
}

function depsFor(vm: Pick<VictoriaQueryClient, 'query'>, orgs: string[], on = db): EgressDeps {
  return { db: on, victoria: vm, orgs: async () => orgs, log: silent };
}

async function rows(clusterId: string) {
  return db
    .selectFrom('egress_destinations')
    .select([
      'org_id',
      'source',
      'destination',
      'dst_kind',
      'port',
      'destination_class',
      'first_seen',
      'first_seen_before',
      'last_seen',
    ])
    .where('cluster_id', '=', clusterId)
    .execute()
    .then((list) =>
      // Code point order, whatever the database's collation.
      list.sort((a, b) =>
        a.destination === b.destination ? a.port - b.port : a.destination < b.destination ? -1 : 1,
      ),
    );
}

async function sources(clusterId: string) {
  return db
    .selectFrom('egress_sources')
    .select(['source', 'first_seen', 'last_seen'])
    .where('cluster_id', '=', clusterId)
    .execute();
}

beforeEach(async () => {
  await sql`TRUNCATE orgs, clusters CASCADE`.execute(db);
});

// ------------------------------------------------------------------------------ pure parts

describe('what a destination is (slice 1: private networks and local names are quiet)', () => {
  it.each([
    ['external', 'api.github.com', 'name'],
    ['external', 'registry-1.docker.io', 'name'],
    ['external', 'demo-control-plane', 'local_name'],
    ['external', 'api', 'local_name'],
    ['external', '104.18.43.0/24', 'public_network'],
    ['external', '1.1.1.0/24', 'public_network'],
    ['external', '10.244.1.0/24', 'private_network'],
    ['external', '172.18.0.0/24', 'private_network'],
    ['external', '192.168.5.0/24', 'private_network'],
    ['external', '100.64.3.0/24', 'private_network'],
    ['external', '127.0.0.0/24', 'private_network'],
    ['external', '169.254.169.0/24', 'private_network'],
    ['external', '2606:4700:4700::/48', 'public_network'],
    ['external', 'fd12:3456:789a::/48', 'private_network'],
    ['external', 'fe80::/48', 'private_network'],
    ['internet', 'Internet', 'internet'],
  ])('%s %s is %s', (kind, dst, cls) => {
    expect(classifyDestination(kind, dst)).toBe(cls);
  });
});

describe('the source, in each platform’s vocabulary', () => {
  it('Kubernetes: namespace, workload kind and workload (no node, no pod)', () => {
    expect(sourceOf('kubernetes', { ...k8s('orders', 'x.io', '443'), node: 'n1' })).toEqual({
      namespace: 'shop',
      workload_kind: 'Deployment',
      workload: 'orders',
    });
    expect(sourceOf('kubernetes', { dst: 'x.io' })).toBeNull();
  });

  it('Docker: the Compose service when there is one, else the container on its host', () => {
    expect(
      sourceOf('docker', docker('shop-api-1', 'x.io', '443', { project: 'shop', service: 'api' })),
    ).toEqual({ compose_project: 'shop', compose_service: 'api' });
    expect(sourceOf('docker', docker('redis', 'x.io', '443'))).toEqual({
      host: 'docker-host-1',
      container: 'redis',
    });
    expect(sourceOf('docker', { host: 'h', dst: 'x.io' })).toBeNull();
  });

  it('the minute query sums node away and groups by the platform’s labels', () => {
    const q = minuteQuery('kubernetes');
    expect(q).toContain('sum by (namespace, workload_kind, workload, dst_kind, dst, dst_port)');
    expect(q).not.toContain('node');
    expect(q).toContain(
      'increase(watchlog_flow_connections_total{dst_kind=~"external|internet"}[2m])',
    );
    expect(q).toContain('increase(watchlog_flow_bytes_total{dst_kind=~"external|internet"}[2m])');
    expect(minuteQuery('docker')).toContain(
      'sum by (host, container, compose_project, compose_service, dst_kind, dst, dst_port)',
    );
  });
});

// ------------------------------------------------------------------------------ minute job

describe('the minute job', () => {
  it('Kubernetes: a workload’s destinations become rows with first and last seen; sources too', async () => {
    const { orgId, clusterId } = await orgWith('kubernetes');
    const vm = new FakeVictoria();
    vm.answer = () => [
      row(k8s('orders', 'api.stripe.com', '443'), 4),
      row(k8s('orders', '10.96.0.0/24', '443'), 2),
      row(k8s('orders', 'demo-control-plane', '6443'), 1),
      row(k8s('traefik', 'update.traefik.io', '443'), 1),
    ];
    const report = await runEgressMinute(depsFor(vm, [orgId]), T0);
    expect(report).toEqual({ clusters: 1, rows: 4, errors: [] });
    expect(vm.queries).toHaveLength(1);
    expect(vm.queries[0]!.time).toBe(T0 / 1000);

    const got = await rows(clusterId);
    expect(got.map((r) => [r.destination, r.port, r.destination_class])).toEqual([
      ['10.96.0.0/24', 443, 'private_network'],
      ['api.stripe.com', 443, 'name'],
      ['demo-control-plane', 6443, 'local_name'],
      ['update.traefik.io', 443, 'name'],
    ]);
    for (const r of got) {
      expect(r.org_id).toBe(orgId);
      expect(r.first_seen.getTime()).toBe(T0);
      expect(r.last_seen.getTime()).toBe(T0);
      expect(r.first_seen_before).toBe(false);
    }
    expect(got[1]!.source).toEqual({
      namespace: 'shop',
      workload_kind: 'Deployment',
      workload: 'orders',
    });
    const src = await sources(clusterId);
    expect(src).toHaveLength(2);
    expect(src.every((s) => s.first_seen.getTime() === T0)).toBe(true);
  });

  it('a later use moves last seen only; first seen and the row stay', async () => {
    const { orgId, clusterId } = await orgWith('kubernetes');
    const vm = new FakeVictoria();
    vm.answer = () => [row(k8s('orders', 'api.stripe.com', '443'), 1)];
    await runEgressMinute(depsFor(vm, [orgId]), T0);
    await runEgressMinute(depsFor(vm, [orgId]), T0 + 3 * MIN);
    const got = await rows(clusterId);
    expect(got).toHaveLength(1);
    expect(got[0]!.first_seen.getTime()).toBe(T0);
    expect(got[0]!.last_seen.getTime()).toBe(T0 + 3 * MIN);
    // The same minute again (a second worker, a retry) changes nothing.
    await runEgressMinute(depsFor(vm, [orgId]), T0 + 3 * MIN);
    expect((await rows(clusterId))[0]!.last_seen.getTime()).toBe(T0 + 3 * MIN);
    // A clock that went back never moves last seen backwards.
    await runEgressMinute(depsFor(vm, [orgId]), T0 + MIN);
    expect((await rows(clusterId))[0]!.last_seen.getTime()).toBe(T0 + 3 * MIN);
    const [s] = await sources(clusterId);
    expect([s!.first_seen.getTime(), s!.last_seen.getTime()]).toEqual([T0, T0 + 3 * MIN]);
  });

  it('gaps and re-use: idle minutes leave last seen; the edge used again is the same row', async () => {
    const { orgId, clusterId } = await orgWith('kubernetes');
    const vm = new FakeVictoria();
    let used = true;
    // An idle edge keeps its unchanged counter for 10 minutes: increase 0, which the query's
    // `> 0` drops; a 0 that slips through is ignored too.
    vm.answer = () => (used ? [row(k8s('orders', 'amazon.com', '443'), 3)] : []);
    await runEgressMinute(depsFor(vm, [orgId]), T0);
    used = false;
    for (let m = 1; m <= 12; m++) await runEgressMinute(depsFor(vm, [orgId]), T0 + m * MIN);
    vm.answer = () => [row(k8s('orders', 'amazon.com', '443'), 0)];
    await runEgressMinute(depsFor(vm, [orgId]), T0 + 13 * MIN);
    expect((await rows(clusterId))[0]!.last_seen.getTime()).toBe(T0);
    // Redialled after the series ended: it comes back from 0, the increase is the new use.
    used = true;
    vm.answer = () => [row(k8s('orders', 'amazon.com', '443'), 1)];
    await runEgressMinute(depsFor(vm, [orgId]), T0 + 15 * MIN);
    const got = await rows(clusterId);
    expect(got).toHaveLength(1);
    expect(got[0]!.first_seen.getTime()).toBe(T0);
    expect(got[0]!.last_seen.getTime()).toBe(T0 + 15 * MIN);
  });

  it('"Internet" is one row per source with port 0, never a name', async () => {
    const { orgId, clusterId } = await orgWith('kubernetes');
    const vm = new FakeVictoria();
    vm.answer = () => [
      row(k8s('dialer', 'Internet', null), 18),
      row(k8s('orders', 'Internet', null), 2),
      row(k8s('dialer', 'amazon.com', '443'), 1),
    ];
    await runEgressMinute(depsFor(vm, [orgId]), T0);
    const internet = (await rows(clusterId)).filter((r) => r.dst_kind === 'internet');
    expect(internet).toHaveLength(2);
    for (const r of internet) {
      expect([r.destination, r.port, r.destination_class]).toEqual(['Internet', 0, 'internet']);
    }
  });

  it('Docker: Compose replicas are one source, a re-created container keeps its rows, plain containers by host', async () => {
    const { orgId, clusterId } = await orgWith('docker');
    const vm = new FakeVictoria();
    const api = { project: 'shop', service: 'api' };
    vm.answer = () => [
      row(docker('shop-api-1', 'api.stripe.com', '443', api), 2),
      row(docker('shop-api-2', 'api.stripe.com', '443', api), 1),
      row(docker('redis', '1.1.1.0/24', '443'), 5),
      row(docker('redis', 'Internet', null), 1),
    ];
    await runEgressMinute(depsFor(vm, [orgId]), T0);
    let got = await rows(clusterId);
    expect(got.map((r) => [r.source, r.destination, r.port, r.destination_class])).toEqual([
      [{ host: 'docker-host-1', container: 'redis' }, '1.1.1.0/24', 443, 'public_network'],
      [{ host: 'docker-host-1', container: 'redis' }, 'Internet', 0, 'internet'],
      [{ compose_project: 'shop', compose_service: 'api' }, 'api.stripe.com', 443, 'name'],
    ]);
    // Re-created: a new container name, the same Compose service.
    vm.answer = () => [row(docker('shop-api-1-new', 'api.stripe.com', '443', api), 1)];
    await runEgressMinute(depsFor(vm, [orgId]), T0 + 10 * MIN);
    got = await rows(clusterId);
    const stripe = got.filter((r) => r.destination === 'api.stripe.com');
    expect(stripe).toHaveLength(1);
    expect(stripe[0]!.first_seen.getTime()).toBe(T0);
    expect(stripe[0]!.last_seen.getTime()).toBe(T0 + 10 * MIN);
    expect(await sources(clusterId)).toHaveLength(2);
  });

  it('one cluster’s failing query is reported; the others still run', async () => {
    const a = await orgWith('kubernetes');
    const b = await orgWith('docker');
    const vm = new FakeVictoria();
    vm.answer = (cid) => {
      if (cid === a.clusterId) throw new Error('VictoriaMetrics unreachable');
      return [row(docker('redis', 'x.example.org', '443'), 1)];
    };
    const report = await runEgressMinute(depsFor(vm, [a.orgId, b.orgId]), T0);
    expect(report.clusters).toBe(1);
    expect(report.errors).toEqual([`${a.clusterId}: VictoriaMetrics unreachable`]);
    expect(await rows(b.clusterId)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------ look-back

describe('first seen from the retained series (once per cluster)', () => {
  /** Answers the look-back's per-day queries from `days`: daysAgo → [labels, first, last]. */
  function lookback(days: Record<number, [Record<string, string>, number, number][]>): Answer {
    return (_c, expr) => {
      const m = /offset (\d+)d/.exec(expr);
      const day = m ? Number(m[1]) : 0;
      const first = expr.includes('tfirst_over_time');
      return (days[day] ?? []).map(([l, f, last]) => row(l, (first ? f : last) / 1000));
    };
  }

  it('reads connections only, one day per query, at most 30 days, and runs once', async () => {
    const { orgId, clusterId } = await orgWith('kubernetes', T0 - 400 * DAY);
    const vm = new FakeVictoria();
    await runEgressBackfill(depsFor(vm, [orgId]), T0);
    expect(vm.queries).toHaveLength(2 * EGRESS_LOOKBACK_DAYS);
    for (const q of vm.queries) {
      expect(q.expr).toContain('watchlog_flow_connections_total');
      expect(q.expr).not.toContain('bytes');
      expect(q.expr).toContain('[1d]');
      expect(q.time).toBe(T0 / 1000);
    }
    expect(vm.queries.some((q) => q.expr.includes('offset 29d'))).toBe(true);
    expect(vm.queries.some((q) => q.expr.includes('offset 30d'))).toBe(false);
    const c = await db
      .selectFrom('clusters')
      .select('egress_backfilled_at')
      .where('id', '=', clusterId)
      .executeTakeFirstOrThrow();
    expect(c.egress_backfilled_at?.getTime()).toBe(T0);
    vm.queries = [];
    await runEgressBackfill(depsFor(vm, [orgId]), T0 + 5 * MIN);
    expect(vm.queries).toEqual([]);
  });

  it('never looks further back than a day before the cluster first reported', async () => {
    const { orgId } = await orgWith('docker', T0 - 2.5 * DAY);
    const vm = new FakeVictoria();
    await runEgressBackfill(depsFor(vm, [orgId]), T0);
    // Days 0 to 3 (the window of day 3 ends 3 days ago, before the first report).
    expect(vm.queries.map((q) => /offset (\d+)d/.exec(q.expr)?.[1] ?? '0')).toEqual([
      '0',
      '0',
      '1',
      '1',
      '2',
      '2',
      '3',
      '3',
    ]);
  });

  it('gives each destination its oldest first sample and newest change; "before" at the retention edge', async () => {
    const { orgId, clusterId } = await orgWith('kubernetes', T0 - 60 * DAY);
    const oldest = T0 - 7 * DAY + 5 * MIN; // the oldest sample retained (7-day retention)
    const github = k8s('orders', 'api.github.com', '443');
    const newer = k8s('orders', 'compass.mongodb.com', '443');
    const vm = new FakeVictoria();
    vm.answer = lookback({
      0: [[github, T0 - 20 * 3_600_000, T0 - 2 * 3_600_000]],
      1: [[github, T0 - 47 * 3_600_000, T0 - 30 * 3_600_000]],
      6: [[github, oldest, oldest + 3_600_000]],
      3: [[newer, T0 - 3 * DAY - 3_600_000, T0 - 3 * DAY]],
    });
    const report = await runEgressBackfill(depsFor(vm, [orgId]), T0);
    expect(report.rows).toBe(2);
    const got = await rows(clusterId);
    expect(
      got.map((r) => [
        r.destination,
        r.first_seen.getTime(),
        r.last_seen.getTime(),
        r.first_seen_before,
      ]),
    ).toEqual([
      ['api.github.com', oldest, T0 - 2 * 3_600_000, true],
      ['compass.mongodb.com', T0 - 3 * DAY - 3_600_000, T0 - 3 * DAY, false],
    ]);
    const src = await sources(clusterId);
    expect(src[0]!.first_seen.getTime()).toBe(oldest);
  });

  it('a cluster whose history is all retained marks nothing "before"', async () => {
    const firstReport = T0 - 2 * DAY;
    const { orgId, clusterId } = await orgWith('kubernetes', firstReport);
    const vm = new FakeVictoria();
    vm.answer = lookback({
      1: [[k8s('orders', 'api.github.com', '443'), firstReport + MIN, firstReport + 2 * MIN]],
    });
    await runEgressBackfill(depsFor(vm, [orgId]), T0);
    expect((await rows(clusterId))[0]!.first_seen_before).toBe(false);
  });

  it('a row the minute job wrote first gets the older first seen; last seen stays the newest', async () => {
    const { orgId, clusterId } = await orgWith('kubernetes', T0 - 60 * DAY);
    const vm = new FakeVictoria();
    const github = k8s('orders', 'api.github.com', '443');
    vm.answer = () => [row(github, 1)];
    await runEgressMinute(depsFor(vm, [orgId]), T0);
    vm.answer = lookback({ 4: [[github, T0 - 4 * DAY - 7 * MIN, T0 - 4 * DAY]] });
    await runEgressBackfill(depsFor(vm, [orgId]), T0 + MIN);
    const [r] = await rows(clusterId);
    expect(r!.first_seen.getTime()).toBe(T0 - 4 * DAY - 7 * MIN);
    expect(r!.last_seen.getTime()).toBe(T0);
  });
});

// ------------------------------------------------------------------------------ forgetting

describe('forgetting after 90 days', () => {
  it('deletes rows and sources last seen more than 90 days ago; keeps expectations', async () => {
    const { orgId, clusterId } = await orgWith('kubernetes');
    const vm = new FakeVictoria();
    vm.answer = () => [row(k8s('old', 'gone.example.org', '443'), 1)];
    await runEgressMinute(depsFor(vm, [orgId]), T0 - 91 * DAY);
    vm.answer = () => [row(k8s('orders', 'kept.example.org', '443'), 1)];
    await runEgressMinute(depsFor(vm, [orgId]), T0 - 89 * DAY);
    await db
      .insertInto('egress_expected')
      .values({ org_id: orgId, cluster_id: clusterId, pattern: 'gone.example.org' })
      .execute();
    const report = await runEgressForget(depsFor(vm, [orgId]), T0);
    expect(report.rows).toBe(1);
    expect((await rows(clusterId)).map((r) => r.destination)).toEqual(['kept.example.org']);
    expect((await sources(clusterId)).map((s) => s.source)).toEqual([
      { namespace: 'shop', workload_kind: 'Deployment', workload: 'orders' },
    ]);
    expect(
      await db
        .selectFrom('egress_expected')
        .select('pattern')
        .where('cluster_id', '=', clusterId)
        .execute(),
    ).toEqual([{ pattern: 'gone.example.org' }]);
    // Used again after being forgotten: new again.
    vm.answer = () => [row(k8s('old', 'gone.example.org', '443'), 1)];
    await runEgressMinute(depsFor(vm, [orgId]), T0 + MIN);
    const back = (await rows(clusterId)).find((r) => r.destination === 'gone.example.org');
    expect(back?.first_seen.getTime()).toBe(T0 + MIN);
  });
});

// ------------------------------------------------------------------------------ real PromQL

describe('the queries against a real VictoriaMetrics', () => {
  const RUN = `egress-${Date.now()}`;
  const SCRAPE = 15_000;
  const vm = new VictoriaQueryClient(TEST_VM_URL);
  /** Three days ago, on a 15 s boundary: far enough back for the look-back's days. */
  const A = Math.floor((Date.now() - 3 * DAY) / SCRAPE) * SCRAPE;

  afterAll(async () => {
    await fetch(
      `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
      { method: 'POST' },
    );
  });

  async function write(clusterId: string, series: TestSeries[]) {
    await vm.write(authorisedScope(clusterId), encode(series));
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
  }

  /** Samples every 15 s in [from, to) (ms after A) with value v(t). */
  function samples(
    name: string,
    labels: Record<string, string>,
    from: number,
    to: number,
    v: (t: number) => number,
  ): TestSeries[] {
    const out: TestSeries[] = [];
    for (let t = A + from; t < A + to; t += SCRAPE) {
      out.push({
        labels: { __name__: name, run: RUN, ...labels },
        value: v(t - A),
        timestampMs: t,
      });
    }
    return out;
  }

  it('Kubernetes: bytes with 0 connects count, an idle edge doesn’t, a gap’s reset does; node is summed away', async () => {
    const { orgId, clusterId } = await orgWith('kubernetes', A - DAY);
    const base = {
      namespace: 'shop',
      workload_kind: 'Deployment',
      dst_kind: 'external',
      dst_port: '443',
    };
    const conn = 'watchlog_flow_connections_total';
    const bytes = 'watchlog_flow_bytes_total';
    await write(clusterId, [
      // A keep-alive connection: connections stay 0, bytes grow.
      ...samples(
        conn,
        { ...base, workload: 'keepalive', node: 'n1', dst: 'production.cloudfront.docker.com' },
        0,
        30 * MIN,
        () => 0,
      ),
      ...samples(
        bytes,
        {
          ...base,
          workload: 'keepalive',
          node: 'n1',
          dst: 'production.cloudfront.docker.com',
          dir: 'received',
        },
        0,
        30 * MIN,
        (t) => t / 10,
      ),
      // Used at minute 1 (3 connections), then idle: the unchanged 3 for 10 minutes, then gone;
      // redialled at minute 20: the same series again from 1.
      ...samples(
        conn,
        { ...base, workload: 'orders', node: 'n1', dst: 'amazon.com' },
        0,
        11 * MIN + SCRAPE,
        (t) => (t < MIN ? 0 : 3),
      ),
      ...samples(
        conn,
        { ...base, workload: 'orders', node: 'n1', dst: 'amazon.com' },
        20 * MIN,
        30 * MIN,
        () => 1,
      ),
      // The same workload on two nodes: one row.
      ...samples(
        conn,
        { ...base, workload: 'orders', node: 'n1', dst: 'api.stripe.com' },
        0,
        30 * MIN,
        (t) => Math.floor(t / MIN),
      ),
      ...samples(
        conn,
        { ...base, workload: 'orders', node: 'n2', dst: 'api.stripe.com' },
        0,
        30 * MIN,
        (t) => Math.floor(t / MIN),
      ),
    ]);
    const deps = depsFor(vm, [orgId]);
    const at = (m: number) => A + m * MIN;
    const lastSeen = async (dst: string) =>
      (await rows(clusterId)).find((r) => r.destination === dst)?.last_seen.getTime();

    await runEgressMinute(deps, at(2));
    expect(await lastSeen('amazon.com')).toBe(at(2));
    expect(await lastSeen('production.cloudfront.docker.com')).toBe(at(2));
    // Idle from minute 1: samples continue until minute 11, the increase is 0.
    for (const m of [5, 8, 11, 14]) await runEgressMinute(deps, at(m));
    expect(await lastSeen('amazon.com')).toBe(at(2));
    expect(await lastSeen('production.cloudfront.docker.com')).toBe(at(14));
    await runEgressMinute(deps, at(21));
    expect(await lastSeen('amazon.com')).toBe(at(21));
    const stripe = (await rows(clusterId)).filter((r) => r.destination === 'api.stripe.com');
    expect(stripe).toHaveLength(1);
  });

  it('Docker: the look-back finds the first sample of each Compose service and container', async () => {
    const { orgId, clusterId } = await orgWith('docker', A - DAY);
    const conn = 'watchlog_flow_connections_total';
    const api = {
      host: 'h1',
      compose_project: 'shop',
      compose_service: 'api',
      dst_kind: 'external',
      dst_port: '443',
    };
    await write(clusterId, [
      // Two days of history before "now" (A + 2 days): the first use two days back.
      ...samples(
        conn,
        { ...api, container: 'shop-api-1', dst: 'api.stripe.com' },
        0,
        20 * MIN,
        (t) => Math.floor(t / MIN),
      ),
      ...samples(
        conn,
        { ...api, container: 'shop-api-2', dst: 'api.stripe.com' },
        DAY,
        DAY + 20 * MIN,
        (t) => Math.floor((t - DAY) / MIN),
      ),
      ...samples(
        conn,
        { host: 'h1', container: 'redis', dst_kind: 'internet', dst: 'Internet' },
        DAY + 10 * MIN,
        DAY + 15 * MIN,
        () => 2,
      ),
    ]);
    await runEgressBackfill(depsFor(vm, [orgId]), A + 2 * DAY);
    const got = await rows(clusterId);
    expect(got.map((r) => [r.source, r.destination, r.port, r.first_seen.getTime()])).toEqual([
      [{ host: 'h1', container: 'redis' }, 'Internet', 0, A + DAY + 10 * MIN],
      [{ compose_project: 'shop', compose_service: 'api' }, 'api.stripe.com', 443, A],
    ]);
    // The last change of the counter: shop-api-2's last increase, at DAY + 19 min.
    expect(got[1]!.last_seen.getTime()).toBe(A + DAY + 19 * MIN);
  });
});

// ------------------------------------------------------------------------------ Cloud

describe('Cloud: each org inside its own scope, under Row-Level Security', () => {
  let appDb: Database;
  beforeAll(async () => {
    await ensureAppRole(inject('databaseUrl'));
    appDb = createDb(appUrlOf(inject('databaseUrl')), { orgScoped: true });
  });
  afterAll(async () => {
    await appDb.destroy();
  });

  it('the job writes each org’s rows as watchlog_app; neither org sees the other’s', async () => {
    const a = await orgWith('kubernetes');
    const b = await orgWith('docker');
    const vm = new FakeVictoria();
    vm.answer = (cid) =>
      cid === a.clusterId
        ? [row(k8s('orders', 'zzalpha.example.org', '443'), 1)]
        : [row(docker('redis', 'zzbeta.example.org', '443'), 1)];
    const report = await runEgressMinute(depsFor(vm, [a.orgId, b.orgId], appDb), T0);
    expect(report).toEqual({ clusters: 2, rows: 2, errors: [] });
    await runEgressBackfill(depsFor(new FakeVictoria(), [a.orgId, b.orgId], appDb), T0);
    expect((await rows(a.clusterId)).map((r) => [r.org_id, r.destination])).toEqual([
      [a.orgId, 'zzalpha.example.org'],
    ]);
    expect((await rows(b.clusterId)).map((r) => [r.org_id, r.destination])).toEqual([
      [b.orgId, 'zzbeta.example.org'],
    ]);
    const client = new pg.Client({ connectionString: appUrlOf(inject('databaseUrl')) });
    await client.connect();
    try {
      for (const t of ['egress_destinations', 'egress_sources']) {
        expect((await client.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n, t).toBe('0');
      }
      await client.query("SELECT set_config('watchlog.org_id', $1, false)", [b.orgId]);
      const seen = await client.query('SELECT destination FROM egress_destinations');
      expect(seen.rows).toEqual([{ destination: 'zzbeta.example.org' }]);
      // B can't write a row for A's cluster: the composite key or RLS refuses it.
      await expect(
        client.query(
          `INSERT INTO egress_destinations (org_id, cluster_id, source, destination, dst_kind, port, destination_class, first_seen, last_seen)
           VALUES ($1, $2, '{}', 'x.io', 'external', 443, 'name', now(), now())`,
          [b.orgId, a.clusterId],
        ),
      ).rejects.toThrow();
      // Forgetting as B removes nothing of A.
      await runEgressForget(depsFor(vm, [b.orgId], appDb), T0 + 200 * DAY);
      expect(await rows(a.clusterId)).toHaveLength(1);
      expect(await rows(b.clusterId)).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});

// ------------------------------------------------------------------------------ migration

describe('the migration (ADR-107: automatic)', () => {
  it('Community: org_id comes from the cluster when an insert leaves it out; deleting the cluster takes the rows', async () => {
    const { orgId, clusterId } = await orgWith('kubernetes');
    await db
      .insertInto('egress_destinations')
      .values({
        cluster_id: clusterId,
        source: JSON.stringify({ host: 'h', container: 'c' }),
        destination: 'x.io',
        dst_kind: 'external',
        port: 443,
        destination_class: 'name',
        first_seen: new Date(T0),
        last_seen: new Date(T0),
      })
      .execute();
    await db
      .insertInto('egress_sources')
      .values({
        cluster_id: clusterId,
        source: JSON.stringify({ host: 'h', container: 'c' }),
        first_seen: new Date(T0),
        last_seen: new Date(T0),
      })
      .execute();
    await db
      .insertInto('egress_expected')
      .values({ cluster_id: clusterId, pattern: '*.x.io' })
      .execute();
    expect((await rows(clusterId))[0]!.org_id).toBe(orgId);
    // The check constraints refuse what the job never writes.
    await expect(
      db
        .insertInto('egress_destinations')
        .values({
          cluster_id: clusterId,
          source: JSON.stringify({}),
          destination: 'y.io',
          dst_kind: 'pod',
          port: 443,
          destination_class: 'name',
          first_seen: new Date(T0),
          last_seen: new Date(T0),
        })
        .execute(),
    ).rejects.toThrow(/check constraint/);
    await db.deleteFrom('clusters').where('id', '=', clusterId).execute();
    for (const t of ['egress_destinations', 'egress_sources', 'egress_expected'] as const) {
      const n = await db
        .selectFrom(t)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      expect(n.n, t).toBe('0');
    }
  });

  // A scratch database with every migration applied: over vitest's 5 s when `pnpm test` runs
  // the web suite beside it (seen in the 0.8.0 release run).
  it(
    'an upgrade: existing clusters start learning at the migration, later ones have none yet',
    { timeout: 30_000 },
    async () => {
      const base = new URL(inject('databaseUrl'));
      const name = 'watchlog_test_egress_upgrade';
      const admin = new pg.Client({ connectionString: base.toString() });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${name}`);
      const url = new URL(base);
      url.pathname = `/${name}`;
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      const before = files.findIndex((f) => f.endsWith('_egress-inventory.sql'));
      expect(before).toBeGreaterThan(0);
      const old = createDb(url.toString());
      try {
        await runner({
          databaseUrl: url.toString(),
          dir: MIGRATIONS_DIR,
          direction: 'up',
          count: before,
          migrationsTable: 'pgmigrations',
          ignorePattern: '\\..*|.*\\.md',
          singleTransaction: true,
          logger: { info: () => {}, warn: () => {}, error: console.error, debug: () => {} },
        });
        const orgId = newId();
        const existing = newId();
        await sql`INSERT INTO orgs (id, name, slug, plan) VALUES (${orgId}, 'Acme', 'acme', 'community')`.execute(
          old,
        );
        await sql`INSERT INTO clusters (id, org_id, name, kind) VALUES (${existing}, ${orgId}, 'prod', 'kubernetes')`.execute(
          old,
        );
        const ran = await migrateUp(url.toString());
        expect(ran[0]).toMatch(/_egress-inventory$/);
        const later = newId();
        await sql`INSERT INTO clusters (id, org_id, name, kind) VALUES (${later}, ${orgId}, 'new', 'docker')`.execute(
          old,
        );
        const got = await sql<{ id: string; since: Date | null; backfilled: Date | null }>`
        SELECT id, egress_learning_since AS since, egress_backfilled_at AS backfilled FROM clusters`.execute(
          old,
        );
        const byId = new Map(got.rows.map((r) => [r.id, r]));
        expect(byId.get(existing)!.since).toBeInstanceOf(Date);
        expect(byId.get(existing)!.backfilled).toBeNull();
        expect(byId.get(later)!.since).toBeNull();
      } finally {
        await old.destroy();
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await admin.end();
      }
    },
  );
});
