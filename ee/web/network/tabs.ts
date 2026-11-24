// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The network section's tabs (ADR-233), data-driven: Overview, Map and Devices here; the next
// release registers Wireless and Storage the same way, each shown only when it has devices.
import { reactive } from 'vue';

export interface NetworkTab {
  /** The route's name. */
  route: string;
  titleKey: string;
  order: number;
  /** A count beside the title (Devices: how many), from the summary. */
  count?: (s: { devices: number }) => number | null;
  /** Shown only when this says so (a tab for a kind of device the network has). */
  shown?: (s: { kinds: string[] }) => boolean;
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
