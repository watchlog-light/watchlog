// SPDX-License-Identifier: AGPL-3.0-only
// Cloud's data rights in the dashboard (ADR-181): Settings › Data (the exports as plain
// downloads, the deletion with its typed confirmation and Undo) and the org status banner
// over every page (deletion with Undo for Owners, inactivity warning, suspension with
// Reactivate for Owners, a staff suspension with its reason).
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudConfig, OrgStatus } from '@/api/cloud';
import OrgStatusBanner from '@/components/cloud/OrgStatusBanner.vue';
import DataSettings from '@/components/settings/DataSettings.vue';
import { useAuthStore } from '@/stores/auth';
import { useOrgStatusStore } from '@/stores/orgStatus';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const CONFIG: CloudConfig = {
  signup: true,
  providers: { github: false, google: false },
  turnstileSiteKey: null,
  passwordMinLength: 10,
  verifyGraceDays: 7,
  supportEmail: 'support@watchlog.io',
  sampleUrl: 'https://demo.watchlog.io',
};
const OWNER = { ...USER, org: { ...USER.org, name: 'Acme', plan: 'free' as const } };
const CLUSTERS = [
  { id: '01a1d6f3-0000-7000-8000-0000000000c1', name: 'prod-eu', kind: 'kubernetes' },
  { id: '01a1d6f3-0000-7000-8000-0000000000c2', name: 'edge', kind: 'docker' },
].map((c) => ({
  ...c,
  status: 'active',
  nodeCount: 3,
  agentVersion: 'dev',
  firstSeenAt: null,
  lastSeenAt: null,
  createdAt: '2026-11-01T12:00:00.000Z',
  ingestFailure: null,
}));
const ACTIVE: OrgStatus = { deletion: null, suspension: null, inactivity: null, lastDataAt: null };
const DUE = '2026-11-21T10:00:00.000Z';
const DELETING: OrgStatus = {
  ...ACTIVE,
  deletion: { requestedAt: '2026-11-14T10:00:00.000Z', dueAt: DUE, requestedBy: 'Ada Admin' },
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mountWith(component: unknown, role: 'owner' | 'viewer', status?: OrgStatus) {
  const plugins = await createPlugins('/settings?tab=data');
  const auth = useAuthStore();
  auth.cloud = CONFIG;
  auth.loaded = true;
  auth.user = { ...OWNER, role };
  if (status) useOrgStatusStore().set(status);
  const wrapper = mount(component as never, {
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  await flushPromises();
  return wrapper;
}

describe('Settings › Data', () => {
  it('offers both exports as downloads, scoped to the chosen cluster and range', async () => {
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: CLUSTERS } },
      'GET /api/v1/org/status': { status: 200, body: ACTIVE },
    });
    const w = await mountWith(DataSettings, 'owner');
    const config = w.get('[data-testid="export-config"]');
    expect(config.attributes('href')).toBe('/api/v1/org/export');
    expect(config.attributes('download')).toBeDefined();
    const metrics = () => w.get('[data-testid="export-metrics"]').attributes('href')!;
    const range = (href: string) => {
      const q = new URL(href, 'http://x').searchParams;
      return Number(q.get('to')) - Number(q.get('from'));
    };
    expect(metrics()).toMatch(new RegExp(`^/api/v1/clusters/${CLUSTERS[0]!.id}/export\\?from=`));
    expect(range(metrics())).toBe(86_400);
    await w.get('[data-testid="export-range-30d"]').trigger('click');
    expect(range(metrics())).toBe(30 * 86_400);
    expect(w.text()).toContain('Secrets are left out');
  });

  it('asks for the org name before deleting, then shows the day and Undo', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: CLUSTERS } },
      'GET /api/v1/org/status': { status: 200, body: ACTIVE },
      'POST /api/v1/org/deletion': { status: 202, body: DELETING },
      'DELETE /api/v1/org/deletion': { status: 200, body: ACTIVE },
    });
    const w = await mountWith(DataSettings, 'owner');
    const submit = () => w.get('[data-testid="deletion-submit"]');
    expect(submit().attributes('disabled')).toBeDefined();
    await w.get('[data-testid="deletion-confirm"] input').setValue('acme');
    expect(submit().attributes('disabled')).toBeDefined();
    await w.get('[data-testid="deletion-confirm"] input').setValue('Acme');
    expect(submit().attributes('disabled')).toBeUndefined();
    await w.get('[data-testid="deletion-form"]').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/v1/org/deletion',
      body: { confirm: 'Acme' },
    });
    const scheduled = w.get('[data-testid="deletion-scheduled"]').text();
    expect(scheduled).toContain('Ada Admin asked to delete this organization');
    expect(scheduled).toContain('November 21, 2026');
    await w.get('[data-testid="deletion-undo"]').trigger('click');
    await flushPromises();
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/v1/org/deletion' });
    expect(w.find('[data-testid="deletion-scheduled"]').exists()).toBe(false);
    expect(w.find('[data-testid="deletion-form"]').exists()).toBe(true);
  });

  it('shows the words, not the controls, to members who are not Owners', async () => {
    mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: CLUSTERS } },
      'GET /api/v1/org/status': { status: 200, body: DELETING },
    });
    const w = await mountWith(DataSettings, 'viewer');
    expect(w.find('[data-testid="data-owners-only"]').exists()).toBe(true);
    expect(w.find('[data-testid="export-config"]').exists()).toBe(false);
    expect(w.find('[data-testid="deletion-form"]').exists()).toBe(false);
    expect(w.find('[data-testid="deletion-undo"]').exists()).toBe(false);
    expect(w.find('[data-testid="deletion-scheduled"]').exists()).toBe(true);
  });
});

