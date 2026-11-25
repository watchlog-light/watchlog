// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
import { describe, expect, it } from 'vitest';
import type { Port } from '../api';
import {
  frontPanel,
  genericRows,
  healthTone,
  inPanelOrder,
  isCage,
  modelOf,
  opticReading,
  pairRows,
  parseName,
  portState,
  servedPorts,
} from './front-panel';

let next = 1;
function port(name: string, over: Partial<Port> = {}): Port {
  return {
    index: next++,
    name,
    descr: '',
    alias: '',
    kind: 'ethernet',
    speedMbps: 1000,
    usualSpeedMbps: 1000,
    adminUp: true,
    operUp: true,
    vlans: [],
    poeWatts: null,
    errorsRising: false,
    changedAt: null,
    neighbour: null,
    ...over,
  };
}
const range = (prefix: string, from: number, to: number, over: Partial<Port> = {}) =>
  Array.from({ length: to - from + 1 }, (_, i) => port(`${prefix}${from + i}`, over));
const names = (ps: Port[]) => ps.map((p) => p.name);

describe('portState', () => {
  it('tells up, errors, went down, not connected and admin down apart', () => {
    expect(portState(port('Gi1/0/1'))).toBe('up');
    expect(portState(port('Gi1/0/1', { errorsRising: true }))).toBe('errors');
    const neighbour = { deviceId: 'x', device: 'core-1', port: 'Eth1/1', linkId: 'l' };
    expect(portState(port('Gi1/0/1', { operUp: false, neighbour }))).toBe('down');
    expect(portState(port('Gi1/0/1', { operUp: false }))).toBe('idle');
    expect(portState(port('Gi1/0/1', { adminUp: false, operUp: false }))).toBe('admin-down');
  });

  it('counts a down port with a WatchLog server or node behind it as went down', () => {
    const served = servedPorts([
      {
        port: 'Gi1/0/14',
        node: { clusterId: 'c', cluster: 'office', kind: 'server', name: 'db-1' },
      },
      { port: 'Gi1/0/15', node: null },
    ]);
    expect([...served]).toEqual(['Gi1/0/14']);
    expect(portState(port('Gi1/0/14', { operUp: false }), served.has('Gi1/0/14'))).toBe('down');
    expect(portState(port('Gi1/0/15', { operUp: false }), served.has('Gi1/0/15'))).toBe('idle');
    expect(portState(port('Gi1/0/14', { adminUp: false, operUp: false }), true)).toBe('admin-down');
    expect(portState(port('Gi1/0/14'), true)).toBe('up');
  });
});

describe('names and cages', () => {
  it('parses interface names', () => {
    expect(parseName('Gi1/0/12')).toEqual({ prefix: 'Gi', parts: [1, 0, 12] });
    expect(parseName('ether3')).toEqual({ prefix: 'ether', parts: [3] });
    expect(parseName('sfp-sfpplus1')).toEqual({ prefix: 'sfp-sfpplus', parts: [1] });
    expect(parseName('Vlan')).toEqual({ prefix: 'Vlan', parts: [] });
  });

  it('puts a port in a cage by kind, name or uplink module', () => {
    expect(isCage(port('Gi1/0/1'))).toBe(false);
    expect(isCage(port('Gi1/0/49', { kind: 'sfp' }))).toBe(true);
    expect(isCage(port('Te1/1/1'))).toBe(true);
    expect(isCage(port('Gi1/1/2'))).toBe(true);
    expect(isCage(port('sfp-sfpplus1'))).toBe(true);
    expect(isCage(port('ether1'))).toBe(false);
  });

  it('knows the reference models', () => {
    expect(modelOf('WS-C2960X-48FPD-L')?.name).toBe('Catalyst 2960X');
    expect(modelOf('WS-C2960+48TC-L')?.name).toBe('Catalyst 2960-Plus');
    expect(modelOf('WS-C2960S-48FPS-L')?.name).toBe('Catalyst 2960S');
    expect(modelOf('WS-C3850-48P')?.name).toBe('Catalyst 3850');
    expect(modelOf('N3K-C3064PQ-10GX')?.name).toBe('Nexus 3064');
    expect(modelOf('CCR2004-16G-2S+')?.name).toBe('CCR2004-16G-2S+');
    expect(modelOf('TS-464')).toBeNull();
    // The live demo's office (1.0.0): a generic set of current products.
    expect(modelOf('C9200L-48T-4X')?.name).toBe('Catalyst 9200L');
    expect(modelOf('C9300-48P')?.name).toBe('Catalyst 9300');
    expect(modelOf('C1000-48T-4G-L')?.name).toBe('Catalyst 1000');
    expect(modelOf('N9K-C9372PX')?.name).toBe('Nexus 9372PX');
    expect(modelOf('CCR2116-12G-4S+')?.name).toBe('CCR2116-12G-4S+');
  });

  it('orders by the numbers within a prefix, prefixes in ifIndex order', () => {
    const ps = [port('Fa0/2'), port('Fa0/10'), port('Gi0/1'), port('Fa0/1')];
    expect(names(inPanelOrder(ps))).toEqual(['Fa0/1', 'Fa0/2', 'Fa0/10', 'Gi0/1']);
  });

  it('pairs odd on top and even below', () => {
    const b = pairRows(range('ether', 1, 5));
    expect(names(b.top)).toEqual(['ether1', 'ether3', 'ether5']);
    expect(names(b.bottom)).toEqual(['ether2', 'ether4']);
  });
});

