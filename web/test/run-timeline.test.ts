// SPDX-License-Identifier: AGPL-3.0-only
// The run timeline's lanes (0.13.0, ADR-230): slots to marks, the next runs as their own marks,
// problems first then the soonest next run, the "now" line and the ticks, on an injected clock.
import type { JobTimeline, ScheduledJob } from '@watchlog/api-types';
import { describe, expect, it } from 'vitest';
import { laneWords, markWords, nowPct, runLanes, runTicks } from '@/lib/run-timeline';

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0) / 1000;
const HOUR = 3600;
// 24 h: 21 h past and 3 h ahead, 96 slots of 15 minutes.
const tl = (jobs: JobTimeline['jobs']): JobTimeline => ({
  range: '24h',
  now: NOW,
  from: NOW - 21 * HOUR,
  to: NOW + 3 * HOUR,
  slots: 96,
  jobs,
});
const job = (name: string, state: string, over: Partial<ScheduledJob> = {}): ScheduledJob =>
  ({
    id: `${name}-id`,
    node: 'worker-1',
    name,
    kind: 'timer',
    state,
    nextAt: null,
    ...over,
  }) as ScheduledJob;
const lane = (name: string, over: Partial<JobTimeline['jobs'][number]> = {}) => ({
  id: `${name}-id`,
  node: 'worker-1',
  slots: [],
  next: [],
  runs: 0,
  failures: 0,
  ...over,
});

describe('runLanes', () => {
  it('turns slots and next runs into marks at their place', () => {
    const [l] = runLanes(
      [job('backup.service', 'working')],
      tl([
        lane('backup.service', {
          slots: [{ i: 12, result: 'failed', at: NOW - 18 * HOUR, seconds: 40, code: 2, runs: 1 }],
          next: [NOW + 2 * HOUR],
          runs: 1,
          failures: 1,
        }),
      ]),
    );
    expect(l!.marks.map((m) => [m.kind, m.left])).toEqual([
      ['failed', 12.5],
      ['next', (92 / 96) * 100], // 23 h of 24: slot 92
    ]);
    expect(l!.next).toBe(NOW + 2 * HOUR);
  });

  it('orders problems first (failing, missed, slow), then the soonest next run, then name', () => {
    const jobs = [
      job('later.timer', 'working', { nextAt: NOW + 5 * HOUR }),
      job('soon.timer', 'working', { nextAt: NOW + HOUR }),
      job('slow.timer', 'slow'),
      job('broken.timer', 'failed'),
      job('missed.timer', 'missed'),
      job('idle.timer', 'disabled'),
    ];
    expect(runLanes(jobs, tl([])).map((l) => l.job.name)).toEqual([
      'broken.timer',
      'missed.timer',
      'slow.timer',
      'soon.timer',
      'later.timer',
      'idle.timer',
    ]);
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
    // UTC+5:30: ticks fall on that zone's whole 3 hours.
    const ist = runTicks(tl([]), '24h', 330);
    expect(((ist[0]!.at + 330 * 60) % (3 * HOUR)) / 60).toBe(0);
    const week = { from: NOW - 6 * 86400, to: NOW + 86400 };
    expect(runTicks(week, '7d', 0).every((x) => x.at % 86400 === 0)).toBe(true);
  });

  it('says each mark and each lane in words', () => {
    const t = (k: string, v: Record<string, unknown> = {}) => `${k}${JSON.stringify(v)}`;
    const words = markWords(
      { kind: 'failed', left: 0, width: 1, at: NOW, seconds: 40, code: 137, runs: 1 },
      () => '12:00',
      (s) => `${s} s`,
      t,
    );
    expect(words).toBe(
      '12:00 · runTimeline.result.failed{} · runTimeline.exitCode{"code":137} · 40 s',
    );
    const [l] = runLanes(
      [job('backup.service', 'failed')],
      tl([
        lane('backup.service', {
          slots: [{ i: 3, result: 'failed', at: NOW - 20 * HOUR, seconds: 4, code: 1, runs: 1 }],
          runs: 5,
          failures: 1,
        }),
      ]),
    );
    const text = laneWords(l!, 'backup.service · worker-1', '24 h', () => '16:00', t);
    expect(text).toContain('runTimeline.a11y.lane{"name":"backup.service · worker-1"');
    expect(text).toContain('runTimeline.a11y.failed{"n":1,"when":"16:00"}');
  });
});
