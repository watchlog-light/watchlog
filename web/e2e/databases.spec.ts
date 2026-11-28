// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL's and MySQL's pages in a real browser (1.2, ADR-245), at 1440 and 390 px, in the
// theme of WATCHLOG_E2E_THEME: every tab, a statement's page from the costly statements, a
// table's page from the Tables tab, and a period chosen on the Waits tab, for a database on a
// Kubernetes cluster and one on a server fleet. Every page passes the layout checks.
//
// Against a running dashboard with four monitored databases that report (Step 0 of the 1.2
// brief), each with a session blocked by an idle transaction:
//   WATCHLOG_E2E_URL=http://localhost:4188 WATCHLOG_E2E_SESSION=… \
//   WATCHLOG_E2E_PG_K8S=<id> WATCHLOG_E2E_PG_SERVER=<id> \
//   WATCHLOG_E2E_MY_K8S=<id> WATCHLOG_E2E_MY_SERVER=<id> \
//     pnpm exec playwright test e2e/databases.spec.ts
// WATCHLOG_E2E_SHOT_DIR saves a screenshot of each step.
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const THEME = process.env.WATCHLOG_E2E_THEME === 'light' ? 'light' : 'dark';
// WATCHLOG_E2E_HEALTHY=1: the databases have nothing wrong (no blocker): Locks has no tree.
const HEALTHY = process.env.WATCHLOG_E2E_HEALTHY === '1';
const SESSION = process.env.WATCHLOG_E2E_SESSION?.replace(/^wl_session=/, '') ?? '';
const DBS = [
  ['pg-k8s', process.env.WATCHLOG_E2E_PG_K8S ?? '', 'postgres'],
  ['pg-server', process.env.WATCHLOG_E2E_PG_SERVER ?? '', 'postgres'],
  ['my-k8s', process.env.WATCHLOG_E2E_MY_K8S ?? '', 'mysql'],
  ['my-server', process.env.WATCHLOG_E2E_MY_SERVER ?? '', 'mysql'],
] as const;
const READY = !!SESSION && DBS.every(([, id]) => id);
const TABS = {
  postgres: [
    'overview',
    'queries',
    'waits',
    'connections',
    'locks',
    'replication',
    'tables',
    'vacuum',
    'alerts',
  ],
  mysql: [
    'overview',
    'queries',
    'waits',
    'connections',
    'locks',
    'replication',
    'tables',
    'storage',
    'alerts',
  ],
};

