// SPDX-License-Identifier: AGPL-3.0-only
// The learning week (ADR-216) in a real browser, for a Kubernetes cluster and a Server fleet:
// the learning page on day 1, 3 and 6 and in its last hour, the list with series that joined
// later, and the upgrade page's waiting hero (Cloud Free and Community) with its day-1
// preview. At 390, 1280 and 1440 px: no horizontal page scroll, the ring
// above the text on a phone, the grid scrolling inside its box; with reduced motion nothing
// animates; and the animations cost the main thread nothing worth measuring, visible or hidden.
//
// Self-contained: every API answer is a fixture and the clock is fixed, so it needs only the
// web dev server (`pnpm --filter @watchlog/web dev`, or WATCHLOG_E2E_URL), no backend and no
// data. Screenshots go to e2e/screenshots/ (git-ignored), or to WATCHLOG_E2E_SHOT_DIR.
import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const SHOT_DIR = process.env.WATCHLOG_E2E_SHOT_DIR
  ? `${process.env.WATCHLOG_E2E_SHOT_DIR.replace(/\/+$/, '')}/`
  : new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOT_DIR, { recursive: true });
const WIDTHS = [390, 1280, 1440];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The upgrade to Pro: Wednesday 18 November 2026, 14:10 in Berlin (13:10 UTC). */
const START = Date.UTC(2026, 10, 18, 13, 10, 0);
const ZONE = 'Europe/Berlin';

type Kind = 'kubernetes' | 'server';
const CLUSTERS: Record<Kind, { id: string; name: string; kind: Kind }> = {
  kubernetes: { id: '01a1de8d-e52d-7188-9878-62ee5fd5309d', name: 'acme-prod', kind: 'kubernetes' },
  server: { id: '01a18f42-06e7-7078-a01a-ea39c791d699', name: 'acme-servers', kind: 'server' },
};
const SERIES: Record<Kind, { total: number; breakdown: Record<string, number> }> = {
  kubernetes: { total: 1482, breakdown: { nodes: 6, workloads: 58, applications: 4 } },
  server: {
    total: 1284,
    breakdown: { servers: 6, services: 35, processGroups: 20, containers: 5, applications: 2 },
  },
};
const ALERT_ID = '01a19300-0000-7000-8000-000000000042';

/**
 * The API's learning answer at `nowMs` for a cluster that started at START (ADR-217): the
 * worker reads each hour when it ends, except in `gap` (the org was off Pro), whose hours are
 * learned when they come round a week later; the day is one for every 24 hours learned.
 */
function learningAt(
  kind: Kind,
  nowMs: number,
  over: Record<string, unknown> = {},
  gap?: [number, number],
) {
  const week = Array<string>(168).fill('0');
  const slot = (h: number) => new Date(h).getUTCDay() * 24 + new Date(h).getUTCHours();
  const off = (h: number) => !!gap && h >= gap[0] && h < gap[1];
  let last: number | null = null;
  let resumed: number | null = null;
  for (let h = Math.floor(START / HOUR) * HOUR; h + HOUR <= nowMs; h += HOUR) {
    if (off(h)) continue;
    week[slot(h)] = '1';
    if (last !== null && h - last > HOUR) resumed = h;
    last = h;
  }
  // Ready when the last hour of the week still missing has come round, never before 7 days.
  let until = START + 7 * DAY;
  for (let h = Math.floor(nowMs / HOUR) * HOUR, n = 0; n < 168; h += HOUR, n++) {
    if (week[slot(h)] === '0') until = Math.max(until, h + HOUR + 6 * 60_000);
  }
  const learned = week.filter((c) => c === '1').length;
  const learning = learned < 168 || nowMs < until;
  const read = nowMs >= Math.ceil(START / HOUR) * HOUR + 5 * 60_000;
  return {
    learning,
    since: new Date(START).toISOString(),
    until: new Date(until).toISOString(),
    day: Math.min(7, Math.floor(learned / 24) + 1),
    hoursLearned: learned,
    hoursTotal: 168,
    week: week.join(''),
    resumedAt: learning && resumed !== null ? new Date(resumed).toISOString() : null,
    series: {
      total: read ? SERIES[kind].total : null,
      learning: learning && read ? SERIES[kind].total : 0,
      readyAt: learning ? new Date(until).toISOString() : null,
      breakdown: read ? SERIES[kind].breakdown : {},
    },
    emailWhenReady: false,
    ...over,
  };
}

