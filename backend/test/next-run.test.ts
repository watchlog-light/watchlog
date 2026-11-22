// SPDX-License-Identifier: AGPL-3.0-only
// A job's next run (0.13.1, ADR-230 amended): the one answer for the list, a job's page, the
// Overview and the run strip. On an injected clock: calendar timers (reported, stale, and while
// their unit runs, as chaos-release.timer on the demo), relative timers, random delays, and
// jobs that don't run.
import { describe, expect, it } from 'vitest';
import { nextRun, nextRuns, period, type NextInput } from '../src/modules/certs-jobs/next-run.js';

const NOW = Date.UTC(2026, 10, 22, 14, 33, 51) / 1000;
const at = (h: number, m: number, s = 0) => Date.UTC(2026, 10, 22, h, m, s) / 1000;
const HOUR = 3600;
const job = (over: Partial<NextInput>): NextInput => ({
  enabled: true,
  state: 'working',
  nextAt: null,
  everySec: 0,
  lastStart: null,
  randomDelaySec: 0,
  relative: false,
  ...over,
});

describe('nextRun', () => {
  it('a reported time still ahead wins, as reported', () => {
    expect(nextRun(job({ nextAt: at(14, 45), everySec: 3598 }), NOW)).toEqual({
      at: at(14, 45),
      about: false,
      windowSec: 0,
    });
  });

  it('chaos-release.timer while its unit runs: systemd reports none, the next comes from the period', () => {
    // Hourly at :25, ran at 14:25:02 for 10 minutes; at 14:33 systemd's next elapse is 0.
    const r = nextRun(
      job({ state: 'running', nextAt: null, everySec: 3598, lastStart: at(14, 25, 2) }),
      NOW,
    );
    expect(r).toEqual({ at: at(15, 25, 2), about: true, windowSec: 0 });
  });

  it('a stale reported time (just passed) steps to the next period, on the minute', () => {
    // The agent's last report said 14:25:00; it is 14:33 now.
    expect(nextRun(job({ nextAt: at(14, 25), everySec: 3598 }), NOW)!.at).toBe(at(15, 25));
    // Every 2 hours from 01:50, reported 13:50 long ago: 15:50.
    expect(nextRun(job({ nextAt: at(13, 50), everySec: 7198 }), NOW)!.at).toBe(at(15, 50));
  });

  it('periods are rounded to whole minutes from 2 minutes up', () => {
    expect([period(3598), period(7198), period(86_401), period(60), period(90)]).toEqual([
      3600, 7200, 86_400, 60, 90,
    ]);
  });

  it('a relative timer (OnUnitActiveSec): the last run plus its interval, "about" with a delay', () => {
    const tmpfiles = job({ relative: true, everySec: 86_400, lastStart: at(12, 10, 42) });
    expect(nextRun(tmpfiles, NOW)).toEqual({
      at: at(12, 10, 42) + 86_400,
      about: false,
      windowSec: 0,
    });
    expect(nextRun({ ...tmpfiles, randomDelaySec: 600 }, NOW)).toMatchObject({
      about: true,
      windowSec: 600,
    });
    // Never ran since the agent started: no next yet; old agents send no interval.
    expect(nextRun({ ...tmpfiles, lastStart: null }, NOW)).toBeNull();
    expect(nextRun({ ...tmpfiles, everySec: 0 }, NOW)).toBeNull();
  });

  it('a randomized delay: the earliest time and the window', () => {
    // dpkg-db-backup-like: daily at 00:00, RandomizedDelaySec=4h.
    expect(nextRun(job({ nextAt: at(24, 0), everySec: 0, randomDelaySec: 4 * HOUR }), NOW)).toEqual(
      { at: at(24, 0), about: false, windowSec: 4 * HOUR },
    );
  });

  it('disabled timers, cron lines with no daemon and suspended CronJobs have none', () => {
    expect(nextRun(job({ enabled: false, nextAt: at(15, 0) }), NOW)).toBeNull();
    expect(
      nextRun(job({ state: 'disabled', everySec: 1800, lastStart: at(14, 9) }), NOW),
    ).toBeNull();
  });

  it('no period and nothing reported: none (a timer that waits for boot)', () => {
    expect(nextRun(job({ nextAt: at(13, 0) }), NOW)).toBeNull();
  });
});

describe('nextRuns', () => {
  it('the first from nextRun, then one period apart, within the window', () => {
    const r = nextRuns(job({ nextAt: at(14, 39), everySec: 1800 }), NOW, at(17, 33));
    expect(r).toEqual([at(14, 39), at(15, 9), at(15, 39), at(16, 9), at(16, 39), at(17, 9)]);
    // The same first run as nextRun, always.
    expect(r[0]).toBe(nextRun(job({ nextAt: at(14, 39), everySec: 1800 }), NOW)!.at);
  });

  it('chaos-release while running gets its dashed marks too', () => {
    const r = nextRuns(
      job({ state: 'running', everySec: 3598, lastStart: at(14, 25, 2) }),
      NOW,
      at(17, 33),
    );
    expect(r).toEqual([at(15, 25, 2), at(16, 25, 2), at(17, 25, 2)]);
  });

  it('none past the window, none for a job that does not run', () => {
    expect(nextRuns(job({ nextAt: at(24, 0) }), NOW, at(17, 33))).toEqual([]);
    expect(nextRuns(job({ enabled: false, nextAt: at(15, 0) }), NOW, at(17, 33))).toEqual([]);
  });
});
