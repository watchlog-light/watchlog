// SPDX-License-Identifier: AGPL-3.0-only
// Updating the agents (0.11.1, ADR-227) in a real browser, at 1440 and 390 px: the fleet's
// banner, the server page's warning chip, and the dialog with its command and copy button.
// Every width passes the layout checks. Against a running dashboard whose fleet named in
// WATCHLOG_E2E_FLEET has servers web-01 (older agent) and web-03 (current):
//   WATCHLOG_E2E_URL=… WATCHLOG_E2E_EMAIL=… WATCHLOG_E2E_PASSWORD=… WATCHLOG_E2E_FLEET=<id> \
//     pnpm exec playwright test e2e/agent-update.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;
const fleet = process.env.WATCHLOG_E2E_FLEET;
const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');

async function signIn(page: Page) {
  if (!email || !password || !fleet) throw new Error('set the WATCHLOG_E2E_* variables');
  const res = await page.request.post('/api/v1/auth/login', { data: { email, password } });
  expect(res.ok(), await res.text()).toBe(true);
}
const shot = (page: Page, name: string) =>
  SHOTS ? page.screenshot({ path: `${SHOTS}/agent-update-${name}.png` }) : Promise.resolve();

for (const width of [1440, 390]) {
  test(`${width} px: the banner, the chip, the dialog`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize(
      width === 1440 ? { width, height: 1000 } : viewportFor(width).viewport,
    );
    await signIn(page);

    // The fleet's Servers: one banner, a version per row.
    await page.goto(`/servers?cluster=${fleet}`);
    const banner = page.getByTestId('agent-banner');
    await expect(banner).toContainText('2 of 3 servers run an older agent');
    let problems = await layoutProblems(page);
    expect(problems, report('/servers', width, problems)).toEqual([]);
    await page.getByTestId('agent-banner-update').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Update the agents');
    await expect(page.getByTestId('agent-update-command')).toContainText('--upgrade');
    await expect(page.getByTestId('agent-update-loop')).toContainText('for h in web-01 web-02');
    await expect(page.getByTestId('agent-update-methods')).toHaveCount(0);
    await shot(page, `${width}-fleet-dialog`);
    problems = await layoutProblems(page);
    expect(problems, report('/servers dialog', width, problems)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // The server page: the warning chip opens the same command for that server.
    await page.goto(`/servers/web-01?cluster=${fleet}`);
    const chip = page.getByTestId('agent-chip-update');
    await expect(chip).toHaveText('Agent 0.10.1 · update to 0.11.1');
    await chip.click();
    await expect(page.getByTestId('agent-update-command')).toContainText('--upgrade');
    await expect(page.getByTestId('agent-update-loop')).toHaveCount(0);
    // The copy button copies the command.
    await page.getByTestId('agent-update-command').getByRole('button').first().click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/install\.sh \| sudo sh -s -- --upgrade$/);
    await shot(page, `${width}-server-dialog`);
    await page.keyboard.press('Escape');

    // A current server: the chip as before.
    await page.goto(`/servers/web-03?cluster=${fleet}`);
    await expect(page.getByTestId('agent-chip')).toHaveText('agent 0.11.1');
    await expect(page.getByTestId('agent-chip-update')).toHaveCount(0);
    problems = await layoutProblems(page);
    expect(problems, report('/servers/web-03', width, problems)).toEqual([]);
  });
}
