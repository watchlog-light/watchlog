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
  /** Unique across types; stored on the rule (default_key) so it can be reset. */
  key: string;
  name: string;
  metric: string;
  condition: Condition;
  forSeconds: number;
  severity?: 'warning' | 'critical';
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

/** Per type (SPEC §4.12): added to the generic ones. */
const BY_TYPE: Partial<Record<IntegrationType, ServiceAlertDefault[]>> = {
  redis: [
    {
      key: 'redis_memory_high',
      name: 'Redis memory above 90 % of maxmemory',
      metric: 'redis.memory.ratio',
      condition: { op: '>', value: 0.9 },
      forSeconds: 300,
    },
    {
      key: 'redis_evicting',
      name: 'Redis evicting keys',
      metric: 'redis.evicted.rate',
      condition: { op: '>', value: 0 },
      forSeconds: 0,
    },
    {
      key: 'redis_replica_down',
      name: 'Redis replica disconnected',
      metric: 'redis.replica.down',
      condition: { op: '>', value: 0 },
      forSeconds: 60,
      severity: 'critical',
    },
    {
      key: 'redis_save_failed',
      name: 'Redis save failed',
      metric: 'redis.save.failed',
      condition: { op: '>', value: 0 },
      forSeconds: 0,
      severity: 'critical',
    },
    {
      key: 'redis_blocked_clients',
      name: 'Redis clients blocked',
      metric: 'redis.blocked_clients',
      condition: { op: '>', value: 0 },
      forSeconds: 120,
    },
  ],
  postgres: [
    {
      key: 'postgres_connections_high',
      name: 'PostgreSQL connections above 90 % of max_connections',
      metric: 'postgres.connections.ratio',
      condition: { op: '>', value: 0.9 },
      forSeconds: 300,
    },
    {
      key: 'postgres_long_query',
      name: 'PostgreSQL query running over 5 minutes',
      metric: 'postgres.query.longest',
      condition: { op: '>', value: 300 },
      forSeconds: 0,
      severity: 'critical',
    },
    {
      key: 'postgres_replication_lag',
      name: 'PostgreSQL replication lag above 30 s',
      metric: 'postgres.replication.lag',
      condition: { op: '>', value: 30 },
      forSeconds: 120,
    },
    {
      key: 'postgres_xid_age',
      name: 'PostgreSQL transaction ID age above 1,500 M',
      metric: 'postgres.xid.age',
      condition: { op: '>', value: 1_500_000_000 },
      forSeconds: 0,
      severity: 'critical',
    },
    {
      key: 'postgres_deadlocks',
      name: 'PostgreSQL deadlocks detected',
      metric: 'postgres.deadlocks.rate',
      condition: { op: '>', value: 0 },
      forSeconds: 0,
    },
  ],
  nginx: [
    {
      key: 'nginx_5xx_high',
      name: 'Nginx 5xx above 5 %',
      metric: 'nginx.5xx.ratio',
      condition: { op: '>', value: 0.05 },
      forSeconds: 300,
      severity: 'critical',
    },
    {
      key: 'nginx_latency_high',
      name: 'Nginx p95 above 1 s',
      metric: 'nginx.latency.p95',
      condition: { op: '>', value: 1 },
      forSeconds: 300,
    },
    {
      key: 'nginx_upstream_down',
      name: 'Nginx upstream without a healthy endpoint',
      metric: 'nginx.upstream.down',
      condition: { op: '>', value: 0 },
      forSeconds: 60,
      severity: 'critical',
    },
    {
      key: 'nginx_certificate_expiring',
      name: 'Certificate expires within 14 days (ingress-nginx)',
      metric: 'nginx.certificate.expiry',
      condition: { op: '<', value: 14 * 86_400 },
      forSeconds: 0,
    },
  ],
};

/** A default by its key, for "Reset to default". */
export function alertDefaultByKey(key: string): ServiceAlertDefault | undefined {
  return [...GENERIC, ...Object.values(BY_TYPE).flat()].find((d) => d.key === key);
}

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
      severity: d.severity ?? 'warning',
      enabled: enabled.includes(d.key),
      defaultKey: d.key,
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
