// SPDX-License-Identifier: AGPL-3.0-only
// Every dashboard route at 360, 390, 768, 1024 and 1280 px: no horizontal page scroll,
// no text under 12 px (11 px uppercase micro-labels aside), touch targets of 44 px below
// 1024 px. Screenshots of the priority pages at 390×844, 768×1024 and 1280×800 go to
// e2e/screenshots/ (git-ignored), or to WATCHLOG_E2E_SHOT_DIR.
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
import * as apps from './fixtures/applications';
import { CAUSES_URL, causeAnswers } from './fixtures/causes';
import * as people from './fixtures/users';
import { SERVICE_MAPS } from './fixtures/service-map';
import { layoutProblems, report, SHOTS, viewportFor, WIDTHS } from './layout-checks';

const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;
const demo = process.env.WATCHLOG_E2E_DEMO === 'true';
// WATCHLOG_E2E_SHOT_DIR puts the screenshots elsewhere (a review folder).
const SHOT_DIR = process.env.WATCHLOG_E2E_SHOT_DIR
  ? `${process.env.WATCHLOG_E2E_SHOT_DIR.replace(/\/+$/, '')}/`
  : new URL('./screenshots/', import.meta.url).pathname;
// The session is reused between runs (sign-in is rate-limited); git-ignored. One per
// dashboard, so a run against another backend doesn't sign the usual one out.
const TARGET = (process.env.WATCHLOG_E2E_URL ?? 'http://localhost:4088').replace(
  /[^a-z0-9]+/gi,
  '-',
);
const AUTH_FILE = new URL(`./.auth/session${demo ? '-demo' : ''}-${TARGET}.json`, import.meta.url)
  .pathname;

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
  /** GET unless set; other methods pass through. */
  method?: string;
  status?: number;
}

/** The service map of a cluster, from a fixture: the checks don't need a live cluster. */
const serviceMapAnswer = (c: Cluster): Answer => ({
  url: new RegExp(`/api/v1/clusters/${c.id}/service-map\\?`),
  json: SERVICE_MAPS[c.kind],
});

