// SPDX-License-Identifier: AGPL-3.0-only
// The read-only demo (ADR-122) end to end, against a dashboard started with
// WATCHLOG_DEMO_MODE=true (`WATCHLOG_DEMO_MODE=true pnpm dev`). Skipped otherwise.
// Screenshots go to e2e/screenshots/ (git-ignored).
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const SHOT_DIR = new URL('./screenshots/', import.meta.url).pathname;
const MESSAGE = 'This is a read-only demo. Install WatchLog to try this on your cluster.';

test.beforeEach(async ({ request }) => {
  const status = await (await request.get('/api/v1/setup')).json();
  test.skip(!status.demoMode, 'the dashboard is not in demo mode');
});

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page
    .waitForFunction(() => !document.querySelector('[data-skeleton], [aria-busy="true"]'), null, {
      timeout: 15_000,
    })
    .catch(() => {});
  await page.waitForTimeout(300);
}

for (const width of [390, 1280]) {
  test(`demo at ${width}px: enter, browse, banner, no changes`, async ({ browser }) => {
    const context = await browser.newContext(viewportFor(width));
    const page = await context.newPage();
    const failures: string[] = [];

    // An anonymous visitor at / lands on the demo entry, not a sign-in form.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('enter-demo')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await page.screenshot({ path: `${SHOT_DIR}demo-login-${width}.png` });
    const login = await layoutProblems(page);
    if (login.length) failures.push(report('demo-login', width, login));

    await page.getByTestId('enter-demo').click();
    await expect(page).not.toHaveURL(/\/login/);
    await settle(page);
    const banner = page.getByTestId('demo-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Live demo');
    await expect(banner).toContainText('sample cluster');
    await expect(page.getByTestId('demo-install')).toHaveAttribute(
      'href',
      'https://watchlog.io/docs/install/',
    );
    await page.screenshot({ path: `${SHOT_DIR}demo-overview-${width}.png` });

    // Browse: every page shows the banner and passes the layout rules; no change controls.
    const cluster = new URL(page.url()).searchParams.get('cluster');
    const pages = [
      '/',
      '/nodes',
      '/workloads',
      '/events',
      '/service-map',
      '/alerts',
      '/alerts?view=rules',
      '/alerts?view=silences',
      '/settings',
      '/settings?tab=channels',
      '/settings?tab=general',
      `/settings/clusters/${cluster}`,
    ];
    for (const path of pages) {
      const sep = path.includes('?') ? '&' : '?';
      await page.goto(`${path}${sep}cluster=${cluster}`);
      await settle(page);
      await expect(page.getByTestId('demo-banner'), path).toBeVisible();
      for (const id of [
        'new-rule',
        'issue-token',
        'revoke',
        'silence-alert',
        'telegram-proxy-save',
        'add-cluster',
      ]) {
        await expect(page.getByTestId(id), `${path}: ${id}`).toHaveCount(0);
      }
      await expect(page.getByTestId('token-list'), path).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^(Save|Add|Delete|New rule)/ })).toHaveCount(
        0,
      );
      const problems = await layoutProblems(page);
      if (problems.length) failures.push(report(`demo ${path}`, width, problems));
    }
    await page.goto(`/alerts?view=rules&cluster=${cluster}`);
    await settle(page);
    await page.screenshot({ path: `${SHOT_DIR}demo-rules-${width}.png` });

    // A write straight to the API: 403 with the demo's code and message.
    const res = await page.request.put('/api/v1/settings/general', { data: { publicUrl: null } });
    expect(res.status()).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'demo_read_only', message: MESSAGE });

    // A write through the app's own API client: the toast says why.
    await page.evaluate(async () => {
      const { api } = await import('/src/api/client.ts');
      await api('/settings/general', { method: 'PUT', body: { publicUrl: null } }).catch(() => {});
    });
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(MESSAGE);
    await page.screenshot({ path: `${SHOT_DIR}demo-toast-${width}.png` });
    const withToast = await layoutProblems(page);
    if (withToast.length) failures.push(report('demo toast', width, withToast));

    // Sign-out still works.
    const out = await page.request.post('/api/v1/auth/logout');
    expect(out.status()).toBe(204);
    await context.close();
    expect(failures, failures.join('\n')).toEqual([]);
  });
}
