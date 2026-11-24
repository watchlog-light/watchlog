// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
import { describe, expect, it } from 'vitest';
import type { WifiClient } from '../api';
import {
  apChips,
  bandAt,
  bandLabel,
  dbmText,
  filterClients,
  isWeak,
  lastValue,
  nextSort,
  radiosText,
  signalBars,
  signalTone,
} from './wireless';

function client(mac: string, over: Partial<WifiClient> = {}): WifiClient {
  return {
    mac,
    vendor: '',
    apId: 'a1',
    ap: 'ap-a',
    ssid: 'office',
    band: '5ghz-ax',
    signalDbm: -60,
    txRate: '',
    rxRate: '',
    uptimeS: 60,
    bytes: 0,
    ...over,
  };
}

const clients = [
  client('00:00:00:00:00:03', { ap: 'ap-b', apId: 'b1', signalDbm: -80, vendor: 'Acme' }),
  client('00:00:00:00:00:01', { signalDbm: -50, vendor: 'Example Corp' }),
  client('00:00:00:00:00:02', { signalDbm: null }),
  client('00:00:00:00:00:04', { ap: 'ap-b', apId: 'b1', signalDbm: -70 }),
];
const opts = { filter: 'all', q: '', sort: 'ap' as const, weakDbm: -75 };
const macs = (cs: WifiClient[]) => cs.map((c) => c.mac.slice(-2));

describe('bands and radios', () => {
  it('names bands from RouterOS words or the frequency', () => {
    expect(bandLabel('2ghz-n')).toBe('2.4 GHz');
    expect(bandLabel('5ghz-ac')).toBe('5 GHz');
    expect(bandLabel(undefined, 5180)).toBe('5 GHz');
    expect(bandLabel(undefined, 2412)).toBe('2.4 GHz');
    expect(bandLabel('60ghz')).toBe('60ghz');
    expect(bandLabel('')).toBe('');
  });

  it('lists radios lowest band first', () => {
    expect(
      radiosText([
        { interface: 'w2', band: '5ghz-ax', channel: 36, clients: 0, running: true },
        { interface: 'w1', band: '2ghz-ax', channel: 1, clients: 0, running: true },
      ]),
    ).toBe('2.4 GHz ch 1 · 5 GHz ch 36');
    expect(radiosText([])).toBe('');
  });
});

describe('signal', () => {
  it('colours weak below the line, near it a warning', () => {
    expect(signalTone(-76, -75)).toBe('critical');
    expect(signalTone(-75, -75)).toBe('warning');
    expect(signalTone(-68, -75)).toBe('warning');
    expect(signalTone(-67, -75)).toBe('ok');
    expect(signalTone(null, -75)).toBe('neutral');
    expect(dbmText(-58)).toBe('\u221258');
    expect(dbmText(3)).toBe('3');
    expect(isWeak({ signalDbm: -76 }, -75)).toBe(true);
    expect(isWeak({ signalDbm: null }, -75)).toBe(false);
  });

  it('gives bars like a phone', () => {
    expect([-50, -65, -70, -80, null].map(signalBars)).toEqual([4, 3, 2, 1, 0]);
  });
});

describe('clients table', () => {
  it('sorts by AP by default', () => {
    expect(macs(filterClients(clients, opts))).toEqual(['01', '02', '03', '04']);
  });

  it('filters weak clients and one AP', () => {
    expect(macs(filterClients(clients, { ...opts, filter: 'weak' }))).toEqual(['03']);
    expect(macs(filterClients(clients, { ...opts, filter: 'ap:b1' }))).toEqual(['03', '04']);
  });

  it('searches MAC or vendor, any case', () => {
    expect(macs(filterClients(clients, { ...opts, q: 'acme' }))).toEqual(['03']);
    expect(macs(filterClients(clients, { ...opts, q: ':04' }))).toEqual(['04']);
    expect(macs(filterClients(clients, { ...opts, q: '  ' }))).toHaveLength(4);
  });

  it('sorts by signal both ways, unknown last', () => {
    expect(macs(filterClients(clients, { ...opts, sort: 'signal-asc' }))).toEqual([
      '03',
      '04',
      '01',
      '02',
    ]);
    expect(macs(filterClients(clients, { ...opts, sort: 'signal-desc' }))).toEqual([
      '01',
      '04',
      '03',
      '02',
    ]);
    expect(nextSort('ap')).toBe('signal-asc');
    expect(nextSort('signal-asc')).toBe('signal-desc');
    expect(nextSort('signal-desc')).toBe('ap');
  });

  it('does not change the list it is given', () => {
    const before = macs(clients);
    filterClients(clients, { ...opts, sort: 'signal-desc' });
    expect(macs(clients)).toEqual(before);
  });

  it('makes one chip per AP, busiest first', () => {
    expect(apChips(clients)).toEqual([
      { id: 'a1', name: 'ap-a', n: 2 },
      { id: 'b1', name: 'ap-b', n: 2 },
    ]);
  });
});

describe('traffic', () => {
  it('finds the hour band and the last value', () => {
    const band = [
      { t: '2026-01-01T10:00:00.000Z', low: 1, high: 2, median: 1.5 },
      { t: '2026-01-01T11:00:00.000Z', low: 3, high: 4, median: 3.5 },
    ];
    expect(bandAt(band, Date.parse('2026-01-01T11:30:00Z'))?.low).toBe(3);
    expect(bandAt(band, Date.parse('2026-01-01T12:00:00Z'))).toBeNull();
    expect(
      lastValue([
        [1, 5],
        [2, null],
      ]),
    ).toEqual({ t: 1, v: 5 });
    expect(lastValue([])).toBeNull();
  });
});
