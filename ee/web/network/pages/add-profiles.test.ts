// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// Credential profiles on Add devices (1.0.2): a profile is edited (a secret left empty is kept,
// a typed one replaces it, the protocol stays), tested against an address through a cluster or
// a fleet's server with each outcome in words, and deleted (unused; in use: its devices listed
// and moved first). A Viewer and the demo see the cards with their controls locked. A poller's
// devices move to another poller; a device's address, pause and an accepted certificate's undo.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { mockFetch, problem, USER, type Routes } from '../../../../web/test/fetch-mock';
import { chooseOption, createPlugins, optionsOf } from '../../../../web/test/helpers';
import type { Credential, CredentialTest, DeviceDetail, PollerChoice } from '../api';
import DeviceHeader from '../components/device/DeviceHeader.vue';
import DeviceSettings from '../components/device/DeviceSettings.vue';
import AddPage from './AddPage.vue';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const KUBE = '01a18f42-06e7-7078-a01a-ea39c791d700';
const FLEET = '01a18f42-06e7-7078-a01a-ea39c791d701';
const POLLERS: PollerChoice[] = [
  {
    clusterId: KUBE,
    name: 'prod',
    kind: 'kubernetes',
    hosts: [{ host: '', collector: true, reporting: true, devices: 0 }],
  },
  {
    clusterId: FLEET,
    name: 'office',
    kind: 'server',
    hosts: [
      { host: 'srv-1', collector: true, reporting: true, devices: 3 },
      { host: 'srv-2', collector: true, reporting: true, devices: 0 },
      { host: 'srv-3', collector: false, reporting: false, devices: 0 },
    ],
  },
];
const V3: Credential = {
  id: 'c-v3',
  name: 'switches-v3',
  protocol: 'snmp',
  settings: { version: '3', user: 'watchlog', authProto: 'SHA256', privProto: 'AES' },
  secretSet: true,
  usedBy: 2,
};
const V3_OTHER: Credential = { ...V3, id: 'c-v3b', name: 'switches-new', usedBy: 0 };
const ROS: Credential = {
  id: 'c-ros',
  name: 'routers',
  protocol: 'routeros',
  settings: { user: 'watchlog', transport: 'rest', allowPlain: false },
  secretSet: true,
  usedBy: 0,
};
const BASE = '/api/v1/network';
const lists = (credentials: Credential[], pollers = POLLERS): Routes => ({
  [`GET ${BASE}/pollers`]: { status: 200, body: { pollers } },
  [`GET ${BASE}/credentials`]: { status: 200, body: { credentials } },
});

