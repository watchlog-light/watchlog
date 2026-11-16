// SPDX-License-Identifier: AGPL-3.0-only
// The cross-org isolation suite (ADR-182), the release gate of WatchLog Cloud: the backend
// in Cloud mode as watchlog_app under Row-Level Security, two orgs (cloud.ts), and every
// REST route, MCP tool, curated query key, ingest path and event stream called as org B
// with org A's ids. B never gets A's data and never changes it; the database itself shows
// no tenant row to a connection that names no org.
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { isCloudOnly } from '../../src/plugins/edition.js';
import { SUPPORT_ALLOWED } from '../../src/plugins/support.js';
import { withOrg, markReadOnly, enterRequestScope } from '../../src/db/org-context.js';
import { enterSupportSession, openSupportSession } from '../../src/modules/support/service.js';
import { METRIC_KEYS } from '../../src/modules/query/catalog.js';
import { PRO_REFUSAL } from '../../src/modules/mcp/tools/whatchanged.js';
import { TEST_VM_URL } from '../helpers.js';
import { newId } from '../../src/lib/ids.js';
import { createSession } from '../../src/modules/auth/sessions.js';
import { createResetLink } from '../../src/modules/users/service.js';
import {
  cloudWorld,
  hashOf,
  seedOrg,
  unknownLinkToken,
  writeSeries,
  type CloudWorld,
  type SeededOrg,
} from './cloud.js';
import { GLOBAL_TABLES } from './tables.js';
import { MCP_TOOLS, ROUTES, STREAMS, type RouteClass } from './classification.js';

let w: CloudWorld;
let A: SeededOrg;
let B: SeededOrg;

beforeAll(async () => {
  w = await cloudWorld();
  A = await seedOrg(w, 'zzalpha');
  B = await seedOrg(w, 'zzbeta');
}, 120_000);

afterAll(async () => {
  await w?.close();
});

// ------------------------------------------------------------------------------- helpers

/** A's markers found in a text. */
/**
 * A's markers in an answer, leaving out what the request itself sent (an id B asked about,
 * echoed in a 404's `instance`, reveals nothing).
 */
const leaks = (text: string, sent = '', of: SeededOrg = A) =>
  of.markers.filter((m) => text.includes(m) && !sent.includes(m));

/** The URL of a route with the given org's ids in its path parameters. */
function pathFor(route: string, o: SeededOrg): string {
  const url = route.split(' ')[1]!;
  const docker = url.includes('/docker/');
  return url
    .replace(/^\/api\/v1\/clusters\/:id/, `/api/v1/clusters/${docker ? o.docker.id : o.k8s.id}`)
    .replace(':tokenId', o.k8s.tokenId)
    .replace('/nodes/:name', `/nodes/${o.node}`)
    .replace('/pods/:namespace/:name', `/pods/${o.pod.namespace}/${o.pod.name}`)
    .replace('/hosts/:host/containers/:name', `/hosts/${o.host}/containers/${o.container}`)
    .replace('/alerts/:id', `/alerts/${o.alertId}`)
    .replace('/silences/:id', `/silences/${o.silenceId}`)
    .replace('/alert-rules/:id', `/alert-rules/${o.ruleId}`)
    .replace('/alert-channels/:id', `/alert-channels/${o.channelId}`)
    .replace('/discovered/ignore/:id', `/discovered/ignore/${o.ignoreId}`)
    .replace('/egress/expected/:id', `/egress/expected/${o.expectedIds[0]}`)
    .replace('/probes/:id', `/probes/${o.probeId}`)
    .replace('/applications/:id', `/applications/${o.serviceId}`)
    .replace('/api-tokens/:id', `/api-tokens/${o.apiToken.id}`)
    .replace('/users/invites/:id', `/users/invites/${o.inviteId}`)
    .replace('/orgs/:id', `/orgs/${o.orgId}`)
    .replace('/auth/sessions/:id', `/auth/sessions/${o.kept.id}`)
    .replace(':provider', 'github')
    .replace('/users/:id', `/users/${o.viewerId}`)
    .replace(':token', unknownLinkToken())
    .replace(':requestId', '00000000-0000-4000-8000-000000000000');
}

/** An id for a schema field, by its name: the org's own row of that kind. */
function idFor(key: string, o: SeededOrg): string {
  const k = key.toLowerCase();
  if (k.includes('cluster')) return o.k8s.id;
  if (k.includes('rule')) return o.ruleId;
  if (k.includes('channel')) return o.channelId;
  if (k.includes('alert')) return o.alertId;
  if (/service|integration|application/.test(k)) return o.serviceId;
  if (k.includes('probe')) return o.probeId;
  if (k.includes('token')) return o.apiToken.id;
  if (k.includes('user')) return o.viewerId;
  return o.k8s.id;
}

type Schema = Record<string, unknown> & {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  items?: Schema;
};

/** A minimal valid value for a JSON schema, with the org's ids in its uuid fields. */
function sample(s: Schema | undefined, key: string, o: SeededOrg): unknown {
  if (!s) return undefined;
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  const variants = s.anyOf ?? s.oneOf;
  if (variants) return sample(variants.find((x) => x.type !== 'null') ?? variants[0], key, o);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const p of s.required ?? []) out[p] = sample(s.properties?.[p], p, o);
      return out;
    }
    case 'array':
      return Array.from({ length: Math.max(1, Number(s.minItems ?? 0)) }, () =>
        sample(s.items, key, o),
      );
    case 'string': {
      if (s.format === 'uuid') return idFor(key, o);
      if (s.format === 'email') return 'someone@probe.test';
      if (s.format === 'date-time') return new Date().toISOString();
      if (s.format === 'uri') return 'https://probe.example.com/x';
      const min = Number(s.minLength ?? 1);
      return 'probe'.padEnd(min, 'x').slice(0, Math.max(min, Number(s.maxLength ?? 64)));
    }
    case 'integer':
    case 'number':
      return Number(s.minimum ?? 1);
    case 'boolean':
      return false;
    default:
      return undefined;
  }
}

function requestFor(route: string, cls: RouteClass, o: SeededOrg) {
  const schema = w.routes.find((r) => r.key === route)?.opts.schema as
    { querystring?: Schema; body?: Schema } | undefined;
  const generated = sample(schema?.querystring, 'query', o) as Record<string, unknown> | undefined;
  const query =
    cls.query ??
    Object.fromEntries(Object.entries(generated ?? {}).map(([k, v]) => [k, String(v)]));
  const body = cls.body ?? (sample(schema?.body, 'body', o) as object | undefined);
  return { url: pathFor(route, o), query, body };
}

/**
 * Calls a route as `as`'s Owner (a fresh session each time) with `ids`' ids; `cookie`
 * names another of the org's users instead (its Admin or Viewer).
 */