const hit = (r: Record<string, string | null>) => ({
  namespace: null,
  host: null,
  type: null,
  id: null,
  match: 'prefix',
  ...r,
});
/** The palette's search answers: a long name of each kind. */
const PALETTE_ANSWERS = {
  kubernetes: {
    query: 'shop',
    truncated: false,
    results: [
      hit({
        kind: 'workload',
        name: 'shop-payments-api',
        namespace: 'shop-production',
        type: 'Deployment',
      }),
      hit({ kind: 'pod', name: 'shop-payments-api-7d9f8c6b5-x2k4q', namespace: 'shop-production' }),
      hit({ kind: 'node', name: 'shop-pool-a-4vcpu-16gb-eu-west-1c-0f3a', match: 'substring' }),
      hit({
        kind: 'application',
        name: 'shop-production/redis',
        namespace: 'shop-production',
        type: 'redis',
        id: '01a18f0e-a6c2-71ef-a7b4-42d765746d40',
      }),
    ],
  },
  docker: {
    query: 'shop',
    truncated: false,
    results: [
      hit({ kind: 'compose_project', name: 'shop', host: 'docker-host-eu-west-1', match: 'exact' }),
      hit({ kind: 'host', name: 'shop-docker-host-eu-west-1' }),
      hit({
        kind: 'container',
        name: 'shop-payments-api-worker-1',
        namespace: 'shop',
        host: 'docker-host-eu-west-1',
      }),
      hit({
        kind: 'application',
        name: 'shop/postgres',
        namespace: 'shop',
        host: 'docker-host-eu-west-1',
        type: 'postgres',
        id: '01a18f0e-a6c2-71ef-a7b4-42d765746d41',
      }),
    ],
  },
};

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
  /** More of them (the connect flow's probes, a fixture service's page). */
  answers?: Answer[];
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
  const { containers } = await get<{
    containers: {
      host: string;
      name: string;
      composeProject: string | null;
      composeService: string | null;
    }[];
  }>(api, `/clusters/${docker.id}/docker/containers`);
  const { alerts } = await get<{ alerts: { id: string }[] }>(api, '/alerts');
  const { applications: monitored } = await get<{
    applications: {
      id: string;
      cluster: { kind: string };
      health: string;
      reason: { code: string };
    }[];
  }>(api, '/applications');
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
    ...applicationRoutes(kube, docker, k, d, monitored, hosts[0]?.name ?? 'docker-01'),
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
    // An edge and a node selected, every panel section open: the panel's toggles, its
    // numbers and its charts at every width (the desktop layout doesn't scroll the page;
    // scroll.spec.ts checks that).
    ...(
      [
        [
          'kube',
          k,
          kube,
          'w:shop/Deployment/frontend>w:shop/Deployment/cart:8080',
          'w:shop/Deployment/orders',
        ],
        ['docker', d, docker, 'c:storefront-api-1>c:storefront-db-1:5432', 'c:storefront-api-1'],
      ] as const
    ).flatMap(([name, q, c, edge, node]) => [
      {
        name: `service-map-edge-${name}`,
        path: `/service-map${q}&view=map&edge=${encodeURIComponent(edge)}`,
        shot: true,
        answer: serviceMapAnswer(c),
        prepare: openSections,
      },
      {
        name: `service-map-node-${name}`,
        path: `/service-map${q}&view=map&node=${encodeURIComponent(node)}`,
        answer: serviceMapAnswer(c),
        prepare: openSections,
      },
    ]),
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
    ...userRoutes(k),
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
    // The ⌘K palette (ADR-169): full screen on phones, a dialog above; fixture answers.
    ...(['kubernetes', 'docker'] as const).map((kind) => ({
      name: `palette-${kind}`,
      path: `/${kind === 'docker' ? d : k}`,
      shot: true,
      answer: {
        url: new RegExp(`/api/v1/clusters/${(kind === 'docker' ? docker : kube).id}/search\\?`),
        json: PALETTE_ANSWERS[kind],
      },
      prepare: async (page: Page) => {
        await page.getByTestId('palette-open').click();
        await page.getByTestId('palette-input').fill('shop');
        await expect(page.getByTestId('palette-option').first()).toBeVisible();
      },
    })),
    { name: 'not-found', path: `/no-such-page${k}` },
  ];
  if (alerts[0]) routes.push({ name: 'alert', path: `/alerts/${alerts[0].id}${k}`, shot: true });
  routes.push(...causeRoutes(kube, docker, k, d, alerts[0]?.id, pod!, container!));
  const only = process.env.WATCHLOG_E2E_ONLY?.split(',');
  // The read-only demo has no rule editor to open, and its own tokens state.
  const available = demo
    ? routes.filter((r) => r.name !== 'rule-editor' && r.name !== 'settings-tokens-demo')
    : routes;
  return only ? available.filter((r) => only.includes(r.name)) : available;
}

/**
 * The v0.3 pages (Applications, the service page, the connect flow, a service's settings
 * and rules) on both kinds. The connect flow's tests and saves are answered by fixtures,
 * so the suite writes nothing: no probe, credential or service is created.
 */