async function page(routes: Routes, role = 'owner', path = '/network/add', demo = false) {
  const m = mockFetch(routes);
  const plugins = await createPlugins(path);
  useAuthStore().user = { ...USER, role: role as 'owner' };
  useAuthStore().demoMode = demo;
  const w = mount(AddPage, {
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  await flushPromises();
  return { w, ...m };
}
const tid = (id: string) => `[data-testid="${id}"]`;
/** The input under the label with these words. */
function field(w: VueWrapper, label: string) {
  const l = w.findAll('label').find((x) => x.text().trim() === label);
  if (!l) throw new Error(`no field "${label}"`);
  return w.get(`[id="${l.attributes('for')}"]`);
}
const inBody = (id: string) => document.body.querySelector<HTMLElement>(tid(id));
async function click(id: string) {
  const el = inBody(id);
  if (!el) throw new Error(`no ${id}`);
  el.click();
  await flushPromises();
}

describe('editing a profile', () => {
  it('opens the form filled in, without the secrets; an empty secret is kept', async () => {
    const { w, calls } = await page({
      ...lists([V3, ROS]),
      [`PATCH ${BASE}/credentials/c-v3`]: { status: 204 },
    });
    await w.get(tid('cred-edit-switches-v3')).trigger('click');
    expect(w.get(tid('cred-editing')).text()).toContain('switches-v3');
    expect((field(w, 'Profile name').element as HTMLInputElement).value).toBe('switches-v3');
    expect((field(w, 'User').element as HTMLInputElement).value).toBe('watchlog');
    // Secrets are never shown: the fields are empty and say so.
    const auth = field(w, 'Authentication key');
    expect((auth.element as HTMLInputElement).value).toBe('');
    expect(w.get(tid('cred-form')).text()).toContain('Leave empty to keep the current one');
    // The protocol can't change; a new profile is offered instead.
    expect(w.get(tid('cred-protocol-fixed')).text()).toContain('SNMP');
    expect(w.get(tid('cred-protocol-fixed')).text()).toContain('Make a new profile instead');
    expect(w.find('input[type="radio"][value="routeros"]').exists()).toBe(false);
    // How many devices use it, and when they are read with the new values.
    expect(w.get(tid('cred-used')).text()).toBe(
      '2 devices use this profile. They will be read with the new values from the next poll.',
    );

    await field(w, 'Profile name').setValue('switches-core');
    await field(w, 'User').setValue('wl-read');
    await w.get(tid('cred-form')).trigger('submit');
    await flushPromises();
    const sent = calls.find((c) => c.method === 'PATCH');
    expect(sent?.body).toEqual({
      name: 'switches-core',
      settings: { version: '3', user: 'wl-read', authProto: 'SHA256', privProto: 'AES' },
    });
    expect(w.find(tid('cred-form')).exists()).toBe(false);
    expect(w.get(tid('cred-note')).text()).toContain('is saved');
    expect(w.get(tid('cred-note')).text()).toContain('from the next poll');
  });

  it('sends only the secret that was typed, and refuses a short one before asking', async () => {
    const { w, calls } = await page({
      ...lists([V3]),
      [`PATCH ${BASE}/credentials/c-v3`]: { status: 204 },
    });
    await w.get(tid('cred-edit-switches-v3')).trigger('click');
    await field(w, 'Authentication key').setValue('short');
    await w.get(tid('cred-form')).trigger('submit');
    await flushPromises();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(w.get('[role="alert"]').text()).toContain('8');

    await field(w, 'Authentication key').setValue('a-new-auth-key');
    await w.get(tid('cred-form')).trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
      secret: { authKey: 'a-new-auth-key' },
    });
    expect(
      (calls.find((c) => c.method === 'PATCH')?.body as { secret: object }).secret,
    ).not.toHaveProperty('privKey');
  });

  it('says the server\'s refusal, and "Make a new profile instead" opens an empty form', async () => {
    const { w } = await page({
      ...lists([V3, ROS]),
      [`PATCH ${BASE}/credentials/c-ros`]: problem(409, 'Another profile is named switches-v3.'),
    });
    await w.get(tid('cred-edit-routers')).trigger('click');
    expect(w.get(tid('cred-protocol-fixed')).text()).toContain('RouterOS');
    await field(w, 'Profile name').setValue('switches-v3');
    await w.get(tid('cred-form')).trigger('submit');
    await flushPromises();
    expect(w.get(tid('cred-form')).text()).toContain('Another profile is named switches-v3.');

    await w.get(tid('cred-fresh')).trigger('click');
    expect(w.find(tid('cred-editing')).exists()).toBe(false);
    expect((field(w, 'Profile name').element as HTMLInputElement).value).toBe('');
    expect(w.find('input[type="radio"][value="routeros"]').exists()).toBe(true);
  });

  it("a link from a device's page opens its profile for editing", async () => {
    const { w } = await page(lists([V3, ROS]), 'admin', '/network/add?profile=c-ros');
    expect(w.get(tid('cred-editing')).text()).toContain('routers');
  });
});

