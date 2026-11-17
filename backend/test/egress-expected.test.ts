// SPDX-License-Identifier: AGPL-3.0-only
// Expected destinations (ADR-186; v0.7 slice 4): the matcher (exact names, `*.` suffixes,
// CIDRs, ports, one source or all), the routes by role, their validation and audit events,
// the inventory rows' copy kept in sync, patterns covering destinations not seen yet, and the
// "New" default (private networks and local names are never New). Kubernetes and Docker.
// Cloud's org scoping is the isolation suite's (test/isolation/cross-org.test.ts, "egress").
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QuerySeries } from '../src/lib/victoria.js';
import {
  bestExpectation,
  parsePattern,
  patternMatches,
  type ParsedExpectation,
  type ParsedPattern,
} from '../src/modules/egress/expected.js';
import { classifyDestination, runEgressMinute } from '../src/modules/egress/inventory.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  type TestContext,
} from './helpers.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / 15_000) * 15_000;

const parsed = (p: string): ParsedPattern => {
  const r = parsePattern(p);
  if (!r.ok) throw new Error(`${p}: ${r.reason}`);
  return r.pattern;
};
const match = (p: string, dst: string) =>
  patternMatches(parsed(p), dst, classifyDestination('external', dst));

describe('patterns (ADR-186): parsed, never compiled', () => {
  it('accepts exact names, *. suffixes and CIDRs, in their canonical form', () => {
    expect(parsed('API.Stripe.com.')).toEqual({ kind: 'name', text: 'api.stripe.com' });
    expect(parsed(' *.AmazonAWS.com ')).toMatchObject({ kind: 'suffix', text: '*.amazonaws.com' });
    expect(parsed('_dmarc.example.org').kind).toBe('name');
    expect(parsed('redis').kind).toBe('name'); // a local name, exactly
    expect(parsed('203.0.113.77/24')).toMatchObject({ kind: 'cidr', text: '203.0.113.0/24' });
    expect(parsed('10.0.0.0/8').text).toBe('10.0.0.0/8');
    expect(parsed('2001:0DB8:0001:0000::/48').text).toBe('2001:db8:1::/48');
    expect(parsed('2001:db8::/32').text).toBe('2001:db8::/32');
  });

  it('refuses anything else, with a reason', () => {
    const refused: [string, RegExp][] = [
      ['', /Type a name/],
      ['*.com', /covers too much/],
      ['*', /Only a leading/],
      ['a.*.example.com', /Only a leading/],
      ['*example.com', /Only a leading/],
      ['(.*)\\.example\\.com', /Only a leading/],
      ['(a|b).example.com', /Not a DNS name/],
      ['api.example.com/x', /Not a DNS name/],
      ['ex ample.com', /Not a DNS name/],
      ['-bad.example.com', /Not a DNS name/],
      [`${'a'.repeat(64)}.example.com`, /Not a DNS name/],
      ['x'.repeat(254), /At most 253/],
      ['203.0.113.7', /CIDR, such as 203\.0\.113\.0\/24/],
      ['2001:db8::1', /\/48/],
      ['10.0.0.0/7', /at least \/8/],
      ['2001:db8::/31', /at least \/32/],
      ['10.0.0.0/33', /Not a valid CIDR/],
      ['10.0.0.0/x', /Not a valid CIDR/],
    ];
    for (const [input, reason] of refused) {
      const r = parsePattern(input);
      expect(r.ok, input).toBe(false);
      if (!r.ok) expect(r.reason, input).toMatch(reason);
    }
  });

  it('a *. suffix covers names under it at any depth, never the suffix itself', () => {
    expect(match('*.amazonaws.com', 's3.amazonaws.com')).toBe(true);
    expect(match('*.amazonaws.com', 's3.eu-central-1.amazonaws.com')).toBe(true);
    expect(match('*.amazonaws.com', 'amazonaws.com')).toBe(false);
    expect(match('*.amazonaws.com', 'notamazonaws.com')).toBe(false);
    expect(match('*.amazonaws.com', 'amazonaws.com.evil.example')).toBe(false);
    expect(match('api.stripe.com', 'api.stripe.com')).toBe(true);
    expect(match('api.stripe.com', 'x.api.stripe.com')).toBe(false);
    expect(match('redis', 'redis')).toBe(true);
  });

  it('a CIDR covers raw networks inside it; names and "Internet" never match across', () => {
    expect(match('203.0.113.0/24', '203.0.113.0/24')).toBe(true);
    expect(match('203.0.0.0/16', '203.0.113.0/24')).toBe(true);
    expect(match('203.0.113.0/28', '203.0.113.0/24')).toBe(false); // narrower than the network
    expect(match('198.51.0.0/16', '203.0.113.0/24')).toBe(false);
    expect(match('10.0.0.0/8', '10.244.1.0/24')).toBe(true);
    expect(match('2001:db8::/32', '2001:db8:1::/48')).toBe(true);
    expect(match('2001:db8::/32', '2001:db9:1::/48')).toBe(false);
    expect(match('10.0.0.0/8', 'ten.example.org')).toBe(false);
    expect(patternMatches(parsed('203.0.113.0/24'), '203.0.113.0/24', 'name')).toBe(false);
    expect(patternMatches(parsed('internet'), 'Internet', 'internet')).toBe(false);
  });

  it('the most specific expectation wins: one source, one port, exact, longer suffix', () => {
    const at = new Date(NOW);
    const e = (id: string, pattern: string, port: number | null, source: object | null) =>
      ({
        id,
        pattern,
        port,
        source,
        created_by: null,
        created_at: at,
        comment: null,
        parsed: parsed(pattern),
      }) as ParsedExpectation;
    const src = { namespace: 'shop', workload_kind: 'Deployment', workload: 'orders' };
    const list = [
      e('all', '*.amazonaws.com', null, null),
      e('deeper', '*.eu.amazonaws.com', null, null),
      e('port', '*.amazonaws.com', 443, null),
      e('mine', '*.amazonaws.com', null, {
        workload: 'orders',
        namespace: 'shop',
        workload_kind: 'Deployment',
      }),
    ];
    const row = (destination: string, port = 443, source = src) => ({
      source,
      destination,
      port,
      destination_class: 'name',
    });
    expect(bestExpectation(list, row('s3.eu.amazonaws.com'))?.id).toBe('mine');
    const other = { ...src, workload: 'billing' };
    expect(bestExpectation(list, row('s3.eu.amazonaws.com', 443, other))?.id).toBe('port');
    expect(bestExpectation(list, row('s3.eu.amazonaws.com', 80, other))?.id).toBe('deeper');
    expect(bestExpectation(list, row('s3.us.amazonaws.com', 80, other))?.id).toBe('all');
    expect(bestExpectation(list, row('example.org', 443, other))).toBeNull();
  });
});

