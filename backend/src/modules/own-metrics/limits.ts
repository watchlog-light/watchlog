// SPDX-License-Identifier: AGPL-3.0-only
// An org's own-metric limits now (1.0.0, ADR-236): its edition and plan (the entitlements), the
// nodes and servers Cloud Pro bills it for, the installation's cap, and whether it has the Pro
// features (the plan, the demo, or a licence that lists `pro`). The numbers themselves are in
// modules/entitlements/own-metrics.ts and nowhere else.
import { sql } from 'kysely';
import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import { withOrg } from '../../db/org-context.js';
import { ownMetricLimits, type OwnMetricLimits } from '../entitlements/own-metrics.js';
import type { EntitlementsService } from '../entitlements/service.js';
import { proFeatures } from '../license/pro.js';
import type { LicenseReader } from '../license/service.js';

const TTL_MS = 60_000;
const DAY_MS = 86_400_000;

export interface LimitsDeps {
  config: Pick<Config, 'edition' | 'demoMode' | 'ownMetricSeries'>;
  db: Database;
  entitlements: EntitlementsService | null;
  license: LicenseReader | null;
  now?: () => number;
}

/**
 * The nodes and servers the org is billed for now: the highest hourly count of the last day
 * (so a node that restarts doesn't take its 200 series away for an hour).
 */
async function billedNodes(db: Database, orgId: string, nowMs: number): Promise<number> {
  const row = await withOrg(orgId, () =>
    db
      .selectFrom('usage_hourly')
      .select(sql<number>`coalesce(max(nodes + docker_hosts), 0)`.as('n'))
      .where('org_id', '=', orgId)
      .where('hour', '>', new Date(nowMs - DAY_MS))
      .executeTakeFirst(),
  );
  return Number(row?.n ?? 0);
}

export function ownLimitsProvider(deps: LimitsDeps): (orgId: string) => Promise<OwnMetricLimits> {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; limits: OwnMetricLimits }>();
  return async (orgId) => {
    const hit = cache.get(orgId);
    if (hit && now() - hit.at < TTL_MS) return hit.limits;
    const { config, entitlements } = deps;
    const pro = await proFeatures(config, deps.license, orgId, entitlements ?? undefined);
    let limits: OwnMetricLimits;
    if (config.edition === 'cloud' && entitlements) {
      const plan = (await entitlements.get(orgId)).plan;
      limits = ownMetricLimits({
        edition: 'cloud',
        plan,
        pro,
        billedNodes: plan === 'free' ? 0 : await billedNodes(deps.db, orgId, now()),
      });
    } else {
      limits = ownMetricLimits({
        edition: 'community',
        pro,
        installationSeries: config.ownMetricSeries,
      });
    }
    if (cache.size > 10_000) cache.clear();
    cache.set(orgId, { at: now(), limits });
    return limits;
  };
}