function applicationRoutes(
  kube: Cluster,
  docker: Cluster,
  k: string,
  d: string,
  monitored: { id: string; cluster: { kind: string }; health: string; reason: { code: string } }[],
  host: string,
): Route[] {
  const list = `/applications${k}`;
  const found: Answer = {
    url: /\/api\/v1\/applications\/discovered$/,
    json: apps.discovered(kube, docker, host),
  };
  const created = (json: Record<string, unknown>): Answer => ({
    url: /\/api\/v1\/applications\/probes$/,
    method: 'POST',
    status: 201,
    json,
  });
  const polled = (json: Record<string, unknown>): Answer => ({
    url: apps.PROBE_URL,
    json: { probe: apps.probe(json) },
  });
  const monitor = (name: string) => async (page: Page) => {
    await page.getByRole('button', { name: `Monitor ${name}` }).click();
    await page.getByTestId('monitor-drawer').waitFor();
  };
  const choose = async (page: Page, method: string) => {
    await page.locator(`[data-access="${method}"] input`).check();
  };
  const fields = (page: Page) =>
    page.getByTestId('access-step').locator('input:not([type="radio"])');
  const fixture = `/applications/${apps.FIXTURE_APP_ID}${k}`;
  const fixtureAnswers: Answer[] = [
    {
      url: new RegExp(`/api/v1/applications/${apps.FIXTURE_APP_ID}(\\?|$)`),
      json: apps.applicationDetail(kube),
    },
    {
      url: new RegExp(`/api/v1/applications/${apps.FIXTURE_APP_ID}/panels`),
      json: apps.applicationPanels(),
    },
    { url: /\/api\/v1\/alert-rules$/, json: { rules: apps.serviceRules(kube) } },
  ];
  const dockerApp = monitored.find(
    (a) => a.cluster.kind === 'docker' && a.reason.code === 'collector_missing',
  );
  const many: Answer = {
    url: /\/api\/v1\/applications\/discovered$/,
    json: apps.manyDiscovered(kube, docker, host),
  };
  const routes: Route[] = [
    // A busy host (item 4): monitored first, three found ones, "Show all 19"; Valkey named.
    { name: 'applications-many', path: list, shot: true, answers: [many] },
    {
      name: 'applications-many-all',
      path: list,
      shot: true,
      answers: [many],
      prepare: async (page) => {
        await page.getByTestId('discovered-toggle').click();
        await page.getByTestId('ignored-toggle').click();
      },
    },
    // Redis's default alerts in the connect drawer, each with its words.
    {
      name: 'connect-redis-alerts',
      path: list,
      shot: true,
      answers: [
        found,
        {
          url: /\/api\/v1\/applications\/alert-defaults\?type=redis$/,
          json: apps.redisAlertDefaults,
        },
      ],
      prepare: async (page) => {
        await monitor('storefront/sessions')(page);
        await page.getByTestId('default-alerts').waitFor();
      },
    },
    // Connect option a, generated user: the command and "trying", then a failed try, then
    // the probe expired (failed) with Check again.
    {
      name: 'connect-generated',
      path: list,
      shot: true,
      answers: [found, created({ probe: apps.probe(), command: apps.generatedCommand })],
      prepare: async (page) => {
        await monitor('shop/orders')(page);
        await page.getByTestId('access-start').click();
        await page.getByTestId('probe-status').waitFor();
      },
    },
    {
      name: 'connect-generated-retrying',
      path: list,
      shot: true,
      answers: [
        found,
        created({ probe: apps.probe(), command: apps.generatedCommand }),
        polled({
          attempts: 4,
          result: apps.failure('auth_failed', 'password authentication failed for user "watchlog"'),
        }),
      ],
      prepare: async (page) => {
        await monitor('shop/orders')(page);
        await page.getByTestId('access-start').click();
        await page.waitForTimeout(5_600);
      },
    },
    {
      name: 'connect-generated-failed',
      path: list,
      shot: true,
      answers: [
        found,
        created({ probe: apps.probe(), command: apps.generatedCommand }),
        polled({
          status: 'failed',
          attempts: 180,
          result: apps.failure('auth_failed', 'password authentication failed for user "watchlog"'),
        }),
      ],
      prepare: async (page) => {
        await monitor('shop/orders')(page);
        await page.getByTestId('access-start').click();
        await page.waitForTimeout(5_600);
      },
    },
    // Option b, an existing user that can do more than needed.
    {
      name: 'connect-entered',
      path: list,
      shot: true,
      answers: [
        found,
        created({
          probe: apps.probe({
            method: 'entered',
            username: 'postgres',
            status: 'ok',
            attempts: 1,
            result: apps.success('16.4', { databases: 3 }, ['superuser']),
          }),
        }),
      ],
      prepare: async (page) => {
        await monitor('shop/orders')(page);
        await choose(page, 'entered');
        await fields(page).nth(0).fill('postgres');
        await fields(page).nth(1).fill('not-a-real-password');
        await page.getByTestId('access-start').click();
        await page.getByTestId('probe-status').waitFor();
      },
    },
    // Option b again: logged in, but the user lacks a privilege; the fix names the grant.
    {
      name: 'connect-entered-missing',
      path: list,
      shot: true,
      answers: [
        found,
        created({
          probe: apps.probe({
            method: 'entered',
            username: 'app',
            attempts: 3,
            result: apps.failure('permission_missing', null, ['pg_monitor']),
          }),
        }),
      ],
      prepare: async (page) => {
        await monitor('shop/orders')(page);
        await choose(page, 'entered');
        await fields(page).nth(0).fill('app');
        await fields(page).nth(1).fill('not-a-real-password');
        await page.getByTestId('access-start').click();
        await page.getByTestId('probe-fix').waitFor();
      },
    },
    // Option c on Kubernetes: a Secret, with the Role and RoleBinding to run.
    {
      name: 'connect-secret',
      path: list,
      shot: true,
      answers: [
        found,
        created({
          probe: apps.probe({ method: 'reference', username: 'monitor' }),
          commands: apps.roleCommands,
        }),
      ],
      prepare: async (page) => {
        await monitor('shop/orders')(page);
        await choose(page, 'reference');
        await fields(page).nth(0).fill('monitor');
        await fields(page).nth(1).fill('orders-db');
        await page.getByTestId('access-start').click();
        await page.getByTestId('access-commands').waitFor();
      },
    },
    // Docker: Redis needs nothing and is tested as the drawer opens; or a file on the host.
    {
      name: 'connect-docker-none',
      path: `/applications${d}`,
      shot: true,
      answers: [
        found,
        created({
          probe: apps.probe({
            method: 'none',
            username: null,
            status: 'ok',
            attempts: 1,
            result: apps.success('7.2.5', { used_memory: '312 MB', clients: 14 }),
          }),
        }),
      ],
      prepare: async (page) => {
        await monitor('storefront/sessions')(page);
        await page.getByTestId('probe-status').waitFor();
      },
    },
    {
      name: 'connect-docker-file',
      path: `/applications${d}`,
      shot: true,
      answers: [
        found,
        created({
          probe: apps.probe({ method: 'reference', username: 'default' }),
          commands: apps.fileCommands,
          mount: '-v /etc/watchlog/secrets:/etc/watchlog/secrets:ro',
        }),
      ],
      prepare: async (page) => {
        await monitor('storefront/sessions')(page);
        await choose(page, 'reference');
        await fields(page).nth(1).fill('sessions-redis');
        await page.getByTestId('access-start').click();
        await page.getByTestId('access-commands').waitFor();
      },
    },
    {
      name: 'add-service',
      path: list,
      shot: true,
      answers: [found],
      prepare: (page) => page.getByTestId('add-manually').click(),
    },
    // A monitored service's page, its settings and a rule scoped to it.
    { name: 'application', path: fixture, shot: true, answers: fixtureAnswers },
    // The PostgreSQL page (slice 8): six tiles and two gauges; a six-column table.
    ...(['overview', 'locks'] as const).map((tab) => ({
      name: `application-postgres-${tab}`,
      path: tab === 'overview' ? fixture : `${fixture}&tab=${tab}`,
      shot: true,
      answers: [
        {
          url: new RegExp(`/api/v1/applications/${apps.FIXTURE_APP_ID}(\\?|$)`),
          json: apps.postgresDetail(kube),
        },
        {
          url: new RegExp(`/api/v1/applications/${apps.FIXTURE_APP_ID}/panels`),
          json: apps.postgresPanels(tab),
        },
        ...fixtureAnswers.slice(2),
      ],
    })),
    {
      name: 'service-rule-editor',
      path: fixture,
      shot: true,
      answers: fixtureAnswers,
      prepare: (page) => page.getByTestId('add-rule').click(),
    },
  ];
  if (dockerApp) {
    const path = `/applications/${dockerApp.id}${d}`;
    const accessAnswer: Answer = {
      url: new RegExp(`/api/v1/applications/${dockerApp.id}/access$`),
      json: apps.access(),
    };
    routes.push(
      // A Docker host without a collector: the docker run card.
      { name: 'application-docker', path, shot: true },
      {
        name: 'service-settings',
        path,
        shot: true,
        answers: [accessAnswer],
        prepare: (page) => page.getByTestId('open-settings').click(),
      },
      {
        name: 'service-settings-change',
        path,
        shot: true,
        answers: [accessAnswer],
        prepare: async (page) => {
          await page.getByTestId('open-settings').click();
          await page.getByTestId('change-access').click();
        },
      },
    );
  }
  return routes;
}

