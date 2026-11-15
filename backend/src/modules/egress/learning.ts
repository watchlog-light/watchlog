// SPDX-License-Identifier: AGPL-3.0-only
// The learning period of "New external destination" (ADR-187): 7 days per cluster and per
// new source. WATCHLOG_EGRESS_LEARNING_DAYS shortens it for tests and the demo kit, as
// WATCHLOG_RIGHT_SIZING_MIN_HOURS does for right-sizing; the API process and the alert worker
// both set it from their configuration at start, so the page and the rule agree.
export const EGRESS_LEARNING_DEFAULT_DAYS = 7;
const DAY_MS = 86_400_000;

let days = EGRESS_LEARNING_DEFAULT_DAYS;

/** Set once at start from `config.egressLearningDays`; tests set it too. */
export function setEgressLearningDays(d: number): void {
  if (!Number.isFinite(d) || d < 0) throw new Error(`Invalid egress learning days: ${d}`);
  days = d;
}

export const egressLearningDays = (): number => days;
export const egressLearningMs = (): number => days * DAY_MS;

/** When a cluster's learning began: the upgrade for clusters that existed then, else its first report. */
export function learningStart(c: {
  egress_learning_since: Date | null;
  first_seen_at: Date | null;
  created_at: Date;
}): Date {
  return c.egress_learning_since ?? c.first_seen_at ?? c.created_at;
}
