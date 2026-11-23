// SPDX-License-Identifier: AGPL-3.0-only
// The Enterprise licence in the dashboard (ADR-232): Settings › License in each state (valid,
// ending, in grace, ended, over the limit, none, from the environment), pasting a key, the
// Owners' banner, the About line, the tab only for self-hosted Owners, What changed on a
// licensed install and once the licence ended, and the ee/ web loader with its gate.
import type { LicenseSummary, LicenseView } from '@watchlog/api-types';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import type { CloudConfig } from '@/api/cloud';
import LicenseBanner from '@/components/license/LicenseBanner.vue';
import LicenseSettings from '@/components/settings/LicenseSettings.vue';
import EeGate from '@/ee/EeGate.vue';
import { eeRoutes, modulesOf } from '@/ee';
import { createAppI18n } from '@/i18n';
import { aboutLine, bannerText, featureNames, unitParts } from '@/lib/license';
import { useAuthStore } from '@/stores/auth';
import SettingsPage from '@/views/SettingsPage.vue';
import WhatChangedPage from '@/views/WhatChangedPage.vue';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const NOW = Date.UTC(2027, 4, 20, 10, 0, 0);
const i18n = createAppI18n();
const t = i18n.global.t as unknown as (
  k: string,
  v?: Record<string, unknown>,
  n?: number,
) => string;

let mounted: VueWrapper | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function view(over: Partial<LicenseView> = {}): LicenseView {
  return {
    source: 'setting',
    shadowed: false,
    fileError: null,
    state: 'valid',
    reason: 'valid until 2027-12-31',
    license: {
      id: '7b0c2b9e-4b1f-4d7c-9a51-1f2e3d4c5b6a',
      customer: 'Acme',
      edition: 'enterprise',
      units: 50,
      features: ['pro', 'network'],
      issuedAt: '2026-12-31T00:00:00.000Z',
      expiresAt: '2027-12-31T23:59:59.000Z',
      graceEndsAt: '2028-01-14T23:59:59.000Z',
    },
    units: {
      used: 42,
      limit: 50,
      over: false,
      overSince: null,
      overDays: 0,
      closedSince: null,
      parts: { nodes: 30, servers: 12 },
    },
    banners: [],
    ...over,
  };
}
const summary = (over: Partial<LicenseSummary> = {}): LicenseSummary => ({
  edition: 'enterprise',
  licensed: true,
  pro: true,
  features: ['pro', 'network'],
  endedOn: null,
  customer: 'Acme',
  banners: [],
  ...over,
});

