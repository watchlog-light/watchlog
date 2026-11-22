// SPDX-License-Identifier: AGPL-3.0-only
// GET /api/v1/overview/all (ADR-226): "All clusters and fleets". The gate (Pro 200, Free 403
// `pro-feature`, Community 404, the demo's org), both kinds and the three server sources in
// the problems, the table and the merge rule, What changed across clusters, housekeeping, the
// kind filter, another org's clusters never shown, and 50 clusters and fleets within 300 ms.
// The clock is injected; metrics are generated series written to the test VictoriaMetrics.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { newId } from '../src/lib/ids.js';
import { authorisedScope, VictoriaQueryClient } from '../src/lib/victoria.js';
import { insertCluster } from '../src/modules/clusters/service.js';
import { seriesHash } from '../src/modules/anomaly/keys.js';
import { ensureDemoUser } from '../src/modules/demo/service.js';
import {
  closeTestContext,
  createTestContext,
  setupAdmin,
  TEST_VM_URL,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / MIN) * MIN;
const RUN = `allc-${NOW}`;
const VERSION = '0.11.0';

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});
afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
});

const CLOUD: Partial<Config> = {
  edition: 'cloud',
  cookieSecure: 'always',
  version: VERSION,
  accounts: { turnstile: {}, supportEmail: 'support@watchlog.io', sampleUrl: 'https://x' },
};
const offline = (async () => new Response('offline', { status: 599 })) as typeof fetch;

async function signup(c: TestContext) {
  const res = await c.app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email: `owner-${newId()}@acme.example`, password: 'a long enough password' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const cookie = res.cookies.find((x) => x.name === 'wl_session')!.value;
  const me = await c.app.inject({
    method: 'GET',
    url: '/api/v1/me',
    cookies: { wl_session: cookie },
  });
  return { cookie, orgId: me.json().user.org.id as string };
}

/** A Cloud org signed up through the API, made Pro unless `free`. */
async function cloudOrg(free = false) {
  ctx = await createTestContext(CLOUD, { fetch: offline, now: () => NOW });
  const c = ctx;
  const { cookie, orgId } = await signup(c);
  if (!free) await c.app.entitlements!.put(orgId, { plan: 'pro', source: 'staff' });
  return { c, cookie, orgId };
}

const get = (c: TestContext, cookie: string, query: Record<string, string> = {}) =>
  c.app.inject({
    method: 'GET',
    url: '/api/v1/overview/all',
    query,
    cookies: { wl_session: cookie },
  });

async function rule(
  c: TestContext,
  orgId: string,
  ruleKey: string,
  over: Record<string, unknown> = {},
) {
  const id = newId();
  await c.db
    .insertInto('alert_rules')
    .values({
      id,
      org_id: orgId,
      name: ruleKey,
      type: 'default',
      rule_key: ruleKey,
      default_key: ruleKey,
      severity: 'warning',
      ...over,
    })
    .execute();
  return id;
}

async function firing(
  c: TestContext,
  orgId: string,
  clusterId: string,
  ruleId: string,
  labels: Record<string, string>,
  startedMinAgo: number,
  severity: 'critical' | 'warning' = 'warning',
) {
  const id = newId();
  await c.db
    .insertInto('alert_states')
    .values({
      id,
      org_id: orgId,
      rule_id: ruleId,
      cluster_id: clusterId,
      fingerprint: `fp-${id}`,
      state: 'firing',
      severity,
      labels: JSON.stringify(labels),
      details: JSON.stringify({}),
      started_at: new Date(NOW - startedMinAgo * MIN),
      fired_at: new Date(NOW - startedMinAgo * MIN),
    })
    .execute();
  return id;
}

async function agent(
  c: TestContext,
  clusterId: string,
  node: string,
  over: {
    mode?: string;
    version?: string;
    seenMinAgo?: number;
    caps?: Record<string, unknown>;
  } = {},
) {
  await c.db
    .insertInto('agent_instances')
    .values({
      id: newId(),
      cluster_id: clusterId,
      node,
      mode: over.mode ?? 'node',
      agent_version: over.version ?? VERSION,
      capabilities: JSON.stringify(over.caps ?? { ebpf: 'enabled' }),
      last_seen_at: new Date(NOW - (over.seenMinAgo ?? 0) * MIN),
    })
    .execute();
}

