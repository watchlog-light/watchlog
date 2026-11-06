// SPDX-License-Identifier: AGPL-3.0-only
// Every dashboard route at 360, 390, 768, 1024 and 1280 px: no horizontal page scroll,
// no text under 12 px (11 px uppercase micro-labels aside), touch targets of 44 px below
// 1024 px. Screenshots of the priority pages at 390×844 and 768×1024 go to
// e2e/screenshots/ (git-ignored).
//
// Needs a running dashboard with data (`pnpm dev` and deploy/test/demo-up.sh) and an
// account: WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD. It picks the first Kubernetes
// cluster and the first Docker fleet (or WATCHLOG_E2E_KUBE / WATCHLOG_E2E_DOCKER, by name).
// While working on a page: WATCHLOG_E2E_ONLY=overview,nodes and WATCHLOG_E2E_WIDTHS=390.
import { existsSync, mkdirSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { layoutProblems, report, SHOTS, viewportFor, WIDTHS } from './layout-checks';

const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;
const SHOT_DIR = new URL('./screenshots/', import.meta.url).pathname;
// The session is reused between runs (sign-in is rate-limited); git-ignored.
const AUTH_FILE = new URL('./.auth/session.json', import.meta.url).pathname;

interface Cluster {
  id: string;
  name: string;
  kind: 'kubernetes' | 'docker';
}

interface Route {
  name: string;
  path: string;
  /** Screenshot it at the phone and tablet sizes. */
  shot?: boolean;
  /** Something to do before checking (open a drawer, a sheet, a menu). */
  prepare?: (page: Page) => Promise<void>;
  /** Public page: checked signed out. */
  public?: boolean;
}

const get = async <T>(api: APIRequestContext, path: string): Promise<T> => {
  const res = await api.get(`/api/v1${path}`);
  expect(res.ok(), `GET ${path}: ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
};

async function signIn(api: APIRequestContext) {
  if (!email || !password) throw new Error('set WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD');
  const res = await api.post('/api/v1/auth/login', { data: { email, password } });
  expect(res.ok(), `sign-in: ${res.status()}`).toBeTruthy();
}

/** The routes, with real names and ids from the API. */
async function discover(api: APIRequestContext): Promise<Route[]> {
  const { clusters } = await get<{ clusters: Cluster[] }>(api, '/clusters');
  const pick = (kind: Cluster['kind'], name?: string) =>
    clusters.find((c) => c.kind === kind && (!name || c.name === name));
  const kube = pick('kubernetes', process.env.WATCHLOG_E2E_KUBE);
  const docker = pick('docker', process.env.WATCHLOG_E2E_DOCKER);
  if (!kube || !docker) throw new Error('needs a Kubernetes cluster and a Docker fleet with data');
  const k = `?cluster=${kube.id}`;
  const d = `?cluster=${docker.id}`;

  const { nodes } = await get<{ nodes: { name: string }[] }>(api, `/clusters/${kube.id}/nodes`);
  const { pods } = await get<{ pods: { namespace: string; name: string; phase?: string }[] }>(
    api,
    `/clusters/${kube.id}/pods`,
  );
  const { hosts } = await get<{ hosts: { name: string }[] }>(
    api,
    `/clusters/${docker.id}/docker/hosts`,
  );
  const { containers } = await get<{ containers: { host: string; name: string }[] }>(
    api,
    `/clusters/${docker.id}/docker/containers`,
  );
  const { alerts } = await get<{ alerts: { id: string }[] }>(api, '/alerts');
  const pod = pods.find((p) => p.namespace === 'shop') ?? pods[0];
  const container = containers.find((c) => c.name.startsWith('storefront')) ?? containers[0];

  const routes: Route[] = [
    { name: 'login', path: '/login', public: true, shot: true },
    { name: 'overview', path: `/${k}`, shot: true },
    { name: 'overview-docker', path: `/${d}`, shot: true },
    { name: 'nodes', path: `/nodes${k}`, shot: true },
    { name: 'node', path: `/nodes/${encodeURIComponent(nodes[0]!.name)}${k}`, shot: true },
    { name: 'workloads', path: `/workloads${k}`, shot: true },
    { name: 'pods', path: `/workloads${k}&view=pods`, shot: true },
    {
      name: 'pod',
      path: `/pods/${encodeURIComponent(pod!.namespace)}/${encodeURIComponent(pod!.name)}${k}`,
      shot: true,
    },
    { name: 'events', path: `/events${k}`, shot: true },
    { name: 'events-docker', path: `/events${d}` },
    { name: 'service-map', path: `/service-map${k}`, shot: true },
    {
      name: 'service-map-graph',
      path: `/service-map${k}`,
      shot: true,
      // Phones open on Connections with an "Open map" button; wider screens on the map.
      prepare: (page) =>
        page.getByTestId((page.viewportSize()?.width ?? 0) < 768 ? 'open-map' : 'view-map').click(),
    },
    { name: 'hosts', path: `/hosts${d}`, shot: true },
    { name: 'host', path: `/hosts/${encodeURIComponent(hosts[0]!.name)}${d}`, shot: true },
    { name: 'containers', path: `/containers${d}`, shot: true },
    {
      name: 'container',
      path: `/containers/${encodeURIComponent(container!.host)}/${encodeURIComponent(container!.name)}${d}`,
      shot: true,
    },
    { name: 'alerts', path: `/alerts${k}`, shot: true },
    { name: 'alerts-history', path: `/alerts${k}&view=history` },
    { name: 'alerts-rules', path: `/alerts${k}&view=rules`, shot: true },
    {
      name: 'rule-editor',
      path: `/alerts${k}&view=rules`,
      shot: true,
      prepare: (page) => page.getByTestId('new-rule').click(),
    },
    { name: 'alerts-silences', path: `/alerts${k}&view=silences` },
    { name: 'settings', path: `/settings${k}`, shot: true },
    { name: 'settings-channels', path: `/settings${k}&tab=channels`, shot: true },
    { name: 'settings-general', path: `/settings${k}&tab=general`, shot: true },
    { name: 'cluster-settings', path: `/settings/clusters/${kube.id}${k}`, shot: true },
    {
      name: 'nav-drawer',
      path: `/${k}`,
      shot: true,
      prepare: async (page) => {
        if ((page.viewportSize()?.width ?? 0) < 1024) await page.getByTestId('nav-open').click();
      },
    },
    {
      name: 'cluster-switcher',
      path: `/${k}`,
      shot: true,
      prepare: async (page) => {
        // Phones: in the filter sheet; tablets: in the top bar.
        if ((page.viewportSize()?.width ?? 0) < 768) await page.getByTestId('filters-open').click();
        await page.getByTestId('cluster-switcher').click();
      },
    },
    { name: 'not-found', path: `/no-such-page${k}` },
  ];
  if (alerts[0]) routes.push({ name: 'alert', path: `/alerts/${alerts[0].id}${k}`, shot: true });
  const only = process.env.WATCHLOG_E2E_ONLY?.split(',');
  return only ? routes.filter((r) => only.includes(r.name)) : routes;
}

/** Waits until the page has drawn its data: no skeletons or loading indicators left. */
async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page
    .waitForFunction(() => !document.querySelector('[data-skeleton], [aria-busy="true"]'), null, {
      timeout: 15_000,
    })
    .catch(() => {});
  await page.waitForTimeout(400);
}

let routes: Route[] = [];
let storage: Awaited<ReturnType<APIRequestContext['storageState']>>;

test.beforeAll(async ({ playwright, baseURL }) => {
  let api = await playwright.request.newContext({
    baseURL,
    ...(existsSync(AUTH_FILE) ? { storageState: AUTH_FILE } : {}),
  });
  if (!(await api.get('/api/v1/me')).ok()) {
    await api.dispose();
    api = await playwright.request.newContext({ baseURL });
    await signIn(api);
    mkdirSync(new URL('./.auth/', import.meta.url).pathname, { recursive: true });
    await api.storageState({ path: AUTH_FILE });
  }
  routes = await discover(api);
  storage = await api.storageState();
  await api.dispose();
});

const widths = process.env.WATCHLOG_E2E_WIDTHS?.split(',').map(Number) ?? WIDTHS;
for (const width of widths) {
  test(`every route at ${width}px: no page scroll, text ≥ 12 px, touch targets`, async ({
    browser,
  }) => {
    const failures: string[] = [];
    for (const signedIn of [true, false]) {
      const context = await browser.newContext({
        ...viewportFor(width),
        ...(signedIn ? { storageState: storage } : {}),
      });
      const page = await context.newPage();
      for (const route of routes.filter((r) => !!r.public !== signedIn)) {
        await page.goto(route.path);
        await settle(page);
        if (route.prepare) {
          try {
            await route.prepare(page);
          } catch (err) {
            failures.push(`${route.name} at ${width}px: ${String(err).split('\n')[0]}`);
            continue;
          }
          await page.waitForTimeout(400);
        }
        const problems = await layoutProblems(page);
        if (problems.length) failures.push(report(route.name, width, problems));
        const shot = SHOTS.find((s) => s.width === width);
        if (route.shot && shot) {
          await page.setViewportSize({ width: shot.width, height: shot.height });
          // The shell scrolls <main>, not the page: let it grow for a full-page picture.
          if (!route.prepare)
            await page.addStyleTag({
              content:
                '.h-dvh { height: auto !important; overflow: visible !important } main { overflow: visible !important }',
            });
          await page.screenshot({
            path: `${SHOT_DIR}${route.name}-${shot.name}.png`,
            fullPage: !route.prepare,
          });
        }
      }
      await context.close();
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
}

test('service map on a phone: Connections first, then the map pans and pinch-zooms by touch', async ({
  browser,
}) => {
  const context = await browser.newContext({ ...viewportFor(390), storageState: storage });
  const page = await context.newPage();
  const map = routes.find((r) => r.name === 'service-map');
  test.skip(!map, 'service map not in this run');
  await page.goto(map!.path);
  await settle(page);
  await expect(page.getByTestId('connections-table')).toBeVisible();
  await page.getByTestId('open-map').click();
  const svg = page.getByTestId('map-canvas').locator('svg').first();
  await expect(svg).toBeVisible();
  await page.waitForTimeout(800); // the fit animation
  const transform = async () => {
    const t = (await svg.locator('> g').first().getAttribute('transform')) ?? '';
    const [tx, ty, k] = (t.match(/-?[\d.]+/g) ?? []).map(Number);
    return { tx: tx!, ty: ty!, k: k! };
  };
  await svg.scrollIntoViewIfNeeded();
  const box = (await svg.boundingBox())!;
  // Near the bottom-left corner: background, away from the nodes and the zoom buttons.
  const y = box.y + box.height - 60;
  const x = box.x + 40;
  const cdp = await context.newCDPSession(page);
  const touch = (type: string, points: { x: number; y: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p, id) => ({ ...p, id })),
    });

  const before = await transform();
  await touch('touchStart', [{ x, y }]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [{ x: x + i * 12, y: y - i * 8 }]);
  await touch('touchEnd', []);
  const panned = await transform();
  expect(panned.tx).toBeGreaterThan(before.tx + 30);
  expect(panned.k).toBeCloseTo(before.k, 5);

  await touch('touchStart', [
    { x, y },
    { x: x + 40, y },
  ]);
  for (let i = 1; i <= 6; i++)
    await touch('touchMove', [
      { x: x - i * 2, y },
      { x: x + 40 + i * 20, y },
    ]);
  await touch('touchEnd', []);
  const pinched = await transform();
  expect(pinched.k).toBeGreaterThan(panned.k * 1.5);
  await context.close();
});
