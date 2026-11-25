// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// A device page shows only what its kind reports (0.17.1): the tiles and charts per source, from
// devices shaped like the demo's.
import { describe, expect, it } from 'vitest';
import type { DeviceDetail } from '../api';
import {
  chartPoints,
  deviceCharts,
  deviceTiles,
  panelTiles,
  radiosText,
  withValue,
} from './device-view';
import { tileText } from './tile-text';

function detail(
  device: Partial<DeviceDetail['device']>,
  rest: Partial<DeviceDetail> = {},
): DeviceDetail {
  return {
    device: {
      id: 'd',
      name: 'x',
      kind: 'switch',
      protocol: 'snmp',
      managedAp: false,
      parentId: null,
      cpu: null,
      memory: null,
      temperature: null,
      portsUp: null,
      portsTotal: null,
      routes: null,
      gateway: null,
      ...device,
    } as DeviceDetail['device'],
    kind: {},
    health: { sensors: [], fans: [], psus: [], optics: [], stack: [], stackExpected: 0 },
    ports: [],
    endpoints: [],
    links: [],
    events: [],
    alerts: [],
    ...rest,
  } as DeviceDetail;
}
const keys = (d: DeviceDetail) => deviceTiles(d).map((t) => t.key);

describe('the tiles and charts per source', () => {
  it('an SNMP switch: CPU, memory, temperature, ports, and its fans', () => {
    const d = detail(
      {
        kind: 'switch',
        profile: 'cisco-ios',
        cpu: 0.17,
        memory: 0.35,
        temperature: 38,
        portsUp: 29,
        portsTotal: 52,
      },
      {
        health: {
          sensors: [],
          fans: [{ name: 'Fan 1', state: 'ok' }],
          psus: [],
          optics: [],
          stack: [],
          stackExpected: 0,
        },
      },
    );
    expect(keys(d)).toEqual(['cpu', 'memory', 'temperature', 'ports', 'fans']);
    expect(deviceCharts(d)).toEqual(['cpu', 'memory', 'temperature']);
  });

  it('a RouterOS router: the same, and its routes', () => {
    const d = detail({
      kind: 'router',
      protocol: 'routeros',
      cpu: 0.04,
      memory: 0.25,
      temperature: 51,
      portsUp: 5,
      portsTotal: 18,
      routes: 12,
      gateway: '203.0.113.1',
    });
    expect(keys(d)).toEqual(['cpu', 'memory', 'temperature', 'ports', 'routes']);
    expect(deviceCharts(d)).toEqual(['cpu', 'memory', 'temperature']);
  });

  it("an access point through CAPsMAN: clients, radios, weak clients; a clients chart; nothing it can't have", () => {
    const d = detail(
      { kind: 'ap', protocol: 'capsman', managedAp: true, parentId: 'edge' },
      {
        kind: {
          ap: {
            clients: 9,
            weak: 3,
            weakDbm: -75,
            generation: 'wifi',
            radios: [
              { interface: 'w1', band: '2ghz-ax', channel: 3, clients: 4, running: true },
              { interface: 'w2', band: '5ghz-ax', channel: 36, clients: 5, running: true },
            ],
          },
        },
      },
    );
    expect(keys(d)).toEqual(['clients', 'radios', 'weak']);
    expect(deviceTiles(d).find((t) => t.key === 'radios')?.value).toBe(
      '2.4 GHz ch 3 · 5 GHz ch 36',
    );
    expect(deviceCharts(d)).toEqual(['clients']);
  });

  it('a Dahua recorder: recording, cameras, days left; a cameras chart; no CPU, memory or ports', () => {
    const d = detail(
      { kind: 'nvr', protocol: 'dahua', profile: 'dahua' },
      {
        kind: {
          recorder: {
            recording: true,
            camerasOnline: 15,
            camerasTotal: 16,
            daysLeft: 11.6,
            full: false,
          },
        },
      },
    );
    expect(keys(d)).toEqual(['recording', 'cameras', 'daysLeft']);
    expect(deviceCharts(d)).toEqual(['camerasOnline']);
  });

  it('a QNAP: CPU, temperature and ports as it reports them, no memory (QTS gives none)', () => {
    const d = detail({
      kind: 'nas',
      profile: 'qnap',
      cpu: 0.09,
      temperature: 48,
      portsUp: 2,
      portsTotal: 2,
    });
    expect(keys(d)).toEqual(['cpu', 'temperature', 'ports']);
    expect(deviceCharts(d)).toEqual(['cpu', 'temperature']);
  });

  it('a UPS: charge, runtime, load first, its network card port; its own charts', () => {
    const d = detail(
      { kind: 'ups', profile: 'ups-mib', portsUp: 1, portsTotal: 1 },
      {
        kind: {
          ups: {
            status: 'online',
            chargePercent: 100,
            runtimeS: 3120,
            loadPercent: 31,
            replaceBattery: false,
          },
        },
      },
    );
    expect(keys(d)).toEqual(['charge', 'runtime', 'load', 'ports']);
    expect(deviceCharts(d)).toEqual(['charge', 'load', 'runtime']);
  });

  it('a chart reads its points from the right field', () => {
    const s = {
      range: 3600,
      step: 60,
      cpu: [[1, 0.1]],
      memory: [],
      temperature: [],
      kind: { clients: [[1, 9]] },
      port: null,
    } as never;
    expect(chartPoints(s, 'cpu')).toEqual([[1, 0.1]]);
    expect(chartPoints(s, 'clients')).toEqual([[1, 9]]);
    expect(chartPoints(s, 'charge')).toEqual([]);
    expect(chartPoints(null, 'cpu')).toEqual([]);
  });

  it('words a radio list', () => {
    expect(radiosText([{ interface: 'a', frequencyMhz: 5955, clients: 0, running: true }])).toBe(
      '6.0 GHz',
    );
    expect(radiosText([])).toBe('');
  });
});

