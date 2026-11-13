// SPDX-License-Identifier: AGPL-3.0-only
// GET /api/v1/clusters/:id/search (ADR-169): the ⌘K palette's name search. The patterns
// (letters in order, one typo), the ranking and the caps as pure functions; then the route
// on the kind fixtures and a Docker fleet: sign-in, 404, each kind's fields, the order.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  lettersPattern,
  likeEscape,
  patterns,
  typoPatterns,
  words,
} from '../src/modules/search/match.js';
import { pick, type Row } from '../src/modules/search/routes.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';
import { container, dockerFleet, kindCluster } from './support/mcp-fixtures.js';

/** What LIKE does, for checking the patterns without PostgreSQL. */
const like = (text: string, pattern: string) => {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') re += pattern[++i]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    else if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's').test(text);
};
const matches = (name: string, q: string) =>
  patterns(q)!.words.every((w) => [w.letters, ...w.typos].some((p) => like(name, p)));

describe('search patterns', () => {
  it('splits, lower-cases and caps the words', () => {
    expect(words('  Payments   API ')).toEqual(['payments', 'api']);
    expect(words('a b c d e')).toHaveLength(4);
    expect(words('x'.repeat(100))[0]).toHaveLength(64);
    expect(patterns('   ')).toBeNull();
    expect(patterns('payments api')!.whole).toBe('payments-api');
  });

  it('escapes the wildcards', () => {
    expect(likeEscape('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
    expect(lettersPattern('a_%')).toBe('%a%\\_%\\%%');
    expect(like('a_%', lettersPattern('a_%'))).toBe(true);
    expect(like('abc', lettersPattern('a_'))).toBe(false);
  });

  it('finds a pod name by its letters in order, and with one typo', () => {
    const pod = 'shop/payments-api-7d9f8c6b5-x2k4q';
    for (const q of [
      'payments',
      'pay7d9',
      'payments api',
      'shop pay',
      'paymnts',
      'paymetns',
      'paymants',
      'paymentss',
    ])
      expect(matches(pod, q), q).toBe(true);
    for (const q of ['checkout', 'payments-web', 'qzpay']) expect(matches(pod, q), q).toBe(false);
  });

  it('allows a typo only in words of 4 to 32 letters', () => {
    expect(typoPatterns('api')).toEqual([]);
    expect(typoPatterns('aaaa')).toEqual(['%a%a%a%']);
    expect(typoPatterns('pays')).toHaveLength(4);
    expect(typoPatterns('x'.repeat(33))).toEqual([]);
  });
});

const row = (grp: Row['grp'], name: string, rank: number): Row => ({
  grp,
  kind: 'Pod',
  namespace: 'ns',
  name,
  node: '',
  rank,
});

describe('pick', () => {
  it('keeps 8 per kind and the best ranks within the limit, kind with the best match first', () => {
    const pods = Array.from({ length: 9 }, (_, i) => row('pod', `p${i}`, 4));
    const { kept, truncated } = pick([...pods, row('node', 'node-42', 0)], 40);
    expect(truncated).toBe(true);
    expect(kept).toHaveLength(9);
    expect(kept[0]).toMatchObject({ grp: 'node', name: 'node-42' });
    expect(kept.slice(1).map((r) => r.name)).toEqual(pods.slice(0, 8).map((r) => r.name));

    const many = (
      ['workload', 'pod', 'node', 'host', 'container', 'compose_project'] as const
    ).flatMap((g) => Array.from({ length: 8 }, (_, i) => row(g, `${g}${i}`, g === 'node' ? 1 : 4)));
    const capped = pick(many, 40);
    expect(capped.kept).toHaveLength(40);
    expect(capped.kept.filter((r) => r.grp === 'node')).toHaveLength(8);
    expect(pick(many, 5).kept.every((r) => r.grp === 'node')).toBe(true);
  });

  it('shows one-typo matches only when nothing matches better', () => {
    expect(pick([row('pod', 'a', 6), row('node', 'b', 4)], 40).kept.map((r) => r.name)).toEqual([
      'b',
    ]);
    expect(pick([row('pod', 'a', 6)], 40).kept.map((r) => r.name)).toEqual(['a']);
  });

  it('stays fast on a 15,000-pod answer', () => {
    const rows = Array.from({ length: 15_000 }, (_, i) => row('pod', `pod-${i}`, i % 7));
    const t = performance.now();
    pick(rows, 40);
    expect(performance.now() - t).toBeLessThan(100);
  });
});

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

const get = (cookie: string | null, url: string) =>
  ctx!.app.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    ...(cookie ? { cookies: { wl_session: cookie } } : {}),
  });

