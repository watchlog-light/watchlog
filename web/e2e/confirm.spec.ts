// SPDX-License-Identifier: AGPL-3.0-only
// Settings in a real browser, on a phone (390 px) and a desktop (1280 px):
//   - destructive actions ask first (ADR-219): removing a person, revoking a pending invite,
//     removing an expired one, deleting an alert channel, signing other devices out. The
//     dialog fits the screen (a bottom sheet on a phone), Cancel has the focus, Escape and
//     Cancel send nothing, the danger button sends one request however often it is pressed,
//     and the row then goes without a reload, with a toast;
//   - ending a silence does not ask: it ends at once and the toast offers Undo;
//   - a failing channel's error (ADR-218) wraps inside its card at every width, even one
//     long unbroken word, and the card's header agrees with the row.
//
// Self-contained: every API answer is a fixture that changes when the page deletes something,
// so it needs only the web dev server (`pnpm --filter @watchlog/web dev`, or
// WATCHLOG_E2E_URL), no backend. Screenshots go to e2e/screenshots/ (git-ignored), or to
// WATCHLOG_E2E_SHOT_DIR.
import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const SHOT_DIR = process.env.WATCHLOG_E2E_SHOT_DIR
  ? `${process.env.WATCHLOG_E2E_SHOT_DIR.replace(/\/+$/, '')}/`
  : new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOT_DIR, { recursive: true });
const WIDTHS = [390, 1280];
const NOW = Date.UTC(2026, 10, 19, 9, 0, 0);
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const DAY = 86_400_000;

const ME = {
  id: '01a18f0e-a6c2-71ef-a7b4-42d765746d40',
  email: 'ada@acme.example',
  name: 'Ada Owner',
  locale: 'en',
  theme: 'system' as const,
  role: 'owner',
  org: { id: '01a18f0e-a6c2-71ef-a7b4-42d765746d41', name: 'Acme', slug: 'acme', plan: 'pro' },
};
const BLOCKED =
  'Telegram refused the message: the bot was blocked in the chat (403). Unblock the bot in Telegram, or connect another chat.';
/** What a row written before 0.9.8 could hold: one unbroken word, far wider than a phone. */
const UNBROKEN = `Webhook answered 500: ${'x'.repeat(260)}`;

interface World {
  edition: 'cloud' | 'community';
  users: { id: string; name: string; email: string; role: string; you: boolean; tokens: number }[];
  invites: { id: string; email: string; role: string; status: 'pending' | 'expired' }[];
  channels: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  silences: Record<string, unknown>[];
  /** Every request that was not a GET, as "METHOD /path". */
  writes: string[];
  /** Reads the page made that no fixture answers. */
  unknown: string[];
}

