// SPDX-License-Identifier: AGPL-3.0-only
// One trigger + resolve test per state default rule (ADR-072, ADR-086), plus the
// captured kind cluster: its crash-looping and OOM-killed test pods fire, nothing else.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { DEFAULT_RULES, ensureDefaultRules, lookupEvaluator } from '../src/modules/alerts/rules.js';
import type { AlertWorker } from '../src/modules/alerts/worker.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';
import { T0, createOrgCluster, insertChannel, testWorker } from './support/alerts.js';
import { createSession } from '../src/modules/auth/sessions.js';

const CYCLE = 30_000;
const iso = (ms: number) => new Date(ms).toISOString();

let ctx: TestContext;
let worker: AlertWorker;
let orgId: string;
let clusterId: string;
const clock = { now: T0 };

async function setup(kind: 'kubernetes' | 'docker' = 'kubernetes') {
  ({ orgId, clusterId } = await createOrgCluster(ctx.db, kind));
  worker = testWorker(ctx.db, clock, lookupEvaluator, {
    prepareOrg: (id) => ensureDefaultRules(ctx.db, id),
  });
}

async function put(
  kind: string,
  name: string,
  o: { namespace?: string; node?: string; spec?: object; status?: object } = {},
) {
  const namespace = o.namespace ?? (kind === 'Node' || kind.startsWith('Docker') ? '' : 'wl-test');
  const uid = `${kind}/${namespace}/${name}`;
  const values = {
    spec_summary: JSON.stringify(o.spec ?? {}),
    status_summary: JSON.stringify(o.status ?? {}),
    deleted_at: null,
  };
  await ctx.db
    .insertInto('objects')
    .values({
      id: newId(),
      cluster_id: clusterId,
      source: kind.startsWith('Docker') ? 'docker' : 'kubernetes',
      kind,
      namespace,
      name,
      uid,
      node: o.node ?? '',
      ...values,
    })
    .onConflict((oc) => oc.columns(['cluster_id', 'uid']).doUpdateSet(values))
    .execute();
}

async function remove(kind: string, name: string, namespace = 'wl-test') {
  await ctx.db
    .updateTable('objects')
    .set({ deleted_at: new Date(clock.now) })
    .where('uid', '=', `${kind}/${namespace}/${name}`)
    .execute();
}

/** A session of an owner in the test org, for API checks. */
async function sessionFor(): Promise<string> {
  const userId = newId();
  await ctx.db
    .insertInto('users')
    .values({ id: userId, email: `${userId}@example.com`, name: 'T', password_hash: 'x' })
    .execute();
  await ctx.db
    .insertInto('memberships')
    .values({ id: newId(), org_id: orgId, user_id: userId, role: 'owner' })
    .execute();
  return (await createSession(ctx.db, userId)).token;
}

async function cycles(n: number) {
  for (let i = 0; i < n; i++) {
    await worker.runCycle();
    clock.now += CYCLE;
  }
}

/** Open and resolved alerts of one rule, with what a message would say. */
async function alerts(ruleKey: string) {
  return ctx.db
    .selectFrom('alert_states as s')
    .innerJoin('alert_rules as r', 'r.id', 's.rule_id')
    .select(['s.state', 's.fingerprint', 's.labels', 's.details', 's.severity'])
    .where('r.rule_key', '=', ruleKey)
    .orderBy('s.fingerprint')
    .execute();
}
const states = async (key: string) => (await alerts(key)).map((a) => a.state);

function agent(node: string, mode: string, seen: number) {
  return ctx.db
    .insertInto('agent_instances')
    .values({
      id: newId(),
      cluster_id: clusterId,
      node,
      mode,
      agent_version: '1',
      last_seen_at: new Date(seen),
    })
    .onConflict((oc) =>
      oc.columns(['cluster_id', 'node']).doUpdateSet({ last_seen_at: new Date(seen) }),
    )
    .execute();
}

