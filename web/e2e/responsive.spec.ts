// SPDX-License-Identifier: AGPL-3.0-only
// Every dashboard route at 360, 390, 768, 1024 and 1280 px: no horizontal page scroll,
// no text under 12 px (11 px uppercase micro-labels aside), touch targets of 44 px below
// 1024 px. Screenshots of the priority pages at 390×844 and 768×1024 go to
// e2e/screenshots/ (git-ignored).
//
// Needs a running dashboard with stored data (`pnpm dev`; deploy/test/demo-up.sh fills it) and an
// account: WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD, or WATCHLOG_E2E_DEMO=true against a
// read-only demo (WATCHLOG_DEMO_MODE=true, ADR-122), which enters through /demo. It picks the first Kubernetes
// cluster and the first Docker fleet (or WATCHLOG_E2E_KUBE / WATCHLOG_E2E_DOCKER, by name).
// While working on a page: WATCHLOG_E2E_ONLY=overview,nodes and WATCHLOG_E2E_WIDTHS=390.
import { existsSync, mkdirSync } from 'node:fs';
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { SERVICE_MAPS } from './fixtures/service-map';
import { layoutProblems, report, SHOTS, viewportFor, WIDTHS } from './layout-checks';

const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;
const demo = process.env.WATCHLOG_E2E_DEMO === 'true';
const SHOT_DIR = new URL('./screenshots/', import.meta.url).pathname;
// The session is reused between runs (sign-in is rate-limited); git-ignored.
const AUTH_FILE = new URL(`./.auth/session${demo ? '-demo' : ''}.json`, import.meta.url).pathname;

interface Cluster {
  id: string;
  name: string;
  kind: 'kubernetes' | 'docker';
  lastSeenAt: string | null;
}

/** An API response answered by a fixture while a route is checked. */
interface Answer {
  url: RegExp;
  json: unknown;
}

/** The service map of a cluster, from a fixture: the checks don't need a live cluster. */
const serviceMapAnswer = (c: Cluster): Answer => ({
  url: new RegExp(`/api/v1/clusters/${c.id}/service-map\\?`),
  json: SERVICE_MAPS[c.kind],
});

/** A cluster that reported in the last 10 minutes, for the optional live-data check. */
const LIVE_MS = 10 * 60_000;
const isLive = (c: Cluster) => !!c.lastSeenAt && Date.now() - Date.parse(c.lastSeenAt) < LIVE_MS;

interface Route {
  name: string;
  path: string;
  /** Screenshot it at the phone and tablet sizes. */
  shot?: boolean;
  /** Something to do before checking (open a drawer, a sheet, a menu). */
  prepare?: (page: Page) => Promise<void>;
  /** Public page: checked signed out. */
  public?: boolean;
  /** API responses answered by fixtures while it is checked. */
  answer?: Answer;
}