/**
 * The probable-cause panel (v0.4 slice 6) on every page it sits on, in each state, on both
 * kinds: the alert detail (likely, also possible, possible only, none, flows off, resolved),
 * the pod and a workload's pods, the Docker container and a Compose service, an application
 * beside its finding, and the service map's edge panel (compact). GET /causes is answered
 * from the recorded answers; the pages themselves are live.
 */
function causeRoutes(
  kube: Cluster,
  docker: Cluster,
  k: string,
  d: string,
  alertId: string | undefined,
  pod: { namespace: string; name: string },
  container: {
    host: string;
    name: string;
    composeProject: string | null;
    composeService: string | null;
  },
): Route[] {
  const c = causeAnswers(kube, docker);
  const answer = (json: unknown): Answer => ({ url: CAUSES_URL, json });
  const routes: Route[] = [];
  if (alertId) {
    for (const state of ['likely', 'also', 'possible', 'none', 'flowsOff', 'was'] as const)
      routes.push({
        name: `cause-alert-${state}`,
        path: `/alerts/${alertId}${k}`,
        shot: true,
        answers: [answer(c[state])],
      });
    // The disclosure open, on a likely answer (closed by default).
    routes.push({
      name: 'cause-alert-checks-open',
      path: `/alerts/${alertId}${k}`,
      shot: true,
      answers: [answer(c.likely)],
      prepare: (page) => page.getByTestId('cause-checks').locator('summary').click(),
    });
  }
  const podPath = `/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}${k}`;
  routes.push(
    { name: 'cause-pod', path: podPath, shot: true, answers: [answer(c.pod)] },
    {
      name: 'cause-workload',
      path: `/workloads${k}&view=pods&wns=causes-e2e&wkind=Deployment&wname=web`,
      shot: true,
      answers: [answer(c.likely)],
    },
    {
      name: 'cause-container',
      path: `/containers/${encodeURIComponent(container.host)}/${encodeURIComponent(container.name)}${d}`,
      shot: true,
      answers: [answer(c.dockerDns)],
    },
    {
      name: 'cause-compose-service',
      path: `/containers${d}&project=${encodeURIComponent(container.composeProject ?? 'causes-e2e')}&service=${encodeURIComponent(container.composeService ?? 'web')}`,
      shot: true,
      answers: [answer(c.dockerDep)],
    },
    {
      name: 'cause-application',
      path: `/applications/${apps.FIXTURE_APP_ID}${k}`,
      shot: true,
      answers: [
        {
          url: new RegExp(`/api/v1/applications/${apps.FIXTURE_APP_ID}(\\?|$)`),
          json: apps.applicationDetail(kube, true),
        },
        {
          url: new RegExp(`/api/v1/applications/${apps.FIXTURE_APP_ID}/panels`),
          json: apps.applicationPanels(),
        },
        { url: /\/api\/v1\/alert-rules$/, json: { rules: apps.serviceRules(kube) } },
        answer(c.rabbit),
      ],
    },
    {
      name: 'cause-edge',
      path: `/service-map${k}&edge=${encodeURIComponent('w:shop/Deployment/frontend>w:shop/Deployment/orders:8080')}`,
      shot: true,
      answers: [serviceMapAnswer(kube), answer(c.likely)],
    },
    {
      name: 'cause-edge-docker',
      path: `/service-map${d}&edge=${encodeURIComponent('c:storefront-worker-1>c:storefront-db-1:5432')}`,
      shot: true,
      answers: [serviceMapAnswer(docker), answer(c.dockerDep)],
    },
  );
  return routes;
}

