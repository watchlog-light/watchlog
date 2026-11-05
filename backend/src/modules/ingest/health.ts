// SPDX-License-Identifier: AGPL-3.0-only
// When did a container's health status begin? (ADR-047, "unhealthy since")

export interface Probe {
  start: string;
  end: string;
  exit_code: number;
}

export interface HealthSince {
  /** ISO time the current health status began. */
  since: string;
  /** True when the change was not observed and `since` is derived from the probe log. */
  estimated: boolean;
}

/**
 * Keeps the stored time while the status is unchanged and uses `now` for an observed
 * change. For a status seen for the first time it estimates from the probe log: an
 * unhealthy status began at the probe that made `retries` consecutive failures; when
 * the failing streak is longer than the log (five probes), the oldest probe is a lower
 * bound.
 */
export function healthSince(
  previous:
    { health?: string; health_since?: string; health_since_estimated?: boolean } | undefined,
  status: string | undefined,
  detail: { failing_streak: number; probes: Probe[]; check?: { retries: number } } | undefined,
  now: Date,
): HealthSince | undefined {
  if (!status) return undefined;
  if (previous?.health === status && previous.health_since)
    return { since: previous.health_since, estimated: previous.health_since_estimated ?? false };
  if (previous?.health && previous.health !== status)
    return { since: now.toISOString(), estimated: false };

  const probes = [...(detail?.probes ?? [])].sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start),
  );
  if (status === 'unhealthy' && detail && probes.length > 0) {
    const retries = detail.check?.retries ?? 3;
    const tipping = probes.length - detail.failing_streak + retries - 1;
    if (detail.failing_streak <= probes.length && tipping >= 0 && tipping < probes.length)
      return { since: new Date(probes[tipping]!.end).toISOString(), estimated: false };
    return { since: new Date(probes[0]!.start).toISOString(), estimated: true };
  }
  return { since: now.toISOString(), estimated: true };
}
