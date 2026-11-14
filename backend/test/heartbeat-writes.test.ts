// SPDX-License-Identifier: AGPL-3.0-only
// The heartbeat writes its times at most once a minute per agent and cluster, and a change
// of state at once (ingest/heartbeat.ts). Each reader of those times still answers right
// when the stored time is as far behind as the throttle lets it be: the cluster's status
// and node count, the onboarding checklist, the overview, "data delayed", the alert
// worker's silent agents, usage_hourly and the plan's node count.
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { EvalContext } from '../src/modules/alerts/engine.js';
import { AGENT_SILENT_MS, clusterReporting } from '../src/modules/alerts/holding.js';
import { hourOf, recordUsage } from '../src/modules/entitlements/usage.js';
import { ingestFailures } from '../src/modules/ingest/errors.js';
import {
  LAST_SEEN_WRITE_MS,
  recordHeartbeat,
  stableJson,
  type Heartbeat,
} from '../src/modules/ingest/heartbeat.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';

const CLOUD: Partial<Config> = {
  edition: 'cloud',
  cookieSecure: 'always',
  ingestUrl: 'https://ingest.watchlog.example',
};
const offline = (async () => new Response('offline', { status: 599 })) as typeof fetch;
/** The most a stored time lags: a write is due at 60 s, the next heartbeat comes 15 s on. */
const LAG_MS = LAST_SEEN_WRITE_MS + 14_000;

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

async function cloud() {
  ctx = await createTestContext(
    {
      ...CLOUD,
      accounts: {
        turnstile: {},
        supportEmail: 'support@watchlog.io',
        sampleUrl: 'https://demo.watchlog.io',
      },
    },
    { fetch: offline },
  );
  const c = ctx;
  const res = await c.app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email: `hb-${Date.now()}@acme.example`, password: 'a long enough password' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const cookie = res.cookies.find((x) => x.name === 'wl_session')!.value;
  const call = (method: string, url: string, payload?: object) =>
    c.app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      cookies: { wl_session: cookie },
      ...(payload ? { payload } : {}),
    });
  const orgId = (await call('GET', '/me')).json().user.org.id as string;
  await c.app.entitlements!.put(orgId, { plan: 'pro', source: 'beta' });
  const cluster = async (name: string, kind: 'kubernetes' | 'docker') => {
    const r = await call('POST', '/clusters', { name, kind });
    expect(r.statusCode, r.body).toBe(201);
    return {
      owner: { clusterId: r.json().cluster.id as string, orgId },
      token: r.json().token.value as string,
    };
  };
  return { c, call, orgId, cluster };
}

const beat = (node: string, mode: Heartbeat['mode'] = 'docker', more: Partial<Heartbeat> = {}) => ({
  agent_version: '0.6.0',
  mode,
  node,
  capabilities: { ebpf: 'disabled', cgroup: 'v2' },
  series: 100,
  ...more,
});

const agentRow = (c: TestContext, clusterId: string, node: string) =>
  c.db
    .selectFrom('agent_instances')
    .selectAll()
    .where('cluster_id', '=', clusterId)
    .where('node', '=', node)
    .executeTakeFirstOrThrow();
const clusterRow = (c: TestContext, id: string) =>
  c.db.selectFrom('clusters').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

