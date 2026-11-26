// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// SNMPv3's protocols on Add devices (1.0.4): the three security levels chosen in the form, the
// choices grouped into "Recommended" and "For older devices", one calm line for MD5 or DES, a
// small mark on a profile with older encryption or without privacy (its card and its devices'
// pages), the test's sentence for each wrong value, "Find what works", a collector older than
// 1.0.4 said with its server and a link, and a QNAP's profile preset to SHA with DES.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { mockFetch, USER, type Routes } from '../../../../web/test/fetch-mock';
import { chooseOption, createPlugins } from '../../../../web/test/helpers';
import type { Credential, DeviceDetail, PollerChoice } from '../api';
import DeviceHeader from '../components/device/DeviceHeader.vue';
import { authLabel, isOlder, privLabel } from '../lib/snmp';
import AddPage from './AddPage.vue';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const FLEET = '01a18f42-06e7-7078-a01a-ea39c791d701';
const POLLERS: PollerChoice[] = [
  {
    clusterId: FLEET,
    name: 'office',
    kind: 'server',
    hosts: [{ host: 'srv-1', collector: true, reporting: true, devices: 1 }],
  },
];
const V3: Credential = {
  id: 'c-v3',
  name: 'switches-v3',
  protocol: 'snmp',
  settings: { version: '3', user: 'watchlog', authProto: 'SHA256', privProto: 'AES' },
  secretSet: true,
  usedBy: 2,
  strength: null,
  olderCollector: null,
};
const NAS: Credential = {
  ...V3,
  id: 'c-nas',
  name: 'nas-des',
  settings: { version: '3', user: 'watchlog', authProto: 'SHA', privProto: 'DES' },
  usedBy: 1,
  strength: 'older',
  olderCollector: { what: 'DES', pollers: ['srv-1'] },
};
const PLAIN: Credential = {
  ...V3,
  id: 'c-plain',
  name: 'ups-auth',
  settings: { version: '3', user: 'watchlog', level: 'authNoPriv', authProto: 'SHA' },
  usedBy: 0,
  strength: 'plain',
};
const BASE = '/api/v1/network';
const lists = (credentials: Credential[]): Routes => ({
  [`GET ${BASE}/pollers`]: { status: 200, body: { pollers: POLLERS } },
  [`GET ${BASE}/credentials`]: { status: 200, body: { credentials } },
});

