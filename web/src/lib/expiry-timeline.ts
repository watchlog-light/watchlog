// SPDX-License-Identifier: AGPL-3.0-only
// The Certificates page's "When they expire" timeline and the Overview's strip (0.13.0,
// ADR-230): each certificate a dot on the day it expires, on an axis from today to the
// range's end; an expired one at the left edge. Labels sit on three lanes so they don't
// overlap, flip to the left near the right end, and with many certificates only the soonest
// and the problems keep one; dots on the same day become one dot with a count. Pure: the page
// and the tests give the certificates, the range and the width.

export type ExpiryRange = 30 | 90 | 365;
export const EXPIRY_RANGES: ExpiryRange[] = [30, 90, 365];

export interface TimelineCert {
  id: string;
  name: string;
  /** Where it is served, for the label: "Ingress shop/api", "app-1 :443". */
  where: string;
  /** Days left; negative once expired. */
  daysLeft: number;
  /** A certificate problem (a name mismatch, an incomplete chain): its label is kept. */
  problem: boolean;
}

export type DotTone = 'crit' | 'warn' | 'info';

export interface TimelineMark {
  /** The first certificate's id; a cluster's ids are in `items`. */
  id: string;
  /** Left, in percent of the axis. */
  pct: number;
  tone: DotTone;
  /** The certificates on this dot: one, or a cluster on the same day. */
  items: TimelineCert[];
  /** Its label's lane (0–2), or null when it carries no label. */
  lane: number | null;
  /** The label extends to the left of the dot (near the right end). */
  flip: boolean;
}

export interface TimelinePlacement {
  marks: TimelineMark[];
  /** Certificates that expire after the range. */
  later: number;
  ticks: { days: number; pct: number }[];
  /** The usual renewal window (ACME clients renew in the last 30 days): its end, in percent. */
  windowEnd: number;
}

export const LANES = 3;
/** Past this many certificates in range, same-day dots cluster and labels are kept for a few. */
export const CLUSTER_OVER = 15;
/** With clustering on, how many of the soonest keep a label (problems always do). */
export const LABELS_KEPT = 6;
/** Labels flip to the left past this point of the axis. */
export const FLIP_AT = 78;

export function toneOf(daysLeft: number): DotTone {
  if (daysLeft < 3) return 'crit';
  if (daysLeft < 14) return 'warn';
  return 'info';
}

export function ticksFor(range: ExpiryRange): number[] {
  if (range === 30) return [0, 7, 14, 21, 30];
  if (range === 90) return [0, 14, 30, 60, 90];
  return [0, 30, 90, 180, 365];
}

/** The widest a label gets (it truncates past this): 60% of the axis, at least 120 px. */
export const maxLabelPx = (widthPx: number) => Math.max(120, widthPx * 0.6);
/** A label's width in pixels: its text in a 12 px monospace face, its padding, capped. */
const labelPx = (c: TimelineCert, widthPx: number) =>
  Math.min(maxLabelPx(widthPx), (c.name.length + 6) * 7.3 + 16);

/**
 * Where each certificate goes. `widthPx` is the axis's width, for the lanes; `labels` false
 * gives the strip (dots only).
 */
export function placeCerts(
  certs: TimelineCert[],
  range: ExpiryRange,
  opts: { widthPx?: number; labels?: boolean } = {},
): TimelinePlacement {
  const width = Math.max(200, opts.widthPx ?? 900);
  const inRange = certs
    .filter((c) => c.daysLeft <= range)
    .sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name));
  const later = certs.length - inRange.length;
  const pctOf = (d: number) => (Math.max(0, Math.min(range, d)) / range) * 100;
  const cluster = inRange.length > CLUSTER_OVER;

  // One dot per certificate, or per day when there are many (expired ones share the edge).
  const groups: TimelineCert[][] = [];
  for (const c of inRange) {
    const day = Math.max(0, Math.floor(c.daysLeft));
    const last = groups[groups.length - 1];
    if (cluster && last && Math.max(0, Math.floor(last[0]!.daysLeft)) === day) last.push(c);
    else groups.push([c]);
  }

  // Which keep a label: all of them, or with many the soonest few and every problem.
  const labelled = new Set<TimelineCert[]>();
  if (opts.labels !== false) {
    groups.forEach((g, i) => {
      if (!cluster || i < LABELS_KEPT || g.some((c) => c.problem || c.daysLeft < 14))
        labelled.add(g);
    });
  }

  // Lanes: each label takes the first lane free at its span; the busiest lane's end otherwise.
  const ends = Array.from({ length: LANES }, () => -Infinity);
  const marks = groups.map((g): TimelineMark => {
    const first = g[0]!;
    const pct = pctOf(first.daysLeft);
    const worst = Math.min(...g.map((c) => c.daysLeft));
    const w = (labelPx(first, width) / width) * 100;
    // Flip near the right end, or wherever the label would run past it (narrow screens).
    const flip = pct > FLIP_AT || (pct + w > 100 && pct > 50);
    let lane: number | null = null;
    if (labelled.has(g)) {
      const start = flip ? pct - w : pct;
      const end = flip ? pct : pct + w;
      const free = ends.findIndex((e) => e <= start);
      lane = free >= 0 ? free : ends.indexOf(Math.min(...ends));
      ends[lane] = end + 0.5;
    }
    return { id: first.id, pct, tone: toneOf(worst), items: g, lane, flip };
  });

  return {
    marks,
    later,
    ticks: ticksFor(range).map((days) => ({ days, pct: (days / range) * 100 })),
    windowEnd: Math.min(100, (30 / range) * 100),
  };
}

/** The drawing's text equivalent: every certificate in range and its days. */
export function timelineText(
  certs: TimelineCert[],
  range: ExpiryRange,
  say: (key: string, values: Record<string, unknown>, n?: number) => string,
): string {
  const inRange = certs.filter((c) => c.daysLeft <= range).sort((a, b) => a.daysLeft - b.daysLeft);
  const parts = inRange.map((c) =>
    c.daysLeft < 0
      ? say('certTimeline.a11y.expired', { name: c.name, n: -c.daysLeft }, -c.daysLeft)
      : say('certTimeline.a11y.left', { name: c.name, n: c.daysLeft }, c.daysLeft),
  );
  const later = certs.length - inRange.length;
  return [
    say('certTimeline.a11y.head', { n: range }, range),
    ...parts,
    ...(later > 0 ? [say('certTimeline.a11y.later', { n: later }, later)] : []),
  ].join('; ');
}
