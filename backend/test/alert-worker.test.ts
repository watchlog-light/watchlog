// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import {
  evaluateOrg,
  type EvaluatorLookup,
  type RuleEvaluator,
} from '../src/modules/alerts/engine.js';
import type { Observation } from '../src/modules/alerts/state-machine.js';
import type { AlertWorker } from '../src/modules/alerts/worker.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';
import { T0, createOrgCluster, insertChannel, insertRule, testWorker } from './support/alerts.js';

const CYCLE = 30_000;

let ctx: TestContext;
let workers: AlertWorker[];
const clock = { now: T0 };
/** The fake source: fingerprints whose condition holds now. */
let active: Map<string, Partial<Observation>>;
let failing: boolean;

const fake: RuleEvaluator = {
  kinds: ['kubernetes'],
  evaluate: async () => {
    if (failing) throw new Error('source down');
    return [...active].map(([fingerprint, o]) => ({
      fingerprint,
      severity: 'warning',
      labels: { namespace: 'wl-test', workload: fingerprint },
      details: {},
      ...o,
    }));
  },
};
const lookup: EvaluatorLookup = (rule) => (rule.rule_key === 'test.fake' ? fake : undefined);

function worker() {
  const w = testWorker(ctx.db, clock, lookup);
  workers.push(w);
  return w;
}
async function cycle(w: AlertWorker) {
  const report = await w.runCycle();
  clock.now += CYCLE;
  return report;
}
const notifications = () =>
  ctx.db.selectFrom('notifications').selectAll().orderBy('created_at').execute();
const states = () => ctx.db.selectFrom('alert_states').selectAll().execute();

beforeEach(async () => {
  ctx = await createTestContext();
  workers = [];
  clock.now = T0;
  active = new Map();
  failing = false;
});
afterEach(async () => {
  for (const w of workers) await w.stop();
  await closeTestContext(ctx);
});

