// SPDX-License-Identifier: AGPL-3.0-only
// The light theme (0.12.0, ADR-228) in a real browser: Light stays after a reload (and, signed
// in, is saved on the user), System follows the computer's setting live, index.html's script
// sets the theme before the app runs, the Theme row works from the keyboard with its names,
// and screenshots of the main pages in light at 1440 and 390 px (Overview, a Server page, a
// server workload, a Kubernetes workload, Alerts, All clusters).
// Against a running dashboard with data and an account, as e2e/responsive.spec.ts:
//   WATCHLOG_E2E_URL=… WATCHLOG_E2E_EMAIL=… WATCHLOG_E2E_PASSWORD=… or WATCHLOG_E2E_DEMO=true
//   pnpm exec playwright test e2e/theme.spec.ts
// Screenshots go to e2e/screenshots/ (git-ignored), or to WATCHLOG_E2E_SHOT_DIR.
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';

const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;
const demo = process.env.WATCHLOG_E2E_DEMO === 'true';
const SHOT_DIR = (
  process.env.WATCHLOG_E2E_SHOT_DIR ?? new URL('./screenshots/', import.meta.url).pathname
).replace(/\/+$/, '');

async function signIn(api: APIRequestContext) {
  if (demo) {
    const res = await api.post('/api/v1/demo/session');
    expect(res.ok(), `demo session: ${res.status()}`).toBe(true);
    return;
  }
  if (!email || !password) throw new Error('set WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD');
  const turnstile = process.env.WATCHLOG_E2E_TURNSTILE;
  const res = await api.post('/api/v1/auth/login', {
    data: { email, password, ...(turnstile ? { turnstileToken: turnstile } : {}) },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

// One sign-in for the whole file (sign-in is rate-limited); every test gets its cookies.
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
test.beforeAll(async ({ playwright, baseURL }) => {
  const api = await playwright.request.newContext({ baseURL });
  await signIn(api);
  cookies = (await api.storageState()).cookies;
  await api.dispose();
});
test.beforeEach(async ({ context }) => context.addCookies(cookies));

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);

async function openMenu(page: Page) {
  await page.getByTestId('account-menu-button').first().click();
  await expect(page.getByTestId('account-menu')).toBeVisible();
}

/** Back to System, here and on the user, so each test starts from the default. */
async function reset(page: Page) {
  await page.evaluate(() => localStorage.removeItem('watchlog.theme'));
  if (!demo) await page.request.patch('/api/v1/me/preferences', { data: { theme: 'system' } });
}

test.describe('the theme', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await reset(page);
    await page.reload();
    // Signed in and loaded: the user's saved theme has been applied (it wins on load).
    await expect(page.getByTestId('account-menu-button').first()).toBeVisible();
  });
  test.afterEach(async ({ page }) => reset(page));

  test('Light stays after a reload, and is saved on the user', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openMenu(page);
    await page.getByRole('menuitemradio', { name: 'Light' }).click();
    expect(await theme(page)).toBe('light');
    // Picking keeps the menu open.
    await expect(page.getByTestId('account-menu')).toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: 'Light' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    if (!demo) {
      await expect
        .poll(async () => ((await (await page.request.get('/api/v1/me')).json()) as never)['user'])
        .toMatchObject({ theme: 'light' });
    }
    await page.reload();
    expect(await theme(page)).toBe('light');
    // The browser chrome's colour follows the chosen theme's background.
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    );
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', bg);
  });

  test("System follows the computer's setting, live", async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => theme(page)).toBe('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => theme(page)).toBe('dark');
    // Dark is chosen: the computer's setting no longer matters.
    await openMenu(page);
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(200);
    expect(await theme(page)).toBe('dark');
  });

  test("index.html sets the theme before the app's script runs", async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('watchlog.theme', 'light'));
    await page.emulateMedia({ colorScheme: 'dark' });
    // Without the app's script, only index.html's inline one can set it.
    await page.route(/\/src\/main\.ts|\/assets\/index-[^/]+\.js/, (r) => r.abort());
    await page.goto('/');
    expect(await theme(page)).toBe('light');
    await page.unroute(/\/src\/main\.ts|\/assets\/index-[^/]+\.js/);
  });

  test('the Theme row from the keyboard, with its names', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    const button = page.getByTestId('account-menu-button').first();
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('account-menu')).toBeVisible();
    const group = page.getByRole('group', { name: 'Theme' });
    await expect(group.getByRole('menuitemradio')).toHaveCount(3);
    for (const name of ['System (follows your computer)', 'Light', 'Dark']) {
      await expect(group.getByRole('menuitemradio', { name })).toHaveAttribute('title', name);
    }
    // Down through the items until the first theme button has the focus.
    const focused = () =>
      page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
    for (let i = 0; i < 10 && (await focused()) !== 'System (follows your computer)'; i++) {
      await page.keyboard.press('ArrowDown');
    }
    expect(await focused()).toBe('System (follows your computer)');
    await page.keyboard.press('ArrowRight');
    expect(await focused()).toBe('Light');
    await page.keyboard.press('Enter');
    expect(await theme(page)).toBe('light');
    await expect(page.getByTestId('account-menu')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    expect(await focused()).toBe('System (follows your computer)');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('account-menu')).toBeHidden();
    await expect(button).toBeFocused();
    // 36×32 on a desk.
    await openMenu(page);
    const box = await group.getByRole('menuitemradio', { name: 'Dark' }).boundingBox();
    expect([Math.round(box!.width), Math.round(box!.height)]).toEqual([36, 32]);
  });

  test('44 px theme buttons on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByTestId('nav-open').click();
    await page.getByTestId('nav-drawer').getByTestId('account-menu-button').click();
    await expect(page.getByTestId('account-menu')).toBeVisible();
    for (const name of ['System (follows your computer)', 'Light', 'Dark']) {
      const box = await page.getByRole('menuitemradio', { name }).boundingBox();
      expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
    }
  });
});