describe('Test against an address', () => {
  const OUTCOMES: [CredentialTest, RegExp][] = [
    [
      {
        id: 't1',
        done: true,
        address: '10.0.10.2',
        outcome: 'answered',
        name: 'sw-access-2',
        vendor: 'Cisco',
        model: 'C9200L',
      },
      /^10\.0\.10\.2 answered: sw-access-2, Cisco C9200L\. These values work\.$/,
    ],
    [
      { id: 't1', done: true, address: '10.0.10.2', outcome: 'refused' },
      /refused these values: the user, the authentication or the privacy key is wrong/,
    ],
    [
      { id: 't1', done: true, address: '10.0.10.2', outcome: 'no_answer' },
      /^Nothing answered at 10\.0\.10\.2\./,
    ],
    [
      { id: 't1', done: true, address: '10.0.10.2', outcome: 'certificate' },
      /certificate that isn't the one pinned.*Nothing was sent to it/,
    ],
    [
      { id: 't1', done: true, address: '10.0.10.2', outcome: 'poller_silent' },
      /The poller didn't report back/,
    ],
  ];
  for (const [answer, words] of OUTCOMES) {
    it(`says "${answer.outcome}" in words`, async () => {
      const { w, calls } = await page({
        ...lists([V3]),
        [`POST ${BASE}/credential-tests`]: { status: 201, body: { id: 't1' } },
        [`GET ${BASE}/credential-tests/t1`]: { status: 200, body: answer },
      });
      await w.get(tid('cred-edit-switches-v3')).trigger('click');
      await w.get(`${tid('cred-test-address')} input`).setValue('10.0.10.2');
      await w.get(tid('cred-test-run')).trigger('click');
      await flushPromises();
      const result = w.get(tid('cred-test-result'));
      expect(result.attributes('data-outcome')).toBe(answer.outcome);
      expect(result.text()).toMatch(words);
      // The values as typed, the saved profile for the secrets left empty, the first poller.
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        clusterId: KUBE,
        host: '',
        address: '10.0.10.2',
        protocol: 'snmp',
        settings: V3.settings,
        secret: { authKey: '', privKey: '' },
        credentialId: 'c-v3',
      });
    });
  }

  it('runs through a server of a fleet, and asks again until the poller answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { w, calls } = await page({
      ...lists([ROS]),
      [`POST ${BASE}/credential-tests`]: { status: 201, body: { id: 't2' } },
      [`GET ${BASE}/credential-tests/t2`]: [
        { status: 200, body: { id: 't2', done: false } },
        {
          status: 200,
          body: { id: 't2', done: true, address: 'gw.example', outcome: 'refused' },
        },
      ],
    });
    await w.get(tid('cred-new')).trigger('click');
    await w.get('input[type="radio"][value="routeros"]').setValue(true);
    await field(w, 'Profile name').setValue('routers-2');
    await field(w, 'User').setValue('watchlog');
    await field(w, 'Password').setValue('a-wrong-password');
    // Only pollers with a collector are offered: the cluster and two of the fleet's servers.
    expect(await optionsOf(w, 'cred-test-poller')).toEqual([
      expect.stringContaining('prod'),
      expect.stringContaining('srv-1'),
      expect.stringContaining('srv-2'),
    ]);
    await chooseOption(w, 'cred-test-poller', 'srv-2');
    await w.get(`${tid('cred-test-address')} input`).setValue('gw.example');
    await w.get(tid('cred-test-run')).trigger('click');
    await flushPromises();
    expect(w.find(tid('cred-test-running')).exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(1300);
    await flushPromises();
    expect(w.get(tid('cred-test-result')).text()).toBe(
      'The router answered and refused the user or the password.',
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      clusterId: FLEET,
      host: 'srv-2',
      address: 'gw.example',
      protocol: 'routeros',
      settings: { user: 'watchlog', transport: 'rest', allowPlain: false },
      secret: { password: 'a-wrong-password' },
    });
    // Nothing was saved by testing.
    expect(calls.some((c) => c.path === `${BASE}/credentials` && c.method === 'POST')).toBe(false);
  });

  it('says after a while that an older collector answers with its next round', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { w } = await page({
      ...lists([V3]),
      [`POST ${BASE}/credential-tests`]: { status: 201, body: { id: 't3' } },
      [`GET ${BASE}/credential-tests/t3`]: { status: 200, body: { id: 't3', done: false } },
    });
    await w.get(tid('cred-edit-switches-v3')).trigger('click');
    await w.get(`${tid('cred-test-address')} input`).setValue('10.0.10.2');
    await w.get(tid('cred-test-run')).trigger('click');
    await flushPromises();
    expect(w.find(tid('cred-test-running')).exists()).toBe(true);
    expect(w.find(tid('cred-test-slow')).exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(8100);
    await flushPromises();
    expect(w.get(tid('cred-test-slow')).text()).toContain('A collector older than 1.0.2');
    w.unmount();
  });

  it("asks for what is missing instead of calling, and says the server's refusal", async () => {
    const { w, calls } = await page({
      ...lists([V3]),
      [`POST ${BASE}/credential-tests`]: problem(429, 'Too many tests. Try again in a minute.'),
    });
    await w.get(tid('cred-edit-switches-v3')).trigger('click');
    await w.get(tid('cred-test-run')).trigger('click');
    expect(w.get(tid('cred-test-error')).text()).toBe('Give the address of one device to read.');
    await w.get(`${tid('cred-test-address')} input`).setValue('not an address');
    await w.get(tid('cred-test-run')).trigger('click');
    expect(w.get(tid('cred-test-error')).text()).toContain("That isn't an address");
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await w.get(`${tid('cred-test-address')} input`).setValue('10.0.10.2');
    await w.get(tid('cred-test-run')).trigger('click');
    await flushPromises();
    expect(w.get(tid('cred-test-error')).text()).toBe('Too many tests. Try again in a minute.');
  });

  it('says so when no poller has a collector', async () => {
    const none: PollerChoice[] = [
      {
        clusterId: FLEET,
        name: 'office',
        kind: 'server',
        hosts: [{ host: 'srv-3', collector: false, reporting: false }],
      },
    ];
    const { w } = await page(lists([V3], none));
    await w.get(tid('cred-edit-switches-v3')).trigger('click');
    await w.get(`${tid('cred-test-address')} input`).setValue('10.0.10.2');
    await w.get(tid('cred-test-run')).trigger('click');
    expect(w.get(tid('cred-test-error')).text()).toContain('No poller has a collector yet');
  });
});

