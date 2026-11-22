// SPDX-License-Identifier: AGPL-3.0-only
// A schedule in words (0.13.1, ADR-230 amended): systemd's OnCalendar as systemd normalised it
// ("*-*-* *:09,39:00", "Mon..Fri *-*-* 18:00:00") and cron's five fields ("09,39 * * * *") read
// the same way: "Every hour at :09 and :39", "Weekdays at 18:00". What it can't put in words
// comes back as `raw`, shown in monospace; the expression is always the tooltip.
import en from '@/i18n/en.json';

export interface Words {
  key: string;
  values?: Record<string, string | number>;
}

/** The key the raw expression comes back with (the page shows it in monospace). */
export const RAW = 'jobs.when.raw';
const raw = (spec: string): Words => ({ key: RAW, values: { spec } });

/** A field: any value, a list of values, or every `step` from `from`. */
type Field =
  { any: true } | { any: false; values: number[] } | { any: false; from: number; step: number };

const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DAY_NUM: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const list = (items: string[]) =>
  new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(items);

/** One element's value: a number, a day or month name. */
function value(v: string, names?: Record<string, number>): number | null {
  if (/^\d+$/.test(v)) return Number(v);
  const n = names?.[v.slice(0, 3).toLowerCase()];
  return n === undefined ? null : n;
}

/**
 * A field in either syntax: "*", "5", "1,15", "1-5" / "1..5", "*\/15" / "0/15", "1-10/2".
 * `max` bounds expanded ranges; `wrap7` maps cron's 7 to Sunday.
 */
function field(
  f: string,
  max: number,
  names?: Record<string, number>,
  wrap7 = false,
): Field | null {
  if (f === '*') return { any: true };
  const step = /^(\*|\d+)\/(\d+)$/.exec(f);
  if (step) {
    const n = Number(step[2]);
    if (!n) return null;
    return { any: false, from: step[1] === '*' ? 0 : Number(step[1]), step: n };
  }
  const out = new Set<number>();
  for (const part of f.split(',')) {
    const r = /^([^-./]+)(?:(?:-|\.\.)([^/]+))?(?:\/(\d+))?$/.exec(part);
    if (!r) return null;
    const a = value(r[1]!, names);
    const b = r[2] !== undefined ? value(r[2], names) : a;
    const by = r[3] ? Number(r[3]) : 1;
    if (a === null || b === null || !by || b < a || b > max) return null;
    for (let x = a; x <= b; x += by) out.add(wrap7 && x === 7 ? 0 : x);
  }
  return { any: false, values: [...out].sort((x, y) => x - y) };
}

const valuesOf = (f: Field): number[] | null => ('values' in f ? f.values : null);
const single = (f: Field): number | null => {
  const v = valuesOf(f);
  return v && v.length === 1 ? v[0]! : null;
};