async function setup(page: Page, width: number) {
  await page.setViewportSize(width < 1024 ? viewportFor(width).viewport : { width, height: 1000 });
  const url = process.env.WATCHLOG_E2E_URL ?? 'http://localhost:4088';
  await page.context().addCookies([{ name: 'wl_session', value: SESSION, url }]);
}
async function layoutOk(page: Page, where: string) {
  // A page that just loaded may be wider for a moment while its charts take their size.
  await expect
    .poll(async () => (await layoutProblems(page)).length, { timeout: 4_000 })
    .toBe(0)
    .catch(() => undefined);
  const problems = await layoutProblems(page);
  expect(problems, report(where, page.viewportSize()?.width ?? 0, problems)).toEqual([]);
}
async function shot(page: Page, name: string, width: number) {
  if (!SHOTS) return;
  // The app shell scrolls <main>, not the page: the viewport takes the whole height for the
  // picture, then goes back.
  const vp = page.viewportSize()!;
  const h = await page.evaluate(() => {
    const m = document.querySelector('main');
    return (m ? m.scrollHeight + m.getBoundingClientRect().top : 0) || document.body.scrollHeight;
  });
  await page.setViewportSize({
    width: vp.width,
    height: Math.ceil(Math.min(Math.max(h, vp.height), 14000)),
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${THEME}-${width}-${name}.png`, fullPage: true });
  await page.setViewportSize(vp);
}
async function settled(page: Page) {
  await expect(page.locator('[data-testid="panels"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="panels"][aria-busy="true"]')).toHaveCount(0);
}

for (const width of [1440, 390]) {
  for (const [where, id, type] of DBS) {
    test(`${width} px, ${where}: every tab`, async ({ page }) => {
      test.skip(!READY, 'set WATCHLOG_E2E_SESSION, _PG_K8S, _PG_SERVER, _MY_K8S and _MY_SERVER');
      await setup(page, width);
      await page.goto(`/applications/${id}`);
      // Overview: the finding, the flow, the six tiles, the checks, the costly statements.
      if (!HEALTHY) await expect(page.getByTestId('reason').first()).toBeVisible();
      await expect(page.locator('[data-panel="flow"] [data-testid="flow"]')).toBeVisible();
      await expect(page.locator('[data-panel="summary"] [data-tile]')).toHaveCount(6);
      await expect(
        page.locator('[data-panel="slowest"] [data-testid="statement-row"]').first(),
      ).toBeVisible();
      if (!HEALTHY) await expect(page.getByRole('tab', { name: /Locks · \d+/ })).toBeVisible();
      await layoutOk(page, `${where} overview`);
      await shot(page, `${where}-overview`, width);
      for (const t of TABS[type].slice(1)) {
        await page.goto(`/applications/${id}?tab=${t}`);
        if (t === 'alerts') await expect(page.getByTestId('alerts-tab')).toBeVisible();
        else await settled(page);
        if (t === 'locks' && HEALTHY) {
          await expect(page.locator('[data-testid="tree-node"]')).toHaveCount(0);
        } else if (t === 'locks') {
          // The root blocker first, the session it blocks under it.
          const nodes = page.locator('[data-testid="tree-node"]');
          await expect(nodes.first()).toHaveAttribute('aria-level', '1');
          await expect(nodes.nth(1)).toHaveAttribute('aria-level', '2');
        }
        if (t === 'waits') await expect(page.getByTestId('waits-period')).toBeVisible();
        await layoutOk(page, `${where} ${t}`);
        await shot(page, `${where}-${t}`, width);
      }
    });
  }

  test(`${width} px: a statement's and a table's own pages, and a period on Waits`, async ({
    page,
  }) => {
    test.skip(!READY, 'set WATCHLOG_E2E_SESSION, _PG_K8S, _PG_SERVER, _MY_K8S and _MY_SERVER');
    await setup(page, width);
    for (const [where, id] of [DBS[0], DBS[2]]) {
      await page.goto(`/applications/${id}`);
      const link = page.locator('[data-panel="slowest"] [data-testid="statement-link"]').first();
      const text = (await link.textContent())?.trim() ?? '';
      await link.click();
      await expect(page).toHaveURL(new RegExp(`/applications/${id}/statements/`));
      await expect(page.getByTestId('db-item-name')).toContainText(text.slice(0, 20));
      await settled(page);
      await expect(
        page.locator('[data-panel="alerts"] [data-testid^="scoped-alert-"]').first(),
      ).toBeVisible();
      await layoutOk(page, `${where} statement`);
      await shot(page, `${where}-statement`, width);
      // The address is stable: a reload lands on the same statement.
      await page.reload();
      await expect(page.getByTestId('db-item-name')).toContainText(text.slice(0, 20));

      await page.goto(`/applications/${id}?tab=tables`);
      await settled(page);
      await page.locator('[data-testid="panels"] a[href*="/tables/"]').first().click();
      await expect(page).toHaveURL(new RegExp(`/applications/${id}/tables/`));
      await settled(page);
      await layoutOk(page, `${where} table`);
      await shot(page, `${where}-table`, width);
      await page.getByTestId('db-item-back').click();
      await expect(page).toHaveURL(new RegExp(`/applications/${id}`));

      await page.goto(`/applications/${id}?tab=waits`);
      await settled(page);
      await page.getByTestId('period-15').click();
      await expect(page).toHaveURL(/from=\d+&to=\d+|to=\d+.*from=\d+/);
      await settled(page);
      await expect(page.getByTestId('period-clear')).toBeVisible();
      await page.getByTestId('period-clear').click();
      await expect(page).not.toHaveURL(/from=/);
    }
  });
}
