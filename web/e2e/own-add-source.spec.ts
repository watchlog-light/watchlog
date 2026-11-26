// SPDX-License-Identifier: AGPL-3.0-only
// Your metrics → Add a source in a real browser (1.0.3), at 1440 and 390 px, in the theme of
// WATCHLOG_E2E_THEME, on a Server fleet and on a Kubernetes cluster: a new user sends a first
// value with only the page's own controls and reaches the metric; the same with the copied
// curl command, run by the test; Expose with an endpoint that answers and with none (each of
// Test's answers); Send from Prometheus with a simulated remote write; a Viewer; and no
// placeholder in capitals anywhere. Every state passes the layout checks.
//
// Against a running dashboard with a collector in a cluster and one on a fleet's server, and
// an address that answers with metrics (a small app with a /metrics page, a web page at /page
// and a page behind a password at /secret):
//   WATCHLOG_E2E_URL=http://localhost:4188 WATCHLOG_E2E_SESSION=wl_session=… \
//   WATCHLOG_E2E_VIEWER_SESSION=wl_session=… \
//   WATCHLOG_E2E_FLEET=<fleet id> WATCHLOG_E2E_OWN_SERVER=<its server> \
//   WATCHLOG_E2E_OWN_ADDRESS=127.0.0.1:9400 \
//   WATCHLOG_E2E_KUBE=<cluster id> WATCHLOG_E2E_OWN_WORKLOAD=shop/orders WATCHLOG_E2E_OWN_PORT=9400 \
//     pnpm exec playwright test e2e/own-add-source.spec.ts
// The cluster's workload has a running pod whose declared port answers with metrics.
// WATCHLOG_E2E_SHOT_DIR saves a screenshot of each state.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const run = promisify(execFile);
const given = (v: string | undefined) => v?.replace(/^wl_session=/, '') || undefined;
const OWNER = given(process.env.WATCHLOG_E2E_SESSION);
const VIEWER = given(process.env.WATCHLOG_E2E_VIEWER_SESSION);
const URL_ = process.env.WATCHLOG_E2E_URL ?? 'http://localhost:4088';
const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const THEME = process.env.WATCHLOG_E2E_THEME === 'light' ? 'light' : 'dark';
const FLEET = process.env.WATCHLOG_E2E_FLEET ?? '';
const KUBE = process.env.WATCHLOG_E2E_KUBE ?? '';
const SERVER = process.env.WATCHLOG_E2E_OWN_SERVER ?? '';
const ADDRESS = process.env.WATCHLOG_E2E_OWN_ADDRESS ?? '';
const WORKLOAD = process.env.WATCHLOG_E2E_OWN_WORKLOAD ?? '';
const PORT = process.env.WATCHLOG_E2E_OWN_PORT ?? '';
const READY = !!(OWNER && FLEET && KUBE && SERVER && ADDRESS && WORKLOAD && PORT);
const SKIP =
  'set WATCHLOG_E2E_SESSION, _FLEET, _KUBE, _OWN_SERVER, _OWN_ADDRESS, _OWN_WORKLOAD, _OWN_PORT';

const as = (page: Page, session: string | undefined) =>
  page.context().addCookies([{ name: 'wl_session', value: session ?? '', url: URL_ }]);
