// SPDX-License-Identifier: AGPL-3.0-only
// Who gets What changed (ADR-195, ADR-197, ADR-203, ADR-232): the one shared check every part
// of the feature uses, through license/pro.ts's proFeatures. Cloud: the org's `pro_features`
// entitlement, through the 60-second cache. Demo mode: the installation's org. Self-hosted:
// a valid Enterprise licence with `pro`, for every org on the installation. Community without
// one: nobody, and the anomaly-worker doesn't start.
import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import type { EntitlementsService } from '../entitlements/service.js';
import { proExists, proFeatures } from '../license/pro.js';
import type { LicenseReader } from '../license/service.js';

export interface GateConfig {
  edition: Config['edition'];
  demoMode: boolean;
}

/**
 * Why the anomaly-worker may not run here, or null when it may (ADR-197, ADR-232): Cloud, the
 * live demo, or a self-hosted install with a licence key set (environment or Settings). With
 * a key that has ended or lacks `pro`, it runs and scores nothing until a working one is set.
 */
export function workerRefusal(config: GateConfig, licenseConfigured = false): string | null {
  if (config.edition === 'cloud' || config.demoMode || licenseConfigured) return null;
  return (
    'the anomaly-worker runs only in WatchLog Cloud (WATCHLOG_EDITION=cloud), the live demo ' +
    '(WATCHLOG_DEMO_MODE=true) or with an Enterprise licence key (WATCHLOG_LICENSE, ' +
    'WATCHLOG_LICENSE_FILE or Settings → License): What changed is part of Pro, and a ' +
    'Community install runs exactly the processes it ran before 0.8.0'
  );
}

/**
 * Whether What changed exists on this installation at all (ADR-202): Cloud, the live demo, or
 * a WatchLog licence that lists `pro`. In Community the route answers 404 and the MCP tool
 * `get_what_changed` isn't registered, so Community's API and tool list are unchanged.
 */
export const whatChangedExists = (
  config: GateConfig,
  license?: LicenseReader | null,
): Promise<boolean> => proExists(config, license);

/** Whether an org has What changed now (proFeatures). */
export async function hasWhatChanged(
  config: GateConfig,
  entitlements: Pick<EntitlementsService, 'get'> | null,
  orgId: string,
  license?: LicenseReader | null,
): Promise<boolean> {
  return proFeatures(config, license, orgId, entitlements);
}

/**
 * Days of retained history the worker learns from when it first sees an org (ADR-203): the
 * live demo only, so its What changed works on the day of the deploy instead of 7 days
 * later. 14 (ADR-196's window) reads whatever the demo keeps (7 days). Everywhere else 0:
 * learning starts at the upgrade (ADR-204), Cloud included, even with demo mode set, and on a
 * licensed install when the key is added (ADR-232).
 */
export const lookBackDays = (config: GateConfig): number =>
  config.edition !== 'cloud' && config.demoMode ? 14 : 0;

/**
 * The orgs the worker scores now, read on the owner's connection (ADR-174's allow-list):
 * Cloud, orgs with `pro_features` that are neither suspended nor being deleted; demo mode,
 * the installation's org; a licensed install, every org while the licence works; else none.
 */
export async function entitledOrgs(
  config: GateConfig,
  systemDb: Database,
  license?: LicenseReader | null,
): Promise<string[]> {
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
  // A licence covers every org on the installation; the org id isn't read.
  if (!config.demoMode && !(await proFeatures(config, license, ''))) return [];
  const rows = await systemDb.selectFrom('orgs').select('id').orderBy('id').execute();
  return rows.map((r) => r.id);
}
