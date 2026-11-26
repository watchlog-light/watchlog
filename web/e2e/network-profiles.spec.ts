// SPDX-License-Identifier: AGPL-3.0-only
// Credential profiles on Network → Add devices in a real browser (1.0.2), at 1440 and 390 px,
// in the theme of WATCHLOG_E2E_THEME, with a Kubernetes cluster and a server of a fleet as
// pollers: a wrong profile is made, tested, edited and tested again; an unused profile is
// deleted; one in use lists its device, moves it to another profile and is deleted; a poller's
// devices move to another poller; a device is paused and resumed; a Viewer sees the cards with
// their controls locked; the tabs row and the help section. Every page passes the layout checks.
//
// Against a running dashboard with network devices on, a collector in a cluster and one on a
// fleet's server, and the simulators (ee/collector/cmd/netsim -office: its router answers the
// user "watchlog" with "read-only-sample", its switches the community "public"):
//   WATCHLOG_E2E_URL=http://localhost:4188 WATCHLOG_E2E_EMAIL=… WATCHLOG_E2E_PASSWORD=… \
//   WATCHLOG_E2E_VIEWER_EMAIL=… WATCHLOG_E2E_VIEWER_PASSWORD=… (or the two sessions, below) \
//   WATCHLOG_E2E_NET_KUBE=<the cluster's name> WATCHLOG_E2E_NET_SERVER=<a server's name> \
//   WATCHLOG_E2E_NET_ROUTER=127.0.0.1:28443 WATCHLOG_E2E_NET_SWITCH=127.0.0.1:21162 \
//     pnpm exec playwright test e2e/network-profiles.spec.ts
// WATCHLOG_E2E_SHOT_DIR saves a screenshot of each step.
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;
const viewerEmail = process.env.WATCHLOG_E2E_VIEWER_EMAIL;
const viewerPassword = process.env.WATCHLOG_E2E_VIEWER_PASSWORD;
const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const THEME = process.env.WATCHLOG_E2E_THEME === 'light' ? 'light' : 'dark';
const KUBE = process.env.WATCHLOG_E2E_NET_KUBE ?? '';
const SERVER = process.env.WATCHLOG_E2E_NET_SERVER ?? '';
const ROUTER = process.env.WATCHLOG_E2E_NET_ROUTER ?? '';
const ROUTER_USER = process.env.WATCHLOG_E2E_NET_ROUTER_USER ?? 'watchlog';
const ROUTER_PASSWORD = process.env.WATCHLOG_E2E_NET_ROUTER_PASSWORD ?? 'read-only-sample';
const SWITCH = process.env.WATCHLOG_E2E_NET_SWITCH ?? '';
const READY = !!(KUBE && SERVER && ROUTER && SWITCH);

interface Profile {
  id: string;
  name: string;
}
interface Device {
  id: string;
  address: string;
  credential?: { id: string; name: string } | null;
}
interface Poller {
  clusterId: string;
  name: string;
  hosts: { host: string }[];
}

/**
 * One sign-in for each user in a run (sign-in is rate limited); later tests reuse its session.
 * WATCHLOG_E2E_SESSION and WATCHLOG_E2E_VIEWER_SESSION (wl_session=…) give sessions from
 * earlier sign-ins instead.
 */