async function api<T>(page: Page, method: string, path: string, data?: object): Promise<T> {
  const res = await page.request.fetch(`/api/v1${path}`, { method, ...(data ? { data } : {}) });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return (res.status() === 204 ? null : await res.json()) as T;
}
async function shot(page: Page, name: string, width: number) {
  if (!SHOTS) return;
  // Colours that are changing (a card just chosen) are let to settle.
  await page.waitForTimeout(300);
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/${THEME}-${width}-${name}.png`, fullPage: true });
}
async function layoutOk(page: Page, where: string) {
  const problems = await layoutProblems(page);
  expect(problems, report(where, page.viewportSize()?.width ?? 0, problems)).toEqual([]);
}
/** A new user of this place: no token, no source added in the panel, no test value. */
async function fresh(page: Page, width: number, cluster: string) {
  await page.setViewportSize(width < 1024 ? viewportFor(width).viewport : { width, height: 1000 });
  await as(page, OWNER);
  const base = `/clusters/${cluster}/own-metrics`;
  const s = await api<{
    tokens: { id: string }[];
    sources: { id: string; removable: boolean }[];
  }>(page, 'GET', base);
  await api(page, 'DELETE', `${base}/test-value`);
  for (const t of s.tokens) await api(page, 'DELETE', `${base}/tokens/${t.id}`);
  for (const src of s.sources)
    if (src.removable) await api(page, 'DELETE', `${base}/sources/${src.id}`);
  // A first visit: no way remembered in this browser.
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('watchlog.ownAdd.way');
    } catch {
      // no storage: nothing to forget
    }
  });
}
/** Picks the option that starts with `label` in the Combobox with this test id. */
async function choose(page: Page, testid: string, label: string) {
  const field = page.getByTestId(testid);
  if ((page.viewportSize()?.width ?? 0) < 768) await field.click();
  else await field.getByRole('combobox').click();
  await page.getByRole('option', { name: new RegExp(`^${label}`) }).click();
}
const code = (page: Page, testid: string) => page.getByTestId(testid).locator('pre code');
const panel = (page: Page, way: string) => page.getByTestId(`own-add-panel-${way}`);
const headline = (page: Page) => page.getByTestId('own-first-headline');

// Prometheus remote write, by hand: the protobuf WriteRequest, in a snappy block of literals.
function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}
const field = (n: number, data: number[]) => [
  ...varint((n << 3) | 2),
  ...varint(data.length),
  ...data,
];
function remoteWrite(series: { labels: Record<string, string>; value: number }[]): Buffer {
  const text = (s: string) => [...Buffer.from(s)];
  const body: number[] = [];
  for (const s of series) {
    const ts: number[] = [];
    const names = Object.keys(s.labels).sort((a, b) =>
      a === '__name__' ? -1 : b === '__name__' ? 1 : a.localeCompare(b),
    );
    for (const name of names)
      ts.push(...field(1, [...field(1, text(name)), ...field(2, text(s.labels[name]!))]));
    const value = Buffer.alloc(8);
    value.writeDoubleLE(s.value);
    ts.push(...field(2, [0x09, ...value, ...varint(2 << 3), ...varint(Date.now())]));
    body.push(...field(1, ts));
  }
  // Snappy: the length, then literals of at most 60 bytes each.
  const out = [...varint(body.length)];
  for (let i = 0; i < body.length; i += 60) {
    const chunk = body.slice(i, i + 60);
    out.push((chunk.length - 1) << 2, ...chunk);
  }
  return Buffer.from(out);
}

for (const width of [1440, 390]) {
  test(`${width} px, a fleet: a first value with only the page's own controls, then the metric`, async ({
    page,
  }) => {
    test.skip(!READY, SKIP);
    await fresh(page, width, FLEET);
    await page.goto(`/your-metrics/add?cluster=${FLEET}`);
    // Nothing answers with metrics on this fleet's ports: the question, and Push open.
    await expect(page.getByTestId('own-chooser')).toContainText('Where is your number?');
    await expect(panel(page, 'push')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('own-choose-push')).toHaveAttribute('aria-pressed', 'true');
    await expect(code(page, 'own-push-code')).toContainText('wl_mt_…');
    await expect(code(page, 'own-push-code')).toContainText(`"server": "${SERVER}"`);
    await expect(page.getByTestId('own-series-meaning')).toContainText(
      'There is no limit on how many times you send.',
    );
    await layoutOk(page, 'Add a source, opened');
    await shot(page, 'push-open', width);

    // One click: a token is made and a test value sent.
    await page.getByTestId('own-push-test').click();
    await expect(headline(page)).toHaveText('Received my_first_test_value = 1', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('own-first-received')).toContainText(`for ${SERVER}`);
    await expect(page.getByTestId('own-token-value')).toContainText('wl_mt_');
    await expect(code(page, 'own-push-code')).not.toContainText('wl_mt_…');
    // The token is nowhere but in the page.
    expect(page.url()).not.toContain('wl_mt_');
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain('wl_mt_');
    await layoutOk(page, 'the test value received');
    await shot(page, 'push-test-received', width);

    // "Open it": the metric, on the server it belongs to.
    await page.getByTestId('own-first-open').click();
    await expect(page).toHaveURL(/\/your-metrics\?.*metric=/);
    await expect(page.getByText('my_first_test_value').first()).toBeVisible();
    await layoutOk(page, 'the metric the page sent');
    await shot(page, 'metric-open', width);

    // Back on the page, the test value is removed and the page waits for the user's own.
    await page.goto(`/your-metrics/add?cluster=${FLEET}`);
    await expect(panel(page, 'push')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('own-token-have')).toContainText("can't be shown again");
    await shot(page, 'push-have-token', width);
    await api(page, 'DELETE', `/clusters/${FLEET}/own-metrics/test-value`);
  });

  test(`${width} px, a fleet: the copied curl command, run by the test`, async ({ page }) => {
    test.skip(!READY, SKIP);
    await fresh(page, width, FLEET);
    await page.goto(`/your-metrics/add?cluster=${FLEET}`);
    await expect(panel(page, 'push')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('own-token-make').click();
    await expect(page.getByTestId('own-token-value')).toContainText('wl_mt_');
    await expect(page.getByTestId('own-first-waiting')).toContainText(
      'Waiting for your first value…',
    );
    await layoutOk(page, 'a token made, waiting');
    await shot(page, 'push-token-waiting', width);

    // The command as the page shows it, with this installation's address and the token.
    const command = (await code(page, 'own-push-code').innerText()).trim();
    expect(command).toContain('/ingest/v1/metrics');
    expect(command).toMatch(/Bearer wl_mt_[A-Za-z0-9_-]{20,}/);
    expect(command).toContain(`{"name": "orders_total", "value": 1, "server": "${SERVER}"}`);
    const ran = await run('bash', ['-c', command]);
    expect(JSON.parse(ran.stdout)).toMatchObject({ stored: 1 });
    await expect(headline(page)).toHaveText('Received orders_total = 1', { timeout: 30_000 });
    await expect(page.getByTestId('own-first-received')).toContainText(`for ${SERVER}`);
    for (const next of ['own-first-open', 'own-first-dashboard', 'own-first-alert'])
      await expect(page.getByTestId(next)).toBeVisible();
    await expect(page.getByTestId('own-first-remove')).toHaveCount(0);
    await layoutOk(page, 'the curl command’s value received');
    await shot(page, 'push-curl-received', width);

    // The name and the value drive the command, in every language.
    const name = page.getByTestId('own-push-name').locator('input');
    await name.fill('queue_jobs_waiting');
    await page.getByTestId('own-push-value').locator('input').fill('12');
    for (const lang of ['cron', 'node', 'python', 'php', 'go', 'curl']) {
      await page.getByTestId(`own-push-lang-${lang}`).click();
      await expect(code(page, 'own-push-code')).toContainText('queue_jobs_waiting');
      await expect(code(page, 'own-push-code')).toContainText(SERVER);
    }
    await page.getByTestId('own-push-lang-python').click();
    await expect(code(page, 'own-push-code')).toContainText('urllib.request');
    await expect(page.getByTestId('own-push-kind-gauge')).toHaveAttribute('aria-current', 'true');
    await layoutOk(page, 'the command in Python');
    await shot(page, 'push-python', width);
    await page.getByTestId('own-push-timestamp').click();
    await expect(code(page, 'own-push-code')).toContainText('value=$(date +%s)');
    await shot(page, 'push-timestamp', width);
  });

  test(`${width} px, a fleet: Expose with no /metrics page here, and each of Test's answers`, async ({
    page,
  }) => {
    test.skip(!READY, SKIP);
    await fresh(page, width, FLEET);
    await page.goto(`/your-metrics/add?cluster=${FLEET}&way=scrape`);
    await expect(panel(page, 'scrape')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('own-expose-sample')).toContainText(
      '# TYPE orders_total counter',
    );
    // The search found nothing: three ways forward, not a dead end.
    await expect(page.getByTestId('own-none')).toContainText('Three ways forward', {
      timeout: 15_000,
    });
    await page.getByTestId('own-none-lang-python').click();
    await expect(page.getByTestId('own-none-code')).toContainText('from prometheus_client import');
    await layoutOk(page, 'Expose, nothing found');
    await shot(page, 'expose-none', width);

    const input = page.getByTestId('own-address-input').locator('input');
    await expect(input).toHaveAttribute('placeholder', 'localhost:9400/metrics');
    const result = page.getByTestId('own-test-result');
    const host = ADDRESS.split(':')[0];
    for (const [address, outcome, words] of [
      [`${host}:9`, 'refused', 'Nothing is listening on that port.'],
      [`${ADDRESS}/page`, 'html', 'not with metrics (it looks like HTML)'],
      [`${ADDRESS}/secret`, 'auth', "which scraping can't send yet"],
      [ADDRESS, 'answered', 'Answered: 5 series, for example'],
    ] as const) {
      await input.fill(address);
      await page.getByTestId('own-address-test').click();
      await expect(result).toHaveAttribute('data-outcome', outcome, { timeout: 30_000 });
      await expect(result).toContainText(words);
      await shot(page, `expose-test-${outcome}`, width);
    }
    await layoutOk(page, 'Expose, an address that answers');
    // Then it is scraped, and listed with what it brought.
    await page.getByTestId('own-address-add').click();
    await expect(page.getByTestId('own-address-added')).toBeVisible();
    await expect(page.getByTestId('own-source').first()).toContainText(SERVER);
    await shot(page, 'expose-added', width);
    // "Push a value instead" leads there.
    await page.getByTestId('own-none-push').click();
    await expect(panel(page, 'push')).toBeVisible();
  });

  test(`${width} px, a cluster: Expose opens with the endpoint found; a workload's port tested and added`, async ({
    page,
  }) => {
    test.skip(!READY, SKIP);
    await fresh(page, width, KUBE);
    await page.goto(`/your-metrics/add?cluster=${KUBE}`);
    // An endpoint answers on a declared port: Expose opens, with it listed.
    await expect(panel(page, 'scrape')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('own-choose-found')).toHaveText('1 found here');
    await expect(page.getByTestId('own-found')).toContainText(`${WORKLOAD} :${PORT}`);
    await expect(page.getByTestId('own-none')).toHaveCount(0);
    await layoutOk(page, 'Expose, opened with an endpoint found');
    await shot(page, 'expose-found', width);

    await choose(page, 'own-port-workload', WORKLOAD);
    await page.getByTestId('own-port-input').locator('input').fill(PORT);
    await page.getByTestId('own-address-test').click();
    const result = page.getByTestId('own-test-result');
    await expect(result).toHaveAttribute('data-outcome', 'answered', { timeout: 30_000 });
    await expect(result).toContainText('Answered: 5 series');
    // The annotation, for that workload: one command, or YAML; the pods restart.
    await page.getByTestId('own-annotate').locator('summary').click();
    const [ns, name] = WORKLOAD.split('/');
    await expect(page.getByTestId('own-annotate-patch')).toContainText(
      `kubectl -n ${ns} patch deployment ${name} --type merge`,
    );
    await expect(page.getByTestId('own-annotate')).toContainText('restarts its pods');
    await layoutOk(page, 'Expose in a cluster, tested');
    await shot(page, 'expose-kube-tested', width);
    await page.getByTestId('own-address-add').click();
    await expect(page.getByTestId('own-address-added')).toBeVisible();
    await expect(page.getByTestId('own-source').first()).toContainText(`${name} :${PORT}/metrics`);

    // Push in a cluster: the workload is what a value belongs to.
    await page.getByTestId('own-add-way-push').click();
    await choose(page, 'own-push-owner', WORKLOAD);
    await expect(code(page, 'own-push-code')).toContainText(`"workload": "${WORKLOAD}"`);
    await shot(page, 'push-kube', width);
  });

  test(`${width} px, a cluster: Send from Prometheus, with a simulated remote write`, async ({
    page,
  }) => {
    test.skip(!READY, SKIP);
    await fresh(page, width, KUBE);
    await page.goto(`/your-metrics/add?cluster=${KUBE}&way=prometheus`);
    await expect(panel(page, 'prometheus')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('own-prometheus-who')).toContainText(
      'Only if you already run Prometheus.',
    );
    await page.getByTestId('own-token-make').click();
    const token = (await page.getByTestId('own-token-value').innerText()).trim();
    await expect(code(page, 'own-prometheus-code')).toContainText(`credentials: ${token}`);
    await expect(code(page, 'own-prometheus-code')).toContainText('/ingest/v1/write');
    await expect(code(page, 'own-prometheus-code')).toContainText('action: keep');
    await expect(page.getByTestId('own-first-waiting')).toContainText(
      'Waiting for your first samples…',
    );
    await layoutOk(page, 'Send from Prometheus, waiting');
    await shot(page, 'prometheus-waiting', width);

    const [ns] = WORKLOAD.split('/');
    const res = await page.request.post('/ingest/v1/write', {
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-protobuf',
        'content-encoding': 'snappy',
      },
      data: remoteWrite([
        { labels: { __name__: 'orders_total', namespace: ns!, method: 'card' }, value: 97 },
        { labels: { __name__: 'orders_total', namespace: ns!, method: 'paypal' }, value: 12 },
        { labels: { __name__: 'checkout_duration_seconds_sum', namespace: ns! }, value: 31.5 },
      ]),
    });
    expect(res.status(), await res.text()).toBeLessThan(300);
    await expect(headline(page)).toContainText('Received 3 series of 2 metrics', {
      timeout: 30_000,
    });
    await layoutOk(page, 'Send from Prometheus, received');
    await shot(page, 'prometheus-received', width);
  });

  test(`${width} px: a Viewer reads every way with its commands, and can change nothing`, async ({
    page,
  }) => {
    test.skip(!READY || !VIEWER, 'set WATCHLOG_E2E_VIEWER_SESSION');
    await page.setViewportSize(
      width < 1024 ? viewportFor(width).viewport : { width, height: 1000 },
    );
    await as(page, VIEWER);
    await page.goto(`/your-metrics/add?cluster=${FLEET}`);
    await expect(page.getByTestId('own-add-readonly')).toContainText('Only Owners and Admins');
    await expect(panel(page, 'push')).toBeVisible({ timeout: 15_000 });
    await expect(code(page, 'own-push-code')).toContainText('curl -sS -X POST');
    for (const gone of ['own-token-make', 'own-push-test', 'own-address-form', 'own-find-start'])
      await expect(page.getByTestId(gone)).toHaveCount(0);
    await layoutOk(page, 'Add a source as a Viewer');
    await shot(page, 'viewer-push', width);
    await page.getByTestId('own-add-way-scrape').click();
    await expect(page.getByTestId('own-none')).toBeVisible();
    await expect(page.getByTestId('own-address-form')).toHaveCount(0);
    await shot(page, 'viewer-expose', width);
    const res = await page.request.post(`/api/v1/clusters/${FLEET}/own-metrics/test-value`, {
      data: { tokenId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.status()).toBe(403);
  });

  test(`${width} px: no placeholder is written in capitals, on these pages and the network's`, async ({
    page,
  }) => {
    test.skip(!READY, SKIP);
    await fresh(page, width, FLEET);
    const seen: string[] = [];
    for (const path of [
      `/your-metrics/add?cluster=${FLEET}&way=push`,
      `/your-metrics/add?cluster=${FLEET}&way=scrape`,
      `/your-metrics/add?cluster=${KUBE}&way=scrape`,
      `/your-metrics/add?cluster=${KUBE}&way=prometheus`,
      `/your-metrics?cluster=${KUBE}&tab=metrics`,
      `/your-metrics?cluster=${KUBE}&tab=alerts`,
      '/network/add',
      '/network/devices',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const found = await page.evaluate(() =>
        [
          ...document.querySelectorAll<HTMLInputElement>(
            'input[placeholder], textarea[placeholder]',
          ),
        ]
          .filter((el) => el.placeholder.trim() !== '')
          .map((el) => ({
            placeholder: el.placeholder,
            transform: getComputedStyle(el, '::placeholder').textTransform,
          })),
      );
      for (const f of found) {
        seen.push(f.placeholder);
        expect(f.transform, `${path}: "${f.placeholder}"`).not.toBe('uppercase');
        // Written in capitals itself, with letters in it: an address or a name never is.
        expect(
          /[a-z]/i.test(f.placeholder) && f.placeholder === f.placeholder.toUpperCase(),
          `${path}: "${f.placeholder}"`,
        ).toBe(false);
      }
    }
    expect(seen).toContain('localhost:9400/metrics');
  });

  test(`${width} px: Your metrics with no source yet asks the same question`, async ({ page }) => {
    test.skip(!READY, SKIP);
    await fresh(page, width, FLEET);
    // A place nothing has reported from yet: made for this test, and removed after it.
    const made = await api<{ cluster: { id: string } }>(page, 'POST', '/clusters', {
      name: `e2e-empty-${THEME}-${width}-${Date.now() % 100000}`,
      kind: 'server',
    });
    try {
      await page.goto(`/your-metrics?cluster=${made.cluster.id}`);
      const empty = page.getByTestId('own-empty');
      await expect(empty).toContainText('Where is your number?', { timeout: 15_000 });
      await expect(empty.getByTestId('own-choose-push')).toContainText('Simplest: one command');
      await layoutOk(page, 'Your metrics, nothing reporting');
      await shot(page, 'empty-chooser', width);
      await empty.getByTestId('own-choose-push').click();
      await expect(page).toHaveURL(/\/your-metrics\/add\?.*way=push/);
      await expect(panel(page, 'push')).toBeVisible({ timeout: 15_000 });
    } finally {
      await api(page, 'DELETE', `/clusters/${made.cluster.id}`);
    }
  });
}
