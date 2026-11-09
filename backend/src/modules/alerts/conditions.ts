// SPDX-License-Identifier: AGPL-3.0-only
// Checks shared by rule views and custom rules (ADR-083, ADR-085).
import type { Condition } from './defaults.js';

/**
 * Cluster kinds a catalog metric exists for: host and container keys are Docker's;
 * a monitored service's are both kinds' (ADR-124).
 */
/** A monitored service's metrics: the generic ones and each integration's (SPEC §4.12). */
export const SERVICE_METRIC_PREFIXES = ['service.', 'redis.', 'postgres.', 'nginx.'] as const;
export const isServiceMetric = (metric: string) =>
  SERVICE_METRIC_PREFIXES.some((p) => metric.startsWith(p));

export function metricKinds(metric: string): ('kubernetes' | 'docker')[] {
  if (isServiceMetric(metric)) return ['kubernetes', 'docker'];
  return metric.startsWith('host.') || metric.startsWith('container.')
    ? ['docker']
    : ['kubernetes'];
}

export function conditionError(c: Condition, unit: string | null): string | null {
  if (!Number.isFinite(c.value) || (c.critical !== undefined && !Number.isFinite(c.critical))) {
    return 'Thresholds must be numbers';
  }
  if (unit === 'ratio' && (c.value < 0 || c.value > 10)) {
    return 'A ratio threshold is between 0 and 1 (1 = 100 %)';
  }
  if (c.critical !== undefined) {
    const ok = c.op === '>' ? c.critical > c.value : c.critical < c.value;
    if (!ok) return 'The critical threshold must be beyond the warning threshold';
  }
  return null;
}