describe('deleting a profile', () => {
  it('asks first, naming it; an unused one is deleted and leaves the selection', async () => {
    const { w, calls } = await page({
      [`GET ${BASE}/pollers`]: { status: 200, body: { pollers: POLLERS } },
      [`GET ${BASE}/credentials`]: [
        { status: 200, body: { credentials: [V3, ROS] } },
        { status: 200, body: { credentials: [V3] } },
      ],
      [`GET ${BASE}/credentials/c-ros/devices`]: { status: 200, body: { devices: [] } },
      [`DELETE ${BASE}/credentials/c-ros`]: { status: 204 },
    });
    const ticked = () =>
      w
        .findAll('[data-testid^="cred-card-"] input[type="checkbox"]')
        .filter((c) => (c.element as HTMLInputElement).checked);
    expect(ticked()).toHaveLength(2);
    await w.get(tid('cred-delete-routers')).trigger('click');
    await flushPromises();
    expect(inBody('cred-delete-name')?.textContent?.trim()).toBe('routers');
    expect(inBody('cred-delete-unused')?.textContent).toContain('No device uses it');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await click('cred-delete-confirm');
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/c-ros'))).toBe(true);
    expect(w.find(tid('cred-card-routers')).exists()).toBe(false);
    expect(ticked()).toHaveLength(1);
    expect(w.get(tid('cred-note')).text()).toBe('routers is deleted.');
    expect(inBody('cred-delete')).toBeNull();
  });

  it('cancel changes nothing', async () => {
    const { w, calls } = await page({
      ...lists([V3, ROS]),
      [`GET ${BASE}/credentials/c-ros/devices`]: { status: 200, body: { devices: [] } },
    });
    await w.get(tid('cred-delete-routers')).trigger('click');
    await flushPromises();
    await click('cred-delete-cancel');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(w.find(tid('cred-card-routers')).exists()).toBe(true);
  });

  it('one in use lists its devices and moves them to a profile of the same protocol first', async () => {
    const devices = [
      { id: 'd1', name: 'sw-core-1', address: '10.0.10.1' },
      { id: 'd2', name: 'sw-access-2', address: '10.0.10.2' },
    ];
    const { w, calls } = await page({
      [`GET ${BASE}/pollers`]: { status: 200, body: { pollers: POLLERS } },
      [`GET ${BASE}/credentials`]: [
        { status: 200, body: { credentials: [V3, V3_OTHER, ROS] } },
        { status: 200, body: { credentials: [{ ...V3, usedBy: 0 }, V3_OTHER, ROS] } },
        { status: 200, body: { credentials: [{ ...V3_OTHER, usedBy: 2 }, ROS] } },
      ],
      [`GET ${BASE}/credentials/c-v3/devices`]: { status: 200, body: { devices } },
      [`POST ${BASE}/credentials/c-v3/move`]: { status: 200, body: { moved: 2 } },
      [`DELETE ${BASE}/credentials/c-v3`]: { status: 204 },
    });
    await w.get(tid('cred-delete-switches-v3')).trigger('click');
    await flushPromises();
    expect(inBody('cred-delete-inuse')?.textContent).toContain(
      '2 devices are read with this profile',
    );
    const listed = inBody('cred-delete-devices')?.textContent ?? '';
    expect(listed).toContain('sw-core-1');
    expect(listed).toContain('10.0.10.2');
    // No way to delete it yet, and nothing to move until a profile is chosen.
    expect(inBody('cred-delete-confirm')).toBeNull();
    expect((inBody('cred-delete-move') as HTMLButtonElement).disabled).toBe(true);
    const dialog = { get: (s: string) => wrap(document.body.querySelector(s)!) };
    expect(await optionsOf(dialog, 'cred-delete-to')).toEqual(['switches-new']);
    await chooseOption(dialog, 'cred-delete-to', 'switches-new');
    await click('cred-delete-move');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ to: 'c-v3b' });
    // After the move, the delete goes through.
    expect(inBody('cred-delete-unused')).not.toBeNull();
    await click('cred-delete-confirm');
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/c-v3'))).toBe(true);
    expect(w.find(tid('cred-card-switches-v3')).exists()).toBe(false);
    expect(w.get(tid('cred-card-switches-new')).text()).toContain('2 devices');
  });

  it('with no other profile of its protocol, says to make one or edit this one', async () => {
    const { w } = await page({
      ...lists([V3, ROS]),
      [`GET ${BASE}/credentials/c-v3/devices`]: {
        status: 200,
        body: { devices: [{ id: 'd1', name: 'sw-core-1', address: '10.0.10.1' }] },
      },
    });
    await w.get(tid('cred-delete-switches-v3')).trigger('click');
    await flushPromises();
    expect(inBody('cred-delete-noother')?.textContent).toContain(
      'There is no other SNMP profile to move them to',
    );
    expect(inBody('cred-delete-to')).toBeNull();
  });

  it('a device added with it meanwhile: the refusal is said and the devices are shown', async () => {
    const { w } = await page({
      ...lists([V3, ROS]),
      [`GET ${BASE}/credentials/c-ros/devices`]: [
        { status: 200, body: { devices: [] } },
        {
          status: 200,
          body: { devices: [{ id: 'd9', name: 'gw-1', address: '10.0.0.1' }] },
        },
      ],
      [`DELETE ${BASE}/credentials/c-ros`]: problem(409, '1 device is read with this profile.'),
    });
    await w.get(tid('cred-delete-routers')).trigger('click');
    await flushPromises();
    await click('cred-delete-confirm');
    expect(inBody('cred-delete')?.textContent).toContain('1 device is read with this profile.');
    expect(inBody('cred-delete-devices')?.textContent).toContain('gw-1');
    expect(w.find(tid('cred-card-routers')).exists()).toBe(true);
  });
});

