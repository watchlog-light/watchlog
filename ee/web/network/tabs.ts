// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The network section's tabs (ADR-233), data-driven: Overview, Map and Devices here; the next
// release registers Wireless and Storage the same way, each shown only when it has devices.
import { reactive } from 'vue';

export interface NetworkTab {
  /** The route's name. */
  route: string;
  titleKey: string;
  order: number;
  /** A count beside the title (Devices: how many), from GET /network/kinds. */
  count?: (s: TabCounts) => number | null;
  /** Shown only when this says so (a tab for a kind of device the network has). */
  shown?: (s: TabCounts) => boolean;
}

export interface TabCounts {
  devices: number;
  kinds: Record<string, number>;
  wifiClients: number;
}

export const networkTabs = reactive<NetworkTab[]>([]);

export function registerNetworkTab(t: NetworkTab): void {
  if (networkTabs.some((x) => x.route === t.route)) return;
  networkTabs.push(t);
  networkTabs.sort((a, b) => a.order - b.order);
}

registerNetworkTab({ route: 'network', titleKey: 'net.tabs.overview', order: 10 });
registerNetworkTab({ route: 'network-map', titleKey: 'net.tabs.map', order: 20 });
registerNetworkTab({
  route: 'network-devices',
  titleKey: 'net.tabs.devices',
  order: 30,
  count: (s) => s.devices,
});
// 0.17 (ADR-234): shown only where the network has access points, or recorders, a NAS or a UPS.
registerNetworkTab({
  route: 'network-wireless',
  titleKey: 'netWifi.tab',
  order: 40,
  shown: (s) => (s.kinds.ap ?? 0) > 0,
  count: (s) => s.wifiClients,
});
const STORAGE_KINDS = ['nvr', 'nas', 'ups'];
registerNetworkTab({
  route: 'network-storage',
  titleKey: 'netStorage.tab',
  order: 50,
  shown: (s) => STORAGE_KINDS.some((k) => (s.kinds[k] ?? 0) > 0),
  count: (s) => STORAGE_KINDS.reduce((n, k) => n + (s.kinds[k] ?? 0), 0),
});
