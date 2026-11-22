// SPDX-License-Identifier: AGPL-3.0-only
// The Scheduled jobs page's one list, "Jobs and their runs" (0.13.1, ADR-230 amended; 0.13.0
// had a timeline and a table): one row per job with its run strip over 6 h, 24 h or 7 days. The
// strip draws each slot's worst run (the backend keeps it), a "now" line, the next runs as
// dashed outlines (a random delay as a faint bar), and hatches the part of the range before
// WatchLog first saw the job. One order: need attention, running, working, new; then by next
// run. Jobs that don't run (disabled, suspended, cron lines with no cron daemon) go into one
// collapsed group with their reason. Pure: the page gives the jobs, the timeline and the clock.
import type { JobTimeline, JobTimelineLane, ScheduledJob } from '@watchlog/api-types';
import { duration, type Words } from './certs-jobs';

export type RunRange = '6h' | '24h' | '7d';
export const RUN_RANGES: RunRange[] = ['6h', '24h', '7d'];

export type MarkKind = 'success' | 'failed' | 'slow' | 'missed' | 'unknown' | 'running' | 'next';

export interface RunMark {
  kind: MarkKind;
  /** Left and width, in percent of the strip. */
  left: number;
  width: number;
  /** The run's start (or the missed or next time), epoch seconds. */
  at: number;
  seconds: number | null;
  code: number | null;
  runs: number;
}

/** The next run, as the backend's one next-run function gave it. */
export interface NextInfo {
  at: number;
  about: boolean;
  windowSec: number;
}

export interface RunLane {
  job: ScheduledJob;
  marks: RunMark[];
  runs: number;
  failures: number;
  next: NextInfo | null;
  /** The hatched part (before WatchLog first saw the job), percent of the strip from the left. */
  hatch: number;
  /** A random delay's window after the first next run, percent of the strip; null when none. */
  window: { left: number; width: number } | null;
}

/** The order of the groups: need attention, running, working, new (hasn't run yet). */
export const GROUP: Record<string, number> = {
  failed: 0,
  missed: 0,
  slow: 0,
  running: 1,
  working: 2,
  new: 3,
};

/** A job that doesn't run: a disabled timer, a cron line with no daemon, a suspended CronJob. */
export const notRunning = (j: Pick<ScheduledJob, 'enabled' | 'state'>) =>
  !j.enabled || j.state === 'disabled';

const pctOf = (tl: Pick<JobTimeline, 'from' | 'to'>, t: number) =>
  Math.max(0, Math.min(100, ((t - tl.from) / (tl.to - tl.from)) * 100));

/** Where "now" sits on the strip, in percent. */
export const nowPct = (tl: Pick<JobTimeline, 'from' | 'to' | 'now'>) => pctOf(tl, tl.now);

/**
 * The hatch boundary: from the range's start to when WatchLog first saw the job, never past
 * now; 0 when it was seen before the range began (or isn't known).
 */
export function hatchPct(
  firstSeen: number | null | undefined,
  tl: Pick<JobTimeline, 'from' | 'to' | 'now'>,
): number {
  if (firstSeen === null || firstSeen === undefined || firstSeen <= tl.from) return 0;
  return Math.min(pctOf(tl, firstSeen), nowPct(tl));
}

function nextOf(job: ScheduledJob, lane: JobTimelineLane | undefined): NextInfo | null {
  if (lane) return lane.nextRun;
  return job.nextAt !== null
    ? { at: job.nextAt, about: job.nextAbout, windowSec: job.nextWindowSec }
    : null;
}

