// SPDX-License-Identifier: AGPL-3.0-only
// Setting a password and signing in, in a real browser at 390 and 1280 px (ADR-175, amended
// in 0.9.9):
//   - the sign-up page's password field: the checklist that ticks as the user types (too
//     short, leaked, the list unreachable, fine), the error under the field, show/hide by
//     keyboard, no suggestion of ours (the browser's), and a button that is never dead;
//   - the sign-in page with Turnstile: quiet when Cloudflare answers (the token goes with the
//     password), and still working, saying nothing, when Cloudflare is blocked.
//
// Self-contained: every API answer is a fixture, and Cloudflare is a stand-in script served
// by the test (or blocked). It needs only the web dev server (`pnpm --filter @watchlog/web
// dev`, or WATCHLOG_E2E_URL). Screenshots go to e2e/screenshots/ (git-ignored), or to
// WATCHLOG_E2E_SHOT_DIR.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const SHOT_DIR = process.env.WATCHLOG_E2E_SHOT_DIR
  ? `${process.env.WATCHLOG_E2E_SHOT_DIR.replace(/\/+$/, '')}/`
  : new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOT_DIR, { recursive: true });
const WIDTHS = [390, 1280];
const SITE_KEY = '1x00000000000000000000AA';
const LEAKED = 'correct horse battery staple';
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').toUpperCase();

interface World {
  /** The leaked-password list answers, or is down. */
  list: 'up' | 'down';
  /** Cloudflare: its script loads and answers a token, or the network blocks it. */
  cloudflare: 'off' | 'answers' | 'blocked';
  login: { status: number; body: unknown };
  /** Requests that were not GETs, as "METHOD /path body". */
  writes: string[];
  ranges: string[];
}
const world = (over: Partial<World> = {}): World => ({
  list: 'up',
  cloudflare: 'off',
  login: { status: 401, body: { type: 'about:blank', title: 'Unauthorized', status: 401 } },
  writes: [],
  ranges: [],
  ...over,
});

async function mock(page: Page, w: World) {
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: status >= 400 ? 'application/problem+json' : 'application/json',
      body: JSON.stringify(body),
    });
  const problem = (status: number, code?: string) => ({
    type: code ? `urn:watchlog:problem:${code}` : 'about:blank',
    title: 'Error',
    status,
    ...(code ? { code } : {}),
  });
  // Cloudflare's script: a stand-in that answers a token as soon as it is rendered, and again
  // on reset; or nothing at all (a network that blocks it).
  await page.context().route('https://challenges.cloudflare.com/**', (route) =>
    w.cloudflare === 'answers'
      ? route.fulfill({
          contentType: 'application/javascript',
          body: `window.__turnstile = [];
window.turnstile = {
  render(el, opts) { window.__turnstile.push(opts); setTimeout(() => opts.callback('token-' + window.__turnstile.length), 30); return 'w1'; },
  reset() { const o = window.__turnstile.at(-1); window.__turnstile.push(o); setTimeout(() => o.callback('token-' + window.__turnstile.length), 30); },
  remove() {},
};`,
        })
      : route.abort('blockedbyclient'),
  );
  await page.context().route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    if (req.method() !== 'GET') {
      w.writes.push(`${req.method()} ${path} ${req.postData() ?? ''}`);
      if (path === '/auth/login') return json(route, w.login.body, w.login.status);
      return json(route, problem(404), 404);
    }
    if (path === '/setup') return json(route, { required: false, demoMode: false, smtp: true });
    if (path === '/auth/config') {
      return json(route, {
        signup: true,
        signupMode: 'public',
        providers: { github: true, google: true },
        turnstileSiteKey: w.cloudflare === 'off' ? null : SITE_KEY,
        passwordMinLength: 10,
        verifyGraceDays: 7,
        supportEmail: 'support@watchlog.io',
        sampleUrl: 'https://demo.watchlog.io',
      });
    }
    if (path === '/me') return json(route, problem(401), 401);
    const range = /^\/auth\/password-range\/([0-9A-F]{5})$/.exec(path);
    if (range) {
      w.ranges.push(range[1]!);
      if (w.list === 'down') return json(route, problem(503, 'breach-check-unavailable'), 503);
      const leaked = sha1(LEAKED);
      return json(route, {
        range: [
          '0018A45C4D1DEF81644B54AB7F969B88D65:0',
          ...(range[1] === leaked.slice(0, 5) ? [`${leaked.slice(5)}:3861`] : []),
          'FFFFA45C4D1DEF81644B54AB7F969B88D65:0',
        ].join('\r\n'),
      });
    }
    return json(route, problem(404), 404);
  });
}