describe('GET /clusters/:id/search', () => {
  it('finds workloads, pods and nodes of a Kubernetes cluster, best match first', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const kube = await kindCluster(ctx, cookie);
    expect((await get(null, `/clusters/${kube.id}/search?q=web`)).statusCode).toBe(401);
    expect((await get(cookie, `/clusters/${randomUUID()}/search?q=web`)).statusCode).toBe(404);
    expect((await get(cookie, `/clusters/${kube.id}/search`)).statusCode).toBe(400);
    expect((await get(cookie, `/clusters/${kube.id}/search?q=`)).statusCode).toBe(400);

    const web = (await get(cookie, `/clusters/${kube.id}/search?q=web`)).json();
    expect(web.results[0]).toEqual({
      kind: 'workload',
      name: 'web',
      namespace: 'wl-test',
      host: null,
      type: 'Deployment',
      id: null,
      match: 'exact',
    });
    const pods = web.results.filter((r: { kind: string }) => r.kind === 'pod');
    expect(pods.map((r: { name: string }) => r.name)).toContain('web-674987bb67-b24ww');
    expect(pods[0].match).toBe('prefix');

    // A CronJob's Jobs stay under it; the CronJob is found.
    const cron = (await get(cookie, `/clusters/${kube.id}/search?q=every-minute`)).json();
    const workloads = cron.results.filter((r: { kind: string }) => r.kind === 'workload');
    expect(workloads.map((r: { type: string; name: string }) => `${r.type}/${r.name}`)).toEqual([
      'CronJob/every-minute',
    ]);

    // Nodes; a typo; nothing.
    const node = (await get(cookie, `/clusters/${kube.id}/search?q=worker2`)).json();
    expect(node.results[0]).toMatchObject({ kind: 'node', name: 'watchlog-worker2' });
    const typo = (await get(cookie, `/clusters/${kube.id}/search?q=crashlop`)).json();
    expect(typo.results[0]).toMatchObject({ kind: 'pod', name: 'crashloop' });
    const typo2 = (await get(cookie, `/clusters/${kube.id}/search?q=crahsloop`)).json();
    expect(typo2.results[0]).toMatchObject({ kind: 'pod', name: 'crashloop', match: 'typo' });
    const none = (await get(cookie, `/clusters/${kube.id}/search?q=zzzz%25`)).json();
    expect(none).toEqual({ query: 'zzzz%', results: [], truncated: false });

    // Applications, by name or type.
    const orgId = (await get(cookie, '/me')).json().user.org.id as string;
    const appId = randomUUID();
    await ctx.db
      .insertInto('integrations')
      .values({
        id: appId,
        org_id: orgId,
        cluster_id: kube.id,
        type: 'redis',
        name: 'shop/cache',
        target: JSON.stringify({
          kind: 'workload',
          namespace: 'shop',
          workload: 'cache',
          port: 6379,
        }),
      })
      .execute();
    const app = (await get(cookie, `/clusters/${kube.id}/search?q=redis`)).json();
    expect(app.results).toEqual([
      {
        kind: 'application',
        name: 'shop/cache',
        namespace: 'shop',
        host: null,
        type: 'redis',
        id: appId,
        match: 'path',
      },
    ]);

    // The limit, and at most 8 per kind.
    const all = (await get(cookie, `/clusters/${kube.id}/search?q=e`)).json();
    const perKind = new Map<string, number>();
    for (const r of all.results) perKind.set(r.kind, (perKind.get(r.kind) ?? 0) + 1);
    expect(Math.max(...perKind.values())).toBeLessThanOrEqual(8);
    expect(all.truncated).toBe(true);
    const two = (await get(cookie, `/clusters/${kube.id}/search?q=e&limit=2`)).json();
    expect(two.results).toHaveLength(2);
  });

  it('finds hosts, containers and Compose projects of a Docker fleet', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const fleet = await dockerFleet(ctx, cookie, {
      'docker-01': [
        container('a', 'shop-api-1', { compose_project: 'shop', compose_service: 'api' }),
        container('b', 'shop-worker-1', { compose_project: 'shop', compose_service: 'worker' }),
        container('c', 'standalone', { compose_project: undefined, compose_service: undefined }),
      ],
      'docker-02': [container('d', 'billing-api-1', { compose_project: 'billing' })],
    });
    const shop = (await get(cookie, `/clusters/${fleet.id}/search?q=shop`)).json();
    expect(shop.results[0]).toEqual({
      kind: 'compose_project',
      name: 'shop',
      namespace: null,
      host: 'docker-01',
      type: null,
      id: null,
      match: 'exact',
    });
    expect(shop.results.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'container',
          name: 'shop-api-1',
          namespace: 'shop',
          host: 'docker-01',
        }),
      ]),
    );
    const host = (await get(cookie, `/clusters/${fleet.id}/search?q=docker-02`)).json();
    expect(host.results[0]).toMatchObject({ kind: 'host', name: 'docker-02', match: 'exact' });
    const api = (await get(cookie, `/clusters/${fleet.id}/search?q=api`)).json();
    expect(api.results.map((r: { name: string }) => r.name).sort()).toEqual([
      'billing-api-1',
      'shop-api-1',
    ]);
    // Kubernetes kinds never come from a fleet.
    expect(api.results.every((r: { kind: string }) => r.kind === 'container')).toBe(true);
  });
});
