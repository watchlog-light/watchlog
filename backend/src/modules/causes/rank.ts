// SPDX-License-Identifier: AGPL-3.0-only
// Ranking (ADR-146) and strength in words (ADR-147). Pure.
//   Order: 1. could be likely (a complete chain that did not begin after the symptom);
//          2. when it began: before the symptom inside the window, with it, unknown, before
//             the window, after the symptom; 3. a complete chain; 4. fewer hops; 5. the
//             catalog's order.
//   Strength: the first is likely when it could be, unless the second could be too and
//   ties with it on everything but the catalog's order: then both are possible. Every
//   other cause is possible. At most three causes; at most one likely.
import { catalogIndex } from './catalog.js';
import type { Candidate, Cause, Check, State } from './types.js';

export const MAX_CAUSES = 3;
/** A cause this close to the symptom began "with it". */
export const SAME_TIME_MS = 60_000;

export const Timing = { before: 0, same: 1, unknown: 2, old: 3, after: 4 } as const;
export type Timing = (typeof Timing)[keyof typeof Timing];

/** When a cause began against the symptom and the window before it. */
export function timing(since: string | null, symptomAt: string | null, windowFrom: string): Timing {
  if (!since) return Timing.unknown;
  if (!symptomAt) return Timing.same;
  const s = Date.parse(since);
  const at = Date.parse(symptomAt);
  if (Math.abs(s - at) <= SAME_TIME_MS) return Timing.same;
  if (s > at) return Timing.after;
  return s >= Date.parse(windowFrom) ? Timing.before : Timing.old;
}

const eligible = (c: Candidate, t: Timing) => c.complete && t !== Timing.after;

export interface Ranked {
  state: State;
  causes: Cause[];
  /** The candidates kept, in order, with their strength (for marking the checks). */
  kept: { candidate: Candidate; cause: Cause }[];
}

export function rank(
  candidates: Candidate[],
  symptomAt: string | null,
  windowFrom: string,
): Ranked {
  const scored = candidates.map((c) => ({ c, t: timing(c.since, symptomAt, windowFrom) }));
  scored.sort(
    (a, b) =>
      Number(eligible(b.c, b.t)) - Number(eligible(a.c, a.t)) ||
      a.t - b.t ||
      Number(b.c.complete) - Number(a.c.complete) ||
      a.c.hops - b.c.hops ||
      catalogIndex(a.c.rule) - catalogIndex(b.c.rule),
  );
  const top = scored.slice(0, MAX_CAUSES);
  const [first, second] = top;
  const tie =
    !!first &&
    !!second &&
    eligible(second.c, second.t) &&
    first.t === second.t &&
    first.c.hops === second.c.hops;
  const likely = !!first && eligible(first.c, first.t) && !tie;
  const kept = top.map(({ c }, i) => ({
    candidate: c,
    cause: {
      rule: c.rule,
      strength: i === 0 && likely ? ('likely' as const) : ('possible' as const),
      code: c.code,
      facts: c.facts,
      since: c.since,
      chain: c.chain.slice(0, 3),
    },
  }));
  return {
    state: likely ? 'likely' : kept.length ? 'possible' : 'none',
    causes: kept.map((k) => k.cause),
    kept,
  };
}

/** The checks a kept cause explains: `explains` for the likely one, `possible` for others. */
export function markChecks(checks: Check[], ranked: Ranked): Check[] {
  return checks.map((ch) => {
    let result = ch.result;
    for (const { candidate, cause } of ranked.kept) {
      if (!candidate.explains.includes(ch.topic)) continue;
      if (cause.strength === 'likely') result = 'explains';
      else if (result !== 'explains') result = 'possible';
    }
    return result === ch.result ? ch : { ...ch, result };
  });
}