async function call(
  route: string,
  as: SeededOrg,
  ids: SeededOrg,
  extra: object = {},
  cookie: () => Promise<string> = () => as.session(),
) {
  const cls = ROUTES[route]!;
  const method = route.split(' ')[0]!;
  const { url, query, body } = requestFor(route, cls, ids);
  const res = await w.app.inject({
    method: method as 'GET',
    url,
    query,
    cookies: { wl_session: await cookie() },
    ...(body !== undefined && method !== 'GET' ? { payload: body } : {}),
    ...extra,
  });
  return Object.assign(res, { sent: url + JSON.stringify(query) + JSON.stringify(body ?? null) });
}

const hasParams = (route: string) => route.includes(':');
const isRead = (route: string) =>
  route.startsWith('GET ') || route === 'POST /api/v1/query/range' || route.endsWith('/preview');

/** Every tenant table (with org_id) and orgs, read as the owner. */
async function tenantTables(): Promise<string[]> {
  const res = await sql<{ name: string }>`
    SELECT c.relname AS name FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
       AND NOT c.relispartition
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                   AND a.attname = 'org_id' AND NOT a.attisdropped)
     ORDER BY 1`.execute(w.owner);
  return res.rows.map((r) => r.name);
}

/** One fingerprint per tenant table of an org's rows, read as the owner. */
async function fingerprint(orgId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of await tenantTables()) {
    const res = await sql<{ h: string | null; n: string }>`
      SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS h, count(*) AS n
        FROM ${sql.table(name)} t WHERE org_id = ${orgId}`.execute(w.owner);
    out[name] = `${res.rows[0]!.n}:${res.rows[0]!.h}`;
  }
  return out;
}

// ------------------------------------------------------------------------------- routes

