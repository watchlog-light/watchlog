// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// Numbers as the network pages show them.
import type { DeviceKind, DeviceStatus } from '../api';

export function speedText(mbps: number | null | undefined): string {
  if (!mbps) return '–';
  if (mbps >= 1000) return `${Number((mbps / 1000).toFixed(1))}G`;
  return `${mbps}M`;
}

/** "1 Gb/s", "100 Mb/s". */
export function speedLong(mbps: number | null | undefined): string {
  if (!mbps) return '–';
  if (mbps >= 1000) return `${Number((mbps / 1000).toFixed(1))} Gb/s`;
  return `${mbps} Mb/s`;
}

/** Bits per second: "4.2 Gb/s", "310 Mb/s", "12 kb/s". */
export function bpsText(bps: number | null | undefined): string {
  if (bps == null) return '–';
  if (bps >= 1e9) return `${Number((bps / 1e9).toFixed(1))} Gb/s`;
  if (bps >= 1e6) return `${Math.round(bps / 1e6)} Mb/s`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} kb/s`;
  return `${Math.round(bps)} b/s`;
}

export const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);

/** "42d 3h", "5h 12m", "9m". */
export function uptimeText(s: number | null | undefined): string {
  if (s == null) return '–';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** A device's status as a tone: up, warning (an alert open), down, or not polled yet. */
export function statusTone(
  s: DeviceStatus,
  openAlerts = 0,
): 'ok' | 'warning' | 'critical' | 'neutral' {
  if (s === 'pending') return 'neutral';
  if (s !== 'ok') return 'critical';
  return openAlerts > 0 ? 'warning' : 'ok';
}

/** The map's band for a kind (ADR-233): Internet, Edge, Core, Access, Devices. */
export function bandOf(
  kind: DeviceKind | 'internet' | 'server' | 'node' | 'endpoint',
): 0 | 1 | 2 | 3 | 4 {
  switch (kind) {
    case 'internet':
      return 0;
    case 'router':
    case 'firewall':
      return 1;
    case 'l3switch':
      return 2;
    case 'switch':
      return 3;
    default:
      return 4;
  }
}
