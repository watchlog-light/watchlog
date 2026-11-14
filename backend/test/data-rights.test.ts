// SPDX-License-Identifier: AGPL-3.0-only
// Cloud's data rights and inactive orgs (ADR-181): the exports, scenario 17 (an Owner deletes
// the org, undoes it on day 3, deletes it again: after 7 days its rows and series are gone,
// and the deletion is recorded), and inactive Free orgs (warned after 30 days without data,
// suspended 7 days later, cancelled by data). The app runs as in Cloud (watchlog_app under
// Row-Level Security, isolation/cloud.ts) against the test PostgreSQL and VictoriaMetrics.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorisedScope, VictoriaQueryClient } from '../src/lib/victoria.js';
import { TieredVictoriaClient } from '../src/lib/victoria-tiers.js';
import {
  DELETION_UNDO_MS,
  runDeletions,
  runInactivity,
} from '../src/modules/data-rights/service.js';
import { TEST_VM_URL } from './helpers.js';
import {
  cloudWorld,
  seedOrg,
  writeSeries,
  type CloudWorld,
  type SeededOrg,
} from './isolation/cloud.js';

const DAY = 86_400_000;
const log = { info: () => {}, warn: () => {} };
const noMail = async () => ({ smtp: undefined, publicUrl: undefined });

let w: CloudWorld;
let A: SeededOrg;
let B: SeededOrg;

beforeAll(async () => {
  w = await cloudWorld();
  A = await seedOrg(w, 'zzalpha');
  B = await seedOrg(w, 'zzbeta');
}, 120_000);
afterAll(() => w?.close());

const as = async (
  o: SeededOrg,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: object,
  role: 'owner' | 'viewer' = 'owner',
) =>
  w.app.inject({
    method,
    url: `/api/v1${url}`,
    cookies: {
      wl_session: role === 'owner' ? await o.session() : await viewerSession(o),
    },
    ...(payload ? { payload } : {}),
  });

async function viewerSession(o: SeededOrg) {
  const { createSession } = await import('../src/modules/auth/sessions.js');
  return (await createSession(w.owner, o.viewerId)).token;
}

const heartbeat = (token: string, node: string) =>
  w.app.inject({
    method: 'POST',
    url: '/ingest/v1/heartbeat',
    headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': node },
    payload: { node, mode: 'node', agent_version: '0.6.0', capabilities: {}, series: 1 },
  });

/** Series VictoriaMetrics holds for a cluster over the last month. */
async function seriesOf(clusterId: string): Promise<number> {
  await fetch(`${TEST_VM_URL}/internal/force_flush`);
  const now = Math.floor(Date.now() / 1000);
  const res = await fetch(
    `${TEST_VM_URL}/api/v1/series?match[]=${encodeURIComponent(`{cluster_id="${clusterId}"}`)}&start=${now - 31 * 86_400}&end=${now}`,
  );
  return ((await res.json()) as { data: unknown[] }).data.length;
}