async function open(
  component: object,
  path = '/',
  role: 'owner' | 'viewer' = 'owner',
  cloud = false,
) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const plugins = await createPlugins(path);
  const auth = useAuthStore();
  auth.user = { ...USER, role };
  auth.cloud = cloud ? ({ signup: true } as CloudConfig) : null;
  const w = mount(component, {
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  mounted = w;
  await flushPromises();
  return { w, auth, plugins };
}

describe('the words', () => {
  it('banners, the About line, features and units', () => {
    expect(bannerText({ kind: 'over', used: 58, limit: 50, closedSince: null }, t)).toBe(
      '58 of 50 units. Your licence covers 50; contact us for a larger one.',
    );
    expect(bannerText({ kind: 'expiring', endsOn: '2027-06-01', days: 12 }, t)).toBe(
      'Your licence ends on 1 Jun 2027, in 12 days.',
    );
    expect(bannerText({ kind: 'grace', endedOn: '2027-05-17', stopsOn: '2027-05-31' }, t)).toBe(
      'Your licence ended on 17 May 2027. Licensed features stop on 31 May 2027.',
    );
    expect(bannerText({ kind: 'ended', endedOn: '2027-04-30' }, t)).toMatch(
      /^Your licence ended on 30 Apr 2027\./,
    );
    const about = (license: LicenseSummary | null, isCloud = false) =>
      aboutLine({ isCloud, demo: false, license }, t);
    expect(about(null)).toBe('WatchLog Community');
    expect(about(summary())).toBe('WatchLog Enterprise, licensed to Acme');
    expect(about(summary({ customer: null }))).toBe('WatchLog Enterprise');
    expect(about(null, true)).toBe('WatchLog Cloud');
    expect(featureNames(['pro', 'network', 'sso'], t)).toEqual([
      'Pro features',
      'Network devices',
      'sso',
    ]);
    expect(unitParts({ nodes: 1, servers: 12 }, t)).toBe('1 node, 12 servers');
  });
});

describe('Settings › License', () => {
  const states: [string, Partial<LicenseView>, RegExp][] = [
    ['valid', {}, /on until 31 Dec 2027/],
    ['expiring', { state: 'expiring' }, /Ask us for a new key/],
    ['grace', { state: 'grace' }, /keep working until 14 Jan 2028/],
    ['expired', { state: 'expired' }, /nothing was deleted/],
  ];
  for (const [name, over, text] of states) {
    it(`${name}: the facts and the state in words`, async () => {
      mockFetch({ 'GET /api/v1/license': { status: 200, body: view(over) } });
      const { w } = await open(LicenseSettings);
      expect(w.get('[data-testid="license-state"]').attributes('data-state')).toBe(
        over.state ?? 'valid',
      );
      expect(w.get('[data-testid="license-state-text"]').text()).toMatch(text);
      expect(w.get('[data-testid="license-customer"]').text()).toBe('Acme');
      expect(w.get('[data-testid="license-units"]').text()).toContain('42 of 50 units');
      expect(w.get('[data-testid="license-units"]').text()).toContain('30 nodes, 12 servers');
      expect(w.get('[data-testid="license-features"]').text()).toContain('Network devices');
      expect(w.get('[data-testid="license-id"]').text()).toBe(
        '7b0c2b9e-4b1f-4d7c-9a51-1f2e3d4c5b6a',
      );
      expect(w.get('[data-testid="license-source"]').text()).toBe('Pasted here');
      expect(w.find('[data-testid="license-remove"]').exists()).toBe(true);
    });
  }

  it('over the limit: used of allowed, the rule', async () => {
    mockFetch({
      'GET /api/v1/license': {
        status: 200,
        body: view({
          units: {
            used: 58,
            limit: 50,
            over: true,
            overSince: '2027-05-18',
            overDays: 3,
            closedSince: null,
            parts: { nodes: 48, servers: 10 },
          },
        }),
      },
    });
    const { w } = await open(LicenseSettings);
    expect(w.get('[data-testid="license-over"]').text()).toContain(
      '58 of 50 units. Your licence covers 50; contact us for a larger one.',
    );
    expect(w.get('[data-testid="license-over"]').text()).toContain('After 30 days over the limit');
  });

  it('none: Community in words, and a place to paste a key; a bad key says why', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/license': {
        status: 200,
        body: view({
          source: 'none',
          state: 'none',
          license: null,
          units: null,
          reason: 'no licence key',
        }),
      },
      'PUT /api/v1/license': [
        {
          status: 422,
          body: {
            type: 'about:blank',
            title: 'x',
            status: 422,
            detail: "This isn't a working licence key: the signature doesn't match a WatchLog key.",
            state: 'invalid',
          },
        },
        { status: 200, body: view() },
      ],
      'GET /api/v1/license/summary': { status: 200, body: summary() },
    });
    const { w, auth } = await open(LicenseSettings);
    expect(w.get('[data-testid="license-state-text"]').text()).toMatch(
      /This is WatchLog Community/,
    );
    expect(w.find('[data-testid="license-facts"]').exists()).toBe(false);
    await w.get('[data-testid="license-key"]').setValue('wl1.bad.key');
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(w.get('[data-testid="license-error"]').text()).toContain("signature doesn't match");
    await w.get('[data-testid="license-key"]').setValue('  wl1.good.key \n');
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { key: 'wl1.bad.key' },
      { key: 'wl1.good.key' },
    ]);
    expect(w.get('[data-testid="license-customer"]').text()).toBe('Acme');
    expect(auth.license?.pro).toBe(true);
  });

  it('from the environment: no paste form, and it says where to change it', async () => {
    mockFetch({
      'GET /api/v1/license': { status: 200, body: view({ source: 'env', shadowed: true }) },
    });
    const { w } = await open(LicenseSettings);
    expect(w.find('form').exists()).toBe(false);
    expect(w.get('[data-testid="license-from-env"]').text()).toContain('WATCHLOG_LICENSE');
    expect(w.get('[data-testid="license-from-env"]').text()).toContain("the environment's wins");
    expect(w.get('[data-testid="license-source"]').text()).toBe(
      'The environment (WATCHLOG_LICENSE)',
    );
  });

  it('the tab: self-hosted Owners only', async () => {
    mockFetch({ 'GET /api/v1/license': { status: 200, body: view() } });
    const tabs = async (role: 'owner' | 'viewer', cloud: boolean) => {
      mounted?.unmount();
      const { w } = await open(SettingsPage, '/settings', role, cloud);
      return w.find('[data-testid="settings-tab-license"]').exists();
    };
    expect(await tabs('owner', false)).toBe(true);
    expect(await tabs('viewer', false)).toBe(false);
  });
});

