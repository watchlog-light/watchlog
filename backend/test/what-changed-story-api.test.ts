// SPDX-License-Identifier: AGPL-3.0-only
// What changed after the learning week (0.14.0, ADR-231), through the API: the story of an
// episode with a linked rollout (Kubernetes) and a scheduled run (a Server fleet), no clear
// cause, the episode switcher, WatchLog's own parts left out by default, the live map's states
// and the quiet page's last 7 days. On an injected clock, with generated rows.
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { newId } from '../src/lib/ids.js';
import { seriesHash } from '../src/modules/anomaly/keys.js';
import { toStored } from '../src/modules/anomaly/live.js';
import type { CausesAnswer } from '../src/modules/causes/engine.js';
import { CausesService } from '../src/modules/causes/likely.js';
import { insertCluster } from '../src/modules/clusters/service.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / MIN) * MIN;
const nowS = Math.floor(NOW / 1000);

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

/** Probable cause, faked: `likely` or no clear cause, with two checks that found something. */
function causesWith(state: 'likely' | 'none') {
  return new CausesService({
    explainFn: async (_r, _c, subject) =>
      ({
        subject: { kind: subject.kind, ref: 'x', name: 'x' },
        state,
        headline: { code: state === 'likely' ? 'bad_change' : 'no_clear_cause', facts: {} },
        causes:
          state === 'likely'
            ? [{ strength: 'likely', rule: 'bad_change', code: 'rollout', facts: {}, since: null }]
            : [],
        checks: [
          {
            topic: 'changes',
            code: 'rollout_before',
            facts: { target: 'backend' },
            result: state === 'likely' ? 'explains' : 'possible',
          },
          { topic: 'node', code: 'node_ok', facts: {}, result: 'ok' },
          {
            topic: 'dependencies',
            code: 'dependency_slow',
            facts: { dependency: 'postgres' },
            result: 'possible',
          },
        ],
      }) as unknown as CausesAnswer,
  });
}

const CLOUD: Partial<Config> = {
  edition: 'cloud',
  cookieSecure: 'always',
  accounts: { turnstile: {}, supportEmail: 'support@watchlog.io', sampleUrl: 'https://x' },
};
const offline = (async () => new Response('offline', { status: 599 })) as typeof fetch;

async function proOrg(kind: 'kubernetes' | 'server', causes = causesWith('likely')) {
  ctx = await createTestContext(CLOUD, { fetch: offline, now: () => NOW, causes });
  const c = ctx;
  const res = await c.app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email: `owner-${newId()}@acme.example`, password: 'a long enough password' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const cookie = res.cookies.find((x) => x.name === 'wl_session')!.value;
  const orgId = (
    await c.app.inject({ method: 'GET', url: '/api/v1/me', cookies: { wl_session: cookie } })
  ).json().user.org.id as string;
  await c.app.entitlements!.put(orgId, { plan: 'pro', source: 'staff' });
  const cluster = await insertCluster(
    c.db,
    orgId,
    kind === 'server' ? 'acme-servers' : 'shop-prod',
    kind,
  );
  // Learned: the org since 10 days, a series first seen 9 days ago.
  await c.db
    .insertInto('anomaly_orgs')
    .values({ org_id: orgId, learning_since: new Date(NOW - 10 * DAY), entitled_at: new Date(NOW) })
    .execute();
  await c.db
    .insertInto('anomaly_baselines')
    .values({
      org_id: orgId,
      cluster_id: cluster.id,
      series_hash: seriesHash('learned', { cluster: cluster.id }),
      metric: 'workload.cpu.usage',
      subject: JSON.stringify({ workload: 'x' }),
      medians: Array(168).fill(1),
      mads: Array(168).fill(0.1),
      minutes: Array(168).fill(120),
      first_seen: new Date(NOW - 9 * DAY),
      last_seen: new Date(NOW),
    })
    .execute();
  const get = (path: string, query: Record<string, string>) =>
    c.app.inject({
      method: 'GET',
      url: `/api/v1/what-changed${path}`,
      query: { cluster: cluster.id, ...query },
      cookies: { wl_session: cookie },
    });
  return { c, orgId, clusterId: cluster.id, get };
}

