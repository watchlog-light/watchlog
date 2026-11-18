// SPDX-License-Identifier: AGPL-3.0-only
// When What changed is ready (ADR-217), as pure functions: no database, no clock. The rule
// the worker scores with and the page reports: every hour of the week learned once since a
// series was first seen, and never before 7 days. The replays against the worker's jobs are
// in what-changed-learning.test.ts.
import { describe, expect, it } from 'vitest';
import {
  RECOMPUTE_LAG_MS,
  allSettled,
  clusterReady,
  coverageFromBaselines,
  emptyCoverage,
  estimateReady,
  estimateSeriesReady,
  learnedHours,
  learningDay,
  recordLook,
  resumedAt,
  seriesReady,
  weekString,
  type Coverage,
} from '../src/modules/anomaly/coverage.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Learning starts on a Wednesday at 14:10 UTC. */
const START = Date.UTC(2026, 10, 18, 14, 10, 0);
const FIRST = Date.UTC(2026, 10, 18, 14, 0, 0);
const slot = (ms: number) => new Date(ms).getUTCDay() * 24 + new Date(ms).getUTCHours();

/** The worker's hourly runs from `from` to `to` (each 5 minutes after its hour ends). */
function learn(
  c: Coverage,
  from: number,
  to: number,
  data: (hour: number) => number | null = () => 5,
) {
  let out = c;
  for (let h = from; h < to; h += HOUR) out = recordLook(out, h, data(h), h + HOUR + 5 * MIN);
  return out;
}
const fresh = (): Coverage => ({ ...emptyCoverage(), firstSeen: START });

describe('a week without a gap', () => {
  it('is ready 7 days after the first series, to the minute, and not a look earlier', () => {
    let c = learn(fresh(), FIRST, FIRST + 7 * DAY - HOUR);
    expect(learnedHours(c)).toBe(167);
    expect(learningDay(c)).toBe(7);
    expect(c.readyAt).toBeNull();
    expect(allSettled(c)).toBe(false);
    expect(estimateReady(c, FIRST + 7 * DAY - 30 * MIN)).toBe(START + 7 * DAY);
    c = learn(c, FIRST + 7 * DAY - HOUR, FIRST + 7 * DAY);
    // The last hour was learned at 14:05; the first series is 7 days old at 14:10.
    expect(c.readyAt).toBe(START + 7 * DAY);
    expect(clusterReady(c, START + 7 * DAY - MIN)).toBe(false);
    expect(seriesReady(c, START, START + 7 * DAY - MIN)).toBe(false);
    expect(seriesReady(c, START, START + 7 * DAY)).toBe(true);
    expect(c.resumedAt).toBeNull();
    expect(weekString(c)).toBe('1'.repeat(168));
  });

  it('counts a day for every 24 hours learned, and an hour looked at twice only once', () => {
    let c = learn(fresh(), FIRST, FIRST + 3 * HOUR);
    expect([learnedHours(c), learningDay(c)]).toEqual([3, 1]);
    // The hourly job is idempotent: a restart recomputes the same hour.
    const again = recordLook(c, FIRST + 2 * HOUR, 5, FIRST + 4 * HOUR);
    expect(again).toEqual(c);
    c = learn(c, FIRST + 3 * HOUR, FIRST + 2 * DAY + 13 * HOUR);
    expect([learnedHours(c), learningDay(c)]).toEqual([61, 3]);
  });
});