describe("the map's side panel follows the device's kind (1.0.0)", () => {
  const none = { cpu: null, memory: null, portsUp: null, portsTotal: null, uptimeS: null };
  const recorder = detail(
    { kind: 'nvr', protocol: 'dahua' },
    {
      kind: {
        recorder: {
          recording: true,
          camerasOnline: 16,
          camerasTotal: 16,
          daysLeft: 12.4,
          daysCalculating: false,
          full: false,
        },
      },
    },
  );
  // vue-i18n's t, as far as these tiles need it: the key, its values and the plural's count.
  const t = (key: string, values?: Record<string, unknown>, count?: number) =>
    `${key}${values ? `:${Object.values(values).join(',')}` : ''}${count !== undefined ? `#${count}` : ''}`;

  it('a recorder: recording, cameras and the recording left, never four dashes', () => {
    const tiles = panelTiles(none, recorder);
    expect(tiles.map((x) => x.key)).toEqual(['recording', 'cameras', 'daysLeft']);
    expect(tiles.map((x) => tileText(t, x).value)).toEqual([
      'netDevice.tiles.recordingYes',
      '16 / 16',
      'netDevice.tiles.days:12#12',
    ]);
    // Before its detail arrives the map knows nothing it reports: no tile at all.
    expect(panelTiles(none, null)).toEqual([]);
    for (const x of tiles) expect(tileText(t, x).value).not.toBe('–');
  });

  it('a switch keeps CPU, memory and ports, with how long it has been up', () => {
    const sw = { cpu: 0.08, memory: 0.35, portsUp: 46, portsTotal: 104, uptimeS: 3_275_000 };
    expect(panelTiles(sw, null).map((x) => x.key)).toEqual(['cpu', 'memory', 'ports', 'uptime']);
    const full = detail({ ...sw, temperature: 41 });
    expect(panelTiles(sw, full).map((x) => x.key)).toEqual([
      'cpu',
      'memory',
      'temperature',
      'uptime',
    ]);
    expect(tileText(t, { key: 'uptime', value: 3_275_000 }).value).toBe('37d 21h');
  });

  it('a UPS and an access point show their own', () => {
    const ups = detail({ kind: 'ups' }, {
      kind: { ups: { chargePercent: 100, runtimeS: 2700, loadPercent: 31 } },
    } as never);
    expect(panelTiles(none, ups).map((x) => x.key)).toEqual(['charge', 'runtime', 'load']);
    const ap = detail(
      { kind: 'ap', protocol: 'capsman', managedAp: true, parentId: 'r' },
      { kind: { ap: { clients: 9, weak: 1, weakDbm: -75, radios: [], generation: 'wifi' } } },
    );
    expect(panelTiles(none, ap).map((x) => x.key)).toEqual(['clients', 'weak']);
  });

  it('the recording left: calculating before an hour of data, words under a day', () => {
    const tile = (r: object) =>
      tileText(
        t,
        deviceTiles(
          detail(
            { kind: 'nvr' },
            {
              kind: {
                recorder: {
                  recording: true,
                  camerasOnline: 1,
                  camerasTotal: 1,
                  daysLeft: null,
                  full: false,
                  ...r,
                },
              },
            },
          ),
        ).find((x) => x.key === 'daysLeft')!,
      );
    expect(tile({ daysCalculating: true }).value).toBe('netDevice.tiles.calculating');
    expect(tile({ daysLeft: 0.4 }).value).toBe('netDevice.tiles.underDay');
    expect(tile({ daysLeft: 1.9 }).value).toBe('netDevice.tiles.days:1#1');
    expect(tile({ full: true }).value).toBe('netDevice.tiles.full');
    for (const r of [{ daysCalculating: true }, { daysLeft: 0.4 }, { daysLeft: 0.01 }])
      expect(tile(r).value).not.toMatch(/:0\b/);
  });

  it('a header fact with no value is not a row', () => {
    const rows = withValue([
      { label: 'Model', value: 'Dahua' },
      { label: 'Uptime', value: null },
      { label: 'Serial', value: '' },
      { label: 'Firmware', value: '–' },
      { label: 'Address', value: '10.0.10.50' },
    ]);
    expect(rows.map((r) => r.label)).toEqual(['Model', 'Address']);
  });
});
