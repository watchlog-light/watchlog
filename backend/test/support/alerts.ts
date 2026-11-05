// SPDX-License-Identifier: AGPL-3.0-only
// Fixtures for alerting tests: orgs, clusters, rules, channels and workers on a fake clock.
import { inject } from 'vitest';
import type { Database } from '../../src/db/index.js';
import type { Insertable } from 'kysely';
import type { AlertRules } from '../../src/db/types.js';
import { newId } from '../../src/lib/ids.js';
import type { EvaluatorLookup } from '../../src/modules/alerts/engine.js';
import { AlertWorker, type WorkerOptions } from '../../src/modules/alerts/worker.js';

export const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

export async function createOrgCluster(
  db: Database,
  kind: 'kubernetes' | 'docker' = 'kubernetes',
  name = 'prod',
): Promise<{ orgId: string; clusterId: string }> {
  const orgId = newId();
  const clusterId = newId();
  await db
    .insertInto('orgs')
    .values({ id: orgId, name: 'Acme', slug: `acme-${orgId.slice(-8)}`, plan: 'community' })
    .execute();
  await db.insertInto('clusters').values({ id: clusterId, org_id: orgId, name, kind }).execute();
  return { orgId, clusterId };
}

export async function insertRule(
  db: Database,
  orgId: string,
  over: Partial<Insertable<AlertRules>> = {},
): Promise<string> {
  const id = newId();
  await db
    .insertInto('alert_rules')
    .values({
      id,
      org_id: orgId,
      name: 'Test rule',
      type: 'default',
      rule_key: 'test.fake',
      severity: 'warning',
      ...over,
    })
    .execute();
  return id;
}

export async function insertChannel(
  db: Database,
  orgId: string,
  type: 'slack' | 'telegram' | 'email' | 'webhook' = 'webhook',
  config: Record<string, unknown> = {},
  secret: string | null = null,
): Promise<string> {
  const id = newId();
  await db
    .insertInto('alert_channels')
    .values({
      id,
      org_id: orgId,
      type,
      name: `${type} channel`,
      config: JSON.stringify(config),
      secret,
    })
    .execute();
  return id;
}

export const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

/** A worker on a shared fake clock; call runCycle() by hand. */
export function testWorker(
  db: Database,
  clock: { now: number },
  evaluators: EvaluatorLookup,
  over: Partial<WorkerOptions> = {},
): AlertWorker {
  return new AlertWorker({
    db,
    databaseUrl: inject('databaseUrl'),
    version: '1.2.3-test',
    log: silentLog,
    evaluators,
    retentionDays: 90,
    now: () => clock.now,
    ...over,
  });
}