describe('gaps', () => {
  it('hours the worker did not look at (the org off Pro) are not learned; what it learned before counts; it says when it resumed', () => {
    // A day of Pro, two days off, Pro again.
    let c = learn(fresh(), FIRST, FIRST + DAY);
    const back = FIRST + 3 * DAY;
    // Before it resumes: the gap's last hour comes round a week later.
    const ready = FIRST + 10 * DAY + RECOMPUTE_LAG_MS;
    expect(estimateReady(c, back + 10 * MIN)).toBe(ready);
    c = learn(c, back, FIRST + 7 * DAY);
    expect(c.resumedAt).toBe(back);
    expect([learnedHours(c), learningDay(c)]).toEqual([120, 6]);
    // 7 days on the calendar: not ready, by the worker or by the page.
    expect(c.readyAt).toBeNull();
    expect(seriesReady(c, START, START + 7 * DAY + HOUR)).toBe(false);
    expect(estimateReady(c, START + 7 * DAY)).toBe(ready);
    // A week on, the looks are one run again; what was recorded stays until it is ready.
    const almost = learn(c, FIRST + 7 * DAY, FIRST + 10 * DAY - HOUR);
    expect(resumedAt(almost)).toBeNull();
    expect(almost.resumedAt).toBe(back);
    c = learn(c, FIRST + 7 * DAY, FIRST + 10 * DAY);
    expect(c.readyAt).toBe(FIRST + 10 * DAY + 5 * MIN);
    expect(seriesReady(c, START, FIRST + 10 * DAY + 5 * MIN)).toBe(true);
  });

  it('an hour with no data is looked at but not learned; twice with none settles it', () => {
    const quiet = FIRST + 3 * DAY + 19 * HOUR;
    const off = (h: number) => (slot(h) === slot(quiet) ? null : 5);
    let c = learn(fresh(), FIRST, FIRST + 7 * DAY, off);
    expect(learnedHours(c)).toBe(167);
    expect(c.readyAt).toBeNull();
    expect(weekString(c)[slot(quiet)]).toBe('0');
    expect(estimateReady(c, FIRST + 7 * DAY + 10 * MIN)).toBe(
      quiet + 7 * DAY + HOUR + RECOMPUTE_LAG_MS,
    );
    // The second look finds nothing either: a silent hour, settled, not learned.
    c = learn(c, FIRST + 7 * DAY, quiet + 7 * DAY + HOUR, off);
    expect(c.readyAt).toBe(quiet + 7 * DAY + HOUR + 5 * MIN);
    expect(learnedHours(c)).toBe(167);
    expect(weekString(c)[slot(quiet)]).toBe('2');
    // Had data come the second time, it would have been learned instead.
    let d = learn(fresh(), FIRST, FIRST + 7 * DAY, off);
    d = learn(d, FIRST + 7 * DAY, quiet + 7 * DAY + HOUR);
    expect([learnedHours(d), weekString(d)[slot(quiet)]]).toEqual([168, '1']);
  });

  it('a missed recompute (the worker was down) is seen as missed a few minutes after it was due', () => {
    const c = learn(fresh(), FIRST, FIRST + 5 * HOUR);
    // The run for 19:00–20:00 is due at 20:06. At 20:07 it may still come; at 20:30 it didn't.
    const due = FIRST + 6 * HOUR + RECOMPUTE_LAG_MS;
    expect(estimateReady(c, due + MIN)).toBe(START + 7 * DAY);
    expect(estimateReady(c, due + 24 * MIN)).toBe(
      FIRST + 5 * HOUR + 7 * DAY + HOUR + RECOMPUTE_LAG_MS,
    );
  });
});

describe('a series that joins a ready cluster', () => {
  it('is scored after its own 7 days, and later if the worker missed hours meanwhile', () => {
    let c = learn(fresh(), FIRST, FIRST + 8 * DAY);
    const joined = FIRST + 8 * DAY + 40 * MIN;
    expect(seriesReady(c, joined, joined + 6 * DAY)).toBe(false);
    // Asked while the recompute of its first hour is still to come.
    expect(estimateSeriesReady(c, joined, joined + 21 * MIN)).toBe(joined + 7 * DAY);
    c = learn(c, FIRST + 8 * DAY, FIRST + 15 * DAY);
    expect(seriesReady(c, joined, joined + 7 * DAY - MIN)).toBe(false);
    expect(seriesReady(c, joined, joined + 7 * DAY)).toBe(true);
    // The cluster's own series stayed ready throughout.
    expect(seriesReady(c, START, joined + DAY)).toBe(true);
    // With two days off in its week, the new series waits for those hours to come round.
    let g = learn(fresh(), FIRST, FIRST + 10 * DAY);
    g = learn(g, FIRST + 12 * DAY, FIRST + 15 * DAY + HOUR);
    expect(seriesReady(g, joined, joined + 7 * DAY)).toBe(false);
    g = learn(g, FIRST + 15 * DAY + HOUR, FIRST + 19 * DAY);
    expect(seriesReady(g, joined, FIRST + 19 * DAY)).toBe(true);
    // The cluster itself never stopped being ready (its baselines are kept and used).
    expect(g.resumedAt).toBeNull();
    expect(seriesReady(g, START, FIRST + 12 * DAY)).toBe(true);
  });
});

