// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Device, DeviceKind, Endpoint, Link, MapData, NodeRef } from '../api';
import { bandOf } from './format';
import {
  BAND_Y,
  GROUP_OVER,
  INTERNET,
  deviceNodeId,
  endpointNodeId,
  flowOf,
  focusOf,
  groupNodeId,
  hostNodeId,
  layoutMap,
  linkWidth,
  searchMap,
  type MapDevice,
} from './map-layout';

function device(id: string, kind: DeviceKind, extra: Partial<MapDevice> = {}): MapDevice {
  const d: Device = {
    id,
    name: id,
    kind,
    vendor: 'Vendor',
    model: 'Model',
    serial: '',
    firmware: '1.0',
    address: `10.0.0.${id.length}`,
    protocol: 'snmp',
    profile: null,
    status: 'ok',
    error: null,
    uptimeS: 100,
    polledAt: null,
    cpu: 0.1,
    memory: 0.2,
    temperature: null,
    portsUp: 4,
    portsTotal: 8,
    update: null,
    managedAp: false,
    poller: { clusterId: 'c1', name: 'fleet', kind: 'server', host: 'poller-1' },
    openAlerts: 0,
  };
  return { ...d, gateway: null, ...extra };
}

let linkSeq = 0;
function link(a: string, b: string, extra: Partial<Link> = {}): Link {
  linkSeq++;
  return {
    id: `k${linkSeq}`,
    a: { deviceId: a, port: `p${linkSeq}a` },
    b: { deviceId: b, port: `p${linkSeq}b` },
    via: ['lldp'],
    speedMbps: 1000,
    bpsAB: 1e6,
    bpsBA: 1e5,
    utilisation: 0.01,
    errors: false,
    state: 'ok',
    lastSeen: '2026-11-24T00:00:00Z',
    ...extra,
  };
}

const mac = (n: number) =>
  Array.from({ length: 6 }, (_, i) => ((n >> (8 * (5 - i))) & 0xff).toString(16).padStart(2, '0'))
    .join(':')
    .replace(/^00/, '02');

function endpoint(n: number, deviceId: string, node: NodeRef | null = null): Endpoint {
  return {
    mac: mac(n),
    ip: `10.1.${n >> 8}.${n & 0xff}`,
    vendor: 'Acme',
    deviceId,
    port: `ge${n % 48}`,
    node,
  };
}

/** edge-1 → core-1 → sw-access-1 (nas-1, db-1, web-1), sw-access-2 (daisy-chained). */
function small(): MapData {
  linkSeq = 0;
  return {
    devices: [
      device('edge-1', 'router', { gateway: '203.0.113.1' }),
      device('core-1', 'l3switch'),
      device('sw-access-1', 'switch', { openAlerts: 1 }),
      device('sw-access-2', 'switch', { status: 'unreachable' }),
      device('nas-1', 'nas'),
    ],
    links: [
      link('edge-1', 'core-1', { speedMbps: 10000 }),
      link('core-1', 'sw-access-1', { speedMbps: 10000 }),
      link('core-1', 'sw-access-1', { speedMbps: 10000, state: 'down', bpsAB: 0, bpsBA: 0 }),
      link('sw-access-1', 'sw-access-2', { state: 'warn', utilisation: 0.86 }),
      link('sw-access-1', 'nas-1'),
    ],
    endpoints: [
      endpoint(1, 'sw-access-1', {
        clusterId: 'f1',
        cluster: 'office',
        kind: 'server',
        name: 'db-1',
      }),
      endpoint(2, 'sw-access-1', {
        clusterId: 'f1',
        cluster: 'office',
        kind: 'server',
        name: 'web-1',
      }),
      endpoint(3, 'core-1', { clusterId: 'f1', cluster: 'office', kind: 'server', name: 'web-1' }),
      ...Array.from({ length: 10 }, (_, i) => endpoint(100 + i, 'sw-access-2')),
      endpoint(200, 'sw-access-1'),
    ],
    layout: {},
  };
}

