// SPDX-License-Identifier: AGPL-3.0-only
// Only the content pane scrolls: wheel-scrolling a long page to its end never moves the
// document, the sidebar or the top bar, with and without the demo banner, on a tall and a
// short desktop and on a phone, on every main route. The demo banner is switched on by
// answering GET /api/v1/setup with demoMode (the layout is what is checked).
// Needs a dashboard with data: WATCHLOG_E2E_URL, WATCHLOG_E2E_EMAIL, WATCHLOG_E2E_PASSWORD.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

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

/** An edge of a cluster's service map, the one with the most to show, and its source. */
async function mapSelection(page: Page, clusterId: string) {
  const map = (await (
    await page.request.get(`/api/v1/clusters/${clusterId}/service-map?range=3600`)
  ).json()) as { edges: { id: string; source: string; health: string; http: unknown }[] };
  const rank = (e: { health: string; http: unknown }) =>
    (e.http ? 2 : 0) + (e.health === 'critical' || e.health === 'warning' ? 1 : 0);
  const edge = [...map.edges].sort((a, b) => rank(b) - rank(a))[0];
  return edge ? { edge: edge.id, node: edge.source } : null;
}

/** How the content pane, the map's filters and its panel scroll. */
async function mapScroll(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector('main')!;
    const el = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
    const info = (e: HTMLElement | null) =>
      e && {
        overflowY: getComputedStyle(e).overflowY,
        extra: e.scrollHeight - e.clientHeight,
        top: e.scrollTop,
      };
    return {
      main: main.scrollHeight - main.clientHeight,
      mainTop: main.scrollTop,
      doc: document.scrollingElement?.scrollTop ?? 0,
      wide: document.documentElement.scrollWidth - window.innerWidth,
      panel: info(el('map-panel')),
      filters: info(el('map-filters')),
    };
  });
}

// The service map with an edge or a node selected: on a desktop the page doesn't scroll at
// all (the map fills the height, the filters and the panel scroll inside); on a phone it
// stacks and the content pane scrolls.
// One sign-in for these three (sign-in is rate-limited).
let session: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;
for (const vp of VIEWPORTS) {
  test(`service map with a selection: ${vp.name}`, async ({ browser }) => {
    test.skip(!email || !password, 'set WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD');
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      storageState: session,
    });
    const page = await context.newPage();
    if (!session) {
      const login = await page.request.post('/api/v1/auth/login', { data: { email, password } });
      expect(login.ok()).toBe(true);
      session = await context.storageState();
    }
    const clusters = (await (await page.request.get('/api/v1/clusters')).json()).clusters as {
      id: string;
      kind: string;
    }[];
    const failures: string[] = [];
    let checked = 0;
    for (const kind of ['kubernetes', 'docker']) {
      const c = clusters.find((x) => x.kind === kind);
      const sel = c && (await mapSelection(page, c.id));
      if (!c || !sel) continue;
      for (const [type, id] of [
        ['edge', sel.edge],
        ['node', sel.node],
      ] as const) {
        const path = `/service-map?cluster=${c.id}&view=map&${type}=${encodeURIComponent(id)}`;
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await expect(page.getByTestId('map-panel')).toBeVisible();
        // Every section open: the panel at its longest.
        const closed = page.locator('[aria-expanded="false"][data-testid$="-toggle"]');
        while ((await closed.count()) > 0) await closed.first().click();
        checked++;
        const at = `${kind} ${type}`;
        const s = await mapScroll(page);
        if (s.wide > 0) failures.push(`${at}: ${s.wide} px of horizontal scroll`);
        if (vp.width < 1024) {
          // Stacked: the content pane scrolls, the panel doesn't scroll on its own.
          if (s.panel?.overflowY !== 'visible')
            failures.push(`${at}: the panel scrolls inside on a phone`);
          continue;
        }
        if (s.main > 1 || s.doc !== 0) failures.push(`${at}: the page scrolls (${s.main} px)`);
        for (const [name, box] of [
          ['panel', s.panel],
          ['filters', s.filters],
        ] as const) {
          if (!box) continue; // the filters fold above the map below 1280 px
          if (box.overflowY !== 'auto') failures.push(`${at}: the ${name} can't scroll inside`);
          if (box.extra <= 0) continue;
          const r = (await page.getByTestId(`map-${name}`).boundingBox())!;
          await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
          await page.mouse.wheel(0, 4000);
          await page.waitForTimeout(150);
          const after = await mapScroll(page);
          if (!after[name]?.top) failures.push(`${at}: the wheel doesn't scroll the ${name}`);
          if (after.mainTop !== 0 || after.doc !== 0)
            failures.push(`${at}: scrolling the ${name} moved the page`);
        }
        // The edge's panel, every section open, is longer than any desktop.
        if (type === 'edge' && !(s.panel!.extra > 0))
          failures.push(`${at}: the panel has every chart open and still no scroll`);
      }
    }
    expect(checked, 'no cluster with a service map edge').toBeGreaterThan(0);
    expect(failures, failures.join('\n')).toEqual([]);
    await context.close();
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
