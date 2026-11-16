// SPDX-License-Identifier: AGPL-3.0-only
// What changed on the live demo (ADR-203; v0.8 slice 7), on an injectable clock: the demo's
// entitlement (demo mode only, never a real Free org), the demo-only look-back (the first
// baselines from the retained history, so the demo doesn't learn for 7 days after its
// deploy), and the firing-alert exclusion against an hourly, chaos-like incident. Each
// scenario runs for a Kubernetes and a Docker subject. The page's, the route's and the MCP
// tool's demo answers are in what-changed-api, mcp-what-changed and the web's tests.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, type Database } from '../src/db/index.js';
import { newId } from '../src/lib/ids.js';
import type { ClusterScope, QuerySeries } from '../src/lib/victoria.js';
import {
  entitledOrgs,
  hasWhatChanged,
  lookBackDays,
  whatChangedExists,
  workerRefusal,
} from '../src/modules/anomaly/gate.js';
import {
  LOOK_BACK_HOURS_PER_RUN,
  runAnomalyHour,
  runAnomalyLookBack,
  runAnomalyMinute,
  type AnomalyDeps,
  type LookBackState,
} from '../src/modules/anomaly/jobs.js';
import {
  queriesFor,
  seriesHash,
  subjectOf,
  type ClusterKind,
  type ScoredKey,
} from '../src/modules/anomaly/keys.js';
import { alertTokens, seriesTokens } from '../src/modules/anomaly/exclusion.js';
import { bucketOf, medianAndMad } from '../src/modules/anomaly/stats.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The series report from here: a Monday, 00:00 UTC. */
const START = Date.UTC(2026, 10, 2, 0, 0, 0);
/** The demo's 0.8.0 deploy: the worker first sees the org 10 days later. */
const DEPLOY = START + 10 * DAY + 30 * MIN;
const silent = { warn: () => {} };

function noise(t: number, seed: number): number {
  let x = (Math.floor(t / MIN) * 2654435761 + seed * 40503) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0x5bd1e995) >>> 0;
  x ^= x >>> 15;
  return (x / 2 ** 32) * 2 - 1;
}

interface Series {
  key: ScoredKey;
  labels: Record<string, string>;
  base: number;
  wobble: number;
  /** The demo's chaos: `add` during minutes [from, to) of every hour. */
  chaos?: { from: number; to: number; add: number };
  /** One more step, [from, to) → add. */
  step?: { from: number; to: number; add: number };
}

const inChaos = (s: Series, t: number) => {
  const m = new Date(t).getUTCMinutes();
  return !!s.chaos && m >= s.chaos.from && m < s.chaos.to;
};

function valueAt(s: Series, t: number): number {
  let v = s.base + s.wobble * noise(t, 7);
  if (s.chaos && inChaos(s, t)) v += s.chaos.add;
  if (s.step && t >= s.step.from && t < s.step.to) v += s.step.add;
  return Math.max(0, v);
}

/** VictoriaMetrics keeping what the demo keeps: no sample before START. */
class FakeVictoria {
  series = new Map<string, Series[]>();
  asked = 0;
  private readonly keyOf = new Map<string, ScoredKey>();
  constructor() {
    for (const kind of ['kubernetes', 'docker'] as ClusterKind[]) {
      for (const q of queriesFor(kind, [])) this.keyOf.set(q.expr, q.key);
    }
  }
  async queryRange(scope: ClusterScope, expr: string, start: number, end: number, step: number) {
    this.asked++;
    const key = this.keyOf.get(expr);
    const out: QuerySeries[] = [];
    for (const s of this.series.get(scope.clusterId) ?? []) {
      if (s.key !== key) continue;
      const points: [number, number | null][] = [];
      for (let t = start; t <= end; t += step) {
        if (t * 1000 >= START) points.push([t, valueAt(s, t * 1000)]);
      }
      if (points.length) out.push({ labels: s.labels, points });
    }
    return out;
  }
}

interface Platform {
  kind: ClusterKind;
  series: Series;
  /** What the demo's own alert on the subject carries (slice 1's labels). */
  alertLabels: Record<string, string>;
  ruleKey: string;
  add: number;
}

