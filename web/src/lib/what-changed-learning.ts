// SPDX-License-Identifier: AGPL-3.0-only
// The learning week in the dashboard (ADR-216, ADR-217): everything the learning page, the
// upgrade page's hero, the alert card and the sidebar say about it, worked out from the API's
// answer and the viewer's time zone. The answer is the anomaly-worker's own state: which
// hours of the week it has learned, which day that makes, and when it will be ready by the
// rule it scores with. Nothing here counts days on the calendar: an hour the worker didn't
// learn (the org was off Pro, no data came) is not learned on the page either.
import type { WhatChangedLearning } from '@watchlog/api-types';

export const LEARNING_DAYS = 7;
export const WEEK_HOURS = 168;
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type Tr = (key: string, values?: Record<string, unknown>, plural?: number) => string;

// ---- the ring of 7 days around the brain (a 340 × 340 box, as the design's) ----

export type SegmentState = 'done' | 'today' | 'todo';
export interface RingSegment {
  /** The arc's path. */
  d: string;
  state: SegmentState;
  /** How much of this day's 24 hours of the week is learned, 0 to 1. */
  share: number;
  /** The weekday it stands for, short ("Wed"), in the viewer's time zone. */
  label: string;
  x: number;
  y: number;
}

const RING = { c: 170, r: 150, gap: 7, labelR: 128 };

function arc(i: number): string {
  const span = 360 / LEARNING_DAYS;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const a0 = rad(-90 + i * span + RING.gap / 2);
  const a1 = rad(-90 + (i + 1) * span - RING.gap / 2);
  const p = (a: number) =>
    `${(RING.c + RING.r * Math.cos(a)).toFixed(1)} ${(RING.c + RING.r * Math.sin(a)).toFixed(1)}`;
  return `M${p(a0)} A${RING.r} ${RING.r} 0 0 1 ${p(a1)}`;
}

/** The hour-of-week slot of a time (UTC; Sunday 00:00 is 0), as the API's `week` counts. */
const slotOf = (ms: number): number => {
  const d = new Date(ms);
  return d.getUTCDay() * 24 + d.getUTCHours();
};

function segment(i: number, startMs: number, weekday: Intl.DateTimeFormat) {
  const a = ((-90 + (i + 0.5) * (360 / LEARNING_DAYS)) * Math.PI) / 180;
  return {
    d: arc(i),
    label: weekday.format(new Date(startMs + i * DAY_MS)),
    x: Number((RING.c + RING.labelR * Math.cos(a)).toFixed(1)),
    y: Number((RING.c + 4 + RING.labelR * Math.sin(a)).toFixed(1)),
  };
}

/**
 * The ring while learning: 7 segments, each the 24 hours of the week that begin where
 * learning began (so the first is the weekday it started on). A segment is done when all its
 * 24 hours are learned, "today" when it holds the current hour, and otherwise shows the
 * share it has: a day the worker didn't learn (the org was off Pro, no data came) stays
 * empty, however long ago it was. From the API's `week`, never from the calendar.
 */
export function ringSegments(
  week: string,
  startMs: number,
  nowMs: number,
  locale = 'en',
  timeZone?: string,
): RingSegment[] {
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone });
  const first = slotOf(startMs);
  const now = slotOf(nowMs);
  return Array.from({ length: LEARNING_DAYS }, (_, i) => {
    let learned = 0;
    let current = false;
    for (let h = 0; h < 24; h++) {
      const slot = (first + i * 24 + h) % WEEK_HOURS;
      // An hour looked at twice with nothing to learn is done with, like a learned one.
      if (week[slot] === '1' || week[slot] === '2') learned++;
      if (slot === now) current = true;
    }
    return {
      ...segment(i, startMs, weekday),
      state: current ? 'today' : learned === 24 ? 'done' : 'todo',
      share: learned / 24,
    };
  });
}

/**
 * The ring on the upgrade page, where nothing is learning: every segment empty, the weekdays
 * from today. `preview` shows day 1 (the Upgrade button hovered or focused).
 */
export function waitingSegments(
  startMs: number,
  preview = false,
  locale = 'en',
  timeZone?: string,
): RingSegment[] {
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone });
  return Array.from({ length: LEARNING_DAYS }, (_, i) => ({
    ...segment(i, startMs, weekday),
    state: preview && i === 0 ? 'today' : 'todo',
    share: 0,
  }));
}

// ---- the time: which day, how long to go, when it is ready ----

/**
 * The day of learning, 1 to 7, as the worker counts it: one for every 24 hours of the week
 * it has learned. Day 1 until the answer has one.
 */
export const dayOf = (l: Pick<WhatChangedLearning, 'day'>): number => l.day ?? 1;

/**
 * The date the upgrade page promises ("Upgrade today and it's ready on…"): the worker's own
 * rule for an org that starts now and has no gap, which is 7 days of data, ready within the
 * hour after they are up. An org that returns with baselines still kept is ready sooner.
 */
export const readyIfStartedAt = (nowMs: number): number => nowMs + LEARNING_DAYS * DAY_MS + HOUR_MS;

export interface Remaining {
  days: number;
  hours: number;
  minutes: number;
}

/** The time from now to `untilMs`, in whole days, hours and minutes (never negative). */
export function remaining(untilMs: number, nowMs: number): Remaining {
  const left = Math.max(0, untilMs - nowMs);
  return {
    days: Math.floor(left / DAY_MS),
    hours: Math.floor((left % DAY_MS) / HOUR_MS),
    minutes: Math.floor((left % HOUR_MS) / MIN_MS),
  };
}

