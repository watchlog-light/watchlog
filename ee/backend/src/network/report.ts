// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// What the poller posts each round (ee/collector/network/report.go).
export interface PortState {
  index: number;
  name: string;
  adminUp: boolean;
  operUp: boolean;
  speedMbps?: number;
  errors?: number;
}
export interface Sensor {
  name: string;
  celsius: number;
  threshold?: number;
  state?: string;
}
export interface Component {
  name: string;
  state: string;
}
export interface Optic {
  port: string;
  rxDbm?: number;
  txDbm?: number;
  rxLow?: number;
  rxHigh?: number;
  txLow?: number;
  txHigh?: number;
  celsius?: number;
}
export interface StackMember {
  number: number;
  role: string;
  state: string;
  model?: string;
  serial?: string;
}
export interface Health {
  cpu?: number;
  memUsed?: number;
  memTotal?: number;
  temperature?: number;
  sensors?: Sensor[];
  fans?: Component[];
  psus?: Component[];
  ports?: PortState[];
  optics?: Optic[];
  stack?: StackMember[];
}
export interface SystemInfo {
  name?: string;
  descr?: string;
  objectId?: string;
  uptimeS: number;
  location?: string;
  vendor?: string;
  model?: string;
  serial?: string;
  firmware?: string;
  kind?: string;
  update?: { channel?: string; installed?: string; latest?: string };
}
export interface Interface {
  index: number;
  name: string;
  descr?: string;
  alias?: string;
  kind: string;
  mac?: string;
  speedMbps?: number;
  adminUp: boolean;
  operUp: boolean;
  vlans?: number[];
  poeWatts?: number;
}
export interface Neighbour {
  localPort: string;
  protocol: string;
  remoteName?: string;
  remotePort?: string;
  remoteAddr?: string;
  remoteMac?: string;
  platform?: string;
}
export interface Inventory {
  interfaces: Interface[];
  neighbours: Neighbour[];
  macs: { port: string; mac: string; vlan?: number }[];
  arp: { mac: string; ip: string }[];
  routes?: number;
  gateway?: string;
}
export interface DeviceReport {
  id: string;
  state: 'ok' | 'unreachable' | 'auth_failed' | 'cert_changed' | 'error';
  error?: string;
  polledAt: number;
  failures?: number;
  profile?: string;
  fingerprint?: string;
  system?: SystemInfo;
  health?: Health;
  inventory?: Inventory;
}
export interface Found {
  address: string;
  name?: string;
  model?: string;
  vendor?: string;
  profile?: string;
  credential?: string;
  protocol?: string;
  answered: boolean;
  error?: string;
  viaNeighbour?: string;
}
export interface Report {
  host: string;
  devices: DeviceReport[];
  discovery?: { id: string; done: boolean; found: Found[] }[];
}