function laneOf(
  job: ScheduledJob,
  lane: JobTimelineLane | undefined,
  tl: JobTimeline | null,
): RunLane {
  const next = nextOf(job, lane);
  if (!tl) return { job, marks: [], runs: 0, failures: 0, next, hatch: 0, window: null };
  const slotPct = 100 / tl.slots;
  const span = tl.to - tl.from;
  const marks: RunMark[] = (lane?.slots ?? []).map((s) => ({
    kind: s.result,
    left: s.i * slotPct,
    width: slotPct,
    at: s.at,
    seconds: s.seconds,
    code: s.code,
    runs: s.runs,
  }));
  for (const t of lane?.next ?? []) {
    const i = Math.min(tl.slots - 1, Math.floor(((t - tl.from) / span) * tl.slots));
    marks.push({
      kind: 'next',
      left: i * slotPct,
      width: slotPct,
      at: t,
      seconds: null,
      code: null,
      runs: 0,
    });
  }
  const window =
    next && next.windowSec > 0 && next.at <= tl.to
      ? {
          left: pctOf(tl, next.at),
          width: pctOf(tl, Math.min(tl.to, next.at + next.windowSec)) - pctOf(tl, next.at),
        }
      : null;
  return {
    job,
    marks,
    runs: lane?.runs ?? 0,
    failures: lane?.failures ?? 0,
    next,
    hatch: hatchPct(lane?.firstSeen ?? job.firstSeen, tl),
    window,
  };
}

const byNext = (a: RunLane, b: RunLane) =>
  (a.next?.at ?? Infinity) - (b.next?.at ?? Infinity) || a.job.name.localeCompare(b.job.name);

/**
 * The rows in one order (need attention, running, working, new; then the soonest next run; then
 * by name) and the jobs that don't run, apart. Without the timeline yet, rows have no marks.
 */
export function runLanes(
  jobs: ScheduledJob[],
  tl: JobTimeline | null,
): { rows: RunLane[]; notRunning: RunLane[] } {
  const byKey = new Map<string, JobTimelineLane>(
    (tl?.jobs ?? []).map((j) => [`${j.node}/${j.id}`, j]),
  );
  const all = jobs.map((job) => laneOf(job, byKey.get(`${job.node}/${job.id}`), tl));
  const rows = all
    .filter((l) => !notRunning(l.job))
    .sort((a, b) => (GROUP[a.job.state] ?? 9) - (GROUP[b.job.state] ?? 9) || byNext(a, b));
  const off = all
    .filter((l) => notRunning(l.job))
    .sort((a, b) => a.job.name.localeCompare(b.job.name));
  return { rows, notRunning: off };
}

/** Why a job doesn't run: no cron daemon on its server, a timer turned off, a suspended CronJob. */
export function notRunningWhy(j: Pick<ScheduledJob, 'kind' | 'node'>): Words {
  if (j.kind === 'cron')
    return j.node
      ? { key: 'jobRows.why.noDaemon', values: { server: j.node } }
      : { key: 'jobRows.why.noDaemonHere' };
  if (j.kind === 'cronjob') return { key: 'jobRows.why.suspended' };
  return { key: 'jobRows.why.timerOff' };
}

/** "3 not running: 2 disabled, 1 suspended". */
export function notRunningSummary(lanes: Pick<RunLane, 'job'>[]): Words {
  const suspended = lanes.filter((l) => l.job.kind === 'cronjob').length;
  const disabled = lanes.length - suspended;
  const key =
    suspended && disabled
      ? 'jobRows.notRunning.both'
      : suspended
        ? 'jobRows.notRunning.suspended'
        : 'jobRows.notRunning.disabled';
  return { key, values: { n: lanes.length, disabled, suspended } };
}

/**
 * The Last run column: "Succeeded · took 4 min", "Failed, exit 137 · 7 in a row", "Running for
 * 37 min", "Ran · exit code unknown", "Hasn't run yet".
 */
export function lastRunLine(j: ScheduledJob, nowSec: number): Words[] {
  const r = j.lastRun;
  if (!r) return [{ key: 'jobs.last.never' }];
  if (r.result === 'running')
    return [{ key: 'jobs.last.running', values: { d: duration(nowSec - r.startedAt) } }];
  if (r.result === 'failed') {
    const out: Words[] = [
      r.code !== null
        ? { key: 'jobRows.last.failedCode', values: { code: r.code } }
        : { key: 'jobs.last.failed' },
    ];
    if (j.failedStreak > 1) out.push({ key: 'jobRows.last.inARow', values: { n: j.failedStreak } });
    return out;
  }
  if (r.result === 'unknown') return [{ key: 'jobRows.last.ran' }];
  return [
    { key: 'jobs.last.ok' },
    ...(r.seconds !== null ? [{ key: 'jobs.last.took', values: { d: duration(r.seconds) } }] : []),
  ];
}

