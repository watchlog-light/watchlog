// SPDX-License-Identifier: AGPL-3.0-only
// GET /api/v1/egress (ADR-188, ADR-189; v0.7 slice 3): the Egress page's read for a Kubernetes
// cluster and a Docker fleet. Inventory rows are written as the minute job writes them; the
// range's traffic comes from flow series written to the real test VictoriaMetrics. "New" is
// measured from an injected clock, never by waiting. Cloud's org scoping is the isolation
// suite's (test/isolation/cross-org.test.ts, "egress").
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authorisedScope,
  VictoriaQueryClient,
  type ClusterScope,
  type QuerySeries,
} from '../src/lib/victoria.js';
import { classifyDestination, runEgressBackfill } from '../src/modules/egress/inventory.js';
import { EGRESS_MAX_ROWS } from '../src/modules/egress/read.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  TEST_VM_URL,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const SCRAPE = 15_000;
const RUN = `egress-api-${Date.now()}`;
/** The injected clock: now, on a scrape boundary, so the series end at "now". */
const NOW = Math.floor(Date.now() / SCRAPE) * SCRAPE;
const vm = new VictoriaQueryClient(TEST_VM_URL);

let ctx: TestContext;
let cookie: string;

afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
});

async function open(overrides = {}) {
  ctx = await createTestContext(overrides, { now: () => NOW });
  cookie = await setupAdmin(ctx.app);
}
afterEach(() => closeTestContext(ctx));

const get = (query: Record<string, string>, as = cookie) =>
  ctx.app.inject({ method: 'GET', url: '/api/v1/egress', query, cookies: { wl_session: as } });

async function cluster(kind: 'kubernetes' | 'server', name: string = kind) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/clusters',
    cookies: { wl_session: cookie },
    payload: { name, kind },
  });
  const id = res.json().cluster.id as string;
  await lookedBack(id);
  return id;
}

/** The first-seen look-back has run, as it has a few minutes after a cluster first reports. */
const lookedBack = (clusterId: string) =>
  ctx.db
    .updateTable('clusters')
    .set({ egress_backfilled_at: new Date(NOW - DAY) })
    .where('id', '=', clusterId)
    .where('egress_backfilled_at', 'is', null)
    .execute();

/** An inventory row as the minute job writes it (the class worked out the same way). */
async function inventory(
  clusterId: string,
  source: Record<string, string>,
  destination: string,
  port: number,
  firstAgoMs: number,
  lastAgoMs = 0,
  extra: { before?: boolean; pattern?: string } = {},
) {
  const internet = destination === 'Internet';
  await ctx.db
    .insertInto('egress_destinations')
    .values({
      cluster_id: clusterId,
      source: JSON.stringify(source),
      destination,
      dst_kind: internet ? 'internet' : 'external',
      port,
      destination_class: classifyDestination(internet ? 'internet' : 'external', destination),
      first_seen: new Date(NOW - firstAgoMs),
      first_seen_before: extra.before ?? false,
      last_seen: new Date(NOW - lastAgoMs),
      pattern: extra.pattern ?? null,
    })
    .execute();
  await ctx.db
    .insertInto('egress_sources')
    .values({
      cluster_id: clusterId,
      source: JSON.stringify(source),
      first_seen: new Date(NOW - firstAgoMs),
      last_seen: new Date(NOW - lastAgoMs),
    })
    .onConflict((oc) => oc.columns(['cluster_id', 'source']).doNothing())
    .execute();
}

/**
 * A counter growing by `per` every scrape for 30 minutes, ending a minute before NOW (queries
 * near "now" don't see the last 30 s: VictoriaMetrics' latency offset).
 */
function counter(name: string, labels: Record<string, string>, per: number): TestSeries[] {
  const out: TestSeries[] = [];
  for (let i = 0, t = NOW - 31 * MIN; t <= NOW - MIN; i++, t += SCRAPE) {
    out.push({ labels: { __name__: name, run: RUN, ...labels }, value: i * per, timestampMs: t });
  }
  return out;
}

