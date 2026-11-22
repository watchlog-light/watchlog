// SPDX-License-Identifier: AGPL-3.0-only
// The three default egress rules (ADR-187, v0.7 slice 5), through the alert worker on an
// injectable clock (never by waiting), on Kubernetes and Docker: New external destination with
// its learning periods (the cluster's from the upgrade or first report, a new source's from its
// first seen), expected rows, private networks, local names and "Internet"; Raw IP egress at 5
// connections in 10 minutes; Large upload to a new destination past 100 MiB in an hour. The
// series come from a fake VictoriaMetrics in the shapes slice 1 measured; the inventory rows are
// written as the minute job writes them. Also: the rules arrive on upgrade with no step, and in
// Cloud each org's alerts and rules are written as watchlog_app under Row-Level Security.
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDb, type Database } from '../src/db/index.js';
import { newId } from '../src/lib/ids.js';
import {
  authorisedScope,
  VictoriaQueryClient,
  type ClusterScope,
  type QuerySeries,
} from '../src/lib/victoria.js';
import { STATE_RULES } from '../src/modules/alerts/defaults.js';
import { DEFAULT_RULES, ensureDefaultRules, lookupEvaluator } from '../src/modules/alerts/rules.js';
import { alertText } from '../src/modules/alerts/text.js';
import type { AlertWorker } from '../src/modules/alerts/worker.js';
import { setEgressLearningDays } from '../src/modules/egress/learning.js';
import { readEgress, type EgressCluster } from '../src/modules/egress/read.js';
import { EGRESS_RULES, LARGE_UPLOAD_BYTES } from '../src/modules/egress/rules.js';
import {
  closeTestContext,
  createTestContext,
  TEST_SECRET_KEY,
  TEST_VM_URL,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';
import { appUrlOf, ensureAppRole } from './isolation/cloud.js';
import { createOrgCluster, insertChannel, testWorker } from './support/alerts.js';
import { readFileSync } from 'node:fs';
import { step, type Episode } from '../src/modules/alerts/state-machine.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 15, 8, 0, 0);
const NEW = 'egress.new_destination';
const RAW = 'egress.raw_ip';
const UPLOAD = 'egress.large_upload_new';

type Source = Record<string, string>;
const ORDERS: Source = { namespace: 'shop', workload_kind: 'Deployment', workload: 'orders' };
const BILLING: Source = { namespace: 'shop', workload_kind: 'Deployment', workload: 'billing' };
const API: Source = { compose_project: 'shop', compose_service: 'api' };
const REDIS: Source = { host: 'docker-01', container: 'redis' };

/** A VictoriaMetrics that answers the rules' queries from what the test sets. */
class FakeVictoria {
  raw: QuerySeries[] = [];
  sent: QuerySeries[] = [];
  queries: string[] = [];
  async query(_scope: ClusterScope, expr: string): Promise<QuerySeries[]> {
    this.queries.push(expr);
    if (expr.includes('watchlog_flow_connections_total')) return this.raw;
    if (expr.includes('watchlog_flow_bytes_total')) return this.sent;
    return [];
  }
}
const series = (labels: Record<string, string>, value: number): QuerySeries => ({
  labels,
  points: [[0, value]],
});
const kubeSeries = (workload: string, dst: string, port: string, extra = {}) => ({
  namespace: 'shop',
  workload_kind: 'Deployment',
  workload,
  dst_kind: 'external',
  dst,
  dst_port: port,
  ...extra,
});
const dockerSeries = (
  container: string,
  dst: string,
  port: string,
  compose?: [string, string],
) => ({
  host: 'docker-01',
  container,
  ...(compose ? { compose_project: compose[0], compose_service: compose[1] } : {}),
  dst_kind: 'external',
  dst,
  dst_port: port,
});

let ctx: TestContext;
let worker: AlertWorker;
let vm: FakeVictoria;
let orgId: string;
let clusterId: string;
let kind: 'kubernetes' | 'server';
const clock = { now: T0 };

/** A cluster that reported from `firstSeenAt`; `learningSince` is the upgrade's mark. */
async function setup(
  k: 'kubernetes' | 'server',
  o: { firstSeenAt?: number; learningSince?: number | null; backfilled?: boolean } = {},
) {
  kind = k;
  ({ orgId, clusterId } = await createOrgCluster(ctx.db, k));
  await ctx.db
    .updateTable('clusters')
    .set({
      first_seen_at: new Date(o.firstSeenAt ?? T0 - 30 * DAY),
      egress_learning_since: o.learningSince ? new Date(o.learningSince) : null,
      egress_backfilled_at: o.backfilled === false ? null : new Date(T0 - 30 * DAY),
    })
    .where('id', '=', clusterId)
    .execute();
  vm = new FakeVictoria();
  worker = testWorker(ctx.db, clock, lookupEvaluator, {
    prepareOrg: (id) => ensureDefaultRules(ctx.db, id),
    victoria: vm as unknown as VictoriaQueryClient,
  });
}

const cls = (d: string) =>
  d === 'Internet'
    ? 'internet'
    : /^\d/.test(d)
      ? /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(d)
        ? 'private_network'
        : 'public_network'
      : d.includes('.')
        ? 'name'
        : 'local_name';

/** An inventory row as the minute job writes it, and its source's row. */
async function seen(
  source: Source,
  destination: string,
  port: number,
  firstSeen: number,
  o: { lastSeen?: number; sourceFirstSeen?: number; pattern?: string; before?: boolean } = {},
) {
  await ctx.db
    .insertInto('egress_sources')
    .values({
      org_id: orgId,
      cluster_id: clusterId,
      source: JSON.stringify(source),
      first_seen: new Date(o.sourceFirstSeen ?? T0 - 20 * DAY),
      last_seen: new Date(o.lastSeen ?? firstSeen),
    })
    .onConflict((oc) => oc.columns(['cluster_id', 'source']).doNothing())
    .execute();
  await ctx.db
    .insertInto('egress_destinations')
    .values({
      id: newId(),
      org_id: orgId,
      cluster_id: clusterId,
      source: JSON.stringify(source),
      destination,
      dst_kind: destination === 'Internet' ? 'internet' : 'external',
      port,
      destination_class: cls(destination),
      first_seen: new Date(firstSeen),
      first_seen_before: o.before ?? false,
      last_seen: new Date(o.lastSeen ?? firstSeen),
      pattern: o.pattern ?? null,
    })
    .execute();
}

async function touch(destination: string, at: number) {
  await ctx.db
    .updateTable('egress_destinations')
    .set({ last_seen: new Date(at) })
    .where('cluster_id', '=', clusterId)
    .where('destination', '=', destination)
    .execute();
}

async function cycle(at = clock.now) {
  clock.now = at;
  const r = await worker.runCycle();
  expect(r.errors).toEqual([]);
}
/** Two cycles 30 s apart: what resolving takes (RESOLVE_CYCLES). */
async function cycles(at = clock.now) {
  await cycle(at);
  await cycle(at + 30_000);
}

async function alerts(ruleKey: string) {
  return ctx.db
    .selectFrom('alert_states as s')
    .innerJoin('alert_rules as r', 'r.id', 's.rule_id')
    .select(['s.state', 's.fingerprint', 's.labels', 's.details', 's.started_at', 'r.name'])
    .where('r.rule_key', '=', ruleKey)
    .where('s.cluster_id', '=', clusterId)
    .orderBy('s.fingerprint')
    .execute();
}
const firing = async (key: string) =>
  (await alerts(key)).filter((a) => a.state === 'firing').map((a) => a.fingerprint);

function text(a: Awaited<ReturnType<typeof alerts>>[number], ruleKey: string) {
  return alertText({
    ruleKey,
    ruleName: a.name,
    labels: a.labels as Record<string, string>,
    details: a.details as Record<string, unknown>,
    cluster: { name: kind === 'server' ? 'fleet' : 'prod' },
    now: clock.now,
  });
}

beforeEach(async () => {
  ctx = await createTestContext();
  clock.now = T0;
  setEgressLearningDays(7);
});
afterEach(async () => {
  await worker?.stop();
  await closeTestContext(ctx);
  setEgressLearningDays(7);
});

// ------------------------------------------------------------------------------ new destination

describe('New external destination', () => {
  it('Kubernetes: quiet while the cluster learns, then fires once with its words; 24 h without traffic resolves it, and its next use stays quiet', async () => {
    // First report 3 days ago: learning until T0 + 4 d.
    await setup('kubernetes', { firstSeenAt: T0 - 3 * DAY });
    await seen(ORDERS, 'api.stripe.com', 443, T0 - 2 * DAY, { lastSeen: T0 });
    await cycle(T0);
    expect(await alerts(NEW)).toEqual([]);

    // A destination first seen during the learning period stays learned once it's over.
    const after = T0 + 5 * DAY;
    await touch('api.stripe.com', after);
    await seen(ORDERS, 'cdn-update-check.xyz', 443, after);
    await cycle(after + MIN);
    const [a, ...rest] = await alerts(NEW);
    expect(rest).toEqual([]);
    expect(a).toMatchObject({
      state: 'firing',
      fingerprint: 'egress-new:shop/Deployment/orders',
      labels: {
        namespace: 'shop',
        workload_kind: 'Deployment',
        workload: 'orders',
        destination: 'cdn-update-check.xyz',
        port: '443',
      },
      details: { destination: 'cdn-update-check.xyz', port: 443, class: 'name', others: 0 },
    });
    // The alert starts at the first connection.
    expect(new Date(a!.started_at).getTime()).toBe(after);
    expect(text(a!, NEW)).toEqual({
      title: 'orders started talking to cdn-update-check.xyz:443',
      why: 'first connection at 08:00 UTC · nothing else in the cluster talks to it',
      code: ['cdn-update-check.xyz:443'],
    });

    // Still used a day later: still firing.
    await touch('cdn-update-check.xyz', after + 20 * HOUR);
    await cycle(after + 25 * HOUR);
    expect(await firing(NEW)).toHaveLength(1);
    // 24 hours without traffic: resolved.
    await cycles(after + 45 * HOUR);
    expect((await alerts(NEW)).map((x) => x.state)).toEqual(['resolved']);
    // Used again: no longer new, nothing fires.
    await touch('cdn-update-check.xyz', after + 46 * HOUR);
    await cycles(after + 46 * HOUR + MIN);
    expect((await alerts(NEW)).map((x) => x.state)).toEqual(['resolved']);
  });

  it('an upgrade with traffic in use raises nothing for 7 days (from the upgrade), then a new name fires', async () => {
    // The cluster reported for 60 days; the migration marked the upgrade at T0.
    await setup('kubernetes', { firstSeenAt: T0 - 60 * DAY, learningSince: T0 });
    await seen(ORDERS, 'api.stripe.com', 443, T0 - 30 * DAY, { lastSeen: T0 });
    await seen(ORDERS, 'hooks.slack.com', 443, T0 + MIN, { sourceFirstSeen: T0 - 30 * DAY });
    for (const d of [0, 1, 3, 6.9]) {
      await touch('hooks.slack.com', T0 + d * DAY);
      await cycle(T0 + d * DAY + MIN);
    }
    expect(await alerts(NEW)).toEqual([]);
    await seen(ORDERS, 'example.org', 443, T0 + 8 * DAY, { sourceFirstSeen: T0 - 30 * DAY });
    await cycle(T0 + 8 * DAY + MIN);
    expect(await firing(NEW)).toEqual(['egress-new:shop/Deployment/orders']);
  });

  it('a new source learns for 7 days from its own first seen; another source using the name is counted', async () => {
    await setup('kubernetes');
    await seen(ORDERS, 'example.org', 443, T0 - 10 * DAY, { lastSeen: T0 });
    // billing appeared 2 days ago: still learning.
    await seen(BILLING, 'example.org', 443, T0, { sourceFirstSeen: T0 - 2 * DAY });
    await cycle(T0 + MIN);
    expect(await alerts(NEW)).toEqual([]);
    // Six days later it talks to a new name: learned now, and orders uses it too.
    await seen(ORDERS, 'files.example.net', 443, T0 - DAY, { lastSeen: T0 + 6 * DAY });
    await seen(BILLING, 'files.example.net', 443, T0 + 6 * DAY);
    await cycle(T0 + 6 * DAY + MIN);
    const [a] = await alerts(NEW);
    expect(a).toMatchObject({
      fingerprint: 'egress-new:shop/Deployment/billing',
      details: { others: 1 },
    });
    expect(text(a!, NEW).why).toBe('first connection at 08:00 UTC · 1 other workload talks to it');
  });

  it('never for an expected name, a private network, a local name, "Internet" or a row only "before" the history', async () => {
    await setup('kubernetes');
    const t = T0 + MIN;
    await seen(ORDERS, 'files.amazonaws.com', 443, T0, { pattern: '*.amazonaws.com' });
    await seen(ORDERS, '10.244.1.0/24', 5432, T0);
    await seen(ORDERS, '192.168.5.0/24', 4080, T0);
    await seen(ORDERS, 'demo-control-plane', 6443, T0);
    await seen(ORDERS, 'Internet', 0, T0);
    await seen(ORDERS, 'old.example.org', 443, T0, { before: true });
    await cycle(t);
    expect(await alerts(NEW)).toEqual([]);
    // A public raw network is a new destination (it is also Raw IP's).
    await seen(ORDERS, '1.1.1.0/24', 443, T0);
    await cycle(t + MIN);
    expect(await firing(NEW)).toEqual(['egress-new:shop/Deployment/orders']);
  });

  it('marking the destination expected resolves its open alert at the next evaluation', async () => {
    await setup('kubernetes');
    await seen(ORDERS, 'example.org', 443, T0);
    await cycle(T0 + MIN);
    expect(await firing(NEW)).toHaveLength(1);
    // What syncExpected writes when an expectation covers the row (ADR-186).
    await ctx.db
      .updateTable('egress_destinations')
      .set({ pattern: 'example.org', approved_at: new Date(T0 + 2 * MIN) })
      .where('cluster_id', '=', clusterId)
      .execute();
    await cycles(T0 + 3 * MIN);
    expect((await alerts(NEW)).map((a) => a.state)).toEqual(['resolved']);
  });

  it('the Egress page’s row carries its firing alert ("View alert")', async () => {
    await setup('kubernetes');
    await seen(ORDERS, 'example.org', 443, T0);
    await seen(ORDERS, 'api.stripe.com', 443, T0 - 10 * DAY, { lastSeen: T0 });
    await cycle(T0 + MIN);
    const [a] = await ctx.db
      .selectFrom('alert_states')
      .select('id')
      .where('state', '=', 'firing')
      .execute();
    const cluster = (await ctx.db
      .selectFrom('clusters')
      .selectAll()
      .where('id', '=', clusterId)
      .executeTakeFirstOrThrow()) as unknown as EgressCluster;
    const page = await readEgress(
      ctx.db,
      null,
      orgId,
      cluster,
      {},
      { fromMs: T0 - DAY, toMs: T0 + MIN },
      T0 + MIN,
    );
    expect(page.rows.map((r) => [r.destination, r.alertId])).toEqual(
      expect.arrayContaining([
        ['example.org', a!.id],
        ['api.stripe.com', null],
      ]),
    );
  });

  it('Docker: a Compose service and a plain container, each in its vocabulary', async () => {
    await setup('server');
    await seen(API, 'cdn-update-check.xyz', 443, T0);
    await seen(REDIS, 'example.org', 443, T0);
    await seen(API, 'example.org', 443, T0 - 3 * DAY, { lastSeen: T0 });
    await cycle(T0 + MIN);
    const list = await alerts(NEW);
    expect(list.map((a) => [a.fingerprint, a.labels])).toEqual([
      [
        'egress-new:docker-01/redis',
        { node: 'docker-01', container: 'redis', destination: 'example.org', port: '443' },
      ],
      [
        'egress-new:shop/api',
        {
          compose_project: 'shop',
          compose_service: 'api',
          destination: 'cdn-update-check.xyz',
          port: '443',
        },
      ],
    ]);
    expect(text(list[1]!, NEW).title).toBe('shop/api started talking to cdn-update-check.xyz:443');
    expect(text(list[1]!, NEW).why).toBe(
      'first connection at 08:00 UTC · nothing else in the fleet talks to it',
    );
    expect(text(list[0]!, NEW).why).toBe(
      'first connection at 08:00 UTC · 1 other container talks to it',
    );
  });

  it('WATCHLOG_EGRESS_LEARNING_DAYS shortens the learning period; bad values are refused at start', async () => {
    const env = { DATABASE_URL: inject('databaseUrl'), WATCHLOG_SECRET_KEY: TEST_SECRET_KEY };
    expect(loadConfig(env).egressLearningDays).toBe(7);
    expect(loadConfig({ ...env, WATCHLOG_EGRESS_LEARNING_DAYS: '0.5' }).egressLearningDays).toBe(
      0.5,
    );
    for (const bad of ['-1', 'x', '91'])
      expect(() => loadConfig({ ...env, WATCHLOG_EGRESS_LEARNING_DAYS: bad })).toThrow(
        /WATCHLOG_EGRESS_LEARNING_DAYS/,
      );

    await setup('kubernetes', { firstSeenAt: T0 - 2 * DAY });
    await seen(ORDERS, 'example.org', 443, T0, { sourceFirstSeen: T0 - 2 * DAY });
    await cycle(T0 + MIN);
    expect(await alerts(NEW)).toEqual([]);
    setEgressLearningDays(1);
    await cycle(T0 + 2 * MIN);
    expect(await firing(NEW)).toHaveLength(1);
  });
});

// ----------------------------------------------------------- one alert per source (ADR-229)

describe('New external destination: one alert per source (ADR-229)', () => {
  it("Kubernetes: new names join the source's open alert, newest first; another source has its own", async () => {
    await setup('kubernetes');
    await seen(ORDERS, 'mirror-0812.example.net', 443, T0);
    await cycle(T0 + MIN);
    await seen(ORDERS, 'mirror-0912.example.net', 443, T0 + HOUR);
    await seen(ORDERS, 'mirror-1012.example.net', 443, T0 + 2 * HOUR);
    await seen(BILLING, 'files.example.net', 443, T0 + 2 * HOUR);
    await cycle(T0 + 2 * HOUR + MIN);
    const list = await alerts(NEW);
    expect(list.map((a) => [a.state, a.fingerprint])).toEqual([
      ['firing', 'egress-new:shop/Deployment/billing'],
      ['firing', 'egress-new:shop/Deployment/orders'],
    ]);
    const orders = list[1]!;
    const d = orders.details as {
      count: number;
      destinations: { destination: string; firstSeen: string }[];
    };
    expect(d.count).toBe(3);
    expect(d.destinations.map((x) => [x.destination, x.firstSeen])).toEqual([
      ['mirror-1012.example.net', new Date(T0 + 2 * HOUR).toISOString()],
      ['mirror-0912.example.net', new Date(T0 + HOUR).toISOString()],
      ['mirror-0812.example.net', new Date(T0).toISOString()],
    ]);
    // The labels carry the newest (the Egress page's link, the chart, probable cause).
    expect(orders.labels).toMatchObject({
      workload: 'orders',
      destination: 'mirror-1012.example.net',
    });
    // It started at the first one.
    expect(new Date(orders.started_at).getTime()).toBe(T0);
    expect(text(orders, NEW)).toEqual({
      title: 'orders started talking to 3 new destinations',
      // The default rule has no channel here: no "new since the last message".
      why: 'newest mirror-1012.example.net:443 at 10:00 UTC',
      code: ['mirror-1012.example.net:443'],
    });
  });

  it('with a channel, it names the destinations that joined since the last message', async () => {
    await setup('kubernetes');
    await seen(ORDERS, 'mirror-0812.example.net', 443, T0);
    await cycle(T0 + MIN);
    const ch = await insertChannel(ctx.db, orgId);
    await ctx.db
      .updateTable('alert_rules')
      .set({ channel_ids: [ch] })
      .where('org_id', '=', orgId)
      .where('rule_key', '=', NEW)
      .execute();
    await seen(ORDERS, 'mirror-0912.example.net', 443, T0 + HOUR);
    await cycle(T0 + HOUR + MIN);
    const [a] = await alerts(NEW);
    expect(text(a!, NEW)!.why).toBe(
      'newest mirror-0912.example.net:443 at 09:00 UTC · new since the last message: mirror-0912.example.net:443',
    );
  });

  it('stays open while any of its names is used, joins older ones while open, resolves after 24 h of quiet', async () => {
    await setup('kubernetes');
    await seen(ORDERS, 'a.example.net', 443, T0, { lastSeen: T0 });
    await seen(ORDERS, 'b.example.net', 443, T0 + HOUR, { lastSeen: T0 + HOUR });
    await cycle(T0 + HOUR + MIN);
    expect(await firing(NEW)).toEqual(['egress-new:shop/Deployment/orders']);
    // 30 h later: a.example.net (first seen 31 h ago, joined while open) is still used.
    await touch('a.example.net', T0 + 30 * HOUR);
    await cycles(T0 + 30 * HOUR + MIN);
    const [a] = await alerts(NEW);
    expect(a!.state).toBe('firing');
    expect((a!.details as { count: number }).count).toBe(1);
    // 24 h with no traffic to any of them: resolved.
    await cycles(T0 + 54 * HOUR + 2 * MIN);
    expect((await alerts(NEW)).map((x) => x.state)).toEqual(['resolved']);
  });

  it('Server fleets: a Compose service and a container each keep one alert', async () => {
    await setup('server');
    await seen(API, 'one.example.net', 443, T0);
    await seen(API, 'two.example.net', 8443, T0 + 10 * MIN);
    await seen(REDIS, 'example.org', 443, T0);
    await cycle(T0 + 11 * MIN);
    const list = await alerts(NEW);
    expect(list.map((a) => [a.fingerprint, (a.details as { count: number }).count])).toEqual([
      ['egress-new:docker-01/redis', 1],
      ['egress-new:shop/api', 2],
    ]);
    expect(text(list[1]!, NEW)!.title).toBe('shop/api started talking to 2 new destinations');
    // The Egress page links each of them to the one alert.
    const cluster = (await ctx.db
      .selectFrom('clusters')
      .selectAll()
      .where('id', '=', clusterId)
      .executeTakeFirstOrThrow()) as unknown as EgressCluster;
    const eg = await readEgress(
      ctx.db,
      null,
      orgId,
      cluster,
      {},
      { fromMs: T0 - DAY, toMs: T0 + 11 * MIN },
      T0 + 11 * MIN,
    );
    const ids = new Set(
      eg.rows.filter((r) => r.destination.endsWith('example.net')).map((r) => r.alertId),
    );
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
  });

  it('a repeat message goes out only when names joined since the last one, and names them', () => {
    const ep: Episode = {
      state: 'firing',
      severity: 'warning',
      labels: {},
      details: {},
      startedAt: T0,
      firedAt: T0,
      resolvedAt: null,
      falseSince: null,
      falseCycles: 0,
      lastNotifiedAt: T0,
      notifiedFiring: true,
      silenced: false,
      flapping: false,
      notifySeq: 1,
    };
    const ctx4h = {
      now: T0 + 5 * HOUR,
      forMs: 0,
      renotifyMs: 4 * HOUR,
      silenced: () => false,
      recentFirings: 0,
    };
    const obs = (changedAt: number) => ({
      fingerprint: 'egress-new:x',
      severity: 'warning' as const,
      labels: {},
      details: {},
      changedAt,
    });
    expect(step(ep, obs(T0 - MIN), ctx4h)).toMatchObject({ notify: null });
    expect(step(ep, obs(T0 + 3 * HOUR), ctx4h)).toMatchObject({ notify: 'renotify' });
    // Not before the interval, even with a new name.
    expect(step(ep, obs(T0 + HOUR), { ...ctx4h, now: T0 + 2 * HOUR })).toMatchObject({
      notify: null,
    });
    const words = alertText({
      ruleKey: NEW,
      ruleName: 'New external destination',
      labels: { namespace: 'shop', workload_kind: 'Deployment', workload: 'updater' },
      details: {
        destination: 'f.example.net',
        port: 443,
        firstSeen: new Date(T0).toISOString(),
        count: 24,
        added: [
          'f.example.net:443',
          'e.example.net:443',
          'd.example.net:443',
          'c.example.net:443',
          'b.example.net:443',
          'a.example.net:443',
        ],
      },
      cluster: { name: 'prod' },
      now: T0,
    });
    expect(words.title).toBe('updater started talking to 24 new destinations');
    expect(words.why).toBe(
      'newest f.example.net:443 at 08:00 UTC · new since the last message: f.example.net:443, e.example.net:443, d.example.net:443, c.example.net:443, b.example.net:443 and 1 more',
    );
  });

  it('the upgrade folds the open per-destination alerts into one per source', async () => {
    await setup('kubernetes');
    await cycle(T0); // the default rules
    const rule = await ctx.db
      .selectFrom('alert_rules')
      .select('id')
      .where('org_id', '=', orgId)
      .where('rule_key', '=', NEW)
      .executeTakeFirstOrThrow();
    const open = (fp: string, started: number, state = 'firing') =>
      ctx.db
        .insertInto('alert_states')
        .values({
          id: newId(),
          org_id: orgId,
          rule_id: rule.id,
          cluster_id: clusterId,
          fingerprint: fp,
          state,
          severity: 'warning',
          labels: JSON.stringify({}),
          details: JSON.stringify({}),
          started_at: new Date(started),
          fired_at: new Date(started),
          resolved_at: state === 'resolved' ? new Date(started + HOUR) : null,
        })
        .execute();
    await open('egress:shop/Deployment/updater>m-1.example.net:443', T0 - 3 * HOUR);
    await open('egress:shop/Deployment/updater>m-2.example.net:443', T0 - 2 * HOUR);
    await open('egress:shop/Deployment/updater>m-3.example.net:443', T0 - HOUR);
    await open('egress:shop/api>x.example.net:443', T0 - HOUR);
    await open('egress:shop/Deployment/updater>old.example.net:443', T0 - 5 * DAY, 'resolved');
    await sql
      .raw(
        readFileSync(
          new URL(
            '../migrations/1797200000000_egress-new-destination-per-source.sql',
            import.meta.url,
          ),
          'utf8',
        ).replace('-- Up Migration', ''),
      )
      .execute(ctx.db);
    const rows = await ctx.db
      .selectFrom('alert_states')
      .select(['fingerprint', 'state', 'started_at'])
      .where('rule_id', '=', rule.id)
      .orderBy('state')
      .orderBy('fingerprint')
      .execute();
    expect(rows.map((r) => [r.state, r.fingerprint])).toEqual([
      ['firing', 'egress-new:shop/Deployment/updater'],
      ['firing', 'egress-new:shop/api'],
      ['resolved', 'egress:shop/Deployment/updater>m-2.example.net:443'],
      ['resolved', 'egress:shop/Deployment/updater>m-3.example.net:443'],
      ['resolved', 'egress:shop/Deployment/updater>old.example.net:443'],
    ]);
    // The oldest is the one kept.
    expect(new Date(rows[0]!.started_at).getTime()).toBe(T0 - 3 * HOUR);
  });
});

// ------------------------------------------------------------------------------ raw IP

describe('Raw IP egress', () => {
  it('Kubernetes: 5 connections in 10 minutes to a public raw network fire, 4 don’t, private never; below the threshold it resolves', async () => {
    await setup('kubernetes');
    vm.raw = [
      series(kubeSeries('orders', '1.1.1.0/24', '443'), 4),
      series(kubeSeries('orders', '10.244.1.0/24', '5432'), 667),
      series(kubeSeries('orders', 'example.org', '443'), 50),
    ];
    await cycle(T0);
    expect(await alerts(RAW)).toEqual([]);
    // Summed across nodes: 3 on one, 2 on another.
    vm.raw = [
      series(kubeSeries('orders', '1.1.1.0/24', '443', { node: 'a' }), 3),
      series(kubeSeries('orders', '1.1.1.0/24', '443', { node: 'b' }), 2),
    ];
    await cycle(T0 + MIN);
    const [a] = await alerts(RAW);
    expect(a).toMatchObject({
      state: 'firing',
      fingerprint: 'egress:shop/Deployment/orders>1.1.1.0/24:443',
      details: { connections: 5, threshold: 4, class: 'public_network' },
    });
    expect(text(a!, RAW)).toEqual({
      title: 'orders connects to 1.1.1.0/24:443 by IP address',
      why: '5 connections in 10 min · no DNS name behind it',
      code: ['1.1.1.0/24:443'],
    });
    // The query counts 10 minutes and keeps the largest count of the last 10 minutes.
    expect(vm.queries.at(-2)).toContain('[10m:1m]');
    expect(vm.queries.at(-2)).toContain(
      'increase(watchlog_flow_connections_total{dst_kind="external"}[10m])',
    );
    vm.raw = [];
    await cycles(T0 + 12 * MIN);
    expect((await alerts(RAW)).map((x) => x.state)).toEqual(['resolved']);
  });

  it('fires during the learning period, and for an expected name’s raw network too', async () => {
    await setup('kubernetes', { firstSeenAt: T0 - HOUR });
    await seen(ORDERS, '1.1.1.0/24', 443, T0 - HOUR, { pattern: '1.0.0.0/8' });
    vm.raw = [series(kubeSeries('orders', '1.1.1.0/24', '443'), 9)];
    await cycle(T0);
    expect(await firing(RAW)).toHaveLength(1);
    expect(await alerts(NEW)).toEqual([]);
  });

  it('Docker: a Compose service’s replicas add up; a plain container on its host', async () => {
    await setup('server');
    vm.raw = [
      series(dockerSeries('shop-api-1', '2606:4700:4700::/48', '443', ['shop', 'api']), 3),
      series(dockerSeries('shop-api-2', '2606:4700:4700::/48', '443', ['shop', 'api']), 2),
      series(dockerSeries('redis', '8.8.8.0/24', '53'), 6),
      series(dockerSeries('redis', '172.19.0.0/24', '6379'), 342),
    ];
    await cycle(T0);
    const list = await alerts(RAW);
    expect(
      list.map((a) => [a.fingerprint, (a.details as { connections: number }).connections]),
    ).toEqual([
      ['egress:docker-01/redis>8.8.8.0/24:53', 6],
      ['egress:shop/api>2606:4700:4700::/48:443', 5],
    ]);
    expect(text(list[0]!, RAW).title).toBe('redis connects to 8.8.8.0/24:53 by IP address');
  });
});

// ------------------------------------------------------------------------------ large upload

describe('Large upload to a new destination', () => {
  const MiB = 2 ** 20;

  it('Kubernetes: 120 MiB in an hour to a destination first seen today fires; to an old one, or 90 MiB, doesn’t', async () => {
    await setup('kubernetes');
    await seen(ORDERS, 'upload.example.org', 443, T0 - 2 * HOUR, { lastSeen: T0 });
    await seen(ORDERS, 'backup.example.org', 443, T0 - 3 * DAY, { lastSeen: T0 });
    await seen(ORDERS, 'small.example.org', 443, T0 - HOUR, { lastSeen: T0 });
    vm.sent = [
      series(kubeSeries('orders', 'upload.example.org', '443', { node: 'a' }), 100 * MiB),
      series(kubeSeries('orders', 'upload.example.org', '443', { node: 'b' }), 20 * MiB),
      series(kubeSeries('orders', 'backup.example.org', '443'), 900 * MiB),
      series(kubeSeries('orders', 'small.example.org', '443'), 90 * MiB),
    ];
    await cycle(T0);
    const list = await alerts(UPLOAD);
    expect(list.map((a) => a.fingerprint)).toEqual([
      'egress:shop/Deployment/orders>upload.example.org:443',
    ]);
    expect(list[0]!.details).toMatchObject({ sentBytes: 120 * MiB, threshold: LARGE_UPLOAD_BYTES });
    expect(text(list[0]!, UPLOAD)).toEqual({
      title: 'orders sent 120 MiB to upload.example.org:443',
      why: 'in the last hour · threshold 100 MiB · first seen at 06:00 UTC',
      code: ['upload.example.org:443'],
    });
    expect(vm.queries.at(-1)).toContain(
      'watchlog_flow_bytes_total{dst_kind="external", dir="sent"}[1h]',
    );
    // Past 24 hours since first seen, an open alert stays while the hour's total is past it.
    await cycle(T0 + 23 * HOUR);
    expect(await firing(UPLOAD)).toHaveLength(1);
    vm.sent = [];
    await cycles(T0 + 24 * HOUR);
    expect((await alerts(UPLOAD)).map((a) => a.state)).toEqual(['resolved']);
  });

  it('waits for the first-seen look-back, so an upgrade’s destinations in use don’t look new', async () => {
    await setup('kubernetes', { backfilled: false });
    await seen(ORDERS, 'upload.example.org', 443, T0 - MIN);
    vm.sent = [series(kubeSeries('orders', 'upload.example.org', '443'), 500 * MiB)];
    await cycle(T0);
    expect(await alerts(UPLOAD)).toEqual([]);
  });

  it('an expected destination still fires; private networks never', async () => {
    await setup('kubernetes');
    await seen(ORDERS, 'upload.example.org', 443, T0 - HOUR, { pattern: '*.example.org' });
    await seen(ORDERS, '10.0.0.0/24', 9000, T0 - HOUR);
    vm.sent = [
      series(kubeSeries('orders', 'upload.example.org', '443'), 200 * MiB),
      series(kubeSeries('orders', '10.0.0.0/24', '9000'), 900 * MiB),
    ];
    await cycle(T0);
    expect(await firing(UPLOAD)).toEqual(['egress:shop/Deployment/orders>upload.example.org:443']);
  });

  it('Docker: a Compose service’s upload, folded across its containers', async () => {
    await setup('server');
    await seen(API, 'upload.example.org', 443, T0 - HOUR);
    vm.sent = [
      series(dockerSeries('shop-api-1', 'upload.example.org', '443', ['shop', 'api']), 60 * MiB),
      series(dockerSeries('shop-api-2', 'upload.example.org', '443', ['shop', 'api']), 60 * MiB),
    ];
    await cycle(T0);
    const [a] = await alerts(UPLOAD);
    expect(a!.labels).toEqual({
      compose_project: 'shop',
      compose_service: 'api',
      destination: 'upload.example.org',
      port: '443',
    });
    expect(text(a!, UPLOAD).title).toBe('shop/api sent 120 MiB to upload.example.org:443');
  });
});

// ------------------------------------------------------------------------------ real PromQL

describe('against a real VictoriaMetrics (slice 1’s shapes)', () => {
  const RUN = `egress-rules-${Date.now()}`;
  const SCRAPE = 15_000;
  const real = new VictoriaQueryClient(TEST_VM_URL);
  const A = Math.floor((Date.now() - 2 * HOUR) / SCRAPE) * SCRAPE;

  afterAll(async () => {
    await fetch(
      `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
      { method: 'POST' },
    );
  });

  function samples(name: string, labels: Record<string, string>, v: (s: number) => number) {
    const out: TestSeries[] = [];
    for (let t = 0; t < 12 * MIN; t += SCRAPE)
      out.push({
        labels: { __name__: name, run: RUN, ...labels },
        value: v(t / 1000),
        timestampMs: A + t,
      });
    return out;
  }

  it.each(['kubernetes', 'server'] as const)(
    '%s: 5 connects to 1.1.1.1:443 fire Raw IP; a 120 MiB upload to a new name fires Large upload',
    async (k) => {
      await setup(k);
      const src = k === 'kubernetes' ? ORDERS : API;
      const labels = (dst: string) =>
        k === 'kubernetes'
          ? kubeSeries('orders', dst, '443', { node: 'n1' })
          : dockerSeries('shop-api-1', dst, '443', ['shop', 'api']);
      await real.write(
        authorisedScope(clusterId),
        encode([
          // One connect every 15 s from the first sample (whose 1 counts), 5 in all.
          ...samples('watchlog_flow_connections_total', labels('1.1.1.0/24'), (s) =>
            Math.min(5, 1 + Math.floor(s / 15)),
          ),
          ...samples(
            'watchlog_flow_bytes_total',
            { ...labels('upload.example.org'), dir: 'sent' },
            (s) => Math.min(120 * 2 ** 20, Math.round((s / 600) * 120 * 2 ** 20)),
          ),
        ]),
      );
      await fetch(`${TEST_VM_URL}/internal/force_flush`);
      await seen(src, 'upload.example.org', 443, A);
      await worker.stop();
      worker = testWorker(ctx.db, clock, lookupEvaluator, {
        prepareOrg: (id) => ensureDefaultRules(ctx.db, id),
        victoria: real,
      });
      await cycle(A + 3 * MIN);
      const raw = await alerts(RAW);
      expect(raw.map((a) => [a.state, (a.details as { connections: number }).connections])).toEqual(
        [['firing', 5]],
      );
      await cycle(A + 11 * MIN);
      const up = await alerts(UPLOAD);
      expect(up.map((a) => [a.state, a.fingerprint])).toEqual([
        [
          'firing',
          `egress:${k === 'kubernetes' ? 'shop/Deployment/orders' : 'shop/api'}>upload.example.org:443`,
        ],
      ]);
      expect((up[0]!.details as { sentBytes: number }).sentBytes).toBe(125_829_120);
    },
  );
});

// ------------------------------------------------------------------------------ upgrade, Cloud

describe('the rules arrive with no manual step (ADR-107)', () => {
  it('an install with the older defaults gets the three, enabled, warning, with their thresholds; edits stay', async () => {
    await setup('kubernetes');
    await ensureDefaultRules(ctx.db, orgId, STATE_RULES);
    await ctx.db
      .updateTable('alert_rules')
      .set({ enabled: false })
      .where('org_id', '=', orgId)
      .where('rule_key', '=', 'k8s.pod.pending')
      .execute();
    // The worker's next cycle adds what this version has.
    await cycle(T0);
    const rules = await ctx.db
      .selectFrom('alert_rules')
      .select(['rule_key', 'enabled', 'severity', 'condition', 'for_seconds', 'name'])
      .where('org_id', '=', orgId)
      .execute();
    expect(rules).toHaveLength(DEFAULT_RULES.length);
    const egress = rules
      .filter((r) => r.rule_key?.startsWith('egress.'))
      .sort((a, b) => a.rule_key!.localeCompare(b.rule_key!));
    expect(egress).toEqual([
      {
        rule_key: UPLOAD,
        enabled: true,
        severity: 'warning',
        condition: { op: '>', value: 104_857_600 },
        for_seconds: 0,
        name: 'Large upload to a new destination',
      },
      {
        rule_key: NEW,
        enabled: true,
        severity: 'warning',
        condition: {},
        for_seconds: 0,
        name: 'New external destination',
      },
      {
        rule_key: RAW,
        enabled: true,
        severity: 'warning',
        condition: { op: '>', value: 4 },
        for_seconds: 0,
        name: 'Raw IP egress',
      },
    ]);
    expect(rules.find((r) => r.rule_key === 'k8s.pod.pending')!.enabled).toBe(false);
    expect(EGRESS_RULES.map((r) => r.evaluator.kinds)).toEqual([
      ['kubernetes', 'server'],
      ['kubernetes', 'server'],
      ['kubernetes', 'server'],
    ]);
  });

  it('a raw IP threshold changed by the user is the one used', async () => {
    await setup('server');
    await cycle(T0);
    await ctx.db
      .updateTable('alert_rules')
      .set({ condition: JSON.stringify({ op: '>', value: 10 }) })
      .where('org_id', '=', orgId)
      .where('rule_key', '=', RAW)
      .execute();
    vm.raw = [series(dockerSeries('redis', '8.8.8.0/24', '53'), 6)];
    await cycle(T0 + MIN);
    expect(await alerts(RAW)).toEqual([]);
  });
});

describe('Cloud: each org’s rules and alerts as watchlog_app, under Row-Level Security', () => {
  let appDb: Database;
  beforeAll(async () => {
    await ensureAppRole(inject('databaseUrl'));
    appDb = createDb(appUrlOf(inject('databaseUrl')), { orgScoped: true });
  });
  afterAll(async () => {
    await appDb.destroy();
  });

  it('two orgs: the defaults are added inside each org; each gets its own alert and sees no other', async () => {
    await setup('kubernetes');
    const a = { orgId, clusterId };
    await seen(ORDERS, 'alpha.example.org', 443, T0);
    await setup('server');
    const b = { orgId, clusterId };
    await seen(API, 'beta.example.org', 443, T0);
    await sql`DELETE FROM alert_rules`.execute(ctx.db);
    await worker.stop();
    worker = testWorker(appDb, clock, lookupEvaluator, {
      systemDb: ctx.db,
      prepareOrg: (id) => ensureDefaultRules(appDb, id),
      victoria: vm as unknown as VictoriaQueryClient,
    });
    await cycle(T0 + MIN);
    const rows = await ctx.db
      .selectFrom('alert_states as s')
      .innerJoin('alert_rules as r', 'r.id', 's.rule_id')
      .select(['s.org_id', 's.cluster_id', 's.fingerprint', 'r.org_id as rule_org'])
      .where('r.rule_key', '=', NEW)
      .orderBy('s.fingerprint')
      .execute();
    expect(rows).toEqual([
      {
        org_id: a.orgId,
        cluster_id: a.clusterId,
        fingerprint: 'egress-new:shop/Deployment/orders',
        rule_org: a.orgId,
      },
      {
        org_id: b.orgId,
        cluster_id: b.clusterId,
        fingerprint: 'egress-new:shop/api',
        rule_org: b.orgId,
      },
    ]);
    for (const o of [a.orgId, b.orgId]) {
      const n = await ctx.db
        .selectFrom('alert_rules')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('org_id', '=', o)
        .where('rule_key', 'like', 'egress.%')
        .executeTakeFirstOrThrow();
      expect(Number(n.n)).toBe(3);
    }
    // Without an org setting, watchlog_app sees no inventory and no alert.
    const seenByApp = await appDb
      .selectFrom('egress_destinations')
      .select('id')
      .execute()
      .catch(() => []);
    expect(seenByApp).toEqual([]);
  });
});