async function page(routes: Routes, path = '/network/add') {
  const m = mockFetch(routes);
  const plugins = await createPlugins(path);
  useAuthStore().user = { ...USER, role: 'owner' };
  const w = mount(AddPage, {
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  await flushPromises();
  return { w, ...m };
}
const tid = (id: string) => `[data-testid="${id}"]`;
function field(w: VueWrapper, label: string) {
  const l = w.findAll('label').find((x) => x.text().trim() === label);
  if (!l) throw new Error(`no field "${label}"`);
  return w.get(`[id="${l.attributes('for')}"]`);
}
const has = (w: VueWrapper, label: string) =>
  w.findAll('label').some((x) => x.text().trim() === label);
/** An open Combobox's group headings and options, in order. */
async function listed(w: VueWrapper, testid: string): Promise<string[]> {
  const input = w.get(`${tid(testid)} [role="combobox"]`);
  await input.trigger('focus');
  await input.trigger('keydown', { key: 'ArrowDown' });
  await flushPromises();
  const list = document.getElementById(input.attributes('aria-controls') ?? '');
  const out = [...(list?.querySelectorAll<HTMLElement>('[role="group"] > *') ?? [])]
    .map((e) => e.textContent?.trim() ?? '')
    .filter(Boolean);
  await input.trigger('keydown', { key: 'Escape' });
  await flushPromises();
  return out;
}
async function newV3(w: VueWrapper) {
  await w.get(tid('cred-new')).trigger('click');
  await field(w, 'Profile name').setValue('nas');
  await field(w, 'User').setValue('watchlog');
}

describe('the labels', () => {
  it('names the protocols as people know them', () => {
    expect(['SHA', 'SHA256', 'MD5'].map(authLabel)).toEqual(['SHA-1', 'SHA-256', 'MD5']);
    expect(['AES', 'AES256', 'AES192C', 'DES'].map(privLabel)).toEqual([
      'AES-128',
      'AES-256',
      'AES-192 (Cisco)',
      'DES',
    ]);
    expect(isOlder('MD5', 'AES')).toBe(true);
    expect(isOlder('SHA', 'DES')).toBe(true);
    expect(isOlder('SHA', null)).toBe(false);
    expect(isOlder('SHA256', 'AES')).toBe(false);
  });
});

describe('the profile form', () => {
  it('groups the choices: recommended first, MD5 and DES for older devices', async () => {
    const { w } = await page(lists([]));
    await newV3(w);
    const auth = await listed(w, 'cred-auth');
    expect(auth).toEqual([
      'Recommended',
      expect.stringContaining('SHA-256'),
      expect.stringContaining('SHA-1'),
      expect.stringContaining('SHA-224'),
      expect.stringContaining('SHA-384'),
      expect.stringContaining('SHA-512'),
      'For older devices',
      expect.stringContaining('MD5'),
    ]);
    const priv = await listed(w, 'cred-priv');
    expect(priv[0]).toBe('Recommended');
    expect(priv).toContain('For older devices');
    expect(priv.indexOf('For older devices')).toBe(priv.length - 2);
    expect(priv.at(-1)).toContain('DES');
    expect(priv.some((p) => p.includes('AES-256 (Cisco)'))).toBe(true);
  });

  it('defaults to SHA-256 with AES, says nothing until MD5 or DES is chosen', async () => {
    const { w, calls } = await page({
      ...lists([]),
      [`POST ${BASE}/credentials`]: { status: 201, body: { id: 'c-new' } },
    });
    await newV3(w);
    expect(w.find(tid('cred-older-note')).exists()).toBe(false);
    await chooseOption(w, 'cred-priv', 'DES');
    expect(w.get(tid('cred-older-note')).text()).toBe(
      "DES and MD5 are weak by today's standards. Use them only when the device offers nothing else, as QNAP's QTS does, and keep SNMP reachable from the poller only.",
    );
    await chooseOption(w, 'cred-priv', 'AES-128');
    expect(w.find(tid('cred-older-note')).exists()).toBe(false);
    await chooseOption(w, 'cred-auth', 'MD5');
    expect(w.find(tid('cred-older-note')).exists()).toBe(true);
    await field(w, 'Authentication key').setValue('auth-secret-1');
    await field(w, 'Privacy key').setValue('priv-secret-1');
    await w.get(tid('cred-form')).trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      settings: { version: '3', user: 'watchlog', authProto: 'MD5', privProto: 'AES' },
      secret: { authKey: 'auth-secret-1', privKey: 'priv-secret-1' },
    });
  });

  it('chooses the security level: each one asks for its own keys and says what it leaves out', async () => {
    const { w, calls } = await page({
      ...lists([]),
      [`POST ${BASE}/credentials`]: { status: 201, body: { id: 'c-new' } },
    });
    await newV3(w);
    expect((w.get(`${tid('cred-level-authPriv')}`).element as HTMLInputElement).checked).toBe(true);

    await w.get(tid('cred-level-authNoPriv')).setValue(true);
    expect(has(w, 'Authentication key')).toBe(true);
    expect(has(w, 'Privacy key')).toBe(false);
    expect(w.find(tid('cred-priv')).exists()).toBe(false);
    expect(w.get(tid('cred-plain-note')).text()).toContain('unencrypted');
    await w.get(tid('cred-form')).trigger('submit');
    await flushPromises();
    expect(w.get(tid('cred-form')).text()).toContain('Give the authentication key');
    await field(w, 'Authentication key').setValue('auth-secret-1');
    await w.get(tid('cred-form')).trigger('submit');
    await flushPromises();
    expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toMatchObject({
      settings: { version: '3', user: 'watchlog', level: 'authNoPriv', authProto: 'SHA256' },
      secret: { authKey: 'auth-secret-1' },
    });
    const sent = calls.filter((c) => c.method === 'POST').at(-1)?.body as {
      settings: object;
      secret: object;
    };
    expect(sent.settings).not.toHaveProperty('privProto');
    expect(sent.secret).not.toHaveProperty('privKey');
  });

  it('noAuthNoPriv sends the user alone', async () => {
    const { w, calls } = await page({
      ...lists([]),
      [`POST ${BASE}/credentials`]: { status: 201, body: { id: 'c-new' } },
    });
    await newV3(w);
    await w.get(tid('cred-level-noAuthNoPriv')).setValue(true);
    expect(has(w, 'Authentication key')).toBe(false);
    expect(w.find(tid('cred-test-find')).exists()).toBe(false);
    await w.get(tid('cred-form')).trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      settings: { version: '3', user: 'watchlog', level: 'noAuthNoPriv' },
      secret: {},
    });
  });

  it("a QNAP's new profile is SHA with DES, and says why", async () => {
    const { w } = await page(lists([]), '/network/add?new=qnap');
    expect(w.get(tid('cred-qnap-preset')).text()).toContain('QTS encrypts SNMPv3 with DES');
    expect(w.get(`${tid('cred-auth')} [role="combobox"]`).attributes('placeholder')).toBe('SHA-1');
    expect(w.get(`${tid('cred-priv')} [role="combobox"]`).attributes('placeholder')).toBe('DES');
    expect(w.find(tid('cred-older-note')).exists()).toBe(true);
  });

  it("the QNAP steps follow QTS's screen and make that profile", async () => {
    const { w } = await page(lists([V3]));
    await w.get(tid('setup-details')).find('summary').trigger('click');
    const tab = w.findAll('[role="tab"]').find((x) => x.text().includes('QNAP'));
    await tab!.trigger('click');
    const steps = w.get(tid('setup-guide-qnap')).text();
    expect(steps).toContain('Control Panel → Network & File Services → SNMP');
    expect(steps).toContain('SNMP V3');
    expect(steps).toContain('HMAC-SHA');
    expect(steps).toContain('Use Privacy');
    expect(steps).toContain('DES');
    expect(steps).not.toMatch(/\bAES\b(?! gets no answer)/);
    await w.get(tid('setup-qnap-profile')).trigger('click');
    expect(w.find(tid('cred-qnap-preset')).exists()).toBe(true);
    expect(w.get(`${tid('cred-priv')} [role="combobox"]`).attributes('placeholder')).toBe('DES');
  });
});

