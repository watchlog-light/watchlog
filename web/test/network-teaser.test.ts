// SPDX-License-Identifier: AGPL-3.0-only
// Network devices where they are off (ADR-233): the teaser in Community without a key and in
// Cloud Free, with its picture, three lines and the edition's link, asking nothing of the
// network API; and when they are on (Cloud Pro, the demo, a licence with `network`).
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NetworkTeaser from '@/components/network/NetworkTeaser.vue';
import NetworkPortLine from '@/components/network/NetworkPortLine.vue';
import { networkOn, portLine } from '@/lib/network';
import { useAuthStore } from '@/stores/auth';
import { createPlugins } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('networkOn', () => {
  it('is on in Cloud Pro, the demo and with a licence listing network', () => {
    const base = { isCloud: false, demo: false, proFeatures: null, licenseFeatures: null };
    expect(networkOn(base)).toBe(false);
    expect(networkOn({ ...base, licenseFeatures: ['pro'] })).toBe(false);
    expect(networkOn({ ...base, licenseFeatures: ['network'] })).toBe(true);
    expect(networkOn({ ...base, demo: true })).toBe(true);
    expect(networkOn({ ...base, isCloud: true, proFeatures: false })).toBe(false);
    expect(networkOn({ ...base, isCloud: true, proFeatures: true })).toBe(true);
    expect(portLine({ device: 'sw-access-2', port: 'Gi1/0/14', speed: '1 Gb/s' })).toBe(
      'sw-access-2 · Gi1/0/14 · 1 Gb/s',
    );
  });
});

describe('the teaser', () => {
  for (const cloud of [false, true]) {
    it(`${cloud ? 'Cloud Free' : 'Community'}: the picture, three lines, the edition's link`, async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const { router, i18n, pinia } = await createPlugins('/');
      if (cloud) useAuthStore().cloud = { signup: true } as never;
      const w = mount(NetworkTeaser, { global: { plugins: [router, i18n, pinia] } });
      await flushPromises();
      expect(w.find('[data-testid="network-teaser-picture"]').exists()).toBe(true);
      expect(w.findAll('li')).toHaveLength(3);
      expect(w.text()).toContain('Available in Pro and Enterprise');
      expect(
        w.find(`[data-testid="network-teaser-${cloud ? 'upgrade' : 'contact'}"]`).exists(),
      ).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it('the port line asks nothing where network devices are off', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { router, i18n, pinia } = await createPlugins('/');
    const w = mount(NetworkPortLine, {
      props: { clusterId: '01a1d459-7a5b-7519-b0e7-f1cac2729b3a', node: 'web-1' },
      global: { plugins: [router, i18n, pinia] },
    });
    await flushPromises();
    expect(fetch).not.toHaveBeenCalled();
    expect(w.find('[data-testid="network-port-line"]').exists()).toBe(false);
  });
});