/**
 * The next run under the schedule: "next 17:55", "next about 15:25", "next around 00:00 (up to
 * 4 h later)", "no next run". `clock` formats a time.
 */
export function nextLine(next: NextInfo | null, clock: (unix: number) => string): Words {
  if (!next) return { key: 'jobRows.next.none' };
  if (next.windowSec > 0)
    return {
      key: 'jobRows.next.around',
      values: { when: clock(next.at), d: duration(next.windowSec) },
    };
  return next.about
    ? { key: 'jobRows.next.about', values: { when: clock(next.at) } }
    : { key: 'jobRows.next.at', values: { when: clock(next.at) } };
}

/** "WatchLog has watched this fleet for 5 hours", when it is younger than a day; else null. */
export function watchedFor(
  tl: Pick<JobTimeline, 'watchedSince' | 'now'> | null,
  kind: 'kubernetes' | 'server',
): Words | null {
  if (!tl?.watchedSince) return null;
  const age = tl.now - tl.watchedSince;
  if (age >= 86_400 || age < 0) return null;
  const hours = Math.floor(age / 3600);
  const place = kind === 'kubernetes' ? 'cluster' : 'fleet';
  return hours >= 1
    ? { key: `jobRows.watchedHours.${place}`, values: { n: hours } }
    : { key: `jobRows.watched.${place}`, values: { n: Math.max(1, Math.floor(age / 60)) } };
}

/**
 * The ticks: whole hours (6 h: every hour; 24 h: every 3 hours) or midnights (7 d), in the
 * viewer's time zone, given as minutes east of UTC so tests can pin it.
 */
export function runTicks(
  tl: Pick<JobTimeline, 'from' | 'to'>,
  range: RunRange,
  offsetMin: number,
): { at: number; pct: number }[] {
  const step = range === '6h' ? 3600 : range === '24h' ? 3 * 3600 : 86400;
  const shift = offsetMin * 60;
  const first = Math.ceil((tl.from + shift) / step) * step - shift;
  const out: { at: number; pct: number }[] = [];
  for (let t = first; t <= tl.to; t += step) out.push({ at: t, pct: pctOf(tl, t) });
  return out;
}

/** The words for one mark, for its tooltip and its accessible name. */
export function markWords(
  m: RunMark,
  when: (unix: number) => string,
  dur: (s: number) => string,
  t: (key: string, values?: Record<string, unknown>, n?: number) => string,
): string {
  const parts = [when(m.at), t(`runTimeline.result.${m.kind}`)];
  if (m.code !== null && m.kind !== 'next') parts.push(t('runTimeline.exitCode', { code: m.code }));
  if (m.seconds !== null && m.kind !== 'next' && m.kind !== 'missed') parts.push(dur(m.seconds));
  if (m.runs > 1) parts.push(t('runTimeline.runs', { n: m.runs }, m.runs));
  return parts.join(' · ');
}

/** A row's strip in words: its runs and failures in the range, missed runs, its next run. */
export function laneWords(
  l: RunLane,
  name: string,
  rangeWords: string,
  when: (unix: number) => string,
  t: (key: string, values?: Record<string, unknown>, n?: number) => string,
): string {
  const failedSlots = l.marks.filter((m) => m.kind === 'failed').map((m) => when(m.at));
  const missed = l.marks.filter((m) => m.kind === 'missed').map((m) => when(m.at));
  const parts = [
    t('runTimeline.a11y.lane', { name, range: rangeWords, n: l.runs }, l.runs),
    l.failures > 0
      ? t('runTimeline.a11y.failed', { n: l.failures, when: failedSlots.join(', ') }, l.failures)
      : t('runTimeline.a11y.noFailures'),
  ];
  if (missed.length) parts.push(t('runTimeline.a11y.missed', { when: missed.join(', ') }));
  if (l.hatch > 0) parts.push(t('runTimeline.a11y.notWatched'));
  if (l.next !== null) parts.push(t('runTimeline.a11y.next', { when: when(l.next.at) }));
  return parts.join('; ');
}