describe('the org status banner', () => {
  it('deletion: the day, and Undo for Owners', async () => {
    const { calls } = mockFetch({ 'DELETE /api/v1/org/deletion': { status: 200, body: ACTIVE } });
    const w = await mountWith(OrgStatusBanner, 'owner', DELETING);
    const banner = w.get('[data-testid="org-status-banner-deletion"]');
    expect(banner.text()).toContain('Acme will be deleted on November 21');
    expect(banner.text()).toContain('data isn’t stored meanwhile');
    await w.get('[data-testid="org-status-action"]').trigger('click');
    await flushPromises();
    expect(calls).toEqual([{ method: 'DELETE', path: '/api/v1/org/deletion', body: undefined }]);
    expect(w.find('[data-testid="org-status-banner-deletion"]').exists()).toBe(false);
  });

  it('deletion: no Undo for a viewer, who is told an Owner can', async () => {
    const w = await mountWith(OrgStatusBanner, 'viewer', DELETING);
    expect(w.text()).toContain('An Owner can undo it.');
    expect(w.find('[data-testid="org-status-action"]').exists()).toBe(false);
  });

  it('inactivity: the day it will be suspended', async () => {
    const w = await mountWith(OrgStatusBanner, 'owner', {
      ...ACTIVE,
      inactivity: { warnedAt: '2026-11-14T10:00:00.000Z', suspendsAt: DUE },
    });
    expect(w.get('[data-testid="org-status-banner-warning"]').text()).toContain(
      'Acme has received no data for 30 days. It will be suspended on November 21 unless an agent sends data.',
    );
    expect(w.find('[data-testid="org-status-action"]').exists()).toBe(false);
  });

  it('suspended for inactivity: Owners reactivate it', async () => {
    const { calls } = mockFetch({ 'POST /api/v1/org/reactivate': { status: 200, body: ACTIVE } });
    const w = await mountWith(OrgStatusBanner, 'owner', {
      ...ACTIVE,
      suspension: { at: DUE, kind: 'inactive', reason: 'No data for 38 days' },
    });
    expect(w.get('[data-testid="org-status-banner-inactive"]').text()).toContain(
      'Acme is suspended',
    );
    await w.get('[data-testid="org-status-action"]').trigger('click');
    await flushPromises();
    expect(calls).toEqual([{ method: 'POST', path: '/api/v1/org/reactivate', body: undefined }]);
  });

  it('suspended by staff: the reason, and no button', async () => {
    const w = await mountWith(OrgStatusBanner, 'owner', {
      ...ACTIVE,
      suspension: { at: DUE, kind: 'staff', reason: 'unpaid invoice' },
    });
    expect(w.get('[data-testid="org-status-banner-staff"]').text()).toContain(
      'WatchLog suspended Acme: unpaid invoice.',
    );
    expect(w.find('[data-testid="org-status-action"]').exists()).toBe(false);
  });

  it('nothing to say: no banner', async () => {
    const w = await mountWith(OrgStatusBanner, 'owner', ACTIVE);
    expect(w.find('[role="region"]').exists()).toBe(false);
  });
});
