// SPDX-License-Identifier: AGPL-3.0-only
// The internal API's shared answers (ADR-177, ADR-179): an org's entitlements and usage.
import { Type } from 'typebox';
import type { Entitlement } from '../entitlements/plans.js';

export const Limit = Type.Union([Type.Integer({ minimum: 0, maximum: 1_000_000 }), Type.Null()]);
export const PlanLiteral = Type.Union([
  Type.Literal('free'),
  Type.Literal('pro'),
  Type.Literal('enterprise'),
]);

export const EntitlementView = Type.Object({
  orgId: Type.String(),
  plan: PlanLiteral,
  source: Type.String(),
  clusters: Limit,
  nodes: Limit,
  users: Limit,
  retentionDays: Type.Integer(),
  proFeatures: Type.Boolean(),
  betaUntil: Type.Union([Type.String(), Type.Null()]),
  graceUntil: Type.Union([Type.String(), Type.Null()]),
  previousRetentionDays: Type.Union([Type.Integer(), Type.Null()]),
  retentionChangedAt: Type.Union([Type.String(), Type.Null()]),
  stored: Type.Boolean(),
});

export const UsageView = Type.Object({
  orgId: Type.String(),
  from: Type.String(),
  to: Type.String(),
  hoursInPeriod: Type.Integer(),
  p95: Type.Integer(),
  peak: Type.Integer(),
  hours: Type.Array(
    Type.Object({
      hour: Type.String(),
      nodes: Type.Integer(),
      dockerHosts: Type.Integer(),
      total: Type.Integer(),
    }),
  ),
});

export function entitlementView(e: Entitlement) {
  return {
    orgId: e.orgId,
    plan: e.plan,
    source: e.source,
    clusters: e.clusters,
    nodes: e.nodes,
    users: e.users,
    retentionDays: e.retentionDays,
    proFeatures: e.proFeatures,
    betaUntil: e.betaUntil?.toISOString() ?? null,
    graceUntil: e.graceUntil?.toISOString() ?? null,
    previousRetentionDays: e.previousRetentionDays,
    retentionChangedAt: e.retentionChangedAt?.toISOString() ?? null,
    stored: e.stored,
  };
}