describe('alert-worker cycle', () => {
  it('takes a rule from pending to firing to resolved with one outbox row per transition', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const ch = await insertChannel(ctx.db, orgId);
    await insertRule(ctx.db, orgId, { for_seconds: 60, channel_ids: [ch] });
    const w = worker();

    active.set('web', {});
    await cycle(w);
    expect((await states())[0]).toMatchObject({ state: 'pending' });
    await cycle(w);
    await cycle(w);
    expect((await states())[0]).toMatchObject({ state: 'firing', notified_firing: true });
    active.clear();
    await cycle(w);
    expect((await states())[0]!.state).toBe('firing');
    await cycle(w);
    await cycle(w);

    const rows = await notifications();
    expect(rows.map((n) => [n.kind, n.channel_id, n.status])).toEqual([
      ['firing', ch, 'pending'],
      ['resolved', ch, 'pending'],
    ]);
    expect((await states())[0]).toMatchObject({ state: 'resolved' });
    const links = await ctx.db.selectFrom('notification_alerts').selectAll().execute();
    expect(links).toHaveLength(2);
  });

  it('keeps the rule as each alert was evaluated, for its chart', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const rule = await insertRule(ctx.db, orgId, {
      condition: JSON.stringify({ op: '>', value: 0.85, critical: 0.95 }),
      for_seconds: 60,
    });
    const w = worker();
    active.set('web', {});
    await cycle(w);
    await cycle(w);
    await cycle(w);
    const fired = (await states())[0]!;
    expect(fired.state).toBe('firing');
    expect(fired.rule_snapshot).toEqual({
      name: 'Test rule',
      condition: { op: '>', value: 0.85, critical: 0.95 },
      forSeconds: 60,
      severity: 'warning',
      metric: null,
      scope: {},
    });
    // The rule changes while the alert keeps firing quietly: the alert keeps the values
    // it fired with; the next state change records the new ones.
    await ctx.db
      .updateTable('alert_rules')
      .set({ condition: JSON.stringify({ op: '>', value: 0.9 }) })
      .where('id', '=', rule)
      .execute();
    await cycle(w);
    expect((await states())[0]!.rule_snapshot).toMatchObject({ condition: { value: 0.85 } });
    active.clear();
    await cycle(w);
    expect((await states())[0]!.rule_snapshot).toMatchObject({
      condition: { op: '>', value: 0.9 },
    });
  });

  it('does not rewrite a firing alert whose data did not change', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    await insertRule(ctx.db, orgId);
    active.set('web', { details: { summary: 'x', pods: ['a', 'b'] } });
    const w = worker();
    await cycle(w);
    const v1 = (await states())[0]!.version;
    await cycle(w);
    await cycle(w);
    expect((await states())[0]!.version).toBe(v1);
    active.set('web', { details: { summary: 'y', pods: ['a', 'b'] } });
    await cycle(w);
    expect((await states())[0]!.version).toBe(v1 + 1);
  });

  it('fires into the UI only when the rule has no channel, and skips deleted channels', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    await insertRule(ctx.db, orgId, { channel_ids: [newId()] });
    active.set('web', {});
    await cycle(worker());
    expect((await states())[0]!.state).toBe('firing');
    expect(await notifications()).toEqual([]);
  });

  it('batches one rule and cluster into one message per channel with at most 5 items', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const chs = [await insertChannel(ctx.db, orgId), await insertChannel(ctx.db, orgId, 'slack')];
    await insertRule(ctx.db, orgId, { channel_ids: chs });
    for (let i = 0; i < 7; i++) active.set(`w${i}`, i === 6 ? { severity: 'critical' } : {});
    await cycle(worker());

    const rows = await notifications();
    expect(rows).toHaveLength(2);
    const payload = rows[0]!.payload as {
      items: { labels: { workload: string } }[];
      total: number;
      severity: string;
    };
    expect(payload.total).toBe(7);
    expect(payload.items).toHaveLength(5);
    expect(payload.severity).toBe('critical');
    expect(payload.items[0]!.labels.workload).toBe('w6');
    const links = await ctx.db.selectFrom('notification_alerts').selectAll().execute();
    expect(links).toHaveLength(14);
  });

  it('does not resolve alerts while the source fails, and records the error', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const ruleId = await insertRule(ctx.db, orgId);
    active.set('web', {});
    const w = worker();
    await cycle(w);
    failing = true;
    const report = await cycle(w);
    await cycle(w);
    expect(report.errors[0]).toMatch(/source down/);
    expect((await states())[0]!.state).toBe('firing');
    const rule = await ctx.db
      .selectFrom('alert_rules')
      .select('eval_error')
      .where('id', '=', ruleId)
      .executeTakeFirstOrThrow();
    expect(rule.eval_error).toBe('prod: source down');
    failing = false;
    await cycle(w);
    const after = await ctx.db
      .selectFrom('alert_rules')
      .select('eval_error')
      .where('id', '=', ruleId)
      .executeTakeFirstOrThrow();
    expect(after.eval_error).toBeNull();
  });

  it('closes the open alerts of a disabled rule without a message', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const ch = await insertChannel(ctx.db, orgId);
    const ruleId = await insertRule(ctx.db, orgId, { channel_ids: [ch] });
    active.set('web', {});
    const w = worker();
    await cycle(w);
    await ctx.db
      .updateTable('alert_rules')
      .set({ enabled: false })
      .where('id', '=', ruleId)
      .execute();
    await cycle(w);
    expect((await states())[0]!.state).toBe('resolved');
    expect((await notifications()).map((n) => n.kind)).toEqual(['firing']);
  });

  it('writes one transition when two evaluations of an org race', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const ch = await insertChannel(ctx.db, orgId);
    await insertRule(ctx.db, orgId, { channel_ids: [ch] });
    active.set('web', {});
    const deps = { db: ctx.db, evaluators: lookup };
    await Promise.all([1, 2, 3].map(() => evaluateOrg(deps, orgId, T0, () => true)));
    expect(await states()).toHaveLength(1);
    expect(await notifications()).toHaveLength(1);
  });

  it('prunes resolved alerts and finished notifications past the retention', async () => {
    const { orgId, clusterId } = await createOrgCluster(ctx.db);
    const ch = await insertChannel(ctx.db, orgId);
    const ruleId = await insertRule(ctx.db, orgId);
    const old = new Date(T0 - 91 * 86_400_000);
    const stateId = newId();
    await ctx.db
      .insertInto('alert_states')
      .values({
        id: stateId,
        org_id: orgId,
        rule_id: ruleId,
        cluster_id: clusterId,
        fingerprint: 'old',
        state: 'resolved',
        severity: 'warning',
        started_at: old,
        resolved_at: old,
      })
      .execute();
    await ctx.db
      .insertInto('notifications')
      .values({
        id: newId(),
        org_id: orgId,
        channel_id: ch,
        kind: 'firing',
        payload: '{}',
        dedupe_key: 'x',
        status: 'sent',
      })
      .execute();
    await sql`UPDATE notifications SET created_at = ${old}`.execute(ctx.db);
    await cycle(worker());
    expect(await states()).toEqual([]);
    expect(await notifications()).toEqual([]);
  });
});

