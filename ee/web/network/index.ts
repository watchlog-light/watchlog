// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The network module's pages (ADR-233), under the core's "Network" sidebar item: Overview, Map,
// Devices, a device, and adding devices. Behind the `network` feature (EeGate): Cloud Free and
// Community without a key see the core's teaser instead.
import { defineAsyncComponent } from 'vue';
import type { EeWebModule } from '../../../web/src/ee/contract';
import './tabs';

const page = (load: () => Promise<{ default: unknown }>) =>
  defineAsyncComponent(load as Parameters<typeof defineAsyncComponent>[0]);

export const eeWebModule: EeWebModule = {
  name: 'network',
  feature: 'network',
  routes: [
    {
      name: 'network',
      path: 'network',
      component: page(() => import('./pages/OverviewPage.vue')),
      meta: { titleKey: 'nav.network' },
    },
    {
      name: 'network-map',
      path: 'network/map',
      component: page(() => import('./pages/MapPage.vue')),
      meta: { titleKey: 'net.tabs.map' },
    },
    {
      name: 'network-devices',
      path: 'network/devices',
      component: page(() => import('./pages/DevicesPage.vue')),
      meta: { titleKey: 'net.tabs.devices' },
    },
    {
      name: 'network-device',
      path: 'network/devices/:id',
      component: page(() => import('./pages/DevicePage.vue')),
      meta: { titleKey: 'net.device.title' },
    },
    {
      name: 'network-add',
      path: 'network/add',
      component: page(() => import('./pages/AddPage.vue')),
      meta: { titleKey: 'net.add.title' },
    },
  ],
};