async function period(
  c: TestContext,
  orgId: string,
  clusterId: string,
  p: {
    metric: string;
    subject: Record<string, string>;
    startedAgo: number;
    endedAgo?: number;
    usual: [number, number];
    last: number;
    peak?: number;
  },
) {
  await c.db
    .insertInto('anomaly_periods')
    .values({
      org_id: orgId,
      cluster_id: clusterId,
      series_hash: seriesHash(p.metric, p.subject),
      metric: p.metric,
      subject: JSON.stringify(p.subject),
      started_at: new Date(NOW - p.startedAgo),
      ended_at: p.endedAgo === undefined ? null : new Date(NOW - p.endedAgo),
      bucket: 0,
      median: (p.usual[0] + p.usual[1]) / 2,
      usual_low: p.usual[0],
      usual_high: p.usual[1],
      peak_score: p.peak ?? 10,
      peak_value: p.last,
      peak_at: new Date(NOW - p.startedAgo + MIN),
      last_value: p.last,
      last_at: new Date(NOW - MIN),
    })
    .execute();
}

const backendCpu = {
  metric: 'workload.cpu.usage',
  subject: { namespace: 'shop', workload_kind: 'Deployment', workload: 'backend' },
};
const postgresCpu = {
  metric: 'workload.cpu.usage',
  subject: { namespace: 'shop', workload_kind: 'StatefulSet', workload: 'postgres' },
};

async function pod(
  c: TestContext,
  clusterId: string,
  ns: string,
  name: string,
  workload: string,
  labels: Record<string, string>,
  node = 'k3d-0',
) {
  await c.db
    .insertInto('objects')
    .values({
      id: newId(),
      cluster_id: clusterId,
      kind: 'Pod',
      namespace: ns,
      name,
      node,
      uid: newId(),
      source: 'kubernetes',
      snapshot_id: null,
      deleted_at: null,
      spec_summary: JSON.stringify({ labels, workload: { kind: 'Deployment', name: workload } }),
    })
    .execute();
}

