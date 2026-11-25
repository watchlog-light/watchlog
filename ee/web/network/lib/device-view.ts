// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// What a device's page shows (0.17.1): a tile or chart only for what the device reports, from its
// data and its source, never an empty chart for a metric it can't have. Switches and routers
// (SNMP, RouterOS) report CPU, memory, temperature and ports when their profile reads them; an
// access point read through CAPsMAN reports its clients and radios instead; a UPS its charge,
// runtime and load; a recorder whether it records, its cameras and the days left.
import type { Device, DeviceDetail, DeviceSeries, Radio } from '../api';

export type TileKey =
  | 'cpu'
  | 'memory'
  | 'temperature'
  | 'ports'
  | 'power'
  | 'fans'
  | 'poe'
  | 'routes'
  | 'clients'
  | 'radios'
  | 'weak'
  | 'charge'
  | 'runtime'
  | 'load'
  | 'recording'
  | 'cameras'
  | 'daysLeft'
  | 'uptime';

export type ChartKey =
  'cpu' | 'memory' | 'temperature' | 'clients' | 'charge' | 'runtime' | 'load' | 'camerasOnline';

export interface TileSpec {
  key: TileKey;
  /** What the tile shows, unformatted: the page words it. */
  value: number | string | boolean | null;
  /** A second number for "x / y" tiles. */
  of?: number;
  extra?: number | string | null;
}

/** "2.4 GHz ch 1 · 5 GHz ch 36". */
export function radiosText(radios: Radio[]): string {
  return radios
    .map((r) => {
      const band = (r.band ?? '').startsWith('2')
        ? '2.4 GHz'
        : (r.band ?? '').startsWith('5')
          ? '5 GHz'
          : (r.band ?? '').startsWith('6')
            ? '6 GHz'
            : r.frequencyMhz
              ? `${(r.frequencyMhz / 1000).toFixed(1)} GHz`
              : '';
      return [band, r.channel ? `ch ${r.channel}` : ''].filter(Boolean).join(' ');
    })
    .filter(Boolean)
    .join(' · ');
}

/** Whether the device is read through its controller (an access point under CAPsMAN). */
export const throughController = (d: DeviceDetail['device']): boolean =>
  d.protocol === 'capsman' || (d.kind === 'ap' && d.managedAp && !!d.parentId);

export function deviceTiles(detail: DeviceDetail): TileSpec[] {
  const d = detail.device;
  const k = detail.kind ?? {};
  if (throughController(d)) {
    const ap = k.ap;
    return [
      { key: 'clients', value: ap?.clients ?? null },
      { key: 'radios', value: ap ? radiosText(ap.radios) || null : null },
      { key: 'weak', value: ap?.weak ?? null, extra: ap?.weakDbm ?? null },
    ];
  }
  const out: TileSpec[] = [];
  if (k.recorder) {
    out.push(
      { key: 'recording', value: k.recorder.recording },
      { key: 'cameras', value: k.recorder.camerasOnline, of: k.recorder.camerasTotal },
      {
        key: 'daysLeft',
        value: k.recorder.full
          ? 'full'
          : k.recorder.daysCalculating
            ? 'calculating'
            : k.recorder.daysLeft,
      },
    );
  }
  if (k.ups) {
    out.push(
      { key: 'charge', value: k.ups.chargePercent ?? null },
      { key: 'runtime', value: k.ups.runtimeS ?? null },
      { key: 'load', value: k.ups.loadPercent ?? null },
    );
  }
  if (d.cpu != null) out.push({ key: 'cpu', value: d.cpu });
  if (d.memory != null) out.push({ key: 'memory', value: d.memory });
  if (d.temperature != null) {
    const hot = detail.health.sensors.find((s) => s.threshold != null);
    out.push({ key: 'temperature', value: d.temperature, extra: hot?.threshold ?? null });
  }
  if (d.portsTotal) out.push({ key: 'ports', value: d.portsUp ?? 0, of: d.portsTotal });
  const okOf = (xs: { state: string }[]) =>
    xs.filter((x) => ['ok', 'normal', 'up', 'good'].includes(x.state.toLowerCase())).length;
  if (detail.health.psus.length)
    out.push({ key: 'power', value: okOf(detail.health.psus), of: detail.health.psus.length });
  if (detail.health.fans.length)
    out.push({ key: 'fans', value: okOf(detail.health.fans), of: detail.health.fans.length });
  const poe = detail.ports.reduce((n, p) => n + (p.poeWatts ?? 0), 0);
  if (poe > 0) out.push({ key: 'poe', value: poe });
  if (d.routes != null) out.push({ key: 'routes', value: d.routes, extra: d.gateway });
  return out;
}

/**
 * The map's side panel (1.0.0): at most four tiles, by the same rule as the device's page. With
 * the device's detail, its kind's own tiles first (a recorder: recording, cameras, the recording
 * left; a UPS: charge, runtime, load; an access point: clients, radios, weak clients), then what
 * else it reports, then how long it has been up. Before the detail arrives, only what the map
 * itself knows and the device reports. Never a tile with "–" for a fact it can't have.
 */
export function panelTiles(
  d: Pick<Device, 'cpu' | 'memory' | 'portsUp' | 'portsTotal' | 'uptimeS'>,
  detail: DeviceDetail | null,
): TileSpec[] {
  const out: TileSpec[] = detail ? deviceTiles(detail) : [];
  if (!detail) {
    if (d.cpu != null) out.push({ key: 'cpu', value: d.cpu });
    if (d.memory != null) out.push({ key: 'memory', value: d.memory });
    if (d.portsTotal) out.push({ key: 'ports', value: d.portsUp ?? 0, of: d.portsTotal });
  }
  const up = detail?.device.uptimeS ?? d.uptimeS;
  const tiles = out.filter((x) => x.value != null).slice(0, up != null ? 3 : 4);
  if (up != null) tiles.push({ key: 'uptime', value: up });
  return tiles;
}

/** The facts worth a row: one with no value isn't shown ("Uptime –" on a recorder). */
export function withValue<T extends { value: string | null | undefined }>(rows: T[]): T[] {
  return rows.filter((r) => r.value != null && r.value.trim() !== '' && r.value.trim() !== '–');
}

/** The charts: the device's reported metrics only. */
export function deviceCharts(detail: DeviceDetail): ChartKey[] {
  const d = detail.device;
  const k = detail.kind ?? {};
  if (throughController(d)) return ['clients'];
  const out: ChartKey[] = [];
  if (k.ups) out.push('charge', 'load', 'runtime');
  if (k.recorder) out.push('camerasOnline');
  if (d.cpu != null) out.push('cpu');
  if (d.memory != null) out.push('memory');
  if (d.temperature != null) out.push('temperature');
  return out;
}

/** A chart's points from the series answer. */
export function chartPoints(s: DeviceSeries | null, key: ChartKey): DeviceSeries['cpu'] {
  if (!s) return [];
  if (key === 'cpu' || key === 'memory' || key === 'temperature') return s[key] ?? [];
  return s.kind?.[key] ?? [];
}
