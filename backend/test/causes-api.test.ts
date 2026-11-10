// SPDX-License-Identifier: AGPL-3.0-only
// GET /api/v1/causes (ADR-148) on a seeded backend: a Kubernetes cluster (the kind fixtures)
// and a Docker fleet. Sign-in, 400 on a bad subject, 404 on an unknown object or cluster, a
// well-formed "no clear cause" answer for a pod, a workload, a container, a Compose service
// and an alert on each, read as the session or as an API token, kept 15 s.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { insertRule } from './support/alerts.js';
import { container, dockerFleet, kindCluster } from './support/mcp-fixtures.js';

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

async function seeded() {
  ctx = await createTestContext();
  const cookie = await setupAdmin(ctx.app);
  const kube = await kindCluster(ctx, cookie);
  const fleet = await dockerFleet(ctx, cookie, {
    'docker-01': [
      container('a', 'shop-web-1', { compose_service: 'web' }),
      container('b', 'shop-api-1', {
        compose_service: 'api',
        state: 'restarting',
        exit_code: 1,
        restart_count: 6,
        restarting: true,
      }),
    ],
  });
  const org = await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow();
  return { cookie, kube, fleet, orgId: org.id };
}

const get = (cookie: string | null, query: Record<string, string>, headers = {}) =>
  ctx!.app.inject({
    method: 'GET',
    url: `/api/v1/causes?${new URLSearchParams(query)}`,
    ...(cookie ? { cookies: { wl_session: cookie } } : {}),
    headers,
  });

async function alert(
  orgId: string,
  clusterId: string,
  ruleKey: string,
  labels: Record<string, string>,
  resolved = false,
) {
  const ruleId = await insertRule(ctx!.db, orgId, { rule_key: ruleKey, name: ruleKey });
  const id = newId();
  const at = new Date(Date.now() - 5 * 60_000);
  await ctx!.db
    .insertInto('alert_states')
    .values({
      id,
      org_id: orgId,
      rule_id: ruleId,
      cluster_id: clusterId,
      fingerprint: `f-${id}`,
      state: resolved ? 'resolved' : 'firing',
      severity: 'critical',
      labels: JSON.stringify(labels),
      started_at: at,
      fired_at: at,
      resolved_at: resolved ? new Date(Date.now() - 60_000) : null,
    })
    .execute();
  return { id, firedAt: at.toISOString() };
}

/** What every answer has, whatever the subject. */
function wellFormed(body: Record<string, unknown>) {
  expect(body).toMatchObject({
    state: expect.stringMatching(/^(likely|possible|none)$/),
    checkedAt: expect.any(String),
    window: { from: expect.any(String), to: expect.any(String) },
    headline: { code: expect.any(String), facts: expect.any(Object) },
    causes: expect.any(Array),
    checks: expect.any(Array),
  });
  for (const c of body.checks as { topic: string; code: string; result: string }[]) {
    expect(c.code.startsWith(`${c.topic}_`), c.code).toBe(true);
    expect(['explains', 'possible', 'ok', 'not_run', 'not_applicable']).toContain(c.result);
  }
}