function world(edition: World['edition']): World {
  return {
    edition,
    users: [
      { id: 'u-ada', name: 'Ada Owner', email: ME.email, role: 'owner', you: true, tokens: 1 },
      {
        id: 'u-mia',
        name: 'Mia Member-With-A-Long-Family-Name',
        email: 'mia.member@acme.example',
        role: 'viewer',
        you: false,
        tokens: 2,
      },
    ],
    invites: [
      { id: 'i-pending', email: 'pending.person@acme.example', role: 'viewer', status: 'pending' },
      { id: 'i-expired', email: 'expired.person@acme.example', role: 'admin', status: 'expired' },
    ],
    channels: [
      {
        id: '01a19300-0000-7000-8000-0000000000d1',
        type: 'telegram',
        name: 'On-call',
        config: { connected: true, botName: 'acme_alerts_bot', chatName: 'Platform on-call' },
        secrets: { botToken: '…Xy12' },
        verifiedAt: iso(-DAY),
        lastSentAt: iso(-DAY),
        lastError: BLOCKED,
        lastErrorAt: iso(-3_600_000),
        createdAt: iso(-7 * DAY),
        ruleCount: 12,
      },
      {
        id: '01a19300-0000-7000-8000-0000000000d2',
        type: 'webhook',
        name: 'Bridge',
        config: { url: 'https://hooks.acme.example/watchlog' },
        secrets: { signingSecret: '…9f3a' },
        verifiedAt: iso(-DAY),
        lastSentAt: iso(-DAY),
        lastError: UNBROKEN,
        lastErrorAt: iso(-3_600_000),
        createdAt: iso(-7 * DAY),
        ruleCount: 3,
      },
    ],
    sessions: [
      {
        id: 's-here',
        current: true,
        createdAt: iso(-DAY),
        lastSeenAt: iso(0),
        expiresAt: iso(29 * DAY),
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/131.0 Safari/537.36',
        mfa: false,
      },
      {
        id: 's-phone',
        current: false,
        createdAt: iso(-3 * DAY),
        lastSeenAt: iso(-DAY),
        expiresAt: iso(27 * DAY),
        ip: '198.51.100.4',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
        mfa: false,
      },
    ],
    silences: [
      {
        id: 'sil-1',
        matchers: { workload: 'web' },
        startsAt: iso(-3_600_000),
        endsAt: iso(90 * 60_000),
        comment: 'deploying the new checkout',
        createdBy: 'Ada Owner',
        active: true,
        matching: 2,
      },
    ],
    writes: [],
    unknown: [],
  };
}