const USER = {
  id: '01a18f0e-a6c2-71ef-a7b4-42d765746d40',
  email: 'ada@acme.example',
  name: 'Ada Owner',
  locale: 'en',
  role: 'owner',
  org: { id: '01a18f0e-a6c2-71ef-a7b4-42d765746d41', name: 'Acme', slug: 'acme', plan: 'pro' },
};
const PRICE = {
  currency: 'USD',
  perNodeMonth: 3,
  minimumMonth: 15,
  annualPerNode: 30,
  annualMinimumNodes: 5,
};
const planOf = (plan: 'pro' | 'free') => ({
  plan,
  source: plan === 'pro' ? 'billing' : 'signup',
  betaUntil: null,
  proFeatures: plan === 'pro',
  limits:
    plan === 'pro'
      ? { clusters: null, nodes: null, users: 10, retentionDays: 30 }
      : { clusters: 1, nodes: 5, users: 1, retentionDays: 3 },
  usage: { clusters: 1, nodes: 4, kubernetesNodes: 4, dockerHosts: 0, users: 1 },
  period: { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z', p95: 4, peak: 4 },
  refusedNodes: 0,
  price: PRICE,
});
const ALERTS = (kind: Kind) => ({
  alerts: [
    {
      id: ALERT_ID,
      title: kind === 'server' ? 'Service failed: nginx.service on web-1' : 'CrashLoop: shop/api',
      severity: 'critical',
      state: 'firing',
      startedAt: new Date(START + 2 * DAY + 3 * HOUR).toISOString(),
      resolvedAt: null,
      cluster: CLUSTERS[kind],
      labels: {},
    },
  ],
  nextCursor: null,
  counts: { firing: 1, critical: 1, warning: 0, pending: 0, silenced: 0, held: 0 },
});
const row = (kind: Kind, i: number, minutesAgo: number, nowMs: number) => ({
  id: `01a19300-0000-7000-8000-00000000000${i}`,
  since: new Date(nowMs - minutesAgo * 60_000).toISOString(),
  until: null,
  key: kind === 'server' ? 'unit.cpu.usage' : 'workload.cpu.usage',
  unit: 'cores',
  subject: {},
  object:
    kind === 'server'
      ? { kind: 'workload', name: 'nginx.service', workloadKind: 'Service', host: 'web-1' }
      : { kind: 'workload', name: 'checkout', namespace: 'shop', workloadKind: 'Deployment' },
  peer: null,
  usualLow: 0.3,
  usualHigh: 0.5,
  value: 0.9 + i / 10,
  peakScore: 8 + i,
  peakAt: new Date(nowMs - (minutesAgo - 2) * 60_000).toISOString(),
});

interface World {
  kind: Kind;
  edition: 'cloud' | 'community';
  plan: 'pro' | 'free';
  role?: 'owner' | 'admin' | 'viewer';
  nowMs: number;
  learning?: Record<string, unknown>;
  /** Hours the org was off Pro: [from, to), each on the hour. */
  gap?: [number, number];
  rows?: number;
  billingLive?: boolean;
}

/** Answers every API request of the page from fixtures; unknown reads answer 404 and are listed. */
async function mock(context: BrowserContext, w: World, unknown: string[]) {
  const cluster = {
    ...CLUSTERS[w.kind],
    status: 'active',
    nodeCount: 6,
    agentVersion: '0.9.4',
    firstSeenAt: new Date(START - 30 * DAY).toISOString(),
    lastSeenAt: new Date(w.nowMs - 20_000).toISOString(),
    createdAt: new Date(START - 30 * DAY).toISOString(),
    ingestFailure: null,
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: status >= 400 ? 'application/problem+json' : 'application/json',
      body: JSON.stringify(body),
    });
  const problem = (status: number, title: string, type = 'about:blank') => ({
    type,
    title,
    status,
  });
  let asked = false;
  await context.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const cloud = w.edition === 'cloud';
    const learning = { ...learningAt(w.kind, w.nowMs, w.learning, w.gap), emailWhenReady: asked };
    if (path === '/setup') {
      return json(route, { required: false, demoMode: false, smtp: true });
    }
    if (path === '/auth/config') {
      return cloud
        ? json(route, {
            signup: true,
            signupMode: 'public',
            providers: { github: false, google: false },
            turnstileSiteKey: null,
            passwordMinLength: 10,
            verifyGraceDays: 7,
            supportEmail: 'support@watchlog.io',
            sampleUrl: 'https://demo.watchlog.io',
          })
        : json(route, problem(404, 'Not Found'), 404);
    }
    if (path === '/me') {
      return json(route, {
        user: {
          ...USER,
          role: w.role ?? 'owner',
          org: { ...USER.org, plan: cloud ? w.plan : 'community' },
        },
      });
    }
    if (path === '/auth/account') {
      return json(route, {
        email: USER.email,
        emailVerified: true,
        verifyBy: null,
        restriction: null,
        password: true,
        mfa: { enabled: false, required: false, recoveryCodesLeft: 0 },
        identities: [],
      });
    }
    // The sidebar's "N new" beside Egress: none.
    if (path === '/egress') return json(route, { summary: { new: 0 } });
    // No support session (404 is the answer for "none").
    if (path === '/support/current') return json(route, problem(404, 'Not Found'), 404);
    if (path === '/alerting/status') {
      return json(route, {
        running: true,
        lastCycleAt: new Date(w.nowMs - 20_000).toISOString(),
        workers: 1,
        publicUrlConfigured: true,
        smtpConfigured: true,
      });
    }
    if (path === '/orgs') {
      return json(route, {
        orgs: [
          { id: USER.org.id, name: 'Acme', slug: 'acme', role: w.role ?? 'owner', current: true },
        ],
      });
    }
    if (path === '/org/status') {
      return json(route, {
        deletion: null,
        suspension: null,
        inactivity: null,
        lastDataAt: new Date(w.nowMs - 20_000).toISOString(),
      });
    }
    if (path === '/clusters') return json(route, { clusters: [cluster] });
    if (path === '/plan') return json(route, planOf(w.plan));
    if (path === '/plan/billing') {
      return json(route, {
        available: true,
        live: w.billingLive ?? true,
        subscription: null,
        dunning: null,
        billingStartsAt: null,
      });
    }
    if (path === '/users') {
      return json(route, { users: [{ name: 'Ada Owner', email: USER.email, role: 'owner' }] });
    }
    if (path === '/applications') return json(route, { applications: [] });
    if (path === '/alerts') return json(route, ALERTS(w.kind));
    if (path === '/what-changed/learning') {
      if (!cloud) return json(route, problem(404, 'Not Found'), 404);
      if (w.plan === 'free') {
        return json(route, problem(403, 'Pro', 'urn:watchlog:problem:pro-feature'), 403);
      }
      return json(route, { learning });
    }
    if (path === '/what-changed/ready-email' && req.method() === 'PUT') {
      asked = (req.postDataJSON() as { enabled: boolean }).enabled;
      return json(route, { emailWhenReady: asked });
    }
    if (path === '/what-changed') {
      if (!cloud) return json(route, problem(404, 'Not Found'), 404);
      if (w.plan === 'free') {
        return json(route, problem(403, 'Pro', 'urn:watchlog:problem:pro-feature'), 403);
      }
      const rows = learning.learning
        ? []
        : Array.from({ length: w.rows ?? 0 }, (_, i) => row(w.kind, i, 14 - 2 * i, w.nowMs));
      const from = new Date(w.nowMs - HOUR).toISOString();
      const to = new Date(w.nowMs).toISOString();
      return json(route, {
        cluster: CLUSTERS[w.kind],
        window: { from, to, alert: null },
        sort: 'first',
        chart: {
          from,
          to,
          step: 60,
          counts: Array.from({ length: 60 }, (_, i) => (rows.length && i > 45 ? rows.length : 0)),
        },
        rows,
        total: rows.length,
        truncated: false,
        learning,
        cause: { subject: null, likely: null },
      });
    }
    if (req.method() === 'GET') unknown.push(path + url.search);
    return json(route, problem(404, 'Not Found'), 404);
  });
}