const get = async <T>(api: APIRequestContext, path: string): Promise<T> => {
  const res = await api.get(`/api/v1${path}`);
  expect(res.ok(), `GET ${path}: ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
};

async function signIn(api: APIRequestContext) {
  if (demo) {
    const res = await api.post('/api/v1/demo/session');
    expect(res.ok(), `demo session: ${res.status()}`).toBeTruthy();
    return;
  }
  if (!email || !password) throw new Error('set WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD');
  const res = await api.post('/api/v1/auth/login', { data: { email, password } });
  expect(res.ok(), `sign-in: ${res.status()}`).toBeTruthy();
}

/** The routes, with real names and ids from the API. */
/** A local dev dashboard, outside CI: the only place the suite may make an API token. */
function mayCreateToken(baseURL: string | undefined): boolean {
  if (process.env.CI || !baseURL) return false;
  const host = new URL(baseURL).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

async function discover(api: APIRequestContext, baseURL: string | undefined): Promise<Route[]> {
  const { clusters } = await get<{ clusters: Cluster[] }>(api, '/clusters');
  const pick = (kind: Cluster['kind'], name?: string) =>
    clusters.find((c) => c.kind === kind && (!name || c.name === name));
  const kube = pick('kubernetes', process.env.WATCHLOG_E2E_KUBE);
  const docker = pick('docker', process.env.WATCHLOG_E2E_DOCKER);
  if (!kube || !docker) throw new Error('needs a Kubernetes cluster and a Docker fleet with data');
  const k = `?cluster=${kube.id}`;
  const d = `?cluster=${docker.id}`;
  clustersByKind = { kubernetes: kube, docker };
  liveClusters = {
    kubernetes: clusters.find((c) => c.kind === 'kubernetes' && isLive(c)),
    docker: clusters.find((c) => c.kind === 'docker' && isLive(c)),
  };

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
  // API tokens (ADR-125): one usable token, so the list, its dialogs and the detail have a
  // row. Made once and reused; the reveal below answers its POST without making another.
  // Made only against a dev dashboard on this machine, never in CI or on a shared install:
  // elsewhere, without a usable token, the token routes are left out.
  let tokenId: string | undefined;
  if (!demo) {
    const { tokens } = await get<{ tokens: { id: string; status: string }[] }>(api, '/api-tokens');
    tokenId = tokens.find((t) => t.status !== 'expired' && t.status !== 'revoked')?.id;
    if (!tokenId && mayCreateToken(baseURL)) {
      const res = await api.post('/api/v1/api-tokens', {
        data: { name: 'Responsive check', expiresInDays: 30 },
      });
      expect(res.ok(), `POST /api-tokens: ${res.status()}`).toBeTruthy();
      tokenId = ((await res.json()) as { token: { id: string } }).token.id;
    }
  }
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
    // Applications (v0.3 slice 2): whatever the dev stack monitors and discovers.
    { name: 'applications', path: `/applications${k}`, shot: true },
    { name: 'applications-docker', path: `/applications${d}` },
    { name: 'events-docker', path: `/events${d}` },
    // The service map from fixtures, for a Kubernetes cluster and a Docker host: these
    // checks hold whether or not a cluster is reporting right now.
    { name: 'service-map', path: `/service-map${k}`, shot: true, answer: serviceMapAnswer(kube) },
    {
      name: 'service-map-graph',
      path: `/service-map${k}`,
      shot: true,
      answer: serviceMapAnswer(kube),
      prepare: openMap,
    },
    {
      name: 'service-map-docker',
      path: `/service-map${d}`,
      shot: true,
      answer: serviceMapAnswer(docker),
    },
    {
      name: 'service-map-docker-graph',
      path: `/service-map${d}`,
      shot: true,
      answer: serviceMapAnswer(docker),
      prepare: openMap,
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
    { name: 'settings-tokens', path: `/settings${k}&tab=tokens`, shot: true },
    {
      // The read-only demo's state, with the public MCP token it gets in slice 7.
      name: 'settings-tokens-demo',
      path: `/settings${k}&tab=tokens`,
      shot: true,
      prepare: (page) =>
        answerOnce(page, '**/api/v1/setup', {
          required: false,
          demoMode: true,
          demoMcpToken: 'wl_demo_public_readonly',
        }),
    },
    ...(tokenId ? tokenRoutes(k, tokenId) : []),
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
  // The read-only demo has no rule editor to open, and its own tokens state.
  const available = demo
    ? routes.filter((r) => r.name !== 'rule-editor' && r.name !== 'settings-tokens-demo')
    : routes;
  return only ? available.filter((r) => only.includes(r.name)) : available;
}

/** Reloads the page with one API path answered by `json`, then lets it through again. */
async function answerOnce(page: Page, url: string, json: unknown) {
  await page.route(url, (r) =>
    r.request().method() === 'GET' ? r.fulfill({ json }) : r.fallback(),
  );
  await page.reload();
  await settle(page);
  await page.unroute(url);
}

/** Settings → API tokens: create, the one-time reveal, revoke and the detail (ADR-125). */
function tokenRoutes(k: string, id: string): Route[] {
  const list = `/settings${k}&tab=tokens`;
  const openCreate = (page: Page) => page.getByTestId('api-token-create').click();
  return [
    { name: 'api-token-create', path: list, shot: true, prepare: openCreate },
    {
      name: 'api-token-reveal',
      path: list,
      shot: true,
      prepare: async (page) => {
        // Answered here: the reveal is checked without making a token each run.
        const now = new Date().toISOString();
        const json = {
          value: 'wl_pat_9fK2mQ7xTb4LhR8vN3cZ1sWd6YpE0aGuXyZ1234567',
          token: {
            id: '01a1a000-0000-7000-8000-00000000e2e0',
            name: 'Claude Code on my laptop',
            prefix: 'wl_pat_9fK2',
            scope: 'read',
            createdAt: now,
            expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
            status: 'active',
            lastUsedAt: null,
            lastUsedIp: null,
            lastUsedCountry: null,
            usedRest: false,
            mcpCalls30d: 0,
            revokedAt: null,
          },
        };
        const url = '**/api/v1/api-tokens';
        await page.route(url, (r) =>
          r.request().method() === 'POST' ? r.fulfill({ status: 201, json }) : r.fallback(),
        );
        await openCreate(page);
        await page.getByTestId('api-token-name').locator('input').fill(json.token.name);
        await page.getByTestId('api-token-create-submit').click();
        await page.getByTestId('api-token-reveal').waitFor();
        await page.unroute(url);
      },
    },
    {
      name: 'api-token-revoke',
      path: list,
      shot: true,
      prepare: (page) => page.getByTestId('api-token-revoke').first().click(),
    },
    { name: 'api-token', path: `/settings/api-tokens/${id}${k}`, shot: true },
    {
      // MCP calls arrive in slice 4: the activity table and cards with sample rows.
      name: 'api-token-activity',
      path: `/settings/api-tokens/${id}${k}`,
      shot: true,
      prepare: async (page) => {
        const res = await page.request.get(`/api/v1/api-tokens/${id}`);
        const detail = (await res.json()) as Record<string, unknown>;
        const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
        const activity = [
          ['get_problems', 'cluster prod-eu', 'ok', 182, 3174],
          ['get_workload', 'prod-eu · shop/api', 'ok', 95, 2458],
          ['query_metric', 'shop/api · cpu · last 1h', 'truncated', 410, 16384],
          ['list_containers', 'docker-01 · project billing', 'ok', 77, 2253],
          ['get_events', 'prod-eu · last 30 min', 'rate_limited', 2, 102],
        ].map(([tool, args, status, durationMs, bytes], i) => ({
          at: at(60 * i),
          tool,
          args,
          status,
          durationMs,
          bytes,
        }));
        await answerOnce(page, `**/api/v1/api-tokens/${id}`, { ...detail, activity });
      },
    },
  ];
}

/** Phones open the service map on Connections with an "Open map" button; wider screens on the map. */
const openMap = (page: Page) =>
  page.getByTestId((page.viewportSize()?.width ?? 0) < 768 ? 'open-map' : 'view-map').click();

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
let clustersByKind: Record<Cluster['kind'], Cluster> | undefined;
let liveClusters: Partial<Record<Cluster['kind'], Cluster>> = {};
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
  routes = await discover(api, baseURL);
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
        const answer = route.answer;
        if (answer) await page.route(answer.url, (r) => r.fulfill({ json: answer.json }));
        try {
          await checkRoute(page, route, width, failures);
        } finally {
          if (answer) await page.unroute(answer.url);
        }
      }
      await context.close();
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
}

/** Loads a route, prepares it, checks the layout rules and takes its screenshots. */
async function checkRoute(page: Page, route: Route, width: number, failures: string[]) {
  await page.goto(route.path);
  await settle(page);
  if (route.prepare) {
    try {
      await route.prepare(page);
    } catch (err) {
      failures.push(`${route.name} at ${width}px: ${String(err).split('\n')[0]}`);
      return;
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

for (const kind of ['kubernetes', 'docker'] as const) {
  test(`service map on a phone (${kind}): Connections first, then the map pans and pinch-zooms by touch`, async ({
    browser,
  }) => {
    const route = routes.find(
      (r) => r.name === (kind === 'docker' ? 'service-map-docker' : 'service-map'),
    );
    test.skip(!route, 'service map not in this run');
    const context = await browser.newContext({ ...viewportFor(390), storageState: storage });
    const page = await context.newPage();
    const answer = route!.answer!;
    await page.route(answer.url, (r) => r.fulfill({ json: answer.json }));
    await page.goto(route!.path);
    await settle(page);
    await expect(page.getByTestId('connections-table')).toBeVisible();
    await page.getByTestId('open-map').click();
    await panAndPinch(page, context);
    await context.close();
  });
}

// Optional: the same on a phone with the cluster's own data, when one reported in the last
// 10 minutes (deploy/test/demo-up.sh). The checks above never need it.
for (const kind of ['kubernetes', 'docker'] as const) {
  test(`service map on a phone with live data (${kind})`, async ({ browser }) => {
    const live = liveClusters[kind];
    const last = clustersByKind?.[kind]?.lastSeenAt;
    test.skip(
      !live,
      `no ${kind === 'docker' ? 'Docker host' : 'Kubernetes cluster'} reported in the last 10 minutes` +
        ` (last report: ${last ?? 'never'}); start one with deploy/test/demo-up.sh to run this check`,
    );
    const context = await browser.newContext({ ...viewportFor(390), storageState: storage });
    const page = await context.newPage();
    await page.goto(`/service-map?cluster=${live!.id}`);
    await settle(page);
    await expect(page.getByTestId('connections-table')).toBeVisible();
    await page.getByTestId('open-map').click();
    await expect(page.getByTestId('map-canvas').locator('svg').first()).toBeVisible();
    const problems = await layoutProblems(page);
    expect(problems, report(`service-map-live-${kind}`, 390, problems)).toEqual([]);
    await context.close();
  });
}

/** One finger pans the map; two fingers spreading zoom it in. */
async function panAndPinch(page: Page, context: BrowserContext) {
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
  const touch = (
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    points: { x: number; y: number }[],
  ) =>
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
}
