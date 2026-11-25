// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The network API's answers (ee/backend/src/network/routes.ts, ADR-233), as the pages read them.
import { api } from '@/api/client';

export type DeviceStatus =
  | 'pending'
  | 'ok'
  | 'unreachable'
  | 'auth_failed'
  | 'cert_changed'
  | 'error'
  // An access point CAPsMAN no longer runs, or whose provisioning failed (0.17).
  | 'disconnected'
  | 'provisioning';
export type DeviceKind =
  'router' | 'l3switch' | 'switch' | 'ap' | 'nas' | 'nvr' | 'ups' | 'firewall' | 'other';

export interface Poller {
  clusterId: string;
  name: string;
  kind: 'kubernetes' | 'server';
  host: string;
}

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  vendor: string;
  model: string;
  serial: string;
  firmware: string;
  address: string;
  protocol: 'snmp' | 'routeros' | 'dahua' | 'capsman';
  profile: string | null;
  status: DeviceStatus;
  error: string | null;
  uptimeS: number | null;
  polledAt: string | null;
  /** 0..1 */
  cpu: number | null;
  /** 0..1 */
  memory: number | null;
  temperature: number | null;
  portsUp: number | null;
  portsTotal: number | null;
  update: { channel?: string; installed?: string; latest?: string } | null;
  managedAp: boolean;
  /** An access point's controller (CAPsMAN), 0.17. */
  parentId: string | null;
  poller: Poller;
  openAlerts: number;
}

export interface Attention {
  alertId: string;
  severity: 'warning' | 'critical';
  what: string;
  why: string | null;
  where: string;
  deviceId: string;
  port: string | null;
  since: string;
}

export interface Summary {
  tiles: {
    devices: number;
    up: number;
    down: number;
    pending: number;
    portsWithProblems: number;
    busyLinks: number;
    links: number;
    oldestFirmware: { deviceId: string; name: string; firmware: string } | null;
  };
  attention: Attention[];
  devices: Device[];
  /** How many devices of each kind (0.17: the Wireless and Storage tabs). */
  kinds: Record<string, number>;
  wifiClients: number;
  /** The Recording card: one line per recorder. */
  recording: RecordingLine[];
}

export interface Kinds {
  kinds: Record<string, number>;
  devices: number;
  wifiClients: number;
}

export interface LinkEnd {
  deviceId: string;
  port: string;
}

export interface Link {
  id: string;
  a: LinkEnd;
  b: LinkEnd;
  /** cdp, lldp, mndp, mac */
  via: string[];
  speedMbps: number | null;
  /** bits per second, A → B and B → A; null when unknown */
  bpsAB: number | null;
  bpsBA: number | null;
  /** the busier direction against the speed, 0..1 */
  utilisation: number | null;
  errors: boolean;
  state: 'ok' | 'warn' | 'down';
  lastSeen: string;
}

export interface NodeRef {
  clusterId: string;
  cluster: string;
  kind: 'kubernetes' | 'server';
  name: string;
}

export interface Endpoint {
  mac: string;
  ip: string | null;
  vendor: string;
  deviceId: string;
  port: string;
  /** Its switch port's link; null when unknown. */
  portUp?: boolean | null;
  /** The WatchLog server (fleet) or node (Kubernetes) it is. */
  node: NodeRef | null;
}

export interface MapData {
  devices: (Device & { gateway: string | null })[];
  links: Link[];
  endpoints: Endpoint[];
  /** Positions an Owner or Admin dragged, by map node id. */
  layout: Record<string, { x: number; y: number }>;
  /** Wireless backhaul between access points (mesh or WDS): dotted links. */
  mesh: { fromId: string; toId: string; signalDbm: number | null; rate: string }[];
  /** iSCSI sessions and the path of links between the recorder and its NAS. */
  iscsi: {
    recorderId: string;
    nasId: string;
    disk: string;
    lun: string;
    connected: boolean;
    path: { devices: string[]; links: string[] } | null;
  }[];
}

