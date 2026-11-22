// SPDX-License-Identifier: AGPL-3.0-only
// The Scheduled jobs page's "Runs" timeline (0.13.0, ADR-230): one lane per job, its runs over
// 6 h, 24 h or 7 days as marks in fixed slots (the backend keeps each slot's worst run), a "now"
// line, the next runs ahead as dashed outlines. Lanes go problems first, then by next run; 12
// show until "Show all". Pure: the page gives the jobs, the timeline answer and the clock.
import type { JobTimeline, JobTimelineLane, ScheduledJob } from '@watchlog/api-types';

export type RunRange = '6h' | '24h' | '7d';
export const RUN_RANGES: RunRange[] = ['6h', '24h', '7d'];
/** Lanes shown before "Show all N". */
export const LANES_SHOWN = 12;

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

export interface RunLane {
  job: ScheduledJob;
  marks: RunMark[];
  runs: number;
  failures: number;
  /** The next run's time, or null. */
  next: number | null;
}

const PROBLEM: Record<string, number> = { failed: 0, missed: 1, slow: 2 };

/**
 * The lanes, in order: problems first (failing, missed, slow), then the soonest next run, then
 * by name. Jobs the timeline doesn't know (a race with the list) get an empty strip.
 */
export function runLanes(jobs: ScheduledJob[], tl: JobTimeline): RunLane[] {
  const byKey = new Map<string, JobTimelineLane>(tl.jobs.map((j) => [`${j.node}/${j.id}`, j]));
  const span = tl.to - tl.from;
  const slotPct = 100 / tl.slots;
  const lanes = jobs.map((job): RunLane => {
    const lane = byKey.get(`${job.node}/${job.id}`);
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
    return {
      job,
      marks,
      runs: lane?.runs ?? 0,
      failures: lane?.failures ?? 0,
      next: lane?.next[0] ?? (job.nextAt && job.nextAt > tl.now ? job.nextAt : null),
    };
  });
  const rank = (l: RunLane) => PROBLEM[l.job.state] ?? 9;
  return lanes.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.next ?? Infinity) - (b.next ?? Infinity) ||
      a.job.name.localeCompare(b.job.name),
  );
}

/** Where "now" sits on the strip, in percent. */
export const nowPct = (tl: Pick<JobTimeline, 'from' | 'to' | 'now'>) =>
  ((tl.now - tl.from) / (tl.to - tl.from)) * 100;

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
  for (let t = first; t <= tl.to; t += step)
    out.push({ at: t, pct: ((t - tl.from) / (tl.to - tl.from)) * 100 });
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

/** A lane's text equivalent: its runs and failures in the range, and its next run. */
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
  if (l.next !== null) parts.push(t('runTimeline.a11y.next', { when: when(l.next) }));
  return parts.join('; ');
}