const pod = (status: object, spec: object = {}) => ({
  spec: { workload: { kind: 'Deployment', name: 'web' }, created_at: iso(T0 - 3600_000), ...spec },
  status: { phase: 'Running', ...status },
});
const running = { containers: [{ name: 'main', ready: true, state: 'running', restart_count: 0 }] };

beforeEach(async () => {
  ctx = await createTestContext();
  clock.now = T0;
});
afterEach(async () => {
  await worker.stop();
  await closeTestContext(ctx);
});

describe('default rules', () => {
  it("are seeded for every org once and keep the user's edits", async () => {
    await setup();
    await cycles(1);
    const rules = await ctx.db
      .selectFrom('alert_rules')
      .selectAll()
      .where('org_id', '=', orgId)
      .execute();
    expect(rules.map((r) => r.rule_key).sort()).toEqual(DEFAULT_RULES.map((r) => r.key).sort());
    expect(rules.every((r) => r.enabled && r.type === 'default')).toBe(true);
    await ctx.db
      .updateTable('alert_rules')
      .set({ for_seconds: 600 })
      .where('rule_key', '=', 'k8s.pod.crashloop')
      .execute();
    await ensureDefaultRules(ctx.db, orgId);
    const crash = await ctx.db
      .selectFrom('alert_rules')
      .select('for_seconds')
      .where('rule_key', '=', 'k8s.pod.crashloop')
      .executeTakeFirstOrThrow();
    expect(crash.for_seconds).toBe(600);
  });
});