export interface Port {
  index: number;
  name: string;
  descr: string;
  alias: string;
  /** ethernet, sfp, lag, vlan, virtual, wireless, other */
  kind: string;
  speedMbps: number | null;
  usualSpeedMbps: number | null;
  adminUp: boolean;
  operUp: boolean;
  vlans: number[];
  poeWatts: number | null;
  errorsRising: boolean;
  changedAt: string | null;
  neighbour: { deviceId: string; device: string; port: string; linkId: string } | null;
}

export interface DeviceDetail {
  device: Device & {
    sysName: string;
    parentName: string | null;
    location: string;
    credential: { id: string; name: string; protocol: string } | null;
    certificate: { pinned: string | null; seen: string | null } | null;
    routes: number | null;
    gateway: string | null;
    firstSeen: string;
    lastSeen: string | null;
  };
  /** What the device's kind reports instead of CPU, memory and ports (0.17.1). */
  kind: {
    ap?: { clients: number; weak: number; weakDbm: number; radios: Radio[]; generation: string };
    ups?: UpsCard['ups'];
    recorder?: {
      recording: boolean | null;
      camerasOnline: number;
      camerasTotal: number;
      daysLeft: number | null;
      full: boolean;
    };
  };
  health: {
    sensors: { name: string; celsius: number; threshold?: number; state?: string }[];
    fans: { name: string; state: string }[];
    psus: { name: string; state: string }[];
    optics: {
      port: string;
      rxDbm?: number;
      txDbm?: number;
      rxLow?: number;
      rxHigh?: number;
      txLow?: number;
      txHigh?: number;
      celsius?: number;
    }[];
    stack: { number: number; role: string; state: string; model?: string; serial?: string }[];
    stackExpected: number;
  };
  ports: Port[];
  endpoints: (Omit<Endpoint, 'deviceId'> & { vlan: number | null; lastSeen: string })[];
  links: Link[];
  events: {
    port: string;
    reason: string;
    severity: 'info' | 'warning' | 'critical';
    message: string;
    at: string;
  }[];
  alerts: Attention[];
}

export type Points = [number, number | null][];
export interface DeviceSeries {
  range: number;
  step: number;
  cpu: Points;
  memory: Points;
  temperature: Points;
  /** The kind's own series: an AP's `clients`; a UPS's `charge`, `runtime`, `load`; a recorder's `camerasOnline`. */
  kind?: Record<string, Points>;
  port: { name: string; inBps: Points; outBps: Points; errors: Points; discards: Points } | null;
}

export interface PollerChoice {
  clusterId: string;
  name: string;
  kind: 'kubernetes' | 'server';
  hosts: { host: string; collector: boolean; reporting: boolean }[];
}

export interface Credential {
  id: string;
  name: string;
  protocol: 'snmp' | 'routeros' | 'dahua';
  settings: {
    version?: '3' | '2c';
    user?: string;
    authProto?: string;
    privProto?: string;
    port?: number;
    transport?: 'rest' | 'api-ssl' | 'api';
    allowPlain?: boolean;
    /** A recorder over HTTPS (its certificate pinned on first contact). */
    https?: boolean;
  };
  secretSet: boolean;
  usedBy: number;
}

export interface Found {
  address: string;
  name?: string;
  model?: string;
  vendor?: string;
  profile?: string;
  credential?: string;
  protocol?: 'snmp' | 'routeros' | 'dahua';
  answered: boolean;
  error?: string;
  viaNeighbour?: string;
  added: boolean;
}

// ---------------------------------------------------------------- 0.17 (ADR-234)

/** One of a recorder's three signals: ok, failing (since), or unknown (learning, no port). */
export interface RecordingSignal {
  key: 'recorder' | 'disk' | 'rate';
  ok: boolean | null;
  why: string;
  since: string | null;
}