describe('exports', () => {
  it('the configuration: Owners only, no secrets, audited and rate-limited', async () => {
    expect((await as(A, 'GET', '/org/export', undefined, 'viewer')).statusCode).toBe(403);
    const res = await as(A, 'GET', '/org/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="watchlog-zzalpha-org-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const body = res.json();
    expect(body.format).toBe('watchlog-org-export/1');
    expect(body.org).toMatchObject({ id: A.orgId, slug: 'zzalpha-org' });
    expect(body.clusters.map((c: { id: string }) => c.id).sort()).toEqual(
      [A.k8s.id, A.docker.id].sort(),
    );
    expect(body.channels[0].settings).toEqual({ url: 'https://zzalpha.example.com/hook' });
    expect(body.members.map((m: { role: string }) => m.role).sort()).toEqual([
      'admin',
      'owner',
      'viewer',
    ]);
    for (const key of ['alertRules', 'silences', 'applications', 'apiTokens', 'plan']) {
      expect(body, key).toHaveProperty(key);
    }
    // Never a hash, a secret or a credential.
    expect(res.body).not.toMatch(/token_hash|password|signingSecret|webhookUrl|botToken|secret/i);
    const audits = await w.owner
      .selectFrom('audit_events')
      .select('details')
      .where('org_id', '=', A.orgId)
      .where('action', '=', 'org_exported')
      .execute();
    expect(audits.map((a) => a.details)).toContainEqual({ what: 'configuration' });
    // 10 an hour per org (one used above).
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await as(A, 'GET', '/org/export')).statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(9);
    expect(codes.at(-1)).toBe(429);
  });

  it("a cluster's metrics as JSON lines, scoped to the cluster, in a bounded range", async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await as(A, 'GET', `/clusters/${A.k8s.id}/export?from=${now - 3600}&to=${now}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const lines = res.body.trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const s = JSON.parse(l) as { metric: Record<string, string>; values: number[] };
      expect(s.metric.cluster_id).toBe(A.k8s.id);
      expect(Array.isArray(s.values)).toBe(true);
    }
    expect(
      (await as(A, 'GET', `/clusters/${A.k8s.id}/export?from=${now - 40 * 86_400}&to=${now}`))
        .statusCode,
    ).toBe(400);
    expect(
      (await as(A, 'GET', `/clusters/${A.k8s.id}/export`, undefined, 'viewer')).statusCode,
    ).toBe(403);
    expect((await as(A, 'GET', `/clusters/${B.k8s.id}/export`)).statusCode).toBe(404);
  });
});

describe('scenario 17: delete, undo on day 3, delete again', () => {
  it('holds ingest for 7 days, undoes, then deletes rows and series and records it', async () => {
    const t0 = Date.now();
    const victoria = new VictoriaQueryClient(TEST_VM_URL);
    // Fresh series for both of A's clusters, and one of B's that must survive.
    await writeSeries(w.app, A.docker.token, [
      { labels: { __name__: 'zz_s17', host: 'h' }, value: 1, timestampMs: t0 },
    ]);
    await writeSeries(w.app, B.k8s.token, [
      { labels: { __name__: 'zz_s17', node: 'n' }, value: 1, timestampMs: t0 },
    ]);
    expect(await seriesOf(A.k8s.id)).toBeGreaterThan(0);
    expect(await seriesOf(A.docker.id)).toBeGreaterThan(0);
    const bSeries = await seriesOf(B.k8s.id);

    // A wrong confirmation, a viewer: refused.
    expect((await as(A, 'POST', '/org/deletion', { confirm: 'zzalpha' })).statusCode).toBe(400);
    expect(
      (await as(A, 'POST', '/org/deletion', { confirm: 'zzalpha Org' }, 'viewer')).statusCode,
    ).toBe(403);
    const asked = await as(A, 'POST', '/org/deletion', { confirm: 'zzalpha Org' });
    expect(asked.statusCode, asked.body).toBe(202);
    const due = Date.parse(asked.json().deletion.dueAt);
    expect(due - Date.parse(asked.json().deletion.requestedAt)).toBe(DELETION_UNDO_MS);
    expect(asked.json().deletion.requestedBy).toBe('zzalpha Owner');
    expect((await as(A, 'POST', '/org/deletion', { confirm: 'zzalpha Org' })).statusCode).toBe(409);
    // Its ingest answers 402 now; B's doesn't; members still read.
    const hb = await heartbeat(A.k8s.token, A.node);
    expect(hb.statusCode).toBe(402);
    expect(hb.json().type).toBe('urn:watchlog:problem:org-deleting');
    expect((await heartbeat(B.k8s.token, B.node)).statusCode).toBe(204);
    const status = await as(A, 'GET', '/org/status', undefined, 'viewer');
    expect(status.json().deletion.dueAt).toBe(asked.json().deletion.dueAt);

    // Day 3: the job deletes nothing; the Owner undoes it; ingest is back.
    expect(
      await runDeletions({ systemDb: w.owner, victoria, settings: noMail, log }, t0 + 3 * DAY),
    ).toEqual([]);
    const undo = await as(A, 'DELETE', '/org/deletion');
    expect(undo.statusCode).toBe(200);
    expect(undo.json().deletion).toBeNull();
    expect((await as(A, 'DELETE', '/org/deletion')).statusCode).toBe(409);
    expect((await heartbeat(A.k8s.token, A.node)).statusCode).toBe(204);

    // Asked again; still there 3 days in; gone after 7.
    const again = await as(A, 'POST', '/org/deletion', { confirm: 'zzalpha Org' });
    expect(again.statusCode).toBe(202);
    const deps = { systemDb: w.owner, victoria, settings: noMail, log };
    expect(await runDeletions(deps, t0 + 3 * DAY)).toEqual([]);
    expect(await runDeletions(deps, t0 + DELETION_UNDO_MS + 60_000)).toEqual([A.orgId]);

    // Every tenant table: nothing of A's left; B's untouched.
    const tables = await sql<{ name: string }>`
      SELECT c.relname AS name FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
         AND NOT c.relispartition
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                     AND a.attname = 'org_id' AND NOT a.attisdropped)`.execute(w.owner);
    expect(tables.rows.length).toBeGreaterThanOrEqual(27);
    for (const { name } of tables.rows) {
      const n = await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(name)}
        WHERE org_id = ${A.orgId}`.execute(w.owner);
      expect(n.rows[0]!.n, name).toBe('0');
    }
    expect(
      await w.owner.selectFrom('orgs').select('id').where('id', '=', A.orgId).execute(),
    ).toEqual([]);
    // A's two accounts belonged to A only: gone too.
    expect(
      await w.owner
        .selectFrom('users')
        .select('id')
        .where('id', 'in', [A.ownerId, A.viewerId])
        .execute(),
    ).toEqual([]);
    expect(await seriesOf(A.k8s.id)).toBe(0);
    expect(await seriesOf(A.docker.id)).toBe(0);
    expect(await seriesOf(B.k8s.id)).toBe(bSeries);
    // 402 while this process still caches the token (60 s), 401 after; never stored.
    expect([401, 402]).toContain((await heartbeat(A.k8s.token, A.node)).statusCode);
    const retired = await w.owner
      .selectFrom('retired_cluster_tokens')
      .select('token_hash')
      .execute();
    expect(retired.length).toBeGreaterThanOrEqual(2);
    expect((await heartbeat(B.k8s.token, B.node)).statusCode).toBe(204);

    // The record outlives the org.
    const rec = await w.owner
      .selectFrom('org_deletions')
      .selectAll()
      .where('deleted_org_id', '=', A.orgId)
      .executeTakeFirstOrThrow();
    expect(rec.org_name).toBe('zzalpha Org');
    expect(rec.requested_by).toBe(A.ownerId);
    expect([...rec.cluster_ids].sort()).toEqual([A.k8s.id, A.docker.id].sort());
    expect(rec.users_deleted).toBe(3);
    expect((rec.series as { all: number }).all).toBeGreaterThan(0);
  });
});

