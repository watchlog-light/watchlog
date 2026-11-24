// SPDX-License-Identifier: AGPL-3.0-only
// Network devices, part 2 (ADR-234) in a real browser, at 1440 and 390 px, in the theme of
// WATCHLOG_E2E_THEME: Wireless (tiles, the APs, the traffic, the clients: search, the weak
// filter, sort by signal), Storage (a recorder's Recording card with its three signals, the
// NAS, the iSCSI sessions, a UPS and what it feeds), the Overview's Recording card, the map's
// iSCSI paths layer; every page passes the layout checks.
//
// Against a running dashboard with network devices on, polled from a Kubernetes cluster and a
// fleet's server (the simulators: ee/collector/cmd/netsim -office -dahua-port=…):
//   WATCHLOG_E2E_URL=http://localhost:4188 WATCHLOG_E2E_SESSION=wl_session=… \
//   WATCHLOG_E2E_RECORDING=yes|no pnpm exec playwright test e2e/network-kinds.spec.ts
// WATCHLOG_E2E_RECORDING says what the recorder should show (the lab loses its iSCSI disk for
// "no"); WATCHLOG_E2E_SHOT_DIR saves a screenshot of each page.
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const THEME = process.env.WATCHLOG_E2E_THEME === 'light' ? 'light' : 'dark';
const RECORDING = process.env.WATCHLOG_E2E_RECORDING === 'no' ? 'no' : 'yes';
const GIVEN = process.env.WATCHLOG_E2E_SESSION?.replace(/^wl_session=/, '');
const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;

async function signIn(page: Page) {
  if (GIVEN) {
    const url = process.env.WATCHLOG_E2E_URL ?? 'http://localhost:4088';
    return page.context().addCookies([{ name: 'wl_session', value: GIVEN, url }]);
  }
  if (!email || !password) throw new Error('set WATCHLOG_E2E_SESSION or the e-mail and password');
  const res = await page.request.post('/api/v1/auth/login', { data: { email, password } });
  expect(res.ok(), await res.text()).toBe(true);
}
async function shot(page: Page, name: string, width: number) {
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/${THEME}-${width}-${name}.png`, fullPage: true });
}
/** A part below the fold (<main> scrolls, so a full-page shot stops at the viewport). */
async function shotOf(page: Page, testId: string, name: string, width: number) {
  const el = page.getByTestId(testId).first();
  if (!SHOTS || !(await el.count())) return;
  await el.scrollIntoViewIfNeeded();
  await el.screenshot({ path: `${SHOTS}/${THEME}-${width}-${name}.png` });
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
  test(`Wireless, ${width} px: tiles, APs, traffic, clients`, async ({ page }) => {
    await setup(page, width);
    await page.goto('/network/wireless');
    await expect(page.getByTestId('wifi-tiles')).toBeVisible();
    await expect(page.getByTestId('wifi-tile-aps')).toContainText(/\d+\s*\/\s*\d+/);
    await expect(page.getByTestId('wifi-ap-row')).toHaveCount(3);
    await expect(page.getByTestId('wifi-mesh')).toBeVisible();
    await expect(page.getByTestId('wifi-traffic')).toBeVisible();
    const all = await page.getByTestId('wifi-client-row').count();
    expect(all).toBeGreaterThan(0);
    await layoutOk(page, `wireless ${width}`);
    await shot(page, 'wireless', width);
    // The weak filter narrows the list; a search by vendor or MAC too.
    await page.getByTestId('wifi-filter-weak').click();
    const weak = await page.getByTestId('wifi-client-row').count();
    expect(weak).toBeLessThan(all);
    await page.getByTestId('wifi-filter-weak').click();
    const first = (await page.getByTestId('wifi-client-row').first().innerText()).match(
      /([0-9a-f]{2}:){5}[0-9a-f]{2}/i,
    )?.[0];
    if (first) {
      await page.getByTestId('wifi-client-search').fill(first);
      await expect(page.getByTestId('wifi-client-row')).toHaveCount(1);
      await page.getByTestId('wifi-client-search').fill('');
    }
    await page.getByTestId('wifi-sort-signal').click();
    await layoutOk(page, `wireless clients ${width}`);
    await shotOf(page, 'wifi-traffic', 'wireless-traffic', width);
    await shotOf(page, 'wifi-clients-table', 'wireless-clients', width);
  });

  test(`Storage, ${width} px: recording ${RECORDING}, the NAS, sessions, the UPS`, async ({
    page,
  }) => {
    await setup(page, width);
    await page.goto('/network/storage');
    const card = page.getByTestId('recording-card').first();
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-recording', RECORDING);
    for (const s of ['recorder', 'disk', 'rate'])
      await expect(card.getByTestId(`recording-signal-${s}`)).toBeVisible();
    if (RECORDING === 'no')
      await expect(card.getByTestId('recording-signal-disk')).toHaveAttribute('data-ok', 'false');
    await expect(page.getByTestId('nas-card').first()).toBeVisible();
    await expect(page.getByTestId('nas-disk-row').first()).toBeVisible();
    await expect(page.getByTestId('nas-lun-row').first()).toBeVisible();
    await expect(page.getByTestId('iscsi-session-row').first()).toBeVisible();
    await expect(page.getByTestId('iscsi-seen-from')).toBeVisible();
    await expect(page.getByTestId('ups-card').first()).toBeVisible();
    await expect(page.getByTestId('ups-feeds').first()).toBeVisible();
    await layoutOk(page, `storage ${width}`);
    await shot(page, `storage-${RECORDING === 'yes' ? 'recording' : 'not-recording'}`, width);
    await shotOf(page, 'recording-card', `storage-card-${RECORDING}`, width);
    await shotOf(page, 'nas-card', 'storage-nas', width);
    await shotOf(page, 'iscsi-seen-from', 'storage-sessions', width);
    await shotOf(page, 'ups-card', 'storage-ups', width);
  });

  test(`Overview, ${width} px: the Recording card`, async ({ page }) => {
    await setup(page, width);
    await page.goto('/network');
    const card = page.getByTestId('overview-recording');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('recording-line').first()).toHaveAttribute(
      'data-recording',
      RECORDING,
    );
    await layoutOk(page, `overview recording ${width}`);
    await shot(page, `overview-${RECORDING === 'yes' ? 'recording' : 'not-recording'}`, width);
    await shotOf(page, 'overview-recording', `overview-card-${RECORDING}`, width);
  });

  test(`Map, ${width} px: the iSCSI paths layer`, async ({ page }) => {
    await setup(page, width);
    await page.goto('/network/map?layer=iscsi');
    await expect(page.getByTestId('map-canvas')).toBeVisible();
    await expect(page.getByTestId('map-iscsi-path').first()).toBeAttached();
    await expect(page.getByTestId('map-mesh').first()).toBeAttached();
    await layoutOk(page, `map iscsi ${width}`);
    await shot(page, 'map-iscsi', width);
  });
}