/** A DOM element with the two calls the Combobox helpers use. */
function wrap(el: Element) {
  return {
    trigger: async (event: string, opts?: object) => {
      const e =
        event === 'keydown'
          ? new KeyboardEvent('keydown', { bubbles: true, ...opts })
          : new Event(event, { bubbles: true });
      el.dispatchEvent(e);
      await flushPromises();
    },
    attributes: (name: string) => el.getAttribute(name) ?? undefined,
  };
}

describe('roles', () => {
  for (const [who, role, demo] of [
    ['a Viewer', 'viewer', false],
    ['the demo', 'owner', true],
  ] as const) {
    it(`${who} sees the profiles with their controls locked, and nothing to add`, async () => {
      const { w, calls } = await page(lists([V3, ROS]), role, '/network/add', demo);
      expect(w.get(tid('add-viewer-note')).text()).not.toBe('');
      expect(w.get(tid('cred-card-switches-v3')).text()).toContain('switches-v3');
      const locked = w.get(`${tid('cred-card-switches-v3')} ${tid('locked')}`);
      expect(locked.get('fieldset').attributes('disabled')).toBeDefined();
      await w.get(tid('cred-edit-switches-v3')).trigger('click');
      await w.get(tid('cred-delete-switches-v3')).trigger('click');
      await flushPromises();
      expect(w.find(tid('cred-form')).exists()).toBe(false);
      expect(inBody('cred-delete')).toBeNull();
      expect(w.find(tid('cred-new')).exists()).toBe(false);
      expect(w.find('[data-testid^="cred-card-"] input[type="checkbox"]').exists()).toBe(false);
      expect(w.find(tid('add-find')).exists()).toBe(false);
      expect(w.find(tid('setup-details')).exists()).toBe(false);
      expect(calls.every((c) => c.method === 'GET')).toBe(true);
    });
  }

  it('an Admin has the controls', async () => {
    const { w } = await page(lists([V3]), 'admin');
    expect(w.find(tid('locked')).exists()).toBe(false);
    expect(w.find(tid('cred-new')).exists()).toBe(true);
    expect(w.find(tid('add-viewer-note')).exists()).toBe(false);
  });
});