/**
 * Settings → Users and its dialogs, as an Owner (with and without SMTP) and a Viewer, and
 * the public pages of the links (v0.3 slice 6, ADR-140). All answered by fixtures: the
 * suite makes no user, invite or reset link.
 */
function userRoutes(k: string): Route[] {
  const path = `/settings${k}&tab=users`;
  const list = (json: unknown): Answer => ({ url: /\/api\/v1\/users$/, json });
  const owner = list(people.users(false));
  const prepareInvite = async (page: Page) => {
    await page.getByTestId('invite').click();
    await page.getByTestId('invite-form').waitFor();
  };
  return [
    { name: 'settings-users', path, shot: true, answers: [owner] },
    { name: 'settings-users-smtp', path, answers: [list(people.users(true))] },
    {
      // Signed in as a Viewer: the session's user is answered too.
      name: 'settings-users-viewer',
      path,
      shot: true,
      answers: [list(people.viewerUsers()), { url: /\/api\/v1\/me$/, json: people.viewerMe }],
    },
    { name: 'users-invite', path, shot: true, answers: [owner], prepare: prepareInvite },
    {
      name: 'users-invited',
      path,
      shot: true,
      answers: [
        owner,
        {
          url: /\/api\/v1\/users\/invites$/,
          method: 'POST',
          status: 201,
          json: people.createdInvite,
        },
      ],
      prepare: async (page) => {
        await prepareInvite(page);
        await page
          .getByTestId('invite-form')
          .locator('input[type="email"]')
          .fill('dev@example.com');
        await page.getByTestId('invite-submit').click();
        await page.getByTestId('link-dialog').waitFor();
      },
    },
    {
      name: 'users-reset',
      path,
      shot: true,
      answers: [
        owner,
        { url: /\/api\/v1\/users\/[^/]+\/reset-link$/, method: 'POST', json: people.resetLink },
      ],
      prepare: async (page) => {
        await page.getByTestId('reset-link').first().click();
        await page.getByTestId('link-dialog').waitFor();
      },
    },
    {
      name: 'users-remove',
      path,
      shot: true,
      answers: [owner],
      prepare: async (page) => {
        await page.getByTestId('remove').first().click();
        await page.getByTestId('remove-dialog').waitFor();
      },
    },
    {
      name: 'accept-invite',
      path: `/invite/${people.TOKEN}`,
      public: true,
      shot: true,
      answers: [{ url: /\/api\/v1\/invites\/[^/]+$/, json: people.invite('pending') }],
    },
    {
      name: 'accept-invite-expired',
      path: `/invite/${people.TOKEN}`,
      public: true,
      shot: true,
      answers: [{ url: /\/api\/v1\/invites\/[^/]+$/, json: people.invite('expired') }],
    },
    {
      name: 'reset-password',
      path: `/reset/${people.TOKEN}`,
      public: true,
      shot: true,
      answers: [{ url: /\/api\/v1\/password-resets\/[^/]+$/, json: people.reset }],
    },
    {
      name: 'forgot-password',
      path: '/login',
      public: true,
      shot: true,
      prepare: async (page) => {
        await page.getByTestId('forgot').click();
        await page
          .locator('[data-testid="forgot-cli"], [data-testid="forgot-email"]')
          .first()
          .waitFor();
      },
    },
  ];
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

/** Opens every folded section of the service map's panel. */
async function openSections(page: Page) {
  await page.getByTestId('map-panel').waitFor();
  const closed = page.locator('[data-testid="map-panel"] [aria-expanded="false"]');
  while ((await closed.count()) > 0) await closed.first().click();
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
        for (const a of route.answers ?? []) {
          await page.route(a.url, (r) =>
            r.request().method() === (a.method ?? 'GET')
              ? r.fulfill({ status: a.status ?? 200, json: a.json })
              : r.fallback(),
          );
        }
        try {
          await checkRoute(page, route, width, failures);
        } finally {
          if (answer) await page.unroute(answer.url);
          for (const a of route.answers ?? []) await page.unroute(a.url);
        }
      }
      await context.close();
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
}

