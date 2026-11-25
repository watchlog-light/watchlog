// SPDX-License-Identifier: AGPL-3.0-only
// The ranges a page offers (ADR-122, 0.17.1): the read-only demo answers at most its limit (the
// backend's DEMO_MAX_RANGE_S, sent with GET /setup as `demoMaxRangeS`), so a longer range isn't
// offered there, and a range a link or a stored choice asks for is brought within it.

/** The ranges within the limit; all of them without one (null: not the demo). */
export function offeredRanges<T extends { seconds: number }>(
  all: readonly T[],
  maxS: number | null | undefined,
): T[] {
  return maxS == null ? [...all] : all.filter((r) => r.seconds <= maxS);
}

/** A range in seconds brought within the limit: the longest offered one at most. */
export function withinLimit(seconds: number, maxS: number | null | undefined): number {
  return maxS == null ? seconds : Math.min(seconds, maxS);
}
