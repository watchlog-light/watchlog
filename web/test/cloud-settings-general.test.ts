// SPDX-License-Identifier: AGPL-3.0-only
// Settings › General in Cloud: the public address, the system namespaces and who may read
// logs are the operator's settings there (the backend answers 404 to /settings/general and
// to any change, ADR-174). The tab shows the two it may read, read-only, and never asks for
// the public address; Community keeps all three editable.
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudConfig } from '@/api/cloud';
import { useAuthStore } from '@/stores/auth';
import SettingsPage from '@/views/SettingsPage.vue';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const CONFIG: CloudConfig = {
  signup: true,
  signupMode: 'public',
  providers: { github: false, google: false },
  turnstileSiteKey: null,
  passwordMinLength: 10,
  verifyGraceDays: 7,
  supportEmail: 'support@watchlog.io',
  sampleUrl: 'https://demo.watchlog.io',
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mountGeneral(cloud: boolean) {
  const plugins = await createPlugins('/settings?tab=general');
  const auth = useAuthStore();
  auth.cloud = cloud ? CONFIG : null;
  auth.loaded = true;
  auth.user = USER;
  const wrapper = mount(SettingsPage as never, {
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  await flushPromises();
  return wrapper;
}

const NAMESPACES = { system: ['kube-system'], watchlog: true };

describe('Settings › General', () => {
  it('Cloud: no public address, the namespaces and logs access read-only, no error', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/settings/namespaces': { status: 200, body: NAMESPACES },
      'GET /api/v1/settings/logs': { status: 200, body: { access: 'all' } },
      'GET /api/v1/clusters': { status: 200, body: { clusters: [] } },
    });
    const wrapper = await mountGeneral(true);
    expect(wrapper.find('[data-testid="general-settings"]').exists()).toBe(false);
    expect(calls.some((c) => c.path === '/api/v1/settings/general')).toBe(false);
    expect(wrapper.find('[data-testid="save-namespaces"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="save-logs-access"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="hide-watchlog"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('Community: the public address and both settings editable by an owner', async () => {
    mockFetch({
      'GET /api/v1/settings/general': {
        status: 200,
        body: { publicUrl: 'https://watchlog.example.com', publicUrlSource: 'settings' },
      },
      'GET /api/v1/settings/namespaces': { status: 200, body: NAMESPACES },
      'GET /api/v1/settings/logs': { status: 200, body: { access: 'all' } },
      'GET /api/v1/clusters': { status: 200, body: { clusters: [] } },
    });
    const wrapper = await mountGeneral(false);
    expect(wrapper.find('[data-testid="general-settings"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="save-namespaces"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="save-logs-access"]').exists()).toBe(true);
  });
});
