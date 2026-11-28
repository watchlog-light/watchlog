// SPDX-License-Identifier: AGPL-3.0-only
// The live demo's guided tour (1.3.0, ADR-246) in a real browser, against a dashboard in demo
// mode whose seed has a tour and whose cluster and fleet report real failures (the 1.3.0 lab:
// a crash-looping pod, a server service failing since its last release). Both sides, by
// pointer and by keyboard, at 1440 and 390 px, in the theme of WATCHLOG_E2E_THEME; each Next
// under a second; the layout checks on every step; and no tour outside demo mode.
//   WATCHLOG_E2E_URL=http://localhost:4188 pnpm exec playwright test e2e/guided-tour.spec.ts
// WATCHLOG_E2E_SHOT_DIR saves a picture of each step.
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const THEME = process.env.WATCHLOG_E2E_THEME === 'light' ? 'light' : 'dark';

test.beforeEach(async ({ request }) => {
  const status = await (await request.get('/api/v1/setup')).json();
  test.skip(!status.demoMode, 'the dashboard is not in demo mode');
});

async function size(page: Page, width: number) {
  await page.setViewportSize(width < 1024 ? viewportFor(width).viewport : { width, height: 900 });
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
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/${THEME}-${width}-${name}.png`, fullPage: false });
}
/** Clicks Next and waits for the step's lit element: under a second. */
async function nextUnderASecond(page: Page, step: number) {
  const t0 = Date.now();
  await page.getByTestId('tour-next').click();
  await expect(page.getByTestId('tour')).toHaveAttribute('data-step', String(step));
  if (step <= 3) await expect(page.getByTestId('tour-spotlight')).toBeVisible({ timeout: 1000 });
  else await expect(page.getByTestId('tour-end')).toBeVisible({ timeout: 1000 });
  const took = Date.now() - t0;
  expect(took, `Next to step ${step} took ${took} ms`).toBeLessThan(1000);
}
/** The lit element is the one the step names, and the spotlight sits on it, on screen. */
async function litIs(page: Page, selector: string) {
  const lit = page.locator(`${selector}[data-tour-lit]`).first();
  await expect(lit).toBeVisible();
  await expect
    .poll(
      async () => {
        const spot = await page.getByTestId('tour-spotlight').boundingBox();
        const el = await lit.boundingBox();
        return spot && el ? Math.round(Math.abs(spot.y + 8 - el.y)) : 999;
      },
      { timeout: 3000, message: `${selector} lit` },
    )
    .toBeLessThan(4);
  await expect
    .poll(async () => (await lit.boundingBox())!.y, {
      timeout: 3000,
      message: `${selector} on screen`,
    })
    .toBeLessThan(page.viewportSize()!.height - 40);
}

for (const width of [1440, 390]) {
  for (const [kind, label] of [
    ['kubernetes', 'Kubernetes'],
    ['server', 'Linux servers'],
  ] as const) {
    test(`${width} px, ${kind}: the whole tour by pointer, from a first visit`, async ({
      page,
    }) => {
      await size(page, width);
      const moments: string[] = [];
      page.on('request', (r) => {
        const m = /\/api\/v1\/demo\/tour\/event\/(.+)$/.exec(r.url());
        if (m) moments.push(m[1]!);
      });
      await page.goto('/demo');
      const welcome = page.getByTestId('tour-welcome');
      await expect(welcome).toBeVisible({ timeout: 15_000 });
      const t0 = Date.now();
      await expect(page.getByTestId('tour-live')).toContainText(/open \d/);
      await layoutOk(page, `${kind} welcome`);
      await shot(page, `${kind}-0-welcome`, width);

      await welcome.getByRole('button', { name: new RegExp(label) }).click();
      await expect(page.getByTestId('tour')).toHaveAttribute('data-step', '1');
      await expect(page.getByTestId('tour-spotlight')).toBeVisible();
      await litIs(page, '[data-testid="ac-problem"]');
      await layoutOk(page, `${kind} problem`);
      await shot(page, `${kind}-1-problem`, width);

      await nextUnderASecond(page, 2);
      await litIs(page, '[data-testid="cause-panel"]');
      // The why on screen within 10 s of the welcome card, at reading speed (about 3 s here).
      expect(Date.now() - t0).toBeLessThan(10_000);
      await expect(page.locator('[data-testid="cause-panel"]')).toContainText(/Likely|Possible/);
      await layoutOk(page, `${kind} why`);
      await shot(page, `${kind}-2-why`, width);

      await nextUnderASecond(page, 3);
      await litIs(page, '[data-testid="alert-chart"]');
      await layoutOk(page, `${kind} proof`);
      await shot(page, `${kind}-3-proof`, width);

      await nextUnderASecond(page, 4);
      const end = page.getByTestId('tour-end');
      // The command is all there, even in a phone's sheet.
      expect((await end.getByTestId('tour-command').boundingBox())!.height).toBeGreaterThan(60);
      await expect(end.getByTestId('tour-command')).toContainText(
        kind === 'server' ? 'compose.yaml' : 'helm install watchlog',
      );
      await expect(end.getByTestId('tour-cloud')).toHaveAttribute(
        'href',
        /^https:\/\/cloud\.watchlog\.io\/signup\?utm_source=demo_tour/,
      );
      await expect(end.getByTestId('tour-install')).toHaveAttribute(
        'href',
        /^https:\/\/watchlog\.io\/docs\/install\/\?utm_source=demo_tour/,
      );
      await expect(end.getByTestId('tour-another')).toBeVisible();
      await layoutOk(page, `${kind} end`);
      await shot(page, `${kind}-4-end`, width);
      await end.getByTestId('tour-keep').click();
      await expect(page.getByTestId('tour')).toHaveCount(0);
      expect(moments).toEqual([
        'shown',
        `started/${kind === 'server' ? 'servers' : 'k8s'}`,
        'step/1',
        'step/2',
        'step/3',
        'step/4',
        'finished',
      ]);
      // Seen: it doesn't open by itself again; the banner replays it.
      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(page.getByTestId('tour')).toHaveCount(0);
      await page.getByTestId('demo-replay-tour').click();
      await expect(page.getByTestId('tour-welcome')).toBeVisible();
    });
  }

  test(`${width} px: by keyboard, on a link that names the side`, async ({ page }) => {
    await size(page, width);
    await page.goto('/demo');
    await page.waitForLoadState('networkidle');
    await page.goto('/all?tour=servers');
    // The question is skipped: step 1 at once, focus in the card.
    await expect(page.getByTestId('tour')).toHaveAttribute('data-step', '1', { timeout: 15_000 });
    await expect(page.getByTestId('tour')).toHaveAttribute('data-kind', 'server');
    await expect(page.locator('#tour-card-title')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('tour')).toHaveAttribute('data-step', '2');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('tour')).toHaveAttribute('data-step', '3');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('tour')).toHaveAttribute('data-step', '2');
    // Tab stays in the card.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() => !!document.activeElement?.closest('[data-testid="tour-card"]')),
      ).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('tour')).toHaveCount(0);
  });
}

test('?tour=off never shows it, even on a first visit', async ({ page }) => {
  await page.goto('/demo');
  await page.waitForURL((u) => !u.pathname.startsWith('/demo'));
  await page.evaluate(() => localStorage.clear());
  await page.goto('/all?tour=off');
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('tour')).toHaveCount(0);
});

for (const [q, kind] of [
  ['k8s', 'kubernetes'],
  ['servers', 'server'],
] as const)
  test(`the site's /demo?tour=${q} link starts the ${kind} story at once`, async ({ page }) => {
    await page.goto(`/demo?tour=${q}`);
    await expect(page.getByTestId('tour')).toHaveAttribute('data-step', '1', { timeout: 15_000 });
    await expect(page.getByTestId('tour')).toHaveAttribute('data-kind', kind);
  });

test('outside demo mode the tour is never loaded or asked for', async ({ page }) => {
  // The same dashboard told it isn't the demo: no tour chunk, no tour request, no markup.
  await page.route('**/api/v1/setup', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, demoMode: false } });
  });
  const asked: string[] = [];
  page.on('request', (r) => {
    if (/TourRoot|\/demo\/tour/.test(r.url())) asked.push(r.url());
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await expect(page.getByTestId('demo-replay-tour')).toHaveCount(0);
  expect(asked).toEqual([]);
});
