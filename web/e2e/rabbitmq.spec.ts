// SPDX-License-Identifier: AGPL-3.0-only
// RabbitMQ's page in a real browser (1.1.0), at 1440 and 390 px, in the theme of
// WATCHLOG_E2E_THEME: the five tabs (Overview, Queues, Clients, Nodes, Alerts) and a queue's
// own page, for a broker on a Kubernetes cluster and one on a server fleet. Every page passes
// the layout checks.
//
// Against a running dashboard with two monitored RabbitMQ services that report (a 3.13 and a
// 4.x, Step 0 of the 1.1.0 brief), the Kubernetes one with WATCHLOG_E2E_RMQ_QUEUE that lost its
// consumer:
//   WATCHLOG_E2E_URL=http://localhost:4188 WATCHLOG_E2E_SESSION=… \
//   WATCHLOG_E2E_RMQ_K8S=<service id> WATCHLOG_E2E_RMQ_SERVER=<service id> \
//   WATCHLOG_E2E_RMQ_QUEUE=emails.send \
//     pnpm exec playwright test e2e/rabbitmq.spec.ts
// WATCHLOG_E2E_SHOT_DIR saves a screenshot of each step.
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const THEME = process.env.WATCHLOG_E2E_THEME === 'light' ? 'light' : 'dark';
const K8S = process.env.WATCHLOG_E2E_RMQ_K8S ?? '';
const SERVER = process.env.WATCHLOG_E2E_RMQ_SERVER ?? '';
const QUEUE = process.env.WATCHLOG_E2E_RMQ_QUEUE ?? '';
const SESSION = process.env.WATCHLOG_E2E_SESSION?.replace(/^wl_session=/, '') ?? '';
const READY = !!(K8S && SERVER && QUEUE && SESSION);

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
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/${THEME}-${width}-${name}.png`, fullPage: true });
}
async function tab(page: Page, name: RegExp) {
  await page.getByRole('tab', { name }).click();
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
}

for (const width of [1440, 390]) {
  for (const [where, id] of [
    ['k8s', K8S],
    ['server', SERVER],
  ] as const) {
    test(`${width} px, ${where}: the five tabs`, async ({ page }) => {
      test.skip(!READY, 'set WATCHLOG_E2E_SESSION, _RMQ_K8S, _RMQ_SERVER and _RMQ_QUEUE');
      await setup(page, width);
      await page.goto(`/applications/${id}`);
      // Overview: the flow, the tiles, the checks, the queues that need a look.
      await expect(page.locator('[data-panel="flow"] [data-testid="flow"]')).toBeVisible();
      await expect(page.locator('[data-tile="ready"]')).toBeVisible();
      await expect(page.getByTestId('checks-summary')).toContainText(/\d+ of \d+ pass/);
      // A queue with a finding, or the one line that none needs a look (1.1.1, A5).
      await expect(
        page
          .locator(
            '[data-panel="needLook"] [data-testid="queue-row"], [data-panel="needLook"] [data-testid="queues-fine"]',
          )
          .first(),
      ).toBeVisible();
      await expect(page.getByRole('tab', { name: /Queues · \d+/ })).toBeVisible();
      await layoutOk(page, `${where} overview`);
      await shot(page, `${where}-overview`, width);

      await tab(page, /Queues/);
      const rows = page.locator('[data-panel="queues"] [data-testid="queue-row"]');
      await expect(rows.first()).toBeVisible();
      await page.getByTestId('queues-no-consumers').check();
      // The Kubernetes broker is the one with the queue that lost its consumer.
      if (where === 'k8s') await expect(rows.first()).toBeVisible();
      await page.getByTestId('queues-no-consumers').uncheck();
      await page.getByTestId('sort-ready').click();
      await layoutOk(page, `${where} queues`);
      await shot(page, `${where}-queues`, width);

      await tab(page, /Clients/);
      await expect(page.locator('[data-panel="clients"]')).toBeVisible();
      await layoutOk(page, `${where} clients`);
      await shot(page, `${where}-clients`, width);

      await tab(page, /Nodes/);
      await expect(page.getByTestId('node').first()).toBeVisible();
      await expect(page.getByTestId('node').first()).toContainText(/3\.13|4\./);
      await layoutOk(page, `${where} nodes`);
      await shot(page, `${where}-nodes`, width);

      await tab(page, /Alerts/);
      await expect(page.getByTestId('alerts-tab')).toBeVisible();
      await layoutOk(page, `${where} alerts`);
      await shot(page, `${where}-alerts`, width);
    });
  }

  test(`${width} px: a queue's own page, from the queue table`, async ({ page }) => {
    test.skip(!READY, 'set WATCHLOG_E2E_SESSION, _RMQ_K8S, _RMQ_SERVER and _RMQ_QUEUE');
    await setup(page, width);
    await page.goto(`/applications/${K8S}?tab=queues`);
    await page.locator(`[data-queue="${QUEUE}"] a`).click();
    await expect(page).toHaveURL(
      new RegExp(`/applications/${K8S}/queues/${QUEUE.replace('.', '\\.')}`),
    );
    await expect(page.getByTestId('queue-name')).toHaveText(QUEUE);
    await expect(page.locator('[data-tile="consumers"]')).toBeVisible();
    await expect(page.locator('[data-panel="timeline"]')).toBeVisible();
    await expect(page.locator('[data-panel="cause"]')).toContainText(
      "RabbitMQ doesn't say which client consumed which queue.",
    );
    await expect(page.locator('[data-panel="facts"]')).toContainText(/classic|quorum|stream/);
    await expect(page.getByTestId('queue-alert-unconsumed')).toBeVisible();
    await layoutOk(page, 'queue page');
    await shot(page, 'queue', width);
    // The address is stable: a reload lands on the same queue.
    await page.reload();
    await expect(page.getByTestId('queue-name')).toHaveText(QUEUE);
    await page.getByTestId('queue-back').click();
    await expect(page.getByRole('tab', { name: /Queues/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
}
