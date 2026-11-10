// SPDX-License-Identifier: AGPL-3.0-only
// The rules on the object itself (slice 2) and under it (slice 4: node_or_host, cpu_throttled),
// and what the rules across the map ask of them: the dependency's or the consumer's own cause,
// and the steps of it that fit after their own.
import type { Evidence } from '../evidence.js';
import { rank } from '../rank.js';
import type { Rule } from '../rules.js';
import type { Candidate, Step } from '../types.js';
import { badChange } from './bad-change.js';
import { cpuThrottled } from './cpu-throttled.js';
import { crashExit } from './crash-exit.js';
import { imagePull } from './image-pull.js';
import { jobFailed } from './job-failed.js';
import { nodeOrHost } from './node-or-host.js';
import { oomLimit } from './oom-limit.js';
import { run } from './run.js';
import { unschedulable } from './unschedulable.js';

export const OWN_RULES: readonly Rule[] = [
  badChange,
  oomLimit,
  crashExit,
  imagePull,
  unschedulable,
  jobFailed,
  nodeOrHost,
  cpuThrottled,
];
export const OWN_CODES: readonly string[] = OWN_RULES.map((r) => r.code);

/** The best cause of the object itself, as ranking orders them; null when none. */
export function bestOf(candidates: Candidate[], ev: Evidence): Candidate | null {
  if (!candidates.length) return null;
  return rank(candidates, ev.symptomAt, ev.window.from).kept[0]?.candidate ?? null;
}

/** The object's own cause (slice 2's rules), for a rule that explains something through it. */
export const ownCause = (ev: Evidence): Candidate | null => bestOf(run(ev, OWN_RULES), ev);

/** Counts that only repeat what the next step says ("7 restarts in the last hour"). */
const COUNTS = new Set(['restarts', 'restarts_backoff', 'restarts_policy']);
/** Details that support a step before them (the memory trend, the last warning). */
const DETAILS = new Set(['memory_climbs', 'last_event']);

/**
 * At most `room` steps of an own cause's chain, to follow another rule's steps: the counts go
 * first, then the supporting details, then the earliest steps (where it starts stays). The
 * last step kept ends the chain (next null).
 */
export function tail(chain: Step[], room: number): Step[] {
  let steps = [...chain];
  if (steps.length > room) steps = steps.filter((s) => !COUNTS.has(s.code));
  if (steps.length > room) steps = steps.filter((s) => !DETAILS.has(s.code));
  if (steps.length > room) steps = steps.slice(steps.length - room);
  if (!steps.length) return [];
  const last = steps[steps.length - 1]!;
  return [...steps.slice(0, -1), { ...last, next: null }];
}