/** What changed has learned this cluster (as the What changed tests set it up). */
async function learned(c: TestContext, orgId: string, clusterId: string) {
  await c.db
    .insertInto('anomaly_orgs')
    .values({ org_id: orgId, learning_since: new Date(NOW - 10 * DAY), entitled_at: new Date(NOW) })
    .onConflict((oc) => oc.column('org_id').doNothing())
    .execute();
  await c.db
    .insertInto('anomaly_baselines')
    .values({
      org_id: orgId,
      cluster_id: clusterId,
      series_hash: seriesHash('learned', { cluster: clusterId }),
      metric: 'workload.cpu.usage',
      subject: JSON.stringify({ workload: 'x' }),
      medians: Array(168).fill(1),
      mads: Array(168).fill(0.1),
      minutes: Array(168).fill(120),
      first_seen: new Date(NOW - 9 * DAY),
      last_seen: new Date(NOW),
    })
    .execute();
}

async function period(
  c: TestContext,
  orgId: string,
  clusterId: string,
  metric: string,
  subject: Record<string, string>,
  peak: number,
  startedMinAgo = 30,
) {
  await c.db
    .insertInto('anomaly_periods')
    .values({
      org_id: orgId,
      cluster_id: clusterId,
      series_hash: seriesHash(metric, subject),
      metric,
      subject: JSON.stringify(subject),
      started_at: new Date(NOW - startedMinAgo * MIN),
      ended_at: null,
      bucket: 0,
      median: 1,
      usual_low: 0.5,
      usual_high: 1.5,
      peak_score: peak,
      peak_value: 5,
      peak_at: new Date(NOW - (startedMinAgo - 2) * MIN),
      last_value: 4,
      last_at: new Date(NOW - MIN),
    })
    .execute();
}

/**
 * CPU and memory of a cluster's hosts as the agents send them: `busy` of each core's seconds
 * not idle, `used` of the memory, every 5 minutes over the last `hours`.
 */
function hostSeries(
  clusterId: string,
  hosts: string[],
  label: 'node' | 'host',
  busy: number,
  used: number,
  hours = 1,
): TestSeries[] {
  const out: TestSeries[] = [];
  const total = 8 * 2 ** 30;
  for (const h of hosts) {
    for (let t = NOW - hours * 3_600_000; t <= NOW; t += 5 * MIN) {
      const secs = (t - (NOW - hours * 3_600_000)) / 1000;
      const base = { run: RUN, cluster: clusterId, [label]: h };
      out.push(
        {
          labels: { __name__: 'watchlog_node_cpu_seconds_total', ...base, mode: 'user' },
          value: secs * busy,
          timestampMs: t,
        },
        {
          labels: { __name__: 'watchlog_node_cpu_seconds_total', ...base, mode: 'idle' },
          value: secs * (1 - busy),
          timestampMs: t,
        },
        {
          labels: { __name__: 'watchlog_node_memory_bytes', ...base, state: 'total' },
          value: total,
          timestampMs: t,
        },
        {
          labels: { __name__: 'watchlog_node_memory_bytes', ...base, state: 'available' },
          value: total * (1 - used),
          timestampMs: t,
        },
      );
    }
  }
  return out;
}

const vm = new VictoriaQueryClient(TEST_VM_URL);
async function write(clusterId: string, series: TestSeries[]) {
  for (let i = 0; i < series.length; i += 5000)
    await vm.write(authorisedScope(clusterId), encode(series.slice(i, i + 5000)));
}
async function flush() {
  await fetch(`${TEST_VM_URL}/internal/force_flush`);
}

