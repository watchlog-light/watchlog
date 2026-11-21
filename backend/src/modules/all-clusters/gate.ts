// SPDX-License-Identifier: AGPL-3.0-only
// Who gets "All clusters and fleets" (ADR-226): the same as What changed (ADR-195, ADR-203).
// Cloud: the org's `pro_features` (Pro and Enterprise). The live demo: the installation's org,
// as for What changed. Community: nobody (the route answers 404 and the MCP tool isn't
// registered, so Community's API is unchanged); its sidebar opens the upgrade page instead.
// Self-hosted Enterprise gets it with the licence key, when that ships (Phase 7).
import type { Config } from '../../config.js';
import { DEMO_MAX_RANGE_S } from '../../plugins/demo.js';
import type { EntitlementsService } from '../entitlements/service.js';
import { hasWhatChanged, whatChangedExists, type GateConfig } from '../anomaly/gate.js';

/** Whether the page's route and tool exist on this installation: Cloud or the live demo. */
export const allClustersExists = (config: GateConfig): boolean => whatChangedExists(config);

/** Whether an org has the page: Cloud with `pro_features`; the demo's org; else nobody. */
export const hasAllClusters = (
  config: GateConfig,
  entitlements: Pick<EntitlementsService, 'get'> | null,
  orgId: string,
): Promise<boolean> => hasWhatChanged(config, entitlements, orgId);

/**
 * The longest range the org may ask for, in seconds: its retention in Cloud, the demo's
 * 24 hours in demo mode.
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
  return DEMO_MAX_RANGE_S;
}
