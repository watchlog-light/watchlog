// SPDX-License-Identifier: AGPL-3.0-only
// A scheduled job's next run (0.13.1, ADR-230 amended): the one answer the list, a job's page,
// the Overview card and the run strip's dashed marks all use. Pure, on an injected clock.
//
// What the agent reports is what systemd or cron says, and systemd says nothing while a timer's
// unit runs (NextElapseUSecRealtime is 0 until it finishes) and nothing for timers that count
// from their last run (OnUnitActiveSec: a monotonic time). A reported time can also be a few
// seconds stale. So: a reported time still ahead wins; otherwise the next one comes from the
// period, stepped forward from the reported time or the last run, and is "about" when stepped
// over an irregular gap or when systemd adds a random delay.

export interface NextInput {
  enabled: boolean;
  state: string;
  /** The agent's next time, epoch seconds, or null. */
  nextAt: number | null;
  /** The usual time between runs, seconds (0: unknown). */
  everySec: number;
  /** The last run's start, epoch seconds, or null. */
  lastStart: number | null;
  /** systemd's RandomizedDelaySec: the run comes up to this much later. */
  randomDelaySec: number;
  /** "after boot or its last run": the timer counts from its last activation. */
  relative: boolean;
}

export interface NextRun {
  /** The earliest time it can run, epoch seconds. */
  at: number;
  /** Computed from the period rather than reported: say "about". */
  about: boolean;
  /** It runs somewhere in [at, at + windowSec] (a random delay). */
  windowSec: number;
}

export const RELATIVE_SCHEDULE = 'after boot or its last run';

/** Whether a job runs at all: disabled timers, cron lines with no daemon, suspended CronJobs. */
export const notRunning = (j: Pick<NextInput, 'enabled' | 'state'>) =>
  !j.enabled || j.state === 'disabled';

/**
 * The period as a schedule means it: systemd's next minus its last trigger is a second or two
 * short (3598 for hourly), so periods of two minutes or more are rounded to whole minutes.
 */
export const period = (everySec: number) =>
  everySec >= 120 ? Math.round(everySec / 60) * 60 : everySec;

/** The first time after `t0 + k·every` that is after `now`. */
function stepPast(t0: number, every: number, now: number): number {
  if (t0 > now) return t0;
  return t0 + (Math.floor((now - t0) / every) + 1) * every;
}

export function nextRun(j: NextInput, nowSec: number): NextRun | null {
  if (notRunning(j)) return null;
  const windowSec = Math.max(0, j.randomDelaySec);
  const random = windowSec > 0;
  if (j.nextAt !== null && j.nextAt > nowSec) return { at: j.nextAt, about: false, windowSec };
  const every = period(j.everySec);
  if (every <= 0) return null;
  // A timer counting from its last run: the last start plus its interval.
  if (j.relative) {
    if (j.lastStart === null) return null;
    return { at: stepPast(j.lastStart + every, every, nowSec), about: random, windowSec };
  }
  const base = j.nextAt ?? j.lastStart;
  if (base === null) return null;
  return { at: stepPast(base, every, nowSec), about: true, windowSec };
}

/**
 * The next runs from now until `untilSec`, at most `max`: the first from `nextRun`, then one
 * period apart. A job with no known period has its first only.
 */
export function nextRuns(j: NextInput, nowSec: number, untilSec: number, max = 96): number[] {
  const first = nextRun(j, nowSec);
  if (!first || first.at > untilSec) return [];
  const out = [first.at];
  const every = period(j.everySec);
  if (every <= 0) return out;
  for (let t = first.at + every; t <= untilSec && out.length < max; t += every) out.push(t);
  return out;
}