describe('the gate', () => {
  it('Community answers 404, as if the route were not there', async () => {
    ctx = await createTestContext({ version: VERSION });
    const cookie = await setupAdmin(ctx.app);
    const res = await get(ctx, cookie);
    expect(res.statusCode).toBe(404);
  });

  it("Cloud Free answers 403 `pro-feature` and nothing of the org's", async () => {
    const { c, cookie, orgId } = await cloudOrg(true);
    await insertCluster(c.db, orgId, 'shop-servers', 'server');
    const res = await get(c, cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toMatch(/pro-feature/);
    expect(res.body).not.toContain('shop-servers');
  });

  it("the live demo's org has it, within 24 hours", async () => {
    ctx = await createTestContext({ version: VERSION, demoMode: true }, { now: () => NOW });
    await ensureDemoUser(ctx.db);
    const demoOrg = (await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow()).id;
    await insertCluster(ctx.db, demoOrg, 'sample-cluster', 'kubernetes');
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/demo/session' });
    const cookie = login.cookies.find((x) => x.name === 'wl_session')!.value;
    const res = await get(ctx, cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().ranges).toEqual([3600, 21_600, 86_400]);
    // A visitor can't add a channel: "sends alerts nowhere" is left out (ADR-229).
    expect(res.json().clusters.map((x: { name: string }) => x.name)).toEqual(['sample-cluster']);
    expect(res.json().housekeeping.noChannel).toEqual([]);
    const week = await get(ctx, cookie, { range: '604800' });
    expect(week.statusCode).toBe(400);
  });
});

describe('Pro: every cluster and fleet', () => {
  it('both kinds, the three server sources, merged rows, the table, What changed, housekeeping', async () => {
    const { c, cookie, orgId } = await cloudOrg();
    const prod = await insertCluster(c.db, orgId, 'acme-prod', 'kubernetes');
    const staging = await insertCluster(c.db, orgId, 'acme-staging', 'kubernetes');
    const edge = await insertCluster(c.db, orgId, 'eu-edge', 'kubernetes');
    const office = await insertCluster(c.db, orgId, 'office-tools', 'server');
    const db = await insertCluster(c.db, orgId, 'db-servers', 'server');
    const shop = await insertCluster(c.db, orgId, 'shop-servers', 'server');

    // Agents: prod 3 nodes; staging 2; edge 1 with eBPF off; office 2 servers, one silent;
    // db 1; shop 2 on an older agent.
    for (const n of ['p1', 'p2', 'p3']) await agent(c, prod.id, n);
    for (const n of ['s1', 's2']) await agent(c, staging.id, n);
    await agent(c, edge.id, 'e1', {
      caps: { ebpf: 'unsupported', ebpf_reason: 'kernel 5.4 without BTF' },
    });
    await agent(c, office.id, 'mail-01', { mode: 'docker', seenMinAgo: 18 });
    await agent(c, office.id, 'files-01', { mode: 'docker' });
    await agent(c, db.id, 'pg-02', { mode: 'docker' });
    for (const n of ['web-01', 'web-03'])
      await agent(c, shop.id, n, { mode: 'docker', version: '0.10.1' });
    await agent(c, prod.id, 'cluster-agent', { mode: 'cluster' });

    // Problems. One org-wide rule per key, as the default rules are.
    const crash = await rule(c, orgId, 'k8s.pod.crashloop', { severity: 'critical' });
    const silent = await rule(c, orgId, 'agent.not_reporting', { severity: 'critical' });
    const unitFailed = await rule(c, orgId, 'server.unit.failed');
    const procOom = await rule(c, orgId, 'server.process.oom');
    const ctrOom = await rule(c, orgId, 'docker.container.oom');
    // The same crash loop in prod and staging (namespaces differ): one row, two places.
    await firing(
      c,
      orgId,
      prod.id,
      crash,
      { namespace: 'payments', workload: 'payments-api', pod: 'payments-api-1' },
      12,
      'critical',
    );
    await firing(
      c,
      orgId,
      staging.id,
      crash,
      { namespace: 'payments-staging', workload: 'payments-api', pod: 'payments-api-7' },
      20,
      'critical',
    );
    // A near miss: the same rule on another workload in staging stays its own row.
    await firing(
      c,
      orgId,
      staging.id,
      crash,
      { namespace: 'jobs', workload: 'importer', pod: 'importer-1' },
      15,
      'critical',
    );
    await firing(c, orgId, office.id, silent, { host: 'mail-01' }, 18, 'critical');
    // Servers: a unit (db and shop: one row), a process group, a container.
    await firing(
      c,
      orgId,
      db.id,
      unitFailed,
      { host: 'pg-02', unit: 'backup-nightly.service' },
      180,
    );
    await firing(
      c,
      orgId,
      shop.id,
      unitFailed,
      { host: 'web-03', unit: 'backup-nightly.service' },
      170,
    );
    await firing(
      c,
      orgId,
      shop.id,
      procOom,
      { host: 'web-01', unit: '', group: 'php-fpm: shop' },
      60,
    );
    await firing(
      c,
      orgId,
      shop.id,
      ctrOom,
      { host: 'web-01', container: 'shop-web-1', compose_service: 'web' },
      30,
    );
    // Resolved this week (the healthy state's line).
    await c.db
      .insertInto('alert_states')
      .values({
        id: newId(),
        org_id: orgId,
        rule_id: unitFailed,
        cluster_id: db.id,
        fingerprint: 'fp-resolved',
        state: 'resolved',
        severity: 'warning',
        labels: JSON.stringify({ host: 'pg-02', unit: 'vacuum.service' }),
        details: JSON.stringify({}),
        started_at: new Date(NOW - 2 * DAY - 3 * 3_600_000),
        resolved_at: new Date(NOW - 2 * DAY),
      })
      .execute();

    // What changed: prod and db have learned; staging hasn't.
    await learned(c, orgId, prod.id);
    await learned(c, orgId, db.id);
    await period(
      c,
      orgId,
      prod.id,
      'workload.http.latency.p95',
      {
        dst_kind: 'workload',
        dst_namespace: 'shop',
        dst_workload_kind: 'Deployment',
        dst_workload: 'checkout',
      },
      34,
    );
    await period(c, orgId, db.id, 'host.disk.write', { host: 'pg-02' }, 28);
    await period(
      c,
      orgId,
      prod.id,
      'workload.cpu.usage',
      { namespace: 'jobs', workload_kind: 'Deployment', workload: 'worker' },
      5,
    );
    await period(
      c,
      orgId,
      staging.id,
      'workload.cpu.usage',
      { namespace: 'x', workload_kind: 'Deployment', workload: 'y' },
      99,
    );

    // Channels: Slack failing since yesterday, Telegram delivering; only prod routes to one.
    const slack = newId();
    const telegram = newId();
    await c.db
      .insertInto('alert_channels')
      .values([
        {
          id: slack,
          org_id: orgId,
          type: 'slack',
          name: '#ops-alerts',
          config: '{}',
          last_error: 'webhook answered 404',
          last_error_at: new Date(NOW - DAY),
        },
        {
          id: telegram,
          org_id: orgId,
          type: 'telegram',
          name: 'On call',
          config: '{}',
          last_sent_at: new Date(NOW - 5 * MIN),
        },
      ])
      .execute();
    await rule(c, orgId, 'custom.prod', { cluster_id: prod.id, channel_ids: [telegram, slack] });
    const note = (channel: string, cluster: string, status: string) => ({
      id: newId(),
      org_id: orgId,
      channel_id: channel,
      cluster_id: cluster,
      dedupe_key: newId(),
      kind: 'firing',
      payload: '{}',
      status,
      created_at: new Date(NOW - 10 * MIN),
    });
    await c.db
      .insertInto('notifications')
      .values([
        note(telegram, prod.id, 'sent'),
        note(telegram, prod.id, 'sent'),
        note(slack, prod.id, 'failed'),
        note(telegram, office.id, 'sent'),
      ])
      .execute();

    // Metrics: prod busy 64 %, memory 71 %; db 35 %, 82 %.
    await write(prod.id, hostSeries(prod.id, ['p1', 'p2', 'p3'], 'node', 0.64, 0.71, 2));
    await write(db.id, hostSeries(db.id, ['pg-02'], 'host', 0.35, 0.82, 2));
    await flush();
    await new Promise((r) => setTimeout(r, 6000)); // the VM's 5 s latency offset

    const res = await get(c, cookie, { range: '3600' });
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json();

    expect(a.counts).toEqual({ all: 6, kubernetes: 3, server: 3 });
    expect(a.hosts).toEqual({ nodes: 6, servers: 5, notReporting: 1 });
    expect(a.ranges).toEqual([3600, 21_600, 86_400, 604_800, 2_592_000]);

    // Needs attention: critical first, then the most recent; merged rows carry both places.
    const rows = a.problems.map(
      (p: { title: string; severity: string; places: { cluster: { name: string } }[] }) => ({
        severity: p.severity,
        places: p.places.map((pl) => pl.cluster.name),
      }),
    );
    expect(rows).toEqual([
      { severity: 'critical', places: ['acme-staging'] }, // importer, 15 min
      { severity: 'critical', places: ['office-tools'] }, // silent, 18 min
      { severity: 'critical', places: ['acme-staging', 'acme-prod'] }, // payments-api, 20 and 12 min
      { severity: 'warning', places: ['shop-servers'] }, // container, 30 min
      { severity: 'warning', places: ['shop-servers'] }, // process group, 60 min
      { severity: 'warning', places: ['db-servers', 'shop-servers'] }, // unit, 180 and 170 min: oldest first
    ]);
    const merged = a.problems[2];
    expect(merged.title).toMatch(/payments-api/);
    expect(
      merged.places.map((p: { problemId: string }) => p.problemId.startsWith('alert:')),
    ).toEqual([true, true]);

    // The table: by status, then name.
    const table = a.clusters.map((r: { name: string; status: string }) => `${r.name}:${r.status}`);
    expect(table).toEqual([
      'acme-prod:critical',
      'acme-staging:critical',
      'office-tools:critical',
      'db-servers:warning',
      'shop-servers:warning',
      'eu-edge:healthy',
    ]);
    const byName = Object.fromEntries(a.clusters.map((r: { name: string }) => [r.name, r]));
    expect(byName['acme-prod'].reporting).toEqual({ live: 3, total: 3 });
    expect(byName['office-tools'].reporting).toEqual({ live: 1, total: 2 });
    expect(byName['acme-prod'].cpu.now).toBeCloseTo(0.64, 2);
    expect(byName['acme-prod'].cpu.points.length).toBeGreaterThan(2);
    expect(byName['acme-prod'].memory).toBeCloseTo(0.71, 2);
    expect(byName['db-servers'].cpu.now).toBeCloseTo(0.35, 2);
    expect(byName['db-servers'].memory).toBeCloseTo(0.82, 2);
    expect(byName['eu-edge'].cpu.now).toBeNull();
    expect(byName['acme-prod'].problems).toEqual({ critical: 1, warning: 0 });
    expect(byName['shop-servers'].problems).toEqual({ critical: 0, warning: 3 });
    expect(byName['acme-prod'].whatChanged).toBe(2);
    expect(byName['db-servers'].whatChanged).toBe(1);
    expect(byName['acme-staging'].whatChanged).toBeNull(); // still learning
    expect(byName['acme-prod'].alerts).toBe(3);
    expect(byName['office-tools'].alerts).toBe(1);
    expect(byName['acme-prod'].sources).toBeNull();
    expect(byName['shop-servers'].sources).toMatchObject({
      services: 0,
      processGroups: 0,
      containers: 0,
    });

    // What changed across clusters: by how far out, with the cluster; staging's left out.
    expect(
      a.whatChanged.rows.map((r: { peakScore: number; cluster: { name: string } }) => [
        r.cluster.name,
        r.peakScore,
      ]),
    ).toEqual([
      ['acme-prod', 34],
      ['db-servers', 28],
      ['acme-prod', 5],
    ]);
    expect(a.whatChanged.learning.map((l: { name: string }) => l.name).sort()).toEqual([
      'acme-staging',
      'eu-edge',
      'office-tools',
      'shop-servers',
    ]);

    // Alerts sent, per channel.
    expect(a.alertsSent.total).toBe(4);
    expect(a.alertsSent.channels).toEqual([
      { id: slack, name: '#ops-alerts', type: 'slack', sent: 0, failed: 1 },
      { id: telegram, name: 'On call', type: 'telegram', sent: 3, failed: 0 },
    ]);

    // Housekeeping.
    const hk = a.housekeeping;
    expect(hk.latestVersion).toBe(VERSION);
    expect(hk.oldAgents).toEqual([
      {
        cluster: { id: shop.id, name: 'shop-servers', kind: 'server' },
        count: 2,
        versions: ['0.10.1'],
      },
    ]);
    expect(hk.failingChannels).toEqual([
      {
        id: slack,
        name: '#ops-alerts',
        type: 'slack',
        since: new Date(NOW - DAY).toISOString(),
        error: 'webhook answered 404',
      },
    ]);
    expect(hk.deliveringChannels.map((x: { name: string }) => x.name)).toEqual(['On call']);
    expect(hk.noChannel.map((x: { name: string }) => x.name).sort()).toEqual([
      'acme-staging',
      'db-servers',
      'eu-edge',
      'office-tools',
      'shop-servers',
    ]);
    expect(hk.ebpfOff).toEqual([
      {
        cluster: { id: edge.id, name: 'eu-edge', kind: 'kubernetes' },
        count: 1,
        reasons: ['kernel 5.4 without BTF'],
      },
    ]);

    expect(a.lastResolved).toMatchObject({
      cluster: { name: 'db-servers' },
      durationSeconds: 3 * 3600,
    });
    expect(a.resolvedThisWeek).toBe(1);

    // The kind filter applies to every section.
    const srv = (await get(c, cookie, { range: '3600', kind: 'server' })).json();
    expect(srv.clusters.map((r: { kind: string }) => r.kind)).toEqual([
      'server',
      'server',
      'server',
    ]);
    expect(
      srv.problems.every((p: { places: { cluster: { kind: string } }[] }) =>
        p.places.every((pl) => pl.cluster.kind === 'server'),
      ),
    ).toBe(true);
    expect(srv.problems).toHaveLength(4);
    expect(srv.whatChanged.rows.map((r: { cluster: { name: string } }) => r.cluster.name)).toEqual([
      'db-servers',
    ]);
    expect(srv.housekeeping.ebpfOff).toEqual([]);
    expect(srv.hosts).toEqual({ nodes: 0, servers: 5, notReporting: 1 });
    expect(srv.counts).toEqual({ all: 6, kubernetes: 3, server: 3 });
    const k8s = (await get(c, cookie, { range: '3600', kind: 'kubernetes' })).json();
    expect(k8s.problems).toHaveLength(2);
    expect(k8s.housekeeping.oldAgents).toEqual([]);

    // Another org's clusters and problems never show.
    const other = await signup(c);
    await c.app.entitlements!.put(other.orgId, { plan: 'pro', source: 'staff' });
    const theirs = await insertCluster(c.db, other.orgId, 'other-org-cluster', 'kubernetes');
    await firing(
      c,
      other.orgId,
      theirs.id,
      await rule(c, other.orgId, 'k8s.pod.crashloop'),
      { namespace: 'payments', workload: 'payments-api' },
      14,
      'critical',
    );
    const again = (await get(c, cookie, { range: '3600' })).json();
    expect(JSON.stringify(again)).not.toContain('other-org-cluster');
    expect(again.problems).toHaveLength(6);
    const theirAnswer = (await get(c, other.cookie, { range: '3600' })).json();
    expect(theirAnswer.clusters.map((r: { name: string }) => r.name)).toEqual([
      'other-org-cluster',
    ]);
    expect(JSON.stringify(theirAnswer)).not.toContain('acme-prod');
  }, 60_000);

  it('a range past the retention is refused', async () => {
    const { c, cookie, orgId } = await cloudOrg();
    await c.app.entitlements!.put(orgId, { plan: 'pro', source: 'staff', retentionDays: 7 });
    const res = await get(c, cookie, { range: '2592000' });
    expect(res.statusCode).toBe(400);
    const ok = (await get(c, cookie, { range: '604800' })).json();
    expect(ok.ranges).toEqual([3600, 21_600, 86_400, 604_800]);
  });

  it('one cluster only, and none', async () => {
    const { c, cookie, orgId } = await cloudOrg();
    const empty = (await get(c, cookie)).json();
    expect(empty.counts).toEqual({ all: 0, kubernetes: 0, server: 0 });
    expect(empty.clusters).toEqual([]);
    await insertCluster(c.db, orgId, 'only', 'server');
    const one = (await get(c, cookie)).json();
    expect(one.clusters.map((r: { name: string; status: string }) => [r.name, r.status])).toEqual([
      ['only', 'waiting'],
    ]);
  });
});

describe('50 clusters and fleets', () => {
  it('answers within 300 ms of server time, with one query per metric', async () => {
    const { c, cookie, orgId } = await cloudOrg();
    const crash = await rule(c, orgId, 'k8s.pod.crashloop', { severity: 'critical' });
    const unit = await rule(c, orgId, 'server.unit.failed');
    const series: [string, TestSeries[]][] = [];
    for (let i = 0; i < 50; i++) {
      const kind = i % 2 ? 'server' : 'kubernetes';
      const cl = await insertCluster(c.db, orgId, `env-${String(i).padStart(2, '0')}`, kind);
      const hosts = [0, 1, 2, 3].map((h) => `${kind === 'server' ? 'srv' : 'node'}-${i}-${h}`);
      for (const h of hosts)
        await agent(c, cl.id, h, { mode: kind === 'server' ? 'docker' : 'node' });
      await learned(c, orgId, cl.id);
      await period(
        c,
        orgId,
        cl.id,
        'workload.cpu.usage',
        { namespace: 'a', workload_kind: 'Deployment', workload: `w${i}` },
        i,
      );
      if (i % 3 === 0)
        await firing(
          c,
          orgId,
          cl.id,
          kind === 'server' ? unit : crash,
          kind === 'server'
            ? { host: hosts[0]!, unit: 'app.service' }
            : { namespace: 'a', workload: 'api' },
          10 + i,
        );
      series.push([
        cl.id,
        hostSeries(cl.id, hosts, kind === 'server' ? 'host' : 'node', 0.3, 0.5, 24),
      ]);
    }
    for (const [id, s] of series) await write(id, s);
    await flush();
    await new Promise((r) => setTimeout(r, 6000));

    // VictoriaMetrics' requests, counted at the client.
    let vmCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).startsWith(TEST_VM_URL)) vmCalls++;
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      await get(c, cookie); // warm
      vmCalls = 0;
      const times: number[] = [];
      for (let n = 0; n < 5; n++) {
        const t0 = performance.now();
        const res = await get(c, cookie);
        times.push(performance.now() - t0);
        expect(res.statusCode).toBe(200);
        expect(res.json().clusters).toHaveLength(50);
      }
      times.sort((x, y) => x - y);
      const median = times[2]!;
      console.log(
        `all-clusters, 50 clusters and fleets: median ${median.toFixed(0)} ms (${times.map((t) => t.toFixed(0)).join(', ')} ms); ${vmCalls / 5} VictoriaMetrics queries per answer`,
      );
      expect(median).toBeLessThan(300);
      // CPU (range), memory used and total, systemd services and process groups, volumes'
      // use and host boots (each cluster's own Needs attention, ADR-227): 7.
      expect(vmCalls / 5).toBe(7);
      const a = (await get(c, cookie)).json();
      expect(
        a.clusters.filter((r: { cpu: { now: number | null } }) => r.cpu.now !== null),
      ).toHaveLength(50);
      // 17 firing alerts; the same rule on the same workload within 30 minutes merges them
      // into 2 Kubernetes rows and 2 server rows (ADR-226's rule, measured from the oldest).
      expect(a.problems).toHaveLength(4);
      expect(
        a.problems.reduce((n: number, p: { places: unknown[] }) => n + p.places.length, 0),
      ).toBe(17);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 300_000);
});