describe('state rules: trigger and resolve', () => {
  it('k8s.pod.crashloop: one alert per workload after 2 min, resolved when the pods are gone', async () => {
    await setup();
    const crashing = pod({
      ready: false,
      containers: [
        {
          name: 'main',
          ready: false,
          state: 'waiting',
          reason: 'CrashLoopBackOff',
          restart_count: 6,
          last_termination: { reason: 'Error', exit_code: 1, finished_at: iso(T0 - 20_000) },
        },
      ],
    });
    await put('Pod', 'web-1', crashing);
    await put('Pod', 'web-2', crashing);
    await cycles(4);
    expect(await states('k8s.pod.crashloop')).toEqual(['pending']);
    await cycles(1);
    const [a] = await alerts('k8s.pod.crashloop');
    expect(a).toMatchObject({
      state: 'firing',
      severity: 'critical',
      fingerprint: 'pod:wl-test/Deployment/web',
      labels: { namespace: 'wl-test', workload: 'web', workload_kind: 'Deployment' },
      details: {
        summary: 'main: Error (exit 1), 6 restarts',
        podCount: 2,
        pods: ['web-1', 'web-2'],
      },
    });
    await remove('Pod', 'web-1');
    await remove('Pod', 'web-2');
    await cycles(2);
    expect(await states('k8s.pod.crashloop')).toEqual(['resolved']);
  });

  it('k8s.container.oomkilled: fires on a kill and resolves 10 min after the last one', async () => {
    await setup();
    await put(
      'Pod',
      'oom',
      pod(
        {
          containers: [
            {
              name: 'main',
              ready: true,
              state: 'running',
              restart_count: 1,
              last_termination: {
                reason: 'OOMKilled',
                exit_code: 137,
                finished_at: iso(T0 - 60_000),
              },
            },
          ],
        },
        { workload: { kind: 'Pod', name: 'oom' } },
      ),
    );
    await cycles(1);
    const [a] = await alerts('k8s.container.oomkilled');
    expect(a).toMatchObject({
      state: 'firing',
      fingerprint: 'pod:wl-test/Pod/oom',
      severity: 'warning',
    });
    expect(a!.details).toMatchObject({ summary: 'main: OOMKilled (exit 137), 1 restart' });
    await cycles(17); // 8.5 min: the kill is 9.5 min old
    expect(await states('k8s.container.oomkilled')).toEqual(['firing']);
    await cycles(3);
    expect(await states('k8s.container.oomkilled')).toEqual(['resolved']);
  });

  it("k8s.pod.pending: counts from the pod's creation and resolves when it runs", async () => {
    await setup();
    await put(
      'Pod',
      'stuck',
      pod({ phase: 'Pending', reason: 'Unschedulable' }, { created_at: iso(T0 - 6 * 60_000) }),
    );
    await put(
      'Pod',
      'new',
      pod({ phase: 'Pending' }, { workload: { kind: 'Pod', name: 'new' }, created_at: iso(T0) }),
    );
    await cycles(1);
    expect((await alerts('k8s.pod.pending')).map((a) => [a.fingerprint, a.state])).toEqual([
      ['pod:wl-test/Deployment/web', 'firing'],
      ['pod:wl-test/Pod/new', 'pending'],
    ]);
    await put('Pod', 'stuck', pod(running));
    await put('Pod', 'new', pod(running, { workload: { kind: 'Pod', name: 'new' } }));
    await cycles(2);
    expect(await states('k8s.pod.pending')).toEqual(['resolved']);
  });

  it('k8s.pod.imagepull: fires after 2 min of ImagePullBackOff and resolves when pulled', async () => {
    await setup();
    await put(
      'Pod',
      'web-1',
      pod({
        phase: 'Pending',
        containers: [
          {
            name: 'main',
            ready: false,
            state: 'waiting',
            reason: 'ImagePullBackOff',
            restart_count: 0,
          },
        ],
      }),
    );
    await cycles(5);
    expect(await alerts('k8s.pod.imagepull')).toMatchObject([
      { state: 'firing', details: { summary: 'main: ImagePullBackOff' } },
    ]);
    await put('Pod', 'web-1', pod(running));
    await cycles(2);
    expect(await states('k8s.pod.imagepull')).toEqual(['resolved']);
  });

  it('k8s.node.notready: fires 1 min after the transition and resolves when Ready', async () => {
    await setup();
    const node = (status: string, since: number) => ({
      status: {
        conditions: [
          {
            type: 'Ready',
            status,
            reason: status === 'True' ? 'KubeletReady' : 'NodeStatusUnknown',
            since: iso(since),
          },
        ],
      },
    });
    await put('Node', 'worker-1', node('Unknown', T0 - 90_000));
    await put('Node', 'worker-2', node('True', T0 - 3600_000));
    await cycles(1);
    expect(await alerts('k8s.node.notready')).toMatchObject([
      {
        state: 'firing',
        fingerprint: 'node:worker-1',
        severity: 'critical',
        labels: { node: 'worker-1' },
      },
    ]);
    await put('Node', 'worker-1', node('True', clock.now));
    await cycles(2);
    expect(await states('k8s.node.notready')).toEqual(['resolved']);
  });

  it('k8s.node.pressure: one alert per node and condition, resolved when it clears', async () => {
    await setup();
    const node = (mem: string, disk: string) => ({
      status: {
        conditions: [
          { type: 'MemoryPressure', status: mem, since: iso(T0) },
          { type: 'DiskPressure', status: disk, since: iso(T0) },
          { type: 'PIDPressure', status: 'True', since: iso(T0) },
          { type: 'Ready', status: 'True', since: iso(T0) },
        ],
      },
    });
    await put('Node', 'worker-1', node('True', 'True'));
    await cycles(1);
    expect((await alerts('k8s.node.pressure')).map((a) => [a.fingerprint, a.state])).toEqual([
      ['node:worker-1:DiskPressure', 'firing'],
      ['node:worker-1:MemoryPressure', 'firing'],
    ]);
    await put('Node', 'worker-1', node('False', 'True'));
    await cycles(2);
    expect((await alerts('k8s.node.pressure')).map((a) => a.state)).toEqual(['firing', 'resolved']);
  });

  it('k8s.deployment.unavailable: fires after 5 min below the desired replicas', async () => {
    await setup();
    await put('Deployment', 'api', { spec: { replicas: 3 }, status: { ready: 1, replicas: 3 } });
    await put('Deployment', 'idle', { spec: { replicas: 0 }, status: {} });
    await cycles(10);
    expect(await states('k8s.deployment.unavailable')).toEqual(['pending']);
    await cycles(1);
    expect(await alerts('k8s.deployment.unavailable')).toMatchObject([
      {
        state: 'firing',
        fingerprint: 'deploy:wl-test/api',
        details: { summary: '1/3 replicas ready' },
      },
    ]);
    await put('Deployment', 'api', { spec: { replicas: 3 }, status: { ready: 3, replicas: 3 } });
    await cycles(2);
    expect(await states('k8s.deployment.unavailable')).toEqual(['resolved']);
  });

  it('docker.container.unhealthy: fires for an unhealthy running container', async () => {
    await setup('docker');
    const container = (health: string) => ({
      node: 'host-1',
      status: { state: 'running', health, status: `Up 8 minutes (${health})` },
    });
    await put('DockerContainer', 'web', container('unhealthy'));
    await put('DockerContainer', 'cache', container('healthy'));
    await cycles(1);
    expect(await alerts('docker.container.unhealthy')).toMatchObject([
      {
        state: 'firing',
        fingerprint: 'docker:host-1/web',
        labels: { node: 'host-1', container: 'web' },
      },
    ]);
    await put('DockerContainer', 'web', container('healthy'));
    await cycles(2);
    expect(await states('docker.container.unhealthy')).toEqual(['resolved']);
  });

  it('agent.not_reporting: fires after 3 min without a heartbeat, ignores removed nodes', async () => {
    await setup();
    await put('Node', 'worker-1', { status: { conditions: [] } });
    await put('Node', 'worker-2', { status: { conditions: [] } });
    await agent('worker-2', 'node', T0 + 3600_000); // keeps reporting: not every agent is silent
    await agent('worker-1', 'node', T0 - 4 * 60_000);
    await agent('worker-gone', 'node', T0 - 4 * 60_000); // its Node object no longer exists
    await agent('cluster-agent', 'cluster', T0 - 60_000);
    await cycles(1);
    expect((await alerts('agent.not_reporting')).map((a) => [a.fingerprint, a.state])).toEqual([
      ['agent:node:worker-1', 'firing'],
    ]);
    await cycles(4); // the cluster-agent is silent for 3.5 min now
    expect((await alerts('agent.not_reporting')).map((a) => a.fingerprint)).toEqual([
      'agent:cluster:cluster-agent',
      'agent:node:worker-1',
    ]);
    await agent('worker-1', 'node', clock.now);
    await agent('cluster-agent', 'cluster', clock.now);
    await cycles(2);
    expect(await states('agent.not_reporting')).toEqual(['resolved', 'resolved']);
  });
});

