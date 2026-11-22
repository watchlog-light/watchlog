// SPDX-License-Identifier: AGPL-3.0-only
// Certificates and scheduled jobs, easy to find (0.13.0, ADR-230), in a real browser at 1440 and
// 390 px, on a Kubernetes cluster and on a Server fleet: the sidebar's entries and badges (the
// phone menu, the collapsed rail's dot), the Overview's "Running here" row, the first-find card
// (shown once, then gone after ×), both timelines with their range switches (remembered after a
// reload), a mark opening its run, the old /applications/... URLs redirecting with their query,
// search's status lines, and the layout checks on every page.
//
// Against a running dashboard whose cluster and fleet have certificates and jobs (the agents'
// inventory, or the same snapshots posted to /ingest/v1/objects). The Overview's metrics and
// the services list are answered by fixtures, so no metrics store is needed:
//   WATCHLOG_E2E_URL=http://localhost:4188 WATCHLOG_E2E_EMAIL=… WATCHLOG_E2E_PASSWORD=… \
//   WATCHLOG_E2E_KUBE=<cluster id> WATCHLOG_E2E_FLEET=<fleet id> \
//     pnpm exec playwright test e2e/certs-jobs.spec.ts
// The first-find card is shown once per user: reset `users.notices` before a second run.
// WATCHLOG_E2E_SHOT_DIR saves a screenshot of each state there; WATCHLOG_E2E_THEME=light.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;
const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const THEME = process.env.WATCHLOG_E2E_THEME === 'light' ? 'light' : 'dark';
const PLACES = [
  { kind: 'kubernetes' as const, id: process.env.WATCHLOG_E2E_KUBE ?? '' },
  { kind: 'server' as const, id: process.env.WATCHLOG_E2E_FLEET ?? '' },
];

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../test/${name}`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;
const KUBE_OVERVIEW = (fixture('kube-fixtures.json') as { overview: Record<string, unknown> })
  .overview;
const SERVER_OVERVIEW = fixture('docker-overview.json');

function services(kube: string, fleet: string) {
  const app = (
    id: string,
    name: string,
    type: string,
    cluster: { id: string; name: string; kind: string },
    health: string,
    reason: object,
    where: object,
  ) => ({
    id,
    type,
    name,
    version: null,
    product: null,
    cluster,
    where: { group: null, host: null, address: null, ...where },
    target: null,
    health,
    reason,
    members: null,
    monitoredSince: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    lastReportAt: new Date().toISOString(),
  });
  const k = { id: kube, name: 'shop-prod', kind: 'kubernetes' };
  const f = { id: fleet, name: 'acme-servers', kind: 'server' };
  return {
    applications: [
      app(
        '01a1c000-0000-7000-8000-0000000000a1',
        'shop/postgres',
        'postgres',
        k,
        'critical',
        { code: 'unreachable', facts: { error: 'connection refused' } },
        { group: 'shop' },
      ),
      app(
        '01a1c000-0000-7000-8000-0000000000a2',
        'traefik/traefik',
        'traefik',
        k,
        'warning',
        { code: 'unreachable', facts: { error: 'i/o timeout' } },
        { group: 'traefik' },
      ),
      app(
        '01a1c000-0000-7000-8000-0000000000a3',
        'data/kafka',
        'kafka',
        k,
        'ok',
        { code: 'connected', facts: {} },
        { group: 'data' },
      ),
      app(
        '01a1c000-0000-7000-8000-0000000000b1',
        'nginx',
        'nginx',
        f,
        'ok',
        { code: 'connected', facts: {} },
        { host: 'app-1' },
      ),
      app(
        '01a1c000-0000-7000-8000-0000000000b2',
        'postgres',
        'postgres',
        f,
        'ok',
        { code: 'connected', facts: {} },
        { host: 'db-1' },
      ),
    ],
  };
}

async function signIn(page: Page) {
  if (!email || !password) throw new Error('set WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD');
  // Sign-in is rate limited: a run signs in four times in a row, so it waits when told to.
  for (let i = 0; ; i++) {
    const res = await page.request.post('/api/v1/auth/login', { data: { email, password } });
    if (res.status() === 429 && i < 3) {
      await page.waitForTimeout(Number(res.headers()['retry-after'] ?? 5) * 1000 + 500);
      continue;
    }
    expect(res.ok(), await res.text()).toBe(true);
    return;
  }
}

/** The Overview's metrics and the services list from fixtures; the rest is the real API. */
async function mock(page: Page, place: (typeof PLACES)[number]) {
  const kube = PLACES[0]!.id;
  const fleet = PLACES[1]!.id;
  await page.route(/\/api\/v1\/clusters\/[^/]+\/overview(\?|$)/, (route) => {
    const base = place.kind === 'kubernetes' ? KUBE_OVERVIEW : SERVER_OVERVIEW;
    const facts = base.facts as Record<string, unknown>;
    return route.fulfill({
      json: {
        ...base,
        kind: place.kind,
        cluster: {
          ...(base.cluster as object),
          id: place.id,
          name: place.kind === 'kubernetes' ? 'shop-prod' : 'acme-servers',
          ingestFailure: null,
        },
        facts:
          place.kind === 'server'
            ? { ...facts, nodes: 3, agents: { reporting: 3, expected: 3 }, alertingRunning: true }
            : facts,
      },
    });
  });
  await page.route(/\/api\/v1\/applications(\?|$)/, (route) =>
    route.fulfill({ json: services(kube, fleet) }),
  );
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${THEME}-${name}.png`, fullPage: true });
}
async function layoutOk(page: Page, where: string) {
  const problems = await layoutProblems(page);
  expect(problems, report(where, page.viewportSize()?.width ?? 0, problems)).toEqual([]);
}