describe('the help section', () => {
  it('is a folded section with the protocols of the ticked profiles in its title', async () => {
    const { w } = await page(lists([V3, ROS]));
    const details = w.get(tid('setup-details'));
    expect(details.element.tagName).toBe('DETAILS');
    expect((details.element as HTMLDetailsElement).open).toBe(false);
    expect(details.get('summary').text()).toContain('SNMPv3, RouterOS');
    expect(details.get('summary').find('svg').exists()).toBe(true);
  });
});

describe('a poller that stopped being a good one', () => {
  it('says how many devices it reads and moves them all to another poller', async () => {
    const { w, calls } = await page({
      ...lists([V3]),
      [`POST ${BASE}/pollers/move`]: { status: 200, body: { moved: 3 } },
    });
    expect(w.get(tid('poller-reads-srv-1')).text()).toContain('Reads 3 devices');
    expect(w.find(tid('poller-reads-srv-2')).exists()).toBe(false);
    await w.get(tid('poller-move-srv-1')).trigger('click');
    // Itself and a server without a collector aren't places to move to.
    const offered = await optionsOf(w, 'poller-move-to');
    expect(offered.some((o) => o.includes('prod'))).toBe(true);
    expect(offered.some((o) => o.startsWith('srv-1'))).toBe(false);
    await chooseOption(w, 'poller-move-to', 'prod');
    await w.get(tid('poller-move-go')).trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      from: { clusterId: FLEET, host: 'srv-1' },
      to: { clusterId: KUBE, host: '' },
    });
  });
});

