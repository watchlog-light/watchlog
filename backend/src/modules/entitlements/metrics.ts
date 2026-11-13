// SPDX-License-Identifier: AGPL-3.0-only
// The VictoriaMetrics client the backend and the alert worker use: the two retention tiers
// in Cloud when both URLs are set (ADR-177), else the one VICTORIAMETRICS_URL as before.
import type { Config } from '../../config.js';
import { VictoriaQueryClient } from '../../lib/victoria.js';
import { TieredVictoriaClient, type TierLogger } from '../../lib/victoria-tiers.js';
import type { EntitlementsService } from './service.js';

export function metricsClient(
  config: Pick<Config, 'victoriaMetricsUrl' | 'victoriaMetricsTiers'>,
  entitlements: EntitlementsService | null,
  log: TierLogger,
  timeoutMs = 10_000,
  queryTimeoutMs = 15_000,
): VictoriaQueryClient | undefined {
  if (config.victoriaMetricsTiers && entitlements) {
    return new TieredVictoriaClient(
      config.victoriaMetricsTiers,
      async (clusterId) => {
        const orgId = await entitlements.orgOfCluster(clusterId);
        return orgId ? entitlements.placement(orgId) : null;
      },
      log,
      timeoutMs,
      queryTimeoutMs,
    );
  }
  return config.victoriaMetricsUrl
    ? new VictoriaQueryClient(config.victoriaMetricsUrl, timeoutMs, queryTimeoutMs)
    : undefined;
}