describe('the cards', () => {
  it('marks older encryption and no encryption, and says which collector is too old', async () => {
    const { w } = await page(lists([V3, NAS, PLAIN]));
    expect(w.get(tid('cred-card-switches-v3')).find('[data-testid^="strength-"]').exists()).toBe(
      false,
    );
    const nas = w.get(tid('cred-card-nas-des'));
    expect(nas.get(tid('strength-older')).text()).toBe('older encryption');
    expect(nas.text()).toContain('SNMPv3 · watchlog · SHA-1 / DES');
    expect(w.get(tid('cred-old-collector-nas-des')).text()).toContain(
      "The collector on srv-1 is older than 1.0.4 and can't read with DES; update it.",
    );
    expect(w.get(tid('cred-old-collector-nas-des')).find('a').attributes('href')).toContain(
      '#updating-the-collector',
    );
    const plain = w.get(tid('cred-card-ups-auth'));
    expect(plain.get(tid('strength-plain')).text()).toBe('not encrypted');
    expect(plain.text()).toContain('SNMPv3 · watchlog · SHA-1, no privacy');
  });
});

describe('the test', () => {
  const run = async (body: object, edit = 'switches-v3', find = false) => {
    const r = await page({
      ...lists([V3, NAS]),
      [`POST ${BASE}/credential-tests`]: { status: 201, body: { id: 't1' } },
      [`GET ${BASE}/credential-tests/t1`]: {
        status: 200,
        body: { id: 't1', done: true, address: '10.0.0.5', ...body },
      },
    });
    await r.w.get(tid(`cred-edit-${edit}`)).trigger('click');
    await r.w.get(`${tid('cred-test-address')} input`).setValue('10.0.0.5');
    await r.w.get(tid(find ? 'cred-test-find' : 'cred-test-run')).trigger('click');
    await flushPromises();
    return r;
  };

  for (const [outcome, words] of [
    ['user', /doesn't know this SNMPv3 user/],
    ['auth', /authentication password or protocol doesn't match/],
    ['privacy', /privacy protocol or password doesn't match: if this is a QNAP, choose DES/],
    ['level', /another security level/],
  ] as const) {
    it(`says which value is wrong: ${outcome}`, async () => {
      const { w } = await run({ outcome });
      expect(w.get(tid('cred-test-result')).text()).toMatch(words);
    });
  }

  it("an older collector: names its server and links to how it's updated", async () => {
    const { w } = await run({ outcome: 'collector_old', collector: 'DES' }, 'nas-des');
    const r = w.get(tid('cred-test-result'));
    expect(r.text()).toContain(
      "The collector on srv-1 is older than 1.0.4 and can't read with DES; update it.",
    );
    expect(w.get(tid('cred-test-update-link')).attributes('href')).toBe(
      'https://watchlog.io/docs/network/#updating-the-collector',
    );
  });

  it('"Find what works" asks with find, offers what answered and puts it in the form', async () => {
    const { w, calls } = await run(
      {
        outcome: 'answered',
        name: 'nas-1',
        found: { authProto: 'SHA', privProto: 'DES' },
        tried: 4,
      },
      'switches-v3',
      true,
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      address: '10.0.0.5',
      settings: V3.settings,
      secret: { authKey: '', privKey: '' },
      credentialId: 'c-v3',
      find: true,
    });
    expect(w.get(tid('cred-test-found')).text()).toContain(
      'SHA-1 with DES answered (tried 4 combinations).',
    );
    await w.get(tid('cred-test-use')).trigger('click');
    expect(w.get(`${tid('cred-auth')} [role="combobox"]`).attributes('placeholder')).toBe('SHA-1');
    expect(w.get(`${tid('cred-priv')} [role="combobox"]`).attributes('placeholder')).toBe('DES');
  });

  it('"Find what works" with nothing answering says how many were tried', async () => {
    const { w } = await run({ outcome: 'privacy', tried: 9 }, 'switches-v3', true);
    expect(w.find(tid('cred-test-found')).exists()).toBe(false);
    expect(w.get(tid('cred-test-tried')).text()).toBe('No combination answered (9 tried).');
  });

  it('a plain test never offers protocols', async () => {
    const { w, calls } = await run({ outcome: 'answered' });
    expect(calls.find((c) => c.method === 'POST')?.body).not.toHaveProperty('find');
    expect(w.find(tid('cred-test-found')).exists()).toBe(false);
  });
});

describe("a device's page", () => {
  const DEVICE = {
    id: 'd1',
    name: 'nas-1',
    address: '10.0.0.5',
    kind: 'nas',
    protocol: 'snmp',
    status: 'ok',
    vendor: 'QNAP',
    model: 'TS-464',
    poller: { clusterId: FLEET, name: 'office', host: 'srv-1', kind: 'server' },
    credential: { id: 'c-nas', name: 'nas-des', protocol: 'snmp', strength: 'older' },
    managedAp: false,
    openAlerts: 0,
  } as unknown as DeviceDetail['device'];
  const header = async (over: object, role = 'owner') => {
    mockFetch({});
    const plugins = await createPlugins('/network');
    useAuthStore().user = { ...USER, role: role as 'owner' };
    const w = mount(DeviceHeader, {
      props: { detail: { device: { ...DEVICE, ...over }, ports: [], alerts: [] } as never },
      attachTo: document.body,
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    await flushPromises();
    return w;
  };

  it("marks its profile's strength beside it, calmly", async () => {
    const w = await header({});
    expect(w.get(tid('device-facts')).get(tid('strength-older')).text()).toBe('older encryption');
    expect(w.find(tid('device-qnap-hint')).exists()).toBe(false);
    w.unmount();
    const plain = await header({
      credential: { id: 'c', name: 'p', protocol: 'snmp', strength: 'plain' },
    });
    expect(plain.get(tid('strength-plain')).text()).toBe('not encrypted');
  });

  it("says in words that its collector is too old, instead of the collector's sentence", async () => {
    const w = await header({
      status: 'unreachable',
      error: 'SNMPv3 privacy "DES" isn\'t supported (AES)',
      olderCollector: 'DES',
    });
    expect(w.get(tid('device-old-collector')).text()).toContain(
      "The collector on srv-1 is older than 1.0.4 and can't read with DES; update it.",
    );
    expect(w.text()).not.toContain("isn't supported (AES)");
  });

  it('a QNAP that cannot be read links to a new profile with SHA and DES', async () => {
    const w = await header({ status: 'unreachable', error: 'the device refused…' });
    const hint = w.get(tid('device-qnap-hint'));
    expect(hint.text()).toContain('QTS encrypts SNMPv3 with DES');
    expect(hint.find('a').attributes('href')).toBe('/network/add?new=qnap');
    w.unmount();
    const viewer = await header({ status: 'unreachable' }, 'viewer');
    expect(viewer.find(tid('device-qnap-hint')).exists()).toBe(false);
  });
});
