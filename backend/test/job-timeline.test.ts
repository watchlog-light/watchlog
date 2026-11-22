// SPDX-License-Identifier: AGPL-3.0-only
// The Scheduled jobs page's run timeline (0.13.0): every job's runs over 6 h, 24 h or 7 days in
// one answer, one value per slot (the worst run of the slot wins), a frequent job's slots from
// its hourly counts, its missed run, and the next runs from its schedule. On an injected clock.
import { describe, expect, it } from 'vitest';
import {
  jobStrip,
  TIMELINE_RANGES,
  TIMELINE_SLOTS,
  type TimelineJobInput,
} from '../src/modules/certs-jobs/service.js';

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0) / 1000;
const MIN = 60;
const HOUR = 3600;
const job = (over: Partial<TimelineJobInput>): TimelineJobInput => ({
  id: 'a1b2c3d4e5f60718',
  node: '',
  frequent: false,
  usualSeconds: 60,
  nextAt: null,
  everySec: 0,
  missedAt: null,
  enabled: true,
  runs: [],
  hours: [],
  ...over,
});
const run = (start: number, seconds: number, result = 'success', code: number | null = 0) => ({
  start,
  end: start + seconds,
  code,
  result,
});
// 24 h: 21 h past + 3 h ahead over 96 slots, 15 minutes each.
const SLOT = (TIMELINE_RANGES['24h'].past + TIMELINE_RANGES['24h'].future) / TIMELINE_SLOTS;
const slotOf = (t: number) => Math.floor((t - (NOW - TIMELINE_RANGES['24h'].past)) / SLOT);

describe('jobStrip', () => {
  it('keeps the worst run of a slot: failed beats fine, and counts them all', () => {
    const t = NOW - 2 * HOUR; // a slot boundary: 19 h into the past range
    const s = jobStrip(
      job({ runs: [run(t, 30), run(t + 5 * MIN, 30, 'failed', 137), run(t + 10 * MIN, 30)] }),
      '24h',
      NOW,
    );
    expect(s.slots).toEqual([
      { i: slotOf(t), result: 'failed', at: t + 5 * MIN, seconds: 30, code: 137, runs: 3 },
    ]);
    expect([s.runs, s.failures]).toEqual([3, 1]);
  });

  it('a run far slower than usual is slow (3× and 5 min more); unknown and running too', () => {
    const s = jobStrip(
      job({
        usualSeconds: 120,
        runs: [
          run(NOW - 10 * HOUR, 900), // 7.5× and 13 min more: slow
          run(NOW - 9 * HOUR, 300), // 2.5×: fine
          { start: NOW - 8 * HOUR, end: null, code: null, result: 'unknown' }, // cron's log only
          { start: NOW - 5 * MIN, end: null, code: null, result: 'running' },
        ],
      }),
      '24h',
      NOW,
    );
    expect(s.slots.map((x) => x.result)).toEqual(['slow', 'success', 'unknown', 'running']);
    // A running one isn't counted as a run yet.
    expect(s.runs).toBe(3);
  });

  it('a frequent job (every minute) fills the slots of each hour from its counts', () => {
    const hour = NOW - 3 * HOUR;
    const s = jobStrip(
      job({
        frequent: true,
        hours: [
          { hour, runs: 60, failures: 0, longestSeconds: 2 },
          { hour: hour + HOUR, runs: 60, failures: 4, longestSeconds: 3 },
        ],
      }),
      '24h',
      NOW,
    );
    expect(s.slots).toHaveLength(8); // two hours of 15-minute slots
    expect(s.slots.slice(0, 4).every((x) => x.result === 'success')).toBe(true);
    expect(s.slots.slice(4).every((x) => x.result === 'failed')).toBe(true);
    expect([s.runs, s.failures]).toEqual([120, 4]);
  });

  it('a missed run is marked, and wins its slot', () => {
    const missed = NOW - 6 * HOUR;
    const s = jobStrip(job({ missedAt: missed, runs: [run(missed + MIN, 10)] }), '24h', NOW);
    expect(s.slots).toEqual([
      { i: slotOf(missed), result: 'missed', at: missed, seconds: null, code: null, runs: 1 },
    ]);
  });

  it('the next runs come from the next time and the period, one per slot, within the range', () => {
    // Every 10 minutes, next at 12:05: 18 runs in the 3 h ahead, but slots are 15 minutes.
    const s = jobStrip(job({ nextAt: NOW + 5 * MIN, everySec: 10 * MIN }), '24h', NOW);
    expect(s.next[0]).toBe(NOW + 5 * MIN);
    expect(s.next.length).toBe(12);
    expect(s.next.every((t) => t > NOW && t <= NOW + 3 * HOUR)).toBe(true);
    expect(new Set(s.next.map(slotOf)).size).toBe(s.next.length);
    // A disabled timer has no next run; nor does one with no next time.
    expect(jobStrip(job({ nextAt: NOW + HOUR, enabled: false }), '24h', NOW).next).toEqual([]);
    // Daily at 03:00 on a 6 h range (5 h back, 1 h ahead): nothing ahead.
    expect(jobStrip(job({ nextAt: NOW + 15 * HOUR, everySec: 86400 }), '6h', NOW).next).toEqual([]);
  });

  it('runs before the range or in the future are left out', () => {
    const s = jobStrip(job({ runs: [run(NOW - 30 * HOUR, 10), run(NOW + HOUR, 10)] }), '24h', NOW);
    expect(s.slots).toEqual([]);
    expect(s.runs).toBe(0);
  });
});
