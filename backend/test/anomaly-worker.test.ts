// SPDX-License-Identifier: AGPL-3.0-only
// The anomaly-worker (ADR-196, ADR-197, ADR-198, ADR-204; v0.8 slice 2) on an injectable
// clock: 14 synthetic days are generated here, never waited for. A fake VictoriaMetrics
// answers each scored key's query from functions of time; PostgreSQL is the test database.
// Every scenario runs for a Kubernetes and a Docker subject.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createDb, type Database } from '../src/db/index.js';
import { newId } from '../src/lib/ids.js';
import type { ClusterScope, QuerySeries } from '../src/lib/victoria.js';
import { ANOMALY_RULE_KEY } from '../src/modules/anomaly/exclusion.js';
import { entitledOrgs, hasWhatChanged, workerRefusal } from '../src/modules/anomaly/gate.js';
import { fromStored, stateOf } from '../src/modules/anomaly/live.js';
import {
  DOWNGRADE_KEEP_DAYS,
  runAnomalyHour,
  runAnomalyMinute,
  type AnomalyDeps,
} from '../src/modules/anomaly/jobs.js';
import {
  queriesFor,
  seriesHash,
  subjectOf,
  type ClusterKind,
  type ScoredKey,
} from '../src/modules/anomaly/keys.js';
import { bucketOf, medianAndMad } from '../src/modules/anomaly/stats.js';
import { appUrlOf, ensureAppRole } from './isolation/cloud.js';

// Most cases replay 10 to 14 days hour by hour (336 recomputes against PostgreSQL): about 2 s
// alone, over vitest's 5 s when `pnpm test` runs the web suite beside it (seen in the 0.8.0
// release run). The time is the replay's, not a wait.
vi.setConfig({ testTimeout: 30_000 });

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Learning starts here: a Monday, 00:00 UTC. */
const START = Date.UTC(2026, 10, 2, 0, 0, 0);
const silent = { warn: () => {} };

// ------------------------------------------------------------------------------ synthetic data

/** A deterministic noise in [-1, 1] for a time and a seed. */
function noise(t: number, seed: number): number {
  let x = (Math.floor(t / MIN) * 2654435761 + seed * 40503) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0x5bd1e995) >>> 0;
  x ^= x >>> 15;
  return (x / 2 ** 32) * 2 - 1;
}

interface Synthetic {
  key: ScoredKey;
  labels: Record<string, string>;
  /** The usual value: a daily shape, quieter at weekends, a little noise. */
  base: number;
  wobble: number;
  /** Extra value during steps: [from, to) → added. */
  steps: { from: number; to: number; add: number }[];
  /** No value before this time (the series appears then). */
  since?: number;
}

function valueAt(s: Synthetic, t: number, seed: number): number | null {
  if (s.since !== undefined && t < s.since) return null;
  const d = new Date(t);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 0.7 : 1;
  let v = s.base * weekend * (1 + 0.3 * Math.sin(((hour - 8) / 24) * 2 * Math.PI));
  v += s.wobble * noise(t, seed);
  for (const st of s.steps) if (t >= st.from && t < st.to) v += st.add;
  return Math.max(0, v);
}

/** A VictoriaMetrics that answers range queries from the synthetic series of each cluster. */
class FakeVictoria {
  series = new Map<string, Synthetic[]>();
  queries = 0;
  /** The clusters asked for anything. */
  asked = new Set<string>();
  private readonly keyOf = new Map<string, ScoredKey>();
  constructor() {
    for (const kind of ['kubernetes', 'server'] as ClusterKind[]) {
      for (const q of queriesFor(kind, ['redis'])) this.keyOf.set(q.expr, q.key);
    }
  }
  async queryRange(
    scope: ClusterScope,
    expr: string,
    start: number,
    end: number,
    step: number,
  ): Promise<QuerySeries[]> {
    this.queries++;
    this.asked.add(scope.clusterId);
    const key = this.keyOf.get(expr);
    const out: QuerySeries[] = [];
    for (const [i, s] of (this.series.get(scope.clusterId) ?? []).entries()) {
      if (s.key !== key) continue;
      const points: [number, number | null][] = [];
      for (let t = start; t <= end; t += step) {
        const v = valueAt(s, t * 1000, i + 1);
        if (v !== null) points.push([t, v]);
      }
      if (points.length) out.push({ labels: s.labels, points });
    }
    return out;
  }
}