/** The Overview's Recording card: one line per recorder. */
export interface RecordingLine {
  id: string;
  name: string;
  /** null: not known yet, or the recorder isn't answering (status). */
  recording: boolean | null;
  status: DeviceStatus;
  since: string | null;
  why: string | null;
  cameras: { online: number; total: number };
  disk: { nasId: string | null; nas: string | null; lun: string } | null;
  daysLeft: number | null;
  full: boolean;
  /** bytes a second */
  rate: number | null;
  usual: { low: number; high: number; median: number } | null;
}

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

export interface AccessPoint extends Device {
  controllerId: string;
  controller: string;
  /** wifi (RouterOS 7's package) or caps-man (legacy) */
  generation: string;
  /** CAPsMAN's word */
  state: string;
  statusSince: string | null;
  radios: Radio[];
  clients: number;
  weak: number;
  switchPort: { deviceId: string; device: string; port: string } | null;
  /** client counts over 24 h, every 30 min */
  spark: number[];
}

export interface WifiClient {
  mac: string;
  vendor: string;
  apId: string | null;
  ap: string;
  ssid: string;
  band: string;
  signalDbm: number | null;
  txRate: string;
  rxRate: string;
  uptimeS: number | null;
  /** since it connected, both ways */
  bytes: number;
}

export interface Wireless {
  controllers: { id: string; name: string; generations: string[] }[];
  tiles: {
    aps: number;
    apsUp: number;
    clients: number;
    weak: number;
    busiest: { id: string; name: string; clients: number } | null;
  };
  /** Below this a client is weak (dBm). */
  weakDbm: number;
  aps: AccessPoint[];
  clients: WifiClient[];
  mesh: {
    fromId: string;
    from: string;
    toId: string;
    to: string;
    signalDbm: number | null;
    rate: string;
  }[];
  /** The access points' switch ports both ways, bytes a second, 24 h at 5 min, and the band. */
  traffic: {
    points: Points;
    band: { t: string; low: number; high: number; median: number }[];
    stepS: number;
  };
  attention: Attention[];
}

export interface RecorderDiskView {
  name: string;
  iscsi: boolean;
  state: string;
  healthy: boolean;
  total: number;
  used: number;
  session: { nasId: string | null; nas: string | null; lun: string } | null;
}

export interface RecorderCard {
  id: string;
  name: string;
  model: string;
  firmware: string;
  address: string;
  status: DeviceStatus;
  recording: boolean | null;
  since: string | null;
  failed: RecordingSignal['key'][];
  signals: RecordingSignal[];
  cameras: {
    online: number;
    total: number;
    list: { channel: number; name: string; online: boolean; since: string | null }[];
  };
  disks: RecorderDiskView[];
  free: number;
  total: number;
  daysLeft: number | null;
  /** full and overwriting its oldest footage */
  full: boolean;
  rate: number | null;
  usual: { low: number; high: number; median: number } | null;
  rateFrom: { device: string; port: string; side: 'recorder' | 'nas' } | null;
  openAlerts: number;
  poller: Poller;
}

export interface NasDisk {
  index: number;
  name?: string;
  model?: string;
  capacity?: number;
  celsius?: number;
  /** good, warning, abnormal, error, unknown (the NAS's word) */
  smart: string;
  status: string;
}
export interface NasVolume {
  name: string;
  total: number;
  free: number;
  status: string;
  raid?: string;
}
export interface NasCard extends Device {
  sensors: { name: string; celsius: number }[];
  fans: { name: string; state: string }[];
  psus: { name: string; state: string }[];
  disks: NasDisk[];
  volumes: NasVolume[];
  pools: NasVolume[];
  luns: {
    name: string;
    capacity: number;
    usedPercent?: number;
    status?: string;
    mapped: boolean;
    session: {
      recorderId: string;
      recorder: string;
      connected: boolean;
      since: string | null;
    } | null;
  }[];
  targets: { name: string; iqn?: string; connected: boolean; status?: string }[];
}