// ------------------------------------------------------------------------------- routes

let ctx: TestContext;
let cookie: string;

beforeEach(async () => {
  ctx = await createTestContext({}, { now: () => NOW });
  cookie = await setupAdmin(ctx.app);
});
afterEach(() => closeTestContext(ctx));

/** The first-seen look-back has run, as it has a few minutes after a cluster first reports. */
const lookedBack = (clusterId: string) =>
  ctx.db
    .updateTable('clusters')
    .set({ egress_backfilled_at: new Date(Date.now() - DAY) })
    .where('id', '=', clusterId)
    .where('egress_backfilled_at', 'is', null)
    .execute();

async function cluster(kind: 'kubernetes' | 'server') {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/clusters',
    cookies: { wl_session: cookie },
    payload: { name: kind, kind },
  });
  const id = res.json().cluster.id as string;
  await lookedBack(id);
  const { org_id } = await ctx.db
    .selectFrom('clusters')
    .select('org_id')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return { id, orgId: org_id };
}

async function inventory(
  clusterId: string,
  source: Record<string, string>,
  destination: string,
  port: number,
  firstAgoMs = 3 * DAY,
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
      last_seen: new Date(NOW - 60_000),
    })
    .execute();
  await ctx.db
    .insertInto('egress_sources')
    .values({
      cluster_id: clusterId,
      source: JSON.stringify(source),
      first_seen: new Date(NOW - firstAgoMs),
      last_seen: new Date(NOW),
    })
    .onConflict((oc) => oc.columns(['cluster_id', 'source']).doNothing())
    .execute();
}