const DEVICE = {
  id: 'd1',
  name: 'gw-1',
  address: '10.0.0.1',
  kind: 'router',
  protocol: 'routeros',
  status: 'ok',
  vendor: 'MikroTik',
  model: 'RB5009',
  poller: { clusterId: FLEET, name: 'office', host: 'srv-1', kind: 'server' },
  credential: { id: 'c-ros', name: 'routers', protocol: 'routeros' },
  managedAp: false,
} as unknown as DeviceDetail['device'];

async function part(component: Component, props: object, routes: Routes, role = 'owner') {
  const m = mockFetch(routes);
  const plugins = await createPlugins('/network');
  useAuthStore().user = { ...USER, role: role as 'owner' };
  const w = mount(component, {
    props: props as never,
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  }) as VueWrapper;
  await flushPromises();
  return { w, ...m };
}

describe("a device's settings", () => {
  const routes = (): Routes => ({
    ...lists([ROS]),
    [`PATCH ${BASE}/devices/d1`]: { status: 204 },
  });

  it('corrects an address typed wrong', async () => {
    const { w, calls } = await part(DeviceSettings, { device: DEVICE }, routes());
    const save = w.get(tid('device-address-save'));
    expect(save.attributes('disabled')).toBeDefined();
    await w.get(`${tid('device-address-form')} input`).setValue('10.0.0.11');
    await w.get(tid('device-address-form')).trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ address: '10.0.0.11' });
    expect(w.emitted('changed')).toHaveLength(1);
  });

  it('says the refusal when another device is at that address', async () => {
    const { w } = await part(
      DeviceSettings,
      { device: DEVICE },
      {
        ...lists([ROS]),
        [`PATCH ${BASE}/devices/d1`]: problem(409, 'gw-2 is already at 10.0.0.2.'),
      },
    );
    await w.get(`${tid('device-address-form')} input`).setValue('10.0.0.2');
    await w.get(tid('device-address-form')).trigger('submit');
    await flushPromises();
    expect(w.get(tid('device-settings')).text()).toContain('gw-2 is already at 10.0.0.2.');
    expect(w.emitted('changed')).toBeUndefined();
  });

  it('pauses polling, and resumes a paused device', async () => {
    const a = await part(DeviceSettings, { device: DEVICE }, routes());
    await a.w.get(tid('device-pause')).trigger('click');
    await flushPromises();
    expect(a.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ paused: true });
    a.w.unmount();
    const b = await part(DeviceSettings, { device: { ...DEVICE, status: 'paused' } }, routes());
    await b.w.get(tid('device-pause')).trigger('click');
    await flushPromises();
    expect(b.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ paused: false });
  });

  it("links to the profile's form", async () => {
    const { w } = await part(DeviceSettings, { device: DEVICE }, routes());
    expect(w.get(tid('device-edit-profile')).attributes('href')).toBe('/network/add?profile=c-ros');
  });
});

describe('an accepted certificate', () => {
  const detail = (over: object) =>
    ({ device: { ...DEVICE, ...over }, ports: [], alerts: [] }) as unknown as DeviceDetail;

  it('an Owner undoes an accept made by mistake', async () => {
    const { w, calls } = await part(
      DeviceHeader,
      { detail: detail({ certUndo: true }) },
      { [`POST ${BASE}/devices/d1/restore-certificate`]: { status: 204 } },
    );
    expect(w.get(tid('cert-accepted')).text()).not.toBe('');
    await w.get(tid('cert-undo')).trigger('click');
    await flushPromises();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${BASE}/devices/d1/restore-certificate`,
    ]);
    expect(w.emitted('changed')).toHaveLength(1);
  });

  it('an Admin reads that an Owner can; without an accept there is nothing to undo', async () => {
    const admin = await part(DeviceHeader, { detail: detail({ certUndo: true }) }, {}, 'admin');
    expect(admin.w.find(tid('cert-accepted')).exists()).toBe(true);
    expect(admin.w.find(tid('cert-undo')).exists()).toBe(false);
    admin.w.unmount();
    const none = await part(DeviceHeader, { detail: detail({ certUndo: false }) }, {});
    expect(none.w.find(tid('cert-accepted')).exists()).toBe(false);
  });
});
