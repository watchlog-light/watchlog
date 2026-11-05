// SPDX-License-Identifier: AGPL-3.0-only
// Small helpers for the Kubernetes views.

/** a / b, or null when either is unknown or b is not positive. */
export function share(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined || !(b > 0)) return null;
  return a / b;
}

/** Pod statuses that mean trouble (shown with the critical tone). */
const BAD_POD_STATUSES = new Set([
  'CrashLoopBackOff',
  'OOMKilled',
  'Error',
  'ImagePullBackOff',
  'ErrImagePull',
  'CreateContainerConfigError',
  'Evicted',
  'Failed',
]);

export type Tone = 'ok' | 'warning' | 'critical' | 'neutral';

export function podTone(status: string): Tone {
  if (BAD_POD_STATUSES.has(status) || status.startsWith('Init:')) return 'critical';
  if (status === 'Running') return 'ok';
  if (status === 'Pending' || status === 'ContainerCreating' || status === 'Terminating') {
    return 'warning';
  }
  return 'neutral';
}

/** Node condition series from `node.condition`: 1 while True. Ready is good when 1. */
export function conditionBad(condition: string, value: number): boolean {
  return condition === 'Ready' ? value !== 1 : value === 1;
}

export interface Segment {
  from: number;
  to: number;
  /** null: no data. */
  bad: boolean | null;
}

/**
 * Collapses a condition's [unix s, value] points into runs of good, bad and missing
 * data over [from, to]; a gap longer than two steps counts as missing.
 */
export function conditionSegments(
  condition: string,
  points: (number | null)[][],
  from: number,
  to: number,
  step: number,
): Segment[] {
  const out: Segment[] = [];
  const push = (start: number, end: number, bad: boolean | null) => {
    if (end <= start) return;
    const last = out[out.length - 1];
    if (last && last.bad === bad && last.to >= start) last.to = end;
    else out.push({ from: start, to: end, bad });
  };
  let cursor = from;
  for (const [t, v] of points) {
    if (t === null || t === undefined || t < from) continue;
    if (t - cursor > 2 * step) push(cursor, t - step, null);
    const bad = v === null || v === undefined ? null : conditionBad(condition, v);
    push(Math.max(cursor, t - step), Math.min(to, t + step), bad);
    cursor = Math.min(to, t + step);
  }
  if (to - cursor > 2 * step) push(cursor, to, null);
  return out;
}