describe('Needs attention on /all is every cluster’s own Needs attention (ADR-227)', () => {
  it('lists exactly what each Overview lists, for both kinds, object problems included', async () => {
    const { c, cookie, orgId } = await cloudOrg();
    const k8s = await insertCluster(c.db, orgId, 'parity-k8s', 'kubernetes');
    const fleet = await insertCluster(c.db, orgId, 'parity-servers', 'server');
    await agent(c, k8s.id, 'n1');
    await agent(c, fleet.id, 'h1', { mode: 'docker' });
    const obj = (
      clusterId: string,
      source: string,
      kind: string,
      name: string,
      node: string,
      spec: object,
      status: object,
      namespace = '',
    ) =>
      c.db
        .insertInto('objects')
        .values({
          id: newId(),
          cluster_id: clusterId,
          source,
          kind,
          uid: `${kind}-${name}`,
          namespace,
          name,
          node,
          spec_summary: JSON.stringify(spec),
          status_summary: JSON.stringify(status),
        })
        .execute();
    // Kubernetes: a NotReady node no alert covers, and an alert on a workload.
    await obj(
      k8s.id,
      'kubernetes',
      'Node',
      'n2',
      'n2',
      {},
      {
        conditions: [{ type: 'Ready', status: 'False', reason: 'KubeletNotReady' }],
      },
    );
    await obj(
      k8s.id,
      'kubernetes',
      'Node',
      'n1',
      'n1',
      {},
      {
        conditions: [{ type: 'Ready', status: 'True' }],
      },
    );
    await firing(
      c,
      orgId,
      k8s.id,
      await rule(c, orgId, 'k8s.pod.crashloop'),
      {
        namespace: 'shop',
        workload: 'api',
        pod: 'api-1',
      },
      7,
      'critical',
    );
    // Servers: an unhealthy container no alert covers, and a unit alert.
    await obj(
      fleet.id,
      'docker',
      'DockerContainer',
      'shop-web-1',
      'h1',
      { image: 'nginx:1.27' },
      {
        state: 'running',
        health: 'unhealthy',
      },
      'h1',
    );
    await firing(
      c,
      orgId,
      fleet.id,
      await rule(c, orgId, 'server.unit.failed'),
      {
        node: 'h1',
        unit: 'backup.service',
      },
      30,
    );

    const all = (await get(c, cookie, { range: '3600' })).json();
    for (const cl of [k8s, fleet]) {
      const own = (
        await c.app.inject({
          method: 'GET',
          url: `/api/v1/clusters/${cl.id}/overview`,
          cookies: { wl_session: cookie },
        })
      ).json();
      const fromOverview = own.problems.items
        .map((p: { title: string; severity: string }) => `${p.severity} ${p.title}`)
        .sort();
      const fromAll = all.problems
        .filter((p: { places: { cluster: { id: string } }[] }) =>
          p.places.some((pl) => pl.cluster.id === cl.id),
        )
        .map((p: { title: string; severity: string }) => `${p.severity} ${p.title}`)
        .sort();
      expect(fromOverview.length).toBe(2);
      expect(fromAll).toEqual(fromOverview);
    }
  });
});

