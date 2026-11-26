// SPDX-License-Identifier: AGPL-3.0-only
// A watched own metric through What changed, whole worker minutes (1.0.1; ADR-238): fourteen
// generated days of a metric are written into VictoriaMetrics with their own timestamps, the
// anomaly-worker's hour and minute jobs are run over them on an injected clock (nothing is
// waited for), and the metric is then where every other series is: learnt, scored, on the live
// map under its workload or server, in the list and the story in its place's words; and its
// "outside its usual range" alert fires and resolves. On a Kubernetes cluster and on a Server
// fleet. Last, the keys: the own-metric row's place must be the place the service map and the
// platform's other series name, or the story can't connect it to what it calls: the real map
// is drawn from flow series and the story must link the two rows through it (on a fleet,
// through the server they share). The worker's own-metric query is answered by the real VictoriaMetrics, so the
// expression What changed sends (owner labels moved, a line per owner) is what is tested.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../src/lib/ids.js';
import {
  authorisedScope,
  VictoriaQueryClient,
  type ClusterScope,
  type QuerySeries,
} from '../src/lib/victoria.js';
import { lookupEvaluator } from '../src/modules/alerts/rules.js';
import { runAnomalyHour, runAnomalyMinute, type AnomalyDeps } from '../src/modules/anomaly/jobs.js';
import { seriesHash } from '../src/modules/anomaly/keys.js';
import { fromStored, liveView, ownParts, stateOf } from '../src/modules/anomaly/live.js';
import { chartRange, objectOf, readPeriods } from '../src/modules/anomaly/read.js';
import { buildStory } from '../src/modules/anomaly/story-build.js';
import { relatedBy, type MapRead } from '../src/modules/anomaly/story-read.js';
import { ownMetricLimits } from '../src/modules/entitlements/own-metrics.js';
import { configureOwnAlerts } from '../src/modules/own-metrics/alerts.js';
import { OwnUsual } from '../src/modules/own-metrics/usual.js';
import { watchedQueries } from '../src/modules/own-metrics/watched.js';
import {
  closeTestContext,
  createTestContext,
  setupAdmin,
  TEST_VM_URL,
  type TestContext,
} from './helpers.js';
import { testWorker } from './support/alerts.js';
import { encode, type TestSeries } from './support/remote-write.js';

// The replay is 336 hourly recomputes and an hour of minutes against PostgreSQL: seconds of
// work, not a wait.
vi.setConfig({ testTimeout: 90_000 });

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const vm = new VictoriaQueryClient(TEST_VM_URL);
const PRO = ownMetricLimits({ edition: 'cloud', plan: 'pro', pro: true, billedNodes: 5 });
const silent = { warn: () => {} };
const KEY = 'own:count:queue_jobs_waiting';

/**
 * The live answer for the own-metric series as the page gets it, shared with the web's test of
 * the live map (web/test/what-changed-live-own.test.ts): if the key or the object's shape
 * changes here, that file must change with it, and the map's grouping is tested on it.
 */
const FIXTURE = JSON.parse(
  readFileSync(
    new URL('../../web/test/fixtures/what-changed-live-own.json', import.meta.url),
    'utf8',
  ),
) as Record<'kubernetes' | 'server', Record<string, unknown>>;

let ctx: TestContext;
let cookie: string;
let clusterId: string;
let orgId: string;
let token: string;

const api = (method: string, url: string, payload?: object) =>
  ctx.app.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    cookies: { wl_session: cookie },
    ...(payload ? { payload } : {}),
  });

async function start(kind: 'kubernetes' | 'server') {
  ctx = await createTestContext();
  cookie = await setupAdmin(ctx.app);
  clusterId = (await api('POST', '/clusters', { name: 'prod', kind })).json().cluster.id;
  orgId = (await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow()).id;
  token = (await api('POST', `/clusters/${clusterId}/own-metrics/tokens`, { name: 't' })).json()
    .value;
  // Pro: watching, the usual range and every alert.
  const usage = ctx.app.ownMetrics.usage.bind(ctx.app.ownMetrics);
  ctx.app.ownMetrics.usage = async (id) => ({ ...(await usage(id)), limits: PRO });
  configureOwnAlerts({ limits: async () => PRO, usual: new OwnUsual(vm) });
}
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined as never;
});