async function write(clusterId: string, series: TestSeries[]) {
  await vm.write(authorisedScope(clusterId), encode(series));
  await fetch(`${TEST_VM_URL}/internal/force_flush`);
  // New series take a moment to be searchable: wait until every one is.
  const want = new Set(series.map((s) => JSON.stringify(s.labels))).size;
  for (let i = 0; i < 50; i++) {
    const found = await vm.query(
      authorisedScope(clusterId),
      `count({run="${RUN}"})`,
      (NOW - MIN) / 1000,
    );
    if ((found[0]?.points[0]?.[1] ?? 0) >= want) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('series not searchable');
}

/** connections, failed and bytes series for one edge; 120 scrapes in 30 minutes. */
function edge(labels: Record<string, string>, conns: number, failed: number, sent = 0, recv = 0) {
  return [
    ...counter('watchlog_flow_connections_total', labels, conns),
    ...counter('watchlog_flow_connect_failed_total', labels, failed),
    ...counter('watchlog_flow_bytes_total', { ...labels, dir: 'sent' }, sent),
    ...counter('watchlog_flow_bytes_total', { ...labels, dir: 'received' }, recv),
  ];
}

const shop = (workload: string, kind = 'Deployment') => ({
  namespace: 'shop',
  workload_kind: kind,
  workload,
});
const k8sLabels = (workload: string, dst: string, port: string, node = 'n1') => ({
  ...shop(workload),
  node,
  dst_kind: 'external',
  dst,
  dst_port: port,
});

type Row = {
  destination: string;
  port: number;
  kind: string;
  class: string;
  private: boolean;
  badges: string[];
  sources: Record<string, unknown>[];
  firstSeen: string;
  firstSeenBefore: boolean;
  connections: number | null;
  failed: number | null;
  failedRatio: number | null;
  sent: number | null;
  received: number | null;
  expected: { pattern: string } | null;
  alertId: string | null;
};
const find = (rows: Row[], d: string, port?: number) =>
  rows.find((r) => r.destination === d && (port === undefined || r.port === port));

describe('GET /api/v1/egress: a Kubernetes cluster', () => {
  let id: string;
  beforeEach(async () => {
    await open();
    id = await cluster('kubernetes', 'acme-prod');
    // Two workloads use S3 (one for 40 days, one since 3 hours: a new source for it).
    await inventory(id, shop('backup'), 's3.eu-central-1.amazonaws.com', 443, 40 * DAY, 10 * MIN);
    await inventory(id, shop('media'), 's3.eu-central-1.amazonaws.com', 443, 3 * HOUR, 0);
    await inventory(id, shop('mailer'), 'api.mailgun.net', 443, 38 * DAY);
    await inventory(id, shop('importer'), '185.220.101.0/24', 9001, 2 * HOUR, 4 * MIN);
    await inventory(id, shop('orders'), '10.244.1.0/24', 8080, 1 * HOUR);
    await inventory(id, shop('orders'), 'api', 80, 5 * HOUR);
    await inventory(id, shop('crawler'), 'Internet', 0, 2 * HOUR);
    // In use before the oldest retained sample: never New, even 20 hours ago.
    await inventory(id, shop('checkout'), 'api.stripe.com', 443, 20 * HOUR, 0, {
      before: true,
      pattern: 'api.stripe.com',
    });
    // Last used 3 days ago: outside 24 h, inside 7 d.
    await inventory(
      id,
      { namespace: 'ops', workload_kind: 'CronJob', workload: 'notifier' },
      'hooks.slack.com',
      443,
      41 * DAY,
      3 * DAY,
    );
    await write(id, [
      ...edge(k8sLabels('backup', 's3.eu-central-1.amazonaws.com', '443'), 1, 0, 1000, 10),
      ...edge(k8sLabels('backup', 's3.eu-central-1.amazonaws.com', '443', 'n2'), 1, 0, 500, 5),
      ...edge(k8sLabels('media', 's3.eu-central-1.amazonaws.com', '443'), 2, 0, 0, 100),
      // 10 % of the mailer's connects fail: Failing.
      ...edge(k8sLabels('mailer', 'api.mailgun.net', '443'), 10, 1),
      // 1 in 120 of the importer's fails: under 5 %.
      ...counter(
        'watchlog_flow_connections_total',
        k8sLabels('importer', '185.220.101.0/24', '9001'),
        1,
      ),
    ]);
  });

  it('groups sources per destination and port, with first and last seen and the range’s traffic', async () => {
    const res = await get({ cluster: id });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cluster).toEqual({ id, kind: 'kubernetes' });
    expect(body.traffic).toBe(true);
    expect(body.truncated).toBe(false);
    // 24 h by default: Slack (3 days ago) is out of range.
    expect(body.rows.map((r: Row) => r.destination)).not.toContain('hooks.slack.com');
    const s3 = find(body.rows, 's3.eu-central-1.amazonaws.com')!;
    expect(s3.sources.map((s) => s.workload)).toEqual(['media', 'backup']);
    expect(s3.sources[0]).toMatchObject({
      namespace: 'shop',
      workloadKind: 'Deployment',
      workload: 'media',
      new: true,
    });
    expect(s3.sources[1]).toMatchObject({ workload: 'backup', new: false });
    expect(s3.sources[0]).not.toHaveProperty('host');
    expect(s3.firstSeen).toBe(new Date(NOW - 40 * DAY).toISOString());
    // Two nodes summed: (1 + 1 + 2) per scrape over 120 scrapes.
    expect(s3.connections).toBe(480);
    expect(s3.sent).toBe(120 * 1500);
    expect(s3.received).toBe(120 * 115);
    expect(s3.kind).toBe('name');
    expect(s3.badges).toEqual(['new']);
    expect(s3.alertId).toBeNull();
  });

  it('labels names, local names, public and private networks and "Internet"; badges New, Raw IP, Failing, Expected', async () => {
    const { rows, summary } = (await get({ cluster: id })).json();
    const raw = find(rows, '185.220.101.0/24')!;
    expect(raw).toMatchObject({ kind: 'network', class: 'public_network', private: false });
    expect(raw.badges).toEqual(['new', 'raw_ip']);
    expect(raw.failedRatio).toBe(0);
    expect(find(rows, '10.244.1.0/24')).toMatchObject({
      kind: 'network',
      class: 'private_network',
      private: true,
      // Listed but never New: private networks don't raise the alert (slice 4's default).
      badges: [],
    });
    expect(find(rows, 'api', 80)).toMatchObject({
      kind: 'name',
      class: 'local_name',
      badges: [],
    });
    const internet = find(rows, 'Internet')!;
    expect(internet).toMatchObject({ kind: 'internet', class: 'internet', port: 0 });
    expect(internet.badges).toEqual([]); // names nothing: never New (ADR-185)
    const mailgun = find(rows, 'api.mailgun.net')!;
    expect(mailgun).toMatchObject({ connections: 1200, failed: 120, failedRatio: 0.1 });
    expect(mailgun.badges).toEqual(['failing']);
    const stripe = find(rows, 'api.stripe.com')!;
    expect(stripe.firstSeenBefore).toBe(true);
    expect(stripe.badges).toEqual(['expected']);
    expect(stripe.expected).toMatchObject({ pattern: 'api.stripe.com' });
    // No series for a row: zeros, not "unknown".
    expect(stripe.connections).toBe(0);
    expect(summary).toEqual({ destinations: 7, sources: 7, new: 2, rawIp: 1, failing: 1 });
    // New first, then Raw IP, then Failing.
    expect(rows.slice(0, 2).every((r: Row) => r.badges.includes('new'))).toBe(true);
    expect(rows[2].destination).toBe('api.mailgun.net');
  });

  it('the New badge follows the clock: 24 hours after first seen it is gone', async () => {
    const at = async (clockMs: number) => {
      await closeTestContext(ctx);
      ctx = await createTestContext({}, { now: () => clockMs });
      cookie = await setupAdmin(ctx.app);
      const c = await cluster('kubernetes', 'later');
      await inventory(c, shop('a'), 'one.example.org', 443, 0); // first seen at NOW
      return (await get({ cluster: c, to: String(Math.floor(NOW / 1000)) })).json();
    };
    expect(find((await at(NOW + 23 * HOUR)).rows, 'one.example.org')!.badges).toEqual(['new']);
    const later = await at(NOW + 25 * HOUR);
    expect(find(later.rows, 'one.example.org')!.badges).toEqual([]);
    expect(find(later.rows, 'one.example.org')!.sources[0]!.new).toBe(false);
    expect(later.summary.new).toBe(0);
  });

  it('filters by namespace, workload kind and name, badge and search; the range widens to 7 days', async () => {
    const w = (await get({ cluster: id, namespace: 'shop', workload: 'media' })).json();
    expect(w.rows.map((r: Row) => r.destination)).toEqual(['s3.eu-central-1.amazonaws.com']);
    expect(w.rows[0].sources.map((s: { workload: string }) => s.workload)).toEqual(['media']);
    expect(w.rows[0].connections).toBe(240); // media's own traffic only
    expect(w.summary.sources).toBe(1);
    expect((await get({ cluster: id, kind: 'StatefulSet' })).json().rows).toEqual([]);
    const raw = (await get({ cluster: id, badge: 'raw_ip' })).json();
    expect(raw.rows.map((r: Row) => r.destination)).toEqual(['185.220.101.0/24']);
    expect(raw.summary.destinations).toBe(7); // the header ignores the badge
    const notExpected = (await get({ cluster: id, badge: 'not_expected' })).json();
    expect(notExpected.rows.map((r: Row) => r.destination)).not.toContain('api.stripe.com');
    expect((await get({ cluster: id, q: 'MAILGUN' })).json().rows).toHaveLength(1);
    // The search covers sources too.
    expect((await get({ cluster: id, q: 'importer' })).json().rows[0].destination).toBe(
      '185.220.101.0/24',
    );
    const week = (
      await get({ cluster: id, from: String(Math.floor((NOW - 7 * DAY) / 1000)) })
    ).json();
    expect(find(week.rows, 'hooks.slack.com')!.sources[0]).toMatchObject({
      namespace: 'ops',
      workloadKind: 'CronJob',
      workload: 'notifier',
    });
  });

  it('says it is learning until 7 days after the upgrade, then from how many days it learned', async () => {
    await ctx.db
      .updateTable('clusters')
      .set({ egress_learning_since: new Date(NOW - 2 * DAY) })
      .where('id', '=', id)
      .execute();
    const learning = (await get({ cluster: id })).json().learning;
    expect(learning).toMatchObject({
      learning: true,
      since: new Date(NOW - 2 * DAY).toISOString(),
      until: new Date(NOW + 5 * DAY).toISOString(),
    });
    // The look-back found 41 days of history.
    expect(learning.days).toBe(41);
    await ctx.db
      .updateTable('clusters')
      .set({ egress_learning_since: new Date(NOW - 9 * DAY) })
      .where('id', '=', id)
      .execute();
    expect((await get({ cluster: id })).json().learning.learning).toBe(false);
  });
});