describe('certificates and scheduled jobs across them all (0.13.0)', () => {
  it('counts per cluster and fleet, the two tiles with where they are, and the kind filter', async () => {
    const { c, cookie, orgId } = await cloudOrg();
    const prod = await insertCluster(c.db, orgId, 'acme-prod', 'kubernetes');
    const fleet = await insertCluster(c.db, orgId, 'acme-servers', 'server');
    const sys = c.app.systemDb;
    const cert = (clusterId: string, id: string, days: number, node = '') => ({
      org_id: orgId,
      cluster_id: clusterId,
      node,
      cert_id: id,
      fingerprint: id.repeat(4),
      names: [`${id}.acme.com`],
      subject: `${id}.acme.com`,
      issuer: 'WL Test CA',
      chain: 'complete',
      not_before: new Date(NOW - 60 * 86_400_000),
      not_after: new Date(NOW + days * 86_400_000),
    });
    await sys
      .insertInto('certificates')
      .values([
        cert(prod.id, 'aaaaaaaaaaaaaaaa', 9),
        cert(prod.id, 'bbbbbbbbbbbbbbbb', 60),
        cert(fleet.id, 'cccccccccccccccc', -2, 'app-1'),
      ] as never)
      .execute();
    const job = (clusterId: string, id: string, name: string, state: string, node = '') => ({
      org_id: orgId,
      cluster_id: clusterId,
      node,
      job_id: id,
      kind: node ? 'timer' : 'cronjob',
      name,
      state,
      enabled: true,
    });
    await sys
      .insertInto('scheduled_jobs')
      .values([
        job(prod.id, '1111111111111111', 'shop/report-builder', 'failed'),
        job(prod.id, '2222222222222222', 'shop/analytics', 'working'),
        job(fleet.id, '3333333333333333', 'backup.timer', 'failed', 'worker-1'),
      ] as never)
      .execute();
    const res = await get(c, cookie);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const row = (name: string) => body.clusters.find((x: { name: string }) => x.name === name);
    expect(row('acme-prod')).toMatchObject({
      certificates: { total: 2, expiring: 1 },
      jobs: { total: 2, failing: 1 },
    });
    expect(row('acme-servers')).toMatchObject({
      certificates: { total: 1, expiring: 1 },
      jobs: { total: 1, failing: 1 },
    });
    expect(body.certificatesExpiring.count).toBe(2);
    expect(
      body.certificatesExpiring.places
        .map((p: { name: string; count: number }) => [p.name, p.count])
        .sort(),
    ).toEqual([
      ['acme-prod', 1],
      ['acme-servers', 1],
    ]);
    expect(body.jobsFailing.count).toBe(2);
    expect(
      body.jobsFailing.jobs.map((j: { name: string; node: string }) => [j.name, j.node]),
    ).toEqual([
      ['backup.timer', 'worker-1'],
      ['shop/report-builder', ''],
    ]);
    // Server fleets only.
    const servers = (await get(c, cookie, { kind: 'server' })).json();
    expect(servers.certificatesExpiring.count).toBe(1);
    expect(servers.jobsFailing.jobs.map((j: { name: string }) => j.name)).toEqual(['backup.timer']);
  });
});
