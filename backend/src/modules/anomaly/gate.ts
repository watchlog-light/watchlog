// SPDX-License-Identifier: AGPL-3.0-only
// Who gets What changed (ADR-195, ADR-197, ADR-203): the one shared check every part of the
// feature uses (the worker here; the page, card, alert rule, route and MCP tool in later
// slices). Cloud: the org's `pro_features` entitlement, through the 60-second cache. Demo
// mode: the installation's org, for What changed only. Community otherwise: nobody, and the
// anomaly-worker doesn't start.
import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import type { EntitlementsService } from '../entitlements/service.js';

export interface GateConfig {
  edition: Config['edition'];
  demoMode: boolean;
}

/** Why the anomaly-worker may not run here, or null when it may (ADR-197). */
export function workerRefusal(config: GateConfig): string | null {
  if (config.edition === 'cloud' || config.demoMode) return null;
  return (
    'the anomaly-worker runs only in WatchLog Cloud (WATCHLOG_EDITION=cloud) or the live demo ' +
    '(WATCHLOG_DEMO_MODE=true): What changed is part of Pro, and a Community install runs ' +
    'exactly the processes it ran before 0.8.0'
  );
}

/**
 * Whether an org has What changed: Cloud with `pro_features`; in demo mode (not Cloud) the
 * installation's org; never in Community otherwise.
 */
export async function hasWhatChanged(
  config: GateConfig,
  entitlements: Pick<EntitlementsService, 'get'> | null,
  orgId: string,
): Promise<boolean> {
  if (config.edition === 'cloud') {
    if (!entitlements) return false;
    return (await entitlements.get(orgId)).proFeatures;
  }
  return config.demoMode;
}

/**
 * The orgs the worker scores now, read on the owner's connection (ADR-174's allow-list):
 * Cloud, orgs with `pro_features` that are neither suspended nor being deleted; demo mode,
 * the installation's org; Community otherwise, none.
 */
export async function entitledOrgs(config: GateConfig, systemDb: Database): Promise<string[]> {
  if (config.edition === 'cloud') {
    const rows = await systemDb
      .selectFrom('entitlements as e')
      .innerJoin('orgs as o', 'o.id', 'e.org_id')
      .select('e.org_id')
      .where('e.pro_features', '=', true)
      .where('o.suspended_at', 'is', null)
      .where('o.deletion_requested_at', 'is', null)
      .orderBy('e.org_id')
      .execute();
    return rows.map((r) => r.org_id);
  }
  if (!config.demoMode) return [];
  const rows = await systemDb.selectFrom('orgs').select('id').orderBy('id').execute();
  return rows.map((r) => r.id);
}
