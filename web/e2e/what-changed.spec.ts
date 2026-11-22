// SPDX-License-Identifier: AGPL-3.0-only
// What changed after the learning week (0.14.0, ADR-231) in a real browser, at 1440 and 390 px,
// on a Kubernetes cluster and a Server fleet: the live line and the map, an episode with a
// linked change (the story, its cause, how it spread, what moved with its band sparkline, why),
// an older episode with no clear cause through the switcher, the quiet page with the last 7
// days, and WatchLog's own parts hidden by default and shown when the toggle is off. Every
// page passes the layout checks.
//
// Against a running Cloud-mode dashboard whose org is Pro, with three places seeded: a
// Kubernetes cluster (a rollout, then three series; an older episode in another workload;
// WatchLog's own backend), a Server fleet (a scheduled run, then the server and its services)
// and a quiet cluster:
//   WATCHLOG_E2E_URL=http://localhost:4198 WATCHLOG_E2E_EMAIL=… WATCHLOG_E2E_PASSWORD=… \
//   WATCHLOG_E2E_KUBE=<id> WATCHLOG_E2E_FLEET=<id> WATCHLOG_E2E_QUIET=<id> \
//     pnpm exec playwright test e2e/what-changed.spec.ts
// WATCHLOG_E2E_SHOT_DIR saves a screenshot of each state; WATCHLOG_E2E_THEME=light.
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;
const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const THEME = process.env.WATCHLOG_E2E_THEME === 'light' ? 'light' : 'dark';
const KUBE = process.env.WATCHLOG_E2E_KUBE ?? '';
const FLEET = process.env.WATCHLOG_E2E_FLEET ?? '';
const QUIET = process.env.WATCHLOG_E2E_QUIET ?? '';