const mark = (body: Record<string, unknown>, as = cookie) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/egress/expected',
    cookies: { wl_session: as },
    payload: body,
  });
const unmark = (id: string, as = cookie) =>
  ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/egress/expected/${id}`,
    cookies: { wl_session: as },
  });
const list = async (clusterId: string, as = cookie) =>
  ctx.app.inject({
    method: 'GET',
    url: '/api/v1/egress/expected',
    query: { cluster: clusterId },
    cookies: { wl_session: as },
  });
const rows = async (clusterId: string, query: Record<string, string> = {}) =>
  (
    await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/egress',
      query: { cluster: clusterId, from: String(NOW / 1000 - 7 * 86_400), ...query },
      cookies: { wl_session: cookie },
    })
  ).json().rows as {
    destination: string;
    port: number;
    badges: string[];
    expected: { pattern: string; at: string; by: string | null; ids: string[] } | null;
  }[];
const copies = (clusterId: string) =>
  ctx.db
    .selectFrom('egress_destinations')
    .select(['destination', 'port', 'source', 'pattern', 'approved_by', 'approved_at'])
    .where('cluster_id', '=', clusterId)
    .orderBy('destination')
    .orderBy('port')
    .execute();

const orders = { namespace: 'shop', workload_kind: 'Deployment', workload: 'orders' };
const billing = { namespace: 'shop', workload_kind: 'Deployment', workload: 'billing' };
const ordersApi = { namespace: 'shop', workloadKind: 'Deployment', workload: 'orders' };

describe('the expectation routes (ADR-186, ADR-189)', () => {
  it('Kubernetes: one destination for one workload, then a pattern for every workload, then Undo', async () => {
    const { id } = await cluster('kubernetes');
    await inventory(id, orders, 'api.stripe.com', 443);
    await inventory(id, billing, 'api.stripe.com', 443);
    await inventory(id, orders, 's3.eu-central-1.amazonaws.com', 443);
    await inventory(id, billing, 'sqs.amazonaws.com', 443);
    await inventory(id, orders, 'example.org', 443);

    // One destination, one workload: that row only; the destination isn't Expected until
    // every source that uses it is covered.
    const one = await mark({
      cluster: id,
      pattern: 'API.stripe.com',
      port: 443,
      source: ordersApi,
    });
    expect(one.statusCode, one.body).toBe(201);
    expect(one.json()).toMatchObject({
      updated: 1,
      expectation: {
        pattern: 'api.stripe.com',
        port: 443,
        source: ordersApi,
        matches: 1,
        createdBy: expect.any(String),
      },
    });
    let page = await rows(id);
    expect(page.find((r) => r.destination === 'api.stripe.com')!.badges).not.toContain('expected');
    expect(await rows(id, { workload: 'orders' })).toContainEqual(
      expect.objectContaining({
        destination: 'api.stripe.com',
        badges: ['expected'],
        expected: expect.objectContaining({
          pattern: 'api.stripe.com',
          ids: [one.json().expectation.id],
        }),
      }),
    );

    // A pattern for every workload covers both amazonaws rows, not example.org.
    const all = await mark({ cluster: id, pattern: '*.amazonaws.com' });
    expect(all.statusCode).toBe(201);
    expect(all.json().updated).toBe(2);
    page = await rows(id);
    const s3 = page.find((r) => r.destination === 's3.eu-central-1.amazonaws.com')!;
    expect(s3.expected).toMatchObject({
      pattern: '*.amazonaws.com',
      ids: [all.json().expectation.id],
    });
    expect(s3.expected!.by).toBeTruthy();
    expect(page.find((r) => r.destination === 'example.org')!.expected).toBeNull();
    expect((await rows(id, { badge: 'not_expected' })).map((r) => r.destination).sort()).toEqual([
      'api.stripe.com',
      'example.org',
    ]);

    // The copy on the inventory rows.
    const c = await copies(id);
    expect(c.filter((r) => r.pattern).map((r) => [r.destination, r.pattern])).toEqual([
      ['api.stripe.com', 'api.stripe.com'],
      ['s3.eu-central-1.amazonaws.com', '*.amazonaws.com'],
      ['sqs.amazonaws.com', '*.amazonaws.com'],
    ]);
    expect(c.every((r) => !r.pattern || (r.approved_by && r.approved_at))).toBe(true);

    // The list, newest first.
    const l = (await list(id)).json().items;
    expect(l.map((e: { pattern: string }) => e.pattern)).toEqual([
      '*.amazonaws.com',
      'api.stripe.com',
    ]);
    expect(l[0]).toMatchObject({ port: null, source: null, matches: 2 });

    // Undo: the pattern's rows lose their copy; the other expectation stays.
    expect((await unmark(all.json().expectation.id)).statusCode).toBe(204);
    expect((await copies(id)).filter((r) => r.pattern).map((r) => r.destination)).toEqual([
      'api.stripe.com',
    ]);
    expect((await unmark(all.json().expectation.id)).statusCode).toBe(404);

    // Each change is audited, with what changed.
    const audits = await ctx.db
      .selectFrom('audit_events')
      .select(['action', 'actor_name', 'details'])
      .where('action', 'like', 'egress_expected_%')
      .orderBy('at')
      .execute();
    expect(audits.map((a) => a.action)).toEqual([
      'egress_expected_added',
      'egress_expected_added',
      'egress_expected_removed',
    ]);
    expect(audits[0]!.details).toMatchObject({
      cluster: id,
      pattern: 'api.stripe.com',
      port: 443,
      source: 'shop/Deployment/orders',
    });
    expect(audits[2]!.details).toMatchObject({
      pattern: '*.amazonaws.com',
      source: 'every source',
    });
    expect(audits[0]!.actor_name).toBeTruthy();
  });

  it('ports: one port covers only that port; any port covers all of them', async () => {
    const { id } = await cluster('kubernetes');
    await inventory(id, orders, 'mail.example.org', 25);
    await inventory(id, orders, 'mail.example.org', 587);
    const r = await mark({ cluster: id, pattern: 'mail.example.org', port: 587 });
    expect(r.json().updated).toBe(1);
    expect((await copies(id)).map((x) => [x.port, x.pattern])).toEqual([
      [25, null],
      [587, 'mail.example.org'],
    ]);
    expect((await mark({ cluster: id, pattern: 'mail.example.org' })).json().updated).toBe(1);
    expect((await copies(id)).every((x) => x.pattern === 'mail.example.org')).toBe(true);
  });

  it('a pattern covers destinations not seen yet: the minute job writes them expected', async () => {
    const { id, orgId } = await cluster('kubernetes');
    expect((await mark({ cluster: id, pattern: '*.googleapis.com' })).json().updated).toBe(0);
    const series = (dst: string): QuerySeries => ({
      labels: { ...orders, dst_kind: 'external', dst, dst_port: '443' },
      points: [[NOW / 1000, 3]],
    });
    const report = await runEgressMinute(
      {
        db: ctx.db,
        victoria: {
          query: async () => [series('maps.googleapis.com'), series('example.net')],
        },
        orgs: async () => [orgId],
        log: { warn: () => undefined },
      },
      NOW,
    );
    expect(report.errors).toEqual([]);
    expect((await copies(id)).map((x) => [x.destination, x.pattern, !!x.approved_at])).toEqual([
      ['example.net', null, false],
      ['maps.googleapis.com', '*.googleapis.com', true],
    ]);
  });

  it('Docker: one Compose service, every container, and a plain container on its host', async () => {
    const { id } = await cluster('server');
    const api = { compose_project: 'storefront', compose_service: 'api' };
    const worker = { compose_project: 'storefront', compose_service: 'worker' };
    const cron = { host: 'docker-02', container: 'cron' };
    await inventory(id, api, 'hooks.slack.com', 443);
    await inventory(id, worker, 'hooks.slack.com', 443);
    await inventory(id, cron, 'hooks.slack.com', 443);
    await inventory(id, cron, '203.0.113.0/24', 9001);

    const svc = await mark({
      cluster: id,
      pattern: 'hooks.slack.com',
      source: { composeProject: 'storefront', composeService: 'api' },
    });
    expect(svc.statusCode, svc.body).toBe(201);
    expect(svc.json()).toMatchObject({
      updated: 1,
      expectation: { source: { composeProject: 'storefront', composeService: 'api' } },
    });
    const plain = await mark({
      cluster: id,
      pattern: '203.0.113.0/24',
      source: { host: 'docker-02', container: 'cron' },
    });
    expect(plain.json().updated).toBe(1);
    // An expected raw network still carries Raw IP (ADR-186: a name doesn't make it safe).
    const raw = (await rows(id)).find((r) => r.destination === '203.0.113.0/24')!;
    expect(raw.badges).toEqual(expect.arrayContaining(['raw_ip', 'expected']));

    expect((await mark({ cluster: id, pattern: 'hooks.slack.com' })).json().updated).toBe(2);
    const slack = (await rows(id)).find((r) => r.destination === 'hooks.slack.com')!;
    expect(slack.badges).toContain('expected');
    // Every source is covered: Undo removes both expectations that cover it.
    expect(slack.expected!.ids).toHaveLength(2);
    for (const e of slack.expected!.ids) expect((await unmark(e)).statusCode).toBe(204);
    expect((await copies(id)).filter((x) => x.pattern).map((x) => x.destination)).toEqual([
      '203.0.113.0/24',
    ]);
  });

  it('validation: patterns, sources in the cluster’s vocabulary, duplicates', async () => {
    const k = await cluster('kubernetes');
    const d = await cluster('server');
    const bad = async (body: Record<string, unknown>, reason: RegExp, code = 400) => {
      const r = await mark(body);
      expect(r.statusCode, JSON.stringify(body)).toBe(code);
      expect(r.json().detail, JSON.stringify(body)).toMatch(reason);
    };
    await bad({ cluster: k.id, pattern: '*.com' }, /covers too much/);
    await bad({ cluster: k.id, pattern: '^.*$' }, /Only a leading|Not a DNS name/);
    await bad({ cluster: k.id, pattern: '1.2.3.4' }, /CIDR/);
    await bad(
      { cluster: k.id, pattern: 'x.example.org', source: { host: 'h', container: 'c' } },
      /Kubernetes source/,
    );
    await bad(
      { cluster: k.id, pattern: 'x.example.org', source: { namespace: 'shop' } },
      /workloadKind/,
    );
    await bad({ cluster: d.id, pattern: 'x.example.org', source: ordersApi }, /Docker source/);
    await bad(
      { cluster: d.id, pattern: 'x.example.org', source: { composeProject: 'p' } },
      /composeService/,
    );
    await bad(
      { cluster: d.id, pattern: 'x.example.org', source: { host: 'h' } },
      /host and container/,
    );
    for (const body of [
      { cluster: k.id, pattern: 'x.example.org', port: 0 },
      { cluster: k.id, pattern: 'x.example.org', port: 70000 },
      { cluster: k.id, pattern: 'x'.repeat(254) },
      { cluster: k.id, pattern: 'x.example.org', comment: 'c'.repeat(501) },
      { cluster: k.id, pattern: 'x.example.org', source: { pod: 'p' } },
    ]) {
      expect((await mark(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await mark({ cluster: k.id, pattern: 'X.example.org' })).statusCode).toBe(201);
    await bad({ cluster: k.id, pattern: 'x.example.org.' }, /already expected/, 409);
    // Same pattern, another port or source: a different expectation.
    expect((await mark({ cluster: k.id, pattern: 'x.example.org', port: 443 })).statusCode).toBe(
      201,
    );
    expect(
      (await mark({ cluster: k.id, pattern: 'x.example.org', source: ordersApi })).statusCode,
    ).toBe(201);
    expect((await list(k.id)).json().items).toHaveLength(3);
    expect((await list(d.id)).json().items).toHaveLength(0);
  });

  it('roles: Owners and Admins change, Viewers read only, tokens and other orgs never', async () => {
    const { id, orgId } = await cluster('kubernetes');
    await inventory(id, orders, 'api.stripe.com', 443);
    const viewer = await createUserSession(ctx.db, { role: 'viewer', orgId });
    const admin = await createUserSession(ctx.db, { role: 'admin', orgId });
    const other = await createUserSession(ctx.db, { role: 'owner' });

    const v = await mark({ cluster: id, pattern: 'api.stripe.com' }, viewer.cookie);
    expect(v.statusCode).toBe(403);
    expect(v.json().detail).toMatch(/Viewers can't change this/);
    const a = await mark({ cluster: id, pattern: 'api.stripe.com' }, admin.cookie);
    expect(a.statusCode).toBe(201);
    const eid = a.json().expectation.id as string;
    expect((await list(id, viewer.cookie)).json().items).toHaveLength(1);
    expect((await unmark(eid, viewer.cookie)).statusCode).toBe(403);

    // Another org: its cluster and its ids are 404, and nothing changes.
    expect((await list(id, other.cookie)).statusCode).toBe(404);
    expect((await mark({ cluster: id, pattern: 'x.example.org' }, other.cookie)).statusCode).toBe(
      404,
    );
    expect((await unmark(eid, other.cookie)).statusCode).toBe(404);

    // An API token is read-only (ADR-125): it reads nothing here yet and writes nothing.
    const token = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/api-tokens',
        cookies: { wl_session: cookie },
        payload: { name: 'reader' },
      })
    ).json().value as string;
    const t = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/egress/expected',
      headers: { authorization: `Bearer ${token}` },
      payload: { cluster: id, pattern: 'y.example.org' },
    });
    expect(t.statusCode).toBe(403);
    const td = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/egress/expected/${eid}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(td.statusCode).toBe(403);
    expect((await list(id)).json().items).toHaveLength(1);
    expect((await copies(id))[0]!.pattern).toBe('api.stripe.com');
    expect((await unmark(eid, admin.cookie)).statusCode).toBe(204);
  });

  it('at most 1000 expectations per cluster', async () => {
    const { id, orgId } = await cluster('server');
    await ctx.db
      .insertInto('egress_expected')
      .values(
        Array.from({ length: 1000 }, (_, i) => ({
          org_id: orgId,
          cluster_id: id,
          pattern: `n${i}.example.org`,
        })),
      )
      .execute();
    const r = await mark({ cluster: id, pattern: 'one-more.example.org' });
    expect(r.statusCode).toBe(409);
    expect(r.json().detail).toMatch(/at most 1000/);
  });
});

describe('"New" skips private networks and local names (ADR-188, slice 4 default)', () => {
  it('only names and public networks are New; the summary (the nav count) follows', async () => {
    for (const kind of ['kubernetes', 'server'] as const) {
      const { id } = await cluster(kind);
      const src = kind === 'kubernetes' ? orders : { host: 'h1', container: 'web' };
      await inventory(id, src, 'fresh.example.org', 443, HOUR);
      await inventory(id, src, '203.0.113.0/24', 443, HOUR);
      await inventory(id, src, '10.244.1.0/24', 5432, HOUR);
      await inventory(id, src, 'redis', 6379, HOUR);
      await inventory(id, src, 'Internet', 0, HOUR);
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/egress',
        query: { cluster: id },
        cookies: { wl_session: cookie },
      });
      const body = res.json();
      const isNew = Object.fromEntries(
        body.rows.map((r: { destination: string; badges: string[] }) => [
          r.destination,
          r.badges.includes('new'),
        ]),
      );
      expect(isNew, kind).toEqual({
        'fresh.example.org': true,
        '203.0.113.0/24': true,
        '10.244.1.0/24': false,
        redis: false,
        Internet: false,
      });
      expect(body.summary.new, kind).toBe(2);
    }
  });
});
