// SPDX-License-Identifier: AGPL-3.0-only
// Gaps in a series: where the agent sent nothing (a host down, an agent stopped), the
// query returns no points at all, and a line drawn straight across them reads as a slow
// change (the owner's v0.4 review: "CPU slowly rising" from 12:11 to 12:40 while the VM was
// down). A null point inside every gap longer than GAP_STEPS steps breaks the line there.

/** A gap longer than this many of the series' steps is no data, not a slow change. */
export const GAP_STEPS = 2;

type Point = (number | null)[];

/** The series' step: the most common distance between consecutive points (seconds). */
export function stepOf(points: Point[]): number | null {
  const counts = new Map<number, number>();
  for (let i = 1; i < points.length; i++) {
    const d = (points[i]![0] ?? 0) - (points[i - 1]![0] ?? 0);
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: number | null = null;
  let n = 0;
  for (const [d, c] of counts)
    if (c > n || (c === n && best !== null && d < best)) {
      best = d;
      n = c;
    }
  return best;
}

/** The points with a null one after each gap longer than GAP_STEPS steps. */
export function breakGaps<T extends Point>(points: T[], step = stepOf(points)): Point[] {
  if (!step || points.length < 2) return points;
  const out: Point[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]![0] ?? 0;
    const t = points[i]![0] ?? 0;
    if (t - prev > GAP_STEPS * step) out.push([prev + step, null]);
    out.push(points[i]!);
  }
  return out;
}
