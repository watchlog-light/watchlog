// SPDX-License-Identifier: AGPL-3.0-only
// The Enterprise licence in a real browser (ADR-232), at 1440 and 390 px: Settings › License
// in the state the instance's key is in (valid, expiring, grace, expired, over the limit), the
// Owners' banner, the About line in the account menu; with a working key, What changed's
// learning week and All clusters and fleets open instead of their upgrade pages. Every page
// passes the layout checks.
//
// Against a running self-hosted (Community) dashboard whose backend trusts a test public key
// and holds a key in the given state (pasted, or from the environment for an ended key):
//   WATCHLOG_E2E_URL=http://localhost:4288 WATCHLOG_E2E_EMAIL=… WATCHLOG_E2E_PASSWORD=… \
//   WATCHLOG_E2E_LICENSE_STATE=valid WATCHLOG_E2E_CLUSTER=<id> \
//     pnpm exec playwright test e2e/license.spec.ts
// WATCHLOG_E2E_SHOT_DIR saves a screenshot of each; WATCHLOG_E2E_THEME=light.
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;
const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const THEME = process.env.WATCHLOG_E2E_THEME === 'light' ? 'light' : 'dark';
const STATE = process.env.WATCHLOG_E2E_LICENSE_STATE ?? 'valid';
const CLUSTER = process.env.WATCHLOG_E2E_CLUSTER ?? '';

/** What each state shows: the badge, the banner (none for a valid key within its units). */
const EXPECT: Record<string, { badge: string; banner: string | null; text: RegExp }> = {
  valid: { badge: 'valid', banner: null, text: /Licensed features are on until/ },
  expiring: { badge: 'expiring', banner: 'expiring', text: /Ask us for a new key/ },
  grace: { badge: 'grace', banner: 'grace', text: /keep working until/ },
  expired: { badge: 'expired', banner: 'ended', text: /nothing was deleted/ },
  over: { badge: 'valid', banner: 'over', text: /Licensed features are on until/ },
};

let session: Awaited<ReturnType<ReturnType<Page['context']>['cookies']>> | null = null;
/** A session from an earlier sign-in (WATCHLOG_E2E_SESSION=wl_session=…): no login per run. */
const GIVEN = process.env.WATCHLOG_E2E_SESSION?.replace(/^wl_session=/, '');
async function signIn(page: Page) {
  if (GIVEN && !session) {
    const url = process.env.WATCHLOG_E2E_URL ?? 'http://localhost:4088';
    session = [{ name: 'wl_session', value: GIVEN, url } as never];
  }
  if (session) return page.context().addCookies(session);
  if (!email || !password) throw new Error('set WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD');
  const res = await page.request.post('/api/v1/auth/login', { data: { email, password } });
  expect(res.ok(), await res.text()).toBe(true);
  session = await page.context().cookies();
}
async function shot(page: Page, name: string) {
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/${THEME}-${STATE}-${name}.png`, fullPage: true });
}
async function layoutOk(page: Page, where: string) {
  const problems = await layoutProblems(page);
  expect(problems, report(where, page.viewportSize()?.width ?? 0, problems)).toEqual([]);
}
async function setup(page: Page, width: number) {
  await page.setViewportSize(width < 1024 ? viewportFor(width).viewport : { width, height: 1000 });
  await signIn(page);
}

for (const width of [1440, 390]) {
  test(`Settings › License, ${STATE}, ${width} px: the facts, the state, the banner`, async ({
    page,
  }) => {
    const want = EXPECT[STATE]!;
    await setup(page, width);
    await page.goto('/settings?tab=license');
    await expect(page.getByTestId('license-state')).toHaveAttribute('data-state', want.badge);
    await expect(page.getByTestId('license-state-text')).toHaveText(want.text);
    await expect(page.getByTestId('license-customer')).toHaveText('Acme Logistics GmbH');
    await expect(page.getByTestId('license-units')).toContainText(/\d+ of \d+ units/);
    await expect(page.getByTestId('license-features')).toContainText('Pro features');
    if (want.banner) {
      await expect(page.getByTestId('license-banner')).toHaveAttribute('data-kind', want.banner);
    } else {
      await expect(page.getByTestId('license-banner')).toHaveCount(0);
    }
    if (STATE === 'over') {
      await expect(page.getByTestId('license-over')).toContainText(
        /\d+ of 2 units\. Your licence covers 2; contact us for a larger one\./,
      );
    }
    await layoutOk(page, `license ${STATE} ${width}`);
    await shot(page, `license-${width}`);
  });

  test(`the About line, ${STATE}, ${width} px`, async ({ page }) => {
    await setup(page, width);
    await page.goto('/settings?tab=license');
    if (width < 1024) await page.getByTestId('nav-open').click();
    await page.getByTestId('account-menu-button').locator('visible=true').first().click();
    await expect(page.getByTestId('account-about')).toHaveText(
      'WatchLog Enterprise, licensed to Acme Logistics GmbH',
    );
    await shot(page, `about-${width}`);
  });

  test(`Pro pages, ${STATE}, ${width} px: on with a working key, "ended" after`, async ({
    page,
  }) => {
    test.skip(!CLUSTER, 'set WATCHLOG_E2E_CLUSTER');
    await setup(page, width);
    await page.goto(`/what-changed?cluster=${CLUSTER}`);
    if (STATE === 'expired') {
      await expect(page.getByTestId('license-ended')).toContainText('Your licence ended on');
      await expect(page.getByTestId('license-ended-renew')).toBeVisible();
    } else {
      await expect(page.getByTestId('wc-learning')).toBeVisible();
    }
    await layoutOk(page, `what changed ${STATE} ${width}`);
    await shot(page, `what-changed-${width}`);
    await page.goto('/all');
    if (STATE === 'expired') {
      await expect(page.getByTestId('license-ended')).toBeVisible();
    } else {
      await expect(page.getByTestId('ac-upgrade')).toHaveCount(0);
    }
    await shot(page, `all-clusters-${width}`);
  });
}