describe('grouping and holding (ADR-094)', () => {
  const crashing = (node: string, workload = 'web') =>
    pod(
      {
        ready: false,
        containers: [
          {
            name: 'main',
            ready: false,
            state: 'waiting',
            reason: 'CrashLoopBackOff',
            restart_count: 6,
            last_termination: { reason: 'Error', exit_code: 1, finished_at: iso(T0) },
          },
        ],
      },
      { workload: { kind: 'Deployment', name: workload } },
    );
  const ready = (status: string) => ({
    status: { conditions: [{ type: 'Ready', status, since: iso(T0 - 3600_000) }] },
  });
  /** Every agent's heartbeat at `at`. */
  async function heartbeats(at: number) {
    for (const [node, mode] of [
      ['worker-1', 'node'],
      ['worker-2', 'node'],
      ['cluster-agent', 'cluster'],
    ]) {
      await agent(node!, mode!, at);
    }
  }
  const outbox = async () =>
    (
      await ctx.db
        .selectFrom('notifications as n')
        .innerJoin('notification_alerts as na', 'na.notification_id', 'n.id')
        .innerJoin('alert_states as s', 's.id', 'na.alert_state_id')
        .select(['n.kind', 's.fingerprint'])
        .orderBy('n.created_at')
        .execute()
    ).map((r) => `${r.kind} ${r.fingerprint}`);
  async function withChannel() {
    const ch = await insertChannel(ctx.db, orgId);
    await worker.runCycle(); // seeds the default rules
    await ctx.db
      .updateTable('alert_rules')
      .set({ channel_ids: [ch] })
      .execute();
  }
  const held = async (key: string) =>
    (
      await ctx.db
        .selectFrom('alert_states as s')
        .innerJoin('alert_rules as r', 'r.id', 's.rule_id')
        .select(['s.fingerprint', 's.state', 's.held'])
        .where('r.rule_key', '=', key)
        .orderBy('s.fingerprint')
        .execute()
    ).map((a) => `${a.fingerprint} ${a.state}${a.held ? ' held' : ''}`);

  it('raises one alert for a cluster whose agents are all silent, one per agent otherwise', async () => {
    await setup();
    await put('Node', 'worker-1', ready('True'));
    await put('Node', 'worker-2', ready('True'));
    await heartbeats(T0 + 3600_000);
    await withChannel();
    await agent('worker-1', 'node', T0 - 4 * 60_000);
    await cycles(1);
    expect(await held('agent.not_reporting')).toEqual(['agent:node:worker-1 firing']);

    await heartbeats(T0 - 10 * 60_000); // now the whole cluster is silent
    await cycles(2);
    expect(await held('agent.not_reporting')).toEqual([
      'agent:node:worker-1 firing held',
      'cluster firing',
    ]);
    const cluster = (await alerts('agent.not_reporting')).find((a) => a.fingerprint === 'cluster');
    expect(cluster!.labels).toEqual({ agent: 'all' });
    expect(cluster!.details).toMatchObject({ agents: 3 });

    await heartbeats(clock.now + 3600_000); // data comes back
    await cycles(3);
    expect(await held('agent.not_reporting')).toEqual([
      'agent:node:worker-1 resolved',
      'cluster resolved',
    ]);
    // Only the cluster-wide alert spoke while the cluster was silent.
    expect(await outbox()).toEqual([
      'firing agent:node:worker-1',
      'firing cluster',
      'resolved cluster',
      'resolved agent:node:worker-1',
    ]);
  });

  it("holds a silent cluster's other alerts and resolves them only from fresh data", async () => {
    await setup();
    await put('Node', 'worker-1', ready('True'));
    await put('Node', 'worker-2', ready('True'));
    await heartbeats(T0 + 3600_000);
    await withChannel();
    await put('Pod', 'web-1', { node: 'worker-1', ...crashing('worker-1') });
    await cycles(5);
    expect(await held('k8s.pod.crashloop')).toEqual(['pod:wl-test/Deployment/web firing']);

    await heartbeats(T0 - 10 * 60_000); // silent; its last report says nothing more
    await remove('Pod', 'web-1');
    await put('Pod', 'api-1', { node: 'worker-2', ...crashing('worker-2', 'api') });
    await cycles(8);
    // Kept, not resolved, not notified; nothing new is raised from stale data.
    expect(await held('k8s.pod.crashloop')).toEqual(['pod:wl-test/Deployment/web firing held']);

    const api = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/alerts?held=true',
      cookies: { wl_session: await sessionFor() },
    });
    expect(api.json().counts.held).toBeGreaterThanOrEqual(1);
    expect(
      api.json().alerts.map((a: { labels: { workload?: string } }) => a.labels.workload),
    ).toContain('web');

    await heartbeats(clock.now + 3600_000); // data is back
    await cycles(6);
    expect(await held('k8s.pod.crashloop')).toEqual([
      'pod:wl-test/Deployment/api firing',
      'pod:wl-test/Deployment/web resolved',
    ]);
    expect((await outbox()).filter((m) => m.includes('pod:'))).toEqual([
      'firing pod:wl-test/Deployment/web',
      'resolved pod:wl-test/Deployment/web',
      'firing pod:wl-test/Deployment/api',
    ]);
  });

  it('holds pod alerts on a NotReady node under the node alert', async () => {
    await setup();
    await put('Node', 'worker-1', ready('False'));
    await put('Node', 'worker-2', ready('True'));
    await heartbeats(T0 + 3600_000);
    await put('Pod', 'web-1', { node: 'worker-1', ...crashing('worker-1') });
    await put('Pod', 'api-1', { node: 'worker-2', ...crashing('worker-2', 'api') });
    await cycles(5);
    expect(await held('k8s.node.notready')).toEqual(['node:worker-1 firing']);
    expect(await held('k8s.pod.crashloop')).toEqual(['pod:wl-test/Deployment/api firing']);

    await put('Node', 'worker-1', ready('True'));
    await cycles(5);
    expect(await held('k8s.pod.crashloop')).toEqual([
      'pod:wl-test/Deployment/api firing',
      'pod:wl-test/Deployment/web firing',
    ]);
    // A firing pod alert whose node goes NotReady is held, not resolved.
    await put('Node', 'worker-2', ready('Unknown'));
    await remove('Pod', 'api-1');
    await cycles(3);
    expect(await held('k8s.pod.crashloop')).toEqual([
      'pod:wl-test/Deployment/api firing held',
      'pod:wl-test/Deployment/web firing',
    ]);
  });
});