describe('frontPanel', () => {
  it('draws a 2960X as four blocks of 12 and four cages', () => {
    const ports = [
      ...range('Gi1/0/', 1, 48),
      ...range('Gi1/0/', 49, 52),
      port('Vlan1', { kind: 'vlan' }),
      port('Po1', { kind: 'lag' }),
    ];
    const fp = frontPanel('WS-C2960X-48FPD-L', ports);
    expect(fp.model).toBe('Catalyst 2960X');
    expect(fp.panels).toHaveLength(1);
    const [p] = fp.panels;
    expect(p!.member).toBeNull();
    expect(p!.blocks).toHaveLength(4);
    expect(names(p!.blocks[0]!.top)).toEqual([
      'Gi1/0/1',
      'Gi1/0/3',
      'Gi1/0/5',
      'Gi1/0/7',
      'Gi1/0/9',
      'Gi1/0/11',
    ]);
    expect(names(p!.blocks[0]!.bottom)).toEqual([
      'Gi1/0/2',
      'Gi1/0/4',
      'Gi1/0/6',
      'Gi1/0/8',
      'Gi1/0/10',
      'Gi1/0/12',
    ]);
    expect(names(p!.blocks[3]!.bottom).at(-1)).toBe('Gi1/0/48');
    expect(names(p!.cages!.top)).toEqual(['Gi1/0/49', 'Gi1/0/51']);
    expect(names(p!.cages!.bottom)).toEqual(['Gi1/0/50', 'Gi1/0/52']);
    expect(names(fp.others)).toEqual(['Vlan1', 'Po1']);
  });

  it('draws a 2960-Plus with its Fa ports in blocks and the Gi ports in cages', () => {
    const fp = frontPanel('WS-C2960+48TC-L', [
      port('Fa0'),
      ...range('Fa0/', 1, 48),
      ...range('Gi0/', 1, 4),
    ]);
    const [p] = fp.panels;
    expect(p!.blocks.flatMap((b) => [...b.top, ...b.bottom])).toHaveLength(48);
    expect(names(p!.cages!.top)).toEqual(['Gi0/1', 'Gi0/3']);
    expect(names(fp.others)).toEqual(['Fa0']);
  });

  it("draws the demo's office: a 9300 stack, a 9200L, a Nexus 9372PX and a CCR2116", () => {
    const stack = frontPanel('C9300-48P', [
      ...range('Gi1/0/', 1, 48),
      ...range('Te1/1/', 1, 4),
      ...range('Gi2/0/', 1, 48),
      ...range('Te2/1/', 1, 4),
    ]);
    expect(stack.model).toBe('Catalyst 9300');
    expect(stack.panels.map((p) => p.member)).toEqual([1, 2]);
    expect(names(stack.panels[0]!.cages!.top)).toEqual(['Te1/1/1', 'Te1/1/3']);
    const access = frontPanel('C9200L-48T-4X', [
      ...range('Gi1/0/', 1, 48),
      ...range('Te1/1/', 1, 4),
    ]);
    expect(access.model).toBe('Catalyst 9200L');
    expect(access.panels).toHaveLength(1);
    expect(access.panels[0]!.member).toBeNull();
    expect(access.panels[0]!.blocks).toHaveLength(4);
    const core = frontPanel(
      'N9K-C9372PX',
      range('Ethernet1/', 1, 54).map((p) => ({ ...p, kind: 'sfp' as const })),
    );
    expect(core.model).toBe('Nexus 9372PX');
    expect(core.panels[0]!.blocks).toHaveLength(4);
    expect(names(core.panels[0]!.cages!.top)).toEqual([
      'Ethernet1/49',
      'Ethernet1/51',
      'Ethernet1/53',
    ]);
    const edge = frontPanel('CCR2116-12G-4S+', [
      ...range('ether', 1, 13),
      ...range('sfp-sfpplus', 1, 4).map((p) => ({ ...p, kind: 'sfp' as const })),
    ]);
    expect(edge.model).toBe('CCR2116-12G-4S+');
    expect(edge.panels[0]!.blocks).toHaveLength(1);
    expect(edge.panels[0]!.cages!.top).toHaveLength(2);
  });

  it('draws a 3850 stack as one panel per member, uplink modules in cages', () => {
    const ports = [
      port('Gi0/0'),
      ...range('Gi1/0/', 1, 48),
      ...range('Te1/1/', 1, 4),
      ...range('Gi2/0/', 1, 48),
      ...range('Gi2/1/', 1, 4),
    ];
    const fp = frontPanel('WS-C3850-48P', ports);
    expect(fp.panels.map((p) => p.member)).toEqual([1, 2]);
    expect(fp.panels[1]!.blocks[0]!.top[0]!.name).toBe('Gi2/0/1');
    expect(names(fp.panels[1]!.cages!.top)).toEqual(['Gi2/1/1', 'Gi2/1/3']);
    expect(names(fp.panels[0]!.cages!.bottom)).toEqual(['Te1/1/2', 'Te1/1/4']);
    expect(names(fp.others)).toEqual(['Gi0/0']);
  });

  it('numbers a single 3850 as member 1', () => {
    const fp = frontPanel('WS-C3850-48T', range('Gi1/0/', 1, 48));
    expect(fp.panels.map((p) => p.member)).toEqual([1]);
    expect(fp.panels[0]!.cages).toBeNull();
  });

  it('draws a Nexus 3064 as 48 SFP+ in blocks and 4 QSFP in cages', () => {
    const ports = [
      ...range('Eth1/', 1, 48, { kind: 'sfp', speedMbps: 10000 }),
      ...range('Eth1/', 49, 52, { kind: 'sfp', speedMbps: 40000 }),
      port('mgmt0'),
    ];
    const fp = frontPanel('N3K-C3064PQ-10GX', ports);
    const [p] = fp.panels;
    expect(p!.member).toBeNull();
    expect(p!.blocks).toHaveLength(4);
    expect(names(p!.cages!.top)).toEqual(['Eth1/49', 'Eth1/51']);
    expect(names(fp.others)).toEqual(['mgmt0']);
  });

  it('draws a CCR2004-16G-2S+ as two blocks of 8 and two SFP+ cages', () => {
    const ports = [
      ...range('ether', 1, 16),
      port('sfp-sfpplus1', { kind: 'sfp' }),
      port('sfp-sfpplus2', { kind: 'sfp' }),
      port('bridge', { kind: 'vlan' }),
    ];
    const fp = frontPanel('CCR2004-16G-2S+', ports);
    const [p] = fp.panels;
    expect(p!.blocks).toHaveLength(2);
    expect(names(p!.blocks[1]!.top)).toEqual(['ether9', 'ether11', 'ether13', 'ether15']);
    expect(names(p!.cages!.top)).toEqual(['sfp-sfpplus1']);
    expect(names(p!.cages!.bottom)).toEqual(['sfp-sfpplus2']);
  });

  it('falls back to rows in ifIndex order for any other model', () => {
    const a = port('eth0');
    const b = port('eth1');
    a.index = 20;
    b.index = 3;
    const fp = frontPanel('TS-464', [a, b, port('lo', { kind: 'virtual' })]);
    expect(fp.model).toBeNull();
    expect(fp.panels).toHaveLength(1);
    expect(fp.panels[0]!.rows!.map(names)).toEqual([['eth1', 'eth0']]);
    expect(names(fp.others)).toEqual(['lo']);
  });

  it('splits generic rows and shows no panel without ports', () => {
    expect(genericRows(range('p', 1, 30), 24).map((r) => r.length)).toEqual([24, 6]);
    expect(frontPanel('anything', []).panels).toEqual([]);
  });
});

describe('health', () => {
  it('reads states as tones', () => {
    expect(healthTone('Normal')).toBe('ok');
    expect(healthTone('Ready')).toBe('ok');
    expect(healthTone('notPresent')).toBe('critical');
    expect(healthTone('Failed')).toBe('critical');
    expect(healthTone('warning')).toBe('warning');
    expect(healthTone('Provisioned')).toBe('neutral');
  });

  it('weighs an optic against its thresholds', () => {
    expect(opticReading('rx', -5.24, -14, 0.5)).toEqual({
      key: 'rx',
      value: '-5.2 dBm',
      tone: 'ok',
      range: '-14.0 … 0.5',
    });
    expect(opticReading('rx', -14.5, -14, 0.5).tone).toBe('critical');
    expect(opticReading('rx', -13.5, -14, 0.5).tone).toBe('warning');
    expect(opticReading('tx', 1, undefined, 0.5)).toMatchObject({
      tone: 'critical',
      range: '≤ 0.5',
    });
    expect(opticReading('tx', -3, undefined, undefined)).toMatchObject({ tone: 'ok', range: '' });
    expect(opticReading('tx', undefined, -14, 0.5)).toMatchObject({ value: '–', tone: 'neutral' });
  });
});