describe('what a heartbeat writes', () => {
  it('writes the times at most once a minute, a change of state at once', async () => {
    const { c, cluster } = await cloud();
    const { owner } = await cluster('fleet', 'docker');
    // Mid-hour, so the hour rule doesn't add a write.
    const t0 = hourOf(Date.now()).getTime() - 30 * 60_000;
    const at = (s: number) => new Date(t0 + s * 1000);

    expect(await recordHeartbeat(c.db, owner, beat('h1'), at(0))).toEqual({
      agent: 'inserted',
      cluster: true,
    });
    expect((await clusterRow(c, owner.clusterId)).node_count).toBe(1);
    // Every 15 s after that: nothing until a minute has passed.
    for (const s of [15, 30, 45])
      expect(
        await recordHeartbeat(c.db, owner, beat('h1', 'docker', { series: s }), at(s)),
      ).toEqual({ agent: null, cluster: false });
    expect((await agentRow(c, owner.clusterId, 'h1')).last_seen_at).toEqual(at(0));
    expect(await recordHeartbeat(c.db, owner, beat('h1'), at(60))).toEqual({
      agent: 'updated',
      cluster: true,
    });
    expect((await agentRow(c, owner.clusterId, 'h1')).last_seen_at).toEqual(at(60));
    expect((await clusterRow(c, owner.clusterId)).last_seen_at).toEqual(at(60));

    // A new agent: written at once, with the cluster's node count.
    expect(await recordHeartbeat(c.db, owner, beat('h2'), at(65))).toEqual({
      agent: 'inserted',
      cluster: true,
    });
    expect((await clusterRow(c, owner.clusterId)).node_count).toBe(2);
    // The other agent's next beats are within the minute: nothing, neither for the cluster.
    expect(await recordHeartbeat(c.db, owner, beat('h1'), at(75))).toEqual({
      agent: null,
      cluster: false,
    });

    // A new version: the agent's row and the cluster's at once.
    expect(
      await recordHeartbeat(c.db, owner, beat('h1', 'docker', { agent_version: '0.6.1' }), at(80)),
    ).toEqual({ agent: 'updated', cluster: true });
    expect((await clusterRow(c, owner.clusterId)).agent_version).toBe('0.6.1');
    // New capabilities (eBPF turned on): the agent's row at once.
    const ebpf = beat('h1', 'docker', {
      agent_version: '0.6.1',
      capabilities: { cgroup: 'v2', ebpf: 'enabled' },
    });
    expect(await recordHeartbeat(c.db, owner, ebpf, at(85))).toEqual({
      agent: 'updated',
      cluster: false,
    });
    expect((await agentRow(c, owner.clusterId, 'h1')).capabilities).toEqual({
      ebpf: 'enabled',
      cgroup: 'v2',
    });
    // The same capabilities in another key order are no change.
    expect(
      await recordHeartbeat(
        c.db,
        owner,
        { ...ebpf, capabilities: { ebpf: 'enabled', cgroup: 'v2' } },
        at(90),
      ),
    ).toEqual({ agent: null, cluster: false });
  });

  it('writes the first heartbeat of an hour, so usage_hourly counts that hour', async () => {
    const { c, cluster } = await cloud();
    const { owner } = await cluster('fleet', 'docker');
    const hour = hourOf(Date.now()).getTime();
    await recordHeartbeat(c.db, owner, beat('h1'), new Date(hour - 20_000));
    expect(await recordHeartbeat(c.db, owner, beat('h1'), new Date(hour - 5_000))).toEqual({
      agent: null,
      cluster: false,
    });
    expect((await recordHeartbeat(c.db, owner, beat('h1'), new Date(hour + 10_000))).agent).toBe(
      'updated',
    );
    expect((await agentRow(c, owner.clusterId, 'h1')).last_seen_at).toEqual(
      new Date(hour + 10_000),
    );
  });

  it('counts an agent back after a silence in the node count at once', async () => {
    const { c, cluster } = await cloud();
    const { owner } = await cluster('prod', 'kubernetes');
    const now = Date.now();
    await recordHeartbeat(c.db, owner, beat('n1', 'node'), new Date(now - 10 * 60_000));
    await recordHeartbeat(c.db, owner, beat('n2', 'node'), new Date(now - 20_000));
    await recordHeartbeat(c.db, owner, beat('cluster-agent', 'cluster'), new Date(now - 10_000));
    // n1 is silent: the cluster counts one node (the cluster-agent is not one).
    expect((await clusterRow(c, owner.clusterId)).node_count).toBe(1);
    expect(await recordHeartbeat(c.db, owner, beat('n1', 'node'), new Date(now))).toEqual({
      agent: 'updated',
      cluster: true,
    });
    expect((await clusterRow(c, owner.clusterId)).node_count).toBe(2);
  });

  it('compares capabilities whatever their key order', () => {
    expect(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"x":1,"y":2}]},"b":1}',
    );
  });
});