describe('inactive Free orgs', () => {
  it('warned after 30 days without data, suspended 7 days later; data cancels it', async () => {
    await w.owner
      .updateTable('entitlements')
      .set({ plan: 'free', source: 'signup' })
      .where('org_id', '=', B.orgId)
      .execute();
    const deps = {
      systemDb: w.owner,
      settings: noMail,
      log,
      invalidate: (id: string) => w.app.entitlements!.invalidate(id),
    };
    const t0 = Date.now();
    // 29 days on: nothing yet.
    expect((await runInactivity(deps, t0 + 29 * DAY)).warned).not.toContain(B.orgId);
    // 31 days on: warned, once.
    expect((await runInactivity(deps, t0 + 31 * DAY)).warned).toContain(B.orgId);
    expect((await runInactivity(deps, t0 + 32 * DAY)).warned).not.toContain(B.orgId);
    const warnedStatus = (await as(B, 'GET', '/org/status')).json();
    expect(warnedStatus.inactivity).not.toBeNull();
    expect(warnedStatus.suspension).toBeNull();

    // Data arrives before the suspension: the warning goes away.
    const warnedAt = Date.parse(warnedStatus.inactivity.warnedAt);
    await w.owner
      .updateTable('agent_instances')
      .set({ last_seen_at: new Date(warnedAt + DAY) })
      .where('org_id', '=', B.orgId)
      .execute();
    expect((await runInactivity(deps, warnedAt + 2 * DAY)).cleared).toContain(B.orgId);
    expect((await as(B, 'GET', '/org/status')).json().inactivity).toBeNull();

    // No data again: warned 30 days after that heartbeat, suspended 7 days later.
    const lastData = warnedAt + DAY;
    expect((await runInactivity(deps, lastData + 30 * DAY + 1000)).warned).toContain(B.orgId);
    expect((await runInactivity(deps, lastData + 36 * DAY)).suspended).toEqual([]);
    expect((await runInactivity(deps, lastData + 38 * DAY)).suspended).toContain(B.orgId);
    const suspended = (await as(B, 'GET', '/org/status')).json();
    expect(suspended.suspension).toMatchObject({ kind: 'inactive', reason: 'No data for 38 days' });
    const hb = await heartbeat(B.k8s.token, B.node);
    expect(hb.statusCode).toBe(402);
    expect(hb.json().type).toBe('urn:watchlog:problem:org-suspended');
    // Sign-in and reads still work; the export too.
    expect((await as(B, 'GET', '/org/export')).statusCode).toBe(200);
    const actions = await w.owner
      .selectFrom('audit_events')
      .select('action')
      .where('org_id', '=', B.orgId)
      .where('action', 'like', 'org_inactive_%')
      .execute();
    expect(actions.map((a) => a.action).sort()).toEqual([
      'org_inactive_suspended',
      'org_inactive_warned',
      'org_inactive_warned',
    ]);

    // The Owner reactivates; a viewer can't; a staff suspension can't be lifted this way.
    expect((await as(B, 'POST', '/org/reactivate', undefined, 'viewer')).statusCode).toBe(403);
    const back = await as(B, 'POST', '/org/reactivate');
    expect(back.statusCode).toBe(200);
    expect(back.json().suspension).toBeNull();
    expect((await heartbeat(B.k8s.token, B.node)).statusCode).toBe(204);
    await w.owner
      .updateTable('orgs')
      .set({ suspended_at: new Date(), suspension_kind: 'staff', suspended_reason: 'abuse' })
      .where('id', '=', B.orgId)
      .execute();
    expect((await as(B, 'POST', '/org/reactivate')).statusCode).toBe(409);
    await w.owner
      .updateTable('orgs')
      .set({ suspended_at: null, suspension_kind: null, suspended_reason: null })
      .where('id', '=', B.orgId)
      .execute();
  });

  it('a Pro org is never warned', async () => {
    await w.owner
      .updateTable('entitlements')
      .set({ plan: 'pro', source: 'staff' })
      .where('org_id', '=', B.orgId)
      .execute();
    const deps = { systemDb: w.owner, settings: noMail, log };
    expect((await runInactivity(deps, Date.now() + 90 * DAY)).warned).not.toContain(B.orgId);
  });
});

