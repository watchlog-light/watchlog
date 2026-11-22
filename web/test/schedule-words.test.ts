// SPDX-License-Identifier: AGPL-3.0-only
// Schedules in words (0.13.1): systemd's normalised OnCalendar and cron's five fields read the
// same way, with ranges, steps, lists, weekdays and month days; what can't be said stays raw.
import { describe, expect, it } from 'vitest';
import { createAppI18n } from '@/i18n';
import { RAW, scheduleWords } from '@/lib/schedule-words';

const i18n = createAppI18n();
const say = (spec: string) => {
  const w = scheduleWords(spec);
  expect(i18n.global.te(w.key), w.key).toBe(true);
  return i18n.global.t(w.key, w.values ?? {}, Number(w.values?.n ?? 1));
};

const TABLE: [string, string][] = [
  // systemd OnCalendar, as systemd normalises it
  ['*-*-* *:09,39:00', 'Every hour at :09 and :39'],
  ['*-*-* 01/2:50:00', 'Every 2 hours at :50, from 01:50'],
  ['Sun *-*-* 03:10:00', 'Sundays at 03:10'],
  ['*-*-* 06,18:00:00', 'Daily at 06:00 and 18:00'],
  ['Mon..Fri *-*-* 18:00:00', 'Weekdays at 18:00'],
  ['*-*-* 03:00:00', 'Daily at 03:00'],
  ['*-*-* 00:00:00', 'Daily at 00:00'],
  ['*-*-* *:25:00', 'Every hour at :25'],
  ['*-*-* *:00:00', 'Every hour at :00'],
  ['*-*-* *:0/15:00', 'Every 15 minutes'],
  ['*-*-* *:*:00', 'Every minute'],
  ['*-*-* 0/6:30:00', 'Every 6 hours at :30'],
  ['Sat,Sun *-*-* 10:00:00', 'Weekends at 10:00'],
  ['Mon,Thu *-*-* 07:30:00', 'Mondays and Thursdays at 07:30'],
  ['*-*-01 04:00:00', 'Monthly on day 1 at 04:00'],
  ['*-*-01,15 02:00:00', 'Monthly on days 1 and 15 at 02:00'],
  ['*-01-01 00:00:00', 'Every year on 1 January at 00:00'],
  ['Mon..Fri *-*-* 09..17:00:00', 'Every hour at :00, 09:00–17:00 on weekdays'],
  ['Mon *-*-* 00:00:00', 'Mondays at 00:00'],
  ['*-*-* 00,12:00:00', 'Daily at 00:00 and 12:00'],
  ['weekly', 'Mondays at 00:00'],
  // cron
  ['09,39 * * * *', 'Every hour at :09 and :39'],
  ['*/10 * * * *', 'Every 10 minutes'],
  ['* * * * *', 'Every minute'],
  ['5 * * * *', 'Every hour at :05'],
  ['0 4 * * *', 'Daily at 04:00'],
  ['30 3 * * 0', 'Sundays at 03:30'],
  ['30 3 * * 7', 'Sundays at 03:30'],
  ['0 18 * * 1-5', 'Weekdays at 18:00'],
  ['0 18 * * mon-fri', 'Weekdays at 18:00'],
  ['15 2 1 * *', 'Monthly on day 1 at 02:15'],
  ['50 1-23/2 * * *', 'Every 2 hours at :50, from 01:50'],
  ['0 */4 * * *', 'Every 4 hours at :00'],
  ['0 6,18 * * *', 'Daily at 06:00 and 18:00'],
  ['0 9-17 * * 1-5', 'Every hour at :00, 09:00–17:00 on weekdays'],
  ['*/5 * * * 6,0', 'Every 5 minutes on weekends'],
  ['@daily', 'Daily at 00:00'],
  ['@hourly', 'Every hour at :00'],
  ['CRON_TZ=Europe/Berlin 0 3 * * *', 'Daily at 03:00'],
  ['after boot or its last run', 'After boot, then after each run'],
];

describe('scheduleWords', () => {
  it.each(TABLE)('%s → %s', (spec, words) => {
    expect(say(spec)).toBe(words);
  });

  it('has at least 25 forms across systemd and cron', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(25);
  });

  it('several OnCalendar specs read one after the other', () => {
    expect(say('*-*-* 06:00:00; Sat *-*-* 12:00:00')).toBe('Daily at 06:00; Saturdays at 12:00');
  });

  it('what it cannot say stays raw (shown in monospace)', () => {
    for (const spec of [
      '*-*-* 01,03,07,11,20:00:00', // 5 uneven times a day
      '2026-12-24 18:00:00', // one year
      '*-*-* 03:00:30', // seconds
      '0 4 1 * 1', // day of month and weekday together
      '0 0 1 6,12 *', // two months
      'nonsense',
    ]) {
      const w = scheduleWords(spec);
      expect(w.key, spec).toBe(RAW);
      expect(w.values?.spec).toBe(spec);
    }
  });
});
