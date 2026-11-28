// SPDX-License-Identifier: AGPL-3.0-only
// The tour's moments for the demo analytics (1.3.0, ADR-246): one GET each, answered with
// nothing. The demo's access log carries the path to the analytics as it does every page; the
// request says nothing about the visitor that any page request doesn't. Fire and forget: a
// lost event never holds the tour up.

export type TourMoment =
  | { name: 'shown' | 'finished' | 'cloud' | 'install' | 'replayed' }
  | { name: 'started'; kind: 'kubernetes' | 'server' }
  | { name: 'step'; step: 1 | 2 | 3 | 4 }
  | { name: 'skipped'; step: 0 | 1 | 2 | 3 | 4 }
  | { name: 'another'; story: string };

/** The path of a moment: /api/v1/demo/tour/event/<name>[/<detail>]. */
export function momentPath(m: TourMoment): string {
  const base = `/api/v1/demo/tour/event/${m.name}`;
  if (m.name === 'started') return `${base}/${m.kind === 'server' ? 'servers' : 'k8s'}`;
  if (m.name === 'step' || m.name === 'skipped') return `${base}/${m.step}`;
  if (m.name === 'another') return `${base}/${encodeURIComponent(m.story)}`;
  return base;
}

export function sendMoment(m: TourMoment): void {
  try {
    void fetch(momentPath(m), { credentials: 'same-origin', keepalive: true }).catch(() => {});
  } catch {
    /* never in the way */
  }
}
