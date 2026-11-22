// SPDX-License-Identifier: AGPL-3.0-only
// The learning week in the dashboard (ADR-216), on a Kubernetes cluster and a Server fleet:
// the learning page on day 1, 3 and 6 and in its last hour, each in its kind's words; the
// first minute; the list with series that joined later; reduced motion and a hidden tab;
// "email me when it's ready"; the alert card's line; the sidebar's hint; the upgrade page's
// hero in its waiting state (ADR-201) with its date, its roles and its day-1 preview; and
// the way back from Checkout, where the hero turns into the learning page without a reload.
// Everything the page says comes from the worker's answer (ADR-217): a week with a gap shows
// the hours really learned, the day they make and the later ready date, top and bottom alike.
// The clock is the test's: no day is waited for.
import type { AlertDetail, WhatChanged, WhatChangedLearning } from '@watchlog/api-types';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingState, CloudConfig, PlanInfo } from '@/api/cloud';
import { leaveFor } from '@/api/cloud';
import AppSidebar from '@/components/layout/AppSidebar.vue';
import LearningBrain from '@/components/what-changed/LearningBrain.vue';
import LearningWeekGrid from '@/components/what-changed/LearningWeekGrid.vue';
import WhatChangedAlertCard from '@/components/what-changed/WhatChangedAlertCard.vue';
import { rememberCheckoutOrigin, takeCheckoutOrigin } from '@/lib/checkout-return';
import { whatChangedPath } from '@/lib/what-changed';
import {
  breakdownText,
  dayOf,
  offsetHours,
  partlyLearning,
  rangesText,
  readyParts,
  remaining,
  remainingText,
  readyIfStartedAt,
  ringSegments,
  waitingSegments,
  weekCells,
  weekSummary,
  zoneLabel,
} from '@/lib/what-changed-learning';
import { installCheckoutReturn } from '@/router';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';
import { usePlanStore } from '@/stores/plan';
import WhatChangedPage from '@/views/WhatChangedPage.vue';
import { FLEET as BASE_FLEET } from './docker-fixtures';
import { mockFetch, USER, type Routes } from './fetch-mock';
import { createPlugins } from './helpers';
import { LEARNED, learningAt, SERIES, STARTING } from './learning-fixtures';

