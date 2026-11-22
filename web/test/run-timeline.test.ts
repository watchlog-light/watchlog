// SPDX-License-Identifier: AGPL-3.0-only
// The Scheduled jobs page's one list (0.13.1, ADR-230 amended): one order (need attention,
// running, working, new; then the next run), the jobs that don't run in their own group with a
// reason, the hatch before WatchLog first saw a job, the next and last-run lines, the "watched
// for" line, the ticks. On an injected clock.
import type { JobTimeline, ScheduledJob } from '@watchlog/api-types';
import { describe, expect, it } from 'vitest';
import { createAppI18n } from '@/i18n';
import type { Words } from '@/lib/certs-jobs';
import {
  hatchPct,
  lastRunLine,
  laneWords,
  markWords,
  nextLine,
  notRunningSummary,
  notRunningWhy,
  nowPct,
  runLanes,
  runTicks,
  watchedFor,
} from '@/lib/run-timeline';

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0) / 1000;
const HOUR = 3600;
// 24 h: 21 h past and 3 h ahead, 96 slots of 15 minutes.
const tl = (jobs: JobTimeline['jobs'], over: Partial<JobTimeline> = {}): JobTimeline => ({
  range: '24h',
  watchedSince: null,
  now: NOW,
  from: NOW - 21 * HOUR,
  to: NOW + 3 * HOUR,
  slots: 96,
  jobs,
  ...over,
});
const job = (name: string, state: string, over: Partial<ScheduledJob> = {}): ScheduledJob =>
  ({
    id: `${name}-id`,
    node: 'worker-1',
    name,
    kind: 'timer',
    state,
    enabled: true,
    nextAt: null,
    nextAbout: false,
    nextWindowSec: 0,
    failedStreak: 0,
    lastRun: null,
    firstSeen: NOW - 30 * 86_400,
    ...over,
  }) as ScheduledJob;
const lane = (name: string, over: Partial<JobTimeline['jobs'][number]> = {}) => ({
  id: `${name}-id`,
  node: 'worker-1',
  slots: [],
  next: [],
  runs: 0,
  failures: 0,
  nextRun: null,
  firstSeen: null,
  ...over,
});
const i18n = createAppI18n();
const say = (w: Words) => {
  expect(i18n.global.te(w.key), w.key).toBe(true);
  return i18n.global.t(w.key, w.values ?? {}, Number(w.values?.n ?? 1));
};

describe('runLanes', () => {
  it('one order: need attention, running, working, new; inside each, by next run', () => {
    const jobs = [
      job('new.timer', 'new', { nextAt: NOW + HOUR }),
      job('later.timer', 'working', { nextAt: NOW + 5 * HOUR }),
      job('soon.timer', 'working', { nextAt: NOW + HOUR }),
      job('busy.timer', 'running'),
      job('slow.timer', 'slow', { nextAt: NOW + 2 * HOUR }),
      job('broken.timer', 'failed', { nextAt: NOW + 3 * HOUR }),
      job('missed.timer', 'missed', { nextAt: NOW + HOUR }),
    ];
    expect(runLanes(jobs, null).rows.map((l) => l.job.name)).toEqual([
      'missed.timer',
      'slow.timer',
      'broken.timer',
      'busy.timer',
      'soon.timer',
      'later.timer',
      'new.timer',
    ]);
  });

  it('jobs that do not run go apart, with their reason; they are not rows', () => {
    const jobs = [
      job('backup.timer', 'working'),
      job('sessionclean', 'disabled', { kind: 'cron', enabled: false, node: 'demo-server' }),
      job('fstrim.timer', 'disabled', { enabled: false }),
      job('shop/archive', 'disabled', { kind: 'cronjob', enabled: false, node: '' }),
    ];
    const { rows, notRunning } = runLanes(jobs, null);
    expect(rows.map((l) => l.job.name)).toEqual(['backup.timer']);
    expect(notRunning.map((l) => l.job.name)).toEqual([
      'fstrim.timer',
      'sessionclean',
      'shop/archive',
    ]);
    expect(say(notRunningSummary(notRunning))).toBe('3 not running: 2 disabled, 1 suspended');
    expect(say(notRunningWhy(jobs[1]!))).toBe('Disabled: no cron daemon on demo-server');
    expect(say(notRunningWhy(jobs[2]!))).toBe('Disabled: the timer is turned off');
    expect(say(notRunningWhy(jobs[3]!))).toBe('Suspended: the CronJob is suspended');
    expect(say(notRunningSummary(notRunning.slice(0, 2)))).toBe('2 not running: all disabled');
  });

  it('turns slots and next runs into marks; the row and the strip share one next run', () => {
    const next = { at: NOW + 2 * HOUR, about: true, windowSec: 0 };
    const { rows } = runLanes(
      [job('backup.service', 'working', { nextAt: NOW + 2 * HOUR, nextAbout: true })],
      tl([
        lane('backup.service', {
          slots: [{ i: 12, result: 'failed', at: NOW - 18 * HOUR, seconds: 40, code: 2, runs: 1 }],
          next: [NOW + 2 * HOUR],
          nextRun: next,
          runs: 1,
          failures: 1,
        }),
      ]),
    );
    expect(rows[0]!.marks.map((m) => [m.kind, m.left])).toEqual([
      ['failed', 12.5],
      ['next', (92 / 96) * 100], // 23 h of 24: slot 92
    ]);
    expect(rows[0]!.next).toEqual(next);
  });

  it('a random delay gives a faint window after the first next run', () => {
    const { rows } = runLanes(
      [job('dpkg-db-backup.timer', 'new')],
      tl([
        lane('dpkg-db-backup.timer', {
          nextRun: { at: NOW + HOUR, about: false, windowSec: HOUR },
        }),
      ]),
    );
    expect(rows[0]!.window!.left).toBeCloseTo((22 / 24) * 100, 5);
    expect(rows[0]!.window!.width).toBeCloseTo((1 / 24) * 100, 5);
  });
});