/** Answers every API request of the Settings page from the world, and changes it on a DELETE. */
async function mock(page: Page, w: World) {
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: status >= 400 ? 'application/problem+json' : 'application/json',
      body: body === null ? '' : JSON.stringify(body),
    });
  const none = (route: Route) => route.fulfill({ status: 204, body: '' });
  const notFound = (route: Route) =>
    json(route, { type: 'about:blank', title: 'Not Found', status: 404 }, 404);
  await page.context().route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const cloud = w.edition === 'cloud';
    if (method !== 'GET') {
      w.writes.push(`${method} ${path}`);
      // Slow enough to see the button's progress and to press it twice.
      await new Promise((r) => setTimeout(r, 250));
      let m: RegExpExecArray | null;
      if (method === 'DELETE' && (m = /^\/users\/invites\/([\w-]+)$/.exec(path))) {
        w.invites = w.invites.filter((i) => i.id !== m![1]);
        return none(route);
      }
      if (method === 'DELETE' && (m = /^\/users\/([\w-]+)$/.exec(path))) {
        w.users = w.users.filter((u) => u.id !== m![1]);
        return none(route);
      }
      if (method === 'DELETE' && (m = /^\/alert-channels\/([\w-]+)$/.exec(path))) {
        w.channels = w.channels.filter((c) => c.id !== m![1]);
        return none(route);
      }
      if (method === 'DELETE' && (m = /^\/silences\/([\w-]+)$/.exec(path))) {
        w.silences = w.silences.filter((x) => x.id !== m![1]);
        return none(route);
      }
      if (method === 'POST' && path === '/silences') {
        const body = req.postDataJSON() as {
          matchers: object;
          durationMinutes: number;
          comment: string;
        };
        const made = {
          id: 'sil-2',
          matchers: body.matchers,
          startsAt: iso(0),
          endsAt: iso(body.durationMinutes * 60_000),
          comment: body.comment,
          createdBy: 'Ada Owner',
          active: true,
          matching: 2,
        };
        w.silences = [...w.silences, made];
        w.writes[w.writes.length - 1] += ` ${body.durationMinutes} min`;
        return json(route, made, 201);
      }
      if (method === 'DELETE' && path === '/auth/sessions') {
        const before = w.sessions.length;
        w.sessions = w.sessions.filter((s) => s.current);
        return json(route, { revoked: before - w.sessions.length });
      }
      if (method === 'DELETE' && (m = /^\/auth\/sessions\/([\w-]+)$/.exec(path))) {
        w.sessions = w.sessions.filter((s) => s.id !== m![1]);
        return none(route);
      }
      return notFound(route);
    }
    switch (path) {
      case '/setup':
        return json(route, { required: false, demoMode: false, smtp: true });
      case '/auth/config':
        return cloud
          ? json(route, {
              signup: true,
              signupMode: 'public',
              providers: { github: false, google: false },
              turnstileSiteKey: null,
              passwordMinLength: 10,
              verifyGraceDays: 7,
              supportEmail: 'support@watchlog.io',
              sampleUrl: 'https://demo.watchlog.io',
            })
          : notFound(route);
      case '/me':
        return json(route, {
          user: { ...ME, org: { ...ME.org, plan: cloud ? 'pro' : 'community' } },
        });
      case '/auth/account':
        return json(route, {
          email: ME.email,
          emailVerified: true,
          verifyBy: null,
          restriction: null,
          password: true,
          mfa: { enabled: false, required: false, recoveryCodesLeft: 0 },
          identities: [],
        });
      case '/auth/sessions':
        return json(route, { sessions: w.sessions });
      case '/egress':
        return json(route, { summary: { new: 0 } });
      case '/support/current':
        return notFound(route);
      // Staff access to the org (Security, Cloud): none so far.
      case '/support-sessions':
        return json(route, { sessions: [] });
      case '/alerting/status':
        return json(route, {
          running: true,
          lastCycleAt: iso(-20_000),
          workers: 1,
          publicUrlConfigured: true,
          smtpConfigured: true,
        });
      case '/orgs':
        return json(route, {
          orgs: [{ id: ME.org.id, name: 'Acme', slug: 'acme', role: 'owner', current: true }],
        });
      case '/org/status':
        return json(route, {
          deletion: null,
          suspension: null,
          inactivity: null,
          lastDataAt: iso(-20_000),
        });
      case '/clusters':
        return json(route, { clusters: [] });
      case '/plan':
        return json(route, {
          plan: 'pro',
          source: 'billing',
          betaUntil: null,
          proFeatures: true,
          limits: { clusters: null, nodes: null, users: 10, retentionDays: 30 },
          usage: { clusters: 0, nodes: 0, kubernetesNodes: 0, dockerHosts: 0, users: 2 },
          period: { from: iso(-18 * DAY), to: iso(12 * DAY), p95: 0, peak: 0 },
          refusedNodes: 0,
          price: {
            currency: 'USD',
            perNodeMonth: 3,
            minimumMonth: 15,
            annualPerNode: 30,
            annualMinimumNodes: 5,
          },
        });
      case '/plan/billing':
        return json(route, {
          available: true,
          live: true,
          subscription: null,
          dunning: null,
          billingStartsAt: null,
        });
      case '/applications':
        return json(route, { applications: [] });
      case '/silences':
        return json(route, { silences: w.silences });
      case '/alerts':
        return json(route, {
          alerts: [],
          nextCursor: null,
          counts: { firing: 0, critical: 0, warning: 0, pending: 0, silenced: 2, held: 0 },
        });
      case '/users':
        return json(route, {
          users: w.users.map((u) => ({ ...u, lastActiveAt: iso(u.you ? 0 : -2 * 3_600_000) })),
          invites: w.invites.map((i) => ({
            ...i,
            invitedBy: 'Ada Owner',
            createdAt: iso(i.status === 'expired' ? -9 * DAY : -DAY),
            expiresAt: iso(i.status === 'expired' ? -2 * DAY : 6 * DAY),
            emailed: true,
          })),
          smtp: true,
          audit: [],
        });
      case '/alert-channels':
        return json(route, { channels: w.channels });
      case '/settings/general':
        return json(route, { publicUrl: 'https://watchlog.acme.example', publicUrlSource: 'db' });
      case '/settings/telegram':
        return json(route, { proxyUrl: null, source: 'none' });
      case '/settings/telegram/reachability':
        return json(route, { reachable: true, error: null });
      case '/settings/smtp':
        return cloud ? notFound(route) : json(route, { smtp: null });
      default:
        w.unknown.push(path + url.search);
        return notFound(route);
    }
  });
}