// Both retention tiers (ADR-177): the deletion and the export reach both. Needs two real
// VictoriaMetrics (WATCHLOG_TEST_VM_3D_URL, WATCHLOG_TEST_VM_30D_URL), else skipped.
const tiers = {
  '3d': process.env.WATCHLOG_TEST_VM_3D_URL,
  '30d': process.env.WATCHLOG_TEST_VM_30D_URL,
};
describe.skipIf(!tiers['3d'] || !tiers['30d'])('both tiers', () => {
  it('exports from both and deletes from both', async () => {
    const urls = tiers as Record<'3d' | '30d', string>;
    const client = new TieredVictoriaClient(
      urls,
      async () => ({ current: '30d', previous: '3d' }),
      log,
    );
    const cluster = '00000000-0000-4000-8000-0000000000a1';
    const scope = authorisedScope(cluster);
    const now = Date.now();
    for (const tier of ['3d', '30d'] as const) {
      await new VictoriaQueryClient(urls[tier]).write(
        scope,
        await (
          await import('./support/remote-write.js')
        ).encode([
          { labels: { __name__: `zz_tier_${tier.replace('d', '')}` }, value: 1, timestampMs: now },
        ]),
      );
      await fetch(`${urls[tier]}/internal/force_flush`);
    }
    const parts = await client.exportSeries(
      scope,
      Math.floor(now / 1000) - 60,
      Math.floor(now / 1000) + 60,
    );
    const text = (await Promise.all(parts.map((p) => p.text()))).join('');
    expect(text).toContain('zz_tier_3');
    expect(text).toContain('zz_tier_30');
    expect(await client.deleteSeries(scope, now)).toEqual({ '3d': 1, '30d': 1 });
    const after = await client.exportSeries(
      scope,
      Math.floor(now / 1000) - 60,
      Math.floor(now / 1000) + 60,
    );
    expect((await Promise.all(after.map((p) => p.text()))).join('').trim()).toBe('');
  });
});

describe('deleting a cluster (SR-15)', () => {
  it("takes its series with it in Cloud; the org's other clusters keep theirs", async () => {
    const made = await as(B, 'POST', '/clusters', { name: 'zzbeta-gone', kind: 'docker' });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().cluster.id as string;
    const token = made.json().token.value as string;
    await writeSeries(w.app, token, [
      { labels: { __name__: 'zz_sr15', host: 'h' }, value: 1, timestampMs: Date.now() },
    ]);
    await writeSeries(w.app, B.k8s.token, [
      { labels: { __name__: 'zz_sr15', node: 'n' }, value: 1, timestampMs: Date.now() },
    ]);
    expect(await seriesOf(id)).toBeGreaterThan(0);
    const kept = await seriesOf(B.k8s.id);
    expect((await as(B, 'DELETE', `/clusters/${id}`)).statusCode).toBe(204);
    // The deletion runs after the answer.
    await expect.poll(() => seriesOf(id), { timeout: 10_000, interval: 250 }).toBe(0);
    expect(await seriesOf(B.k8s.id)).toBe(kept);
  });
});