interface Cluster {
  id: string;
  kind: 'kubernetes' | 'server';
}

async function pages(api: APIRequestContext): Promise<{ name: string; path: string }[]> {
  const get = async <T>(path: string) => (await (await api.get(`/api/v1${path}`)).json()) as T;
  const { clusters } = await get<{ clusters: Cluster[] }>('/clusters');
  const kube = clusters.find((c) => c.kind === 'kubernetes');
  const fleet = clusters.find((c) => c.kind === 'server');
  const list: { name: string; path: string }[] = [];
  for (const c of [kube, fleet]) {
    if (c) list.push({ name: `overview-${c.kind}`, path: `/?cluster=${c.id}` });
  }
  if (kube) {
    const { workloads } = await get<{
      workloads: { kind: string; namespace: string; name: string }[];
    }>(`/clusters/${kube.id}/workloads?range=3600`);
    const apps = workloads.filter((x) => !/^(kube-|ingress-|local-path|watchlog)/.test(x.namespace));
    const w = apps.find((x) => x.kind === 'Deployment') ?? apps[0] ?? workloads[0];
    if (w) {
      const q = new URLSearchParams({
        view: 'pods',
        wkind: w.kind,
        wns: w.namespace,
        wname: w.name,
      });
      list.push({ name: 'workload-kubernetes', path: `/workloads?cluster=${kube.id}&${q}` });
    }
  }
  if (fleet) {
    const { servers, workloads = [] } = await get<{
      servers: { name: string }[];
      workloads?: { id: string; server: string; source: string }[];
    }>(`/clusters/${fleet.id}/servers?workloads=1`);
    if (servers[0]) {
      list.push({
        name: 'server',
        path: `/servers/${encodeURIComponent(servers[0].name)}?cluster=${fleet.id}`,
      });
    }
    const w = workloads.find((x) => x.source !== 'container') ?? workloads[0];
    if (w) {
      list.push({
        name: 'workload-server',
        path: `/servers/${encodeURIComponent(w.server)}/workloads/${encodeURIComponent(w.id)}?cluster=${fleet.id}`,
      });
    }
  }
  list.push({ name: 'alerts', path: '/alerts' }, { name: 'all-clusters', path: '/all' });
  return list;
}

for (const width of [1440, 390]) {
  test(`screenshots in light, ${width} px`, async ({ page }) => {
    await page.setViewportSize(width === 1440 ? { width, height: 1000 } : { width, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    for (const p of await pages(page.request)) {
      await page.goto(p.path);
      await page.waitForLoadState('networkidle');
      await page
        .waitForFunction(
          () => !document.querySelector('[data-skeleton], [aria-busy="true"]'),
          null,
          {
            timeout: 15_000,
          },
        )
        .catch(() => {});
      await page.waitForTimeout(600);
      expect(await theme(page), p.name).toBe('light');
      await page.screenshot({
        path: `${SHOT_DIR}/theme-light-${p.name}-${width}.png`,
        fullPage: true,
      });
    }
  });
}
