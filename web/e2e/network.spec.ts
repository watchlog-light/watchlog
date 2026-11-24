// SPDX-License-Identifier: AGPL-3.0-only
// Network devices in a real browser (ADR-233), at 1440 and 390 px, in the theme of
// WATCHLOG_E2E_THEME: Overview, Map (hover, click focus, the docked panel, a link, layers, zoom,
// fit, a down link), Devices, a device (select a port) and Add devices (the poller on a
// Kubernetes cluster and on a server of a fleet, a profile, the setup commands); every page
// passes the layout checks. And the teaser where the feature is off.
//
// Against a running dashboard with network devices on, polled from a cluster and a fleet's
// server (the simulators: ee/collector/cmd/netsim with -office), one switch port down:
//   WATCHLOG_E2E_URL=http://localhost:4188 WATCHLOG_E2E_EMAIL=… WATCHLOG_E2E_PASSWORD=… \
//   WATCHLOG_E2E_DEVICE=<a switch's id> WATCHLOG_E2E_PORT=Gi1/0/14 \
//     pnpm exec playwright test e2e/network.spec.ts
// WATCHLOG_E2E_TEASER_URL (a dashboard without the feature) adds the teaser's checks.
// WATCHLOG_E2E_SHOT_DIR saves a screenshot of each.
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;
const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const THEME = process.env.WATCHLOG_E2E_THEME === 'light' ? 'light' : 'dark';
const DEVICE = process.env.WATCHLOG_E2E_DEVICE ?? '';
const PORT = process.env.WATCHLOG_E2E_PORT ?? '';
const TEASER = process.env.WATCHLOG_E2E_TEASER_URL;