const given = (v: string | undefined) => v?.replace(/^wl_session=/, '') || undefined;
const sessions: Partial<Record<'owner' | 'viewer', string>> = {
  owner: given(process.env.WATCHLOG_E2E_SESSION),
  viewer: given(process.env.WATCHLOG_E2E_VIEWER_SESSION),
};
async function signIn(page: Page, who: 'owner' | 'viewer' = 'owner') {
  const url = process.env.WATCHLOG_E2E_URL ?? 'http://localhost:4088';
  if (!sessions[who]) {
    const data =
      who === 'owner' ? { email, password } : { email: viewerEmail, password: viewerPassword };
    if (!data.email || !data.password) throw new Error(`set the ${who}'s email and password`);
    const res = await page.request.post('/api/v1/auth/login', { data });
    expect(res.ok(), await res.text()).toBe(true);
    const cookie = (await page.context().cookies(url)).find((c) => c.name === 'wl_session');
    if (!cookie) throw new Error('no session cookie after sign-in');
    sessions[who] = cookie.value;
    return;
  }
  await page.context().addCookies([{ name: 'wl_session', value: sessions[who], url }]);
}
async function api<T>(page: Page, method: string, path: string, data?: object): Promise<T> {
  const res = await page.request.fetch(`/api/v1/network${path}`, {
    method,
    ...(data ? { data } : {}),
  });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return (res.status() === 204 ? null : await res.json()) as T;
}
async function shot(page: Page, name: string, width: number) {
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/${THEME}-${width}-${name}.png`, fullPage: true });
}
async function layoutOk(page: Page, where: string) {
  const problems = await layoutProblems(page);
  expect(problems, report(where, page.viewportSize()?.width ?? 0, problems)).toEqual([]);
}
async function setup(page: Page, width: number) {
  await page.setViewportSize(width < 1024 ? viewportFor(width).viewport : { width, height: 1000 });
  await signIn(page);
}
/** Picks the option that starts with `label` in the Combobox with this test id. */
async function choose(page: Page, testid: string, label: string) {
  // Below 768 px the field is one button that opens a sheet; above, an input with a list.
  const field = page.getByTestId(testid);
  if ((page.viewportSize()?.width ?? 0) < 768) await field.click();
  else await field.getByRole('combobox').click();
  await page.getByRole('option', { name: new RegExp(`^${label}`) }).click();
}
/** What an earlier run of this theme and width left behind: its devices, then its profiles. */
async function clean(page: Page, prefix: string) {
  const { devices } = await api<{ devices: Device[] }>(page, 'GET', '/devices');
  for (const d of devices) {
    if (d.credential?.name.startsWith(prefix) || d.address === SWITCH)
      await api(page, 'DELETE', `/devices/${d.id}`);
  }
  const { credentials } = await api<{ credentials: Profile[] }>(page, 'GET', '/credentials');
  for (const c of credentials) {
    if (c.name.startsWith(prefix)) await api(page, 'DELETE', `/credentials/${c.id}`);
  }
}
const profile = (page: Page, name: string, body: object) =>
  api<{ id: string }>(page, 'POST', '/credentials', { name, ...body });
const V2C = { protocol: 'snmp', settings: { version: '2c' }, secret: { community: 'public' } };
const result = (page: Page) => page.getByTestId('cred-test-result');

for (const width of [1440, 390]) {
  const P = `e2e-${THEME}-${width}-`;

  test(`${width} px: a wrong profile is tested, edited and tested again`, async ({ page }) => {
    test.skip(!READY, 'set WATCHLOG_E2E_NET_KUBE, _SERVER, _ROUTER and _SWITCH');
    await setup(page, width);
    await clean(page, P);
    await page.goto('/network/add');
    const name = `${P}router`;

    // A new profile with a mistake in it: the password.
    await page.getByTestId('cred-new').click();
    const form = page.getByTestId('cred-form');
    await form.locator('input[type="radio"][value="routeros"]').check();
    await form.getByLabel('Profile name').fill(name);
    await form.getByLabel('User', { exact: true }).fill(ROUTER_USER);
    await form.getByLabel('Password', { exact: true }).fill('not-the-password');
    // Tried before it is saved, through the cluster's collector.
    await page.getByTestId('cred-test-address').locator('input').fill(ROUTER);
    await choose(page, 'cred-test-poller', KUBE);
    await page.getByTestId('cred-test-run').click();
    await expect(result(page)).toHaveAttribute('data-outcome', 'refused', { timeout: 60_000 });
    await expect(result(page)).toContainText('refused the user or the password');
    await layoutOk(page, 'a new profile, tested and refused');
    await shot(page, 'profile-new-refused', width);
    await page.getByTestId('cred-save').click();
    await expect(page.getByTestId(`cred-card-${name}`)).toBeVisible();
    await expect(form).toBeHidden();

    // Edit: the form filled in, the secret not shown, the protocol fixed.
    await page.getByTestId(`cred-edit-${name}`).click();
    await expect(page.getByTestId('cred-editing')).toContainText(name);
    await expect(form.getByLabel('Profile name')).toHaveValue(name);
    await expect(form.getByLabel('User', { exact: true })).toHaveValue(ROUTER_USER);
    await expect(form.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(form).toContainText('Leave empty to keep the current one');
    await expect(page.getByTestId('cred-protocol-fixed')).toContainText(
      'Make a new profile instead',
    );
    await expect(form.locator('input[type="radio"][value="snmp"]')).toHaveCount(0);
    // The saved password, tried through the fleet's server: still refused.
    await page.getByTestId('cred-test-address').locator('input').fill(ROUTER);
    await choose(page, 'cred-test-poller', SERVER);
    await page.getByTestId('cred-test-run').click();
    await expect(result(page)).toHaveAttribute('data-outcome', 'refused', { timeout: 60_000 });
    await shot(page, 'profile-edit-refused', width);
    // The right one, as typed: the device answers with its name and model.
    await form.getByLabel('Password', { exact: true }).fill(ROUTER_PASSWORD);
    await page.getByTestId('cred-test-run').click();
    await expect(result(page)).toHaveAttribute('data-outcome', 'answered', { timeout: 60_000 });
    await expect(result(page)).toContainText(/answered: .+\. These values work\./);
    await layoutOk(page, 'an edited profile, tested and answered');
    await shot(page, 'profile-edit-answered', width);
    await form.getByLabel('Profile name').fill(`${name}-ok`);
    await page.getByTestId('cred-save').click();
    await expect(page.getByTestId('cred-note')).toContainText(`${name} is saved`);
    await expect(page.getByTestId(`cred-card-${name}-ok`)).toBeVisible();
    await expect(page.getByTestId(`cred-card-${name}`)).toHaveCount(0);
    await layoutOk(page, 'a profile saved');
    await shot(page, 'profile-saved', width);

    // The saved profile now answers without typing anything.
    await page.getByTestId(`cred-edit-${name}-ok`).click();
    await page.getByTestId('cred-test-address').locator('input').fill(ROUTER);
    await page.getByTestId('cred-test-run').click();
    await expect(result(page)).toHaveAttribute('data-outcome', 'answered', { timeout: 60_000 });
    await clean(page, P);
  });

  test(`${width} px: an unused profile is deleted; one in use moves its device first`, async ({
    page,
  }) => {
    test.skip(!READY, 'set WATCHLOG_E2E_NET_KUBE, _SERVER, _ROUTER and _SWITCH');
    await setup(page, width);
    await clean(page, P);
    const a = await profile(page, `${P}sw-a`, V2C);
    await profile(page, `${P}sw-b`, V2C);
    await profile(page, `${P}unused`, {
      protocol: 'routeros',
      settings: { user: ROUTER_USER, transport: 'rest' },
      secret: { password: ROUTER_PASSWORD },
    });
    const { pollers } = await api<{ pollers: Poller[] }>(page, 'GET', '/pollers');
    const kube = pollers.find((p) => p.name === KUBE);
    expect(kube, `no poller named ${KUBE}`).toBeTruthy();
    const added = await api<{ added: string[]; restored: string[] }>(page, 'POST', '/devices', {
      clusterId: kube!.clusterId,
      host: '',
      devices: [{ address: SWITCH, name: `${P}switch`, credentialId: a.id }],
    });
    const deviceId = [...added.added, ...(added.restored ?? [])][0];
    expect(deviceId).toBeTruthy();
    await page.goto('/network/add');

    // Unused: asked first, by name; then gone, with a note.
    await page.getByTestId(`cred-delete-${P}unused`).click();
    await expect(page.getByTestId('cred-delete-name')).toHaveText(`${P}unused`);
    await expect(page.getByTestId('cred-delete-unused')).toBeVisible();
    await layoutOk(page, 'deleting an unused profile');
    await shot(page, 'delete-unused', width);
    await page.getByTestId('cred-delete-confirm').click();
    await expect(page.getByTestId(`cred-card-${P}unused`)).toHaveCount(0);
    await expect(page.getByTestId('cred-note')).toHaveText(`${P}unused is deleted.`);

    // In use: its device is listed, and there is no delete until it has moved.
    await page.getByTestId(`cred-delete-${P}sw-a`).click();
    await expect(page.getByTestId('cred-delete-inuse')).toContainText('1 device is read with');
    await expect(page.getByTestId('cred-delete-devices')).toContainText(SWITCH);
    await expect(page.getByTestId('cred-delete-confirm')).toHaveCount(0);
    await expect(page.getByTestId('cred-delete-move')).toBeDisabled();
    await layoutOk(page, 'deleting a profile in use');
    await shot(page, 'delete-in-use', width);
    await choose(page, 'cred-delete-to', `${P}sw-b`);
    await page.getByTestId('cred-delete-move').click();
    await expect(page.getByTestId('cred-delete-unused')).toBeVisible();
    await shot(page, 'delete-after-move', width);
    await page.getByTestId('cred-delete-confirm').click();
    await expect(page.getByTestId(`cred-card-${P}sw-a`)).toHaveCount(0);
    await expect(page.getByTestId(`cred-card-${P}sw-b`)).toContainText('used by 1 device');

    // The poller: how many devices it reads, and all of them moved to the fleet's server.
    await expect(page.getByTestId(`poller-reads-${KUBE}`)).toContainText('Reads 1 device');
    await page.getByTestId(`poller-move-${KUBE}`).click();
    await choose(page, 'poller-move-to', SERVER);
    await layoutOk(page, "moving a poller's devices");
    await shot(page, 'poller-move', width);
    await page.getByTestId('poller-move-go').click();
    await expect(page.getByTestId(`poller-reads-${SERVER}`)).toContainText('Reads 1 device');
    await expect(page.getByTestId(`poller-reads-${KUBE}`)).toHaveCount(0);

    // The device: paused, and polled again.
    await page.goto(`/network/devices/${deviceId}`);
    await expect(page.getByTestId('device-address-form')).toBeVisible();
    await page.getByTestId('device-pause').click();
    await expect(page.getByTestId('device-status')).toHaveText('Paused');
    await layoutOk(page, 'a paused device');
    await shot(page, 'device-paused', width);
    await page.getByTestId('device-pause').click();
    await expect(page.getByTestId('device-status')).not.toHaveText('Paused');
    await clean(page, P);
  });

  test(`${width} px: a Viewer sees the profiles with their controls locked`, async ({ page }) => {
    test.skip(
      !READY || !(viewerEmail || sessions.viewer),
      'set WATCHLOG_E2E_VIEWER_EMAIL and _PASSWORD',
    );
    await setup(page, width);
    await clean(page, P);
    await profile(page, `${P}seen`, V2C);
    await signIn(page, 'viewer');
    await page.goto('/network/add');
    await expect(page.getByTestId('add-viewer-note')).toBeVisible();
    const card = page.getByTestId(`cred-card-${P}seen`);
    await expect(card).toBeVisible();
    await expect(page.getByTestId(`cred-edit-${P}seen`)).toBeDisabled();
    await expect(page.getByTestId(`cred-delete-${P}seen`)).toBeDisabled();
    await expect(card.locator('input[type="checkbox"]')).toHaveCount(0);
    for (const gone of ['cred-new', 'cred-form', 'add-find', 'setup-details'])
      await expect(page.getByTestId(gone)).toHaveCount(0);
    // The server refuses too.
    const res = await page.request.post('/api/v1/network/credential-tests', {
      data: {
        clusterId: '00000000-0000-0000-0000-000000000000',
        host: '',
        address: ROUTER,
        ...V2C,
      },
    });
    expect(res.status()).toBe(403);
    await layoutOk(page, 'Add devices as a Viewer');
    await shot(page, 'viewer', width);
    await signIn(page);
    await clean(page, P);
  });

  test(`${width} px: the tabs row has no scroll control; the help is a folded section`, async ({
    page,
  }) => {
    test.skip(!READY, 'set WATCHLOG_E2E_NET_KUBE, _SERVER, _ROUTER and _SWITCH');
    await setup(page, width);
    await clean(page, P);
    await profile(page, `${P}help`, V2C);
    await page.goto('/network/add');
    // The tabs scroll sideways inside their row when they don't fit, without a scrollbar or
    // a stepper drawn at its edge, and the row never scrolls up and down.
    const tabs = page.getByTestId('network-header').locator('nav');
    const box = await tabs.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        bar: el.offsetHeight - el.clientHeight,
        scrollbar: s.scrollbarWidth,
        y: s.overflowY,
        tall: el.scrollHeight - el.clientHeight,
      };
    });
    expect(box).toEqual({ bar: 0, scrollbar: 'none', y: 'hidden', tall: 0 });
    await shot(page, 'tabs', width);

    const help = page.getByTestId('setup-details');
    await expect(help).not.toHaveAttribute('open', '');
    await expect(help.locator('summary')).toContainText('How to make this read-only user');
    await expect(help.locator('summary')).toContainText('SNMP v2c');
    await expect(help.locator('summary svg')).toBeVisible();
    await layoutOk(page, 'Add devices, the help folded');
    await help.locator('summary').click();
    await expect(help).toHaveAttribute('open', '');
    await expect(help.locator('pre, code').first()).toBeVisible();
    await layoutOk(page, 'Add devices, the help open');
    await shot(page, 'help-open', width);
    await clean(page, P);
  });
}