describe('the captured kind cluster', () => {
  it('fires for the crash-looping and OOM-killed test pods and nothing else (the OOM pod is crash-looping too)', async () => {
    const objects = JSON.parse(
      readFileSync(new URL('./fixtures/kind-objects.json', import.meta.url), 'utf8'),
    ) as {
      kind: string;
      namespace: string;
      name: string;
      node: string;
      spec: object;
      status: object;
    }[];
    // The fixture was captured at about 11:54 UTC.
    clock.now = Date.parse('2026-10-31T11:54:00Z');
    await setup();
    for (const o of objects) await put(o.kind, o.name, o);
    await cycles(5);
    const firing = await ctx.db
      .selectFrom('alert_states as s')
      .innerJoin('alert_rules as r', 'r.id', 's.rule_id')
      .select(['r.rule_key', 's.fingerprint'])
      .where('s.state', '=', 'firing')
      .orderBy('r.rule_key')
      .orderBy('s.fingerprint')
      .execute();
    expect(firing.map((f) => `${f.rule_key} ${f.fingerprint}`)).toEqual([
      'k8s.container.oomkilled pod:wl-test/Pod/oom',
      'k8s.pod.crashloop pod:wl-test/Pod/crashloop',
      'k8s.pod.crashloop pod:wl-test/Pod/oom',
    ]);
  });
});