// One sign-in per worker: the session cookies are reused, so a run stays under the login limit.
let session: Awaited<ReturnType<ReturnType<Page['context']>['cookies']>> | null = null;
async function signIn(page: Page) {
  if (!email || !password) throw new Error('set WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD');
  if (session) {
    await page.context().addCookies(session);
    return;
  }
  for (let i = 0; ; i++) {
    const res = await page.request.post('/api/v1/auth/login', {
      // Cloud's test Turnstile key accepts this token.
      data: { email, password, turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' },
    });
    if (res.status() === 429 && i < 3) {
      await page.waitForTimeout(Number(res.headers()['retry-after'] ?? 5) * 1000 + 500);
      continue;
    }
    expect(res.ok(), await res.text()).toBe(true);
    session = await page.context().cookies();
    return;
  }
}
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${THEME}-${name}.png`, fullPage: true });
}
async function layoutOk(page: Page, where: string) {
  const problems = await layoutProblems(page);
  expect(problems, report(where, page.viewportSize()?.width ?? 0, problems)).toEqual([]);
}
async function setup(page: Page, width: number) {
  await page.setViewportSize(width < 1024 ? viewportFor(width).viewport : { width, height: 1100 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-started')) return;
    sessionStorage.setItem('e2e-started', '1');
    localStorage.removeItem('watchlog.whatChanged.hideOwn');
  });
  await signIn(page);
}

for (const width of [1440, 390]) {
  test(`Kubernetes, ${width} px: a linked rollout, no clear cause, WatchLog's own parts`, async ({
    page,
  }) => {
    test.skip(!KUBE, 'set WATCHLOG_E2E_KUBE');
    await setup(page, width);
    await page.goto(`/what-changed?cluster=${KUBE}&window=6h`);
    // The header: the live line, the toggle on.
    await expect(page.getByTestId('wc-live')).toHaveText(
      /Watching \d+ series · checked \d+ s ago$/,
    );
    const own = page.getByTestId('wc-own');
    await expect(own).toHaveAttribute('aria-pressed', 'true');
    await expect(own).toContainText("Hide WatchLog's own parts (1)");
    // The map: workloads, the one outside first, the counts, the footer.
    const groups = page.getByTestId('wc-map-group');
    await expect(groups.first()).toHaveAttribute('data-outside', '1');
    await expect(page.getByTestId('wc-map-counts')).toContainText('1 outside');
    // The footer's learning count is the strip's (none here: every series has learned).
    await expect(page.getByTestId('wc-map-foot')).toContainText('Checked every minute inside');
    await expect(page.getByTestId('wc-map')).not.toContainText('watchlog/watchlog-backend');
    // The story: after the rollout of backend, its cause box green, the switcher on 2 of 2.
    await expect(page.getByTestId('wc-story-sentence')).toContainText(
      'after the rollout of backend',
    );
    await expect(page.getByTestId('wc-cause-box')).toHaveAttribute('data-state', 'likely');
    await expect(page.getByTestId('wc-episode-of')).toHaveText('2 of 2');
    // How it spread: the rollout first, then the series, with the minutes between.
    await expect(page.getByTestId('wc-chain-node').first()).toHaveAttribute('data-kind', 'change');
    await expect(page.getByTestId('wc-chain-node')).toHaveCount(4);
    // What moved: band sparklines and the chip; why: the checks, what changed around then.
    await expect(page.getByTestId('wc-spark').first()).toBeVisible();
    await expect(page.getByTestId('wc-factor').first()).toHaveText(/× usual$/);
    await expect(page.getByTestId('wc-around')).toContainText('The rollout of backend');
    await expect(page.getByTestId('wc-checks')).toBeVisible();
    // The chart: two episodes, the selected one pressed, the change markers.
    await expect(page.getByTestId('wc-chart-band')).toHaveCount(2);
    await expect(page.getByTestId('wc-chart-marker').first()).toBeAttached();
    await layoutOk(page, `kubernetes ${width} linked`);
    await shot(page, `kubernetes-${width}-linked`);

    // The older episode: no clear cause, named checks or "nothing found", never a bare count.
    await page.getByTestId('wc-episode-prev').click();
    await expect(page.getByTestId('wc-episode-of')).toHaveText('1 of 2');
    await expect(page.getByTestId('wc-story-sentence')).toContainText('moved first');
    const box = page.getByTestId('wc-cause-box');
    await expect(box).toHaveAttribute('data-state', 'none');
    await expect(box).toContainText('No clear cause');
    await expect(box).not.toContainText(/\d+ of them found/);
    await layoutOk(page, `kubernetes ${width} no clear cause`);
    await shot(page, `kubernetes-${width}-no-cause`);

    // WatchLog's own parts: off, then on again; remembered. (On a phone the map folds after
    // 6 groups, so the own group may be among "N more": the series count says it is back.)
    const title = page.locator('#wc-map-title');
    const hiddenTitle = (await title.textContent()) ?? '';
    await page.getByTestId('wc-own').click();
    await expect(page.getByTestId('wc-own')).toHaveAttribute('aria-pressed', 'false');
    await expect(title).not.toHaveText(hiddenTitle);
    if (width >= 1024)
      await expect(page.getByTestId('wc-map')).toContainText('watchlog/watchlog-backend');
    await shot(page, `kubernetes-${width}-own-shown`);
    await page.reload();
    await expect(page.getByTestId('wc-own')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('wc-own').click();
    await expect(page.getByTestId('wc-map')).not.toContainText('watchlog/watchlog-backend');
  });

  test(`Server fleet, ${width} px: a scheduled run as the cause, in the fleet's words`, async ({
    page,
  }) => {
    test.skip(!FLEET, 'set WATCHLOG_E2E_FLEET');
    await setup(page, width);
    await page.goto(`/what-changed?cluster=${FLEET}&window=6h`);
    await expect(page.getByTestId('wc-map-group').first()).toContainText('db-1');
    await expect(page.getByTestId('wc-map')).toContainText('postgresql.service · db-1');
    await expect(page.getByTestId('wc-story-sentence')).toContainText(
      'backup.timer running on db-1',
    );
    await expect(page.getByTestId('wc-cause-box')).toHaveAttribute('data-state', 'likely');
    await expect(page.getByTestId('wc-cause-box')).toContainText('backup.timer running on db-1 at');
    await expect(page.getByTestId('wc-chain-node').first()).toContainText('Scheduled run');
    await expect(page.getByTestId('wc-spark').first()).toBeVisible();
    await layoutOk(page, `fleet ${width}`);
    await shot(page, `fleet-${width}`);
  });

  test(`quiet, ${width} px: all inside, the last 7 days`, async ({ page }) => {
    test.skip(!QUIET, 'set WATCHLOG_E2E_QUIET');
    await setup(page, width);
    await page.goto(`/what-changed?cluster=${QUIET}&window=6h`);
    await expect(page.getByTestId('wc-quiet')).toContainText(
      'are inside their usual range for this hour',
    );
    await expect(page.getByTestId('wc-map-counts')).toContainText('0 outside');
    await expect(page.getByTestId('wc-quiet-card')).toHaveCount(1);
    await layoutOk(page, `quiet ${width}`);
    await shot(page, `quiet-${width}`);
    // A past episode opens in a window around it, selected.
    await page.getByTestId('wc-quiet-see').click();
    await expect(page).toHaveURL(/window=custom.*episode=\d+|episode=\d+.*window=custom/);
    await expect(page.getByTestId('wc-story')).toBeVisible();
  });
}