// ------------------------------------------------------------------------------ the platforms

interface Platform {
  kind: ClusterKind;
  /** The main subject's series and a second one. */
  main: Synthetic;
  other: Synthetic;
  /** An alert on the main subject, as its rule labels it (slice 1). */
  alertLabels: Record<string, string>;
  /** How far a step must move the main series (well past score 4). */
  stepAdd: number;
}

const platforms: Platform[] = [
  {
    kind: 'kubernetes',
    main: {
      key: 'workload.cpu.usage',
      labels: { namespace: 'shop', workload_kind: 'Deployment', workload: 'checkout' },
      base: 1,
      wobble: 0.04,
      steps: [],
    },
    other: {
      key: 'edge.http.latency.p95',
      labels: {
        namespace: 'shop',
        workload_kind: 'Deployment',
        workload: 'frontend',
        dst_kind: 'workload',
        dst_namespace: 'shop',
        dst_workload_kind: 'Deployment',
        dst_workload: 'checkout',
        dst_port: '8080',
      },
      base: 0.15,
      wobble: 0.01,
      steps: [],
    },
    // CrashLoop on a pod of the workload (pod alerts add pod and node).
    alertLabels: {
      namespace: 'shop',
      workload_kind: 'Deployment',
      workload: 'checkout',
      pod: 'checkout-7d9-x',
      node: 'kind-worker',
    },
    stepAdd: 3,
  },
  {
    kind: 'server',
    main: {
      key: 'container.memory.working_set',
      labels: { host: 'docker-1', container: 'shop-api-1' },
      base: 512 * 2 ** 20,
      wobble: 8 * 2 ** 20,
      steps: [],
    },
    other: {
      key: 'container.network.bytes',
      labels: { host: 'docker-1', container: 'shop-db-1', dir: 'received' },
      base: 2 * 2 ** 20,
      wobble: 50 * 1024,
      steps: [],
    },
    // Docker's restarting container: the host is `node` in alerts.
    alertLabels: { container: 'shop-api-1', node: 'docker-1' },
    stepAdd: 2 * 2 ** 30,
  },
];

// ------------------------------------------------------------------------------ database

let db: Database;
beforeAll(() => {
  db = createDb(inject('databaseUrl'));
});
afterAll(async () => {
  await db.destroy();
});

async function orgWith(kind: ClusterKind, plan: 'pro' | 'free' | null = 'pro') {
  const orgId = newId();
  const clusterId = newId();
  await db
    .insertInto('orgs')
    .values({ id: orgId, name: 'Acme', slug: `acme-${orgId.slice(-8)}`, plan: 'community' })
    .execute();
  await db
    .insertInto('clusters')
    .values({ id: clusterId, org_id: orgId, name: kind, kind })
    .execute();
  if (plan) {
    await db
      .insertInto('entitlements')
      .values({ org_id: orgId, plan, source: 'signup', pro_features: plan === 'pro' })
      .execute();
  }
  return { orgId, clusterId };
}

function deps(vm: FakeVictoria, orgs: () => Promise<string[]>, on = db): AnomalyDeps {
  return { db: on, systemDb: db, victoria: vm, orgs, log: silent };
}

/** Runs the hourly recompute for every hour in [from, to). */
async function learn(d: AnomalyDeps, from: number, to: number) {
  for (let h = from + HOUR; h <= to; h += HOUR) await runAnomalyHour(d, h + 5 * MIN);
}

/** Runs the minute's scoring for every minute in [from, to]. */
async function score(d: AnomalyDeps, from: number, to: number) {
  for (let m = from; m <= to; m += MIN) await runAnomalyMinute(d, m);
}

async function baseline(clusterId: string, s: Synthetic) {
  return db
    .selectFrom('anomaly_baselines')
    .selectAll()
    .where('cluster_id', '=', clusterId)
    .where('series_hash', '=', seriesHash(s.key, subjectOf(s.labels)))
    .executeTakeFirst();
}

function periods(clusterId: string) {
  return db
    .selectFrom('anomaly_periods')
    .selectAll()
    .where('cluster_id', '=', clusterId)
    .orderBy('started_at')
    .execute();
}