describe('watchlog.ingest.failing (ADR-117)', () => {
  it('fires after 5 min of ingest errors, even while every agent looks silent, and resolves on success', async () => {
    await setup();
    const fail = (endpoint: string, sinceMs: number) =>
      ctx.db
        .insertInto('ingest_errors')
        .values({
          cluster_id: clusterId,
          endpoint,
          failing_since: new Date(sinceMs),
          last_error_at: new Date(clock.now),
          last_status: 500,
          last_message: 'internal error',
          failures: 12,
        })
        .onConflict((oc) =>
          oc
            .columns(['cluster_id', 'endpoint'])
            .doUpdateSet({ last_error_at: new Date(clock.now) }),
        )
        .execute();
    // Heartbeats fail too: the cluster looks silent, which holds every other rule.
    await fail('objects', clock.now);
    await fail('heartbeat', clock.now);
    await cycles(1);
    expect(await states('watchlog.ingest.failing')).toEqual(['pending']);
    for (let i = 0; i < 10; i++) {
      await fail('objects', clock.now - 30_000);
      await cycles(1);
    }
    const a = (await alerts('watchlog.ingest.failing'))[0]!;
    expect([a.fingerprint, a.state, a.severity]).toEqual(['ingest', 'firing', 'critical']);
    await ctx.db
      .updateTable('ingest_errors')
      .set({ failing_since: null })
      .where('cluster_id', '=', clusterId)
      .execute();
    await cycles(2);
    expect(await states('watchlog.ingest.failing')).toEqual(['resolved']);
  });

  it('is a default rule: critical, after 5 min', () => {
    const rule = DEFAULT_RULES.find((r) => r.key === 'watchlog.ingest.failing');
    expect([rule?.name, rule?.severity, rule?.forSeconds]).toEqual([
      'WatchLog ingest failing',
      'critical',
      300,
    ]);
  });
});
