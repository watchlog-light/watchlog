// SPDX-License-Identifier: AGPL-3.0-only
// MongoDB's and Redis's pages in a real browser (1.4, ADR-247), at 1440 and 390 px, in the
// theme of WATCHLOG_E2E_THEME: every tab, a shape's and a collection's page, a key prefix's, a
// command's and a stream group's page, for services on a Kubernetes cluster and on a server
// fleet. Every page passes the layout checks.
//
// Against a running dashboard with monitored services that report (Step 0 of the 1.4 brief):
//   WATCHLOG_E2E_URL=http://localhost:4188 WATCHLOG_E2E_SESSION=… \
//   WATCHLOG_E2E_MONGO_SERVER=<id> WATCHLOG_E2E_MONGO_K8S=<id> \
//   WATCHLOG_E2E_REDIS_SERVER=<id> WATCHLOG_E2E_REDIS_K8S=<id> WATCHLOG_E2E_REDIS_STREAMS=<id> \
//     pnpm exec playwright test e2e/mongo-redis.spec.ts
// WATCHLOG_E2E_SHOT_DIR saves a screenshot of each step; WATCHLOG_E2E_HEALTHY=1 when nothing is
// wrong (no finding expected).
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const THEME = process.env.WATCHLOG_E2E_THEME === 'light' ? 'light' : 'dark';
const HEALTHY = process.env.WATCHLOG_E2E_HEALTHY === '1';
const SESSION = process.env.WATCHLOG_E2E_SESSION?.replace(/^wl_session=/, '') ?? '';
const SERVICES = [
  ['mongo-server', process.env.WATCHLOG_E2E_MONGO_SERVER ?? '', 'mongodb'],
  ['mongo-k8s', process.env.WATCHLOG_E2E_MONGO_K8S ?? '', 'mongodb'],
  ['redis-server', process.env.WATCHLOG_E2E_REDIS_SERVER ?? '', 'redis'],
  ['redis-k8s', process.env.WATCHLOG_E2E_REDIS_K8S ?? '', 'redis'],
  ['valkey-streams', process.env.WATCHLOG_E2E_REDIS_STREAMS ?? '', 'redis'],
] as const;
// The server-side three are required; a Kubernetes one without an id is skipped.
const READY = !!SESSION && [0, 2, 4].every((i) => SERVICES[i]![1]);
const TABS = {
  mongodb: [
    'overview',
    'operations',
    'waits',
    'clients',
    'replica',
    'collections',
    'storage',
    'alerts',
  ],
  redis: [
    'overview',
    'memory',
    'commands',
    'clients',
    'streams',
    'persistence',
    'replication',
    'alerts',
  ],
};

