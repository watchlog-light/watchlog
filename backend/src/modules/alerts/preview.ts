// SPDX-License-Identifier: AGPL-3.0-only
// Rule preview (alerts redesign item 9, ADR-096): how often a metric rule would have
// fired in the last 24 h with the settings being edited — a backtest over the same
// catalog query, the same duration and the same resolve rule as the worker
// (RESOLVE_CYCLES clean checks) — and the busiest series to draw with the thresholds.
import type { Condition } from './defaults.js';
import { RESOLVE_CYCLES } from './state-machine.js';

export interface BacktestResult {
  /** Episodes that would have fired. */
  fired: number;
  /** Of those, how many reached the critical threshold. */
  critical: number;
}

const crosses = (op: Condition['op'], v: number, t: number) => (op === '>' ? v > t : v < t);

/**
 * Replays one series sample by sample: pending once the warning threshold is crossed,
 * firing after `forSeconds`, resolved after RESOLVE_CYCLES samples below it. Missing
 * samples count as "no data" (they neither fire nor resolve), like an unreadable source.
 */
export function backtest(
  points: [number, number | null][],
  cond: Condition,
  forSeconds: number,
): BacktestResult {
  const out: BacktestResult = { fired: 0, critical: 0 };
  let since: number | null = null;
  let firing = false;
  let reachedCritical = false;
  let clean = 0;
  for (const [t, v] of points) {
    if (v === null) continue;
    const warn = crosses(cond.op, v, cond.value);
    const crit = cond.critical !== undefined && crosses(cond.op, v, cond.critical);
    if (warn || crit) {
      clean = 0;
      since ??= t;
      if (!firing && t - since >= forSeconds) {
        firing = true;
        reachedCritical = false;
        out.fired++;
      }
      if (firing && crit && !reachedCritical) {
        reachedCritical = true;
        out.critical++;
      }
    } else if (firing) {
      if (++clean >= RESOLVE_CYCLES) {
        firing = false;
        since = null;
      }
    } else {
      since = null;
    }
  }
  return out;
}