const platforms: Platform[] = [
  {
    kind: 'kubernetes',
    series: {
      key: 'workload.cpu.usage',
      labels: { namespace: 'shop', workload_kind: 'Deployment', workload: 'backend' },
      base: 0.5,
      wobble: 0.02,
    },
    // busy-backend's throttling alert names the workload and its container.
    alertLabels: {
      namespace: 'shop',
      workload_kind: 'Deployment',
      workload: 'backend',
      container: 'podinfo',
    },
    ruleKey: 'k8s.cpu.throttled',
    add: 1.5,
  },
  {
    kind: 'docker',
    series: {
      key: 'container.memory.working_set',
      labels: { host: 'demo-docker-host', container: 'storefront-worker-1' },
      base: 40 * 2 ** 20,
      wobble: 2 * 2 ** 20,
    },
    // The worker's OOM: Docker's restarting container, the host as `node`.
    alertLabels: { container: 'storefront-worker-1', node: 'demo-docker-host' },
    ruleKey: 'docker.container.restarts',
    add: 600 * 2 ** 20,
  },
];

let db: Database;
beforeAll(() => {
  db = createDb(inject('databaseUrl'));
});
afterAll(async () => {
  await db.destroy();
});

async function orgWith(kind: ClusterKind, plan: 'pro' | 'free' | null = null) {
  const orgId = newId();
  const clusterId = newId();
  await db
    .insertInto('orgs')
    .values({ id: orgId, name: 'Demo', slug: `demo-${orgId.slice(-8)}`, plan: 'community' })
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

function deps(vm: FakeVictoria, orgId: string, look: number): AnomalyDeps {
  return {
    db,
    systemDb: db,
    victoria: vm,
    orgs: async () => [orgId],
    lookBackDays: look,
    log: silent,
  };
}

/** The look-back's runs until it has nothing left (one a minute in the worker). */
async function lookBack(d: AnomalyDeps, now: number, state: LookBackState) {
  let runs = 0;
  for (;;) {
    const r = await runAnomalyLookBack(d, now + runs * MIN, state);
    if (!r.clusters) return runs;
    runs++;
  }
}

async function baseline(clusterId: string, s: Series) {
  return db
    .selectFrom('anomaly_baselines')
    .selectAll()
    .where('cluster_id', '=', clusterId)
    .where('series_hash', '=', seriesHash(s.key, subjectOf(s.labels)))
    .executeTakeFirst();
}

const periods = (clusterId: string) =>
  db
    .selectFrom('anomaly_periods')
    .selectAll()
    .where('cluster_id', '=', clusterId)
    .orderBy('started_at')
    .execute();

async function score(d: AnomalyDeps, from: number, to: number) {
  for (let m = from; m <= to; m += MIN) await runAnomalyMinute(d, m);
}

async function fireEveryHour(
  orgId: string,
  clusterId: string,
  p: Platform,
  chaos: { from: number; to: number },
) {
  const ruleId = newId();
  await db
    .insertInto('alert_rules')
    .values({
      id: ruleId,
      org_id: orgId,
      name: p.ruleKey,
      type: 'default',
      rule_key: p.ruleKey,
      severity: 'warning',
    })
    .execute();
  const rows = [];
  for (let h = START; h < DEPLOY + DAY; h += HOUR) {
    const from = h + chaos.from * MIN;
    rows.push({
      id: newId(),
      org_id: orgId,
      rule_id: ruleId,
      cluster_id: clusterId,
      fingerprint: `${ruleId}:${h}`,
      state: 'resolved',
      severity: 'warning',
      labels: JSON.stringify(p.alertLabels),
      // Pending from the chaos's start, firing 5 minutes later (the rule's "for"), as the
      // demo's own alerts do: the exclusion starts at the start.
      started_at: new Date(from),
      fired_at: new Date(from + 5 * MIN),
      resolved_at: new Date(h + chaos.to * MIN),
    });
  }
  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insertInto('alert_states')
      .values(rows.slice(i, i + 500) as never)
      .execute();
  }
}