describe('GET /api/v1/egress: a Docker fleet', () => {
  let id: string;
  const api = { compose_project: 'storefront', compose_service: 'api' };
  const dockerLabels = (container: string, host: string, dst: string, compose = true) => ({
    host,
    container,
    ...(compose ? api : {}),
    dst_kind: 'external',
    dst,
    dst_port: '443',
  });
  beforeEach(async () => {
    await open();
    id = await cluster('server', 'acme-hosts');
    await inventory(id, api, 'api.openai.com', 443, 9 * DAY);
    await inventory(id, { host: 'h2', container: 'cron' }, 'hooks.slack.com', 443, 2 * HOUR);
    // The Compose service's two replicas on two hosts, and the plain container on h2.
    await write(id, [
      ...edge(dockerLabels('storefront-api-1', 'h1', 'api.openai.com'), 2, 0, 10, 20),
      ...edge(dockerLabels('storefront-api-2', 'h2', 'api.openai.com'), 1, 0, 10, 20),
      ...edge(dockerLabels('cron', 'h2', 'hooks.slack.com', false), 1, 0),
    ]);
  });

  it('shows Compose services and plain containers in the Docker vocabulary', async () => {
    const body = (await get({ cluster: id })).json();
    expect(body.cluster.kind).toBe('server');
    const openai = find(body.rows, 'api.openai.com')!;
    expect(openai.sources).toEqual([
      expect.objectContaining({ composeProject: 'storefront', composeService: 'api', new: false }),
    ]);
    expect(openai.sources[0]).not.toHaveProperty('namespace');
    expect(openai.connections).toBe(360); // both replicas
    const slack = find(body.rows, 'hooks.slack.com')!;
    expect(slack.sources).toEqual([
      expect.objectContaining({ host: 'h2', container: 'cron', new: true }),
    ]);
    expect(slack.badges).toEqual(['new']);
  });

  it('shows a service and a process group on a server, filtered by kind and name (ADR-212)', async () => {
    const native = (workload_kind: string, workload: string, dst: string) => ({
      host: 'h1',
      workload_kind,
      workload,
      dst_kind: 'external',
      dst,
      dst_port: '443',
    });
    await inventory(
      id,
      { host: 'h1', workload_kind: 'Service', workload: 'orders.service' },
      'api.stripe.com',
      443,
      DAY,
    );
    await inventory(
      id,
      { host: 'h1', workload_kind: 'ProcessGroup', workload: 'api' },
      'api.github.com',
      443,
      DAY,
    );
    await write(id, [
      ...edge(native('Service', 'orders.service', 'api.stripe.com'), 1, 0),
      ...edge(native('ProcessGroup', 'api', 'api.github.com'), 1, 0),
    ]);
    const body = (await get({ cluster: id })).json();
    expect(find(body.rows, 'api.stripe.com')!.sources).toEqual([
      expect.objectContaining({ host: 'h1', workloadKind: 'Service', workload: 'orders.service' }),
    ]);
    const groups = (await get({ cluster: id, kind: 'ProcessGroup', workload: 'api' })).json();
    expect(groups.rows.map((r: Row) => r.destination)).toEqual(['api.github.com']);
    expect(groups.rows[0].connections).toBeGreaterThan(0);
  });

  it('filters by host (Compose services by the hosts their series came from), project and container', async () => {
    const h1 = (await get({ cluster: id, host: 'h1' })).json();
    expect(h1.rows.map((r: Row) => r.destination)).toEqual(['api.openai.com']);
    expect(h1.rows[0].connections).toBe(240); // h1's replica only
    const h2 = (await get({ cluster: id, host: 'h2' })).json();
    expect(h2.rows.map((r: Row) => r.destination).sort()).toEqual([
      'api.openai.com',
      'hooks.slack.com',
    ]);
    const project = (await get({ cluster: id, project: 'storefront', service: 'api' })).json();
    expect(project.rows.map((r: Row) => r.destination)).toEqual(['api.openai.com']);
    // The container page: its Compose service's rows, its own traffic (ADR-188).
    const container = (
      await get({
        cluster: id,
        host: 'h2',
        container: 'storefront-api-2',
        project: 'storefront',
        service: 'api',
      })
    ).json();
    expect(container.rows.map((r: Row) => r.destination)).toEqual(['api.openai.com']);
    expect(container.rows[0].connections).toBe(120);
    // A replica with no traffic in the range still shows its service's rows, with 0.
    const idle = (
      await get({
        cluster: id,
        host: 'h3',
        container: 'storefront-api-3',
        project: 'storefront',
        service: 'api',
      })
    ).json();
    expect(idle.rows.map((r: Row) => r.destination)).toEqual(['api.openai.com']);
    expect(idle.rows[0].connections).toBe(0);
    const plain = (await get({ cluster: id, host: 'h2', container: 'cron' })).json();
    expect(plain.rows.map((r: Row) => r.destination)).toEqual(['hooks.slack.com']);
  });
});