async function open(
  browser: import('@playwright/test').Browser,
  w: World,
  width: number,
  path: string,
  opts: { reducedMotion?: boolean; zone?: string } = {},
) {
  const context = await browser.newContext({
    ...viewportFor(width),
    // WATCHLOG_E2E_SCALE=2 for screenshots at twice the pixels (the docs' image).
    deviceScaleFactor: Number(process.env.WATCHLOG_E2E_SCALE ?? 1),
    timezoneId: opts.zone ?? ZONE,
    locale: 'en-GB',
    reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference',
  });
  const unknown: string[] = [];
  await mock(context, w, unknown);
  const page = await context.newPage();
  // The clock is the fixture's: "now" in the page is the scenario's minute.
  await page.clock.install({ time: new Date(w.nowMs) });
  await page.clock.resume();
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}cluster=${CLUSTERS[w.kind].id}`);
  await page.waitForLoadState('networkidle');
  await page
    .waitForFunction(() => !document.querySelector('[data-skeleton], [aria-busy="true"]'))
    .catch(() => {});
  return { context, page, unknown };
}

async function shoot(page: Page, name: string, width: number) {
  // The shell scrolls inside its own box: make the window as tall as the page's content, so
  // the screenshot shows all of it.
  const before = page.viewportSize()!;
  const extra = await page.evaluate(() => {
    let el = document.querySelector('[data-testid="wc-title"], [data-testid="wc-upgrade"]');
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (/auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight) {
        return el.scrollHeight - el.clientHeight;
      }
      el = el.parentElement;
    }
    return 0;
  });
  if (extra > 0) await page.setViewportSize({ width, height: before.height + extra });
  // The animations are caught mid-cycle: let them run a moment, the same for every shot.
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOT_DIR}${name}-${width}.png`, fullPage: true });
  if (extra > 0) await page.setViewportSize(before);
}

