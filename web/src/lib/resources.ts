// SPDX-License-Identifier: AGPL-3.0-only
// Resource rules shared by the cluster pages (ADR-111):
// the pod heatmap's colours and the usage bar against request and limit.

export type HeatTone = 'fail' | 'over' | 'high' | 'mid' | 'low' | 'none';

/** Heatmap cell: failing first, else CPU against the pod's request (<25 %, 25–75 %, 75–100 %, over). */
export function heatTone(p: { cpuRatio: number | null; failing: string | null }): HeatTone {
  if (p.failing) return 'fail';
  if (p.cpuRatio === null) return 'none';
  if (p.cpuRatio > 1) return 'over';
  if (p.cpuRatio > 0.75) return 'high';
  if (p.cpuRatio > 0.25) return 'mid';
  return 'low';
}

/** Usage over this share of the limit turns the bar red. */
export const NEAR_LIMIT = 0.9;

export interface Bar {
  /** Where usage, the request tick and the limit marker sit, 0–100 % of the track. */
  usage: number;
  request: number | null;
  limit: number | null;
  /** Near (over 90 % of) the limit is red; over the request alone is not a problem. */
  near: boolean;
}

/** A usage bar: the track is 1.1 × the largest of usage, request and limit. */
export function resourceBar(usage: number, request: number | null, limit: number | null): Bar {
  const scale = Math.max(usage, request ?? 0, limit ?? 0) * 1.1 || 1;
  const at = (v: number) => Math.min(100, (v / scale) * 100);
  return {
    usage: Math.max(2, at(usage)),
    request: request === null ? null : at(request),
    limit: limit === null ? null : at(limit),
    near: limit !== null && limit > 0 && usage / limit > NEAR_LIMIT,
  };
}

/**
 * Cores with two decimals ("0.05"), fewer for large totals ("12.5", "16004"); "<0.01"
 * for a trace, so it never reads as idle.
 */
export function formatCores(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  if (v > 0 && v < 0.005) return '<0.01';
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2);
}

/** Cores for tooltips: three significant digits ("0.0124"). */
export function exactCores(v: number): string {
  return v === 0 ? '0' : `${+(v >= 1 ? v.toFixed(3) : v.toPrecision(3))}`;
}