describe('the story (Kubernetes)', () => {
  it('an episode after a rollout: the sentence, the chain, the cause, the checks, what changed around then', async () => {
    const { c, orgId, clusterId, get } = await proOrg('kubernetes');
    await period(c, orgId, clusterId, {
      ...backendCpu,
      startedAgo: 40 * MIN,
      endedAgo: 5 * MIN,
      usual: [0.1, 0.3],
      last: 4.2,
    });
    await period(c, orgId, clusterId, {
      ...postgresCpu,
      startedAgo: 32 * MIN,
      endedAgo: 6 * MIN,
      usual: [0.2, 0.5],
      last: 1.7,
    });
    // backend and postgres share a node: connected.
    await pod(c, clusterId, 'shop', 'backend-1', 'backend', {});
    await pod(c, clusterId, 'shop', 'postgres-0', 'postgres', {});
    await c.db
      .insertInto('change_markers')
      .values([
        {
          id: newId(),
          cluster_id: clusterId,
          kind: 'rollout',
          target: 'Deployment/shop/backend',
          namespace: 'shop',
          ts: new Date(NOW - 42 * MIN),
          details: JSON.stringify({ from: '7', to: '8' }),
        },
        {
          id: newId(),
          cluster_id: clusterId,
          kind: 'scale',
          target: 'Deployment/shop/api',
          namespace: 'shop',
          ts: new Date(NOW - 20 * MIN),
          details: JSON.stringify({ from: 2, to: 4 }),
        },
      ])
      .execute();
    const r = await get('', { from: String(nowS - 3600), to: String(nowS) });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.episodes).toHaveLength(1);
    expect(b.episode).toBe(0);
    expect(b.story.clauses.map((x: { code: string }) => x.code)).toEqual(['after_change', 'then']);
    expect(b.story.clauses[0].facts).toMatchObject({
      who: 'shop/backend',
      x: 14,
      dir: 'up',
      gap: 2,
      change: 'rollout',
      target: 'backend',
    });
    expect(
      b.story.chain.nodes.map(
        (n: { kind: string; who: string; gapMin: number | null; linked: boolean }) => [
          n.kind,
          n.who,
          n.gapMin,
          n.linked,
        ],
      ),
    ).toEqual([
      ['change', 'backend', null, false],
      ['first', 'shop/backend', 2, true],
      ['then', 'shop/postgres', 8, true],
    ]);
    expect(b.story.change).toMatchObject({ kind: 'rollout', name: 'backend', namespace: 'shop' });
    expect(b.story.cause.state).toBe('likely');
    expect(b.cause.likely).not.toBeNull();
    expect(b.story.checks.map((x: { code: string }) => x.code)).toEqual([
      'rollout_before',
      'node_ok',
      'dependency_slow',
    ]);
    // Changed around then: the rollout and the scale, oldest first.
    expect(
      b.story.changes.map((x: { kind: string; name: string }) => `${x.kind} ${x.name}`),
    ).toEqual(['rollout backend', 'scale api']);
    expect(b.story.rows.map((x: { object: { name: string } }) => x.object.name)).toEqual([
      'backend',
      'postgres',
    ]);
  });

  it('no clear cause: no change before it, the engine finds none; two episodes switch', async () => {
    const { c, orgId, clusterId, get } = await proOrg('kubernetes', causesWith('none'));
    await period(c, orgId, clusterId, {
      ...backendCpu,
      startedAgo: 50 * MIN,
      endedAgo: 45 * MIN,
      usual: [0.1, 0.3],
      last: 1,
    });
    await period(c, orgId, clusterId, {
      ...postgresCpu,
      startedAgo: 20 * MIN,
      endedAgo: 10 * MIN,
      usual: [0.2, 0.5],
      last: 2,
    });
    const r = (await get('', { from: String(nowS - 3600), to: String(nowS) })).json();
    expect(r.episodes).toHaveLength(2);
    expect(r.episode).toBe(1); // the newest
    expect(r.story.clauses.map((x: { code: string }) => x.code)).toEqual(['first']);
    expect(r.story.cause).toEqual({ state: 'none', change: null });
    expect(r.story.checks.filter((x: { result: string }) => x.result === 'possible')).toHaveLength(
      2,
    );
    // The switcher: the older one, by its start.
    const from = Math.floor(Date.parse(r.episodes[0].from) / 1000);
    const older = (
      await get('', { from: String(nowS - 3600), to: String(nowS), episode: String(from) })
    ).json();
    expect(older.episode).toBe(0);
    expect(older.story.rows[0].object.name).toBe('backend');
  });

  it('WatchLog’s own parts are left out by default, listed and flagged with own=show', async () => {
    const { c, orgId, clusterId, get } = await proOrg('kubernetes');
    await pod(c, clusterId, 'watchlog', 'watchlog-backend-1', 'watchlog-backend', {
      'app.kubernetes.io/name': 'watchlog',
    });
    await period(c, orgId, clusterId, {
      metric: 'workload.cpu.usage',
      subject: { namespace: 'watchlog', workload_kind: 'Deployment', workload: 'watchlog-backend' },
      startedAgo: 30 * MIN,
      usual: [0.1, 0.3],
      last: 2,
    });
    // WatchLog's own update is one of its changes: hidden with its series.
    await c.db
      .insertInto('change_markers')
      .values({
        id: newId(),
        cluster_id: clusterId,
        kind: 'rollout',
        target: 'Deployment/watchlog/watchlog-backend',
        namespace: 'watchlog',
        ts: new Date(NOW - 35 * MIN),
        details: JSON.stringify({ from: '3', to: '4' }),
      })
      .execute();
    const hidden = (await get('', { from: String(nowS - 3600), to: String(nowS) })).json();
    expect(hidden.own).toBe('hide');
    expect(hidden.changes).toEqual([]);
    expect(hidden.rows).toEqual([]);
    expect(hidden.episodes).toEqual([]);
    expect(hidden.story).toBeNull();
    const shown = (
      await get('', { from: String(nowS - 3600), to: String(nowS), own: 'show' })
    ).json();
    expect(shown.rows).toHaveLength(1);
    expect(shown.rows[0].own).toBe(true);
    expect(shown.episodes).toHaveLength(1);
    expect(shown.changes.map((x: { name: string }) => x.name)).toEqual(['watchlog-backend']);
    expect(shown.story.changes.map((x: { name: string }) => x.name)).toEqual(['watchlog-backend']);
  });
});

