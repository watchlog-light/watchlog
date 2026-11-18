// SPDX-License-Identifier: AGPL-3.0-only
// The API's learning answer (ADR-216) as the backend gives it, for a cluster that started
// learning at `startMs` and is asked at `nowMs`: the worker reads each hour when it ends, so
// every whole hour since the start has a baseline. Shared by the web tests of the learning
// week.
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
  series: { total: 1482, learning: 0, readyAt: null, breakdown: SERIES.kubernetes.breakdown },
  emailWhenReady: false,
};

export function learningAt(
  kind: 'kubernetes' | 'server',
  startMs: number,
  nowMs: number,
  over: Partial<WhatChangedLearning> = {},
): WhatChangedLearning {
  const week = Array<string>(168).fill('0');
  for (let h = Math.floor(startMs / HOUR) * HOUR; h + HOUR <= nowMs; h += HOUR) {
    const d = new Date(h);
    week[d.getUTCDay() * 24 + d.getUTCHours()] = '1';
  }
  const until = startMs + 7 * DAY;
  const learning = nowMs < until;
  return {
    learning,
    since: new Date(startMs).toISOString(),
    until: new Date(until).toISOString(),
    day: Math.min(7, Math.floor((nowMs - startMs) / DAY) + 1),
    hoursLearned: week.filter((c) => c === '1').length,
    hoursTotal: 168,
    week: week.join(''),
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
  series: { total: null, learning: 0, readyAt: null, breakdown: {} },
  emailWhenReady: false,
};
