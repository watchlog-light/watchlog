// SPDX-License-Identifier: AGPL-3.0-only
// One story per workload (ADR-229): "has N of M replicas ready" is held back while "is
// crash-looping" fires for the same workload, and a crash loop while the OOM kills that cause
// it fire, on Kubernetes and on servers. A held-back alert is kept current, counted as held,
// sends no message, shows on the other alert's page as related, and is announced when the
// other one ends first.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvaluatorLookup, RuleEvaluator } from '../src/modules/alerts/engine.js';
import type { Observation } from '../src/modules/alerts/state-machine.js';
import type { AlertWorker } from '../src/modules/alerts/worker.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  type TestContext,
} from './helpers.js';
import { T0, createOrgCluster, insertChannel, insertRule, testWorker } from './support/alerts.js';

const CYCLE = 30_000;
let ctx: TestContext;
let worker: AlertWorker;
const clock = { now: T0 };
/** What each rule's fake source reports now: fingerprint → labels. */
let active: Map<string, Map<string, Record<string, string>>>;

const fake = (key: string, kinds: ('kubernetes' | 'server')[]): RuleEvaluator => ({
  kinds,
  evaluate: async () =>
    [...(active.get(key) ?? new Map())].map(([fingerprint, labels]): Observation => ({
      fingerprint,
      severity: 'critical',
      labels,
      details: {},
    })),
});
const KEYS = {
  'k8s.pod.crashloop': ['kubernetes'],
  'k8s.deployment.unavailable': ['kubernetes'],
  'k8s.container.oomkilled': ['kubernetes'],
  'server.unit.crashloop': ['server'],
  'server.unit.oom': ['server'],
} as const;
const lookup: EvaluatorLookup = (rule) => {
  const kinds = KEYS[rule.rule_key as keyof typeof KEYS];
  return kinds ? fake(rule.rule_key!, [...kinds]) : undefined;
};

const report = (key: string, fp: string, labels: Record<string, string>) => {
  if (!active.has(key)) active.set(key, new Map());
  active.get(key)!.set(fp, labels);
};
const stop = (key: string, fp: string) => active.get(key)?.delete(fp);
async function cycles(n = 1) {
  for (let i = 0; i < n; i++) {
    const r = await worker.runCycle();
    expect(r.errors).toEqual([]);
    clock.now += CYCLE;
  }
}
async function alertOf(ruleKey: string) {
  return ctx.db
    .selectFrom('alert_states as s')
    .innerJoin('alert_rules as r', 'r.id', 's.rule_id')
    .select(['s.id', 's.state', 's.held', 's.notified_firing', 's.details'])
    .where('r.rule_key', '=', ruleKey)
    .executeTakeFirst();
}
async function sent(ruleKey: string) {
  return ctx.db
    .selectFrom('notifications as n')
    .innerJoin('alert_rules as r', 'r.id', 'n.rule_id')
    .select('n.kind')
    .where('r.rule_key', '=', ruleKey)
    .orderBy('n.created_at')
    .execute()
    .then((rows) => rows.map((r) => r.kind));
}

const LEGACY = {
  namespace: 'shop',
  workload: 'legacy-importer',
  workload_kind: 'Deployment',
};

beforeEach(async () => {
  ctx = await createTestContext();
  clock.now = T0;
  active = new Map();
});
afterEach(async () => {
  await worker?.stop();
  await closeTestContext(ctx);
});

async function setup(kind: 'kubernetes' | 'server', keys: string[]) {
  const { orgId } = await createOrgCluster(ctx.db, kind);
  const ch = await insertChannel(ctx.db, orgId);
  for (const k of keys) {
    await insertRule(ctx.db, orgId, { name: k, rule_key: k, for_seconds: 0, channel_ids: [ch] });
  }
  worker = testWorker(ctx.db, clock, lookup);
  return { orgId };
}