describe('the demo entitlement (ADR-203)', () => {
  it('demo mode: the installation’s org has What changed; Cloud, even with demo mode set, only Pro', async () => {
    const demo = { edition: 'community' as const, demoMode: true };
    const cloudDemo = { edition: 'cloud' as const, demoMode: true };
    const community = { edition: 'community' as const, demoMode: false };
    const free = await orgWith('docker', 'free');
    const pro = await orgWith('kubernetes', 'pro');
    // The demo: no entitlement row at all, and What changed all the same.
    const bare = await orgWith('kubernetes');
    expect(whatChangedExists(demo)).toBe(true);
    expect(workerRefusal(demo)).toBeNull();
    expect(await hasWhatChanged(demo, null, bare.orgId)).toBe(true);
    expect(await entitledOrgs(demo, db)).toContain(bare.orgId);
    // A real Free org in a Cloud that also has demo mode set: the entitlement decides.
    const ent = {
      get: async (id: string) => ({ proFeatures: id === pro.orgId }),
    } as never;
    expect(await hasWhatChanged(cloudDemo, ent, free.orgId)).toBe(false);
    expect(await hasWhatChanged(cloudDemo, null, free.orgId)).toBe(false);
    expect(await hasWhatChanged(cloudDemo, ent, pro.orgId)).toBe(true);
    const listed = await entitledOrgs(cloudDemo, db);
    expect(listed).toContain(pro.orgId);
    expect(listed).not.toContain(free.orgId);
    expect(listed).not.toContain(bare.orgId);
    // Community: nobody.
    expect(await hasWhatChanged(community, null, bare.orgId)).toBe(false);
    expect(await entitledOrgs(community, db)).toEqual([]);
  });

  it('the look-back is the demo’s alone: 14 days in demo mode, 0 in Cloud (with demo mode too) and Community', () => {
    expect(lookBackDays({ edition: 'community', demoMode: true })).toBe(14);
    expect(lookBackDays({ edition: 'cloud', demoMode: true })).toBe(0);
    expect(lookBackDays({ edition: 'cloud', demoMode: false })).toBe(0);
    expect(lookBackDays({ edition: 'community', demoMode: false })).toBe(0);
  });
});

describe.each(platforms)('$kind: the demo’s look-back and its chaos', (p) => {
  it('the demo learns from its retained history at the deploy: scored the same day, not 7 days later', async () => {
    const { orgId, clusterId } = await orgWith(p.kind);
    const vm = new FakeVictoria();
    const series: Series = { ...p.series };
    vm.series.set(clusterId, [series]);
    const d = deps(vm, orgId, 14);
    const state: LookBackState = new Map();
    const runs = await lookBack(d, DEPLOY, state);
    expect(runs).toBe(168 / LOOK_BACK_HOURS_PER_RUN);
    const learning = await db
      .selectFrom('anomaly_orgs')
      .selectAll()
      .where('org_id', '=', orgId)
      .executeTakeFirstOrThrow();
    expect(learning.learning_since.getTime()).toBe(DEPLOY - 14 * DAY);
    const row = (await baseline(clusterId, series))!;
    // The retained history starts at START: 10 days, so the series' first sighting is there.
    expect(row.first_seen.getTime()).toBe(START);
    // Every bucket: one occurrence, or two for the 3 days that also have last week's.
    expect(row.minutes.filter((n) => n === 0)).toHaveLength(0);
    expect(row.minutes.filter((n) => n === 120)).toHaveLength(3 * 24);
    expect(row.minutes.filter((n) => n === 60)).toHaveLength(4 * 24);
    // A step right after the deploy is listed: no 7 days of learning first.
    const at = DEPLOY + 30 * MIN;
    series.step = { from: at, to: at + 15 * MIN, add: p.add };
    await score(d, at, at + 12 * MIN);
    const list = await periods(clusterId);
    expect(list).toHaveLength(1);
    expect(list[0]!.started_at.getTime()).toBe(at);
    // Nothing is left to do, and a restart does it again (idempotent).
    expect((await runAnomalyLookBack(d, at, state)).clusters).toBe(0);
    expect(await lookBack(d, DEPLOY, new Map())).toBe(runs);
    expect((await baseline(clusterId, series))!.minutes).toEqual(row.minutes);
  });

  it('a real org never looks back: learning starts at the upgrade, nothing read before it', async () => {
    const { orgId, clusterId } = await orgWith(p.kind, 'pro');
    const vm = new FakeVictoria();
    const series: Series = { ...p.series };
    vm.series.set(clusterId, [series]);
    const d = deps(vm, orgId, 0);
    expect((await runAnomalyLookBack(d, DEPLOY, new Map())).clusters).toBe(0);
    expect(vm.asked).toBe(0);
    await runAnomalyMinute(d, DEPLOY);
    const learning = await db
      .selectFrom('anomaly_orgs')
      .selectAll()
      .where('org_id', '=', orgId)
      .executeTakeFirstOrThrow();
    expect(learning.learning_since.getTime()).toBe(DEPLOY);
    expect(await baseline(clusterId, series)).toBeUndefined();
    await runAnomalyHour(d, DEPLOY + HOUR + 5 * MIN);
    expect((await baseline(clusterId, series))!.first_seen.getTime()).toBe(DEPLOY);
    const at = DEPLOY + 2 * HOUR;
    series.step = { from: at, to: at + 15 * MIN, add: p.add };
    await score(d, at, at + 12 * MIN);
    expect(await periods(clusterId)).toHaveLength(0);
  });

  it('hourly chaos with its alert is left out of every bucket, and is listed when it comes back', async () => {
    const { orgId, clusterId } = await orgWith(p.kind);
    const vm = new FakeVictoria();
    // Every hour from :15 to :30 the subject breaks, and the demo's own alert fires on it
    // after its rule's 5 minutes.
    const chaos = { from: 15, to: 30, add: p.add };
    const series: Series = { ...p.series, chaos };
    // A twin subject with the same chaos and no alert: its minutes stay in (for contrast).
    const rename: Record<string, string> =
      p.kind === 'kubernetes' ? { workload: 'backend-twin' } : { container: 'storefront-twin-1' };
    const twin: Series = { ...series, labels: { ...series.labels, ...rename } };
    vm.series.set(clusterId, [series, twin]);
    await fireEveryHour(orgId, clusterId, p, chaos);
    const d = deps(vm, orgId, 14);
    await lookBack(d, DEPLOY, new Map());
    const row = (await baseline(clusterId, series))!;
    const twinRow = (await baseline(clusterId, twin))!;
    // 45 minutes an occurrence: the 15 chaos minutes of each hour are left out.
    expect(row.minutes.filter((n) => n === 90)).toHaveLength(3 * 24);
    expect(row.minutes.filter((n) => n === 45)).toHaveLength(4 * 24);
    expect(twinRow.minutes.filter((n) => n === 120)).toHaveLength(3 * 24);
    // The median and MAD are those of the quiet minutes alone.
    const hour = Math.floor(DEPLOY / HOUR) * HOUR - 2 * HOUR;
    const quiet: number[] = [];
    for (const occ of [hour, hour - 7 * DAY]) {
      for (let t = occ; t < occ + HOUR; t += MIN)
        if (!inChaos(series, t)) quiet.push(valueAt(series, t));
    }
    const ref = medianAndMad(quiet);
    const b = bucketOf(hour);
    expect(Math.abs(row.medians[b]! - ref.median)).toBeLessThanOrEqual(ref.median * 1e-6);
    expect(Math.abs(row.mads[b]! - ref.mad)).toBeLessThanOrEqual(ref.mad * 1e-5 + 1e-9);
    // The next occurrence after the deploy: unusual for its 15 minutes, so it is listed.
    const next = Math.floor(DEPLOY / HOUR) * HOUR + HOUR + 15 * MIN;
    await score(d, next, next + 12 * MIN);
    const listed = await periods(clusterId);
    expect(listed.map((r) => r.subject)).toContainEqual(subjectOf(series.labels));
    expect(listed.find((r) => r.metric === series.key)!.started_at.getTime()).toBe(next);
  });
});

