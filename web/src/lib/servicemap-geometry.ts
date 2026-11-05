// SPDX-License-Identifier: AGPL-3.0-only
// Geometry of the service map: curved edges between node rims, points along them for
// the live particles and badges, and which labels fit without overlapping.

export interface Pt {
  x: number;
  y: number;
}
export interface Curve {
  start: Pt;
  control: Pt;
  end: Pt;
}

/** A gentle curve from rim to rim, bowed to one side so opposite edges don't overlap. */
export function curve(a: Pt, b: Pt, ra: number, rb: number): Curve {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const start = { x: a.x + (dx / len) * ra, y: a.y + (dy / len) * ra };
  const end = { x: b.x - (dx / len) * rb, y: b.y - (dy / len) * rb };
  const bow = Math.min(28, len * 0.12);
  return {
    start,
    end,
    control: {
      x: (start.x + end.x) / 2 - (dy / len) * bow,
      y: (start.y + end.y) / 2 + (dx / len) * bow,
    },
  };
}

export const pathOf = (c: Curve) =>
  `M${c.start.x.toFixed(1)} ${c.start.y.toFixed(1)} Q${c.control.x.toFixed(1)} ${c.control.y.toFixed(1)} ${c.end.x.toFixed(1)} ${c.end.y.toFixed(1)}`;

/** The point at t ∈ [0, 1] on the curve. */
export function pointAt(c: Curve, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * c.start.x + 2 * u * t * c.control.x + t * t * c.end.x,
    y: u * u * c.start.y + 2 * u * t * c.control.y + t * t * c.end.y,
  };
}

/** Approximate length (a few chords), enough to keep particle speed even. */
export function lengthOf(c: Curve): number {
  let len = 0;
  let prev = c.start;
  for (let i = 1; i <= 8; i++) {
    const p = pointAt(c, i / 8);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return len;
}

export interface LabelCandidate {
  id: string;
  x: number;
  y: number;
  text: string;
  /** Higher first: selected and hovered, problems, busy nodes. */
  priority: number;
  /** Always shown (selected, hovered and their neighbours). */
  force?: boolean;
}

const CHAR_W = 6.6;
const LABEL_H = 15;

/**
 * Labels to draw: greedily by priority, each below its node or, if that overlaps one
 * already placed, above it; otherwise hidden. Zoomed out (scale < 0.6) only forced and
 * high-priority labels are considered, so minor labels give way.
 */
export function placeLabels(
  cands: LabelCandidate[],
  scale: number,
  offset = 34,
): Map<string, { x: number; y: number }> {
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const out = new Map<string, { x: number; y: number }>();
  const sorted = [...cands].sort(
    (a, b) =>
      Number(!!b.force) - Number(!!a.force) || b.priority - a.priority || a.id.localeCompare(b.id),
  );
  for (const c of sorted) {
    if (scale < 0.6 && !c.force && c.priority < 2) continue;
    const w = c.text.length * CHAR_W + 6;
    for (const dy of [offset, -offset + 6]) {
      const box = {
        x0: c.x - w / 2,
        y0: c.y + dy - LABEL_H + 3,
        x1: c.x + w / 2,
        y1: c.y + dy + 4,
      };
      const hit = placed.some(
        (b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0,
      );
      if (!hit || c.force) {
        placed.push(box);
        out.set(c.id, { x: c.x, y: c.y + dy });
        break;
      }
    }
  }
  return out;
}