describe('GET /api/v1/egress: bounds and roles', () => {
  beforeEach(() => open());

  it('answers 401 signed out, 404 for an unknown cluster, 400 for a bad range or badge', async () => {
    const id = await cluster('kubernetes');
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/v1/egress?cluster=${id}` })).statusCode,
    ).toBe(401);
    expect((await get({ cluster: '00000000-0000-7000-8000-000000000000' })).statusCode).toBe(404);
    expect((await get({})).statusCode).toBe(400);
    expect((await get({ cluster: 'nope' })).statusCode).toBe(400);
    const s = Math.floor(NOW / 1000);
    expect((await get({ cluster: id, from: String(s), to: String(s) })).statusCode).toBe(400);
    expect(
      (await get({ cluster: id, from: String(s - 31 * 86_400), to: String(s) })).statusCode,
    ).toBe(400);
    expect((await get({ cluster: id, to: String(s + 3600) })).statusCode).toBe(400);
    expect((await get({ cluster: id, badge: 'evil' })).statusCode).toBe(400);
    expect((await get({ cluster: id, q: 'x'.repeat(254) })).statusCode).toBe(400);
    // 30 days is the longest range.
    expect(
      (await get({ cluster: id, from: String(s - 30 * 86_400), to: String(s) })).statusCode,
    ).toBe(200);
  });

  it('never answers more than 500 rows; truncated and total say how many matched', async () => {
    const id = await cluster('kubernetes');
    const rows = Array.from({ length: EGRESS_MAX_ROWS + 3 }, (_, i) => ({
      cluster_id: id,
      source: JSON.stringify(shop('fanout')),
      destination: `d${i}.example.org`,
      dst_kind: 'external',
      port: 443,
      destination_class: 'name',
      first_seen: new Date(NOW - 2 * DAY),
      last_seen: new Date(NOW - MIN),
    }));
    await ctx.db.insertInto('egress_destinations').values(rows).execute();
    const body = (await get({ cluster: id })).json();
    expect(body.rows).toHaveLength(EGRESS_MAX_ROWS);
    expect(body.total).toBe(EGRESS_MAX_ROWS + 3);
    expect(body.truncated).toBe(true);
    expect(body.summary.destinations).toBe(EGRESS_MAX_ROWS + 3);
  });

  it('Viewers and Admins read it; another org’s member gets 404', async () => {
    const id = await cluster('server');
    await inventory(id, { host: 'h', container: 'c' }, 'x.example.org', 443, HOUR);
    const orgId = (
      await ctx.db
        .selectFrom('clusters')
        .select('org_id')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).org_id;
    for (const role of ['viewer', 'admin'] as const) {
      const s = await createUserSession(ctx.db, { role, orgId });
      const res = await get({ cluster: id }, s.cookie);
      expect(res.statusCode, role).toBe(200);
      expect(res.json().rows).toHaveLength(1);
    }
    const other = await createUserSession(ctx.db, { role: 'owner' });
    expect((await get({ cluster: id }, other.cookie)).statusCode).toBe(404);
  });

  it('without metrics storage the inventory still answers, with no traffic numbers', async () => {
    await closeTestContext(ctx);
    await open({ victoriaMetricsUrl: undefined });
    const id = await cluster('kubernetes');
    await inventory(id, shop('a'), 'x.example.org', 443, HOUR);
    const body = (await get({ cluster: id })).json();
    expect(body.traffic).toBe(false);
    expect(body.rows[0]).toMatchObject({
      destination: 'x.example.org',
      connections: null,
      sent: null,
      failedRatio: null,
      badges: ['new'],
    });
  });
});

describe('GET /api/v1/egress: after an upgrade, until the first-seen look-back has run', () => {
  // The upgrade at NOW - 3 min; the minute job has written what it saw since then, so every
  // destination's first seen is the upgrade's minute. The look-back (the worker's, every few
  // minutes) moves first seen back to the retained series' first sample. Until it has run,
  // nothing is New: the page's summary and the nav count say 0, as the alert rules wait.
  const UPGRADE = NOW - 3 * MIN;

  /** The look-back's per-day answers: labels and the first sample's time, today's window. */
  const lookback =
    (first: [Record<string, string>, number][]) =>
    async (_scope: ClusterScope, expr: string): Promise<QuerySeries[]> =>
      /offset \d+d/.test(expr)
        ? []
        : first.map(([labels, ms]) => ({ labels, points: [[0, ms / 1000]] }));

  async function upgraded(kind: 'kubernetes' | 'server') {
    await open();
    const id = await cluster(kind, `upgraded-${kind}`);
    await ctx.db
      .updateTable('clusters')
      .set({
        first_seen_at: new Date(NOW - 60 * DAY),
        egress_learning_since: new Date(UPGRADE),
        egress_backfilled_at: null,
      })
      .where('id', '=', id)
      .execute();
    const { org_id } = await ctx.db
      .selectFrom('clusters')
      .select('org_id')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { id, orgId: org_id };
  }

  const lookBack = (orgId: string, answer: ReturnType<typeof lookback>) =>
    runEgressBackfill(
      {
        db: ctx.db,
        victoria: { query: answer },
        orgs: async () => [orgId],
        log: { warn: () => {} },
      },
      NOW,
    );

  it('Kubernetes: no row is New and the count is 0; after the look-back, only the destination first used since the upgrade is', async () => {
    const { id, orgId } = await upgraded('kubernetes');
    await inventory(id, shop('checkout'), 'api.stripe.com', 443, NOW - UPGRADE + MIN);
    await inventory(id, shop('importer'), '185.220.101.0/24', 9001, NOW - UPGRADE + MIN);
    await inventory(id, shop('orders'), 'example.org', 443, 2 * MIN);

    const before = (await get({ cluster: id })).json();
    expect(before.learning.firstSeenPending).toBe(true);
    expect(before.summary).toMatchObject({ destinations: 3, new: 0, rawIp: 1 });
    for (const r of before.rows as Row[]) {
      expect(r.badges).not.toContain('new');
      expect(r.sources.map((s) => s.new)).toEqual([false]);
    }
    // The badge filter agrees with the count.
    expect((await get({ cluster: id, badge: 'new' })).json().rows).toEqual([]);

    const report = await lookBack(
      orgId,
      lookback([
        [
          { ...shop('checkout'), dst_kind: 'external', dst: 'api.stripe.com', dst_port: '443' },
          NOW - 20 * DAY,
        ],
        [
          { ...shop('importer'), dst_kind: 'external', dst: '185.220.101.0/24', dst_port: '9001' },
          NOW - 9 * DAY,
        ],
        [
          { ...shop('orders'), dst_kind: 'external', dst: 'example.org', dst_port: '443' },
          NOW - 2 * MIN,
        ],
      ]),
    );
    expect(report.errors).toEqual([]);

    const after = (await get({ cluster: id })).json();
    expect(after.learning.firstSeenPending).toBe(false);
    expect(after.summary.new).toBe(1);
    expect(find(after.rows, 'example.org')!.badges).toEqual(['new']);
    expect(find(after.rows, 'api.stripe.com')!.badges).toEqual([]);
    expect(find(after.rows, '185.220.101.0/24')!.badges).toEqual(['raw_ip']);
  });

  it('Docker: the same for a Compose service and a plain container', async () => {
    const { id, orgId } = await upgraded('server');
    const api = { compose_project: 'storefront', compose_service: 'api' };
    await inventory(id, api, 'api.openai.com', 443, NOW - UPGRADE + MIN);
    await inventory(id, { host: 'h2', container: 'cron' }, 'hooks.slack.com', 443, 2 * MIN);

    const before = (await get({ cluster: id })).json();
    expect(before.learning.firstSeenPending).toBe(true);
    expect(before.summary).toMatchObject({ destinations: 2, new: 0 });
    expect(find(before.rows, 'api.openai.com')!.sources).toEqual([
      expect.objectContaining({ composeProject: 'storefront', composeService: 'api', new: false }),
    ]);
    expect(find(before.rows, 'hooks.slack.com')!.sources).toEqual([
      expect.objectContaining({ host: 'h2', container: 'cron', new: false }),
    ]);

    await lookBack(
      orgId,
      lookback([
        [
          {
            host: 'h1',
            container: 'storefront-api-1',
            ...api,
            dst_kind: 'external',
            dst: 'api.openai.com',
            dst_port: '443',
          },
          NOW - 12 * DAY,
        ],
        [
          {
            host: 'h2',
            container: 'cron',
            dst_kind: 'external',
            dst: 'hooks.slack.com',
            dst_port: '443',
          },
          NOW - 2 * MIN,
        ],
      ]),
    );

    const after = (await get({ cluster: id })).json();
    expect(after.learning.firstSeenPending).toBe(false);
    expect(after.summary.new).toBe(1);
    expect(find(after.rows, 'api.openai.com')!.badges).toEqual([]);
    expect(find(after.rows, 'hooks.slack.com')!.sources).toEqual([
      expect.objectContaining({ host: 'h2', container: 'cron', new: true }),
    ]);
  });
});