describe('every REST route as org B with org A ids', () => {
  it('classifies every route of the route table, and none is gone', () => {
    const keys = w.routes.map((r) => r.key);
    const unclassified = keys.filter((k) => !ROUTES[k]);
    expect(unclassified, 'classify these in test/isolation/classification.ts').toEqual([]);
    expect(Object.keys(ROUTES).filter((k) => !keys.includes(k))).toEqual([]);
    // Cloud-only routes are classified `cloud`, and only they are.
    for (const r of w.routes) {
      expect(ROUTES[r.key]!.kind === 'cloud', r.key).toBe(isCloudOnly(r.opts));
    }
  });

  it('reads: 404 or 403 with A ids, never a marker of A, and A itself gets its data', async () => {
    const problems: string[] = [];
    let controls = 0;
    for (const [route, cls] of Object.entries(ROUTES)) {
      if (!isRead(route) || cls.kind === 'mcp' || cls.kind === 'ingest') continue;
      const b = await call(route, B, A);
      const found = leaks(b.body, b.sent);
      if (found.length) problems.push(`${route}: B saw ${found.join(', ')} (${b.statusCode})`);
      if (cls.kind === 'installation' && b.statusCode !== 404)
        problems.push(`${route}: ${b.statusCode}, expected 404 in Cloud`);
      if (cls.kind === 'org' && hasParams(route) && ![403, 404].includes(b.statusCode))
        problems.push(`${route}: B got ${b.statusCode} with A's ids: ${b.body.slice(0, 160)}`);
      // B's own ids: B's own answer, still nothing of A (metrics included).
      if (cls.kind === 'org' && hasParams(route)) {
        const own = await call(route, B, B);
        const mine = leaks(own.body, own.sent);
        if (mine.length) problems.push(`${route}: B's own answer has ${mine.join(', ')}`);
        if (own.statusCode >= 500 && cls.control === undefined)
          problems.push(`${route}: B's own call ${own.statusCode}`);
      }
      // The control: A with the same ids gets an answer, so the ids are A's real ones.
      if (cls.kind === 'org' && hasParams(route) && cls.control === undefined) {
        const a = await call(route, A, A);
        if (a.statusCode >= 300) {
          problems.push(`${route}: control as A got ${a.statusCode}: ${a.body.slice(0, 160)}`);
        }
        controls++;
      }
    }
    expect(problems).toEqual([]);
    expect(controls).toBeGreaterThanOrEqual(20);
  }, 120_000);

  it('A sees its own markers where B sees none (the seed is real)', async () => {
    const seen = async (route: string) => leaks((await call(route, A, A)).body);
    expect(await seen('GET /api/v1/clusters')).toContain(A.k8s.id);
    expect(await seen('GET /api/v1/clusters/:id/docker/containers')).toContain('zzalpha');
    expect(await seen('GET /api/v1/alerts')).toContain(A.alertId);
    expect(await seen('GET /api/v1/alert-channels')).toContain(A.channelId);
    expect(await seen('GET /api/v1/applications')).toContain(A.serviceId);
    const q = await w.app.inject({
      method: 'POST',
      url: '/api/v1/query/range',
      cookies: { wl_session: await A.session() },
      payload: {
        clusterId: A.k8s.id,
        metric: 'pod.cpu.usage',
        from: Math.floor(Date.now() / 1000) - 900,
        to: Math.floor(Date.now() / 1000),
      },
    });
    expect(q.body).toContain('zzalpha-pod');
  });

  it("egress (ADR-192): B can't read A's clusters' destinations, and B's own hold none of A's", async () => {
    const egressOf = async (as: SeededOrg, cluster: string, extra: Record<string, string> = {}) =>
      w.app.inject({
        method: 'GET',
        url: '/api/v1/egress',
        query: { cluster, from: String(Math.floor(Date.now() / 1000) - 7 * 86_400), ...extra },
        cookies: { wl_session: await as.session() },
      });
    for (const id of [A.k8s.id, A.docker.id]) {
      const extras: Record<string, string>[] = [
        {},
        { namespace: 'shop' },
        { project: 'zzalpha-shop', service: 'api' },
      ];
      for (const extra of extras) {
        const b = await egressOf(B, id, extra);
        expect(b.statusCode, id).toBe(404);
        expect(leaks(b.body, id + JSON.stringify(extra))).toEqual([]);
      }
    }
    for (const id of [B.k8s.id, B.docker.id]) {
      const own = await egressOf(B, id);
      expect(own.statusCode).toBe(200);
      expect(leaks(own.body)).toEqual([]);
      expect(own.body).toContain('api.zzbeta.example.org');
    }
    // The control: A reads its own rows on both platforms.
    for (const id of [A.k8s.id, A.docker.id]) {
      const a = await egressOf(A, id);
      expect(a.statusCode).toBe(200);
      expect(a.body).toContain('api.zzalpha.example.org');
    }
  });

  it("what changed (ADR-202): B gets 404 for A's clusters and alert, 403 as Free; each org reads its own", async () => {
    const wc = async (as: SeededOrg, query: Record<string, string>) =>
      w.app.inject({
        method: 'GET',
        url: '/api/v1/what-changed',
        // The window that holds the seeded periods (30 minutes ago, still open).
        query,
        cookies: { wl_session: await as.session() },
      });
    for (const id of [A.k8s.id, A.docker.id]) {
      const b = await wc(B, { cluster: id });
      expect(b.statusCode, id).toBe(404);
      expect(leaks(b.body, id)).toEqual([]);
    }
    // A's alert with B's own cluster, and with A's.
    for (const cluster of [B.k8s.id, A.k8s.id]) {
      const b = await wc(B, { cluster, alert: A.alertId });
      expect(b.statusCode).toBe(404);
      expect(leaks(b.body, cluster + A.alertId)).toEqual([]);
    }
    // Each org reads its own periods, on both platforms, under RLS.
    for (const [o, other] of [
      [A, B],
      [B, A],
    ] as const) {
      for (const id of [o.k8s.id, o.docker.id]) {
        const own = await wc(o, { cluster: id });
        expect(own.statusCode, own.body).toBe(200);
        expect(own.json().rows).toHaveLength(1);
        expect(own.body).toContain(o.label);
        expect(leaks(own.body, '', other)).toEqual([]);
      }
      const around = await wc(o, { cluster: o.k8s.id, alert: o.alertId });
      expect(around.statusCode).toBe(200);
      expect(leaks(around.body, '', other)).toEqual([]);
    }
    // B without pro_features (Free): 403 pro-feature, for its own cluster and for A's.
    const flip = async (on: boolean) => {
      await w.owner
        .updateTable('entitlements')
        .set({ pro_features: on })
        .where('org_id', '=', B.orgId)
        .execute();
      w.app.entitlements!.invalidate(B.orgId);
    };
    await flip(false);
    try {
      for (const id of [B.k8s.id, A.k8s.id, A.docker.id]) {
        const r = await wc(B, { cluster: id });
        expect(r.statusCode).toBe(403);
        expect(r.json().type).toBe('urn:watchlog:problem:pro-feature');
        expect(leaks(r.body, id)).toEqual([]);
      }
    } finally {
      await flip(true);
    }
  });

  it("anomaly feedback (ADR-200): B gets 404 for A's anomaly alert, 403 as Free; B's own answer and undo work under RLS", async () => {
    const as = async (o: SeededOrg, method: 'GET' | 'POST' | 'DELETE', url: string, extra = {}) =>
      w.app.inject({ method, url, cookies: { wl_session: await o.session() }, ...extra });
    const answers = (orgId: string) =>
      w.owner
        .selectFrom('anomaly_feedback')
        .select(['id', 'undone_at'])
        .where('org_id', '=', orgId)
        .execute();
    const aBefore = await answers(A.orgId);
    const page = `/api/v1/alerts/${A.anomalyAlertId}/anomaly`;
    const fb = `/api/v1/alerts/${A.anomalyAlertId}/anomaly-feedback`;
    for (const [method, url, extra] of [
      ['GET', page, {}],
      ['POST', fb, { payload: { answer: 'normal' } }],
      ['DELETE', fb, {}],
    ] as const) {
      const r = await as(B, method, url, extra);
      expect(r.statusCode, `${method} ${url}`).toBe(404);
      expect(leaks(r.body, A.anomalyAlertId)).toEqual([]);
    }
    expect(await answers(A.orgId)).toEqual(aBefore);
    // Each org's own: the page, an answer and its undo, under RLS, on its own rows only.
    for (const [o, other] of [
      [A, B],
      [B, A],
    ] as const) {
      const own = await as(o, 'GET', `/api/v1/alerts/${o.anomalyAlertId}/anomaly`);
      expect(own.statusCode, own.body).toBe(200);
      expect(leaks(own.body, '', other)).toEqual([]);
      const url = `/api/v1/alerts/${o.anomalyAlertId}/anomaly-feedback`;
      const add = await as(o, 'POST', url, { payload: { answer: 'useful' } });
      expect(add.statusCode, add.body).toBe(201);
      expect((await as(o, 'DELETE', url)).statusCode).toBe(204);
      const mine = await answers(o.orgId);
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((r) => r.undone_at !== null)).toBe(true);
    }
    // B without pro_features (Free): 403 pro-feature, for its own alert and for A's.
    const flip = async (on: boolean) => {
      await w.owner
        .updateTable('entitlements')
        .set({ pro_features: on })
        .where('org_id', '=', B.orgId)
        .execute();
      w.app.entitlements!.invalidate(B.orgId);
    };
    await flip(false);
    try {
      for (const id of [B.anomalyAlertId, A.anomalyAlertId]) {
        const r = await as(B, 'GET', `/api/v1/alerts/${id}/anomaly`);
        expect(r.statusCode).toBe(403);
        expect(r.json().type).toBe('urn:watchlog:problem:pro-feature');
        expect(leaks(r.body, id)).toEqual([]);
      }
    } finally {
      await flip(true);
    }
  });

  it("expectations (ADR-186, ADR-192): B can't list, add or remove A's; B's own work under RLS", async () => {
    const as = async (o: SeededOrg, method: 'GET' | 'POST' | 'DELETE', url: string, extra = {}) =>
      w.app.inject({ method, url, cookies: { wl_session: await o.session() }, ...extra });
    const before = await fingerprint(A.orgId);
    for (const id of [A.k8s.id, A.docker.id]) {
      const l = await as(B, 'GET', '/api/v1/egress/expected', { query: { cluster: id } });
      expect(l.statusCode, id).toBe(404);
      expect(leaks(l.body, id)).toEqual([]);
      const add = await as(B, 'POST', '/api/v1/egress/expected', {
        payload: { cluster: id, pattern: '*.zzalpha.example.org' },
      });
      expect(add.statusCode, id).toBe(404);
      expect(leaks(add.body, id + 'zzalpha')).toEqual([]);
    }
    for (const eid of A.expectedIds) {
      const del = await as(B, 'DELETE', `/api/v1/egress/expected/${eid}`);
      expect(del.statusCode).toBe(404);
      expect(leaks(del.body, eid)).toEqual([]);
    }
    expect(await fingerprint(A.orgId)).toEqual(before);

    // B's own: listed, added (its inventory row gets the copy), removed, nothing of A.
    for (const id of [B.k8s.id, B.docker.id]) {
      const l = await as(B, 'GET', '/api/v1/egress/expected', { query: { cluster: id } });
      expect(l.statusCode).toBe(200);
      expect(leaks(l.body)).toEqual([]);
      expect(l.json().items.map((e: { pattern: string }) => e.pattern)).toEqual([
        '*.zzbeta.example.org',
      ]);
      const add = await as(B, 'POST', '/api/v1/egress/expected', {
        payload: { cluster: id, pattern: 'api.zzbeta.example.org', port: 443 },
      });
      expect(add.statusCode, add.body).toBe(201);
      expect(add.json().updated).toBe(1);
      expect(leaks(add.body)).toEqual([]);
      const del = await as(B, 'DELETE', `/api/v1/egress/expected/${add.json().expectation.id}`);
      expect(del.statusCode).toBe(204);
    }
    // The control: A lists its own.
    const a = await as(A, 'GET', '/api/v1/egress/expected', { query: { cluster: A.k8s.id } });
    expect(a.statusCode).toBe(200);
    expect(a.body).toContain('*.zzalpha.example.org');
    expect(await fingerprint(A.orgId)).toEqual(before);
  });

  it("egress policy (ADR-190, ADR-192): B can't get A's workloads' policy, by session or token; B's own and A's control", async () => {
    const policy = async (as: SeededOrg, cluster: string, workload: string, token = false) =>
      w.app.inject({
        method: 'GET',
        url: '/api/v1/egress/policy',
        query: { cluster, workload },
        ...(token
          ? { headers: { authorization: `Bearer ${as.apiToken.value}` } }
          : { cookies: { wl_session: await as.session() } }),
      });
    const aWorkload = 'shop/Deployment/zzalpha-orders';
    for (const token of [false, true]) {
      for (const id of [A.k8s.id, A.docker.id]) {
        for (const workload of [aWorkload, 'shop/Deployment/zzbeta-orders']) {
          const b = await policy(B, id, workload, token);
          expect(b.statusCode, `${id} ${workload}`).toBe(404);
          // Another org's Docker fleet is "not found", never Docker's reason.
          expect(b.json().detail).toBe('Cluster not found');
          expect(leaks(b.body, id + aWorkload)).toEqual([]);
        }
      }
      const own = await policy(B, B.k8s.id, 'shop/Deployment/zzbeta-orders', token);
      expect(own.statusCode, own.body).toBe(200);
      expect(own.body).toContain('api.zzbeta.example.org');
      expect(own.body).toContain('*.zzbeta.example.org');
      expect(leaks(own.body)).toEqual([]);
      const ownDocker = await policy(B, B.docker.id, 'shop/Deployment/zzbeta-orders', token);
      expect(ownDocker.statusCode).toBe(404);
      expect(ownDocker.json().detail).toContain('Docker has no egress policy object');
      // B's own cluster with A's workload name: nothing of A's there.
      const cross = await policy(B, B.k8s.id, aWorkload, token);
      expect(cross.statusCode).toBe(404);
      expect(leaks(cross.body, aWorkload)).toEqual([]);
      // The control: A gets its own.
      const a = await policy(A, A.k8s.id, aWorkload, token);
      expect(a.statusCode, a.body).toBe(200);
      expect(a.body).toContain('api.zzalpha.example.org');
    }
  });

  it("exports (ADR-181): B can't reach A's clusters, and B's own exports hold nothing of A", async () => {
    const now = Math.floor(Date.now() / 1000);
    const range = { from: String(now - 3600), to: String(now) };
    const exportOf = async (as: SeededOrg, clusterId: string) =>
      w.app.inject({
        method: 'GET',
        url: `/api/v1/clusters/${clusterId}/export`,
        query: range,
        cookies: { wl_session: await as.session() },
      });
    for (const id of [A.k8s.id, A.docker.id]) {
      const b = await exportOf(B, id);
      expect(b.statusCode, id).toBe(404);
      expect(leaks(b.body, id)).toEqual([]);
    }
    for (const id of [B.k8s.id, B.docker.id]) {
      const own = await exportOf(B, id);
      expect(own.statusCode).toBe(200);
      expect(leaks(own.body)).toEqual([]);
    }
    // The control: A's own export has A's series.
    const a = await exportOf(A, A.k8s.id);
    expect(a.statusCode).toBe(200);
    expect(a.body).toContain('zzalpha-pod');
    expect(a.body).toContain(`"cluster_id":"${A.k8s.id}"`);
    const config = await w.app.inject({
      method: 'GET',
      url: '/api/v1/org/export',
      cookies: { wl_session: await B.session() },
    });
    expect(config.statusCode).toBe(200);
    expect(leaks(config.body)).toEqual([]);
    expect(config.json().org.id).toBe(B.orgId);
  });

  it.each(['owner', 'admin', 'viewer'] as const)(
    "changes: B's %s with A ids gets 404 or 403, and none of A rows changes",
    async (role) => {
      const cookie = () =>
        role === 'owner' ? B.session() : B.sessionOf(role === 'admin' ? B.adminId : B.viewerId);
      const before = await fingerprint(A.orgId);
      const problems: string[] = [];
      let calls = 0;
      for (const [route, cls] of Object.entries(ROUTES)) {
        if (isRead(route) || cls.kind === 'mcp' || cls.kind === 'ingest') continue;
        const b = await call(route, B, A, {}, cookie);
        calls++;
        const found = leaks(b.body, b.sent);
        if (found.length) problems.push(`${route}: B saw ${found.join(', ')} (${b.statusCode})`);
        if (cls.kind === 'installation' && b.statusCode !== 404)
          problems.push(`${route}: ${b.statusCode}, expected 404 in Cloud`);
        if (cls.kind === 'org' && hasParams(route) && ![403, 404].includes(b.statusCode))
          problems.push(`${route}: B got ${b.statusCode} with A's ids: ${b.body.slice(0, 160)}`);
      }
      expect(problems).toEqual([]);
      expect(calls).toBeGreaterThan(40);
      expect(await fingerprint(A.orgId)).toEqual(before);
    },
    120_000,
  );
});