async function noPageScroll(page: Page, name: string, width: number) {
  const problems = await layoutProblems(page);
  expect(problems.length ? report(name, width, problems) : '').toBe('');
}

const DAYS: [string, number, { day: number; hours: number }][] = [
  ['day1', START + 3 * HOUR + 10 * 60_000, { day: 1, hours: 3 }],
  ['day3', START + 2 * DAY + 13 * HOUR, { day: 3, hours: 61 }],
  ['day6', START + 5 * DAY + 6 * HOUR, { day: 6, hours: 126 }],
  ['last-hour', START + 7 * DAY - 38 * 60_000, { day: 7, hours: 167 }],
];

for (const kind of ['kubernetes', 'server'] as Kind[]) {
  for (const [name, nowMs, want] of DAYS) {
    test(`${kind}: the learning page, ${name}`, async ({ browser }) => {
      for (const width of WIDTHS) {
        const { context, page, unknown } = await open(
          browser,
          { kind, edition: 'cloud', plan: 'pro', nowMs },
          width,
          '/what-changed',
        );
        const root = page.getByTestId('wc-learning');
        await expect(root).toBeVisible();
        await expect(page.getByTestId('wc-learn-day')).toHaveText(
          `Learning · day ${want.day} of 7`,
        );
        await expect(page.getByTestId('wc-learn-ready')).toContainText(
          'Ready on Wed 25 Nov, about 14:10',
        );
        await expect(page.getByTestId('wc-learn-bar')).toHaveAttribute(
          'aria-valuenow',
          String(want.hours),
        );
        await expect(page.getByTestId('wc-tile-hours')).toContainText(`${want.hours} of 168`);
        await expect(page.getByTestId('wc-tile-series')).toContainText(
          kind === 'server'
            ? '6 servers · 35 services · 20 process groups'
            : '6 nodes · 58 workloads',
        );
        await expect(page.locator('[data-testid="ring-done"]')).toHaveCount(want.day - 1);
        await expect(page.locator('[data-testid="ring-today"]')).toHaveCount(1);
        await expect(
          page.locator('[data-testid="wc-week-grid"] [data-state="learned"]'),
        ).toHaveCount(want.hours);
        await expect(page.locator('[data-testid="wc-week-grid"] [data-state="now"]')).toHaveCount(
          1,
        );
        // The sidebar says which day it is (below 1024 px it is a drawer, closed here).
        if (width >= 1024) {
          await expect(page.getByTestId('nav-learning')).toContainText(`day ${want.day}/7`);
        }
        // Nothing is listed, and no window to pick.
        await expect(page.getByTestId('wc-windows')).toHaveCount(0);
        await expect(page.getByTestId('learning-brain')).toHaveAttribute('data-motion', 'on');
        // The ring above the text on a phone, beside it on a desktop.
        const ring = (await page.getByTestId('learning-brain').boundingBox())!;
        const title = (await page.locator('#wc-learn-title').boundingBox())!;
        if (width < 768) expect(ring.y + ring.height).toBeLessThanOrEqual(title.y);
        else expect(ring.x + ring.width).toBeLessThanOrEqual(title.x);
        // The grid scrolls inside its box on a phone; the page never scrolls sideways.
        const scroll = page.getByTestId('wc-week-scroll');
        const overflows = await scroll.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
        expect(overflows).toBe(width < 768);
        await noPageScroll(page, `learning-${kind}-${name}`, width);
        await shoot(page, `s094-learning-${kind}-${name}`, width);
        expect(unknown, 'API paths the fixtures did not answer').toEqual([]);
        await context.close();
      }
    });
  }

  test(`${kind}: the list with series that joined later`, async ({ browser }) => {
    const nowMs = START + 9 * DAY;
    const readyAt = new Date(nowMs + 5 * DAY + 2 * HOUR).toISOString();
    for (const width of WIDTHS) {
      const { context, page } = await open(
        browser,
        {
          kind,
          edition: 'cloud',
          plan: 'pro',
          nowMs,
          rows: 3,
          learning: {
            series: {
              total: SERIES[kind].total + 12,
              learning: 12,
              readyAt,
              breakdown: SERIES[kind].breakdown,
            },
          },
        },
        width,
        '/what-changed',
      );
      await expect(page.getByTestId('wc-partly')).toContainText('12 of');
      await expect(page.getByTestId('wc-partly')).toContainText('still learning');
      await expect(page.locator('[data-testid="wc-row"]')).toHaveCount(3);
      await expect(page.getByTestId('wc-learning')).toHaveCount(0);
      await expect(page.getByTestId('nav-learning')).toHaveCount(0);
      await noPageScroll(page, `partly-${kind}`, width);
      await shoot(page, `s094-partly-${kind}`, width);
      await context.close();
    }
  });

  test(`${kind}: the upgrade page's hero, waiting (Cloud Free), and the day-1 preview`, async ({
    browser,
  }) => {
    const nowMs = START;
    for (const width of WIDTHS) {
      const { context, page, unknown } = await open(
        browser,
        { kind, edition: 'cloud', plan: 'free', nowMs },
        width,
        '/what-changed',
      );
      const brain = page.getByTestId('learning-brain');
      await expect(brain).toHaveAttribute('data-state', 'waiting');
      await expect(page.getByTestId('wc-up-state')).toHaveText('Not learning yet');
      await expect(page.getByTestId('wc-up-ready')).toHaveText(
        "Upgrade today and it's ready on Wed 25 Nov.",
      );
      await expect(page.locator('[data-testid="ring-todo"]')).toHaveCount(7);
      await expect(page.locator('[data-testid="wc-week-grid"] [data-state="todo"]')).toHaveCount(
        168,
      );
      await expect(page.getByTestId('wc-up-fine')).toContainText('$3 per');
      await expect(page.getByTestId('nav-learning')).toHaveCount(0);
      await noPageScroll(page, `upgrade-${kind}`, width);
      await shoot(page, `s094-upgrade-${kind}`, width);
      if (width >= 1024) {
        // Hovering Upgrade previews day 1: the first segment fills and the brain brightens.
        await page.getByTestId('wc-up-checkout').hover();
        await expect(brain).toHaveAttribute('data-preview', 'on');
        await expect(page.locator('[data-testid="ring-today"]')).toHaveCount(1);
        await shoot(page, `s094-upgrade-${kind}-preview`, width);
        await page.mouse.move(0, 0);
        await expect(brain).not.toHaveAttribute('data-preview', 'on');
      }
      expect(unknown, 'API paths the fixtures did not answer').toEqual([]);
      await context.close();
    }
  });
}