describe('the hatch', () => {
  const t = tl([]);
  it('from the range start to when WatchLog first saw the job, never past now', () => {
    expect(hatchPct(NOW - 30 * HOUR, t)).toBe(0); // seen before the range
    expect(hatchPct(NOW - 9 * HOUR, t)).toBeCloseTo((12 / 24) * 100, 5); // 12 h into 24
    expect(hatchPct(NOW + HOUR, t)).toBeCloseTo(nowPct(t), 5); // a clock skew: up to now
    expect(hatchPct(null, t)).toBe(0);
  });

  it('a row carries its hatch, from the timeline or the job', () => {
    const { rows } = runLanes(
      [job('chaos-fpm.timer', 'working', { firstSeen: NOW - 3 * HOUR })],
      tl([lane('chaos-fpm.timer', { firstSeen: NOW - 3 * HOUR })]),
    );
    expect(rows[0]!.hatch).toBeCloseTo((18 / 24) * 100, 5);
  });
});

describe('the lines', () => {
  const clock = (u: number) => new Date(u * 1000).toISOString().slice(11, 16);
  it('next run: at, about, around a random delay, none', () => {
    expect(say(nextLine({ at: NOW + HOUR, about: false, windowSec: 0 }, clock))).toBe('next 13:00');
    expect(say(nextLine({ at: NOW + HOUR, about: true, windowSec: 0 }, clock))).toBe(
      'next about 13:00',
    );
    expect(
      say(nextLine({ at: NOW + 12 * HOUR, about: false, windowSec: 4 * HOUR }, clock)),
    ).toMatch(/^next around 00:00 \(up to 4 h later\)$/);
    expect(say(nextLine(null, clock))).toBe('no next run');
  });

  it('last run: succeeded and took, failed with its code and streak, running for, unknown', () => {
    const run = (over: object) => ({
      startedAt: NOW - 600,
      endedAt: NOW - 360,
      seconds: 240,
      code: 0,
      result: 'success',
      ...over,
    });
    const line = (j: ScheduledJob) => lastRunLine(j, NOW).map(say).join(' · ');
    expect(line(job('a', 'working', { lastRun: run({}) }))).toBe('Succeeded · took 4 min');
    expect(
      line(job('a', 'failed', { failedStreak: 7, lastRun: run({ result: 'failed', code: 137 }) })),
    ).toBe('Failed, exit 137 · 7 in a row');
    expect(
      line(job('a', 'running', { lastRun: run({ result: 'running', startedAt: NOW - 37 * 60 }) })),
    ).toBe('Running for 37 min');
    expect(line(job('a', 'working', { lastRun: run({ result: 'unknown', code: null }) }))).toBe(
      'Ran · exit code unknown',
    );
    expect(line(job('a', 'new'))).toBe("Hasn't run yet");
  });

  it('says how long WatchLog has watched a young fleet or cluster, and nothing after a day', () => {
    expect(say(watchedFor(tl([], { watchedSince: NOW - 5 * HOUR - 60 }), 'server')!)).toBe(
      'WatchLog has watched this fleet for 5 hours',
    );
    expect(say(watchedFor(tl([], { watchedSince: NOW - 20 * 60 }), 'kubernetes')!)).toBe(
      'WatchLog has watched this cluster for 20 minutes',
    );
    expect(watchedFor(tl([], { watchedSince: NOW - 30 * HOUR }), 'server')).toBeNull();
    expect(watchedFor(tl([]), 'server')).toBeNull();
  });
});

describe('the strip', () => {
  it('puts now at 21 of 24 hours', () => {
    expect(nowPct(tl([]))).toBeCloseTo(87.5, 5);
  });

  it('ticks on whole hours in the viewer’s zone: every 3 h on 24 h, midnights on 7 d', () => {
    const ticks = runTicks(tl([]), '24h', 0);
    expect(ticks.map((x) => new Date(x.at * 1000).getUTCHours())).toEqual([
      15, 18, 21, 0, 3, 6, 9, 12, 15,
    ]);
    const ist = runTicks(tl([]), '24h', 330);
    expect(((ist[0]!.at + 330 * 60) % (3 * HOUR)) / 60).toBe(0);
    const week = { from: NOW - 6 * 86400, to: NOW + 86400 };
    expect(runTicks(week, '7d', 0).every((x) => x.at % 86400 === 0)).toBe(true);
  });

  it('says each mark and each row in words, the hatch included', () => {
    const t = (k: string, v: Record<string, unknown> = {}) => `${k}${JSON.stringify(v)}`;
    expect(
      markWords(
        { kind: 'failed', left: 0, width: 1, at: NOW, seconds: 40, code: 137, runs: 1 },
        () => '12:00',
        (s) => `${s} s`,
        t,
      ),
    ).toBe('12:00 · runTimeline.result.failed{} · runTimeline.exitCode{"code":137} · 40 s');
    const { rows } = runLanes(
      [job('backup.service', 'failed', { firstSeen: NOW - 3 * HOUR })],
      tl([
        lane('backup.service', {
          slots: [{ i: 90, result: 'failed', at: NOW - HOUR, seconds: 4, code: 1, runs: 1 }],
          runs: 2,
          failures: 1,
          firstSeen: NOW - 3 * HOUR,
        }),
      ]),
    );
    const text = laneWords(rows[0]!, 'backup.service', '24 h', () => '11:00', t);
    expect(text).toContain('runTimeline.a11y.failed{"n":1,"when":"11:00"}');
    expect(text).toContain('runTimeline.a11y.notWatched');
  });
});
