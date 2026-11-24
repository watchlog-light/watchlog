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
  /** The device's own address, for the switch port it is behind (0.17). */
  mac?: string;
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
  wireless?: Wireless;
  nas?: NAS;
  recorder?: Recorder;
  ups?: UPS;
}

// 0.17 (ADR-234): CAPsMAN, a NAS, a recorder, a UPS.
export interface Radio {
  interface: string;
  ssid?: string;
  band?: string;
  channel?: number;
  frequencyMhz?: number;
  txPowerDbm?: number;
  noiseDbm?: number;
  clients: number;
  running: boolean;
}
export interface AP {
  name: string;
  mac?: string;
  address?: string;
  model?: string;
  serial?: string;
  version?: string;
  state: string;
  uptimeS?: number;
  generation: string;
  radios: Radio[];
}
export interface WifiClient {
  mac: string;
  ap: string;
  interface?: string;
  ssid?: string;
  band?: string;
  signalDbm?: number;
  txRate?: string;
  rxRate?: string;
  uptimeS?: number;
  bytesTx?: number;
  bytesRx?: number;
}
export interface MeshLink {
  from: string;
  to: string;
  signalDbm?: number;
  rate?: string;
}
export interface Wireless {
  generations: string[];
  aps: AP[];
  clients: WifiClient[];
  mesh?: MeshLink[];
}
export interface Disk {
  index: number;
  name?: string;
  model?: string;
  capacity?: number;
  celsius?: number;
  smart: string;
  status: string;
}
export interface Volume {
  name: string;
  total: number;
  free: number;
  status: string;
  raid?: string;
}
export interface LUN {
  name: string;
  capacity: number;
  usedPercent?: number;
  status?: string;
  mapped: boolean;
}
export interface ISCSITarget {
  name: string;
  iqn?: string;
  connected: boolean;
  status?: string;
}
export interface NAS {
  disks: Disk[];
  volumes: Volume[];
  pools?: Volume[];
  luns: LUN[];
  targets?: ISCSITarget[];
}
export interface RecorderDisk {
  name: string;
  iscsi: boolean;
  state: string;
  healthy: boolean;
  total: number;
  used: number;
}
export interface Camera {
  channel: number;
  name?: string;
  online: boolean;
}
export interface RecorderEvent {
  code: string;
  action: string;
  index: number;
  at: number;
}
export interface Recorder {
  disks: RecorderDisk[];
  cameras: Camera[];
  events?: RecorderEvent[];
  active?: RecorderEvent[];
  stream: boolean;
}
export interface UPS {
  status: string;
  chargePercent?: number;
  runtimeS?: number;
  loadPercent?: number;
  inputVolts?: number;
  outputVolts?: number;
  celsius?: number;
  replaceBattery: boolean;
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
