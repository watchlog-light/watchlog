// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The network API's answers (ee/backend/src/network/routes.ts, ADR-233), as the pages read them.
import { api } from '@/api/client';

export type DeviceStatus =
  'pending' | 'ok' | 'unreachable' | 'auth_failed' | 'cert_changed' | 'error';
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
  protocol: 'snmp' | 'routeros';
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
    location: string;
    credential: { id: string; name: string; protocol: string } | null;
    certificate: { pinned: string | null; seen: string | null } | null;
    routes: number | null;
    gateway: string | null;
    firstSeen: string;
    lastSeen: string | null;
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
  protocol: 'snmp' | 'routeros';
  settings: {
    version?: '3' | '2c';
    user?: string;
    authProto?: string;
    privProto?: string;
    port?: number;
    transport?: 'rest' | 'api-ssl' | 'api';
    allowPlain?: boolean;
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
  protocol?: 'snmp' | 'routeros';
  answered: boolean;
  error?: string;
  viaNeighbour?: string;
  added: boolean;
}

export const networkApi = {
  summary: () => api<Summary>('/network/summary'),
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
    protocol: 'snmp' | 'routeros';
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