describe('layoutMap', () => {
  it('puts devices in their bands, an Internet node above the gateway, servers under their switch', () => {
    const l = layoutMap(small(), { endpoints: false });
    const at = (id: string) => l.byId.get(id)!;
    expect(at(INTERNET).y).toBe(BAND_Y[0]);
    expect(at(deviceNodeId('edge-1')).y).toBe(BAND_Y[1]);
    expect(at(deviceNodeId('core-1')).y).toBe(BAND_Y[2]);
    expect(at(deviceNodeId('sw-access-1')).y).toBe(BAND_Y[3]);
    expect(at(deviceNodeId('sw-access-2')).y).toBe(BAND_Y[3]);
    expect(at(deviceNodeId('nas-1')).y).toBe(BAND_Y[4]);
    expect(at(deviceNodeId('sw-access-2')).parent).toBe(deviceNodeId('sw-access-1'));
    expect(at(deviceNodeId('edge-1')).parent).toBe(INTERNET);

    const web = at(hostNodeId({ kind: 'server', clusterId: 'f1', name: 'web-1' }));
    expect(web.kind).toBe('server');
    // Seen on core-1 and sw-access-1: hangs under the access switch, linked to both.
    expect(web.parent).toBe(deviceNodeId('sw-access-1'));
    expect(l.edges.filter((e) => e.to === web.id)).toHaveLength(2);
    // Daisy-chained switches in one band don't overlap.
    expect(
      Math.abs(at(deviceNodeId('sw-access-1')).x - at(deviceNodeId('sw-access-2')).x),
    ).toBeGreaterThan(60);
    // Unknown endpoints only with the layer.
    expect(l.nodes.some((n) => n.type === 'group' || n.type === 'endpoint')).toBe(false);
    expect(at(deviceNodeId('sw-access-2')).behind).toBe(10);
    // Parallel links get offsets apart.
    const pair = l.edges.filter(
      (e) => e.from === deviceNodeId('core-1') && e.to === deviceNodeId('sw-access-1'),
    );
    expect(pair.map((e) => e.offset).sort()).toEqual([-3.5, 3.5]);
  });

  it('groups unknown endpoints per device until expanded', () => {
    const data = small();
    const l = layoutMap(data, { endpoints: true });
    const g = l.byId.get(groupNodeId('sw-access-2'))!;
    expect(g.behind).toBe(10);
    expect(g.parent).toBe(deviceNodeId('sw-access-2'));
    // Few enough are shown one by one.
    expect(l.byId.get(endpointNodeId(mac(200)))?.parent).toBe(deviceNodeId('sw-access-1'));
    const open = layoutMap(data, { endpoints: true, expanded: new Set(['sw-access-2']) });
    expect(open.byId.has(groupNodeId('sw-access-2'))).toBe(false);
    expect(open.nodes.filter((n) => n.type === 'endpoint')).toHaveLength(11);
  });

  it('focuses the path up to the Internet and what is below', () => {
    const l = layoutMap(small(), { endpoints: false });
    const f = focusOf(l, { type: 'node', id: deviceNodeId('sw-access-2') });
    expect([...f.nodes].sort()).toEqual(
      [
        INTERNET,
        deviceNodeId('edge-1'),
        deviceNodeId('core-1'),
        deviceNodeId('sw-access-1'),
        deviceNodeId('sw-access-2'),
      ].sort(),
    );
    expect(f.nodes.has(deviceNodeId('nas-1'))).toBe(false);
    const k = l.edges.find((e) => e.type === 'link' && e.link!.state === 'warn')!;
    const fl = focusOf(l, { type: 'link', id: k.id });
    expect(fl.edges.has(k.id)).toBe(true);
    expect(fl.nodes.has(INTERNET)).toBe(true);
  });

  it('has no Internet node without a gateway', () => {
    const data = small();
    data.devices = data.devices.map((d) => ({ ...d, gateway: null }));
    const l = layoutMap(data, { endpoints: false });
    expect(l.byId.has(INTERNET)).toBe(false);
    expect(l.byId.get(deviceNodeId('edge-1'))!.parent).toBeNull();
  });

  it('lays out 200 devices and 1,000 endpoints quickly', () => {
    linkSeq = 0;
    const devices: MapDevice[] = [];
    const links: Link[] = [];
    const endpoints: Endpoint[] = [];
    devices.push(device('edge-1', 'router', { gateway: '203.0.113.1' }));
    devices.push(device('edge-2', 'router', { gateway: '203.0.113.2' }));
    for (let i = 1; i <= 4; i++) {
      devices.push(device(`core-${i}`, 'l3switch'));
      links.push(link(`edge-${(i % 2) + 1}`, `core-${i}`, { speedMbps: 10000 }));
    }
    for (let i = 1; i <= 120; i++) {
      devices.push(device(`sw-access-${i}`, 'switch'));
      links.push(link(`core-${(i % 4) + 1}`, `sw-access-${i}`, { speedMbps: 10000 }));
      links.push(link(`core-${((i + 1) % 4) + 1}`, `sw-access-${i}`, { speedMbps: 10000 }));
    }
    const kinds: DeviceKind[] = ['ap', 'nas', 'ups', 'nvr'];
    for (let i = 1; i <= 74; i++) {
      devices.push(device(`dev-${i}`, kinds[i % 4]!));
      links.push(link(`sw-access-${(i % 120) + 1}`, `dev-${i}`));
    }
    for (let i = 0; i < 1000; i++) {
      const sw = `sw-access-${(i % 120) + 1}`;
      const node: NodeRef | null =
        i < 200
          ? {
              clusterId: 'k1',
              cluster: 'prod',
              kind: i % 2 ? 'kubernetes' : 'server',
              name: `host-${i}`,
            }
          : null;
      endpoints.push(endpoint(1000 + i, sw, node));
    }
    const data: MapData = { devices, links, endpoints, layout: {} };
    expect(devices).toHaveLength(200);

    layoutMap(data, { endpoints: true }); // warm up
    const t0 = performance.now();
    const l = layoutMap(data, { endpoints: true });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(200);

    for (const d of devices) {
      const n = l.byId.get(deviceNodeId(d.id))!;
      expect(n.y, d.id).toBe(BAND_Y[bandOf(d.kind)]);
    }
    // Servers and nodes: one node each, in the Devices band or the rows below it.
    const hosts = l.nodes.filter((n) => n.type === 'host');
    expect(hosts).toHaveLength(200);
    expect(hosts.every((h) => h.y >= BAND_Y[4])).toBe(true);
    // 800 unknown endpoints over 120 switches (6–7 each): one "+N more" bubble per switch.
    const groups = l.nodes.filter((n) => n.type === 'group');
    expect(groups).toHaveLength(120);
    expect(groups.every((g) => g.behind > GROUP_OVER)).toBe(true);
    expect(groups.reduce((s, g) => s + g.behind, 0)).toBe(800);
    // No two nodes on the same spot.
    const spots = new Set(l.nodes.map((n) => `${Math.round(n.x)},${n.y}`));
    expect(spots.size).toBe(l.nodes.length);
  });
});

