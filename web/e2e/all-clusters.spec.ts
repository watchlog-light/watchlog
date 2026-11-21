// SPDX-License-Identifier: AGPL-3.0-only
// All clusters and fleets (0.11, ADR-226) in a real browser, at 1440 and 390 px: Pro with
// problems (the sentence, the merged row's chips, the table, the sidebar's list, the switcher's
// first item, landing on /all), Pro all healthy, and the upgrade card for Cloud Free and
// Community. Every width passes the layout checks (no page scroll; the table scrolls in its box).
// Against a running dashboard and an account of the edition named:
//   WATCHLOG_E2E_URL=http://localhost:4198 WATCHLOG_E2E_EDITION=pro|healthy|free|community \
//   WATCHLOG_E2E_EMAIL=… WATCHLOG_E2E_PASSWORD=… pnpm exec playwright test e2e/all-clusters.spec.ts
// WATCHLOG_E2E_SHOT_DIR saves a screenshot of each state there.
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;
const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const edition = process.env.WATCHLOG_E2E_EDITION ?? 'pro';

async function signIn(page: Page) {
  if (!email || !password) throw new Error('set WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD');
  // Cloud's test Turnstile key accepts this token: sign-in is never locked by repeated runs.
  const turnstile = process.env.WATCHLOG_E2E_TURNSTILE;
  const res = await page.request.post('/api/v1/auth/login', {
    data: { email, password, ...(turnstile ? { turnstileToken: turnstile } : {}) },
  });
  expect(res.ok(), await res.text()).toBe(true);
}
const shot = (page: Page, name: string) =>
  SHOTS
    ? page.screenshot({ path: `${SHOTS}/all-clusters-${edition}-${name}.png`, fullPage: true })
    : Promise.resolve();

for (const width of [1440, 390]) {
  test(`${edition}, ${width} px`, async ({ page }) => {
    await page.setViewportSize(
      width === 1440 ? { width, height: 1000 } : viewportFor(width).viewport,
    );
    await signIn(page);
    await page.goto('/all');
    await expect(
      page.getByRole('heading', { level: 1, name: 'All clusters and fleets' }),
    ).toBeVisible();

    if (edition === 'pro') {
      await expect(page.getByTestId('ac-hero')).toHaveText(/clusters and fleets need attention$/);
      await expect(page.getByTestId('ac-hero-sub')).toContainText('share one problem');
      // The same crash loop in prod and staging: one row, a chip for each.
      const merged = page.getByTestId('ac-problem').filter({ hasText: 'payments-api' });
      await expect(merged).toHaveCount(1);
      await expect(merged.getByTestId('ac-problem-place')).toHaveCount(2);
      await expect(page.getByTestId('ac-row').first()).toBeVisible();
      await expect(page.getByTestId('ac-chore').first()).toBeVisible();
      // The table scrolls inside its box when it is wider than the screen.
      const box = page.getByTestId('ac-table-scroll');
      const fits = await box.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
      expect(fits).toBe(width >= 1024);
      if (width === 1440) {
        await expect(page.getByTestId('nav-all')).toHaveAttribute('aria-current', 'page');
        await expect(page.getByTestId('nav-env').first()).toBeVisible();
        // The filter narrows every section.
        await page
          .getByTestId('ac-filter')
          .getByRole('button', { name: /Server fleets/ })
          .click();
        await expect(page).toHaveURL(/kind=server/);
        await expect(page.getByTestId('ac-row').filter({ hasText: 'acme-prod' })).toHaveCount(0);
        await page.getByTestId('ac-filter').getByRole('button', { name: /^All/ }).click();
      }
    } else if (edition === 'healthy') {
      await expect(page.getByTestId('ac-hero')).toHaveText(
        /^All \d+ clusters and fleets are healthy$/,
      );
      await expect(page.getByTestId('ac-attention-none')).toContainText('Nothing needs attention');
      await expect(page.getByTestId('ac-changes-empty')).toBeVisible();
    } else {
      await expect(page.getByTestId('ac-upgrade')).toBeVisible();
      await expect(page.getByTestId('ac-content')).toHaveAttribute('aria-hidden', 'true');
      await expect(page.getByTestId('nav-all').or(page.getByTestId('nav-open'))).toHaveCount(1);
      if (edition === 'community')
        await expect(page.getByTestId('ac-up-cloud')).toHaveText('Try WatchLog Cloud');
      else await expect(page.getByTestId('ac-upgrade')).toContainText('Upgrade to Pro');
    }
    await shot(page, String(width));
    const problems = await layoutProblems(page);
    expect(problems, report('/all', width, problems)).toEqual([]);
  });
}

test(`${edition}: where signing in lands`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto('/');
  if (edition === 'pro' || edition === 'healthy') await expect(page).toHaveURL(/\/all$/);
  else await expect(page).not.toHaveURL(/\/all/);
});