describe('the banner', () => {
  it('Owners see the most pressing one, with the way to Settings › License; others nothing', async () => {
    const banners = [{ kind: 'over' as const, used: 58, limit: 50, closedSince: null }];
    const { w, auth } = await open(LicenseBanner);
    auth.license = summary({ banners });
    await flushPromises();
    expect(w.get('[data-testid="license-banner"]').attributes('data-kind')).toBe('over');
    expect(w.text()).toContain('58 of 50 units.');
    auth.user = { ...USER, role: 'viewer' };
    await flushPromises();
    expect(w.find('[data-testid="license-banner"]').exists()).toBe(false);
  });
});

describe('What changed on a licensed install', () => {
  it('a licence with pro: the page asks the server; once it ended, "Your licence ended on …"', async () => {
    const cluster = {
      id: '01a1b869-739a-7082-aa66-1f7ce7fcbc32',
      name: 'kind',
      kind: 'kubernetes',
      status: 'active',
      nodeCount: 1,
      lastSeenAt: null,
      createdAt: '2027-01-01T00:00:00.000Z',
    };
    const { calls } = mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [cluster] } },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const plugins = await createPlugins(`/what-changed?cluster=${cluster.id}`);
    const auth = useAuthStore();
    auth.user = { ...USER, role: 'viewer' };
    auth.license = summary({ pro: false, licensed: false, endedOn: '2027-05-01', features: [] });
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [cluster] } },
      [`GET /api/v1/what-changed?cluster=${cluster.id}`]: {
        status: 403,
        body: {
          type: 'urn:watchlog:problem:license-ended',
          title: 'Forbidden',
          status: 403,
          detail: 'Your licence ended on 2027-05-01.',
        },
      },
    });
    const w = mount(WhatChangedPage, {
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    mounted = w;
    await flushPromises();
    expect(w.get('[data-testid="license-ended"]').text()).toContain(
      'Your licence ended on 2027-05-01',
    );
    expect(w.text()).toContain('Ask an Owner');
    expect(w.find('[data-testid="wc-upgrade"]').exists()).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('ee/ in the dashboard', () => {
  const Page = defineComponent({
    render: () => h('p', { 'data-testid': 'ee-page' }, 'module page'),
  });
  const mod = {
    name: 'widgets',
    feature: 'widgets',
    routes: [{ name: 'ee-widgets', path: 'ee/widgets', component: Page }],
  };

  it('finds modules that export eeWebModule, nothing else', () => {
    expect(
      modulesOf({ a: { eeWebModule: mod }, b: {}, c: { eeWebModule: { name: 'x' } as never } }),
    ).toEqual([mod]);
    expect(modulesOf({})).toEqual([]);
  });

  it('wraps each route in the licence gate', () => {
    const [r] = eeRoutes([mod]);
    expect(r!.component).toBe(EeGate);
    expect(r!.meta).toMatchObject({ eeFeature: 'widgets' });
    expect(r!.props).toEqual({ feature: 'widgets', page: Page });
  });

  it('the gate: the teaser without the feature, the page with it', async () => {
    const plugins = await createPlugins('/');
    const auth = useAuthStore();
    auth.user = USER;
    auth.license = summary({ features: ['pro'] });
    const w = mount(EeGate, {
      props: { feature: 'widgets', page: Page },
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    mounted = w;
    expect(w.find('[data-testid="ee-teaser"]').exists()).toBe(true);
    auth.license = summary({ features: ['pro', 'widgets'] });
    await flushPromises();
    expect(w.find('[data-testid="ee-page"]').exists()).toBe(true);
  });
});
