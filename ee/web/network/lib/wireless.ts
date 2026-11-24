// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The Wireless page's arithmetic (ADR-234): radios as words, signal tones, and the clients
// table's filter, search and sort.
import type { Radio, WifiClient } from '../api';

export type Tone = 'ok' | 'warning' | 'critical' | 'neutral';

/** "2.4 GHz", "5 GHz", "6 GHz" from RouterOS's band ("2ghz-ax") or the frequency. */
export function bandLabel(band?: string | null, frequencyMhz?: number | null): string {
  const b = (band ?? '').toLowerCase();
  const f = frequencyMhz ?? 0;
  if (/^2(\.4)?ghz/.test(b) || (!b && f >= 2400 && f < 2500)) return '2.4 GHz';
  if (/^5ghz/.test(b) || (!b && f >= 5000 && f < 5925)) return '5 GHz';
  if (/^6ghz/.test(b) || (!b && f >= 5925 && f < 7200)) return '6 GHz';
  return band ?? '';
}

/** "2.4 GHz ch 1 · 5 GHz ch 36", lowest band first. */
export function radiosText(radios: Radio[]): string {
  return radios
    .map((r) => ({
      band: bandLabel(r.band, r.frequencyMhz),
      text: [bandLabel(r.band, r.frequencyMhz), r.channel != null ? `ch ${r.channel}` : '']
        .filter(Boolean)
        .join(' '),
    }))
    .filter((r) => r.text)
    .sort((a, b) => parseFloat(a.band) - parseFloat(b.band) || a.text.localeCompare(b.text))
    .map((r) => r.text)
    .join(' · ');
}

/** "−58": dBm with a real minus sign. */
export const dbmText = (n: number) => String(n).replace('-', '\u2212');

export const isWeak = (c: Pick<WifiClient, 'signalDbm'>, weakDbm: number) =>
  c.signalDbm != null && c.signalDbm < weakDbm;

/** Below the weak line critical, within 8 dB above it a warning, stronger ok. */
export function signalTone(dbm: number | null | undefined, weakDbm: number): Tone {
  if (dbm == null) return 'neutral';
  if (dbm < weakDbm) return 'critical';
  if (dbm < weakDbm + 8) return 'warning';
  return 'ok';
}

/** 0–4 bars, as a phone shows them. */
export function signalBars(dbm: number | null | undefined): number {
  if (dbm == null) return 0;
  if (dbm > -60) return 4;
  if (dbm > -67) return 3;
  if (dbm > -75) return 2;
  return 1;
}

/** "all", "weak", or "ap:<id>" (an access point's clients; "ap:" for clients with no AP id). */
export type ClientFilter = string;
export type ClientSort = 'ap' | 'signal-asc' | 'signal-desc';

/** The sort control's next state: weakest first, then strongest first, then back to by AP. */
export function nextSort(s: ClientSort): ClientSort {
  return s === 'ap' ? 'signal-asc' : s === 'signal-asc' ? 'signal-desc' : 'ap';
}

export function filterClients(
  clients: WifiClient[],
  opts: { filter: ClientFilter; q: string; sort: ClientSort; weakDbm: number },
): WifiClient[] {
  const q = opts.q.trim().toLowerCase();
  const out = clients.filter((c) => {
    if (opts.filter === 'weak' && !isWeak(c, opts.weakDbm)) return false;
    if (opts.filter.startsWith('ap:') && (c.apId ?? '') !== opts.filter.slice(3)) return false;
    if (q && !c.mac.toLowerCase().includes(q) && !(c.vendor ?? '').toLowerCase().includes(q))
      return false;
    return true;
  });
  const byAp = (a: WifiClient, b: WifiClient) =>
    a.ap.localeCompare(b.ap) || a.mac.localeCompare(b.mac);
  if (opts.sort === 'ap') return out.sort(byAp);
  const dir = opts.sort === 'signal-asc' ? 1 : -1;
  return out.sort((a, b) => {
    // Unknown signal last, either way.
    if (a.signalDbm == null || b.signalDbm == null)
      return a.signalDbm == null ? (b.signalDbm == null ? byAp(a, b) : 1) : -1;
    return (a.signalDbm - b.signalDbm) * dir || byAp(a, b);
  });
}

/** The chips: one per access point with clients, busiest first. */
export function apChips(clients: WifiClient[]): { id: string; name: string; n: number }[] {
  const m = new Map<string, { id: string; name: string; n: number }>();
  for (const c of clients) {
    const id = c.apId ?? '';
    const e = m.get(id) ?? { id, name: c.ap, n: 0 };
    e.n++;
    m.set(id, e);
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/** The band entry (hourly) that covers `atMs`, or null. */
export function bandAt<T extends { t: string }>(
  band: T[],
  atMs: number,
  stepMs = 3_600_000,
): T | null {
  for (const b of band) {
    const t = Date.parse(b.t);
    if (atMs >= t && atMs < t + stepMs) return b;
  }
  return null;
}

/** The last non-null point of a series ([ms, value]). */
export function lastValue(points: [number, number | null][]): { t: number; v: number } | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const [t, v] = points[i]!;
    if (v != null) return { t, v };
  }
  return null;
}