describe('one story per workload (ADR-229)', () => {
  it('Kubernetes: replicas ready waits under the crash loop, then speaks if it outlasts it', async () => {
    const { orgId } = await setup('kubernetes', [
      'k8s.pod.crashloop',
      'k8s.deployment.unavailable',
    ]);
    report('k8s.pod.crashloop', 'pod:legacy', { ...LEGACY, pod: 'legacy-importer-1' });
    await cycles(2);
    report('k8s.deployment.unavailable', 'w:legacy', LEGACY);
    await cycles(3);
    const crash = (await alertOf('k8s.pod.crashloop'))!;
    const replicas = (await alertOf('k8s.deployment.unavailable'))!;
    expect(crash).toMatchObject({ state: 'firing', held: false });
    expect(replicas).toMatchObject({ state: 'firing', held: true, notified_firing: false });
    expect(replicas.details).toMatchObject({ heldBy: crash.id });
    expect(await sent('k8s.deployment.unavailable')).toEqual([]);

    // The API: held, with the alert it is held under; listed as related on that one's page.
    const { cookie } = await createUserSession(ctx.db, { role: 'viewer', orgId });
    const get = (id: string) =>
      ctx.app.inject({
        method: 'GET',
        url: `/api/v1/alerts/${id}`,
        cookies: { wl_session: cookie },
      });
    const page = (await get(crash.id)).json();
    expect(page.related.map((a: { id: string }) => a.id)).toEqual([replicas.id]);
    expect((await get(replicas.id)).json().alert).toMatchObject({ held: true, heldBy: crash.id });

    // The crash loop ends first: the replicas alert is announced now.
    stop('k8s.pod.crashloop', 'pod:legacy');
    await cycles(4);
    expect((await alertOf('k8s.pod.crashloop'))!.state).toBe('resolved');
    expect(await alertOf('k8s.deployment.unavailable')).toMatchObject({
      held: false,
      notified_firing: true,
    });
    expect(await sent('k8s.deployment.unavailable')).toEqual(['firing']);
  });

  it('Kubernetes: a crash loop waits under its OOM kills; another workload is not held', async () => {
    await setup('kubernetes', ['k8s.container.oomkilled', 'k8s.pod.crashloop']);
    const consumer = { namespace: 'shop', workload: 'consumer', workload_kind: 'Deployment' };
    report('k8s.container.oomkilled', 'oom:consumer', {
      ...consumer,
      pod: 'consumer-1',
      container: 'main',
    });
    await cycles(2);
    report('k8s.pod.crashloop', 'pod:consumer', { ...consumer, pod: 'consumer-1' });
    report('k8s.pod.crashloop', 'pod:legacy', { ...LEGACY, pod: 'legacy-importer-1' });
    await cycles(3);
    const rows = await ctx.db
      .selectFrom('alert_states as s')
      .innerJoin('alert_rules as r', 'r.id', 's.rule_id')
      .select(['s.fingerprint', 's.held'])
      .where('r.rule_key', '=', 'k8s.pod.crashloop')
      .orderBy('s.fingerprint')
      .execute();
    expect(rows).toEqual([
      { fingerprint: 'pod:consumer', held: true },
      { fingerprint: 'pod:legacy', held: false },
    ]);
  });

  it('Server fleets: a systemd service crash loop waits under its OOM kills', async () => {
    await setup('server', ['server.unit.oom', 'server.unit.crashloop']);
    const unit = { node: 'web-01', unit: 'pm2-app.service' };
    report('server.unit.oom', 'oom:pm2', unit);
    await cycles(2);
    report('server.unit.crashloop', 'crash:pm2', unit);
    await cycles(3);
    expect(await alertOf('server.unit.crashloop')).toMatchObject({ state: 'firing', held: true });
    expect(await sent('server.unit.crashloop')).toEqual([]);
    expect(await sent('server.unit.oom')).toEqual(['firing']);
  });
});
