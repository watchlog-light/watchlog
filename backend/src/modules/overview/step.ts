// SPDX-License-Identifier: AGPL-3.0-only

/** A range in seconds → the query step that gives at most 60 points (≥ 15 s). */
export function sparkStep(range: number): number {
  const steps = [15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400];
  return steps.find((s) => range / s <= 60) ?? 14400;
}