/**
 * i18n keys the page asked for and en.json lacks: vue-i18n says so in the console in
 * development ("Not found 'a.b' key"), where the key itself would show on screen.
 */
function watchMissingKeys(page: Page): () => string[] {
  const keys = new Set<string>();
  const listener = (msg: { text(): string }) => {
    const m = /Not found '([^']+)' key/.exec(msg.text());
    if (m) keys.add(m[1]!);
  };
  page.on('console', listener);
  return () => {
    page.off('console', listener);
    return [...keys];
  };
}

/** Loads a route, prepares it, checks the layout rules and takes its screenshots. */
async function checkRoute(page: Page, route: Route, width: number, failures: string[]) {
  const missingKeys = watchMissingKeys(page);
  try {
    await checkRouteLayout(page, route, width, failures);
  } finally {
    const keys = missingKeys();
    if (keys.length) {
      failures.push(
        `${route.name} at ${width}px: i18n keys missing from en.json: ${keys.join(', ')}`,
      );
    }
  }
}

async function checkRouteLayout(page: Page, route: Route, width: number, failures: string[]) {
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
    // WATCHLOG_E2E_SHOT_TALL: drawers and dialogs whole in one picture, for review.
    const tall = process.env.WATCHLOG_E2E_SHOT_TALL === 'true' && !!route.prepare;
    await page.setViewportSize({
      width: shot.width,
      height: tall ? Math.max(shot.height, shot.width < 768 ? 2100 : 1500) : shot.height,
    });
    if (tall) await page.waitForTimeout(300);
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

// The overview below the tiles is two columns that stack on their own (ADR-159): the wide
// one holds the resources chart (about 320 px, whatever the other column holds), top
// workloads and warning events; the narrow one Needs attention (six problems at most),
// recent changes and the heatmap. On a narrow page, one column with Needs attention first.
// The traffic tile's sub-line stays on one line.
for (const kind of ['kubernetes', 'docker'] as const) {
  for (const width of [1280, 1440, 390]) {
    test(`overview (${kind}) at ${width}px: columns stack on their own`, async ({ browser }) => {
      const cluster = clustersByKind?.[kind];
      test.skip(!cluster, `no ${kind} cluster`);
      const context = await browser.newContext({ ...viewportFor(width), storageState: storage });
      const page = await context.newPage();
      await page.goto(`/?cluster=${cluster!.id}`);
      await settle(page);
      const box = async (id: string) => (await page.getByTestId(id).first().boundingBox())!;
      const chart = await box('resources-chart');
      expect(chart.height).toBeGreaterThanOrEqual(300);
      expect(chart.height).toBeLessThanOrEqual(340);
      expect(await page.getByTestId('attention-item').count()).toBeLessThanOrEqual(6);
      const resources = await box('card-resources');
      const attention = await box('card-attention');
      const top = await box('card-top');
      if (width >= 1280) {
        // Side by side, and the card under the chart follows the chart, not Needs attention.
        expect(Math.abs(resources.y - attention.y)).toBeLessThan(2);
        expect(attention.x).toBeGreaterThan(resources.x + resources.width);
        expect(top.y - (resources.y + resources.height)).toBeLessThan(16);
        if (await page.getByTestId('kpi-traffic-sub').count()) {
          const sub = await box('kpi-traffic-sub');
          expect(sub.height, 'the traffic tile’s sub-line on one line').toBeLessThan(22);
        }
      } else {
        expect(attention.y).toBeLessThan(resources.y);
        expect(Math.abs(attention.x - resources.x)).toBeLessThan(2);
      }
      await context.close();
    });
  }
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