vi.mock('@/api/cloud', async (original) => ({
  ...(await original<typeof import('@/api/cloud')>()),
  leaveFor: vi.fn(),
}));

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The upgrade to Pro: a Wednesday at 14:10 UTC. */
const START = Date.UTC(2026, 10, 18, 14, 10, 0);
const UNTIL = START + 7 * DAY;
/** The hour a time is in (gaps are whole hours: the worker learns an hour or doesn't). */
const H = (ms: number) => Math.floor(ms / HOUR) * HOUR;
const K8S = {
  ...BASE_FLEET,
  id: '01a1de8d-e52d-7188-9878-62ee5fd5309d',
  name: 'acme-prod',
  kind: 'kubernetes',
};
const FLEET = { ...BASE_FLEET, name: 'acme-servers' };
type C = typeof K8S;
const kindOf = (c: C) => (c.kind === 'server' ? 'server' : 'kubernetes');
const CONFIG: CloudConfig = {
  signup: true,
  signupMode: 'public',
  providers: { github: false, google: false },
  turnstileSiteKey: null,
  passwordMinLength: 10,
  verifyGraceDays: 7,
  supportEmail: 'support@watchlog.io',
  sampleUrl: 'https://demo.watchlog.io',
};
const FREE: PlanInfo = {
  plan: 'free',
  source: 'signup',
  betaUntil: null,
  proFeatures: false,
  limits: { clusters: 1, nodes: 5, users: 1, retentionDays: 3 },
  usage: { clusters: 1, nodes: 3, kubernetesNodes: 3, dockerHosts: 0, users: 1 },
  period: { from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z', p95: 3, peak: 4 },
  refusedNodes: 0,
  downgrade: null,
  price: {
    currency: 'USD',
    perNodeMonth: 3,
    minimumMonth: 15,
    annualPerNode: 30,
    annualMinimumNodes: 5,
  },
};
const PRO: PlanInfo = {
  ...FREE,
  plan: 'pro',
  source: 'billing',
  proFeatures: true,
  limits: { clusters: null, nodes: null, users: 10, retentionDays: 30 },
};
const LIVE: BillingState = {
  available: true,
  live: true,
  customer: false,
  subscription: null,
  beta: null,
  dunning: null,
};
const PRO_FEATURE = {
  status: 403,
  body: { type: 'urn:watchlog:problem:pro-feature', title: 'Forbidden', status: 403 },
};
const noAlerts = {
  status: 200,
  body: {
    alerts: [],
    nextCursor: null,
    counts: { firing: 0, critical: 0, warning: 0, pending: 0, silenced: 0, held: 0 },
  },
};
const ALERT_ID = '01a19300-0000-7000-8000-000000000042';
const oneAlert = (c: C) => ({
  status: 200,
  body: {
    ...noAlerts.body,
    alerts: [
      {
        id: ALERT_ID,
        title: 'api is crash-looping',
        state: 'firing',
        severity: 'critical',
        startedAt: new Date(START).toISOString(),
        cluster: { id: c.id, name: c.name, kind: c.kind },
      },
    ],
  },
});

function answer(c: C, learning: WhatChangedLearning, now: number, rows = 0): WhatChanged {
  return {
    cluster: { id: c.id, name: c.name, kind: c.kind },
    window: {
      from: new Date(now - HOUR).toISOString(),
      to: new Date(now).toISOString(),
      alert: null,
    },
    sort: 'first',
    chart: {
      from: new Date(now - HOUR).toISOString(),
      to: new Date(now).toISOString(),
      step: 60,
      counts: Array(60).fill(rows),
    },
    rows: Array.from({ length: rows }, (_, i) => ({
      id: `r${i}`,
      since: new Date(now - (12 - i) * MIN).toISOString(),
      until: null,
      key: 'workload.cpu.usage',
      unit: 'cores',
      subject: {},
      object: { kind: 'workload', name: `api-${i}`, namespace: 'shop', workloadKind: 'Deployment' },
      peer: null,
      usualLow: 0.3,
      usualHigh: 0.5,
      value: 0.9,
      peakScore: 8,
      peakAt: new Date(now - 10 * MIN).toISOString(),
    })),
    total: rows,
    truncated: false,
    learning,
    cause: { subject: null, likely: null },
  } as unknown as WhatChanged;
}

const wc = (c: C, now: number) => `GET /api/v1${whatChangedPath(c.id, { window: '1h' }, now)}`;
/** The requests of the learning page: the cluster, the answer, and its latest alert. */
function routes(c: C, now: number, learning: WhatChangedLearning, rows = 0): Routes {
  return {
    'GET /api/v1/clusters': { status: 200, body: { clusters: [c] } },
    [wc(c, now)]: { status: 200, body: answer(c, learning, now, rows) },
    [`GET /api/v1/alerts?view=firing&clusterId=${c.id}&limit=1`]: oneAlert(c),
    [`GET /api/v1/alerts?view=history&clusterId=${c.id}&limit=1`]: noAlerts,
  };
}

let mounted: VueWrapper | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(leaveFor).mockReset();
  sessionStorage.clear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

type Edition = 'pro' | 'free' | 'community' | 'demo';
async function open(
  component: object,
  path: string,
  now: number,
  edition: Edition = 'pro',
  role: 'owner' | 'admin' | 'viewer' = 'owner',
  props: object = {},
) {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  vi.setSystemTime(now);
  const plugins = await createPlugins(path);
  const auth = useAuthStore();
  auth.user = { ...USER, role };
  auth.cloud = edition === 'pro' || edition === 'free' ? CONFIG : null;
  auth.demoMode = edition === 'demo';
  const w = mount(component, {
    props,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  mounted = w;
  await flushPromises();
  await flushPromises();
  return { w, plugins };
}
const reducedMotion = (on: boolean) =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: on && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
const count = (w: VueWrapper, selector: string) => w.findAll(selector).length;
const text = (w: VueWrapper, id: string) => w.get(`[data-testid="${id}"]`).text();

// ------------------------------------------------------------------------------ the lib

describe('the lib', () => {
  it('the ring is the week as it was learned: days done, today, days to come, with the weekdays from the start', () => {
    const at = START + 2 * DAY + 13 * HOUR;
    const day3 = ringSegments(learningAt('server', START, at).week, START, at, 'en', 'UTC');
    expect(day3.map((s) => s.state)).toEqual([
      'done',
      'done',
      'today',
      'todo',
      'todo',
      'todo',
      'todo',
    ]);
    expect(day3.map((s) => s.share)).toEqual([1, 1, 13 / 24, 0, 0, 0, 0]);
    expect(day3.map((s) => s.label)).toEqual(['Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue']);
    const day1 = ringSegments(learningAt('server', START, START + HOUR).week, START, START + HOUR);
    expect(day1.map((s) => s.state)[0]).toBe('today');
    const last = ringSegments(learningAt('server', START, UNTIL - MIN).week, START, UNTIL - MIN);
    expect(last.filter((s) => s.state === 'done')).toHaveLength(6);
    // The weekday is the viewer's: 14:10 UTC on Wednesday is already Thursday in Auckland.
    expect(ringSegments('', START, START, 'en', 'Pacific/Auckland')[0]!.label).toBe('Thu');
    // Seven arcs of one circle, the first starting at the top.
    expect(new Set(day3.map((s) => s.d)).size).toBe(7);
    expect(day3[0]!.d).toMatch(/^M1[67]\d\.\d 2\d\.\d A150 150 0 0 1 /);
  });

  it('a gap is not learned on the ring: a day off Pro stays empty however long ago it was', () => {
    // Pro for a day, off for two, Pro again: asked 7 days after the start.
    const gaps: [number, number][] = [[H(START + DAY), H(START + 3 * DAY)]];
    const l = learningAt('server', START, UNTIL, {}, gaps);
    expect(l).toMatchObject({ learning: true, hoursLearned: 120, day: 6 });
    const ring = ringSegments(l.week, START, UNTIL, 'en', 'UTC');
    // Wednesday's block (14:00 to 14:00) holds the current hour; the two days of the gap
    // (Thursday and Friday afternoon to afternoon) have next to nothing.
    expect(ring.map((s) => s.label)).toEqual(['Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue']);
    expect(ring.map((s) => s.state)).toEqual([
      'today',
      'todo',
      'todo',
      'done',
      'done',
      'done',
      'done',
    ]);
    expect(ring[1]!.share).toBe(0);
    expect(ring[2]!.share).toBe(0);
    // An hour looked at twice with no data is done with, like a learned one.
    const quiet = `2${'1'.repeat(167)}`;
    expect(ringSegments(quiet, START, START + 12 * HOUR).filter((s) => s.share < 1)).toEqual([]);
    // The upgrade page: nothing learning, every segment empty; the preview shows day 1.
    expect(waitingSegments(START).every((s) => s.state === 'todo' && s.share === 0)).toBe(true);
    expect(waitingSegments(START, true).map((s) => s.state)).toEqual([
      'today',
      'todo',
      'todo',
      'todo',
      'todo',
      'todo',
      'todo',
    ]);
  });

  it('the day is the worker’s; the time to go and the ready time are in the viewer’s zone', () => {
    // One day for every 24 hours learned, as the API counts it: never the calendar's.
    expect(dayOf({ day: 3 })).toBe(3);
    expect(dayOf({ day: null })).toBe(1);
    expect(dayOf(learningAt('server', START, START + 2 * DAY + 13 * HOUR))).toBe(3);
    expect(
      dayOf(learningAt('server', START, UNTIL, {}, [[H(START + DAY), H(START + 3 * DAY)]])),
    ).toBe(6);
    // The upgrade page's promise: 7 days of data, ready within the hour after.
    expect(readyIfStartedAt(START)).toBe(START + 7 * DAY + HOUR);

    const tr = (key: string, v?: Record<string, unknown>, n?: number) =>
      key.endsWith('soon')
        ? 'less than a minute'
        : `${String(v?.n)} ${key
            .split('.')
            .pop()!
            .replace(/s$/, n === 1 ? '' : 's')}`;
    const say = (ms: number) => remainingText(remaining(UNTIL, UNTIL - ms), tr);
    expect(say(4 * DAY + 11 * HOUR + 20 * MIN)).toBe('4 days 11 hours');
    expect(say(DAY + 30 * MIN)).toBe('1 day');
    expect(say(11 * HOUR + 5 * MIN)).toBe('11 hours 5 minutes');
    expect(say(HOUR)).toBe('1 hour');
    expect(say(38 * MIN + 20_000)).toBe('38 minutes');
    expect(say(MIN)).toBe('1 minute');
    expect(say(20_000)).toBe('less than a minute');
    expect(remaining(UNTIL, UNTIL + HOUR)).toEqual({ days: 0, hours: 0, minutes: 0 });

    expect(readyParts(UNTIL, 'en', 'UTC')).toEqual({ date: 'Wed 25 Nov', time: '14:10' });
    expect(readyParts(UNTIL, 'en', 'Europe/Berlin')).toEqual({ date: 'Wed 25 Nov', time: '15:10' });
    expect(readyParts(UNTIL, 'en', 'Asia/Tehran')).toEqual({ date: 'Wed 25 Nov', time: '17:40' });
    expect(readyParts(UNTIL, 'en', 'Pacific/Auckland')).toEqual({
      date: 'Thu 26 Nov',
      time: '03:10',
    });
  });

  it('the grid: the API’s UTC week as Monday-to-Sunday rows in the viewer’s hours', () => {
    // Day 1, 17:20 UTC: Wednesday 14:00, 15:00 and 16:00 are learned, 17:00 is this hour.
    const now = START + 3 * HOUR + 10 * MIN;
    const week = learningAt('server', START, now).week;
    const utc = weekCells(week, now, 0);
    expect(utc).toHaveLength(168);
    expect(utc.filter((c) => c.state === 'learned').map((c) => [c.row, c.col])).toEqual([
      [2, 14],
      [2, 15],
      [2, 16],
    ]);
    expect(utc.filter((c) => c.state === 'now').map((c) => [c.row, c.col])).toEqual([[2, 17]]);
    // New York (UTC−5): the same hours are 09:00 to 11:00, and this hour is 12:00.
    const ny = weekCells(week, now, -300);
    expect(ny.filter((c) => c.state === 'learned').map((c) => c.col)).toEqual([9, 10, 11]);
    expect(ny.find((c) => c.state === 'now')).toMatchObject({ row: 2, col: 12 });
    // Auckland (UTC+13): they are Thursday morning.
    expect(weekCells(week, now, 780).filter((c) => c.state === 'learned')[0]).toMatchObject({
      row: 3,
      col: 3,
    });
    // Tehran (UTC+3:30): to the nearest hour, and the label says the true offset.
    expect(offsetHours(210)).toBe(4);
    expect(weekCells(week, now, 210).filter((c) => c.state === 'learned')[0]!.col).toBe(18);
    expect([0, 60, 210, -300, 345].map(zoneLabel)).toEqual([
      'UTC',
      'UTC+1',
      'UTC+3:30',
      'UTC−5',
      'UTC+5:45',
    ]);
    // Sunday 00:00 UTC, the API's first character, is the last row's first column.
    expect(weekCells(`1${'0'.repeat(167)}`, null, 0).find((c) => c.state === 'learned')).toEqual({
      row: 6,
      col: 0,
      state: 'learned',
      learned: true,
    });
    // Nothing learning: no cell is "this hour", whatever the clock.
    expect(weekCells('', null, 0).every((c) => c.state === 'todo')).toBe(true);
  });

  it('the grid as text: a weekday a line, with its hours', () => {
    const now = START + DAY + 2 * HOUR; // Thursday 16:10 UTC
    const days = weekSummary(weekCells(learningAt('kubernetes', START, now).week, now, 0));
    expect(days.map((d) => d.learned)).toEqual([0, 0, 10, 16, 0, 0, 0]);
    expect(rangesText(days[2]!.ranges)).toBe('14:00–24:00');
    expect(rangesText(days[3]!.ranges)).toBe('00:00–16:00');
    expect(days[3]!.now).toBe(16);
    expect(
      rangesText([
        [0, 2],
        [5, 5],
      ]),
    ).toBe('00:00–03:00, 05:00–06:00');
  });

  it('the series in the kind’s words, and when the list is on while some still learn', () => {
    const tr = (key: string, v?: Record<string, unknown>) =>
      `${String(v?.n)} ${key.split('.').pop()}`;
    expect(breakdownText(SERIES.server.breakdown, tr)).toBe(
      '6 servers · 35 services · 20 processGroups · 5 containers',
    );
    expect(breakdownText({ nodes: 1200, workloads: 3 }, tr)).toBe('1,200 nodes · 3 workloads');
    expect(breakdownText({}, tr)).toBe('');
    expect(partlyLearning(LEARNED)).toBe(false);
    expect(partlyLearning(learningAt('server', START, START + DAY))).toBe(false);
    expect(
      partlyLearning({
        ...LEARNED,
        series: { ...LEARNED.series, learning: 3, readyAt: new Date(UNTIL).toISOString() },
      }),
    ).toBe(true);
  });

  it('where Checkout was started: read once, forgotten after two hours, never trusted blindly', () => {
    expect(takeCheckoutOrigin()).toBeNull();
    rememberCheckoutOrigin('c1', 1_000);
    expect(takeCheckoutOrigin(2_000)).toEqual({ page: 'what-changed', cluster: 'c1' });
    expect(takeCheckoutOrigin(2_000)).toBeNull();
    rememberCheckoutOrigin('c1', 1_000);
    expect(takeCheckoutOrigin(1_000 + 3 * HOUR)).toBeNull();
    sessionStorage.setItem('watchlog.checkout-from', '{"page":"settings","cluster":5}');
    expect(takeCheckoutOrigin()).toBeNull();
    sessionStorage.setItem('watchlog.checkout-from', 'not json');
    expect(takeCheckoutOrigin()).toBeNull();
  });
});

// ------------------------------------------------------------------------------ the page

const DAYS: [string, number, { day: number; hours: number; done: number }][] = [
  ['day 1', START + 3 * HOUR + 10 * MIN, { day: 1, hours: 3, done: 0 }],
  ['day 3', START + 2 * DAY + 13 * HOUR, { day: 3, hours: 61, done: 2 }],
  ['day 6', START + 5 * DAY + 6 * HOUR, { day: 6, hours: 126, done: 5 }],
  ['the last hour', UNTIL - 38 * MIN, { day: 7, hours: 167, done: 6 }],
];

describe.each([K8S, FLEET])('the learning page, $kind', (c) => {
  it.each(DAYS)('%s', async (_name, now, want) => {
    reducedMotion(false);
    const learning = learningAt(kindOf(c), START, now);
    expect(learning.hoursLearned).toBe(want.hours);
    mockFetch(routes(c, now, learning));
    const { w } = await open(WhatChangedPage, `/what-changed?cluster=${c.id}`, now);
    const page = w.get('[data-testid="wc-learning"]');
    expect(page.attributes('data-day')).toBe(String(want.day));
    expect(text(w, 'wc-learn-day')).toBe(`Learning · day ${want.day} of 7`);
    expect(page.text()).toContain(`Learning what normal looks like for ${c.name}.`);
    expect(page.text()).toContain(
      c.kind === 'server'
        ? 'every server, service, process group, container'
        : 'every workload, node and service map connection in this cluster',
    );
    // When it is ready, in the viewer's time zone, and how long that is.
    const ready = readyParts(UNTIL);
    expect(text(w, 'wc-learn-ready')).toContain(`Ready on ${ready.date}, about ${ready.time}`);
    const left = remaining(UNTIL, now);
    expect(text(w, 'wc-learn-togo')).toBe(
      left.days
        ? `${left.days} ${left.days === 1 ? 'day' : 'days'} ${left.hours} hours to go`
        : `${left.minutes} minutes to go`,
    );
    // The bar and the tiles: the real hours and the real series, in the kind's words.
    const bar = w.get('[data-testid="wc-learn-bar"]');
    expect(bar.attributes('aria-valuenow')).toBe(String(want.hours));
    expect(bar.attributes('aria-valuemax')).toBe('168');
    expect(bar.attributes('aria-label')).toBe('Hours of the week learned');
    expect(text(w, 'wc-tile-hours')).toContain(`${want.hours} of 168`);
    expect(text(w, 'wc-tile-series')).toContain(c.kind === 'server' ? '1,284' : '1,482');
    expect(text(w, 'wc-tile-series')).toContain(
      c.kind === 'server'
        ? '6 servers · 35 services · 20 process groups · 5 containers'
        : '6 nodes · 58 workloads · 4 applications',
    );
    expect(text(w, 'wc-tile-togo')).toContain('no action needed from you');
    // The ring: the days done, today, the days to come.
    expect(count(w, '[data-testid="ring-done"]')).toBe(want.done);
    expect(count(w, '[data-testid="ring-today"]')).toBe(1);
    expect(count(w, '[data-testid="ring-todo"]')).toBe(6 - want.done);
    const brain = w.get('[data-testid="learning-brain"]');
    expect(brain.attributes('data-state')).toBe('learning');
    expect(brain.attributes('aria-label')).toBe(`Day ${want.day} of 7 of learning`);
    expect(brain.attributes('data-motion')).toBe('on');
    // The week: every hour learned so far, this hour, and the rest.
    const grid = w.get('[data-testid="wc-week-grid"]');
    expect(grid.findAll('span')).toHaveLength(168);
    expect(count(w, '[data-testid="wc-week-grid"] [data-state="learned"]')).toBe(want.hours);
    expect(count(w, '[data-testid="wc-week-grid"] [data-state="now"]')).toBe(1);
    // …and the same as text, for a screen reader: the squares themselves are hidden from it.
    expect(w.get('[data-testid="wc-week-scroll"]').attributes('aria-hidden')).toBe('true');
    const asText = w.get('[data-testid="wc-week-text"]');
    expect(asText.text()).toContain(`${want.hours} of the 168 hours of the week learned so far.`);
    expect(asText.findAll('li')).toHaveLength(7);
    expect(asText.text()).toContain('This hour is');
    // What happens next, and what already works, with real links.
    expect(text(w, 'wc-learn-next')).toContain('When the week is learned: the list turns on');
    expect(text(w, 'wc-learn-next')).toContain('“Unusual for this hour” alerts');
    const href = (id: string) => w.get(`[data-testid="wc-working-${id}"]`).attributes('href');
    expect(href('alerts')).toBe(`/alerts?cluster=${c.id}`);
    expect(href('cause')).toBe(`/alerts/${ALERT_ID}`);
    expect(href('egress')).toBe(`/egress?cluster=${c.id}`);
    expect(href('map')).toBe(`/service-map?cluster=${c.id}`);
    expect(text(w, 'wc-working-alerts')).toContain(
      c.kind === 'server' ? 'failed services' : 'crash loops',
    );
    // Nothing is listed, there is no window to pick, and the footer line stays.
    expect(w.find('[data-testid="wc-windows"]').exists()).toBe(false);
    expect(w.find('[data-testid="wc-hero"]').exists()).toBe(false);
    expect(w.find('[data-testid="wc-row"]').exists()).toBe(false);
    expect(text(w, 'wc-footnote')).toContain('Statistics only');
    expect(text(w, 'wc-footnote')).toContain('Nothing is sent to an AI');
    expect(text(w, 'wc-cluster')).toContain(c.kind === 'server' ? 'Servers' : 'Kubernetes');
  });

  it('the first minute: learning is about to start, and nothing is counted yet', async () => {
    reducedMotion(false);
    mockFetch({
      ...routes(c, START, STARTING),
      [`GET /api/v1/alerts?view=firing&clusterId=${c.id}&limit=1`]: noAlerts,
    });
    const { w } = await open(WhatChangedPage, `/what-changed?cluster=${c.id}`, START);
    expect(text(w, 'wc-learn-day')).toBe('Learning · day 1 of 7');
    expect(text(w, 'wc-learn-ready')).toBe('Learning starts within a minute and takes 7 days.');
    expect(text(w, 'wc-tile-series')).toContain('Counting…');
    expect(text(w, 'wc-tile-series')).toContain('The first hour is read at');
    expect(text(w, 'wc-tile-hours')).toContain('0 of 168');
    expect(text(w, 'wc-tile-togo')).toContain('7 days');
    expect(count(w, '[data-testid="wc-week-grid"] [data-state="learned"]')).toBe(0);
    // No alert yet: "Probable cause on every alert" opens the alert list.
    expect(w.get('[data-testid="wc-working-cause"]').attributes('href')).toBe(
      `/alerts?cluster=${c.id}`,
    );
  });

  it('a week with a gap (Pro, off for 2 days, Pro again): the top and the bottom say the same, and it is the later date', async () => {
    reducedMotion(false);
    const gaps: [number, number][] = [[H(START + DAY), H(START + 3 * DAY)]];
    // Asked 7 days after the first sighting: where the page used to say "ready".
    const now = UNTIL;
    const learning = learningAt(kindOf(c), START, now, {}, gaps);
    expect(learning).toMatchObject({ learning: true, hoursLearned: 120, day: 6 });
    mockFetch(routes(c, now, learning));
    const { w } = await open(WhatChangedPage, `/what-changed?cluster=${c.id}`, now);
    // The top: the day the learned hours make, and the worker's ready date.
    expect(text(w, 'wc-learn-day')).toBe('Learning · day 6 of 7');
    const ready = readyParts(Date.parse(learning.until!));
    expect(Date.parse(learning.until!)).toBeGreaterThan(START + 9 * DAY);
    expect(text(w, 'wc-learn-ready')).toContain(`Ready on ${ready.date}, about ${ready.time}`);
    expect(text(w, 'wc-learn-togo')).toMatch(/^2 days 2\d hours to go$/);
    // The bottom: the same 120 hours in the bar, the tile and the grid.
    expect(w.get('[data-testid="wc-learn-bar"]').attributes('aria-valuenow')).toBe('120');
    expect(text(w, 'wc-tile-hours')).toContain('120 of 168');
    // (This hour is one of the 120: it was learned a week ago, and is drawn as "this hour".)
    expect(count(w, '[data-testid="wc-week-grid"] [data-state="learned"]')).toBe(119);
    expect(count(w, '[data-testid="wc-week-grid"] [data-state="now"]')).toBe(1);
    expect(text(w, 'wc-week-text')).toContain('120 of the 168 hours of the week learned so far.');
    // The ring: four full days, today, and the two days of the gap empty.
    expect(count(w, '[data-testid="ring-done"]')).toBe(4);
    expect(count(w, '[data-testid="ring-today"]')).toBe(1);
    const empty = w.findAll('[data-testid="ring-todo"]');
    expect(empty.map((s) => s.attributes('data-share'))).toEqual(['0.00', '0.00']);
    // And it says when it resumed, and that what it had still counts.
    const resumed = readyParts(Date.parse(learning.resumedAt!));
    expect(text(w, 'wc-learn-resumed')).toBe(
      `Learning resumed on ${resumed.date} at ${resumed.time}. What it learned before still counts; the hours in between are learned as they come round.`,
    );
    mounted!.unmount();

    // Two hours learned before the gap, then two days off: day 1, not day 3.
    const few = learningAt(kindOf(c), START, START + 2 * DAY + 70 * MIN, {}, [
      [H(START + 2 * HOUR), H(START + 2 * DAY)],
    ]);
    expect(few).toMatchObject({ learning: true, hoursLearned: 3, day: 1 });
    mockFetch(routes(c, START + 2 * DAY + 70 * MIN, few));
    const again = await open(
      WhatChangedPage,
      `/what-changed?cluster=${c.id}`,
      START + 2 * DAY + 70 * MIN,
    );
    expect(text(again.w, 'wc-learn-day')).toBe('Learning · day 1 of 7');
    expect(text(again.w, 'wc-tile-hours')).toContain('3 of 168');
    expect(again.w.get('[data-testid="wc-learn-bar"]').attributes('aria-valuenow')).toBe('3');
    // The first day has 2 of its 24 hours: a short arc over an empty track, not a full day.
    expect(count(again.w, '[data-testid="ring-done"]')).toBe(0);
    expect(again.w.get('[data-testid="ring-part"]').attributes('stroke-dasharray')).toBe('0.083 1');
    expect(Date.parse(few.until!)).toBeGreaterThan(START + 8 * DAY);
    // A week without a gap never says "resumed".
    mounted!.unmount();
    mockFetch(routes(c, START + DAY, learningAt(kindOf(c), START, START + DAY)));
    const plain = await open(WhatChangedPage, `/what-changed?cluster=${c.id}`, START + DAY);
    expect(plain.w.find('[data-testid="wc-learn-resumed"]').exists()).toBe(false);
    expect(plain.w.find('[data-testid="ring-part"]').exists()).toBe(false);
  });

  it('partly learned: the list as always, and a strip saying how many still learn and until when', async () => {
    const now = UNTIL + 2 * DAY;
    const readyAt = now + 5 * DAY + 2 * HOUR;
    const learning: WhatChangedLearning = {
      ...learningAt(kindOf(c), START, now),
      series: {
        total: 1296,
        learning: 12,
        readyAt: new Date(readyAt).toISOString(),
        breakdown: SERIES[kindOf(c)].breakdown,
      },
    };
    mockFetch(routes(c, now, learning, 2));
    const { w } = await open(WhatChangedPage, `/what-changed?cluster=${c.id}`, now);
    const at = readyParts(readyAt);
    expect(text(w, 'wc-partly')).toBe(
      `12 of 1,296 series are still learning (they joined later). The last is ready on ${at.date}, about ${at.time}.`,
    );
    // After learning: the map, then the story or the quiet page (0.14.0).
    expect(w.find('[data-testid="wc-after"]').exists()).toBe(true);
    expect(w.find('[data-testid="wc-map"]').exists()).toBe(true);
    expect(w.find('[data-testid="wc-windows"]').exists()).toBe(true);
    expect(w.find('[data-testid="wc-learning"]').exists()).toBe(false);
    expect(w.find('[data-testid="learning-brain"]').exists()).toBe(false);
    mounted!.unmount();

    // One series, and none: the singular, and no strip.
    mockFetch(routes(c, now, { ...learning, series: { ...learning.series, learning: 1 } }, 0));
    let r = await open(WhatChangedPage, `/what-changed?cluster=${c.id}`, now);
    expect(text(r.w, 'wc-partly')).toContain(
      '1 of 1,296 series is still learning (it joined later)',
    );
    expect(r.w.find('[data-testid="wc-quiet"]').exists()).toBe(true);
    mounted!.unmount();
    mockFetch(routes(c, now, learningAt(kindOf(c), START, now), 0));
    r = await open(WhatChangedPage, `/what-changed?cluster=${c.id}`, now);
    expect(r.w.find('[data-testid="wc-partly"]').exists()).toBe(false);
  });
});

// ------------------------------------------------------------------------------ motion

describe('motion', () => {
  const now = START + 2 * DAY + 13 * HOUR;

  it('reduced motion: everything still, the same information', async () => {
    reducedMotion(true);
    mockFetch(routes(FLEET, now, learningAt('server', START, now)));
    const { w } = await open(WhatChangedPage, `/what-changed?cluster=${FLEET.id}`, now);
    expect(w.get('[data-testid="learning-brain"]').attributes('data-motion')).toBe('off');
    expect(w.get('[data-testid="wc-week"]').attributes('data-motion')).toBe('off');
    // Nothing is lost with it: the day, the ring, the grid, the date.
    expect(text(w, 'wc-learn-day')).toBe('Learning · day 3 of 7');
    expect(count(w, '[data-testid="ring-done"]')).toBe(2);
    expect(count(w, '[data-testid="ring-today"]')).toBe(1);
    expect(count(w, '[data-testid="wc-week-grid"] [data-state="now"]')).toBe(1);
    expect(text(w, 'wc-learn-ready')).toContain('Ready on');
    expect(w.get('[data-testid="learning-brain"]').attributes('aria-label')).toBe(
      'Day 3 of 7 of learning',
    );
  });

  it('a hidden tab pauses every animation and the countdown; it goes on when the tab is back', async () => {
    reducedMotion(false);
    mockFetch(routes(FLEET, now, learningAt('server', START, now)));
    const { w } = await open(WhatChangedPage, `/what-changed?cluster=${FLEET.id}`, now);
    const brain = w.get('[data-testid="learning-brain"]');
    expect(brain.attributes('data-motion')).toBe('on');
    const hide = async (state: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
      await flushPromises();
    };
    await hide('hidden');
    expect(brain.attributes('data-motion')).toBe('paused');
    expect(w.get('[data-testid="wc-week"]').attributes('data-motion')).toBe('paused');
    const before = text(w, 'wc-learn-togo');
    // Two hours pass with the tab hidden: nothing ticks.
    vi.setSystemTime(now + 2 * HOUR);
    vi.advanceTimersByTime(60_000);
    await flushPromises();
    expect(text(w, 'wc-learn-togo')).toBe(before);
    await hide('visible');
    expect(brain.attributes('data-motion')).toBe('on');
    expect(text(w, 'wc-learn-togo')).not.toBe(before);
  });
});

describe('the centrepiece and the grid on their own', () => {
  async function plugins() {
    const p = await createPlugins('/');
    return { global: { plugins: [p.router, p.i18n, p.pinia] } };
  }

  it('waiting: every segment empty, no "today", and a label that says nothing is learned', async () => {
    reducedMotion(false);
    const w = mount(LearningBrain, {
      props: { state: 'waiting', start: START },
      ...(await plugins()),
    });
    mounted = w;
    expect(w.attributes('data-state')).toBe('waiting');
    expect(count(w, '[data-testid="ring-todo"]')).toBe(7);
    expect(count(w, '[data-testid="ring-today"]')).toBe(0);
    expect(count(w, '[data-testid="ring-done"]')).toBe(0);
    expect(w.attributes('aria-label')).toContain('Not learning yet');
    expect(w.attributes('data-preview')).toBeUndefined();
    // Two slow dots, not the learning page's five; and no pulsing "today" layer.
    expect(w.findAll('.lb-orbit circle')).toHaveLength(2);
    expect(w.find('.lb-today').exists()).toBe(false);
    // The preview of day 1: the first segment fills.
    await w.setProps({ preview: true });
    expect(w.attributes('data-preview')).toBe('on');
    expect(count(w, '[data-testid="ring-today"]')).toBe(1);
    expect(count(w, '[data-testid="ring-todo"]')).toBe(6);
    await w.setProps({ preview: false });
    expect(count(w, '[data-testid="ring-todo"]')).toBe(7);
  });

  it('waiting with reduced motion: no preview at all', async () => {
    reducedMotion(true);
    const w = mount(LearningBrain, {
      props: { state: 'waiting', start: START, preview: true },
      ...(await plugins()),
    });
    mounted = w;
    expect(w.attributes('data-motion')).toBe('off');
    expect(w.attributes('data-preview')).toBeUndefined();
    expect(count(w, '[data-testid="ring-todo"]')).toBe(7);
  });

  it('learning: five dots on three orbits, the ten folds in three turns', async () => {
    reducedMotion(false);
    const w = mount(LearningBrain, {
      props: {
        state: 'learning',
        day: 4,
        start: START,
        week: learningAt('server', START, START + 3 * DAY + HOUR).week,
        now: START + 3 * DAY + HOUR,
      },
      ...(await plugins()),
    });
    mounted = w;
    expect(w.findAll('.lb-orbit')).toHaveLength(3);
    expect(w.findAll('.lb-orbit circle')).toHaveLength(5);
    expect(w.findAll('.lb-turn')).toHaveLength(3);
    expect(w.findAll('.lb-fold')).toHaveLength(10);
    expect(count(w, '[data-testid="ring-done"]')).toBe(3);
  });

  it('the grid, waiting: all 168 hours "not seen yet", none "this hour", and it says why', async () => {
    reducedMotion(false);
    const w = mount(LearningWeekGrid, {
      props: { week: '1'.repeat(168), now: START, waiting: true, offsetMin: 0 },
      ...(await plugins()),
    });
    mounted = w;
    expect(count(w, '[data-state="todo"]')).toBe(168);
    expect(count(w, '[data-state="learned"]')).toBe(0);
    expect(count(w, '[data-state="now"]')).toBe(0);
    expect(w.text()).toContain('The week it will learn');
    expect(w.text()).toContain('Nothing is learned before the upgrade.');
    expect(w.text()).not.toContain('this hour');
    expect(text(w, 'wc-week-text')).toContain('None of the 168 hours of the week is learned');
  });

  it('an hour looked at twice with no data is neither learned nor "not seen yet", and the legend says so only then', async () => {
    reducedMotion(false);
    const now = START + DAY;
    const week = learningAt('server', START, now).week;
    const quiet = `22${week.slice(2)}`;
    const w = mount(LearningWeekGrid, {
      props: { week: quiet, now, offsetMin: 0 },
      ...(await plugins()),
    });
    mounted = w;
    expect(count(w, '[data-state="quiet"]')).toBe(2);
    expect(text(w, 'wc-week-quiet')).toBe('no data');
    expect(text(w, 'wc-week-text')).toContain(
      '2 hours had no data both times they were looked at.',
    );
    w.unmount();
    const none = mount(LearningWeekGrid, {
      props: { week, now, offsetMin: 0 },
      ...(await plugins()),
    });
    mounted = none;
    expect(none.find('[data-testid="wc-week-quiet"]').exists()).toBe(false);
  });

  it('the grid in a half-hour zone says it rounds; in a whole-hour zone it names the zone', async () => {
    reducedMotion(false);
    const now = START + DAY;
    const week = learningAt('server', START, now).week;
    let w = mount(LearningWeekGrid, {
      props: { week, now, offsetMin: 210 },
      ...(await plugins()),
    });
    expect(text(w, 'wc-week-zone')).toBe(
      'Hours are in your time zone (UTC+3:30), to the nearest hour.',
    );
    w.unmount();
    w = mount(LearningWeekGrid, { props: { week, now, offsetMin: 60 }, ...(await plugins()) });
    mounted = w;
    expect(text(w, 'wc-week-zone')).toBe('Hours are in your time zone (UTC+1).');
    expect(text(w, 'wc-week-text')).toContain('Wednesday: 9 of 24 hours learned (15:00–24:00).');
    expect(text(w, 'wc-week-text')).toContain('Monday: not seen yet.');
  });
});

// ------------------------------------------------------------------------------ the email

describe('“Email me when it’s ready”', () => {
  const now = START + DAY;
  const put = 'PUT /api/v1/what-changed/ready-email';

  it('asks the server, shows its state, and can be undone; a Viewer may too', async () => {
    reducedMotion(false);
    const { calls } = mockFetch({
      ...routes(K8S, now, learningAt('kubernetes', START, now)),
      // The page reads again after each change.
      [wc(K8S, now)]: [
        { status: 200, body: answer(K8S, learningAt('kubernetes', START, now), now) },
        {
          status: 200,
          body: answer(K8S, learningAt('kubernetes', START, now, { emailWhenReady: true }), now),
        },
        { status: 200, body: answer(K8S, learningAt('kubernetes', START, now), now) },
      ],
      [put]: [
        { status: 200, body: { emailWhenReady: true } },
        { status: 200, body: { emailWhenReady: false } },
      ],
    });
    const { w } = await open(
      WhatChangedPage,
      `/what-changed?cluster=${K8S.id}`,
      now,
      'pro',
      'viewer',
    );
    const button = w.get('[data-testid="wc-learn-email"]');
    expect(button.text()).toBe("Email me when it's ready");
    expect(button.attributes('aria-pressed')).toBe('false');
    expect(w.find('[data-testid="wc-learn-undo"]').exists()).toBe(false);
    await button.trigger('click');
    await flushPromises();
    expect(calls.find((x) => x.method === 'PUT')).toMatchObject({
      path: '/api/v1/what-changed/ready-email',
      body: { cluster: K8S.id, enabled: true },
    });
    expect(button.text()).toBe("We'll email you when it's ready");
    expect(button.attributes('aria-pressed')).toBe('true');
    expect(text(w, 'wc-learn-undo')).toContain(USER.email);
    expect(text(w, 'wc-learn-undo')).toContain('Press the button again to undo');
    await button.trigger('click');
    await flushPromises();
    expect(calls.filter((x) => x.method === 'PUT')[1]!.body).toEqual({
      cluster: K8S.id,
      enabled: false,
    });
    expect(button.attributes('aria-pressed')).toBe('false');
  });

  it('opens already asked for; a refusal says why and changes nothing', async () => {
    reducedMotion(false);
    mockFetch({
      ...routes(FLEET, now, learningAt('server', START, now, { emailWhenReady: true })),
      [put]: {
        status: 409,
        body: { type: 'about:blank', title: 'Verify your email address first', status: 409 },
      },
    });
    const { w } = await open(WhatChangedPage, `/what-changed?cluster=${FLEET.id}`, now);
    const button = w.get('[data-testid="wc-learn-email"]');
    expect(button.attributes('aria-pressed')).toBe('true');
    await button.trigger('click');
    await flushPromises();
    expect(text(w, 'wc-learn-err')).toBe('Verify your email address first');
    expect(button.attributes('aria-pressed')).toBe('true');
  });

  it('the demo offers neither the email nor a link to itself', async () => {
    reducedMotion(false);
    mockFetch(routes(K8S, now, learningAt('kubernetes', START, now)));
    const { w } = await open(WhatChangedPage, `/what-changed?cluster=${K8S.id}`, now, 'demo');
    expect(w.find('[data-testid="wc-learning"]').exists()).toBe(true);
    expect(w.find('[data-testid="wc-learn-email"]').exists()).toBe(false);
    expect(w.find('[data-testid="wc-learn-demo"]').exists()).toBe(false);
  });
});

// ------------------------------------------------------------------------------ elsewhere

describe('elsewhere, the same in small', () => {
  const now = START + 2 * DAY + 13 * HOUR;
  const alert = (c: C) =>
    ({
      id: ALERT_ID,
      cluster: { id: c.id, name: c.name, kind: c.kind },
    }) as unknown as AlertDetail['alert'];
  const around = (c: C) =>
    `GET /api/v1${whatChangedPath(c.id, { window: 'alert', alert: ALERT_ID })}`;

  it('the alert card: one line with the day and the ready date, opening the learning page', async () => {
    for (const c of [K8S, FLEET]) {
      mockFetch({
        [around(c)]: { status: 200, body: answer(c, learningAt(kindOf(c), START, now), now) },
      });
      const { w } = await open(WhatChangedAlertCard, '/alerts', now, 'pro', 'viewer', {
        alert: alert(c),
      });
      const line = w.get('[data-testid="wc-card-learning"]');
      const at = readyParts(UNTIL);
      expect(line.text()).toBe(
        `Learning ${c.name}'s usual week, day 3 of 7. What changed is ready on ${at.date}, about ${at.time}.`,
      );
      expect(line.attributes('href')).toBe(`/what-changed?cluster=${c.id}`);
      // One line, not a card with a title and an empty body.
      expect(w.find('[data-testid="wc-card"]').exists()).toBe(false);
      expect(w.find('[data-testid="wc-card-link"]').exists()).toBe(false);
      mounted!.unmount();
      mounted = null;
    }
  });

  it('the sidebar: "day 3/7" beside What changed for an org with Pro, while it learns', async () => {
    const learningPath = `GET /api/v1/what-changed/learning?cluster=${K8S.id}`;
    const base: Routes = {
      'GET /api/v1/clusters': { status: 200, body: { clusters: [K8S] } },
      [`GET /api/v1/egress?cluster=${K8S.id}`]: { status: 200, body: { summary: { new: 0 } } },
    };
    const mountSidebar = async (plan: PlanInfo | null, cloud = true) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      const p = await createPlugins(`/?cluster=${K8S.id}`);
      const auth = useAuthStore();
      auth.user = USER;
      auth.cloud = cloud ? CONFIG : null;
      usePlanStore().info = plan;
      await useClustersStore().ensure();
      const w = mount(AppSidebar, { global: { plugins: [p.router, p.i18n, p.pinia] } });
      mounted = w;
      await flushPromises();
      return w;
    };
    // Pro and learning: the hint, in words for a screen reader, instead of the Pro pill.
    mockFetch({
      ...base,
      [learningPath]: { status: 200, body: { learning: learningAt('kubernetes', START, now) } },
    });
    let w = await mountSidebar(PRO);
    const hint = w.get('[data-testid="nav-learning"]');
    expect(hint.text()).toContain('day 3/7');
    expect(hint.text()).toContain('Learning: day 3 of 7');
    expect(w.find('[data-testid="nav-pro"]').exists()).toBe(false);
    mounted!.unmount();
    // Pro and learned: no hint, the Pro pill as before.
    mockFetch({ ...base, [learningPath]: { status: 200, body: { learning: LEARNED } } });
    w = await mountSidebar(PRO);
    expect(w.find('[data-testid="nav-learning"]').exists()).toBe(false);
    expect(w.find('[data-testid="nav-pro"]').exists()).toBe(true);
    mounted!.unmount();
    // Free and Community never ask.
    let m = mockFetch(base);
    w = await mountSidebar(FREE);
    expect(w.find('[data-testid="nav-learning"]').exists()).toBe(false);
    expect(m.calls.some((x) => x.path.includes('/what-changed'))).toBe(false);
    mounted!.unmount();
    m = mockFetch(base);
    w = await mountSidebar(null, false);
    expect(w.find('[data-testid="nav-learning"]').exists()).toBe(false);
    expect(m.calls.some((x) => x.path.includes('/what-changed'))).toBe(false);
  });
});

// ------------------------------------------------------------------------------ the upgrade page

describe('the upgrade page’s hero: the same brain, waiting (ADR-201)', () => {
  const now = START;
  const freeRoutes = (c: C, billing: BillingState | null = LIVE): Routes => ({
    'GET /api/v1/clusters': { status: 200, body: { clusters: [c] } },
    [wc(c, now)]: PRO_FEATURE,
    [`GET /api/v1/alerts?view=firing&clusterId=${c.id}&limit=5`]: noAlerts,
    [`GET /api/v1/alerts?view=history&clusterId=${c.id}&limit=5`]: noAlerts,
    'GET /api/v1/plan': { status: 200, body: FREE },
    ...(billing ? { 'GET /api/v1/plan/billing': { status: 200, body: billing } } : {}),
    'GET /api/v1/users': {
      status: 200,
      body: { users: [{ name: 'Grace Hopper', email: 'grace@example.com', role: 'owner' }] },
    },
  });

  it.each([K8S, FLEET])(
    'Cloud Free, $kind: not learning, the real date, the price, and nothing that looks learned',
    async (c) => {
      reducedMotion(false);
      mockFetch(freeRoutes(c));
      const { w } = await open(WhatChangedPage, `/what-changed?cluster=${c.id}`, now, 'free');
      const hero = w.get('[data-testid="wc-up-hero"]');
      expect(text(w, 'wc-up-state')).toBe('Not learning yet');
      expect(hero.text()).toContain('What changed learns your normal week.');
      expect(hero.text()).toContain('It starts the minute you upgrade.');
      // Today plus 7 days, in the viewer's time zone.
      expect(text(w, 'wc-up-ready')).toBe(
        `Upgrade today and it's ready on ${readyParts(readyIfStartedAt(now)).date}.`,
      );
      expect(text(w, 'wc-up-badge')).toBe('Pro · $3 per node a month');
      expect(text(w, 'wc-up-fine')).toContain(
        c.kind === 'server'
          ? '$3 per server a month, $15 minimum'
          : '$3 per node a month, $15 minimum',
      );
      // The brain waits: every segment empty, and the grid all "not seen yet".
      const brain = w.get('[data-testid="learning-brain"]');
      expect(brain.attributes('data-state')).toBe('waiting');
      expect(count(w, '[data-testid="ring-todo"]')).toBe(7);
      expect(count(w, '[data-testid="wc-week-grid"] [data-state="todo"]')).toBe(168);
      expect(count(w, '[data-testid="wc-week-grid"] [data-state="now"]')).toBe(0);
      // Nothing on the page says or shows that anything is being learned.
      const page = w.get('[data-testid="wc-upgrade"]');
      expect(page.text()).not.toMatch(/Learning · day|hours? of the week learned|to go\b/);
      expect(w.find('[data-testid="wc-learning"]').exists()).toBe(false);
      expect(w.find('[data-testid="wc-learn-bar"]').exists()).toBe(false);
      // It leads the page: above the demo's labelled example, the alerts and the reasons.
      const order = ['wc-up-hero', 'wc-week', 'wc-up-example', 'wc-up-alerts', 'wc-up-reasons'].map(
        (id) => page.html().indexOf(`data-testid="${id}"`),
      );
      expect(order.every((at) => at >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(text(w, 'wc-up-demo-label')).toMatch(/^Live demo · not your/);
      expect(text(w, 'wc-up-free-note')).toContain('stay free on every plan');
    },
  );

  it('hovering or focusing Upgrade previews day 1; with reduced motion nothing moves', async () => {
    reducedMotion(false);
    mockFetch(freeRoutes(K8S));
    let { w } = await open(WhatChangedPage, `/what-changed?cluster=${K8S.id}`, now, 'free');
    let brain = w.get('[data-testid="learning-brain"]');
    const button = w.get('[data-testid="wc-up-checkout"]');
    for (const [on, off] of [
      ['mouseenter', 'mouseleave'],
      ['focus', 'blur'],
    ] as const) {
      await button.trigger(on);
      expect(brain.attributes('data-preview')).toBe('on');
      expect(count(w, '[data-testid="ring-today"]')).toBe(1);
      // Still labelled as it is: a preview, not learning.
      expect(text(w, 'wc-up-state')).toBe('Not learning yet');
      expect(brain.attributes('data-state')).toBe('waiting');
      await button.trigger(off);
      expect(brain.attributes('data-preview')).toBeUndefined();
      expect(count(w, '[data-testid="ring-todo"]')).toBe(7);
    }
    mounted!.unmount();

    reducedMotion(true);
    mockFetch(freeRoutes(K8S));
    ({ w } = await open(WhatChangedPage, `/what-changed?cluster=${K8S.id}`, now, 'free'));
    brain = w.get('[data-testid="learning-brain"]');
    await w.get('[data-testid="wc-up-checkout"]').trigger('mouseenter');
    await w.get('[data-testid="wc-up-checkout"]').trigger('focus');
    expect(brain.attributes('data-motion')).toBe('off');
    expect(brain.attributes('data-preview')).toBeUndefined();
    expect(count(w, '[data-testid="ring-todo"]')).toBe(7);
  });

  it('the roles: an Owner upgrades (Checkout, or Plan & billing while billing is off); an Admin and a Viewer ask an Owner', async () => {
    reducedMotion(false);
    mockFetch(freeRoutes(K8S, { ...LIVE, live: false }));
    let { w } = await open(WhatChangedPage, `/what-changed?cluster=${K8S.id}`, now, 'free');
    expect(w.get('[data-testid="wc-up-plan"]').attributes('href')).toBe('/settings?tab=billing');
    await w.get('[data-testid="wc-up-plan"]').trigger('focus');
    expect(w.get('[data-testid="learning-brain"]').attributes('data-preview')).toBe('on');
    mounted!.unmount();
    for (const role of ['admin', 'viewer'] as const) {
      const { calls } = mockFetch(freeRoutes(K8S, null));
      ({ w } = await open(WhatChangedPage, `/what-changed?cluster=${K8S.id}`, now, 'free', role));
      expect(text(w, 'wc-up-ask')).toBe('Ask an Owner to upgrade');
      expect(text(w, 'wc-up-owners')).toContain('Grace Hopper');
      expect(w.find('[data-testid="wc-up-checkout"]').exists()).toBe(false);
      expect(w.find('[data-testid="wc-up-plan"]').exists()).toBe(false);
      // The same hero and the same date for them.
      expect(text(w, 'wc-up-state')).toBe('Not learning yet');
      expect(text(w, 'wc-up-ready')).toContain("it's ready on");
      expect(calls.some((x) => x.method !== 'GET')).toBe(false);
      mounted!.unmount();
    }
    mounted = null;
  });

  it.each([K8S, FLEET])(
    'Community, $kind: the same hero with "Try WatchLog Cloud", and no date it can’t keep',
    async (c) => {
      reducedMotion(false);
      const { calls } = mockFetch({
        'GET /api/v1/clusters': { status: 200, body: { clusters: [c] } },
        [`GET /api/v1/alerts?view=firing&clusterId=${c.id}&limit=5`]: noAlerts,
        [`GET /api/v1/alerts?view=history&clusterId=${c.id}&limit=5`]: noAlerts,
      });
      const { w } = await open(WhatChangedPage, `/what-changed?cluster=${c.id}`, now, 'community');
      expect(w.get('[data-testid="learning-brain"]').attributes('data-state')).toBe('waiting');
      expect(text(w, 'wc-up-state')).toBe('Not learning yet');
      expect(w.get('[data-testid="wc-up-hero"]').text()).toContain(
        'It is part of WatchLog Cloud Pro.',
      );
      const ready = text(w, 'wc-up-ready');
      expect(ready).toContain(c.kind === 'server' ? `on ${c.name}` : `in ${c.name}`);
      expect(ready).toContain('not in a self-hosted install');
      expect(ready).not.toMatch(/ready on|today|\b\d{1,2} (Nov|Dec)\b/);
      expect(w.get('[data-testid="wc-upgrade"]').text()).not.toContain(
        readyParts(readyIfStartedAt(now)).date,
      );
      expect(w.get('[data-testid="wc-up-cloud"]').text()).toContain('Try WatchLog Cloud');
      expect(count(w, '[data-testid="wc-week-grid"] [data-state="todo"]')).toBe(168);
      // Nothing is asked of Cloud, and nothing of What changed.
      expect(calls.every((x) => x.method === 'GET' && !x.path.includes('what-changed'))).toBe(true);
    },
  );
});

// ------------------------------------------------------------------------------ Checkout's return

describe('after Checkout', () => {
  it('Upgrade remembers where it was pressed, and the router brings the browser back there', async () => {
    reducedMotion(false);
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [K8S] } },
      [wc(K8S, START)]: PRO_FEATURE,
      [`GET /api/v1/alerts?view=firing&clusterId=${K8S.id}&limit=5`]: noAlerts,
      [`GET /api/v1/alerts?view=history&clusterId=${K8S.id}&limit=5`]: noAlerts,
      'GET /api/v1/plan': { status: 200, body: FREE },
      'GET /api/v1/plan/billing': { status: 200, body: LIVE },
      'POST /api/v1/plan/checkout': { status: 200, body: { url: 'https://checkout.stripe.com/x' } },
    });
    const { w, plugins } = await open(
      WhatChangedPage,
      `/what-changed?cluster=${K8S.id}`,
      START,
      'free',
    );
    await w.get('[data-testid="wc-up-checkout"]').trigger('click');
    await flushPromises();
    expect(leaveFor).toHaveBeenCalledWith('https://checkout.stripe.com/x');
    // Stripe returns to Plan & billing; the guard sends that to What changed, once.
    installCheckoutReturn(plugins.router);
    await plugins.router.push('/settings?tab=billing&checkout=done');
    expect(plugins.router.currentRoute.value.name).toBe('what-changed');
    expect(plugins.router.currentRoute.value.query).toMatchObject({
      cluster: K8S.id,
      checkout: 'done',
    });
    await plugins.router.push('/settings?tab=billing&checkout=done');
    expect(plugins.router.currentRoute.value.name).toBe('settings');
    // A Checkout started on Plan & billing stays there, and so does a cancelled one from here.
    rememberCheckoutOrigin(K8S.id, START);
    await plugins.router.push('/settings?tab=billing&checkout=cancelled');
    expect(plugins.router.currentRoute.value.query.checkout).toBe('cancelled');
    expect(plugins.router.currentRoute.value.name).toBe('what-changed');
  });

  it('back with checkout=done: the hero says so, asks again, and turns into day 1 without a reload', async () => {
    reducedMotion(false);
    const day1 = learningAt('kubernetes', START + 2 * MIN, START + 3 * MIN, {
      series: { total: null, learning: 0, readyAt: null, breakdown: {} },
    });
    const { calls } = mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [K8S] } },
      // Stripe's confirmation hasn't reached the product yet; then it has, and the worker
      // hasn't seen the org yet; then it has.
      [wc(K8S, START)]: [
        PRO_FEATURE,
        PRO_FEATURE,
        // (Dropping `checkout` from the address reads once more.)
        { status: 200, body: answer(K8S, STARTING, START + 6_000) },
        { status: 200, body: answer(K8S, STARTING, START + 6_000) },
        { status: 200, body: answer(K8S, day1, START + 16_000) },
      ],
      [`GET /api/v1/alerts?view=firing&clusterId=${K8S.id}&limit=5`]: noAlerts,
      [`GET /api/v1/alerts?view=history&clusterId=${K8S.id}&limit=5`]: noAlerts,
      [`GET /api/v1/alerts?view=firing&clusterId=${K8S.id}&limit=1`]: noAlerts,
      [`GET /api/v1/alerts?view=history&clusterId=${K8S.id}&limit=1`]: noAlerts,
      'GET /api/v1/plan': [
        { status: 200, body: FREE },
        { status: 200, body: PRO },
      ],
      'GET /api/v1/plan/billing': { status: 200, body: LIVE },
    });
    const { w, plugins } = await open(
      WhatChangedPage,
      `/what-changed?cluster=${K8S.id}&checkout=done`,
      START,
      'free',
    );
    // Still the upgrade page, saying what is about to happen.
    expect(text(w, 'wc-up-checkout-return')).toContain(
      'What changed starts learning as soon as Stripe confirms the payment',
    );
    expect(w.get('[data-testid="learning-brain"]').attributes('data-state')).toBe('waiting');
    // 3 seconds later it asks again: still Free.
    await vi.advanceTimersByTimeAsync(3_000);
    await flushPromises();
    expect(w.find('[data-testid="wc-upgrade"]').exists()).toBe(true);
    // 3 more: Pro is on. The same mounted page is now the learning page.
    await vi.advanceTimersByTimeAsync(3_000);
    await flushPromises();
    await flushPromises();
    expect(w.find('[data-testid="wc-upgrade"]').exists()).toBe(false);
    expect(text(w, 'wc-learn-day')).toBe('Learning · day 1 of 7');
    expect(text(w, 'wc-learn-ready')).toBe('Learning starts within a minute and takes 7 days.');
    expect(w.get('[data-testid="learning-brain"]').attributes('data-state')).toBe('learning');
    // The query has done its work, and the plan strip is told.
    await flushPromises();
    expect(plugins.router.currentRoute.value.query.checkout).toBeUndefined();
    expect(usePlanStore().info?.plan).toBe('pro');
    // The worker sees the org within a minute: the page picks the real date up by itself.
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    await flushPromises();
    const at = readyParts(START + 2 * MIN + 7 * DAY);
    expect(text(w, 'wc-learn-ready')).toContain(`Ready on ${at.date}, about ${at.time}`);
    expect(calls.filter((x) => x.path.includes('/what-changed?')).length).toBe(5);
  });

  it('back with checkout=cancelled: nothing was charged, and nothing is polled', async () => {
    reducedMotion(false);
    const { calls } = mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [K8S] } },
      [wc(K8S, START)]: PRO_FEATURE,
      [`GET /api/v1/alerts?view=firing&clusterId=${K8S.id}&limit=5`]: noAlerts,
      [`GET /api/v1/alerts?view=history&clusterId=${K8S.id}&limit=5`]: noAlerts,
      'GET /api/v1/plan': { status: 200, body: FREE },
      'GET /api/v1/plan/billing': { status: 200, body: LIVE },
    });
    const { w } = await open(
      WhatChangedPage,
      `/what-changed?cluster=${K8S.id}&checkout=cancelled`,
      START,
      'free',
    );
    expect(text(w, 'wc-up-checkout-return')).toBe('Checkout was cancelled; nothing was charged.');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls.filter((x) => x.path.includes('/what-changed?')).length).toBe(1);
  });
});
