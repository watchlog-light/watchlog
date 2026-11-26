// SPDX-License-Identifier: AGPL-3.0-only
// Your metrics (1.0.0, ADR-236 to ADR-239) in a real browser at 1440 and 390 px, on a
// Kubernetes cluster and on a Server fleet: the dashboards tab (a dashboard's widgets draw, edit
// mode opens and cancels), the list with its search and a metric's page with its chart and its
// searchable "Split by", the alerts tab, Add a source in each kind's own words (the pod
// annotation, or an address on a server), and the layout checks on every page.
//
// Against a running dashboard whose cluster and fleet each have own metrics and at least one
// dashboard (a few values pushed to POST /ingest/v1/metrics are enough):
//   WATCHLOG_E2E_URL=http://localhost:4188 WATCHLOG_E2E_EMAIL=… WATCHLOG_E2E_PASSWORD=… \
//   WATCHLOG_E2E_KUBE=<cluster id> WATCHLOG_E2E_FLEET=<fleet id> \
//     pnpm exec playwright test e2e/your-metrics.spec.ts
// WATCHLOG_E2E_SHOT_DIR saves a screenshot of each page there; WATCHLOG_E2E_THEME=light.
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;
const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const THEME = process.env.WATCHLOG_E2E_THEME === 'light' ? 'light' : 'dark';
const PLACES = [
  { kind: 'kubernetes' as const, id: process.env.WATCHLOG_E2E_KUBE ?? '' },
  { kind: 'server' as const, id: process.env.WATCHLOG_E2E_FLEET ?? '' },
];

async function signIn(page: Page) {
  if (!email || !password) throw new Error('set WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD');
  // Sign-in is rate limited: a run signs in four times in a row, so it waits when told to.
  for (let i = 0; ; i++) {
    const res = await page.request.post('/api/v1/auth/login', { data: { email, password } });
    if (res.status() === 429 && i < 3) {
      await page.waitForTimeout(Number(res.headers()['retry-after'] ?? 5) * 1000 + 500);
      continue;
    }
    expect(res.ok(), await res.text()).toBe(true);
    return;
  }
}

async function checked(page: Page, route: string, width: number, tag: string) {
  // Charts draw after their data: let the page settle before it is measured.
  await page.waitForLoadState('networkidle').catch(() => {});
  const problems = await layoutProblems(page);
  expect(problems, report(route, width, problems)).toEqual([]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/your-metrics-${tag}-${THEME}.png` });
}

for (const place of PLACES) {
  for (const width of [1440, 390]) {
    test.describe(`${place.kind} at ${width}px`, () => {
      test.use(viewportFor(width));
      test.skip(!place.id, `set WATCHLOG_E2E_${place.kind === 'server' ? 'FLEET' : 'KUBE'}`);

      test('dashboards, the list, a metric, alerts and Add a source', async ({ page }) => {
        await signIn(page);
        const q = `cluster=${place.id}`;
        const tag = `${place.kind}-${width}`;

        // ---- Dashboards: the first one draws its widgets; edit mode opens and cancels ------
        await page.goto(`/your-metrics?${q}`);
        await expect(page.getByTestId('your-metrics')).toBeVisible();
        await expect(page.getByTestId('own-usage')).toContainText(/of [\d,]+ series/);
        const dashboards = page.getByTestId('own-dashboards');
        await expect(dashboards).toBeVisible();
        const grid = page.getByTestId('own-grid');
        await expect(grid).toBeVisible();
        await expect(
          grid.getByTestId('own-widget-number').or(grid.locator('canvas')).first(),
        ).toBeVisible();
        await checked(page, '/your-metrics', width, `${tag}-dashboard`);
        await page.getByTestId('own-dash-edit').click();
        await expect(page.getByTestId('own-dash-done')).toBeVisible();
        await expect(page.getByTestId('own-w-add')).toBeVisible();
        await page.getByTestId('own-dash-cancel').click();
        await expect(page.getByTestId('own-dash-edit')).toBeVisible();

        // ---- The list: search narrows it; a metric's page has its value and its chart ------
        await page.goto(`/your-metrics?${q}&tab=metrics`);
        const rows = page.getByTestId('own-row');
        await expect(rows.first()).toBeVisible();
        const all = await rows.count();
        const name = (await rows.first().locator('.font-mono').first().innerText()).trim();
        await page.getByTestId('own-search').fill(name);
        await expect(rows.first()).toContainText(name);
        expect(await rows.count()).toBeLessThanOrEqual(all);
        await page.getByTestId('own-search').fill('');
        // A phone shows the list alone: a row opens the metric.
        if (width < 1024) await rows.first().click();
        const detail = page.getByTestId('own-detail');
        await expect(detail).toBeVisible();
        await expect(detail.getByTestId('own-name')).toHaveText(name);
        await expect(detail.getByTestId('own-chart').locator('canvas').first()).toBeVisible();
        await checked(page, '/your-metrics?tab=metrics', width, `${tag}-metric`);

        // "Split by" is a searchable dropdown (slice 5): typing filters its options. On a phone
        // it opens as a sheet, which the Combobox's own tests cover.
        if (width >= 1024) {
          const split = detail.getByRole('combobox').first();
          await split.click();
          await expect(page.getByRole('option').first()).toBeVisible();
          await page.keyboard.type('zzzz-no-such-label');
          await expect(page.getByRole('listbox')).toContainText(/no match/i);
          await page.keyboard.press('Escape');
        }

        // ---- Alerts: the tab lists rules or says what the edition allows -------------------
        await page.goto(`/your-metrics?${q}&tab=alerts`);
        await expect(page.getByTestId('own-alerts')).toBeVisible();
        await checked(page, '/your-metrics?tab=alerts', width, `${tag}-alerts`);

        // ---- Add a source, in the kind's own words ----------------------------------------
        await page.goto(`/your-metrics/add?${q}`);
        const add = page.getByTestId('own-add-page');
        await expect(add).toBeVisible();
        await expect(add.getByTestId('own-sources')).toBeVisible();
        await expect(add.getByTestId('own-tokens')).toBeVisible();
        if (place.kind === 'kubernetes') {
          await expect(add).toContainText('watchlog.io/scrape');
          await expect(add.getByTestId('own-address-form')).toHaveCount(0);
        } else {
          await expect(add.getByTestId('own-address-form')).toBeVisible();
          await expect(add).not.toContainText('watchlog.io/scrape');
        }
        await checked(page, '/your-metrics/add', width, `${tag}-add`);
      });
    });
  }
}
