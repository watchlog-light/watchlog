// SPDX-License-Identifier: AGPL-3.0-only
// SNMPv3 with DES and MD5 in a real browser (1.0.4), at 1440 and 390 px, in the theme of
// WATCHLOG_E2E_THEME: a QNAP's profile is made from "New profile for a QNAP" (SHA with DES),
// tested against the simulated QNAP through a Kubernetes cluster's collector, saved, and the NAS
// is found, added through a fleet's server and its disks are on Storage; a profile with AES gets
// "the privacy protocol or password doesn't match" and is corrected by "Find what works". Every
// page passes the layout checks.
//
// Against a running dashboard with network devices on, a collector from 1.0.4 in a cluster and
// one on a fleet's server, and the simulators (ee/collector/cmd/netsim -office: its NAS answers
// the SNMPv3 user "watchlog" with "read-only-auth" and "read-only-priv", SHA or MD5 with DES):
//   WATCHLOG_E2E_URL=http://localhost:4188 WATCHLOG_E2E_EMAIL=… WATCHLOG_E2E_PASSWORD=… \
//   WATCHLOG_E2E_NET_KUBE=<the cluster's name> WATCHLOG_E2E_NET_FLEET=<the fleet's name> \
//   WATCHLOG_E2E_NET_SERVER=<its server> WATCHLOG_E2E_NET_NAS=127.0.0.1:21164 \
//     pnpm exec playwright test e2e/network-snmpv3.spec.ts
// WATCHLOG_E2E_SHOT_DIR saves a screenshot of each step.
import { expect, test, type Page } from '@playwright/test';
import { layoutProblems, report, viewportFor } from './layout-checks';

const email = process.env.WATCHLOG_E2E_EMAIL;
const password = process.env.WATCHLOG_E2E_PASSWORD;
const SHOTS = process.env.WATCHLOG_E2E_SHOT_DIR?.replace(/\/+$/, '');
const THEME = process.env.WATCHLOG_E2E_THEME === 'light' ? 'light' : 'dark';
const KUBE = process.env.WATCHLOG_E2E_NET_KUBE ?? '';
const FLEET = process.env.WATCHLOG_E2E_NET_FLEET ?? '';
const SERVER = process.env.WATCHLOG_E2E_NET_SERVER ?? '';
const NAS = process.env.WATCHLOG_E2E_NET_NAS ?? '';
const USER = process.env.WATCHLOG_E2E_NET_V3_USER ?? 'watchlog';
const AUTH = process.env.WATCHLOG_E2E_NET_V3_AUTH ?? 'read-only-auth';
const PRIV = process.env.WATCHLOG_E2E_NET_V3_PRIV ?? 'read-only-priv';
const READY = !!(KUBE && FLEET && SERVER && NAS);

interface Profile {
  id: string;
  name: string;
}
interface Device {
  id: string;
  address: string;
  credential?: { id: string; name: string } | null;
}

