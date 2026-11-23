// SPDX-License-Identifier: AGPL-3.0-only
// The licence's units and the 30-day rule (ADR-232), and the Owners' banners, on generated
// days and a clock: never waiting on time.
import { describe, expect, it } from 'vitest';
import { bannersOf, licenseView } from '../src/modules/license/status.js';
import { OVER_LIMIT_DAYS, unitsState, type DayCount } from '../src/modules/license/units.js';
import type { CurrentLicense } from '../src/modules/license/service.js';

const DAY = 86_400_000;
const TODAY = Date.parse('2027-05-20T10:00:00Z');

/** Days oldest first, ending today, from a list of counts. */
function days(counts: number[]): DayCount[] {
  return counts.map((units, i) => ({
    day: new Date(TODAY - (counts.length - 1 - i) * DAY).toISOString().slice(0, 10),
    units,
    parts: { nodes: units, servers: 0 },
  }));
}

describe('units', () => {
  it("the licence's count is the highest daily count of the last 7 days", () => {
    const s = unitsState(days([90, 90, 10, 12, 30, 14, 11, 12, 13]), 50);
    expect(s.used).toBe(30);
    expect(s.peak?.day).toBe(new Date(TODAY - 4 * DAY).toISOString().slice(0, 10));
    expect(s.over).toBe(false);
    expect(s.overSince).toBeNull();
  });

  it('over the limit: at once, and the run counted back to the first day over', () => {
    const s = unitsState(days([40, 48, 58, 57, 58]), 50);
    expect(s).toMatchObject({ used: 58, over: true, overDays: 3, closedSince: null });
    expect(s.overSince).toBe(new Date(TODAY - 2 * DAY).toISOString().slice(0, 10));
  });

  it("today under the limit doesn't end the run yet: it is still being counted", () => {
    const s = unitsState(days([40, 58, 58, 12]), 50);
    expect(s).toMatchObject({ over: true, overDays: 2 });
  });

  it('30 days over in a row: closed to new places from the 31st day; a pause starts it over', () => {
    const over29 = unitsState(days([40, ...Array(29).fill(60)]), 50);
    expect(over29).toMatchObject({ overDays: 29, closedSince: null });
    const over30 = unitsState(days([40, ...Array(OVER_LIMIT_DAYS).fill(60)]), 50);
    expect(over30.overDays).toBe(30);
    expect(over30.closedSince).toBe(new Date(TODAY + DAY).toISOString().slice(0, 10));
    const over35 = unitsState(days([40, ...Array(35).fill(60)]), 50);
    expect(over35.closedSince).toBe(new Date(TODAY - 4 * DAY).toISOString().slice(0, 10));
    // One day at the limit in the middle: the run starts after it.
    const paused = unitsState(days([...Array(20).fill(60), 50, ...Array(15).fill(60)]), 50);
    expect(paused).toMatchObject({ overDays: 15, closedSince: null });
    // Back under for a week: not over, nothing closed.
    const back = unitsState(days([...Array(40).fill(60), ...Array(8).fill(10)]), 50);
    expect(back).toMatchObject({ over: false, overDays: 0, closedSince: null });
  });

  it('no data: nothing used', () => {
    expect(unitsState([], 50)).toMatchObject({ used: 0, over: false, peak: null });
  });
});

function current(state: string, expiresAt: number, units = 50): CurrentLicense {
  return {
    source: 'setting',
    shadowed: false,
    check: {
      state: state as never,
      reason: 'x',
      payload: {
        v: 1,
        id: '00000000-0000-4000-8000-000000000001',
        customer: 'Acme',
        edition: 'enterprise',
        units,
        features: ['pro'],
        issuedAt: new Date(expiresAt - 365 * DAY).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      },
      graceEndsAt: new Date(expiresAt + 14 * DAY).toISOString(),
    },
  };
}
const fine = unitsState(days([10, 12]), 50);
const over = unitsState(days([10, 58]), 50);

describe('banners', () => {
  it('valid and within the limit: none', () => {
    expect(bannersOf(licenseView(current('valid', TODAY + 100 * DAY), fine), TODAY)).toEqual([]);
  });
  it('expiring: the end date and the days left', () => {
    expect(bannersOf(licenseView(current('expiring', TODAY + 12 * DAY), fine), TODAY)).toEqual([
      { kind: 'expiring', endsOn: '2027-06-01', days: 12 },
    ]);
  });
  it('grace: when it ended and when features stop', () => {
    expect(bannersOf(licenseView(current('grace', TODAY - 3 * DAY), fine), TODAY)).toEqual([
      { kind: 'grace', endedOn: '2027-05-17', stopsOn: '2027-05-31' },
    ]);
  });
  it('ended: one banner, over the limit no longer said', () => {
    expect(bannersOf(licenseView(current('expired', TODAY - 20 * DAY), over), TODAY)).toEqual([
      { kind: 'ended', endedOn: '2027-04-30' },
    ]);
  });
  it('over the limit: used of allowed; closed after 30 days', () => {
    expect(bannersOf(licenseView(current('valid', TODAY + 100 * DAY), over), TODAY)).toEqual([
      { kind: 'over', used: 58, limit: 50, closedSince: null },
    ]);
    const closed = unitsState(days([...Array(32).fill(60)]), 50);
    expect(
      bannersOf(licenseView(current('valid', TODAY + 100 * DAY), closed), TODAY)[0],
    ).toMatchObject({
      kind: 'over',
      closedSince: closed.closedSince,
    });
  });
  it('an invalid key: its reason', () => {
    const v = licenseView(
      {
        source: 'env',
        shadowed: false,
        check: {
          state: 'invalid',
          reason: "the signature doesn't match a WatchLog key",
          payload: null,
          graceEndsAt: null,
        },
      },
      null,
    );
    expect(bannersOf(v, TODAY)).toEqual([
      { kind: 'invalid', reason: "the signature doesn't match a WatchLog key" },
    ]);
  });
});