describe('alert-worker locks and failover (ADR-073)', () => {
  it('shares the buckets between two workers and fails over when a lock connection drops', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const ch = await insertChannel(ctx.db, orgId);
    await insertRule(ctx.db, orgId, { channel_ids: [ch] });
    const a = worker();
    const b = worker();

    await cycle(a);
    expect(a.heldBuckets).toBe(64);
    await cycle(b); // b is live now but every bucket is taken
    expect(b.heldBuckets).toBe(0);
    await cycle(a); // a gives up its surplus
    expect(a.heldBuckets).toBe(32);
    await cycle(b);
    expect(b.heldBuckets).toBe(32);

    active.set('web', {});
    await cycle(a);
    await cycle(b);
    expect((await notifications()).map((n) => n.kind)).toEqual(['firing']);

    // a's lock session ends (crash, network): b takes every bucket in its next cycle.
    await sql`SELECT pg_terminate_backend(${a.lockPid}::int)`.execute(ctx.db);
    await new Promise((r) => setTimeout(r, 100));
    expect(a.health().ready).toBe(false);
    await cycle(b);
    expect(b.heldBuckets).toBe(64);
    // a reconnects but finds nothing free, so it evaluates nothing.
    const ra = await cycle(a);
    expect(ra.orgs).toBe(0);

    active.clear();
    for (let i = 0; i < 3; i++) {
      await cycle(a);
      await cycle(b);
    }
    expect((await notifications()).map((n) => n.kind)).toEqual(['firing', 'resolved']);
  });
});

describe('alert-worker heartbeat and probes (ADR-088)', () => {
  it('records each evaluated cycle and answers /livez and /readyz', async () => {
    const w = worker();
    await cycle(w);
    const hb = await ctx.db
      .selectFrom('alert_worker_heartbeats')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(hb).toMatchObject({
      worker_id: w.id,
      version: '1.2.3-test',
      buckets: 64,
      last_error: null,
      lock_pid: w.lockPid,
    });
    expect(new Date(hb.last_cycle_at!).getTime()).toBe(T0);

    const server = await w.listen('127.0.0.1', 0);
    const port = (server.address() as { port: number }).port;
    const probe = (p: string) => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.status);
    expect(await probe('/livez')).toBe(200);
    expect(await probe('/readyz')).toBe(200);

    await sql`SELECT pg_terminate_backend(${w.lockPid}::int)`.execute(ctx.db);
    await new Promise((r) => setTimeout(r, 100));
    expect(await probe('/readyz')).toBe(503);
    clock.now += 3 * 60_000; // the loop has not advanced for 3 minutes
    expect(await probe('/livez')).toBe(503);
    server.close();
  });
});