/** A session from an earlier sign-in (WATCHLOG_E2E_SESSION=wl_session=…): no login per test. */
const GIVEN = process.env.WATCHLOG_E2E_SESSION?.replace(/^wl_session=/, '');
async function signIn(page: Page, base?: string) {
  if (GIVEN) {
    const url = base ?? process.env.WATCHLOG_E2E_URL ?? 'http://localhost:4088';
    return page.context().addCookies([{ name: 'wl_session', value: GIVEN, url }]);
  }
  if (!email || !password) throw new Error('set WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD');
  const res = await page.request.post(`${base ?? ''}/api/v1/auth/login`, {
    data: { email, password },
  });
  expect(res.ok(), await res.text()).toBe(true);
}
async function shot(page: Page, name: string, width: number) {
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/${THEME}-${width}-${name}.png`, fullPage: true });
}
async function layoutOk(page: Page, where: string) {
  const problems = await layoutProblems(page);
  expect(problems, report(where, page.viewportSize()?.width ?? 0, problems)).toEqual([]);
}
async function setup(page: Page, width: number, base?: string) {
  await page.setViewportSize(width < 1024 ? viewportFor(width).viewport : { width, height: 1000 });
  await signIn(page, base);
}

for (const width of [1440, 390]) {
  test(`Overview, ${width} px: tiles, the map, Needs attention, the devices`, async ({ page }) => {
    await setup(page, width);
    await page.goto('/network');
    await expect(page.getByTestId('network-tiles')).toBeVisible();
    await expect(page.getByTestId('network-tile-devices')).toContainText(/\d+ \/ \d+/);
    await expect(page.getByTestId('map-canvas')).toBeVisible();
    await expect(page.getByTestId('network-attention')).toBeVisible();
    await expect(page.getByTestId('network-device-row').first()).toBeVisible();
    await layoutOk(page, `network overview ${width}`);
    await shot(page, 'overview', width);
  });

  test(`Map, ${width} px: hover, focus, the panel, a link, layers, zoom, a down link`, async ({
    page,
  }) => {
    await setup(page, width);
    await page.goto('/network/map');
    const canvas = page.getByTestId('map-canvas');
    await expect(canvas).toBeVisible();
    await expect(page.getByTestId('map-node').first()).toBeVisible();
    // A port down behind a switch: a red, dashed link.
    await expect(
      page
        .locator('[data-state="down"]:is([data-testid="map-link"], [data-testid="map-attach"])')
        .first(),
    ).toBeAttached();
    await shot(page, 'map', width);
    const node = page.locator('[data-testid="map-node"][data-node^="d:"]').first();
    if (width >= 1024) {
      await node.hover();
      await expect(page.getByTestId('map-tooltip')).toBeVisible();
    }
    await node.click();
    await expect(page.getByTestId('map-panel')).toBeVisible();
    await expect(page.getByTestId('map-panel-title')).not.toBeEmpty();
    await layoutOk(page, `network map focused ${width}`);
    await shot(page, 'map-focus', width);
    await page.locator('[data-testid="map-link"]').first().click({ force: true });
    await expect(page.getByTestId('map-panel-end').first()).toBeVisible();
    await shot(page, 'map-link', width);
    await page.getByTestId('map-layer-endpoints').click();
    await page.getByTestId('map-zoom-in').click();
    await page.getByTestId('map-fit').click();
    await layoutOk(page, `network map endpoints ${width}`);
    await shot(page, 'map-endpoints', width);
  });

  test(`Devices, ${width} px: the table and its filters`, async ({ page }) => {
    await setup(page, width);
    await page.goto('/network/devices');
    await expect(page.getByTestId('network-device-row').first()).toBeVisible();
    const all = await page.getByTestId('network-device-row').count();
    await page.getByTestId('filter-kind').selectOption('router');
    await expect(page.getByTestId('network-device-row')).toHaveCount(1);
    await page.getByTestId('filter-kind').selectOption('');
    await expect(page.getByTestId('network-device-row')).toHaveCount(all);
    await layoutOk(page, `network devices ${width}`);
    await shot(page, 'devices', width);
  });

  test(`A device, ${width} px: the front panel, a port selected`, async ({ page }) => {
    test.skip(!DEVICE, 'set WATCHLOG_E2E_DEVICE');
    await setup(page, width);
    await page.goto(`/network/devices/${DEVICE}`);
    await expect(page.getByTestId('device-facts')).toBeVisible();
    await expect(
      page.getByTestId('front-panel-1').or(page.getByTestId('front-panel-0')),
    ).toBeVisible();
    await shot(page, 'device', width);
    if (PORT) {
      await page.getByTestId(`port-${PORT}`).first().click();
      await expect(page.getByTestId('port-detail')).toBeVisible();
      await layoutOk(page, `network device port ${width}`);
      await shot(page, 'device-port', width);
    }
  });

  test(`Add devices, ${width} px: pollers in each place's words, a profile, the commands`, async ({
    page,
  }) => {
    await setup(page, width);
    await page.goto('/network/add');
    // A Kubernetes cluster's collector and a fleet's servers.
    await expect(page.locator('[data-testid^="poller-"]').first()).toBeVisible();
    await page.getByTestId('cred-new').click();
    await expect(page.getByTestId('cred-form')).toBeVisible();
    await page
      .locator('summary')
      .filter({ hasText: /read-only user/i })
      .first()
      .click();
    await expect(page.getByTestId('setup-commands')).toBeVisible();
    await layoutOk(page, `network add ${width}`);
    await shot(page, 'add', width);
  });

  test(`The teaser, ${width} px: no data, the edition's link`, async ({ page }) => {
    test.skip(!TEASER, 'set WATCHLOG_E2E_TEASER_URL');
    await setup(page, width, TEASER);
    const asked: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/network/')) asked.push(r.url());
    });
    await page.goto(`${TEASER}/network`);
    await expect(page.getByTestId('network-teaser')).toBeVisible();
    await expect(page.getByTestId('network-teaser-picture')).toBeVisible();
    await expect(
      page.getByTestId('network-teaser-contact').or(page.getByTestId('network-teaser-upgrade')),
    ).toBeVisible();
    expect(asked).toEqual([]);
    await layoutOk(page, `network teaser ${width}`);
    await shot(page, 'teaser', width);
  });
}