for (const kind of ['kubernetes', 'server'] as Kind[]) {
  test(`${kind}: a week with a gap: two hours of Pro, two days off, Pro again`, async ({
    browser,
  }) => {
    // As WatchLog Cloud's own fleet on 18 November: 2 hours learned, 46 hours off, resumed.
    const first = Math.floor(START / HOUR) * HOUR;
    const gap: [number, number] = [first + 2 * HOUR, first + 2 * DAY];
    const nowMs = START + 2 * DAY + 2 * HOUR;
    for (const width of WIDTHS) {
      const { context, page } = await open(
        browser,
        { kind, edition: 'cloud', plan: 'pro', nowMs, gap },
        width,
        '/what-changed',
      );
      // The top and the bottom agree: day 1, 4 hours, and ready a week after it resumed.
      await expect(page.getByTestId('wc-learn-day')).toHaveText('Learning · day 1 of 7');
      await expect(page.getByTestId('wc-learn-bar')).toHaveAttribute('aria-valuenow', '4');
      await expect(page.getByTestId('wc-tile-hours')).toContainText('4 of 168');
      await expect(page.getByTestId('wc-learn-ready')).toContainText('Ready on Fri 27 Nov');
      await expect(page.getByTestId('wc-learn-ready')).not.toContainText('25 Nov');
      await expect(page.getByTestId('wc-learn-resumed')).toContainText(
        'Learning resumed on Fri 20 Nov',
      );
      await expect(page.locator('[data-testid="ring-done"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="ring-part"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="wc-week-grid"] [data-state="learned"]')).toHaveCount(
        4,
      );
      if (width >= 1024) await expect(page.getByTestId('nav-learning')).toContainText('day 1/7');
      await noPageScroll(page, `gap-${kind}`, width);
      await shoot(page, `s096-learning-${kind}-gap`, width);
      await context.close();
    }
  });
}