describe('the story (Server fleet)', () => {
  it('a scheduled run on the server is the linked change; names in the fleet’s words', async () => {
    const { c, orgId, clusterId, get } = await proOrg('server', causesWith('none'));
    await period(c, orgId, clusterId, {
      metric: 'host.disk.io_wait',
      subject: { host: 'db-1' },
      startedAgo: 40 * MIN,
      endedAgo: 4 * MIN,
      usual: [0.01, 0.04],
      last: 0.36,
    });
    await period(c, orgId, clusterId, {
      metric: 'unit.cpu.usage',
      subject: { host: 'db-1', unit: 'postgresql.service' },
      startedAgo: 38 * MIN,
      endedAgo: 4 * MIN,
      usual: [0.05, 0.1],
      last: 1.2,
    });
    await c.db
      .insertInto('scheduled_jobs')
      .values({
        cluster_id: clusterId,
        node: 'db-1',
        job_id: 'b'.repeat(16),
        kind: 'timer',
        name: 'backup.timer',
        enabled: true,
        state: 'working',
        frequent: false,
      })
      .execute();
    await c.db
      .insertInto('job_runs')
      .values({
        cluster_id: clusterId,
        node: 'db-1',
        job_id: 'b'.repeat(16),
        started_at: new Date(NOW - 42 * MIN),
        ended_at: new Date(NOW - 4 * MIN),
        code: 0,
        result: 'success',
      })
      .execute();
    const b = (await get('', { from: String(nowS - 3600), to: String(nowS) })).json();
    expect(b.story.change).toMatchObject({ kind: 'job_run', name: 'backup.timer', host: 'db-1' });
    expect(b.story.cause.state).toBe('change');
    expect(b.story.cause.change).toMatchObject({
      code: 'change',
      facts: { change: 'job_run', target: 'backup.timer', gap: 2, who: 'db-1' },
    });
    expect(b.story.chain.nodes.map((n: { who: string }) => n.who)).toEqual([
      'backup.timer',
      'db-1',
      'postgresql.service · db-1',
    ]);
    expect(b.story.chain.linked).toBe(true); // same server
  });
});