async function open(browser: Browser, w: World, width: number, tab: string, path?: string) {
  const context = await browser.newContext({
    ...viewportFor(width),
    deviceScaleFactor: Number(process.env.WATCHLOG_E2E_SCALE ?? 1),
    timezoneId: 'Europe/Berlin',
    locale: 'en-GB',
  });
  const page = await context.newPage();
  await mock(page, w);
  await page.clock.install({ time: new Date(NOW) });
  await page.clock.resume();
  await page.goto(path ?? `/settings?tab=${tab}`);
  await page.waitForLoadState('networkidle');
  return { context, page };
}

const shot = (page: Page, name: string, width: number) =>
  page.screenshot({ path: `${SHOT_DIR}${name}-${width}.png` });

async function noLayoutProblems(page: Page, name: string, width: number) {
  const problems = await layoutProblems(page);
  expect(problems.length ? report(name, width, problems) : '').toBe('');
}

/** The open dialog: inside the viewport, Cancel focused, both buttons a finger can hit. */
async function expectDialog(page: Page, testid: string, width: number, says: string[]) {
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  for (const text of says) await expect(sheet).toContainText(text);
  await expect(page.getByTestId(`${testid}-cancel`)).toBeFocused();
  const box = (await sheet.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
  const cancel = (await page.getByTestId(`${testid}-cancel`).boundingBox())!;
  const danger = (await page.getByTestId(`${testid}-confirm`).boundingBox())!;
  if (width < 640) {
    // A phone: a bottom sheet, the buttons stacked at full width, the danger one on top.
    expect(Math.abs(box.y + box.height - vp.height)).toBeLessThanOrEqual(1);
    expect(cancel.height).toBeGreaterThanOrEqual(44);
    expect(danger.height).toBeGreaterThanOrEqual(44);
    expect(Math.abs(cancel.width - danger.width)).toBeLessThanOrEqual(1);
    expect(danger.width).toBeGreaterThan(box.width * 0.8);
    expect(danger.y).toBeLessThan(cancel.y);
  }
  // No word of the dialog runs past it.
  const wide = await sheet.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(wide).toBeLessThanOrEqual(0);
}

interface Ask {
  name: string;
  tab: string;
  /** The button that opens the dialog. */
  open: (page: Page) => ReturnType<Page['getByTestId']>;
  testid: string;
  says: string[];
  /** The request the danger button sends. */
  request: string;
  /** What is on the page before and gone after. */
  row: (page: Page) => ReturnType<Page['getByText']>;
  toast: string;
  editions: World['edition'][];
}

const inRow = (page: Page, text: string, testid: string) =>
  page.getByTestId('user-row').filter({ hasText: text }).getByTestId(testid);

const ASKS: Ask[] = [
  {
    name: 'remove-member',
    tab: 'users',
    open: (p) => inRow(p, 'mia.member@acme.example', 'remove'),
    testid: 'remove',
    says: [
      'Remove Mia Member-With-A-Long-Family-Name?',
      'mia.member@acme.example',
      'They lose access right away and are signed out.',
    ],
    request: 'DELETE /users/u-mia',
    row: (p) => p.getByText('mia.member@acme.example', { exact: true }),
    toast: 'Mia Member-With-A-Long-Family-Name was removed.',
    editions: ['community', 'cloud'],
  },
  {
    name: 'revoke-invite',
    tab: 'users',
    open: (p) => inRow(p, 'pending.person@acme.example', 'revoke'),
    testid: 'revoke',
    says: [
      'Revoke this invite?',
      'pending.person@acme.example',
      'The invite link stops working at once.',
    ],
    request: 'DELETE /users/invites/i-pending',
    row: (p) => p.getByText('pending.person@acme.example', { exact: true }),
    toast: 'Invite for pending.person@acme.example revoked.',
    editions: ['community', 'cloud'],
  },
  {
    name: 'remove-expired-invite',
    tab: 'users',
    open: (p) => inRow(p, 'expired.person@acme.example', 'revoke'),
    testid: 'revoke',
    says: ['Remove this expired invite?', 'expired.person@acme.example'],
    request: 'DELETE /users/invites/i-expired',
    row: (p) => p.getByText('expired.person@acme.example', { exact: true }),
    toast: 'Invite for expired.person@acme.example removed.',
    editions: ['community', 'cloud'],
  },
  {
    name: 'delete-channel',
    tab: 'channels',
    open: (p) => p.getByTestId('webhook-card').getByTestId('delete-channel'),
    testid: 'delete-channel',
    says: ['Delete this channel?', 'Bridge', 'It is taken out of the 3 rules that use it.'],
    request: 'DELETE /alert-channels/01a19300-0000-7000-8000-0000000000d2',
    row: (p) => p.getByTestId('webhook-card').getByTestId('channel-row'),
    toast: 'Channel Bridge deleted.',
    editions: ['community', 'cloud'],
  },
  {
    name: 'sign-out-device',
    tab: 'security',
    open: (p) => p.getByTestId('sessions').locator('li').nth(1).getByTestId('revoke-session'),
    testid: 'revoke-session',
    says: ['Sign this device out?', 'Safari on iOS', '198.51.100.4'],
    request: 'DELETE /auth/sessions/s-phone',
    row: (p) => p.getByTestId('sessions').getByText('Safari on iOS'),
    toast: 'Signed out: Safari on iOS.',
    editions: ['cloud'],
  },
  {
    name: 'sign-out-others',
    tab: 'security',
    open: (p) => p.getByTestId('revoke-others'),
    testid: 'revoke-others',
    says: ['Sign out everywhere else?', '1 other device is signed out at once'],
    request: 'DELETE /auth/sessions',
    row: (p) => p.getByTestId('sessions').getByText('Safari on iOS'),
    toast: '',
    editions: ['cloud'],
  },
];

for (const ask of ASKS) {
  for (const edition of ask.editions) {
    for (const width of WIDTHS) {
      test(`${ask.name} asks first (${edition}, ${width} px)`, async ({ browser }) => {
        const w = world(edition);
        const { context, page } = await open(browser, w, width, ask.tab);
        const name = `confirm-${ask.name}-${edition}`;
        await expect(ask.row(page).first()).toBeVisible();

        // 1. It asks, and has sent nothing.
        await ask.open(page).click();
        await expectDialog(page, ask.testid, width, ask.says);
        expect(w.writes).toEqual([]);
        await shot(page, name, width);

        // 2. Escape, and Cancel: nothing sent, the row still there.
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await ask.open(page).click();
        await page.getByTestId(`${ask.testid}-cancel`).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(w.writes).toEqual([]);
        await expect(ask.row(page).first()).toBeVisible();

        // 3. By keyboard: Enter on the button opens it, and Enter again is Cancel's.
        await ask.open(page).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByTestId(`${ask.testid}-cancel`)).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(w.writes).toEqual([]);

        // 4. The danger button, pressed twice: one request, progress while it is on its way.
        await ask.open(page).click();
        const danger = page.getByTestId(`${ask.testid}-confirm`);
        await danger.click();
        await expect(danger).toHaveAttribute('aria-busy', 'true');
        await expect(danger).toBeDisabled();
        await danger.click({ force: true, timeout: 1000 }).catch(() => {});
        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(w.writes).toEqual([ask.request]);

        // 5. The row is gone without a reload, and a toast says what was done.
        await expect(ask.row(page)).toHaveCount(0);
        if (ask.toast) await expect(page.getByTestId('toast')).toContainText(ask.toast);
        await shot(page, `${name}-done`, width);
        await noLayoutProblems(page, name, width);
        expect(w.unknown, 'reads no fixture answers').toEqual([]);
        await context.close();
      });
    }
  }
}