test('Community: the same hero, "Try WatchLog Cloud", and no date', async ({ browser }) => {
  for (const width of WIDTHS) {
    const { context, page } = await open(
      browser,
      { kind: 'kubernetes', edition: 'community', plan: 'free', nowMs: START },
      width,
      '/what-changed',
    );
    await expect(page.getByTestId('learning-brain')).toHaveAttribute('data-state', 'waiting');
    await expect(page.getByTestId('wc-up-cloud')).toHaveText(/Try WatchLog Cloud/);
    await expect(page.getByTestId('wc-up-ready')).not.toContainText('ready on');
    await expect(page.getByTestId('wc-up-ready')).not.toContainText('Nov');
    await noPageScroll(page, 'upgrade-community', width);
    await shoot(page, 's094-upgrade-community', width);
    await context.close();
  }
});

test('reduced motion: nothing animates, the same information; no preview on the upgrade page', async ({
  browser,
}) => {
  const nowMs = START + 2 * DAY + 13 * HOUR;
  let { context, page } = await open(
    browser,
    { kind: 'server', edition: 'cloud', plan: 'pro', nowMs },
    1280,
    '/what-changed',
    { reducedMotion: true },
  );
  await expect(page.getByTestId('learning-brain')).toHaveAttribute('data-motion', 'off');
  const running = await page.evaluate(
    () => document.getAnimations().filter((a) => a.playState === 'running').length,
  );
  expect(running).toBe(0);
  await expect(page.getByTestId('wc-learn-day')).toHaveText('Learning · day 3 of 7');
  await expect(page.locator('[data-testid="ring-done"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="ring-today"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="wc-week-grid"] [data-state="now"]')).toHaveCount(1);
  await shoot(page, 's094-learning-server-day3-reduced-motion', 1280);
  await context.close();

  ({ context, page } = await open(
    browser,
    { kind: 'server', edition: 'cloud', plan: 'free', nowMs: START },
    1280,
    '/what-changed',
    { reducedMotion: true },
  ));
  await page.getByTestId('wc-up-checkout').hover();
  await expect(page.getByTestId('learning-brain')).not.toHaveAttribute('data-preview', 'on');
  await expect(page.locator('[data-testid="ring-todo"]')).toHaveCount(7);
  expect(
    await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === 'running').length,
    ),
  ).toBe(0);
  await context.close();
});

