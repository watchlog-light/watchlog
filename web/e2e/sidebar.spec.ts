// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's footer (0.10.1) in a real browser, at 1440 and 390 px: the account menu opens
// and closes (Esc, a click outside, focus back on its button), the collapse button in the
// header, the collapsed rail's avatar opening the same menu to the right, the phone drawer's
// footer, and Sign out. Against a running dashboard, Community or Cloud:
//   WATCHLOG_E2E_URL=http://localhost:4088 WATCHLOG_E2E_EMAIL=… WATCHLOG_E2E_PASSWORD=… \
//     pnpm exec playwright test e2e/sidebar.spec.ts
// WATCHLOG_E2E_SHOT_DIR saves a screenshot of each state there.
import { expect, test, type Page } from '@playwright/test';

const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;
const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const edition = process.env.WATCHLOG_E2E_EDITION ?? 'community';

async function signIn(page: Page) {
  if (!email || !password) throw new Error('set WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD');
  const res = await page.request.post('/api/v1/auth/login', { data: { email, password } });
  expect(res.ok(), await res.text()).toBe(true);
}
const shot = (page: Page, name: string) =>
  SHOTS ? page.screenshot({ path: `${SHOTS}/${edition}-${name}.png` }) : Promise.resolve();

const menu = (page: Page) => page.getByRole('menu', { name: 'Account' });
const button = (page: Page) => page.getByTestId('account-menu-button');

test.describe('sidebar footer', () => {
  test.beforeEach(async ({ page }) => {
    // Start expanded, once: a reload keeps what the test chose.
    await page.addInitScript(() => {
      if (sessionStorage.getItem('e2e-started')) return;
      sessionStorage.setItem('e2e-started', '1');
      localStorage.removeItem('watchlog.sidebarCollapsed');
    });
  });

  test('1440 px: the menu, collapse and expand, sign out', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await page.goto('/settings');
    await expect(button(page)).toBeVisible();
    await expect(button(page)).toHaveAttribute('aria-haspopup', 'menu');
    await expect(page.getByTestId('sign-out')).toHaveCount(0);
    if (edition === 'cloud') await expect(page.getByTestId('plan-line')).toContainText('Free');
    else await expect(page.getByTestId('plan-line')).toHaveCount(0);
    await shot(page, '1440-closed');

    // Open, Esc closes and focus returns.
    await button(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(button(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(menu(page)).toContainText('Signed in as');
    await expect(menu(page)).toContainText(email!);
    const items = await menu(page).getByRole('menuitem').allTextContents();
    expect(items.map((i) => i.trim().replace('(opens in a new tab)', ''))).toEqual(
      edition === 'cloud'
        ? ['Account and security', 'API tokens', 'Plan and billing', 'Documentation', 'Sign out']
        : ['API tokens', 'Documentation', 'Sign out'],
    );
    // The menu sits above the button and inside the window.
    const m = (await menu(page).boundingBox())!;
    const b = (await button(page).boundingBox())!;
    expect(m.y + m.height).toBeLessThanOrEqual(b.y + 1);
    await shot(page, '1440-menu');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(button(page)).toBeFocused();

    // A click outside closes it. Reka starts listening for outside clicks one task after
    // opening (so the opening click doesn't close it); Playwright clicks faster than a person,
    // so let the page run that task first.
    await button(page).click();
    await expect(menu(page)).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await page.mouse.click(900, 400);
    await expect(menu(page)).toBeHidden();

    // A menu item navigates and closes it.
    await button(page).click();
    await menu(page).getByRole('menuitem', { name: 'API tokens' }).click();
    await expect(page).toHaveURL(/tab=tokens/);
    await expect(menu(page)).toBeHidden();

    // Collapse from the header; the rail's avatar opens the same menu to the right.
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toHaveClass(/w-16/);
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await shot(page, '1440-collapsed');
    await button(page).click();
    await expect(menu(page)).toBeVisible();
    const rail = (await sidebar.boundingBox())!;
    expect((await menu(page).boundingBox())!.x).toBeGreaterThanOrEqual(rail.x + rail.width - 1);
    await shot(page, '1440-collapsed-menu');
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    // It stays collapsed after a reload (stored as before), then expands.
    await page.reload();
    await expect(sidebar).toHaveClass(/w-16/);
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(sidebar).toHaveClass(/w-60/);

    // Sign out.
    await button(page).click();
    await menu(page).getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test('390 px: the drawer has the same footer and menu, and signs out', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto('/settings');
    await page.getByTestId('nav-open').click();
    const drawer = page.getByTestId('nav-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Collapse sidebar' })).toHaveCount(0);
    if (edition === 'cloud') await expect(drawer.getByTestId('plan-line')).toBeVisible();
    await shot(page, '390-drawer');
    await drawer.getByTestId('account-menu-button').click();
    await expect(menu(page)).toBeVisible();
    const m = (await menu(page).boundingBox())!;
    expect(m.x).toBeGreaterThanOrEqual(0);
    expect(m.x + m.width).toBeLessThanOrEqual(390);
    await shot(page, '390-menu');
    // Esc closes the menu first; the drawer stays.
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('account-menu-button')).toBeFocused();
    await drawer.getByTestId('account-menu-button').click();
    await menu(page).getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});
