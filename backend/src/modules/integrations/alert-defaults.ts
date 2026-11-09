// SPDX-License-Identifier: AGPL-3.0-only
// A monitored service's default alert rules (SPEC §4.12, slice 5): threshold rules scoped
// to that one service, created when monitoring starts. The connect drawer's "Default
// alerts" step turns each on or off; the ones left off stay in the rule list, ready to
// enable. Each integration adds its own (Redis memory, PostgreSQL connections) as it lands.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { insertThresholdRule } from '../alerts/rules.js';
import type { Condition } from '../alerts/defaults.js';
import type { IntegrationType } from './collector-config.js';

export interface ServiceAlertDefault {
  key: string;
  name: string;
  metric: string;
  condition: Condition;
  forSeconds: number;
}

/** Every service, whatever its type: reachable, and quick to connect. */
const GENERIC: ServiceAlertDefault[] = [
  {
    key: 'unreachable',
    name: 'Service unreachable',
    metric: 'service.reachable.ratio',
    // A member down is a warning; none reachable is critical.
    condition: { op: '<', value: 1, critical: 0.01 },
    forSeconds: 120,
  },
  {
    key: 'slow_connect',
    name: 'Service slow to connect',
    metric: 'service.connect.time',
    condition: { op: '>', value: 0.5 },
    forSeconds: 300,
  },
];

/** Per type: the generic ones until the type's integration adds its own. */
const BY_TYPE: Partial<Record<IntegrationType, ServiceAlertDefault[]>> = {};

export function alertDefaultsFor(type: IntegrationType): ServiceAlertDefault[] {
  return [...GENERIC, ...(BY_TYPE[type] ?? [])];
}

/**
 * Creates the service's default rules; those in `enabled` start on. They notify the
 * organization's channels, as a new rule in the rule editor does.
 */
export async function createServiceRules(
  db: Database,
  orgId: string,
  svc: { id: string; clusterId: string; type: IntegrationType },
  enabled: readonly string[],
): Promise<number> {
  const defaults = alertDefaultsFor(svc.type);
  const channels = await db
    .selectFrom('alert_channels')
    .select('id')
    .where('org_id', '=', orgId)
    .execute();
  for (const d of defaults) {
    await insertThresholdRule(db, orgId, {
      name: d.name,
      metric: d.metric,
      clusterId: svc.clusterId,
      scope: { service: svc.id },
      condition: d.condition,
      forSeconds: d.forSeconds,
      severity: 'warning',
      enabled: enabled.includes(d.key),
      channelIds: channels.map((c) => c.id),
    });
  }
  return defaults.filter((d) => enabled.includes(d.key)).length;
}

/** Removes the rules scoped to a service that is no longer monitored. */
export async function deleteServiceRules(db: Database, orgId: string, serviceId: string) {
  await db
    .deleteFrom('alert_rules')
    .where('org_id', '=', orgId)
    .where('type', '=', 'threshold')
    .where(sql<boolean>`scope->>'service' = ${serviceId}`)
    .execute();
}