async function write(series: TestSeries[]) {
  for (let i = 0; i < series.length; i += 2000) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/write',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-protobuf',
        'content-encoding': 'snappy',
      },
      payload: encode(series.slice(i, i + 2000)),
    });
    expect(res.statusCode, res.body).toBe(204);
  }
  await fetch(`${TEST_VM_URL}/internal/force_flush`);
}

/** A deterministic wobble in [-1, 1]. */
const wobble = (t: number) => Math.sin(t / (7 * MIN)) * 0.6 + Math.sin(t / (3.1 * MIN)) * 0.4;
/** About 40 jobs waiting, with a daily shape; 400 during the step. */
const usual = (t: number) => 40 + 10 * Math.sin(((t % DAY) / DAY) * 2 * Math.PI) + 2 * wobble(t);

interface Place {
  kind: 'kubernetes' | 'server';
  labels: Record<string, string>;
  /** The subject What changed keeps for the series. */
  subject: Record<string, string>;
  object: Record<string, unknown>;
  /** As an alert names it. */
  owner: string;
  prepare: () => Promise<void>;
  /** An ordinary series next to it: of what its workload calls, or of a container on its server. */
  neighbour: { key: string; subject: Record<string, string>; who: string };
  /** The same kind of series somewhere unrelated. */
  stranger: { key: string; subject: Record<string, string> };
}

const places: Place[] = [
  {
    kind: 'kubernetes',
    labels: { namespace: 'shop', pod: 'worker-1', queue: 'emails' },
    subject: { namespace: 'shop', workload: 'worker', workload_kind: 'Deployment' },
    object: { kind: 'workload', name: 'worker', namespace: 'shop', workloadKind: 'Deployment' },
    owner: 'shop/worker',
    neighbour: {
      key: 'workload.cpu.usage',
      subject: { namespace: 'shop', workload: 'postgres', workload_kind: 'StatefulSet' },
      who: 'shop/postgres',
    },
    stranger: {
      key: 'workload.cpu.usage',
      subject: { namespace: 'billing', workload: 'invoices', workload_kind: 'Deployment' },
    },
    prepare: async () => {
      await ctx.db
        .insertInto('objects')
        .values({
          id: newId(),
          cluster_id: clusterId,
          source: 'kubernetes',
          kind: 'Pod',
          namespace: 'shop',
          name: 'worker-1',
          uid: newId(),
          spec_summary: JSON.stringify({ workload: { kind: 'Deployment', name: 'worker' } }),
          status_summary: JSON.stringify({ phase: 'Running' }),
        })
        .execute();
    },
  },
  {
    kind: 'server',
    labels: { instance: 'db-1:9400', queue: 'emails' },
    subject: { host: 'db-1' },
    object: { kind: 'host', name: 'db-1' },
    owner: 'db-1',
    neighbour: {
      key: 'container.memory.working_set',
      subject: { host: 'db-1', container: 'api' },
      who: 'api · db-1',
    },
    stranger: { key: 'container.memory.working_set', subject: { host: 'db-2', container: 'api' } },
    prepare: async () => {
      await ctx.db
        .insertInto('agent_instances')
        .values({
          id: newId(),
          cluster_id: clusterId,
          node: 'db-1',
          mode: 'docker',
          agent_version: '1',
          last_seen_at: new Date(),
        })
        .execute();
    },
  },
];

