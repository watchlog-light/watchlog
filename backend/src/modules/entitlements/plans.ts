// SPDX-License-Identifier: AGPL-3.0-only
// What each Cloud plan allows (ADR-177, SPEC §3.2), and the arithmetic the limits and the
// bill share. Community has no plan here: it never reads an entitlement (ADR-151).

export type CloudPlan = 'free' | 'pro' | 'enterprise';
export const CLOUD_PLANS: readonly CloudPlan[] = ['free', 'pro', 'enterprise'];
export type EntitlementSource = 'signup' | 'beta' | 'billing' | 'staff';
export const ENTITLEMENT_SOURCES: readonly EntitlementSource[] = [
  'signup',
  'beta',
  'billing',
  'staff',
];
export type LimitKind = 'nodes' | 'clusters' | 'users';

/** An org's entitlements. `null` limits are unlimited. */
export interface Entitlement {
  orgId: string;
  plan: CloudPlan;
  source: EntitlementSource;
  clusters: number | null;
  nodes: number | null;
  users: number | null;
  retentionDays: number;
  proFeatures: boolean;
  betaUntil: Date | null;
  /** After a downgrade: what already sends keeps sending until then (14 days). */
  graceUntil: Date | null;
  /** The retention (tier) before the last change, and when it changed. */
  previousRetentionDays: number | null;
  retentionChangedAt: Date | null;
  /** False for an org without a row (made outside signup): Free's defaults apply. */
  stored: boolean;
}

export type PlanLimits = Pick<
  Entitlement,
  'clusters' | 'nodes' | 'users' | 'retentionDays' | 'proFeatures'
>;

/** The defaults (ADR-177): Free 1 cluster or fleet, 5 nodes, 3 days, 1 user; Pro unlimited, 30 days, 10 users. */
export const PLAN_DEFAULTS: Record<CloudPlan, PlanLimits> = {
  free: { clusters: 1, nodes: 5, users: 1, retentionDays: 3, proFeatures: false },
  pro: { clusters: null, nodes: null, users: 10, retentionDays: 30, proFeatures: true },
  // Enterprise in Cloud is a staff-set contract; its limits come with the row.
  enterprise: { clusters: null, nodes: null, users: null, retentionDays: 30, proFeatures: true },
};

/** Nodes and clusters already sending keep sending this long after a downgrade (ADR-177). */
export const DOWNGRADE_GRACE_MS = 14 * 86_400_000;
/** An agent instance the org saw within this window is "already sending" (ADR-177). */
export const SEEN_WINDOW_MS = 24 * 3_600_000;

/** Free's defaults for an org without a row. */
export function defaultEntitlement(orgId: string): Entitlement {
  return {
    orgId,
    plan: 'free',
    source: 'signup',
    ...PLAN_DEFAULTS.free,
    betaUntil: null,
    graceUntil: null,
    previousRetentionDays: null,
    retentionChangedAt: null,
    stored: false,
  };
}

/** Over the limit when one more would pass it; `null` never is. */
export function atLimit(limit: number | null, used: number): boolean {
  return limit !== null && used >= limit;
}

/**
 * The 95th percentile by nearest rank: the smallest count that at least 95 % of the hours
 * are at or below. 10 nodes for 696 hours and 40 for one day (24 hours, 3.3 %) gives 10.
 * Hours without a row count as 0; an empty period is 0.
 */
export function percentile95(counts: number[]): number {
  if (counts.length === 0) return 0;
  const sorted = [...counts].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]!;
}

/** Whole days left until `until` (rounded up, never below 0). */
export function daysLeft(until: Date, now: Date): number {
  return Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 86_400_000));
}