test('a time zone off by half an hour: the times are the viewer’s, the grid says it rounds', async ({
  browser,
}) => {
  const { context, page } = await open(
    browser,
    { kind: 'server', edition: 'cloud', plan: 'pro', nowMs: START + 2 * DAY + 13 * HOUR },
    1280,
    '/what-changed',
    { zone: 'Asia/Tehran' },
  );
  await expect(page.getByTestId('wc-learn-ready')).toContainText(
    'Ready on Wed 25 Nov, about 16:40',
  );
  await expect(page.getByTestId('wc-week-zone')).toHaveText(
    'Hours are in your time zone (UTC+3:30), to the nearest hour.',
  );
  await context.close();
});

test('"Email me when it’s ready": the button shows its state and can be undone', async ({
  browser,
}) => {
  const { context, page } = await open(
    browser,
    { kind: 'kubernetes', edition: 'cloud', plan: 'pro', nowMs: START + DAY },
    1280,
    '/what-changed',
  );
  const button = page.getByTestId('wc-learn-email');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toContainText('We’ll email you'.replace('’', "'"));
  await expect(page.getByTestId('wc-learn-undo')).toContainText('ada@acme.example');
  await shoot(page, 's094-learning-kubernetes-email-on', 1280);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await context.close();
});

test('the animations cost the main thread next to nothing, visible, and nothing when hidden', async ({
  browser,
}) => {
  const { context, page } = await open(
    browser,
    { kind: 'server', edition: 'cloud', plan: 'pro', nowMs: START + 2 * DAY + 13 * HOUR },
    1280,
    '/what-changed',
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const busy = async (ms: number) => {
    const read = async () => {
      const { metrics } = await cdp.send('Performance.getMetrics');
      const of = (n: string) => metrics.find((m) => m.name === n)?.value ?? 0;
      return {
        task: of('TaskDuration'),
        script: of('ScriptDuration'),
        layout: of('LayoutDuration'),
      };
    };
    const a = await read();
    await page.waitForTimeout(ms);
    const b = await read();
    return {
      task: (b.task - a.task) / (ms / 1000),
      script: (b.script - a.script) / (ms / 1000),
      layout: (b.layout - a.layout) / (ms / 1000),
    };
  };
  // After the folds' one-time draw-in (2.6 s from the page opening).
  await page.waitForTimeout(4000);
  const visible = await busy(5000);
  // Hidden: the page says so, and every animation is paused.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByTestId('learning-brain')).toHaveAttribute('data-motion', 'paused');
  const runningHidden = await page.evaluate(
    () => document.getAnimations().filter((a) => a.playState === 'running').length,
  );
  const hidden = await busy(5000);
  console.log(
    `main thread busy per second: visible ${(visible.task * 100).toFixed(2)} % (script ${(visible.script * 100).toFixed(2)} %, layout ${(visible.layout * 100).toFixed(2)} %), hidden ${(hidden.task * 100).toFixed(2)} %; running animations when hidden: ${runningHidden}`,
  );
  expect(runningHidden).toBe(0);
  // Every moving part is a compositor layer: the main thread does next to nothing while they
  // run (animating the folds' strokes instead measured 6 %). The bound leaves room for a slow
  // machine and for the page's own timers.
  expect(visible.task).toBeLessThan(0.02);
  expect(visible.script).toBeLessThan(0.01);
  expect(visible.layout).toBeLessThan(0.01);
  expect(hidden.task).toBeLessThan(0.02);
  await context.close();
});