describe.each(places)('a watched own metric through What changed, on a $kind', (place) => {
  it('is learnt and scored across worker minutes, is on the live map and in the story under its owner, and its alert fires and resolves', async () => {
    await start(place.kind);
    await place.prepare();
    // The last sample is two minutes old, so a read "now" still sees it.
    const now = Math.floor(Date.now() / MIN) * MIN - 2 * MIN;
    const first = Math.floor((now - 14 * DAY - 2 * HOUR) / HOUR) * HOUR;
    const stepFrom = now - 40 * MIN;
    const stepTo = now - 15 * MIN;
    const value = (t: number) => (t >= stepFrom && t < stepTo ? 400 : usual(t));
    const series: TestSeries[] = [];
    // Every five minutes for fourteen days, every minute for the last three hours.
    for (let t = first; t < now - 3 * HOUR; t += 5 * MIN)
      series.push({
        labels: { __name__: 'queue_jobs_waiting', ...place.labels },
        value: value(t),
        timestampMs: t,
      });
    for (let t = now - 3 * HOUR; t <= now; t += MIN)
      series.push({
        labels: { __name__: 'queue_jobs_waiting', ...place.labels },
        value: value(t),
        timestampMs: t,
      });
    await write(series);

    const base = `/clusters/${clusterId}/own-metrics`;
    const metric = (await api('GET', `${base}/metrics`))
      .json()
      .metrics.find((m: { name: string }) => m.name === 'queue_jobs_waiting');
    expect(
      (await api('PUT', `${base}/metrics/${metric.id}/watch`, { watched: true })).json(),
    ).toEqual({ watched: true });
    const queries = await watchedQueries(ctx.db, clusterId);
    expect(queries.map((q) => q.key)).toEqual([KEY]);

    // The worker, as it runs: its own-metric query goes to the real store; the platform's
    // other keys have no data here.
    const own = new Set(queries.map((q) => q.expr));
    let asked = 0;
    const victoria = {
      queryRange: async (
        scope: ClusterScope,
        expr: string,
        start: number,
        end: number,
        step: number,
      ): Promise<QuerySeries[]> => {
        if (!own.has(expr)) return [];
        asked++;
        return vm.queryRange(scope, expr, start, end, step);
      },
    };
    const d: AnomalyDeps = {
      db: ctx.db,
      systemDb: ctx.db,
      victoria,
      orgs: async () => [orgId],
      log: silent,
    };
    // Learning starts with the data; every hour's recompute, then the minutes of the last hour.
    await runAnomalyMinute(d, first);
    for (let h = first + HOUR; h <= now - HOUR; h += HOUR) await runAnomalyHour(d, h + 5 * MIN);
    expect(asked).toBeGreaterThan(300);
    const baselines = await ctx.db
      .selectFrom('anomaly_baselines')
      .select(['metric', 'subject'])
      .where('cluster_id', '=', clusterId)
      .execute();
    expect(baselines).toHaveLength(1);
    expect(baselines[0]).toMatchObject({ metric: KEY, subject: place.subject });

    // ---- Inside the step: a period opens, and the live map has it outside its range -------
    const inside = stepFrom + 20 * MIN;
    for (let m = now - 55 * MIN; m <= inside; m += MIN) await runAnomalyMinute(d, m);
    const liveRow = await ctx.db
      .selectFrom('anomaly_live')
      .selectAll()
      .where('cluster_id', '=', clusterId)
      .executeTakeFirstOrThrow();
    const entries = (liveRow.series as unknown[]).map((e) => fromStored(e)!);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: KEY, subject: place.subject, open: true });
    expect(entries[0]!.value).toBe(400);
    expect(entries[0]!.high).toBeLessThan(100);
    expect(stateOf(entries[0]!).state).toBe('outside');
    const view = liveView(liveRow, await ownParts(ctx.db, clusterId), new Map());
    expect(view.series).toHaveLength(1);
    const cell = view.series[0]!;
    expect(cell).toMatchObject({
      key: KEY,
      unit: 'count',
      object: place.object,
      peer: null,
      state: 'outside',
      own: false,
    });
    // What the web's live map is tested on: the same key, unit, object and peer.
    expect({ key: cell.key, unit: cell.unit, object: cell.object, peer: cell.peer }).toEqual(
      FIXTURE[place.kind],
    );

    // ---- "Outside its usual range": the user's own rule fires in the step ------------------
    const rule = await api('POST', `${base}/alerts`, {
      metricId: metric.id,
      is: 'unusual',
      forSeconds: 0,
    });
    expect(rule.statusCode, rule.body).toBe(201);
    const clock = { now: inside };
    const worker = testWorker(ctx.db, clock, lookupEvaluator, { victoria: vm });
    await worker.runCycle();
    const states = () =>
      ctx.db
        .selectFrom('alert_states')
        .select(['state', 'labels', 'details'])
        .where('rule_id', '=', rule.json().id)
        .execute();
    const fired = await states();
    expect(fired).toMatchObject([{ state: 'firing', details: { is: 'unusual', value: 400 } }]);
    expect((fired[0]!.details as { title: string }).title).toContain(place.owner);
    expect((fired[0]!.details as { usualHigh: number }).usualHigh).toBeLessThan(100);

    // ---- After the step: the period ends, the square is inside again, the alert resolves ---
    for (let m = inside + MIN; m <= now; m += MIN) await runAnomalyMinute(d, m);
    const periods = await ctx.db
      .selectFrom('anomaly_periods')
      .select(['metric', 'subject', 'started_at', 'ended_at', 'peak_score'])
      .where('cluster_id', '=', clusterId)
      .execute();
    expect(periods).toHaveLength(1);
    const period = periods[0]!;
    expect(period).toMatchObject({ metric: KEY, subject: place.subject });
    expect(period.started_at.getTime()).toBeGreaterThanOrEqual(stepFrom);
    expect(period.started_at.getTime()).toBeLessThan(stepFrom + 15 * MIN);
    expect(period.ended_at).not.toBeNull();
    expect(period.ended_at!.getTime()).toBeGreaterThanOrEqual(stepTo);
    expect(Number(period.peak_score)).toBeGreaterThan(4);
    const after = (
      (
        await ctx.db
          .selectFrom('anomaly_live')
          .select('series')
          .where('cluster_id', '=', clusterId)
          .executeTakeFirstOrThrow()
      ).series as unknown[]
    ).map((e) => fromStored(e)!);
    expect(after[0]).toMatchObject({ key: KEY, open: false });
    expect(stateOf(after[0]!).state).not.toBe('outside');

    clock.now = now;
    for (let i = 0; i < 4; i++) {
      await worker.runCycle();
      clock.now += MIN;
    }
    expect((await states()).map((s) => s.state)).toEqual(['resolved']);
    await worker.stop();

    // ---- The list and the story, as the page reads them ------------------------------------
    const w = { fromMs: now - HOUR, toMs: now };
    const read = await readPeriods(
      ctx.db,
      orgId,
      { id: clusterId, kind: place.kind },
      w,
      chartRange(w, false, 0),
      'first',
      now,
      false,
    );
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]).toMatchObject({
      key: KEY,
      unit: 'count',
      object: place.object,
      peer: null,
    });
    expect(read.rows[0]!.until).not.toBeNull();
    const built = await buildStory(
      {
        db: ctx.db,
        // The story's sparks ask the real store.
        victoria: vm,
        reader: { role: 'owner', namespaces: null } as never,
        log: silent,
      },
      {
        id: clusterId,
        name: 'prod',
        kind: place.kind,
        scope: authorisedScope(clusterId),
        own: null,
      },
      orgId,
      read.all,
      w,
      now,
    );
    expect(built.episodes).toHaveLength(1);
    expect(built.story).not.toBeNull();
    // One thing moved, and it is the user's metric on its own workload or server.
    expect(built.story!.rows.map((r) => [r.key, r.object])).toEqual([[KEY, place.object]]);
    // The story's first box names the place in its own words: "shop/worker", "db-1".
    expect(built.story!.chain.nodes).toHaveLength(1);
    expect(built.story!.chain.nodes[0]).toMatchObject({
      kind: 'first',
      who: place.owner,
      rowId: read.rows[0]!.id,
    });
    expect(built.story!.clauses.length).toBeGreaterThan(0);

    // ---- The keys: its place is the service map's and the other series' place --------------
    if (place.kind === 'kubernetes') {
      // The map as the page draws it: worker calls postgres (flow series from the node agent).
      await ctx.db
        .insertInto('agent_instances')
        .values({
          id: newId(),
          cluster_id: clusterId,
          node: 'w1',
          mode: 'node',
          agent_version: 'dev',
          capabilities: JSON.stringify({ ebpf: 'enabled', cgroup: 'v2' }),
          last_seen_at: new Date(),
        })
        .execute();
      const flow: TestSeries[] = [];
      for (let t = now - 20 * MIN, v = 0; t <= now; t += 15_000, v += 60)
        flow.push({
          labels: {
            __name__: 'watchlog_flow_connections_total',
            node: 'w1',
            namespace: 'shop',
            workload_kind: 'Deployment',
            workload: 'worker',
            dst_kind: 'workload',
            dst_namespace: 'shop',
            dst_workload_kind: 'StatefulSet',
            dst_workload: 'postgres',
            dst_service: 'postgres',
            dst_port: '5432',
          },
          value: v,
          timestampMs: t,
        });
      await vm.write(authorisedScope(clusterId), encode(flow));
      await fetch(`${TEST_VM_URL}/internal/force_flush`);
    }
    const reader = {
      get: async <T>(path: string, query: Record<string, string | number> = {}): Promise<T> => {
        const qs = new URLSearchParams(
          Object.entries(query).map(([k, v]) => [k, String(v)] as [string, string]),
        ).toString();
        const res = await api('GET', `${path}${qs ? `?${qs}` : ''}`);
        if (res.statusCode !== 200) throw new Error(`${path}: ${res.statusCode}`);
        return res.json() as T;
      },
    };
    const neighbour = objectOf(place.neighbour.key, place.neighbour.subject).object;
    const stranger = objectOf(place.stranger.key, place.stranger.subject).object;
    const mine = read.rows[0]!.object;
    let map: MapRead | null = null;
    if (place.kind === 'kubernetes') {
      map = await reader.get<MapRead>(`/clusters/${clusterId}/service-map`, { range: 3600 });
      // The map's own node for the metric's workload, found by the row's namespace and name.
      expect(map.nodes.map((n) => `${n.namespace}/${n.name}`).sort()).toEqual([
        'shop/postgres',
        'shop/worker',
      ]);
      expect(map.edges).toHaveLength(1);
    }
    const related = relatedBy(place.kind, map, new Map());
    expect(related(mine, neighbour)).toBe(true);
    expect(related(neighbour, mine)).toBe(true);
    expect(related(mine, stranger)).toBe(false);

    // And in the story: a second row, three minutes later, of what it calls (or of a
    // container on its server). The two boxes are connected, in each place's words.
    await ctx.db
      .insertInto('anomaly_periods')
      .values({
        org_id: orgId,
        cluster_id: clusterId,
        series_hash: seriesHash(place.neighbour.key, place.neighbour.subject),
        metric: place.neighbour.key,
        subject: JSON.stringify(place.neighbour.subject),
        started_at: new Date(period.started_at.getTime() + 3 * MIN),
        ended_at: period.ended_at,
        bucket: 0,
        median: 1,
        usual_low: 0.8,
        usual_high: 1.2,
        peak_score: 9,
        peak_value: 4,
        peak_at: new Date(period.started_at.getTime() + 6 * MIN),
        last_value: 1,
        last_at: period.ended_at!,
      })
      .execute();
    const both = await readPeriods(
      ctx.db,
      orgId,
      { id: clusterId, kind: place.kind },
      w,
      chartRange(w, false, 0),
      'first',
      now,
      false,
    );
    expect(both.rows.map((r) => r.key)).toEqual([KEY, place.neighbour.key]);
    const linked = await buildStory(
      { db: ctx.db, victoria: vm, reader: reader as never, log: silent },
      {
        id: clusterId,
        name: 'prod',
        kind: place.kind,
        scope: authorisedScope(clusterId),
        own: null,
      },
      orgId,
      both.all,
      w,
      now,
    );
    expect(linked.story!.chain.nodes.map((n) => [n.kind, n.who, n.linked])).toEqual([
      ['first', place.owner, false],
      ['then', place.neighbour.who, true],
    ]);
    expect(linked.story!.chain.linked).toBe(true);
  });
});