let session = process.env.WATCHLOG_E2E_SESSION?.replace(/^wl_session=/, '') || '';
async function signIn(page: Page) {
  const url = process.env.WATCHLOG_E2E_URL ?? 'http://localhost:4088';
  if (!session) {
    if (!email || !password) throw new Error('set WATCHLOG_E2E_EMAIL and _PASSWORD');
    const res = await page.request.post('/api/v1/auth/login', { data: { email, password } });
    expect(res.ok(), await res.text()).toBe(true);
    session = (await page.context().cookies(url)).find((c) => c.name === 'wl_session')?.value ?? '';
    if (!session) throw new Error('no session cookie after sign-in');
    return;
  }
  await page.context().addCookies([{ name: 'wl_session', value: session, url }]);
}
async function api<T>(page: Page, method: string, path: string): Promise<T> {
  const res = await page.request.fetch(`/api/v1/network${path}`, { method });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return (res.status() === 204 ? null : await res.json()) as T;
}
async function shot(page: Page, name: string, width: number) {
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/${THEME}-${width}-${name}.png`, fullPage: true });
}
async function layoutOk(page: Page, where: string) {
  // A page that just loaded may be wider for a moment while its charts take their size.
  await expect
    .poll(async () => (await layoutProblems(page)).length, { timeout: 4_000 })
    .toBe(0)
    .catch(() => undefined);
  const problems = await layoutProblems(page);
  expect(problems, report(where, page.viewportSize()?.width ?? 0, problems)).toEqual([]);
}
async function setup(page: Page, width: number) {
  await page.setViewportSize(width < 1024 ? viewportFor(width).viewport : { width, height: 1000 });
  await signIn(page);
}
async function choose(page: Page, testid: string, label: string) {
  const field = page.getByTestId(testid);
  if ((page.viewportSize()?.width ?? 0) < 768) await field.click();
  else await field.getByRole('combobox').click();
  await page.getByRole('option', { name: new RegExp(`^${label}`) }).click();
}
/** What an earlier run left: the NAS (whoever added it) and this run's profiles. */
async function clean(page: Page, prefix: string) {
  const { devices } = await api<{ devices: Device[] }>(page, 'GET', '/devices');
  for (const d of devices) if (d.address === NAS) await api(page, 'DELETE', `/devices/${d.id}`);
  const { credentials } = await api<{ credentials: Profile[] }>(page, 'GET', '/credentials');
  for (const c of credentials)
    if (c.name.startsWith(prefix)) await api(page, 'DELETE', `/credentials/${c.id}`);
}
const result = (page: Page) => page.getByTestId('cred-test-result');

for (const width of [1440, 390]) {
  const P = `e2e104-${THEME}-${width}-`;

  test(`${width} px: a QNAP's profile is SHA with DES, tested, and the NAS shows its disks`, async ({
    page,
  }) => {
    test.skip(!READY, 'set WATCHLOG_E2E_NET_KUBE, _FLEET, _SERVER and _NAS');
    await setup(page, width);
    await clean(page, P);
    await page.goto('/network/add');

    // The QNAP steps follow QTS's screen and make the profile.
    await page.getByTestId('setup-details').locator('summary').click();
    await page.getByRole('tab', { name: /QNAP/ }).click();
    const steps = page.getByTestId('setup-guide-qnap');
    await expect(steps).toContainText('Control Panel → Network & File Services → SNMP');
    await expect(steps).toContainText('HMAC-SHA');
    await expect(steps).toContainText('it encrypts with DES');
    await layoutOk(page, 'the QNAP steps');
    await shot(page, 'qnap-steps', width);
    await page.getByTestId('setup-qnap-profile').click();

    const form = page.getByTestId('cred-form');
    await expect(page.getByTestId('cred-qnap-preset')).toContainText(
      'QTS encrypts SNMPv3 with DES',
    );
    await expect(page.getByTestId('cred-older-note')).toContainText(
      "DES and MD5 are weak by today's standards.",
    );
    await form.getByLabel('Profile name').fill(`${P}nas`);
    await form.getByLabel('User', { exact: true }).fill(USER);
    await form.getByLabel('Authentication key').fill(AUTH);
    await form.getByLabel('Privacy key').fill(PRIV);
    // Tested through the cluster's collector before it is saved.
    await page.getByTestId('cred-test-address').locator('input').fill(NAS);
    await choose(page, 'cred-test-poller', KUBE);
    await page.getByTestId('cred-test-run').click();
    await expect(result(page)).toHaveAttribute('data-outcome', 'answered', { timeout: 60_000 });
    await expect(result(page)).toContainText('QNAP');
    await layoutOk(page, "a QNAP's profile, tested");
    await shot(page, 'qnap-profile-answered', width);
    await page.getByTestId('cred-save').click();
    const card = page.getByTestId(`cred-card-${P}nas`);
    await expect(card).toContainText('SHA-1 / DES');
    await expect(card.getByTestId('strength-older')).toHaveText('older encryption');
    await shot(page, 'qnap-profile-card', width);

    // Found from the fleet's server, with only this profile ticked, and added.
    await page.getByTestId(`poller-${FLEET}-${SERVER}`).click();
    const { credentials } = await api<{ credentials: Profile[] }>(page, 'GET', '/credentials');
    for (const c of credentials) {
      const box = page.getByTestId(`cred-card-${c.name}`).locator('input[type="checkbox"]');
      if ((await box.count()) && (await box.isChecked()) !== (c.name === `${P}nas`))
        await box.click();
    }
    await page.getByTestId('add-seeds').fill(NAS);
    await page.getByTestId('add-find').click();
    await expect(page.getByTestId(`found-${NAS}`)).toContainText('nas-1', { timeout: 60_000 });
    await shot(page, 'qnap-found', width);
    await page.getByTestId('add-submit').click();
    await page.waitForURL(/\/network\/devices/);

    // Its disks on Storage, read with SHA and DES.
    await page.goto('/network/storage');
    await expect(page.getByTestId('nas-disk-row').first()).toBeVisible({ timeout: 120_000 });
    await layoutOk(page, "the NAS's disks");
    await shot(page, 'qnap-storage', width);
    const { devices } = await api<{ devices: Device[] }>(page, 'GET', '/devices');
    const nas = devices.find((d) => d.address === NAS);
    await page.goto(`/network/devices/${nas!.id}`);
    await expect(page.getByTestId('device-facts').getByTestId('strength-older')).toHaveText(
      'older encryption',
    );
    await layoutOk(page, "the NAS's page");
    await shot(page, 'qnap-device', width);
    await clean(page, P);
  });

  test(`${width} px: a profile with AES is corrected by "Find what works"`, async ({ page }) => {
    test.skip(!READY, 'set WATCHLOG_E2E_NET_KUBE, _FLEET, _SERVER and _NAS');
    await setup(page, width);
    await clean(page, P);
    await page.goto('/network/add');
    await page.getByTestId('cred-new').click();
    const form = page.getByTestId('cred-form');
    await form.getByLabel('Profile name').fill(`${P}nas-aes`);
    await form.getByLabel('User', { exact: true }).fill(USER);
    await form.getByLabel('Authentication key').fill(AUTH);
    await form.getByLabel('Privacy key').fill(PRIV);
    await expect(page.getByTestId('cred-older-note')).toHaveCount(0);

    // SHA-256 with AES, the defaults, through the fleet's server.
    await page.getByTestId('cred-test-address').locator('input').fill(NAS);
    await choose(page, 'cred-test-poller', SERVER);
    await page.getByTestId('cred-test-run').click();
    await expect(result(page)).toHaveAttribute('data-outcome', /auth|privacy/, { timeout: 60_000 });
    // SHA-1 with AES: the device answers, and the privacy doesn't match.
    await choose(page, 'cred-auth', 'SHA-1');
    await page.getByTestId('cred-test-run').click();
    await expect(result(page)).toHaveAttribute('data-outcome', 'privacy', { timeout: 60_000 });
    await expect(result(page)).toContainText('if this is a QNAP, choose DES');
    await layoutOk(page, 'the privacy that does not match');
    await shot(page, 'aes-privacy', width);

    await page.getByTestId('cred-test-find').click();
    await expect(page.getByTestId('cred-test-found')).toContainText('SHA-1 with DES answered', {
      timeout: 60_000,
    });
    await layoutOk(page, '"Find what works" answered');
    await shot(page, 'find-answered', width);
    await page.getByTestId('cred-test-use').click();
    // The form now says SHA-1 with DES (a phone shows the choice on a button).
    if (width < 768) await expect(page.getByTestId('cred-priv')).toContainText('DES');
    else
      await expect(page.getByTestId('cred-priv').getByRole('combobox')).toHaveAttribute(
        'placeholder',
        'DES',
      );
    await expect(page.getByTestId('cred-older-note')).toBeVisible();
    await page.getByTestId('cred-test-run').click();
    await expect(result(page)).toHaveAttribute('data-outcome', 'answered', { timeout: 60_000 });
    await page.getByTestId('cred-save').click();
    await expect(page.getByTestId(`cred-card-${P}nas-aes`)).toContainText('SHA-1 / DES');
    await shot(page, 'find-saved', width);
    await clean(page, P);
  });
}
