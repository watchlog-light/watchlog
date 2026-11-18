// SPDX-License-Identifier: AGPL-3.0-only
// The API's learning answer (ADR-216, ADR-217) as the backend gives it, for a cluster that
// started learning at `startMs` and is asked at `nowMs`: the worker reads each hour when it
// ends, so every whole hour since the start has a baseline, except in the `gaps` (the org was
// off Pro, or no data came), which are learned when they come round a week later. The day is
// one for every 24 hours learned, and the list turns on when all 168 are. Shared by the web
// tests of the learning week.
import type { WhatChangedLearning } from '@watchlog/api-types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const SERIES: Record<
  'kubernetes' | 'server',
  { total: number; breakdown: WhatChangedLearning['series']['breakdown'] }
> = {
  kubernetes: { total: 1482, breakdown: { nodes: 6, workloads: 58, applications: 4 } },
  server: {
    total: 1284,
    breakdown: { servers: 6, services: 35, processGroups: 20, containers: 5 },
  },
};

/** A cluster that has finished learning (the answer every other test of the page uses). */
export const LEARNED: WhatChangedLearning = {
  learning: false,
  since: '2026-11-07T14:10:00.000Z',
  until: '2026-11-14T14:10:00.000Z',
  day: 7,
  hoursLearned: 168,
  hoursTotal: 168,
  week: '1'.repeat(168),
  resumedAt: null,
  series: { total: 1482, learning: 0, readyAt: null, breakdown: SERIES.kubernetes.breakdown },
  emailWhenReady: false,
};

export function learningAt(
  kind: 'kubernetes' | 'server',
  startMs: number,
  nowMs: number,
  over: Partial<WhatChangedLearning> = {},
  /** Hours nothing was learned in: [from, to) in ms, each on the hour. */
  gaps: [number, number][] = [],
): WhatChangedLearning {
  const slot = (ms: number) => new Date(ms).getUTCDay() * 24 + new Date(ms).getUTCHours();
  const inGap = (h: number) => gaps.some(([a, b]) => h >= a && h < b);
  const week = Array<string>(168).fill('0');
  const first = Math.floor(startMs / HOUR) * HOUR;
  let resumedAt: number | null = null;
  let last: number | null = null;
  for (let h = first; h + HOUR <= nowMs; h += HOUR) {
    if (inGap(h)) continue;
    week[slot(h)] = '1';
    if (last !== null && h - last > HOUR) resumedAt = h;
    last = h;
  }
  const hours = week.filter((c) => c === '1').length;
  // Ready once every hour of the week is learned: the hour after the last missing one ends,
  // and never before 7 days from the start.
  let until = startMs + 7 * DAY;
  for (let h = Math.floor(nowMs / HOUR) * HOUR; h < nowMs + 8 * DAY; h += HOUR) {
    if (week[slot(h)] === '0' && !inGap(h)) until = Math.max(until, h + HOUR + 6 * 60_000);
    if (week[slot(h)] === '0') week[slot(h)] = 'x'; // counted once
  }
  for (let i = 0; i < 168; i++) if (week[i] === 'x') week[i] = '0';
  const learning = hours < 168 || nowMs < until;
  return {
    learning,
    since: new Date(startMs).toISOString(),
    until: new Date(until).toISOString(),
    day: Math.min(7, Math.floor(hours / 24) + 1),
    hoursLearned: hours,
    hoursTotal: 168,
    week: week.join(''),
    resumedAt: learning && resumedAt !== null ? new Date(resumedAt).toISOString() : null,
    series: {
      total: SERIES[kind].total,
      learning: learning ? SERIES[kind].total : 0,
      readyAt: learning ? new Date(until).toISOString() : null,
      breakdown: SERIES[kind].breakdown,
    },
    emailWhenReady: false,
    ...over,
  };
}

/** Before the worker has seen the org (the first minute of Pro). */
export const STARTING: WhatChangedLearning = {
  learning: true,
  since: null,
  until: null,
  day: null,
  hoursLearned: 0,
  hoursTotal: 168,
  week: '0'.repeat(168),
  resumedAt: null,
  series: { total: null, learning: 0, readyAt: null, breakdown: {} },
  emailWhenReady: false,
};