for (const width of WIDTHS) {
  test(`ending a silence does not ask; its toast offers Undo (${width} px)`, async ({
    browser,
  }) => {
    const w = world('cloud');
    const { context, page } = await open(browser, w, width, '', '/alerts?view=silences');
    await expect(page.getByTestId('silence-row')).toHaveCount(1);
    await page.getByTestId('end-silence').click();
    // No question: it ended, and the list says so.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('silence-row')).toHaveCount(0);
    expect(w.writes).toEqual(['DELETE /silences/sil-1']);
    const toast = page.getByTestId('toast');
    await expect(toast).toContainText('Silence ended. Its alerts send messages again.');
    const undo = page.getByTestId('toast-action');
    await expect(undo).toHaveText('Undo');
    // A finger can hit it, and the toast stays inside the screen.
    const u = (await undo.boundingBox())!;
    const box = (await toast.boundingBox())!;
    if (width < 1024) expect(u.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await shot(page, 'silence-ended-undo', width);
    // Undo: the same alerts are silenced again until the same time (90 minutes from now).
    await undo.click();
    await expect(page.getByTestId('silence-row')).toHaveCount(1);
    await expect(page.getByTestId('silence-row')).toContainText('deploying the new checkout');
    expect(w.writes).toEqual(['DELETE /silences/sil-1', 'POST /silences 90 min']);
    await expect(toast).toContainText('Silenced again, until the same time.');
    await expect(page.getByTestId('toast-action')).toHaveCount(0);
    expect(w.unknown, 'reads no fixture answers').toEqual([]);
    await context.close();
  });
}

test('a refusal stays in the dialog and the row stays on the page', async ({ browser }) => {
  const w = world('cloud');
  const { context, page } = await open(browser, w, 390, 'users');
  // The server says no to this one.
  await page.context().route('**/api/v1/users/invites/i-pending', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'This invite was accepted a moment ago; it is a member now.',
      }),
    }),
  );
  await inRow(page, 'pending.person@acme.example', 'revoke').click();
  await page.getByTestId('revoke-confirm').click();
  await expect(page.getByTestId('revoke-error')).toHaveText(
    'This invite was accepted a moment ago; it is a member now.',
  );
  await expect(page.getByRole('dialog')).toBeVisible();
  await shot(page, 'confirm-revoke-invite-refused', 390);
  await page.getByTestId('revoke-cancel').click();
  await expect(page.getByText('pending.person@acme.example', { exact: true })).toBeVisible();
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await context.close();
});