/** The reference median and MAD of a bucket: the minutes of its two occurrences. */
function reference(
  s: Synthetic,
  seed: number,
  hour: number,
  skip: (t: number) => boolean = () => false,
) {
  const vals: number[] = [];
  for (const occ of [hour, hour - 7 * DAY]) {
    if (occ < START) continue;
    for (let t = occ; t < occ + HOUR; t += MIN) {
      const v = valueAt(s, t, seed);
      if (v !== null && !skip(t)) vals.push(v);
    }
  }
  return { ...medianAndMad(vals), n: vals.length };
}

const fresh = (s: Synthetic): Synthetic => ({ ...s, steps: [] });

/** Equal within float32's precision (the arrays are real[]). */
function close(got: number | undefined, want: number) {
  expect(Math.abs(got! - want)).toBeLessThanOrEqual(Math.abs(want) * 1e-6 + 1e-9);
}

// ------------------------------------------------------------------------------ scenarios

describe.each(platforms)('$kind: baselines, scoring and periods', (p) => {
  it('14 days give each bucket the median and MAD of its two occurrences', async () => {
    const { orgId, clusterId } = await orgWith(p.kind);
    const vm = new FakeVictoria();
    const main = fresh(p.main);
    const other = fresh(p.other);
    vm.series.set(clusterId, [main, other]);
    // Learning starts at START: the worker sees the org with Pro then.
    const d = deps(vm, async () => [orgId]);
    await runAnomalyMinute(d, START);
    await learn(d, START, START + 14 * DAY);
    const row = (await baseline(clusterId, main))!;
    expect(row.first_seen.getTime()).toBe(START);
    // Every hour of the week, against a reference computed from the same minutes.
    for (const hour of [
      START + 13 * DAY + 14 * HOUR,
      START + 8 * DAY + 3 * HOUR,
      START + 14 * DAY - HOUR,
    ]) {
      const b = bucketOf(hour);
      const ref = reference(main, 1, hour);
      expect(row.minutes[b]).toBe(120);
      close(row.medians[b], ref.median);
      close(row.mads[b], ref.mad);
    }
    const second = (await baseline(clusterId, other))!;
    expect(second.metric).toBe(p.other.key);
    expect(second.subject).toEqual(subjectOf(p.other.labels));
    expect(second.minutes.filter((n) => n === 120)).toHaveLength(168);
  });

  it('a 10-minute step past score 4 opens a period; 9 minutes don’t; it ends after 10 calm minutes', async () => {
    const { orgId, clusterId } = await orgWith(p.kind);
    const vm = new FakeVictoria();
    const at = START + 14 * DAY + 14 * HOUR + 2 * MIN;
    const main: Synthetic = {
      ...p.main,
      steps: [
        { from: at, to: at + 10 * MIN, add: p.stepAdd },
        { from: at + 60 * MIN, to: at + 69 * MIN, add: p.stepAdd },
      ],
    };
    vm.series.set(clusterId, [main, fresh(p.other)]);
    const d = deps(vm, async () => [orgId]);
    await runAnomalyMinute(d, START);
    await learn(d, START, START + 14 * DAY + 14 * HOUR);
    // Scoring reads the minutes up to the one before now.
    await score(d, at, at + 100 * MIN);
    const list = await periods(clusterId);
    expect(list).toHaveLength(1);
    const [period] = list;
    expect(period!.started_at.getTime()).toBe(at);
    expect(period!.ended_at!.getTime()).toBe(at + 10 * MIN);
    expect(period!.metric).toBe(p.main.key);
    expect(period!.subject).toEqual(subjectOf(p.main.labels));
    expect(period!.bucket).toBe(bucketOf(at));
    expect(period!.peak_score).toBeGreaterThan(4);
    expect(period!.peak_value).toBeGreaterThan(period!.usual_high);
    expect(period!.usual_low).toBeLessThanOrEqual(period!.median);
    expect(period!.usual_high).toBeGreaterThan(period!.median);
    expect(period!.org_id).toBe(orgId);
  });

  it('the live map (0.14.0): each minute writes every scored series with its band, score and open period', async () => {
    const { orgId, clusterId } = await orgWith(p.kind);
    const vm = new FakeVictoria();
    const at = START + 14 * DAY + 14 * HOUR + 2 * MIN;
    vm.series.set(clusterId, [
      { ...p.main, steps: [{ from: at, to: at + 30 * MIN, add: p.stepAdd }] },
      fresh(p.other),
    ]);
    const d = deps(vm, async () => [orgId]);
    await runAnomalyMinute(d, START);
    await learn(d, START, START + 14 * DAY + 14 * HOUR);
    // 12 minutes into the step: the period is open.
    await score(d, at, at + 12 * MIN);
    const live = await db
      .selectFrom('anomaly_live')
      .selectAll()
      .where('cluster_id', '=', clusterId)
      .executeTakeFirstOrThrow();
    expect(live.org_id).toBe(orgId);
    expect(live.scored_at.getTime()).toBe(at + 11 * MIN);
    // The step's series: scored, outside, with its band; the other one inside.
    const series = (live.series as unknown[]).map((e) => fromStored(e)!);
    const main = series.find(
      (e) =>
        e.key === p.main.key &&
        e.subject.workload === p.main.labels.workload &&
        e.subject.container === p.main.labels.container,
    )!;
    expect(main).toMatchObject({ subject: subjectOf(p.main.labels), open: true });
    expect(main.score!).toBeGreaterThan(4);
    expect(main.low).toBeLessThan(main.high);
    expect(stateOf(main).state).toBe('outside');
    expect(series.filter((e) => e !== main).every((e) => !e.open)).toBe(true);
  });

  it('a series with under 7 days of data stays learning, even when its bucket has data', async () => {
    const { orgId, clusterId } = await orgWith(p.kind);
    const vm = new FakeVictoria();
    const hour = START + 14 * DAY + 14 * HOUR;
    const at = hour + 2 * MIN;
    const step = [{ from: at, to: at + 15 * MIN, add: p.stepAdd }];
    // The same subject's twin appeared 6 days 23 hours 40 minutes before: its bucket has the
    // 40 minutes of last week's occurrence, more than the 30 a bucket needs.
    const rename: Record<string, string> =
      p.kind === 'kubernetes' ? { workload: 'checkout-v2' } : { container: 'shop-api-2' };
    const late: Synthetic = {
      ...p.main,
      labels: { ...p.main.labels, ...rename },
      since: hour - 7 * DAY + 20 * MIN,
      steps: step,
    };
    vm.series.set(clusterId, [{ ...p.main, steps: step }, late]);
    const d = deps(vm, async () => [orgId]);
    await runAnomalyMinute(d, START);
    await learn(d, START, hour);
    expect((await baseline(clusterId, late))!.minutes[bucketOf(hour)]).toBe(40);
    await score(d, at, at + 14 * MIN);
    const list = await periods(clusterId);
    expect(list.map((r) => r.subject)).toEqual([subjectOf(p.main.labels)]);
  });

  it('minutes under a firing alert on the subject are left out; anomaly alerts’ stay in', async () => {
    const { orgId, clusterId } = await orgWith(p.kind);
    const vm = new FakeVictoria();
    // An incident on day 9, 10:00–10:40: the value doubles; a CrashLoop (or restarting) alert fires.
    const inc = START + 9 * DAY + 10 * HOUR;
    const main: Synthetic = {
      ...p.main,
      steps: [{ from: inc, to: inc + 40 * MIN, add: p.stepAdd }],
    };
    // The same on day 10 11:00–11:40, but only an anomaly alert fires: its minutes stay in.
    const own = START + 10 * DAY + 11 * HOUR;
    main.steps.push({ from: own, to: own + 40 * MIN, add: p.stepAdd });
    vm.series.set(clusterId, [main]);
    const rule = async (key: string) => {
      const id = newId();
      await db
        .insertInto('alert_rules')
        .values({
          id,
          org_id: orgId,
          name: key,
          type: 'default',
          rule_key: key,
          severity: 'warning',
        })
        .execute();
      return id;
    };
    const fire = async (ruleId: string, from: number, to: number) =>
      db
        .insertInto('alert_states')
        .values({
          id: newId(),
          org_id: orgId,
          rule_id: ruleId,
          cluster_id: clusterId,
          fingerprint: `${ruleId}:x`,
          state: 'resolved',
          severity: 'warning',
          labels: JSON.stringify(p.alertLabels),
          started_at: new Date(from),
          fired_at: new Date(from),
          resolved_at: new Date(to),
        })
        .execute();
    await fire(
      await rule(p.kind === 'kubernetes' ? 'k8s.pod.crashloop' : 'docker.container.restarts'),
      inc,
      inc + 40 * MIN,
    );
    await fire(await rule(ANOMALY_RULE_KEY), own, own + 40 * MIN);
    const d = deps(vm, async () => [orgId]);
    await runAnomalyMinute(d, START);
    await learn(d, START, START + 14 * DAY);
    const row = (await baseline(clusterId, main))!;
    const b1 = bucketOf(inc);
    const ref1 = reference(main, 1, inc, (t) => t >= inc && t < inc + 40 * MIN);
    expect(row.minutes[b1]).toBe(80);
    expect(ref1.n).toBe(80);
    close(row.medians[b1], ref1.median);
    close(row.mads[b1], ref1.mad);
    // The anomaly alert's hour keeps its 120 minutes, the step included.
    const b2 = bucketOf(own);
    expect(row.minutes[b2]).toBe(120);
    close(row.medians[b2], reference(main, 1, own).median);
  });

  it('learning starts when the org is first seen with Pro, never reading older history', async () => {
    const { orgId, clusterId } = await orgWith(p.kind);
    const vm = new FakeVictoria();
    // The series has reported for weeks; the org upgrades on day 10.
    vm.series.set(clusterId, [fresh(p.main)]);
    const upgrade = START + 10 * DAY + 30 * MIN;
    let pro = false;
    const d = deps(vm, async () => (pro ? [orgId] : []));
    await learn(d, START, START + 10 * DAY);
    expect(await baseline(clusterId, p.main)).toBeUndefined();
    pro = true;
    await runAnomalyMinute(d, upgrade);
    const learning = await db
      .selectFrom('anomaly_orgs')
      .selectAll()
      .where('org_id', '=', orgId)
      .executeTakeFirstOrThrow();
    expect(learning.learning_since.getTime()).toBe(upgrade);
    await learn(d, START + 10 * DAY, START + 12 * DAY);
    const row = (await baseline(clusterId, p.main))!;
    expect(row.first_seen.getTime()).toBe(upgrade);
    // The upgrade's hour has its 30 minutes after the upgrade; the hours before it none,
    // though the series was retained 7 days before.
    expect(row.minutes[bucketOf(upgrade)]).toBe(30);
    expect(row.minutes[bucketOf(upgrade + HOUR)]).toBe(60);
    expect(row.minutes[bucketOf(upgrade - HOUR)]).toBe(0);
    // Scoring waits 7 days from the upgrade.
    const at = START + 12 * DAY;
    vm.series.set(clusterId, [
      { ...p.main, steps: [{ from: at, to: at + 20 * MIN, add: p.stepAdd }] },
    ]);
    await score(d, at, at + 15 * MIN);
    expect(await periods(clusterId)).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------ gating

describe('gating (ADR-195, ADR-197, ADR-204)', () => {
  it('Community doesn’t start the worker: it exits at start saying why', () => {
    expect(workerRefusal({ edition: 'community', demoMode: false })).toMatch(
      /only in WatchLog Cloud/,
    );
    expect(workerRefusal({ edition: 'cloud', demoMode: false })).toBeNull();
    expect(workerRefusal({ edition: 'community', demoMode: true })).toBeNull();
    const entry = fileURLToPath(new URL('../src/anomaly-worker.ts', import.meta.url));
    const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
    const env = { PATH: process.env.PATH ?? '', DATABASE_URL: 'postgres://x@127.0.0.1:1/none' };
    const run = spawnSync(tsx, [entry], { env, encoding: 'utf8', timeout: 30_000 });
    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/anomaly-worker does not start: .*only in WatchLog Cloud/);
  });

  it('Cloud: only orgs with pro_features are scored; a Free org gets no rows', async () => {
    const pro = await orgWith('kubernetes', 'pro');
    const free = await orgWith('server', 'free');
    const none = await orgWith('server', null);
    const cloud = { edition: 'cloud' as const, demoMode: false };
    const listed = await entitledOrgs(cloud, db);
    expect(listed).toContain(pro.orgId);
    expect(listed).not.toContain(free.orgId);
    expect(listed).not.toContain(none.orgId);
    expect(await entitledOrgs({ edition: 'community', demoMode: false }, db)).toEqual([]);
    expect(
      (await entitledOrgs({ edition: 'community', demoMode: true }, db)).length,
    ).toBeGreaterThan(2);
    const ent = { get: async (id: string) => ({ proFeatures: id === pro.orgId }) } as never;
    expect(await hasWhatChanged(cloud, ent, pro.orgId)).toBe(true);
    expect(await hasWhatChanged(cloud, ent, free.orgId)).toBe(false);
    expect(await hasWhatChanged({ edition: 'community', demoMode: false }, null, pro.orgId)).toBe(
      false,
    );
    expect(await hasWhatChanged({ edition: 'community', demoMode: true }, null, pro.orgId)).toBe(
      true,
    );

    const vm = new FakeVictoria();
    vm.series.set(pro.clusterId, [fresh(platforms[0]!.main)]);
    vm.series.set(free.clusterId, [fresh(platforms[1]!.main)]);
    vm.series.set(none.clusterId, [fresh(platforms[1]!.main)]);
    const d = deps(vm, async () =>
      (await entitledOrgs(cloud, db)).filter((o) =>
        [pro.orgId, free.orgId, none.orgId].includes(o),
      ),
    );
    await learn(d, START, START + 3 * HOUR);
    for (const o of [free, none]) {
      expect(await baseline(o.clusterId, platforms[1]!.main), 'free').toBeUndefined();
      const learning = await db
        .selectFrom('anomaly_orgs')
        .select('org_id')
        .where('org_id', '=', o.orgId)
        .execute();
      expect(learning).toEqual([]);
    }
    expect(await baseline(pro.clusterId, platforms[0]!.main)).toBeDefined();
    // Not even read: the Free clusters were never queried.
    expect([...vm.asked]).toEqual([pro.clusterId]);
  });

  it.each(platforms)(
    '$kind: a downgrade stops scoring at once and keeps baselines 30 days',
    async (p) => {
      const { orgId, clusterId } = await orgWith(p.kind);
      const vm = new FakeVictoria();
      const at = START + 14 * DAY + 2 * HOUR;
      vm.series.set(clusterId, [
        { ...p.main, steps: [{ from: at, to: at + 60 * MIN, add: p.stepAdd }] },
      ]);
      let entitled = true;
      const d = deps(vm, async () => (entitled ? [orgId] : []));
      await runAnomalyMinute(d, START);
      await learn(d, START, START + 14 * DAY);
      await score(d, at, at + 15 * MIN);
      expect((await periods(clusterId))[0]!.ended_at).toBeNull();
      // Downgraded: the next hour ends the open period; the baselines stay.
      entitled = false;
      await runAnomalyHour(d, at + HOUR + 5 * MIN);
      expect((await periods(clusterId))[0]!.ended_at).not.toBeNull();
      expect(await baseline(clusterId, p.main)).toBeDefined();
      // Back to Pro within 30 days: learning resumes from the kept start.
      entitled = true;
      const back = at + 20 * DAY;
      await runAnomalyMinute(d, back);
      const kept = await db
        .selectFrom('anomaly_orgs')
        .selectAll()
        .where('org_id', '=', orgId)
        .executeTakeFirstOrThrow();
      expect(kept.learning_since.getTime()).toBe(START);
      expect(await baseline(clusterId, p.main)).toBeDefined();
      // Downgraded again; 30 days after it last had Pro, the baselines and learning row go.
      entitled = false;
      await runAnomalyHour(d, back + (DOWNGRADE_KEEP_DAYS - 1) * DAY);
      expect(await baseline(clusterId, p.main)).toBeDefined();
      await runAnomalyHour(d, back + (DOWNGRADE_KEEP_DAYS + 1) * DAY);
      expect(await baseline(clusterId, p.main)).toBeUndefined();
      expect(
        await db.selectFrom('anomaly_orgs').selectAll().where('org_id', '=', orgId).execute(),
      ).toEqual([]);
    },
  );
});

// ------------------------------------------------------------------------------ Docker specifics

describe('Docker: a Compose service’s alert leaves out its containers’ minutes', () => {
  it('the container list maps the container to its Compose service', async () => {
    const { orgId, clusterId } = await orgWith('server');
    await db
      .insertInto('objects')
      .values({
        id: newId(),
        cluster_id: clusterId,
        source: 'docker',
        kind: 'DockerContainer',
        namespace: 'shop',
        name: 'shop-api-1',
        uid: newId(),
        node: 'docker-1',
        spec_summary: JSON.stringify({ compose_service: 'api' }),
      })
      .execute();
    const ruleId = newId();
    await db
      .insertInto('alert_rules')
      .values({
        id: ruleId,
        org_id: orgId,
        name: 'egress',
        type: 'default',
        rule_key: 'egress.new_destination',
        severity: 'warning',
      })
      .execute();
    const inc = START + 9 * DAY + 10 * HOUR;
    await db
      .insertInto('alert_states')
      .values({
        id: newId(),
        org_id: orgId,
        rule_id: ruleId,
        cluster_id: clusterId,
        fingerprint: 'egress:x',
        state: 'firing',
        severity: 'warning',
        labels: JSON.stringify({ compose_project: 'shop', compose_service: 'api' }),
        started_at: new Date(inc),
        fired_at: new Date(inc),
      })
      .execute();
    const vm = new FakeVictoria();
    const main = fresh(platforms[1]!.main);
    vm.series.set(clusterId, [main]);
    const d = deps(vm, async () => [orgId]);
    await runAnomalyMinute(d, START);
    await learn(d, START, START + 10 * DAY);
    const row = (await baseline(clusterId, main))!;
    // Still firing: every minute from 10:00 on day 9 is left out.
    expect(row.minutes[bucketOf(inc)]).toBe(60);
    expect(row.minutes[bucketOf(inc + HOUR)]).toBe(60);
    expect(row.minutes[bucketOf(inc - HOUR)]).toBe(120);
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

  it(
    'the jobs write each org’s rows as watchlog_app; neither org sees the other’s',
    // Two apps and the watchlog_app role: over 5 s on a busy CI runner.
    { timeout: 30_000 },
    async () => {
      const a = await orgWith('kubernetes');
      const b = await orgWith('server');
      const vm = new FakeVictoria();
      const at = START + 14 * DAY + 2 * HOUR;
      vm.series.set(a.clusterId, [
        { ...platforms[0]!.main, steps: [{ from: at, to: at + 60 * MIN, add: 3 }] },
      ]);
      vm.series.set(b.clusterId, [
        { ...platforms[1]!.main, steps: [{ from: at, to: at + 60 * MIN, add: 2 ** 31 }] },
      ]);
      const d = deps(vm, async () => [a.orgId, b.orgId], appDb);
      await runAnomalyMinute(d, START);
      await learn(d, START, START + 14 * DAY);
      const report = await runAnomalyMinute(d, at + 12 * MIN);
      expect(report.errors).toEqual([]);
      expect(report.opened).toBe(2);
      const client = new pg.Client({ connectionString: appUrlOf(inject('databaseUrl')) });
      await client.connect();
      try {
        for (const t of ['anomaly_baselines', 'anomaly_periods', 'anomaly_orgs']) {
          expect((await client.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n, t).toBe('0');
        }
        await client.query("SELECT set_config('watchlog.org_id', $1, false)", [b.orgId]);
        for (const t of ['anomaly_baselines', 'anomaly_periods', 'anomaly_orgs']) {
          const r = await client.query(`SELECT DISTINCT org_id FROM ${t}`);
          expect(r.rows, t).toEqual([{ org_id: b.orgId }]);
        }
        await expect(
          client.query(
            `INSERT INTO anomaly_periods (org_id, cluster_id, series_hash, metric, subject, started_at, bucket, median, usual_low, usual_high, peak_score, peak_value, peak_at, last_value, last_at)
           VALUES ($1, $2, decode(repeat('00', 32), 'hex'), 'x', '{}', now(), 0, 0, 0, 0, 0, 0, now(), 0, now())`,
            [b.orgId, a.clusterId],
          ),
        ).rejects.toThrow();
        const upd = await client.query(
          'UPDATE anomaly_baselines SET last_seen = now() WHERE org_id = $1',
          [a.orgId],
        );
        expect(upd.rowCount).toBe(0);
      } finally {
        await client.end();
      }
    },
  );
});
