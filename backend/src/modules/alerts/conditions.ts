// SPDX-License-Identifier: AGPL-3.0-only
// Checks shared by rule views and custom rules (ADR-083, ADR-085).
import type { Condition } from './defaults.js';

/** Cluster kinds a catalog metric exists for: host and container keys are Docker's. */
export function metricKinds(metric: string): ('kubernetes' | 'docker')[] {
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