/** "4 days 11 hours", "11 hours 5 minutes", "38 minutes", "less than a minute". */
export function remainingText(r: Remaining, tr: Tr): string {
  const days = () => tr('whatChanged.learn.time.days', { n: r.days }, r.days);
  const hours = () => tr('whatChanged.learn.time.hours', { n: r.hours }, r.hours);
  const minutes = () => tr('whatChanged.learn.time.minutes', { n: r.minutes }, r.minutes);
  if (r.days > 0) return r.hours > 0 ? `${days()} ${hours()}` : days();
  if (r.hours > 0) return r.minutes > 0 ? `${hours()} ${minutes()}` : hours();
  if (r.minutes > 0) return minutes();
  return tr('whatChanged.learn.time.soon');
}

/** "Wed 25 Nov" and "14:10", in the viewer's time zone (or `timeZone`). */
export function readyParts(
  ms: number,
  locale = 'en',
  timeZone?: string,
): { date: string; time: string } {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone,
  }).formatToParts(d);
  const part = (type: string) => parts.find((x) => x.type === type)?.value ?? '';
  return {
    date: `${part('weekday')} ${part('day')} ${part('month')}`,
    time: new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    }).format(d),
  };
}

// ---- the 7 × 24 grid of hours of the week ----

/** `quiet`: the worker looked twice and there was no data: nothing to learn in that hour. */
export type CellState = 'learned' | 'now' | 'todo' | 'quiet';
export interface WeekCell {
  /** Monday is row 0, Sunday row 6. */
  row: number;
  /** The hour of the day, 0 to 23, in the viewer's time zone. */
  col: number;
  /** How it is drawn: "this hour" is drawn as now, whether or not it is learned yet. */
  state: CellState;
  /** It has a baseline (also true of "this hour" once a week has passed). */
  learned: boolean;
}

/** The viewer's offset from UTC in minutes (east is positive). */
export const viewerOffset = (at = new Date()): number => -at.getTimezoneOffset();

/** The grid's hours are the viewer's, to the nearest hour: whole hours east of UTC. */
export const offsetHours = (offsetMin: number): number => Math.round(offsetMin / 60);

/** "UTC", "UTC+1", "UTC+3:30", "UTC−5". */
export function zoneLabel(offsetMin: number): string {
  if (!offsetMin) return 'UTC';
  const abs = Math.abs(offsetMin);
  const m = abs % 60;
  return `UTC${offsetMin > 0 ? '+' : '−'}${Math.floor(abs / 60)}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/**
 * The API's week (168 characters, UTC, Sunday 00:00 first; `1` has a baseline, `2` was looked
 * at twice with no data) as the grid's
 * cells, Monday to Sunday by hour of the day in the viewer's time zone. The hour of `nowMs`
 * is "this hour"; leave `nowMs` out and no cell is (the upgrade page: nothing is learning).
 */
export function weekCells(
  week: string,
  nowMs: number | null,
  offsetMin = viewerOffset(),
): WeekCell[] {
  const shift = offsetHours(offsetMin);
  const now =
    nowMs === null
      ? -1
      : (() => {
          const d = new Date(nowMs);
          return d.getUTCDay() * 24 + d.getUTCHours();
        })();
  const cells: WeekCell[] = [];
  for (let b = 0; b < WEEK_HOURS; b++) {
    const local = (((b + shift) % WEEK_HOURS) + WEEK_HOURS) % WEEK_HOURS;
    const weekday = Math.floor(local / 24); // Sunday is 0
    cells.push({
      row: (weekday + 6) % 7,
      col: local % 24,
      state: b === now ? 'now' : week[b] === '1' ? 'learned' : week[b] === '2' ? 'quiet' : 'todo',
      learned: week[b] === '1',
    });
  }
  return cells.sort((a, b) => a.row - b.row || a.col - b.col);
}

export interface DaySummary {
  /** Monday is 0. */
  row: number;
  /** Hours of that weekday with a baseline. */
  learned: number;
  /** Their runs as hours of the day: [14, 23] is 14:00 to 23:59. */
  ranges: [number, number][];
  /** "This hour" is on this day. */
  now: number | null;
}

/** The grid as text, a weekday a line: how many of its 24 hours are learned, and which. */
export function weekSummary(cells: WeekCell[]): DaySummary[] {
  return Array.from({ length: 7 }, (_, row) => {
    const day = cells.filter((c) => c.row === row);
    const ranges: [number, number][] = [];
    let learned = 0;
    for (const c of day) {
      if (!c.learned) continue;
      learned++;
      const last = ranges.at(-1);
      if (last && last[1] === c.col - 1) last[1] = c.col;
      else ranges.push([c.col, c.col]);
    }
    return { row, learned, ranges, now: day.find((c) => c.state === 'now')?.col ?? null };
  });
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** "14:00–24:00, 02:00–03:00": the hours a weekday has learned. */
export const rangesText = (ranges: [number, number][]): string =>
  ranges.map(([a, b]) => `${hh(a)}–${hh(b + 1)}`).join(', ');

// ---- the series: how many, and what they are, in the kind's words ----

const BREAKDOWN_ORDER = [
  'nodes',
  'workloads',
  'servers',
  'services',
  'processGroups',
  'containers',
  'applications',
] as const;

/** "6 servers · 35 services · 20 process groups · 5 containers". */
export function breakdownText(b: WhatChangedLearning['series']['breakdown'], tr: Tr): string {
  return BREAKDOWN_ORDER.flatMap((k) => {
    const n = b[k];
    return n ? [tr(`whatChanged.learn.breakdown.${k}`, { n: n.toLocaleString('en') }, n)] : [];
  }).join(' · ');
}

/** Whether the list is on while some series that joined later still learn (ADR-216). */
export const partlyLearning = (l: WhatChangedLearning): boolean =>
  !l.learning && l.series.learning > 0 && !!l.series.readyAt;