for (const place of PLACES) {
  // 390 first: it sees the first-find card; 1440 then dismisses it and checks it stays gone.
  for (const width of [390, 1440]) {
    test(`${place.kind}, ${width} px`, async ({ page }) => {
      test.skip(!place.id, 'set WATCHLOG_E2E_KUBE and WATCHLOG_E2E_FLEET');
      const phone = width < 1024;
      await page.setViewportSize(phone ? viewportFor(width).viewport : { width, height: 1000 });
      await page.addInitScript(() => {
        if (sessionStorage.getItem('e2e-started')) return;
        sessionStorage.setItem('e2e-started', '1');
        for (const k of [
          'watchlog.sidebarCollapsed',
          'watchlog.certTimeline.range',
          'watchlog.runTimeline.range',
        ])
          localStorage.removeItem(k);
      });
      await signIn(page);
      await mock(page, place);
      const tag = `${place.kind}-${width}`;
      const q = `cluster=${place.id}`;

      // ---- Overview: the first-find card, the row, the sidebar --------------------------
      await page.goto(`/?${q}`);
      const row = page.getByTestId('running-here');
      await expect(row).toBeVisible();
      await expect(
        row.getByTestId('running-certificates').getByTestId('expiry-strip'),
      ).toBeVisible();
      await expect(row.getByTestId('running-jobs').getByTestId('run-bars').first()).toBeVisible();
      await expect(
        row.getByTestId('running-services').getByTestId('running-row').first(),
      ).toBeVisible();
      if (place.kind === 'server') {
        // The Server fleet's vocabulary, and the failing renewal job on the certificate's row.
        await expect(row.getByTestId('running-certificates')).toContainText('nginx :443 on app-1');
        await expect(row.getByTestId('running-certificates')).toContainText(
          'certbot.timer is failing',
        );
        await expect(row.getByTestId('running-jobs')).toContainText('cron on db-1');
      } else {
        await expect(row.getByTestId('running-certificates')).toContainText('Ingress shop/');
        await expect(row.getByTestId('running-jobs')).toContainText('report-builder');
      }
      const card = page.getByTestId('first-find');
      await expect(card).toBeVisible();
      await expect(card).toContainText(/WatchLog found \d+ certificates and \d+ scheduled jobs/);
      await expect(page.getByTestId('first-find-urgent')).toBeVisible();
      await layoutOk(page, `${tag} overview`);
      await shot(page, `${tag}-overview`);

      if (!phone) {
        // × hides it for good: not after a reload.
        await page.getByTestId('first-find-dismiss').click();
        await expect(card).toHaveCount(0);
        await page.reload();
        await expect(row).toBeVisible();
        await expect(page.getByTestId('first-find')).toHaveCount(0);
      }

      // The entries and their badges: the phone menu, or the sidebar and its collapsed dots.
      if (phone) {
        await page.getByTestId('nav-open').click();
      }
      const nav = page.getByRole('navigation').first();
      const certs = nav.getByRole('link', { name: /^Certificates/ });
      const jobs = nav.getByRole('link', { name: /^Scheduled jobs/ });
      await expect(certs).toBeVisible();
      await expect(jobs).toBeVisible();
      await expect(page.getByTestId('nav-group-running')).toHaveText(/Running here/i);
      await expect(page.getByTestId('nav-group-investigate')).toHaveText(/Investigate/i);
      const certBadge = certs.getByTestId('nav-badge');
      const jobBadge = jobs.getByTestId('nav-badge');
      // Kubernetes: one expired and one under 3 days (red); the fleet: 9 days at most (amber).
      await expect(certBadge).toHaveAttribute(
        'data-tone',
        place.kind === 'kubernetes' ? 'crit' : 'warn',
      );
      await expect(jobBadge).toHaveAttribute('data-tone', 'crit');
      await expect(certBadge).toHaveAttribute('title', /.+/);
      await shot(page, `${tag}-sidebar`);
      if (phone) {
        await certs.click();
      } else {
        await page.evaluate(() => localStorage.setItem('watchlog.sidebarCollapsed', '1'));
        await page.reload();
        await expect(page.getByTestId('nav-badge').first()).toBeVisible();
        await shot(page, `${tag}-collapsed`);
        await page.evaluate(() => localStorage.removeItem('watchlog.sidebarCollapsed'));
        await page.reload();
        await page
          .getByRole('navigation')
          .first()
          .getByRole('link', { name: /^Certificates/ })
          .click();
      }

      // ---- Certificates: the timeline, its range remembered, a label opens one ------------
      await expect(page).toHaveURL(/\/certificates/);
      const tl = page.getByTestId('cert-timeline-card');
      await expect(tl.getByTestId('expiry-timeline')).toBeVisible();
      await expect(tl.getByRole('button', { name: '90 days' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(tl.getByTestId('expiry-timeline-text')).toContainText('Expiry timeline');
      await layoutOk(page, `${tag} certificates`);
      await shot(page, `${tag}-certificates`);
      await tl.getByRole('button', { name: '1 year' }).click();
      await expect(tl.getByRole('button', { name: '1 year' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await page.reload();
      await expect(
        page.getByTestId('cert-timeline-card').getByRole('button', { name: '1 year' }),
      ).toHaveAttribute('aria-pressed', 'true');
      await layoutOk(page, `${tag} certificates 1 y`);
      await shot(page, `${tag}-certificates-1y`);
      await page.getByTestId('cert-timeline-card').getByRole('button', { name: '30 days' }).click();
      await shot(page, `${tag}-certificates-30d`);
      const label = page.getByTestId('expiry-label').first();
      await label.click();
      await expect(page).toHaveURL(/\/certificates\/[0-9a-f]{16}/);

      // ---- Scheduled jobs: the run timeline, its range, the filter, a mark opens its run --
      await page.goto(`/scheduled-jobs?${q}`);
      const rt = page.getByTestId('run-timeline-card');
      await expect(rt.getByTestId('run-lane').first()).toBeVisible();
      await expect(rt.getByRole('button', { name: '24 h' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      // Problems first.
      await expect(rt.getByTestId('run-lane').first()).toHaveAttribute('data-state', 'failed');
      await expect(rt.getByTestId('run-mark').first()).toHaveAttribute('aria-label', /.+/);
      expect(
        await rt.locator('[data-testid="run-mark"][data-kind="next"]').count(),
      ).toBeGreaterThan(0);
      await layoutOk(page, `${tag} scheduled jobs`);
      await shot(page, `${tag}-jobs`);
      await rt.getByRole('button', { name: '7 days' }).click();
      await expect(rt.getByRole('button', { name: '7 days' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await page.reload();
      await expect(
        page.getByTestId('run-timeline-card').getByRole('button', { name: '7 days' }),
      ).toHaveAttribute('aria-pressed', 'true');
      await layoutOk(page, `${tag} scheduled jobs 7 d`);
      await shot(page, `${tag}-jobs-7d`);
      await page.getByTestId('run-timeline-card').getByRole('button', { name: '6 h' }).click();
      await shot(page, `${tag}-jobs-6h`);
      // The table's filter filters the lanes.
      const all = await page.getByTestId('run-lane').count();
      await page.getByTestId('job-filter').filter({ hasText: 'Need attention' }).click();
      await expect.poll(() => page.getByTestId('run-lane').count()).toBeLessThan(all);
      await page.getByTestId('job-filter').filter({ hasText: /^All/ }).click();
      if (place.kind === 'server') {
        // A past mark opens the job at that run, highlighted.
        await page.getByTestId('run-timeline-card').getByRole('button', { name: '24 h' }).click();
        const mark = page.locator('[data-testid="run-mark"]:not([data-kind="next"])').first();
        await mark.click({ force: true });
        await expect(page).toHaveURL(/\/scheduled-jobs\/[0-9a-f]{16}\?.*run=\d+/);
        await expect(page.locator('[data-testid="run-row"][aria-current="true"]')).toHaveCount(1);
      }

      // ---- The old URLs redirect, keeping the query --------------------------------------
      await page.goto(`/applications/certificates?${q}&show=attention`);
      await expect(page).toHaveURL(new RegExp(`/certificates\\?.*show=attention`));
      await page.goto(`/applications/scheduled-jobs?${q}&q=backup`);
      await expect(page).toHaveURL(/\/scheduled-jobs\?.*q=backup/);

      // ---- Search: certificates with their status line ------------------------------------
      if (!phone) {
        await page.goto(`/?${q}`);
        await expect(page.getByTestId('running-here')).toBeVisible();
        await page.keyboard.press('ControlOrMeta+k');
        await page
          .getByTestId('palette-input')
          .fill(place.kind === 'server' ? 'api.acme.io' : 'api.acme.com');
        const group = page.getByTestId('palette-group-certificate');
        await expect(group).toBeVisible();
        // "expires in 9 days · Ingress shop/api (api.acme.com)", "… · nginx on app-1 :443".
        await expect(group.getByTestId('palette-detail').first()).toContainText(
          place.kind === 'server'
            ? /^expires in \d+ days · nginx on app-1 :443$/
            : /^expires in \d+ days · Ingress shop\/api/,
        );
        await shot(page, `${tag}-search`);
        await page.keyboard.press('Escape');
      }
    });
  }
}