async function setup(page: Page, width: number) {
  await page.setViewportSize(width < 1024 ? viewportFor(width).viewport : { width, height: 1000 });
  const url = process.env.WATCHLOG_E2E_URL ?? 'http://localhost:4088';
  await page.context().addCookies([{ name: 'wl_session', value: SESSION, url }]);
}
async function layoutOk(page: Page, where: string) {
  await expect
    .poll(async () => (await layoutProblems(page)).length, { timeout: 4_000 })
    .toBe(0)
    .catch(() => undefined);
  const problems = await layoutProblems(page);
  expect(problems, report(where, page.viewportSize()?.width ?? 0, problems)).toEqual([]);
}
async function shot(page: Page, name: string, width: number) {
  if (!SHOTS) return;
  // The app shell scrolls <main>: the viewport takes the whole height for the picture.
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
  for (const [where, id, type] of SERVICES) {
    test(`${width} px, ${where}: every tab`, async ({ page }) => {
      test.skip(!READY || !id, 'set WATCHLOG_E2E_SESSION and the service ids');
      await setup(page, width);
      await page.goto(`/applications/${id}`);
      // Overview: the finding, the flow, the six tiles, the checks beside the table that matters.
      if (!HEALTHY) await expect(page.getByTestId('reason').first()).toBeVisible();
      await expect(page.locator('[data-panel="flow"] [data-testid="flow"]')).toBeVisible();
      await expect(page.locator('[data-panel="summary"] [data-tile]')).toHaveCount(6);
      await expect(page.locator('[data-panel="checks"]')).toBeVisible();
      await expect(
        page.locator(`[data-panel="${type === 'mongodb' ? 'slow' : 'prefixes'}"]`),
      ).toBeVisible();
      await layoutOk(page, `${where} overview`);
      await shot(page, `${where}-overview`, width);
      const tabs = page.getByRole('tab');
      for (const t of TABS[type].slice(1)) {
        // Streams is there only when the sampler found streams.
        if (t === 'streams') {
          const has = (await tabs.filter({ hasText: 'Streams' }).count()) > 0;
          if (where === 'valkey-streams') expect(has).toBe(true);
          if (!has) continue;
        }
        await page.goto(`/applications/${id}?tab=${t}`);
        if (t === 'alerts') await expect(page.getByTestId('alerts-tab')).toBeVisible();
        else await settled(page);
        if (t === 'waits') await expect(page.getByTestId('waits-period')).toBeVisible();
        await layoutOk(page, `${where} ${t}`);
        await shot(page, `${where}-${t}`, width);
      }
    });
  }

  test(`${width} px: the item pages, each at its own address`, async ({ page }) => {
    test.skip(!READY, 'set WATCHLOG_E2E_SESSION and the five service ids');
    await setup(page, width);
    const mongo = SERVICES[0][1];
    const redis = SERVICES[2][1];
    const valkey = SERVICES[4][1];
    // A shape, from the Overview's slow operations.
    await page.goto(`/applications/${mongo}`);
    await page.locator('[data-panel="slow"] [data-testid="table-row"] a').first().click();
    await expect(page).toHaveURL(new RegExp(`/applications/${mongo}/statements/`));
    await settled(page);
    await expect(page.getByTestId('db-item-name')).toContainText(/find|aggregate|update|insert/);
    await layoutOk(page, 'mongo shape');
    await shot(page, 'mongo-shape', width);
    await page.reload();
    await settled(page);
    // A collection, from the Collections tab; back goes to Collections.
    await page.goto(`/applications/${mongo}?tab=collections`);
    await settled(page);
    await page.locator('[data-panel="collections"] [data-testid="table-row"] a').first().click();
    await expect(page).toHaveURL(new RegExp(`/applications/${mongo}/tables/`));
    await settled(page);
    await layoutOk(page, 'mongo collection');
    await shot(page, 'mongo-collection', width);
    await page.getByTestId('db-item-back').click();
    await expect(page).toHaveURL(/tab=collections/);
    // A key prefix, from what fills the memory.
    await page.goto(`/applications/${redis}`);
    await page.locator('[data-panel="prefixes"] [data-testid="table-row"] a').first().click();
    await expect(page).toHaveURL(new RegExp(`/applications/${redis}/items/prefix/`));
    await settled(page);
    await expect(page.getByTestId('db-item-name')).toContainText('*');
    await layoutOk(page, 'redis prefix');
    await shot(page, 'redis-prefix', width);
    // A command, from the Commands tab.
    await page.goto(`/applications/${redis}?tab=commands`);
    await settled(page);
    await page.locator('[data-panel="commands"] [data-testid="table-row"] a').first().click();
    await expect(page).toHaveURL(new RegExp(`/applications/${redis}/items/command/`));
    await settled(page);
    await layoutOk(page, 'redis command');
    await shot(page, 'redis-command', width);
    // A stream group, from the Streams tab.
    await page.goto(`/applications/${valkey}?tab=streams`);
    await settled(page);
    await page.locator('[data-panel="groups"] [data-testid="table-row"] a').first().click();
    await expect(page).toHaveURL(new RegExp(`/applications/${valkey}/items/group/`));
    await settled(page);
    await expect(page.getByTestId('db-item-name')).toContainText('·');
    await layoutOk(page, 'valkey group');
    await shot(page, 'valkey-group', width);
    await page.getByTestId('db-item-back').click();
    await expect(page).toHaveURL(/tab=streams/);
  });
}