// ------------------------------------------------------------------------------- streams

describe('event streams', () => {
  it('B asking for a stream of A gets 404 at once', async () => {
    for (const s of STREAMS) {
      const res = await w.app.inject({
        method: 'GET',
        url: pathFor(s.route, A),
        query: s.query,
        headers: { accept: 'text/event-stream' },
        cookies: { wl_session: await B.session() },
      });
      expect(res.statusCode, s.route).toBe(404);
      expect(leaks(res.body, pathFor(s.route, A))).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------------------- query keys

describe('every curated query key', () => {
  it(`as B: 404 on both of A's clusters, and B's own clusters show nothing of A`, async () => {
    const now = Math.floor(Date.now() / 1000);
    const problems: string[] = [];
    const ask = async (as: SeededOrg, clusterId: string, metric: string) =>
      w.app.inject({
        method: 'POST',
        url: '/api/v1/query/range',
        cookies: { wl_session: await as.session() },
        payload: { clusterId, metric, from: now - 900, to: now },
      });
    const session = await B.session();
    for (const metric of METRIC_KEYS) {
      for (const clusterId of [A.k8s.id, A.docker.id]) {
        const r = await w.app.inject({
          method: 'POST',
          url: '/api/v1/query/range',
          cookies: { wl_session: session },
          payload: { clusterId, metric, from: now - 900, to: now },
        });
        if (r.statusCode !== 404) problems.push(`${metric} on A: ${r.statusCode}`);
      }
      for (const clusterId of [B.k8s.id, B.docker.id]) {
        const r = await ask(B, clusterId, metric);
        if (leaks(r.body).length) problems.push(`${metric} on B: ${leaks(r.body).join(', ')}`);
      }
    }
    expect(problems).toEqual([]);
    expect(METRIC_KEYS.length).toBeGreaterThan(50);
  }, 120_000);
});

// ------------------------------------------------------------------------------- MCP tools

describe('every MCP tool', () => {
  async function connect(token: string) {
    const address = w.app.server.listening
      ? `http://127.0.0.1:${(w.app.server.address() as { port: number }).port}`
      : await w.app.listen({ port: 0, host: '127.0.0.1' });
    const client = new Client(
      { name: 'watchlog-isolation', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  }

  it('classifies every tool, and none is gone', async () => {
    const asB = await connect(B.apiToken.value);
    const { tools } = await asB.listTools();
    await asB.close();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(MCP_TOOLS).sort());
  });

  it("egress tools (ADR-192): B with A's Kubernetes and Docker clusters gets an error and nothing of A; B's own and A's control", async () => {
    const asB = await connect(B.apiToken.value);
    const asA = await connect(A.apiToken.value);
    const call = async (c: Client, name: string, args: Record<string, unknown>) => {
      const r = await c.callTool({ name, arguments: args });
      const t = (r.content as { type: string; text?: string }[])
        .map((x) => x.text ?? '')
        .join('\n');
      return { isError: r.isError === true, text: t };
    };
    const tools: [string, Record<string, unknown>, string][] = [
      ['get_egress', { hours: 168 }, 'api.%s.example.org'],
      ['get_new_destinations', { hours: 168 }, 'api.%s.example.org'],
      ['get_expected_destinations', {}, '*.%s.example.org'],
    ];
    for (const [tool, extra, marker] of tools) {
      // A's clusters by id and by name, with each platform's source filters.
      for (const [cluster, filters] of [
        [A.k8s.id, { namespace: 'shop' }],
        [A.docker.id, { composeService: 'zzalpha-shop/api' }],
        ['zzalpha-k8s', {}],
        ['zzalpha-fleet', {}],
      ] as const) {
        const args = {
          cluster,
          ...extra,
          ...(tool === 'get_expected_destinations' ? {} : filters),
        };
        const b = await call(asB, tool, args);
        expect(b.isError, `${tool} ${cluster}`).toBe(true);
        expect(JSON.parse(b.text).error, tool).toBe('No cluster with this name or id.');
        expect(leaks(b.text, JSON.stringify(args)), `${tool} ${cluster}`).toEqual([]);
      }
      for (const cluster of [B.k8s.id, B.docker.id]) {
        const own = await call(asB, tool, { cluster, ...extra });
        expect(own.isError, `${tool} B ${own.text.slice(0, 200)}`).toBe(false);
        expect(own.text).toContain(marker.replace('%s', 'zzbeta'));
        expect(leaks(own.text), tool).toEqual([]);
      }
      for (const cluster of [A.k8s.id, A.docker.id]) {
        const a = await call(asA, tool, { cluster, ...extra });
        expect(a.isError, tool).toBe(false);
        expect(a.text).toContain(marker.replace('%s', 'zzalpha'));
      }
    }
    await asA.close();
    await asB.close();
  });

  it("what changed tool and route by token (ADR-202): B with A's clusters and alert gets an error and nothing of A; B's own, A's control; Free refused", async () => {
    const asB = await connect(B.apiToken.value);
    const asA = await connect(A.apiToken.value);
    const call = async (c: Client, args: Record<string, unknown>) => {
      const r = await c.callTool({ name: 'get_what_changed', arguments: args });
      const t = (r.content as { type: string; text?: string }[])
        .map((x) => x.text ?? '')
        .join('\n');
      return { isError: r.isError === true, text: t };
    };
    // A's clusters by id and by name.
    for (const cluster of [A.k8s.id, A.docker.id, 'zzalpha-k8s', 'zzalpha-fleet']) {
      const b = await call(asB, { cluster });
      expect(b.isError, cluster).toBe(true);
      expect(JSON.parse(b.text).error).toBe('No cluster with this name or id.');
      expect(leaks(b.text, cluster)).toEqual([]);
    }
    // A's alert with B's own cluster.
    const alert = await call(asB, { cluster: B.k8s.id, alert: A.alertId });
    expect(alert.isError).toBe(true);
    expect(JSON.parse(alert.text).error).toBe('No alert with this id in this cluster.');
    expect(leaks(alert.text, A.alertId)).toEqual([]);
    // B's own rows and A's control, on both platforms.
    for (const [o, c, other] of [
      [B, asB, A],
      [A, asA, B],
    ] as const) {
      for (const cluster of [o.k8s.id, o.docker.id]) {
        const own = await call(c, { cluster });
        expect(own.isError, own.text.slice(0, 200)).toBe(false);
        expect(JSON.parse(own.text).changes).toHaveLength(1);
        expect(own.text).toContain(o.label);
        expect(leaks(own.text, '', other)).toEqual([]);
      }
    }
    // The route with B's token: A's clusters 404, B's own 200.
    const read = (o: SeededOrg, cluster: string) =>
      w.app.inject({
        method: 'GET',
        url: '/api/v1/what-changed',
        query: { cluster },
        headers: { authorization: `Bearer ${o.apiToken.value}` },
      });
    for (const id of [A.k8s.id, A.docker.id]) {
      const b = await read(B, id);
      expect(b.statusCode, id).toBe(404);
      expect(leaks(b.body, id)).toEqual([]);
    }
    for (const id of [B.k8s.id, B.docker.id]) {
      const own = await read(B, id);
      expect(own.statusCode, own.body).toBe(200);
      expect(leaks(own.body)).toEqual([]);
    }
    // B without pro_features (Free): the tool refuses in-band and the route answers 403, for
    // B's own clusters and A's, with nothing of A's.
    const flip = async (on: boolean) => {
      await w.owner
        .updateTable('entitlements')
        .set({ pro_features: on })
        .where('org_id', '=', B.orgId)
        .execute();
      w.app.entitlements!.invalidate(B.orgId);
    };
    await flip(false);
    try {
      for (const cluster of [B.k8s.id, B.docker.id]) {
        const t = await call(asB, { cluster });
        expect(t.isError).toBe(true);
        expect(JSON.parse(t.text).error).toBe(PRO_REFUSAL);
        expect(leaks(t.text)).toEqual([]);
      }
      for (const id of [B.k8s.id, A.k8s.id, A.docker.id]) {
        const r = await read(B, id);
        expect(r.statusCode, id).toBe(403);
        expect(r.json().type).toBe('urn:watchlog:problem:pro-feature');
        expect(leaks(r.body, id)).toEqual([]);
      }
    } finally {
      await flip(true);
    }
    await asA.close();
    await asB.close();
  });

  it("the egress routes with B's API token: A's clusters 404, B's own, A's token reads A's", async () => {
    const read = (o: SeededOrg, url: string, cluster: string) =>
      w.app.inject({
        method: 'GET',
        url,
        query: { cluster, from: String(Math.floor(Date.now() / 1000) - 7 * 86_400) },
        headers: { authorization: `Bearer ${o.apiToken.value}` },
      });
    for (const url of ['/api/v1/egress', '/api/v1/egress/expected']) {
      for (const id of [A.k8s.id, A.docker.id]) {
        const b = await read(B, url, id);
        expect(b.statusCode, `${url} ${id}`).toBe(404);
        expect(leaks(b.body, id)).toEqual([]);
      }
      for (const id of [B.k8s.id, B.docker.id]) {
        const own = await read(B, url, id);
        expect(own.statusCode, `${url} ${own.body}`).toBe(200);
        expect(own.body).toContain('zzbeta.example.org');
        expect(leaks(own.body)).toEqual([]);
      }
      for (const id of [A.k8s.id, A.docker.id]) {
        const a = await read(A, url, id);
        expect(a.statusCode).toBe(200);
        expect(a.body).toContain('zzalpha.example.org');
      }
    }
    // A write with a token is refused before any cluster is looked at.
    const before = await fingerprint(A.orgId);
    const add = await w.app.inject({
      method: 'POST',
      url: '/api/v1/egress/expected',
      payload: { cluster: A.k8s.id, pattern: '*.zzalpha.example.org' },
      headers: { authorization: `Bearer ${B.apiToken.value}` },
    });
    expect(add.statusCode).toBe(403);
    const del = await w.app.inject({
      method: 'DELETE',
      url: `/api/v1/egress/expected/${A.expectedIds[0]}`,
      headers: { authorization: `Bearer ${B.apiToken.value}` },
    });
    expect(del.statusCode).toBe(403);
    expect(await fingerprint(A.orgId)).toEqual(before);
  });

  it("as B with A's ids: never a marker of A; A gets its own", async () => {
    const asB = await connect(B.apiToken.value);
    const asA = await connect(A.apiToken.value);
    const { tools } = await asB.listTools();
    expect(tools.length).toBeGreaterThan(10);
    const problems: string[] = [];
    let aSaw = 0;
    const text = (r: Awaited<ReturnType<Client['callTool']>>) =>
      (r.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
    for (const tool of tools) {
      for (const docker of [false, true]) {
        const ids = { ...A, k8s: docker ? { ...A.k8s, id: A.docker.id } : A.k8s };
        const args = sample(tool.inputSchema as Schema, 'args', ids) as Record<string, unknown>;
        // Fill the optional ids too: each is a chance to reach A's rows.
        for (const [k, p] of Object.entries((tool.inputSchema as Schema).properties ?? {})) {
          if (args[k] === undefined && /id$/i.test(k) && (p as Schema).type === 'string')
            args[k] = idFor(k, ids);
        }
        const b = text(await asB.callTool({ name: tool.name, arguments: args }));
        const found = leaks(b, JSON.stringify(args));
        if (found.length)
          problems.push(`${tool.name}: B saw ${found.join(', ')}: ${b.slice(0, 200)}`);
        const a = text(await asA.callTool({ name: tool.name, arguments: args }));
        if (leaks(a).length) aSaw++;
      }
    }
    await asA.close();
    await asB.close();
    expect(problems).toEqual([]);
    expect(aSaw).toBeGreaterThan(3);
  }, 120_000);
});

// ------------------------------------------------------------------------------- ingest

describe('ingest', () => {
  it('a write naming another cluster or tenant in its labels is refused with 400', async () => {
    for (const label of ['cluster_id', 'tenant_id']) {
      const r = await writeSeries(w.app, B.k8s.token, [
        {
          labels: { __name__: 'zzbeta_probe', [label]: A.k8s.id },
          value: 1,
          timestampMs: Date.now(),
        },
      ]);
      expect(r.statusCode, label).toBe(400);
    }
  });

  it("B's writes land in B's cluster only", async () => {
    const r = await writeSeries(w.app, B.k8s.token, [
      { labels: { __name__: 'zzbeta_landing' }, value: 1, timestampMs: Date.now() },
    ]);
    expect(r.statusCode).toBe(204);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const res = (await (
      await fetch(`${TEST_VM_URL}/api/v1/series?match[]=zzbeta_landing`)
    ).json()) as { data: { cluster_id: string }[] };
    expect(res.data.map((s) => s.cluster_id)).toEqual([B.k8s.id]);
  });

  it("every ingest path: without a token 401; with B's token nothing of A changes or shows", async () => {
    const ingestRoutes = Object.entries(ROUTES).filter(([, c]) => c.kind === 'ingest');
    expect(ingestRoutes.length).toBeGreaterThan(5);
    const before = await fingerprint(A.orgId);
    for (const [route] of ingestRoutes) {
      const [method] = route.split(' ') as [string];
      const url = pathFor(route, A);
      const none = await w.app.inject({ method: method as 'GET', url });
      expect(none.statusCode, route).toBe(401);
      const b = await w.app.inject({
        method: method as 'GET',
        url,
        query: { host: A.host, wait: '0' },
        headers: { authorization: `Bearer ${B.docker.token}`, 'x-watchlog-agent': A.host },
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      expect(leaks(b.body, url + A.host), route).toEqual([]);
    }
    expect(await fingerprint(A.orgId)).toEqual(before);
  });
});

// ------------------------------------------------------------------------------- the database

describe('Row-Level Security (the second layer)', () => {
  it('is on for every tenant table and its partitions, with the org policy', async () => {
    const tables = await tenantTables();
    expect(tables.length).toBeGreaterThanOrEqual(27);
    const res = await sql<{ name: string; rls: boolean; policies: string }>`
      SELECT c.relname AS name, c.relrowsecurity AS rls, count(p.polname)::text AS policies
        FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
       GROUP BY 1, 2`.execute(w.owner);
    const byName = new Map(res.rows.map((r) => [r.name, r]));
    for (const t of [...tables, 'orgs']) {
      expect(byName.get(t)?.rls, t).toBe(true);
      expect(byName.get(t)?.policies, t).toBe('1');
    }
    // Partitions: RLS on and no policy, so they are only readable through their parent.
    for (const r of res.rows.filter((r) => /^k8s_events_\d{8}$/.test(r.name))) {
      expect(r.rls, r.name).toBe(true);
    }
    // Every other table is a known global one: a new table must be classified.
    const others = res.rows
      .map((r) => r.name)
      .filter((n) => !tables.includes(n) && n !== 'orgs' && !/^k8s_events_\d{8}$/.test(n));
    expect(others.sort()).toEqual([...GLOBAL_TABLES].sort());
  });

  it('a connection with no org setting sees no row of any tenant table', async () => {
    const client = new pg.Client({ connectionString: w.appUrl });
    await client.connect();
    try {
      for (const t of [...(await tenantTables()), 'orgs']) {
        const owner = await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(t)}`.execute(
          w.owner,
        );
        const app = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`);
        expect(app.rows[0]!.n, `${t} (the owner sees ${owner.rows[0]!.n})`).toBe('0');
      }
      // An empty setting, as the pool sets outside an org, is the same.
      await client.query("SELECT set_config('watchlog.org_id', '', false)");
      expect((await client.query('SELECT count(*) AS n FROM clusters')).rows[0].n).toBe('0');
    } finally {
      await client.end();
    }
  });

  it("with org B set: none of A's rows, and A's rows can't be written", async () => {
    const client = new pg.Client({ connectionString: w.appUrl });
    await client.connect();
    try {
      await client.query("SELECT set_config('watchlog.org_id', $1, false)", [B.orgId]);
      for (const t of await tenantTables()) {
        const r = await client.query(`SELECT count(*) AS n FROM ${t} WHERE org_id = $1`, [A.orgId]);
        expect(r.rows[0].n, t).toBe('0');
      }
      const upd = await client.query('UPDATE clusters SET name = $1 WHERE id = $2', [
        'x',
        A.k8s.id,
      ]);
      expect(upd.rowCount).toBe(0);
      await expect(
        client.query(
          "INSERT INTO clusters (id, org_id, name, kind) VALUES (gen_random_uuid(), $1, 'x', 'docker')",
          [A.orgId],
        ),
      ).rejects.toThrow(/row-level security/);
      // A row of B's naming A's cluster: the composite key refuses it.
      await expect(
        client.query(
          "INSERT INTO change_markers (id, cluster_id, org_id, kind, target) VALUES (gen_random_uuid(), $1, $2, 'x', 'x')",
          [A.k8s.id, B.orgId],
        ),
      ).rejects.toThrow();
    } finally {
      await client.end();
    }
  });
});

// ------------------------------------------------------------------------------- accounts

describe('Cloud accounts across orgs (ADR-175)', () => {
  const as = async (o: SeededOrg, method: 'GET' | 'POST' | 'DELETE', url: string) =>
    w.app.inject({ method, url, cookies: { wl_session: await o.session() } });

  it("B can't switch to A's org: 404, and B's session stays in B", async () => {
    const res = await as(B, 'POST', `/api/v1/orgs/${A.orgId}/switch`);
    expect(res.statusCode).toBe(404);
    expect(leaks(res.body, A.orgId)).toEqual([]);
    const orgs = await as(B, 'GET', '/api/v1/orgs');
    expect(orgs.statusCode).toBe(200);
    expect(orgs.json().orgs.map((o: { id: string }) => o.id)).toEqual([B.orgId]);
    expect(leaks(orgs.body)).toEqual([]);
  });

  it("B can't revoke A's session: 404, and A's session still works", async () => {
    const res = await as(B, 'DELETE', `/api/v1/auth/sessions/${A.kept.id}`);
    expect(res.statusCode).toBe(404);
    const me = await w.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: { wl_session: A.kept.token },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.org.id).toBe(A.orgId);
  });

  it("B's session list and account show nothing of A", async () => {
    for (const url of ['/api/v1/auth/sessions', '/api/v1/auth/account']) {
      const res = await as(B, 'GET', url);
      expect(res.statusCode, url).toBe(200);
      expect(leaks(res.body), url).toEqual([]);
      expect(res.body).not.toContain(A.kept.id);
    }
  });
});

// ------------------------------------------------------------------------------- support

describe('support mode (ADR-179): a session of B, read-only, never reaching A', () => {
  /** The tables support mode itself records into (what was opened, tokens read). */
  const SUPPORT_RECORDS = [
    'support_session_views',
    'support_sessions',
    'audit_events',
    'api_token_events',
  ];
  const withoutRecords = (f: Record<string, string>) =>
    Object.fromEntries(Object.entries(f).filter(([k]) => !SUPPORT_RECORDS.includes(k)));
  let support: string;

  beforeAll(async () => {
    const { code } = await openSupportSession(w.owner, {
      orgId: B.orgId,
      staffEmail: 'staff@watchlog.test',
      reason: 'isolation sweep',
      minutes: 60,
    });
    support = (await enterSupportSession(w.owner, code))!.token;
  });
  const asSupport = (route: string, ids: SeededOrg) =>
    call(route, B, ids, { cookies: { wl_support: support } });

  it("reads with A's ids: 404 or 403, never a marker of A; B's own reads never fail", async () => {
    const problems: string[] = [];
    let reads = 0;
    for (const [route, cls] of Object.entries(ROUTES)) {
      if (!isRead(route) || cls.kind === 'mcp' || cls.kind === 'ingest') continue;
      reads++;
      const b = await asSupport(route, A);
      const found = leaks(b.body, b.sent);
      if (found.length)
        problems.push(`${route}: support saw ${found.join(', ')} (${b.statusCode})`);
      if (cls.kind === 'org' && hasParams(route) && ![403, 404].includes(b.statusCode))
        problems.push(`${route}: support of B got ${b.statusCode} with A's ids`);
      // B's own ids: a read under a read-only database must not fail (a GET that writes would).
      const own = await asSupport(route, B);
      if (own.statusCode >= 500) {
        problems.push(`${route}: support's own read ${own.statusCode}: ${own.body.slice(0, 160)}`);
      }
    }
    expect(problems).toEqual([]);
    expect(reads).toBeGreaterThan(60);
  }, 120_000);

  it("every change is refused (403), with A's ids and with B's own; neither org's rows change", async () => {
    const beforeA = await fingerprint(A.orgId);
    const beforeB = withoutRecords(await fingerprint(B.orgId));
    const problems: string[] = [];
    for (const [route, cls] of Object.entries(ROUTES)) {
      // The installation's settings answer 404 in Cloud before anything else.
      if (cls.kind === 'mcp' || cls.kind === 'ingest' || cls.kind === 'installation') continue;
      if (route.startsWith('GET ')) continue;
      const [method, url] = route.split(' ');
      if (SUPPORT_ALLOWED.some((a) => a.method === method && a.url === url)) continue;
      for (const ids of [A, B]) {
        const res = await asSupport(route, ids);
        if (res.statusCode !== 403 || !res.body.includes('support-read-only')) {
          problems.push(`${route}: ${res.statusCode} ${res.body.slice(0, 120)}`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(await fingerprint(A.orgId)).toEqual(beforeA);
    expect(withoutRecords(await fingerprint(B.orgId))).toEqual(beforeB);
  }, 120_000);

  it('the database refuses a write in a read-only scope, even one no guard caught', async () => {
    const err = await new Promise<unknown>((resolve) =>
      enterRequestScope(() => {
        markReadOnly();
        withOrg(B.orgId, () =>
          w.appDb
            .updateTable('clusters')
            .set({ name: 'zzbeta-renamed' })
            .where('org_id', '=', B.orgId)
            .execute(),
        ).then(() => resolve(null), resolve);
      }),
    );
    expect((err as { code?: string } | null)?.code).toBe('25006');
    // The next request on the same pool writes again (the setting is per checkout).
    const ok = await withOrg(B.orgId, () =>
      w.appDb.selectFrom('clusters').select('id').where('org_id', '=', B.orgId).execute(),
    );
    expect(ok.length).toBeGreaterThan(0);
    const write = await withOrg(B.orgId, () =>
      w.appDb
        .updateTable('clusters')
        .set({ updated_at: new Date() })
        .where('id', '=', B.k8s.id)
        .executeTakeFirst(),
    );
    expect(Number(write.numUpdatedRows)).toBe(1);
  });

  it("the support session's org is fixed: no org switch, and A's ids are 404", async () => {
    const sw = await w.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${A.orgId}/switch`,
      cookies: { wl_support: support },
    });
    expect(sw.statusCode).toBe(403);
    const cluster = await w.app.inject({
      method: 'GET',
      url: `/api/v1/clusters/${A.k8s.id}`,
      cookies: { wl_support: support, wl_session: await A.session() },
    });
    // The support cookie wins over a session cookie in the same browser: B's org, not A's.
    expect(cluster.statusCode).toBe(404);
    expect(leaks(cluster.body, A.k8s.id)).toEqual([]);
  });
});

// -------------------------------------------------------------------------- shared member

/**
 * The review's SR-1 and SR-24: in Cloud an account is global and may belong to several
 * orgs. S is a Viewer in A and in B and the Owner of their own org, with 2FA on. Nothing A's Owner
 * or Admin can do may touch S's account (password, sessions, reset links, sign-in
 * methods, verification links, recovery codes) or S's own org.
 */
describe('a user who belongs to both orgs (shared member)', () => {
  let S: { id: string; email: string; session: string; sessionId: string; orgId: string };

  beforeAll(async () => {
    const id = newId();
    // S's own org (an org has one Owner).
    const orgId = newId();
    await w.owner
      .insertInto('orgs')
      .values({ id: orgId, name: 'zzshared Org', slug: 'zzshared-org', plan: 'pro' })
      .execute();
    const email = 'shared@zzshared.test';
    await w.owner
      .insertInto('users')
      .values({
        id,
        email,
        name: 'zzshared Member',
        password_hash: 'x',
        // 2FA on (as an Owner of a paid org must have it); the secret itself isn't needed.
        totp_enabled_at: new Date(),
        totp_secret: 'not-a-real-secret',
      })
      .execute();
    await w.owner
      .insertInto('memberships')
      .values([
        { id: newId(), org_id: orgId, user_id: id, role: 'owner' },
        { id: newId(), org_id: A.orgId, user_id: id, role: 'viewer' },
        // And a Viewer of B, so that a change aimed at S can't reach a third org either.
        { id: newId(), org_id: B.orgId, user_id: id, role: 'viewer' },
      ])
      .execute();
    const { token } = await createSession(w.owner, id, { orgId });
    const row = await w.owner
      .selectFrom('sessions')
      .select('id')
      .where('token_hash', '=', hashOf(token))
      .executeTakeFirstOrThrow();
    S = { id, email, session: token, sessionId: row.id, orgId };
  });

  /** S's rows in the global tables, read as the owner (S's sessions outside A only). */
  async function account(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const tables = {
      users: sql`id = ${S.id}`,
      sessions: sql`user_id = ${S.id} AND current_org_id IS DISTINCT FROM ${A.orgId}::uuid`,
      password_resets: sql`user_id = ${S.id}`,
      user_identities: sql`user_id = ${S.id}`,
      email_tokens: sql`user_id = ${S.id}`,
      recovery_codes: sql`user_id = ${S.id}`,
    };
    for (const [name, where] of Object.entries(tables)) {
      const res = await sql<{ h: string | null; n: string }>`
        SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS h, count(*) AS n
          FROM ${sql.table(name)} t WHERE ${where}`.execute(w.owner);
      out[name] = `${res.rows[0]!.n}:${res.rows[0]!.h}`;
    }
    return out;
  }

  /** S is back in A as a Viewer (a sweep may remove or promote them). */
  async function restoreMembership() {
    await w.owner
      .deleteFrom('memberships')
      .where('org_id', '=', A.orgId)
      .where('user_id', '=', S.id)
      .execute();
    await w.owner
      .insertInto('memberships')
      .values({ id: newId(), org_id: A.orgId, user_id: S.id, role: 'viewer' })
      .execute();
  }

  it.each(['owner', 'admin'] as const)(
    "A's %s can't get a link that signs in as S (no reset link in Cloud)",
    async (role) => {
      const before = await account();
      const cookie = role === 'owner' ? await A.session() : await A.sessionOf(A.adminId);
      const res = await w.app.inject({
        method: 'POST',
        url: `/api/v1/users/${S.id}/reset-link`,
        cookies: { wl_session: cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('/reset/');
      expect(await account()).toEqual(before);
    },
  );

  it('a reset link for a 2FA account never signs in without the second factor', async () => {
    // Whoever holds S's link (from S's mailbox, say) sets a password and gets only the
    // 2FA step: no session, no way into S's org.
    const { token } = await createResetLink(w.owner, {
      userId: S.id,
      via: 'email',
      createdBy: null,
    });
    const res = await w.app.inject({
      method: 'POST',
      url: `/api/v1/password-resets/${token}`,
      payload: { password: 'a-new-password-for-s' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ mfaRequired: true });
    const full = res.cookies.find((c) => c.name === 'wl_session' && c.value);
    expect(full).toBeUndefined();
    const sessions = await w.owner
      .selectFrom('sessions')
      .select(['stage'])
      .where('user_id', '=', S.id)
      .execute();
    // Every earlier session ended with the reset; only the pending 2FA step is left.
    expect(sessions.map((x) => x.stage)).toEqual(['mfa']);
    // S signs in again for the rest of the suite.
    await w.owner.deleteFrom('sessions').where('user_id', '=', S.id).execute();
    const { token: again } = await createSession(w.owner, S.id, { orgId: S.orgId });
    S.session = again;
    S.sessionId = (
      await w.owner
        .selectFrom('sessions')
        .select('id')
        .where('token_hash', '=', hashOf(again))
        .executeTakeFirstOrThrow()
    ).id;
  });

  it.each(['owner', 'admin'] as const)(
    "every change A's %s can make, aimed at S, leaves S's account and S's org alone",
    async (role) => {
      const cookie = () => (role === 'owner' ? A.session() : A.sessionOf(A.adminId));
      // A's routes with A's own ids, except that every user id is S's.
      const asS: SeededOrg = { ...A, viewerId: S.id };
      const beforeAccount = await account();
      const beforeB = await fingerprint(B.orgId);
      const beforeOwn = await fingerprint(S.orgId);
      const problems: string[] = [];
      let calls = 0;
      const routes = Object.entries(ROUTES)
        .filter(([r, c]) => !isRead(r) && c.kind !== 'mcp' && c.kind !== 'ingest')
        // The routes about users first, while A is whole.
        .sort(([a], [b]) => Number(b.includes('/users')) - Number(a.includes('/users')));
      for (const [route] of routes) {
        await restoreMembership();
        const res = await call(route, A, asS, {}, cookie);
        calls++;
        if (res.statusCode >= 500 && res.statusCode !== 503)
          problems.push(`${route}: ${res.statusCode} ${res.body.slice(0, 200)}`);
        const now = await account();
        for (const [t, h] of Object.entries(now))
          if (h !== beforeAccount[t]) {
            problems.push(`${route} (${res.statusCode}) changed S's ${t}`);
            beforeAccount[t] = h;
          }
      }
      expect(problems).toEqual([]);
      expect(calls).toBeGreaterThan(40);
      expect(await fingerprint(B.orgId)).toEqual(beforeB);
      expect(await fingerprint(S.orgId)).toEqual(beforeOwn);
      // S still signs in to their own org, as its Owner.
      const me = await w.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        cookies: { wl_session: S.session },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.org.id).toBe(S.orgId);
      expect(me.json().user.role).toBe('owner');
    },
    120_000,
  );
});
