// SPDX-License-Identifier: AGPL-3.0-only
// The network pages in the read-only demo (0.17.1), at 1440 and 390 px, in the theme of
// WATCHLOG_E2E_THEME: every network page and every device, every range a device page offers.
// It fails on a chart that "couldn't be loaded", on a range the demo refuses being offered, on a
// tile with nothing in it, and on a chart for a metric the device's kind can't report — so a new
// range or a new kind can't break the demo silently.
//
//   WATCHLOG_E2E_URL=https://demo.watchlog.io pnpm exec playwright test e2e/network-demo.spec.ts
// (or a local backend started with WATCHLOG_DEMO_MODE=1 and network devices). The visitor's
// session comes from POST /api/v1/demo/session. WATCHLOG_E2E_SHOT_DIR saves screenshots.
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const THEME = process.env.WATCHLOG_E2E_THEME === 'light' ? 'light' : 'dark';
/** What each kind may chart (lib/device-view.ts): anything else on its page is a bug. */
const CHARTS: Record<string, string[]> = {
  ap: ['clients'],
  nvr: ['camerasOnline'],
  ups: ['charge', 'load', 'runtime'],
};
const GENERIC = ['cpu', 'memory', 'temperature'];

interface Dev {
  id: string;
  name: string;
  kind: string;
  cpu: number | null;
  memory: number | null;
  temperature: number | null;
}

async function enter(page: Page, width: number) {
  // The guided tour (1.3.0) opens on a first visit; these walk the pages without it.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('watchlog-demo-tour-seen', '1');
    } catch {
      /* no storage: the tour may open, as for a visitor */
    }
  });
  await page.setViewportSize(width < 1024 ? viewportFor(width).viewport : { width, height: 1000 });
  const res = await page.request.post('/api/v1/demo/session');
  expect(res.ok(), 'this spec runs against the read-only demo').toBe(true);
}
async function noBrokenCharts(page: Page, where: string) {
  await expect(page.getByText(/couldn.t be loaded/i), where).toHaveCount(0);
  await expect(page.getByTestId('chart-retry'), where).toHaveCount(0);
}
async function layoutOk(page: Page, where: string) {
  const problems = await layoutProblems(page);
  expect(problems, report(where, page.viewportSize()?.width ?? 0, problems)).toEqual([]);
}
async function shot(page: Page, name: string, width: number) {
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/${THEME}-${width}-${name}.png`, fullPage: true });
}

for (const width of [1440, 390]) {
  test(`every network page, ${width} px`, async ({ page }) => {
    await enter(page, width);
    for (const path of [
      '/network',
      '/network/map',
      '/network/devices',
      '/network/wireless',
      '/network/storage',
    ]) {
      await page.goto(path);
      await expect(page.getByTestId('network-header')).toBeVisible();
      await page.waitForLoadState('networkidle');
      await noBrokenCharts(page, path);
      await layoutOk(page, `${path} ${width}`);
    }
  });

  test(`every device and every range it offers, ${width} px`, async ({ page }) => {
    test.setTimeout(240_000);
    await enter(page, width);
    const devices = (
      (await (await page.request.get('/api/v1/network/devices')).json()) as {
        devices: Dev[];
      }
    ).devices;
    expect(devices.length).toBeGreaterThan(0);
    for (const d of devices) {
      await page.goto(`/network/devices/${d.id}`);
      await expect(page.getByTestId('device-status')).toBeVisible();
      const where = `${d.name} (${d.kind})`;
      // The demo answers at most 24 hours: no longer range is offered. The buttons are found by
      // their group's name, so this holds for any markup.
      const ranges = page.getByRole('group', { name: 'Time range' }).getByRole('button');
      expect(await ranges.count(), where).toBeGreaterThan(0);
      await expect(ranges.filter({ hasText: /^\s*7d\s*$/ }), where).toHaveCount(0);
      for (let i = 0; i < (await ranges.count()); i++) {
        await ranges.nth(i).click();
        await page.waitForLoadState('networkidle');
        await noBrokenCharts(page, `${where} range ${await ranges.nth(i).innerText()}`);
      }
      // No tile without a value.
      for (const v of await page
        .locator('[data-testid^="device-tile-"] span:nth-child(2)')
        .allInnerTexts())
        expect(v.trim(), `${where}: a tile shows nothing`).not.toBe('–');
      // Only the charts the kind can have, and for generic metrics only what it reports.
      const shown = (
        await page
          .locator('[data-testid^="device-chart-"]')
          .evaluateAll((els) =>
            els.map((e) => e.getAttribute('data-testid')!.replace('device-chart-', '')),
          )
      ).sort();
      const allowed = CHARTS[d.kind] ?? GENERIC.filter((m) => d[m as keyof Dev] != null);
      for (const c of shown) expect(allowed, `${where} charts ${c}`).toContain(c);
      if (!CHARTS[d.kind])
        for (const m of GENERIC)
          if (d[m as keyof Dev] == null)
            expect(shown, `${where}: an empty ${m} chart`).not.toContain(m);
      await layoutOk(page, `${where} ${width}`);
      if (['ap', 'nvr', 'nas', 'switch', 'ups', 'router'].includes(d.kind))
        await shot(page, `device-${d.name}`, width);
    }
  });
}