/** The parts every schedule shares, from either syntax. */
interface Parts {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

function cronParts(s: string): Parts | null {
  const f = s.split(/\s+/);
  if (f.length !== 5) return null;
  const minute = field(f[0]!, 59);
  const hour = field(f[1]!, 23);
  const dom = field(f[2]!, 31);
  const month = field(f[3]!, 12, MONTHS);
  const dow = field(f[4]!, 7, DAY_NUM, true);
  return minute && hour && dom && month && dow ? { minute, hour, dom, month, dow } : null;
}

/** systemd's normalised form: "[DOW] YYYY-MM-DD HH:MM:SS" with "*" for any. */
function systemdParts(s: string): Parts | null {
  const m = /^(?:([A-Za-z.,]+) )?([^ ]+)-([^ -]+)-([^ ]+) ([^ :]+):([^ :]+)(?::([^ ]+))?$/.exec(s);
  if (!m) return null;
  const [, wd, year, mon, day, h, mi, sec] = m;
  if (year !== '*' || (sec !== undefined && !/^0+$/.test(sec))) return null;
  const dow = wd ? field(wd, 6, DAY_NUM) : { any: true as const };
  const month = field(mon!, 12);
  const dom = field(day!, 31);
  const hour = field(h!, 23);
  const minute = field(mi!, 59);
  return minute && hour && dom && month && dow ? { minute, hour, dom, month, dow } : null;
}

/** The day part: every day, weekdays, Sundays, Mondays and Thursdays, day 1 of each month. */
function days(p: Parts): { key: string; values?: Record<string, string | number> } | null {
  if (!p.month.any) {
    const mon = single(p.month);
    const day = single(p.dom);
    if (mon !== null && day !== null && p.dow.any)
      return { key: 'yearly', values: { day, month: en.jobs.when.months[mon - 1]! } };
    return null;
  }
  if (!p.dom.any) {
    const d = valuesOf(p.dom);
    if (!d || !p.dow.any) return null;
    return { key: 'monthly', values: { days: list(d.map(String)), n: d.length } };
  }
  if (p.dow.any) return { key: 'daily' };
  const w = valuesOf(p.dow);
  if (!w) return null;
  const k = w.join(',');
  if (k === '1,2,3,4,5') return { key: 'weekdays' };
  if (k === '0,6') return { key: 'weekends' };
  return {
    key: 'on',
    values: { days: list(w.map((d) => en.jobs.when.dayNames[DAYS[d]!])) },
  };
}

/** The times of day, when there are a few: "06:00 and 18:00". */
function times(hours: number[], minutes: number[]): string | null {
  const all = hours.flatMap((h) => minutes.map((m) => `${pad(h)}:${pad(m)}`));
  return all.length <= 4 ? list(all) : null;
}

function describe(p: Parts): Words | null {
  const d = days(p);
  if (!d) return null;
  // "on weekdays", "on Sundays" after an hourly form; nothing for every day.
  const suffix =
    d.key === 'daily'
      ? ''
      : d.key === 'weekdays'
        ? en.jobs.when.suffix.weekdays
        : d.key === 'weekends'
          ? en.jobs.when.suffix.weekends
          : d.key === 'on'
            ? en.jobs.when.suffix.on.replace('{days}', String(d.values!.days))
            : null;
  const mins = valuesOf(p.minute);
  // Every N minutes: "*-*-* *:0/15:00", "*/15 * * * *".
  if (p.hour.any && 'step' in p.minute && p.minute.from === 0) {
    if (suffix === null) return null;
    return { key: 'jobs.when.everyMinutes', values: { n: p.minute.step, on: suffix } };
  }
  if (p.hour.any && p.minute.any) {
    if (suffix === null) return null;
    return { key: 'jobs.when.everyMinutes', values: { n: 1, on: suffix } };
  }
  // Every hour at :09 and :39.
  if (p.hour.any && mins) {
    if (suffix === null) return null;
    return {
      key: 'jobs.when.hourlyAt',
      values: { mins: list(mins.map((m) => `:${pad(m)}`)), on: suffix },
    };
  }
  // Every 2 hours at :50, from 01:50.
  if ('step' in p.hour && mins && mins.length === 1) {
    if (suffix === null) return null;
    const m = pad(mins[0]!);
    if (p.hour.step === 1)
      return { key: 'jobs.when.hourlyAt', values: { mins: `:${m}`, on: suffix } };
    return p.hour.from === 0
      ? { key: 'jobs.when.everyHours', values: { n: p.hour.step, min: m, on: suffix } }
      : {
          key: 'jobs.when.everyHoursFrom',
          values: { n: p.hour.step, min: m, from: `${pad(p.hour.from)}:${m}`, on: suffix },
        };
  }
  const hours = valuesOf(p.hour);
  if (!hours || !mins) return null;
  // cron's "1-23/2" is a list here: read an even step to the day's end as the step it is.
  const gap = hours.length > 2 ? hours[1]! - hours[0]! : 0;
  if (
    gap > 1 &&
    mins.length === 1 &&
    hours.every((h, i) => i === 0 || h - hours[i - 1]! === gap) &&
    hours[hours.length - 1]! + gap > 23
  ) {
    return describe({ ...p, hour: { any: false, from: hours[0]!, step: gap } });
  }
  // Every hour at :00, 09:00–17:00 (a run of hours).
  const run = hours.length > 4 && hours.every((h, i) => i === 0 || h === hours[i - 1]! + 1);
  if (run && mins.length <= 2 && suffix !== null) {
    return {
      key: 'jobs.when.hourlyBetween',
      values: {
        mins: list(mins.map((m) => `:${pad(m)}`)),
        from: `${pad(hours[0]!)}:${pad(mins[0]!)}`,
        to: `${pad(hours[hours.length - 1]!)}:${pad(mins[mins.length - 1]!)}`,
        on: suffix,
      },
    };
  }
  const at = times(hours, mins);
  if (!at) return null;
  return { key: `jobs.when.${d.key}`, values: { ...(d.values ?? {}), at } };
}

const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  // systemd's shorthands, should a spec arrive unnormalised.
  minutely: '*-*-* *:*:00',
  hourly: '*-*-* *:00:00',
  daily: '*-*-* 00:00:00',
  weekly: 'Mon *-*-* 00:00:00',
  monthly: '*-*-01 00:00:00',
  yearly: '*-01-01 00:00:00',
  annually: '*-01-01 00:00:00',
};

/** One spec in words, or null. */
function one(spec: string): Words | null {
  const s = MACROS[spec] ?? spec;
  const p = cronParts(s) ?? systemdParts(s);
  return p ? describe(p) : null;
}

/**
 * A schedule in words. Several OnCalendar specs (the agent joins them with "; ") read one after
 * the other when each can be said; anything else comes back raw.
 */
export function scheduleWords(spec: string): Words {
  const s = spec.trim().replace(/^(CRON_TZ|TZ)=\S+\s+/, '');
  if (!s) return raw(s);
  if (s === 'after boot or its last run') return { key: 'jobs.when.relative' };
  const specs = s.split(/;\s*/);
  const words = specs.map(one);
  if (words.some((w) => w === null)) return raw(s);
  if (words.length === 1) return words[0]!;
  return { key: 'jobs.when.several', values: { list: words.map((w) => fill(w!)).join('; ') } };
}

/** A Words in English, as vue-i18n would say it (for several specs read as one line). */
function fill(w: Words): string {
  const path = w.key.split('.');
  let t: unknown = en;
  for (const k of path) t = (t as Record<string, unknown>)[k];
  const forms = String(t).split(' | ');
  const n = Number(w.values?.n ?? 1);
  const form =
    forms.length === 3
      ? forms[n === 0 ? 0 : n === 1 ? 1 : 2]
      : forms[n === 1 ? 0 : forms.length - 1];
  return form!.replace(/\{(\w+)\}/g, (_, k: string) => String(w.values?.[k] ?? ''));
}
