// SPDX-License-Identifier: AGPL-3.0-only
// Only the content pane scrolls: wheel-scrolling a long page to its end never moves the
// document, the sidebar or the top bar, with and without the demo banner, on a tall and a
// short desktop and on a phone, on every main route. The demo banner is switched on by
// answering GET /api/v1/setup with demoMode (the layout is what is checked).
// Needs a dashboard with data: WATCHLOG_E2E_URL, WATCHLOG_E2E_EMAIL, WATCHLOG_E2E_PASSWORD.
import { expect, test, type Page } from '@playwright/test';

const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'short', width: 1280, height: 700 },
  { name: 'phone', width: 390, height: 844 },
];

async function routes(page: Page): Promise<string[]> {
  const clusters = (await (await page.request.get('/api/v1/clusters')).json()).clusters as {
    id: string;
  }[];
  const apps = (await (await page.request.get('/api/v1/applications')).json()).applications as {
    id: string;
  }[];
  // Every service page and each of its tabs: the long ones are where it showed.
  const appPages: string[] = [];
  for (const a of apps) {
    const tabs = (await (await page.request.get(`/api/v1/applications/${a.id}`)).json()).page
      .tabs as { id: string }[];
    for (const t of tabs) appPages.push(`/applications/${a.id}?tab=${t.id}`);
  }
  const c = clusters[0]?.id;
  return [
    `/?cluster=${c}`,
    `/nodes?cluster=${c}`,
    `/workloads?cluster=${c}`,
    `/applications`,
    ...appPages,
    `/service-map?cluster=${c}`,
    `/alerts`,
    `/alerts/rules`,
    `/settings`,
    `/settings/users`,
  ];
}

/** Where the document, the sidebar (or the menu button) and the top bar are. */
async function frame(page: Page) {
  return page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top) : null;
    };
    return {
      doc: document.scrollingElement?.scrollTop ?? 0,
      win: window.scrollY,
      header: box('header'),
      side: box('[data-testid="sidebar"]'),
      tall: document.documentElement.scrollHeight - window.innerHeight,
      // macOS rubber-bands the page when a nested scroller hands the wheel on: what
      // moved the shell on the live demo, with scrollTop staying 0.
      chain: [
        getComputedStyle(document.documentElement).overscrollBehaviorY,
        getComputedStyle(document.body).overscrollBehaviorY,
        getComputedStyle(document.querySelector('main')!).overscrollBehaviorY,
        getComputedStyle(document.body).overflowY,
      ].join(','),
    };
  });
}

for (const demo of [false, true]) {
  for (const vp of VIEWPORTS) {
    test(`only the content scrolls: ${vp.name}${demo ? ', demo banner' : ''}`, async ({
      browser,
    }) => {
      test.skip(!email || !password, 'set WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD');
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
      });
      const page = await context.newPage();
      const login = await page.request.post('/api/v1/auth/login', { data: { email, password } });
      expect(login.ok()).toBe(true);
      if (demo) {
        await page.route(/\/api\/v1\/setup$/, async (r) => {
          const res = await r.fetch();
          await r.fulfill({ response: res, json: { ...(await res.json()), demoMode: true } });
        });
      }
      const failures: string[] = [];
      for (const path of await routes(page)) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        if (demo) await expect(page.getByTestId('demo-banner')).toBeVisible();
        const before = await frame(page);
        await page.mouse.move(vp.width - 40, vp.height / 2);
        for (let i = 0; i < 8; i++) {
          await page.mouse.wheel(0, 4000);
          await page.waitForTimeout(80);
        }
        const after = await frame(page);
        if (after.doc !== 0 || after.win !== 0 || after.tall > 0)
          failures.push(
            `${path}: the page scrolls (document ${after.doc}, ${after.tall} px taller than the viewport)`,
          );
        if (after.header !== before.header)
          failures.push(`${path}: the top bar moved ${before.header} → ${after.header}`);
        if (after.side !== before.side)
          failures.push(`${path}: the sidebar moved ${before.side} → ${after.side}`);
        if (after.chain !== 'none,none,contain,hidden')
          failures.push(
            `${path}: the wheel can reach the page (overscroll html,body,main / body overflow: ${after.chain})`,
          );
      }
      expect(failures, failures.join('\n')).toEqual([]);
      await context.close();
    });
  }
}