async function open(browser: Browser, w: World, width: number, path: string) {
  const context = await browser.newContext({
    ...viewportFor(width),
    deviceScaleFactor: Number(process.env.WATCHLOG_E2E_SCALE ?? 1),
    locale: 'en-GB',
  });
  const page = await context.newPage();
  await mock(page, w);
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  return { context, page };
}
const shot = (page: Page, name: string, width: number) =>
  page.screenshot({ path: `${SHOT_DIR}${name}-${width}.png`, fullPage: true });
async function noLayoutProblems(page: Page, name: string, width: number) {
  const problems = await layoutProblems(page);
  expect(problems.length ? report(name, width, problems) : '').toBe('');
}
const rule = (page: Page, key: string) => page.locator(`[data-rule="${key}"]`);

/** The field's own column: nothing of the field runs past it. */
async function insideItsColumn(page: Page) {
  const field = (await page.getByTestId('password-field').boundingBox())!;
  for (const id of ['password-error', 'password-rules']) {
    const el = page.getByTestId(id);
    if (!(await el.count())) continue;
    const box = (await el.boundingBox())!;
    expect(box.x, id).toBeGreaterThanOrEqual(field.x - 1);
    expect(box.x + box.width, id).toBeLessThanOrEqual(field.x + field.width + 1);
    expect(await el.evaluate((n) => n.scrollWidth - n.clientWidth), id).toBeLessThanOrEqual(0);
  }
  expect(field.x + field.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

for (const width of WIDTHS) {
  test(`sign-up: the password field's states, live (${width} px)`, async ({ browser }) => {
    const w = world();
    const { context, page } = await open(browser, w, width, '/signup');
    const input = page.getByTestId('password-input');
    await expect(input).toHaveAttribute('autocomplete', 'new-password');
    await expect(rule(page, 'length')).toHaveAttribute('data-state', 'todo');
    await expect(rule(page, 'leak')).toHaveAttribute('data-state', 'todo');
    await expect(page.getByText('Weak')).toHaveCount(0);
    await shot(page, 'signup-empty', width);

    // Too short: the length rule waits, and the list is not asked.
    await input.fill('short');
    await expect(rule(page, 'length')).toHaveAttribute('data-state', 'todo');
    await page.waitForTimeout(600);
    expect(w.ranges).toEqual([]);

    // Long and leaked: said under the field, in words that say what to do.
    await input.fill(LEAKED);
    await expect(rule(page, 'length')).toHaveAttribute('data-state', 'ok');
    await expect(rule(page, 'leak')).toHaveAttribute('data-state', 'bad');
    const error = page.getByTestId('password-error');
    await expect(error).toHaveText(
      'This password is in a list of leaked passwords, so attackers try it first. Pick a different one, or let your browser or password manager suggest one.',
    );
    // Directly under the field: between the input and the rules.
    const [i, e, r] = await Promise.all(
      [input, error, page.getByTestId('password-rules')].map((l) => l.boundingBox()),
    );
    expect(e!.y).toBeGreaterThanOrEqual(i!.y + i!.height);
    expect(e!.y - (i!.y + i!.height)).toBeLessThan(16);
    expect(r!.y).toBeGreaterThanOrEqual(e!.y + e!.height);
    await insideItsColumn(page);
    // Only 5 characters of the hash left the page.
    expect(w.ranges).toEqual([sha1(LEAKED).slice(0, 5)]);
    await shot(page, 'signup-leaked', width);

    // The button is alive: pressed now, nothing is sent and the focus is in the field.
    await page.getByTestId('signup-submit').click();
    await expect(page.getByTestId('signup').locator('input[type="email"]')).toBeFocused();
    await page.getByTestId('signup').locator('input[type="email"]').fill('sara@acme.dev');
    await page.getByTestId('signup-submit').click();
    await expect(input).toBeFocused();
    expect(w.writes).toEqual([]);

    // Another one: both rules tick and the error goes.
    await input.fill('nobody has used this one 7781');
    await expect(rule(page, 'leak')).toHaveAttribute('data-state', 'ok');
    await expect(error).toHaveCount(0);
    await shot(page, 'signup-ok', width);

    // Show and hide, by keyboard: Tab from the field reaches the button, Space presses it.
    await input.focus();
    await page.keyboard.press('Tab');
    const toggle = page.getByTestId('password-toggle');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAccessibleName('Show password');
    await page.keyboard.press('Space');
    await expect(input).toHaveAttribute('type', 'text');
    await expect(toggle).toHaveAccessibleName('Hide password');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const t = (await toggle.boundingBox())!;
    if (width < 1024) expect(Math.min(t.width, t.height)).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Space');
    await expect(input).toHaveAttribute('type', 'password');

    // No suggestion of ours (0.9.10): the browser's own is offered for a new password.
    await expect(input).toHaveAttribute('autocomplete', 'new-password');
    await expect(page.getByTestId('password-suggest')).toHaveCount(0);
    await expect(page.getByText('Suggest a strong password')).toHaveCount(0);

    // The right column speaks of clusters and servers.
    const aside = page.locator('aside');
    await expect(aside).toContainText('Two minutes from here to your cluster or servers');
    await expect(aside).toContainText('Kubernetes or Linux servers');
    await noLayoutProblems(page, 'signup', width);
    await context.close();
  });

  test(`sign-up: the leaked list can't be reached (${width} px)`, async ({ browser }) => {
    const w = world({ list: 'down' });
    const { context, page } = await open(browser, w, width, '/signup');
    await page.getByTestId('password-input').fill('nobody has used this one 7781');
    await expect(rule(page, 'leak')).toHaveAttribute('data-state', 'unknown');
    await expect(rule(page, 'leak')).toContainText(
      "Couldn't check right now; we'll check when you continue",
    );
    // Nothing alarming: no error, nothing red.
    await expect(page.getByTestId('password-error')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await insideItsColumn(page);
    await shot(page, 'signup-list-down', width);
    await context.close();
  });

  test(`sign-in: Turnstile is quiet and its token goes with the password (${width} px)`, async ({
    browser,
  }) => {
    const w = world({ cloudflare: 'answers' });
    const { context, page } = await open(browser, w, width, '/login');
    // Rendered for interaction only: nothing of it on the page.
    await expect
      .poll(() => page.evaluate(() => (window as { __turnstile?: unknown[] }).__turnstile?.length))
      .toBe(1);
    const opts = await page.evaluate(
      () =>
        (window as unknown as { __turnstile: { appearance: string }[] }).__turnstile[0]!.appearance,
    );
    expect(opts).toBe('interaction-only');
    const widget = page.getByTestId('signin-turnstile');
    expect((await widget.boundingBox())?.height ?? 0).toBeLessThanOrEqual(1);
    await shot(page, 'signin-quiet', width);
    await page.locator('input[type="email"]').fill('sara@acme.dev');
    await page.locator('input[type="password"]').fill('not my password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Invalid email or password.');
    expect(w.writes).toEqual([
      'POST /auth/login {"email":"sara@acme.dev","password":"not my password","turnstileToken":"token-1"}',
    ]);
    // The token was spent: the next try has a new one, by itself.
    await page.locator('input[type="password"]').fill('my password after all');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect.poll(() => w.writes.length).toBe(2);
    expect(w.writes[1]).toContain('"turnstileToken":"token-2"');
    await noLayoutProblems(page, 'signin', width);
    await context.close();
  });

  test(`sign-in: Cloudflare blocked, it still works and says nothing (${width} px)`, async ({
    browser,
  }) => {
    const w = world({ cloudflare: 'blocked' });
    const { context, page } = await open(browser, w, width, '/login');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.locator('input[type="email"]').fill('sara@acme.dev');
    await page.locator('input[type="password"]').fill('not my password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // No token, no wait: the server's strict limits are the guard here.
    await expect(page.getByRole('alert')).toHaveText('Invalid email or password.');
    expect(w.writes).toEqual([
      'POST /auth/login {"email":"sara@acme.dev","password":"not my password"}',
    ]);
    // The fallback's limit, when it is reached, says what to do.
    w.login = {
      status: 429,
      body: {
        type: 'urn:watchlog:problem:rate-limited',
        title: 'Too Many Requests',
        status: 429,
        code: 'rate-limited',
      },
    };
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Too many sign-in attempts without the human check. Wait 15 minutes',
    );
    const alert = (await page.getByRole('alert').boundingBox())!;
    expect(alert.x + alert.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await shot(page, 'signin-blocked-limit', width);
    await noLayoutProblems(page, 'signin-blocked', width);
    await context.close();
  });
}