describe('the readers, with a stored time as far behind as the throttle allows', () => {
  /** An agent whose last write was LAG_MS ago and whose later beats were skipped. */
  async function lagging(
    c: TestContext,
    owner: { clusterId: string; orgId: string },
    node: string,
    mode: Heartbeat['mode'],
  ) {
    const now = Date.now();
    await recordHeartbeat(c.db, owner, beat(node, mode), new Date(now - LAG_MS));
    // A later beat inside the minute writes nothing (unless it starts a new hour).
    const later = await recordHeartbeat(c.db, owner, beat(node, mode), new Date(now - 15_000));
    if (hourOf(now - LAG_MS).getTime() === hourOf(now - 15_000).getTime())
      expect(later).toEqual({ agent: null, cluster: false });
  }

  it('Docker: status, nodes, the checklist, the overview, the plan and the usage', async () => {
    const { c, call, orgId, cluster } = await cloud();
    const { owner } = await cluster('fleet', 'docker');
    await lagging(c, owner, 'h1', 'docker');

    const list = (await call('GET', '/clusters')).json().clusters as {
      id: string;
      status: string;
      nodeCount: number;
    }[];
    expect(list.find((x) => x.id === owner.clusterId)).toMatchObject({
      status: 'active',
      nodeCount: 1,
    });

    const status = await call('GET', `/clusters/${owner.clusterId}/onboarding-status`);
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json().steps.find((s: { id: string }) => s.id === 'agent')).toMatchObject({
      state: 'done',
      nodes: 1,
    });

    const overview = await call('GET', `/clusters/${owner.clusterId}/overview`);
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.json().nodes).toEqual([expect.objectContaining({ name: 'h1', ready: true })]);

    const plan = await call('GET', '/plan');
    expect(plan.statusCode, plan.body).toBe(200);
    expect(plan.json().usage.nodes).toBe(1);

    await recordUsage({ systemDb: c.db, db: c.db }, Date.now());
    const usage = await c.db
      .selectFrom('usage_hourly')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('hour', '=', hourOf(Date.now()))
      .executeTakeFirst();
    // The agent's stored time may still be in the previous hour only if no beat came in
    // this one; the hour rule writes the first beat of an hour, so this hour counts it.
    expect(usage).toMatchObject({ docker_hosts: 1 });
  });

  it('Kubernetes: the alert worker sees no silent agent, and sees one after 3 minutes', async () => {
    const { c, cluster } = await cloud();
    const { owner } = await cluster('prod', 'kubernetes');
    await lagging(c, owner, 'n1', 'node');
    await lagging(c, owner, 'cluster-agent', 'cluster');
    const reporting = (now: number) =>
      clusterReporting({
        db: c.db,
        cluster: { id: owner.clusterId, kind: 'kubernetes' } as EvalContext['cluster'],
        now,
        memo: (_k, fn) => fn(),
      } as Pick<EvalContext, 'db' | 'cluster' | 'now' | 'memo'>);
    const live = await reporting(Date.now());
    expect(live.silent).toEqual([]);
    expect(live.allSilent).toBe(false);
    // Nothing more arrives: silent once the stored time is 3 minutes old.
    const later = await reporting(Date.now() - LAG_MS + AGENT_SILENT_MS);
    expect(later.allSilent).toBe(true);
  });

  it('"data delayed" clears with a good heartbeat that writes nothing', async () => {
    const { c, cluster } = await cloud();
    const { owner, token } = await cluster('fleet', 'docker');
    const send = (payload: object) =>
      c.app.inject({
        method: 'POST',
        url: '/ingest/v1/heartbeat',
        headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': 'h1' },
        payload,
      });
    expect((await send(beat('h1'))).statusCode).toBe(204);
    expect((await send({ node: 'h1' })).statusCode).toBe(400);
    expect(
      (await ingestFailures(c.db, [owner.clusterId], Date.now())).get(owner.clusterId),
    ).toBeTruthy();
    const before = (await agentRow(c, owner.clusterId, 'h1')).updated_at;
    expect((await send(beat('h1'))).statusCode).toBe(204);
    // Nothing written for the agent (within the minute), and the failure is over.
    expect((await agentRow(c, owner.clusterId, 'h1')).updated_at).toEqual(before);
    expect(
      (await ingestFailures(c.db, [owner.clusterId], Date.now())).get(owner.clusterId) ?? null,
    ).toBeNull();
  });
});