for (const edition of ['community', 'cloud'] as const) {
  for (const width of [320, 390, 768, 1280]) {
    test(`a channel's error wraps inside its card (${edition}, ${width} px)`, async ({
      browser,
    }) => {
      const w = world(edition);
      const { context, page } = await open(browser, w, width, 'channels');
      for (const card of ['telegram-card', 'webhook-card']) {
        const box = (await page.getByTestId(card).boundingBox())!;
        const error = page.getByTestId(card).getByTestId('last-error');
        await expect(error).toBeVisible();
        const e = (await error.boundingBox())!;
        expect(e.x, `${card}: the error starts inside the card`).toBeGreaterThanOrEqual(box.x);
        expect(e.x + e.width, `${card}: the error ends inside the card`).toBeLessThanOrEqual(
          box.x + box.width,
        );
        // Every line of it, not only its box: no text is cut off or scrolls sideways.
        const over = await error.evaluate((el) => el.scrollWidth - el.clientWidth);
        expect(over, `${card}: no line of the error is wider than it`).toBeLessThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        // The header agrees with the row.
        await expect(page.getByTestId(card).locator('header')).toContainText('1 failing');
        await expect(page.getByTestId(card).getByTestId('channel-row')).toContainText('Failing');
      }
      await expect(page.getByTestId('telegram-card').getByTestId('last-error')).toContainText(
        'Unblock the bot in Telegram, or connect another chat.',
      );
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sideways, 'the page does not scroll sideways').toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `${SHOT_DIR}channels-error-${edition}-${width}.png`,
        fullPage: true,
      });
      await context.close();
    });
  }
}