describe('links', () => {
  it('thickens with speed', () => {
    expect(linkWidth(100)).toBeLessThan(linkWidth(1000));
    expect(linkWidth(1000)).toBeLessThan(linkWidth(10000));
    expect(linkWidth(null)).toBe(linkWidth(100));
  });
  it('flows the busier way, faster with more traffic, not when down', () => {
    const slow = flowOf(link('a', 'b', { bpsAB: 1e4, bpsBA: 1e6 }))!;
    const fast = flowOf(link('a', 'b', { bpsAB: 5e9, bpsBA: 1e6 }))!;
    expect(slow.dir).toBe(-1);
    expect(fast.dir).toBe(1);
    expect(fast.dur).toBeLessThan(slow.dur);
    expect(flowOf(link('a', 'b', { state: 'down' }))).toBeNull();
    expect(flowOf(link('a', 'b', { bpsAB: null, bpsBA: 0 }))).toBeNull();
  });
});

describe('searchMap', () => {
  it('finds devices by name and endpoints by IP or MAC', () => {
    const data = small();
    expect(searchMap(data, 'core')[0]).toMatchObject({
      nodeId: deviceNodeId('core-1'),
      kind: 'device',
    });
    const byIp = searchMap(data, '10.1.0.200')[0]!;
    expect(byIp).toMatchObject({
      nodeId: endpointNodeId(mac(200)),
      expand: 'sw-access-1',
      kind: 'endpoint',
    });
    const byMac = searchMap(data, mac(105).toUpperCase().replace(/:/g, '-'))[0]!;
    expect(byMac.nodeId).toBe(endpointNodeId(mac(105)));
    const web = searchMap(data, 'web-1');
    expect(web).toHaveLength(1);
    expect(web[0]).toMatchObject({ kind: 'server', expand: null });
    expect(searchMap(data, '  ')).toEqual([]);
  });
});