describe('the chaos’s alerts name what they break (ADR-203)', () => {
  it('Kubernetes: failed connections leave out the destination workload as well as the caller', () => {
    const alert = alertTokens('kubernetes', {
      namespace: 'shop',
      workload_kind: 'Deployment',
      workload: 'frontend',
      dst_kind: 'workload',
      dst_namespace: 'shop',
      dst_workload_kind: 'Deployment',
      dst_workload: 'api',
    });
    // The requests api serves (seen from the callers) and api's own CPU.
    const served = seriesTokens('kubernetes', {
      dst_kind: 'workload',
      dst_namespace: 'shop',
      dst_workload_kind: 'Deployment',
      dst_workload: 'api',
    });
    const own = seriesTokens('kubernetes', {
      namespace: 'shop',
      workload_kind: 'Deployment',
      workload: 'api',
    });
    for (const t of [served, own]) expect([...t].some((x) => alert.has(x))).toBe(true);
    // Another workload stays in.
    const other = seriesTokens('kubernetes', {
      namespace: 'shop',
      workload_kind: 'Deployment',
      workload: 'backend',
    });
    expect([...other].some((x) => alert.has(x))).toBe(false);
  });

  it('Docker: failed connections leave out the destination container and its Compose service', () => {
    const compose = new Map([['storefront-api-1', { project: 'storefront', service: 'api' }]]);
    const alert = alertTokens(
      'docker',
      {
        container: 'storefront-web-1',
        node: 'demo-docker-host',
        dst_kind: 'container',
        dst: 'storefront-api-1',
      },
      compose,
    );
    const own = seriesTokens(
      'docker',
      { host: 'demo-docker-host', container: 'storefront-api-1' },
      compose,
    );
    expect([...own].some((x) => alert.has(x))).toBe(true);
    const other = seriesTokens(
      'docker',
      { host: 'demo-docker-host', container: 'storefront-db-1' },
      compose,
    );
    expect([...other].some((x) => alert.has(x))).toBe(false);
  });
});