export interface ISCSISession {
  recorderId: string;
  recorder: string;
  disk: string;
  nasId: string | null;
  nas: string | null;
  lun: string;
  target: string;
  connected: boolean;
  since: string | null;
  lostAt: string | null;
  /** bytes a second */
  throughputBps: number | null;
  throughputFrom: { device: string; port: string; side: 'recorder' | 'nas' } | null;
  /** QTS gives no session table: these are seen from the recorder and the switch ports. */
  seenFrom: 'recorder' | 'nas';
}

export interface UpsCard extends Device {
  ups: {
    /** online, on-battery, bypass, off, unknown */
    status: string;
    chargePercent?: number;
    runtimeS?: number;
    loadPercent?: number;
    inputVolts?: number;
    outputVolts?: number;
    celsius?: number;
    replaceBattery: boolean;
  } | null;
  feeds: { clusterId: string; node: string; cluster: string; kind: string }[];
}

export interface Storage {
  recorders: RecorderCard[];
  nases: NasCard[];
  sessions: ISCSISession[];
  upses: UpsCard[];
  attention: Attention[];
}

export const networkApi = {
  summary: () => api<Summary>('/network/summary'),
  kinds: () => api<Kinds>('/network/kinds'),
  wireless: () => api<Wireless>('/network/wireless'),
  storage: () => api<Storage>('/network/storage'),
  feedOptions: () =>
    api<{ hosts: { clusterId: string; cluster: string; kind: string; node: string }[] }>(
      '/network/feed-options',
    ),
  setFeeds: (id: string, feeds: { clusterId: string; node: string }[]) =>
    api<void>(`/network/devices/${encodeURIComponent(id)}/feeds`, {
      method: 'PUT',
      body: { feeds },
    }),
  devices: () => api<{ devices: Device[] }>('/network/devices'),
  device: (id: string) => api<DeviceDetail>(`/network/devices/${encodeURIComponent(id)}`),
  series: (id: string, range: number, port?: string) =>
    api<DeviceSeries>(
      `/network/devices/${encodeURIComponent(id)}/series?range=${range}${port ? `&port=${encodeURIComponent(port)}` : ''}`,
    ),
  map: () => api<MapData>('/network/map'),
  saveLayout: (positions: Record<string, { x: number; y: number }>) =>
    api<void>('/network/map/layout', { method: 'PUT', body: { positions } }),
  pollers: () => api<{ pollers: PollerChoice[] }>('/network/pollers'),
  credentials: () => api<{ credentials: Credential[] }>('/network/credentials'),
  createCredential: (body: {
    name: string;
    protocol: 'snmp' | 'routeros' | 'dahua';
    settings: Credential['settings'];
    secret: Record<string, string>;
  }) => api<{ id: string }>('/network/credentials', { method: 'POST', body }),
  discover: (body: {
    clusterId: string;
    host: string;
    seeds: string[];
    range?: string;
    neighbours: boolean;
    credentialIds: string[];
  }) => api<{ id: string }>('/network/discoveries', { method: 'POST', body }),
  discovery: (id: string) =>
    api<{ id: string; done: boolean; expired: boolean; found: Found[] }>(
      `/network/discoveries/${encodeURIComponent(id)}`,
    ),
  addDevices: (body: {
    clusterId: string;
    host: string;
    devices: { address: string; name?: string; credentialId: string; profile?: string }[];
  }) =>
    api<{ added: string[]; skipped: { address: string; reason: string }[] }>('/network/devices', {
      method: 'POST',
      body,
    }),
  updateDevice: (id: string, body: Record<string, unknown>) =>
    api<void>(`/network/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  acceptCertificate: (id: string) =>
    api<void>(`/network/devices/${encodeURIComponent(id)}/accept-certificate`, { method: 'POST' }),
  removeDevice: (id: string) =>
    api<void>(`/network/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setupCommands: (platform: 'ios' | 'nxos' | 'routeros', credentialId: string, poller: string) =>
    api<{ commands: string }>(
      `/network/setup-commands?platform=${platform}&credentialId=${encodeURIComponent(credentialId)}&poller=${encodeURIComponent(poller)}`,
    ),
};