describe('GET /causes', () => {
  it('needs a session, a known subject form and a known cluster', async () => {
    const { cookie, kube, fleet } = await seeded();
    expect((await get(null, { cluster: kube.id, subject: 'pod:wl-test/oom' })).statusCode).toBe(
      401,
    );
    const bad = await get(cookie, { cluster: kube.id, subject: 'pods:wl-test/oom' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().detail).toMatch(/pod:<namespace>\/<pod>/);
    expect((await get(cookie, { cluster: kube.id, subject: 'pod:oom' })).statusCode).toBe(400);
    expect(
      (await get(cookie, { cluster: 'not-a-uuid', subject: 'pod:wl-test/oom' })).statusCode,
    ).toBe(400);
    // Kubernetes words on a Docker fleet, and the other way round.
    const words = await get(cookie, { cluster: fleet.id, subject: 'pod:wl-test/oom' });
    expect(words.statusCode).toBe(400);
    expect(words.json().detail).toMatch(/Docker fleet/);
    expect(
      (await get(cookie, { cluster: kube.id, subject: 'container:shop-web-1' })).statusCode,
    ).toBe(400);
    const nope = await get(cookie, { cluster: randomUUID(), subject: 'pod:wl-test/oom' });
    expect(nope.statusCode).toBe(404);
    expect(nope.json().detail).toBe('Cluster not found');
  });

  it('answers 404 for objects that do not exist', async () => {
    const { cookie, kube, fleet } = await seeded();
    for (const [cluster, subject, detail] of [
      [kube.id, 'pod:wl-test/nope', 'No pod with this name in this namespace'],
      [kube.id, 'workload:wl-test/nope', 'No workload with this name in this namespace'],
      [kube.id, `alert:${randomUUID()}`, 'Alert not found'],
      [
        kube.id,
        'application:shop/redis',
        'No monitored service with this id or name in this cluster',
      ],
      [
        kube.id,
        'edge:w:wl-test/Deployment/web>w:wl-test/StatefulSet/db:5432',
        'This edge is not on the service map (last hour)',
      ],
      [fleet.id, 'container:nope', 'No container with this name'],
      [fleet.id, 'compose_service:shop/nope', 'No Compose service with this name'],
    ] as const) {
      const res = await get(cookie, { cluster, subject });
      expect(res.statusCode, subject).toBe(404);
      expect(res.json().detail, subject).toBe(detail);
    }
  });

  it('keeps clusters of other orgs out', async () => {
    const { kube } = await seeded();
    const other = await createUserSession(ctx!.db, { role: 'owner' });
    const res = await get(other.cookie, { cluster: kube.id, subject: 'pod:wl-test/oom' });
    expect(res.statusCode).toBe(404);
  });

  it('Kubernetes: a pod, a workload and an alert, with what was checked', async () => {
    const { cookie, kube, orgId } = await seeded();
    const pod = await get(cookie, { cluster: kube.id, subject: 'pod:wl-test/crashloop' });
    expect(pod.statusCode, pod.body).toBe(200);
    const p = pod.json();
    wellFormed(p);
    expect(p).toMatchObject({
      subject: { kind: 'pod', ref: 'wl-test/crashloop', platform: 'kubernetes' },
      object: { kind: 'pod', ref: 'wl-test/crashloop' },
      cluster: { id: kube.id, name: 'kind', kind: 'kubernetes' },
      // Its container exits with a code (the seed's crash loop): crash_exit, on the pod itself.
      state: 'likely',
      causes: [{ rule: 'crash_exit', strength: 'likely' }],
      resolvedAt: null,
    });
    expect(p.headline.code).toMatch(/^crash_exit/);
    expect(p.checks.map((c: { topic: string }) => c.topic)).toEqual(
      expect.arrayContaining(['self', 'changes', 'node']),
    );
    expect(p.checks.find((c: { topic: string }) => c.topic === 'node')).toMatchObject({
      object: { kind: 'node', ref: 'watchlog-worker' },
    });
    // No agent reports flows: the checks of the services it calls could not run.
    expect(p.flowsOff).not.toBeNull();

    // The kind is filled in.
    const w = await get(cookie, { cluster: kube.id, subject: 'workload:wl-test/web' });
    expect(w.statusCode, w.body).toBe(200);
    wellFormed(w.json());
    expect(w.json().subject).toMatchObject({
      kind: 'workload',
      ref: 'wl-test/Deployment/web',
      name: 'wl-test/web',
      workloadKind: 'Deployment',
    });

    const a = await alert(orgId, kube.id, 'k8s.pod.crashloop', {
      namespace: 'wl-test',
      pod: 'crashloop',
      workload: 'crashloop',
      workload_kind: 'Pod',
      node: 'watchlog-worker',
    });
    const res = await get(cookie, { cluster: kube.id, subject: `alert:${a.id}` });
    expect(res.statusCode, res.body).toBe(200);
    wellFormed(res.json());
    expect(res.json()).toMatchObject({
      subject: { kind: 'alert', ref: a.id, name: 'k8s.pod.crashloop' },
      object: { kind: 'pod', ref: 'wl-test/crashloop' },
      symptomSince: a.firedAt,
      resolvedAt: null,
    });
    // Its pod's problem starts when the alert fired.
    const again = await get(cookie, { cluster: kube.id, subject: 'pod:wl-test/oom' });
    expect(again.statusCode).toBe(200);
    // Another cluster's alert is not this one's.
    const fleetRes = await get(cookie, {
      cluster: (
        await ctx!.db
          .selectFrom('clusters')
          .select('id')
          .where('kind', '=', 'docker')
          .executeTakeFirstOrThrow()
      ).id,
      subject: `alert:${a.id}`,
    });
    expect(fleetRes.statusCode).toBe(404);
  });

  it('a resolved alert says when it resolved ("was likely")', async () => {
    const { cookie, kube, orgId } = await seeded();
    const a = await alert(
      orgId,
      kube.id,
      'k8s.container.oomkilled',
      { namespace: 'wl-test', pod: 'oom' },
      true,
    );
    const res = await get(cookie, { cluster: kube.id, subject: `alert:${a.id}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().resolvedAt).toEqual(expect.any(String));
    expect(Date.parse(res.json().window.to)).toBe(Date.parse(res.json().resolvedAt));
  });

  it('an alert about no object: the changes only', async () => {
    const { cookie, kube, orgId } = await seeded();
    const a = await alert(orgId, kube.id, 'custom.metric', {});
    const res = await get(cookie, { cluster: kube.id, subject: `alert:${a.id}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ object: null, state: 'none' });
    expect(res.json().checks.map((c: { code: string }) => c.code)).toEqual([
      'self_no_object',
      expect.stringMatching(/^changes_cluster/),
    ]);
  });

  it('an alert on a node or a host: its own state, no "itself" line', async () => {
    const { cookie, kube, fleet, orgId } = await seeded();
    const n = await alert(orgId, kube.id, 'k8s.node.notready', { node: 'watchlog-worker' });
    const res = await get(cookie, { cluster: kube.id, subject: `alert:${n.id}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().object).toMatchObject({ kind: 'node', ref: 'watchlog-worker' });
    expect(res.json().checks.map((c: { topic: string }) => c.topic)).toEqual([
      'events',
      'changes',
      'node',
    ]);
    const h = await alert(orgId, fleet.id, 'node.agent.silent', {
      node: 'docker-01',
      agent: 'docker',
    });
    const host = await get(cookie, { cluster: fleet.id, subject: `alert:${h.id}` });
    expect(host.statusCode, host.body).toBe(200);
    expect(host.json().object).toMatchObject({
      kind: 'host',
      ref: 'docker-01',
      platform: 'docker',
    });
    expect(host.json().checks.map((c: { code: string }) => c.code)).toContain('host_ok');
  });

  it('Docker: a container, a Compose service and an alert', async () => {
    const { cookie, fleet, orgId } = await seeded();
    const c = await get(cookie, { cluster: fleet.id, subject: 'container:shop-api-1' });
    expect(c.statusCode, c.body).toBe(200);
    wellFormed(c.json());
    expect(c.json()).toMatchObject({
      subject: {
        kind: 'container',
        ref: 'docker-01/shop-api-1',
        host: 'docker-01',
        platform: 'docker',
      },
      cluster: { kind: 'docker' },
      state: 'none',
    });
    expect(c.json().checks.find((x: { topic: string }) => x.topic === 'host')).toMatchObject({
      code: 'host_ok',
      object: { kind: 'host', ref: 'docker-01' },
    });
    // The host's name works too.
    const named = await get(cookie, {
      cluster: fleet.id,
      subject: 'container:docker-01/shop-api-1',
    });
    expect(named.statusCode).toBe(200);

    const s = await get(cookie, { cluster: fleet.id, subject: 'compose_service:web' });
    expect(s.statusCode, s.body).toBe(200);
    wellFormed(s.json());
    expect(s.json().subject).toMatchObject({
      kind: 'compose_service',
      ref: 'shop/web',
      name: 'shop/web',
    });
    expect(s.json().checks[0]).toMatchObject({ topic: 'self', code: 'self_ok', result: 'ok' });

    const a = await alert(orgId, fleet.id, 'docker.container.restarting', {
      container: 'shop-api-1',
      node: 'docker-01',
    });
    const res = await get(cookie, { cluster: fleet.id, subject: `alert:${a.id}` });
    expect(res.statusCode, res.body).toBe(200);
    wellFormed(res.json());
    expect(res.json()).toMatchObject({
      subject: { kind: 'alert', ref: a.id },
      object: { kind: 'container', ref: 'docker-01/shop-api-1' },
      symptomSince: a.firedAt,
    });
  });

  it('reads as an API token too, and keeps an answer 15 s', async () => {
    const { cookie, fleet } = await seeded();
    const created = await ctx!.app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      cookies: { wl_session: cookie },
      payload: { name: 'causes' },
    });
    const token = created.json().value as string;
    const q = { cluster: fleet.id, subject: 'compose_service:shop/api' };
    const first = await get(null, q, { authorization: `Bearer ${token}` });
    expect(first.statusCode, first.body).toBe(200);
    wellFormed(first.json());
    const second = await get(cookie, q);
    expect(second.json().checkedAt).toBe(first.json().checkedAt);
  });
});
