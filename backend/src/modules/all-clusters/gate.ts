// SPDX-License-Identifier: AGPL-3.0-only
// Who gets "All clusters and fleets" (ADR-226, ADR-232): the same as What changed, through
// license/pro.ts's proFeatures. Cloud: the org's `pro_features` (Pro and Enterprise). The
// live demo: the installation's org. Self-hosted: a valid Enterprise licence with `pro`.
// Community without one: nobody (the route answers 404 and the MCP tool isn't registered, so
// Community's API is unchanged); its sidebar opens the upgrade page instead.
import type { Config } from '../../config.js';
import { DEMO_MAX_RANGE_S } from '../../plugins/demo.js';
import type { EntitlementsService } from '../entitlements/service.js';
import { proExists, proFeatures } from '../license/pro.js';
import type { LicenseReader } from '../license/service.js';
import type { GateConfig } from '../anomaly/gate.js';

/** Whether the page's route and tool exist on this installation. */
export const allClustersExists = (
  config: GateConfig,
  license?: LicenseReader | null,
): Promise<boolean> => proExists(config, license);

/** Whether an org has the page now. */
export const hasAllClusters = (
  config: GateConfig,
  entitlements: Pick<EntitlementsService, 'get'> | null,
  orgId: string,
  license?: LicenseReader | null,
): Promise<boolean> => proFeatures(config, license, orgId, entitlements);

/** Cloud Pro's 30 days, for a licensed install's longest range (its disk decides the rest). */
const LICENSED_MAX_RANGE_S = 30 * 86_400;

/**
 * The longest range the org may ask for, in seconds: its retention in Cloud, the demo's
 * 24 hours in demo mode, Pro's 30 days on a licensed install.
 */
export async function maxRangeOf(
  config: Pick<Config, 'edition' | 'demoMode'>,
  entitlements: Pick<EntitlementsService, 'get'> | null,
  orgId: string,
): Promise<number> {
  if (config.edition === 'cloud' && entitlements) {
    const days = (await entitlements.get(orgId)).retentionDays;
    return config.demoMode ? Math.min(days * 86_400, DEMO_MAX_RANGE_S) : days * 86_400;
  }
  return config.demoMode ? DEMO_MAX_RANGE_S : LICENSED_MAX_RANGE_S;
}
