// SPDX-License-Identifier: AGPL-3.0-only
// A custom rule on a pod's restarts counts the restarts within the last 15 minutes (ADR-229),
// so a pod that stopped restarting resolves; the migration moves the rules made on the total
// count. Server fleets already use `container.restarts.increase` (10 minutes, ADR-072).
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildQuery } from '../src/modules/query/catalog.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';
import { createOrgCluster, insertRule } from './support/alerts.js';

describe('pod.restarts.increase', () => {
  it('is the increase of the restart counter over 15 minutes, per pod', () => {
    const q = buildQuery('pod.restarts.increase', { namespaces: ['shop'] }, 60);
    expect(q.unit).toBe('count');
    expect(q.expr).toMatch(
      /^sum by \(namespace, pod\) \(increase\(watchlog_kube_pod_container_restarts_total\{.*namespace=~"shop".*\}\[15m\]\)\)$/,
    );
    // The total stays for charts.
    expect(buildQuery('pod.restarts', {}, 60).expr).not.toContain('increase');
  });
});

describe('the migration of rules on the total', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => closeTestContext(ctx));

  it('moves them to the windowed metric with their threshold, and leaves the rest', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const restarts = await insertRule(ctx.db, orgId, {
      name: 'Shop pods keep restarting',
      type: 'threshold',
      rule_key: null,
      metric: 'pod.restarts',
      condition: JSON.stringify({ op: '>', value: 3, critical: 10 }),
    });
    const cpu = await insertRule(ctx.db, orgId, {
      name: 'Backend CPU busy',
      type: 'threshold',
      rule_key: null,
      metric: 'workload.cpu.usage',
    });
    await sql
      .raw(
        readFileSync(
          new URL('../migrations/1797300000000_pod-restarts-in-window.sql', import.meta.url),
          'utf8',
        ),
      )
      .execute(ctx.db);
    const rows = await ctx.db
      .selectFrom('alert_rules')
      .select(['id', 'metric', 'condition'])
      .where('id', 'in', [restarts, cpu])
      .execute();
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get(restarts)!.metric).toBe('pod.restarts.increase');
    expect(by.get(restarts)!.condition).toEqual({ op: '>', value: 3, critical: 10 });
    expect(by.get(cpu)!.metric).toBe('workload.cpu.usage');
  });
});
