// SPDX-License-Identifier: AGPL-3.0-only
// Each org's entitlements in Cloud (ADR-177): read through a 60-second cache, written only
// through the internal API (the billing service, staff). The cache spans orgs (ingest,
// the metrics tiers and the worker read it before or outside a request's org), so it
// reads on the owner's connection, `systemDb` (ADR-174's allow-list). Community never
// builds one: no row, no limits.
import type { Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { Entitlements } from '../../db/types.js';
import type { Tier, TierPlacement } from '../../lib/victoria-tiers.js';
import {
  DOWNGRADE_GRACE_MS,
  PLAN_DEFAULTS,
  defaultEntitlement,
  type CloudPlan,
  type Entitlement,
  type EntitlementSource,
} from './plans.js';

export const ENTITLEMENTS_TTL_MS = 60_000;
const MAX_ENTRIES = 50_000;

export type { Tier };
/** The two VictoriaMetrics tiers (SPEC §5.4): 3 days (Free) and 30 days (Pro). */
export function tierOf(retentionDays: number): Tier {
  return retentionDays <= 3 ? '3d' : '30d';
}

/** Where an org's metrics are: the tier written now, and the one read beside it, if any. */
export type Placement = TierPlacement;

/** PUT /internal/orgs/:id/entitlements: the plan, where it comes from, and any override. */
export interface EntitlementInput {
  plan: CloudPlan;
  source: EntitlementSource;
  clusters?: number | null;
  nodes?: number | null;
  users?: number | null;
  retentionDays?: number;
  proFeatures?: boolean;
  betaUntil?: Date | null;
}

function fromRow(row: Selectable<Entitlements>): Entitlement {
  return {
    orgId: row.org_id,
    plan: row.plan as CloudPlan,
    source: row.source as EntitlementSource,
    clusters: row.clusters,
    nodes: row.nodes,
    users: row.users,
    retentionDays: row.retention_days,
    proFeatures: row.pro_features,
    betaUntil: row.beta_until,
    graceUntil: row.grace_until,
    previousRetentionDays: row.previous_retention_days,
    retentionChangedAt: row.retention_changed_at,
    stored: true,
  };
}

/** A limit went down (or from unlimited to a number). */
function lowered(before: number | null, after: number | null): boolean {
  return after !== null && (before === null || after < before);
}

export class EntitlementsService {
  private readonly entries = new Map<string, { value: Entitlement; expiresAt: number }>();
  private readonly clusterOrgs = new Map<string, string>();
  private readonly listeners: ((orgId: string) => void)[] = [];
  private readonly suspensions = new Map<string, { value: boolean; expiresAt: number }>();

  constructor(
    private readonly systemDb: Database,
    private readonly now: () => number = Date.now,
  ) {}

  /** The org's entitlements; Free's defaults when it has no row. */
  async get(orgId: string): Promise<Entitlement> {
    const hit = this.entries.get(orgId);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    const row = await this.systemDb
      .selectFrom('entitlements')
      .selectAll()
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    const value = row ? fromRow(row) : defaultEntitlement(orgId);
    if (this.entries.size >= MAX_ENTRIES) this.entries.clear();
    this.entries.set(orgId, { value, expiresAt: this.now() + ENTITLEMENTS_TTL_MS });
    return value;
  }

  /** Called with an org whose entitlements changed in this process (the node gate listens). */
  onChange(listener: (orgId: string) => void): void {
    this.listeners.push(listener);
  }

  /** Whether staff suspended the org (ADR-179): ingest answers 402. Cached like the rest. */
  async isSuspended(orgId: string): Promise<boolean> {
    const hit = this.suspensions.get(orgId);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    const row = await this.systemDb
      .selectFrom('orgs')
      .select('suspended_at')
      .where('id', '=', orgId)
      .executeTakeFirst();
    const value = !!row?.suspended_at;
    if (this.suspensions.size >= MAX_ENTRIES) this.suspensions.clear();
    this.suspensions.set(orgId, { value, expiresAt: this.now() + ENTITLEMENTS_TTL_MS });
    return value;
  }

  invalidate(orgId: string): void {
    this.entries.delete(orgId);
    this.suspensions.delete(orgId);
    for (const l of this.listeners) l(orgId);
  }

  /** The org a cluster belongs to (it never changes), for the metrics tiers. */
  async orgOfCluster(clusterId: string): Promise<string | null> {
    const hit = this.clusterOrgs.get(clusterId);
    if (hit) return hit;
    const row = await this.systemDb
      .selectFrom('clusters')
      .select('org_id')
      .where('id', '=', clusterId)
      .executeTakeFirst();
    if (!row) return null;
    if (this.clusterOrgs.size >= MAX_ENTRIES) this.clusterOrgs.clear();
    this.clusterOrgs.set(clusterId, row.org_id);
    return row.org_id;
  }

  /** The tiers to write to and read from for an org (ADR-177). */
  async placement(orgId: string): Promise<Placement> {
    return placementOf(await this.get(orgId), new Date(this.now()));
  }

  /**
   * Writes the org's entitlements (the internal API). Limits not given take the plan's
   * defaults. A lower node or cluster limit starts the 14-day grace (kept, not extended,
   * when one is already running); a higher one ends it. A retention change records the
   * tier the metrics were in, which reads keep merging until its retention has run out.
   */
  async put(orgId: string, input: EntitlementInput): Promise<Entitlement> {
    const now = new Date(this.now());
    const defaults = PLAN_DEFAULTS[input.plan];
    const next = {
      clusters: input.clusters !== undefined ? input.clusters : defaults.clusters,
      nodes: input.nodes !== undefined ? input.nodes : defaults.nodes,
      users: input.users !== undefined ? input.users : defaults.users,
      retentionDays: input.retentionDays ?? defaults.retentionDays,
      proFeatures: input.proFeatures ?? defaults.proFeatures,
    };
    const saved = await this.systemDb.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('entitlements')
        .selectAll()
        .where('org_id', '=', orgId)
        .forUpdate()
        .executeTakeFirst();
      const before = row ? fromRow(row) : defaultEntitlement(orgId);
      const down = lowered(before.nodes, next.nodes) || lowered(before.clusters, next.clusters);
      const up = !down && (next.nodes !== before.nodes || next.clusters !== before.clusters);
      const running = before.graceUntil && before.graceUntil > now ? before.graceUntil : null;
      const graceUntil = down
        ? (running ?? new Date(now.getTime() + DOWNGRADE_GRACE_MS))
        : up
          ? null
          : before.graceUntil;
      const tierChanged = row !== undefined && before.retentionDays !== next.retentionDays;
      const values = {
        plan: input.plan,
        source: input.source,
        clusters: next.clusters,
        nodes: next.nodes,
        users: next.users,
        retention_days: next.retentionDays,
        pro_features: next.proFeatures,
        beta_until: input.betaUntil ?? null,
        grace_until: graceUntil,
        previous_retention_days: tierChanged
          ? before.retentionDays
          : (row?.previous_retention_days ?? null),
        retention_changed_at: tierChanged ? now : (row?.retention_changed_at ?? null),
      };
      const out = await trx
        .insertInto('entitlements')
        .values({ org_id: orgId, ...values })
        .onConflict((oc) => oc.column('org_id').doUpdateSet(values))
        .returningAll()
        .executeTakeFirstOrThrow();
      // The session's org carries the plan too (auth/sessions.ts).
      await trx.updateTable('orgs').set({ plan: input.plan }).where('id', '=', orgId).execute();
      return out;
    });
    this.invalidate(orgId);
    return fromRow(saved);
  }
}

/** The tier written now, and the previous one while its retention hasn't run out. */
export function placementOf(e: Entitlement, now: Date): Placement {
  const current = tierOf(e.retentionDays);
  if (e.previousRetentionDays === null || e.retentionChangedAt === null) {
    return { current, previous: null };
  }
  const previous = tierOf(e.previousRetentionDays);
  const until = e.retentionChangedAt.getTime() + e.previousRetentionDays * 86_400_000;
  return { current, previous: previous !== current && now.getTime() < until ? previous : null };
}