describe('the live map', () => {
  it('every scored series with its state and the own-parts flag; the learning count', async () => {
    const { c, orgId, clusterId, get } = await proOrg('kubernetes');
    await pod(c, clusterId, 'watchlog', 'watchlog-agent-x', 'watchlog-agent', {
      'helm.sh/chart': 'watchlog-agent-0.2.0',
    });
    const e = (subject: Record<string, string>, score: number, open: boolean) =>
      toStored({ key: 'workload.cpu.usage', subject, value: 1, low: 0.1, high: 0.5, score, open });
    await c.db
      .insertInto('anomaly_live')
      .values({
        org_id: orgId,
        cluster_id: clusterId,
        scored_at: new Date(NOW - 12_000),
        learning: 26,
        series: JSON.stringify([
          e(backendCpu.subject, 9, true),
          e(postgresCpu.subject, 2.6, false),
          e({ namespace: 'shop', workload_kind: 'Deployment', workload: 'api' }, 0.4, false),
          e(
            { namespace: 'watchlog', workload_kind: 'DaemonSet', workload: 'watchlog-agent' },
            1,
            false,
          ),
        ]),
      })
      .execute();
    const r = await get('/live', {});
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.scoredAt).toBe(new Date(NOW - 12_000).toISOString());
    expect(b.learning).toBe(26);
    expect(
      b.series.map(
        (s: { object: { name: string }; state: string; shade: number; own: boolean }) => [
          s.object.name,
          s.state,
          s.shade,
          s.own,
        ],
      ),
    ).toEqual([
      ['backend', 'outside', 2, false],
      ['postgres', 'near', 1, false],
      ['api', 'inside', 0, false],
      ['watchlog-agent', 'inside', 1, true],
    ]);
  });

  it('a monitored application by its name, not its id (here and on the quiet page)', async () => {
    const { c, orgId, clusterId, get } = await proOrg('kubernetes');
    const id = newId();
    await c.db
      .insertInto('integrations')
      .values({
        id,
        org_id: orgId,
        cluster_id: clusterId,
        type: 'postgres',
        name: 'orders-db',
        target: JSON.stringify({ kind: 'address', port: 5432 }),
      })
      .execute();
    const subject = { service: id, service_type: 'postgres' };
    await c.db
      .insertInto('anomaly_live')
      .values({
        org_id: orgId,
        cluster_id: clusterId,
        scored_at: new Date(NOW - 12_000),
        learning: 0,
        series: JSON.stringify([
          toStored({
            key: 'postgres.connections',
            subject,
            value: 9,
            low: 1,
            high: 4,
            score: 1,
            open: false,
          }),
        ]),
      })
      .execute();
    const live = (await get('/live', {})).json();
    expect(live.series[0].object).toMatchObject({ kind: 'service', name: 'orders-db', id });
    await period(c, orgId, clusterId, {
      metric: 'postgres.connections',
      subject,
      startedAgo: DAY,
      endedAgo: DAY - 20 * MIN,
      usual: [1, 4],
      last: 9,
    });
    const recent = (await get('/recent', {})).json();
    expect(recent.episodes[0].clauses[0].facts.who).toBe('orders-db');
  });

  it('before the worker’s first minute: nothing scored yet', async () => {
    const { get } = await proOrg('server');
    expect((await get('/live', {})).json()).toEqual({ scoredAt: null, learning: 0, series: [] });
  });
});

describe('the quiet page', () => {
  it('the last 7 days’ episodes in brief, newest first; none: an empty list', async () => {
    const { c, orgId, clusterId, get } = await proOrg('kubernetes');
    expect((await get('/recent', {})).json()).toEqual({ episodes: [] });
    await period(c, orgId, clusterId, {
      ...backendCpu,
      startedAgo: 3 * DAY,
      endedAgo: 3 * DAY - 20 * MIN,
      usual: [0.1, 0.3],
      last: 1,
    });
    await period(c, orgId, clusterId, {
      ...postgresCpu,
      startedAgo: DAY,
      endedAgo: DAY - 10 * MIN,
      usual: [0.2, 0.5],
      last: 2,
    });
    await period(c, orgId, clusterId, {
      ...postgresCpu,
      startedAgo: 9 * DAY,
      endedAgo: 9 * DAY - 10 * MIN,
      usual: [0.2, 0.5],
      last: 2,
    });
    const b = (await get('/recent', {})).json();
    expect(
      b.episodes.map((e: { clauses: { facts: { who: string } }[] }) => e.clauses[0]!.facts.who),
    ).toEqual(['shop/postgres', 'shop/backend']);
    expect(b.episodes[0].cause).toBeNull();
  });
});