describe('baselines learned before the coverage was recorded (0.8.0 to 0.9.5)', () => {
  it('WatchLog Cloud’s fleet on 18 November: 3 hours learned in two visits, ready on 25 November, not 23', () => {
    // First seen Monday 16 Nov 15:06 UTC; learned Mon 15:00 and 16:00, then nothing until
    // Wed 18 Nov 15:00 (the org had no Pro features in between); asked at 17:00.
    const first = Date.UTC(2026, 10, 16, 15, 6, 0);
    const now = Date.UTC(2026, 10, 18, 17, 0, 49);
    const hours = Array<number>(168).fill(0);
    hours[39] = 11; // Monday 15:00
    hours[40] = 11; // Monday 16:00
    hours[87] = 69; // Wednesday 15:00
    const c = coverageFromBaselines(hours, first, now);
    expect([learnedHours(c), learningDay(c)]).toEqual([3, 1]);
    expect(c.readyAt).toBeNull();
    expect(c.lookedAt[39]).toBe(Date.UTC(2026, 10, 16, 15));
    expect(c.lookedAt[87]).toBe(Date.UTC(2026, 10, 18, 15));
    // It resumed on Wednesday at 15:00, and says so although the gap is older than the record.
    expect(resumedAt(c)).toBe(Date.UTC(2026, 10, 18, 15));
    expect(c.resumedAt).toBe(Date.UTC(2026, 10, 18, 15));
    // 0.9.6 stored such a row without it: the next look fills it in, from the looks.
    const next = recordLook(
      { ...c, resumedAt: null },
      Date.UTC(2026, 10, 18, 16),
      69,
      Date.UTC(2026, 10, 18, 17, 6),
    );
    expect(next.resumedAt).toBe(Date.UTC(2026, 10, 18, 15));
    // The rule before 0.9.6: 7 days after the first sighting.
    expect(new Date(first + 7 * DAY).toISOString()).toBe('2026-11-23T15:06:00.000Z');
    // The worker's rule: the last hour it hasn't learned is Wednesday 14:00, read at 15:06.
    expect(new Date(estimateReady(c, now)).toISOString()).toBe('2026-11-25T15:06:00.000Z');
    expect(seriesReady(c, first, first + 7 * DAY)).toBe(false);
  });

  it('a cluster that was already listing goes on listing', () => {
    const first = START - 20 * DAY;
    const hours = Array<number>(168).fill(3);
    hours[5] = 0; // an hour it never has data for
    const c = coverageFromBaselines(hours, first, START);
    expect(c.readyAt).toBe(first + 7 * DAY);
    expect(clusterReady(c, START)).toBe(true);
    expect(seriesReady(c, first, START)).toBe(true);
    // A series that joined 3 days ago is still learning, as under the old rule.
    expect(seriesReady(c, START - 3 * DAY, START)).toBe(false);
    expect(seriesReady(c, START - 8 * DAY, START)).toBe(true);
  });

  it('no baselines: nothing learned, ready a week after it starts', () => {
    const c = coverageFromBaselines([], null, START);
    expect(learnedHours(c)).toBe(0);
    expect(estimateReady(c, START)).toBe(FIRST + 7 * DAY + RECOMPUTE_LAG_MS);
  });
});
