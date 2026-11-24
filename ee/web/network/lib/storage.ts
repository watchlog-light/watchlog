// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The Storage page's arithmetic (ADR-234): recording states, days of recording left, the NAS's
// words as tones, and a UPS's feeds grouped by place.
import type { RecorderCard, RecordingSignal } from '../api';
import type { Tone } from './wireless';

export type { Tone };

export function recordingState(r: Pick<RecorderCard, 'recording'>): 'yes' | 'no' | 'unknown' {
  return r.recording == null ? 'unknown' : r.recording ? 'yes' : 'no';
}

export function signalState(s: Pick<RecordingSignal, 'ok'>): 'true' | 'false' | 'unknown' {
  return s.ok == null ? 'unknown' : s.ok ? 'true' : 'false';
}

/**
 * Days of recording left as words: the i18n key under netStorage.daysLeft and its count.
 * Full: overwriting its oldest footage. Unknown: no disk or no write rate.
 */
export function daysLeftWords(r: Pick<RecorderCard, 'daysLeft' | 'full'>): {
  key: 'full' | 'unknown' | 'underDay' | 'days';
  n: number;
} {
  if (r.full) return { key: 'full', n: 0 };
  if (r.daysLeft == null) return { key: 'unknown', n: 0 };
  if (r.daysLeft < 1) return { key: 'underDay', n: 0 };
  return { key: 'days', n: Math.floor(r.daysLeft) };
}

/** A disk's SMART word: good ok, warning a warning, abnormal or error critical. */
export function smartTone(smart: string): Tone {
  const s = smart.trim().toLowerCase();
  if (s === 'good' || s === 'ok' || s === 'normal') return 'ok';
  if (s === 'warning') return 'warning';
  if (s === 'abnormal' || s === 'error' || s === 'bad' || s === 'failed') return 'critical';
  return 'neutral';
}

/** A volume's or pool's state: Ready ok, Rebuilding a warning, Degraded (or worse) critical. */
export function volumeTone(status: string): Tone {
  const s = status.trim().toLowerCase();
  if (/^(ready|normal|ok|good|healthy)$/.test(s)) return 'ok';
  if (/rebuild|sync|migrat|expand|initiali/.test(s)) return 'warning';
  if (/degrad|fail|crash|error|not active|inactive|abnormal|read.?only/.test(s)) return 'critical';
  return 'neutral';
}

/** A UPS's status: online ok, on battery critical, bypass a warning, off a warning. */
export function upsTone(status: string | undefined): Tone {
  switch (status) {
    case 'online':
      return 'ok';
    case 'on-battery':
      return 'critical';
    case 'bypass':
    case 'off':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** Used share 0..1 of something with a total and a free part; null without a total. */
export function usedShare(total: number, free: number): number | null {
  if (!total || total <= 0) return null;
  return Math.min(1, Math.max(0, (total - free) / total));
}

/** The write rate against its usual band: below, inside or above; null when either is unknown. */
export function rateAgainstUsual(
  rate: number | null,
  usual: { low: number; high: number } | null,
): 'below' | 'inside' | 'above' | null {
  if (rate == null || !usual) return null;
  if (rate < usual.low) return 'below';
  if (rate > usual.high) return 'above';
  return 'inside';
}

/** Fans or power supplies whose state isn't plainly fine. */
export function failing<T extends { state: string }>(parts: T[]): T[] {
  return parts.filter((p) => !/^(ok|normal|good|on|running|present)$/i.test(p.state.trim()));
}

export interface FeedHost {
  clusterId: string;
  cluster: string;
  kind: string;
  node: string;
}

export const feedKey = (f: { clusterId: string; node: string }) => `${f.clusterId}/${f.node}`;

/** The hosts a UPS can feed, grouped by cluster or fleet, both sorted by name. */
export function feedGroups(
  hosts: FeedHost[],
): { clusterId: string; cluster: string; kind: string; nodes: string[] }[] {
  const m = new Map<
    string,
    { clusterId: string; cluster: string; kind: string; nodes: string[] }
  >();
  for (const h of hosts) {
    const g = m.get(h.clusterId) ?? {
      clusterId: h.clusterId,
      cluster: h.cluster,
      kind: h.kind,
      nodes: [],
    };
    if (!g.nodes.includes(h.node)) g.nodes.push(h.node);
    m.set(h.clusterId, g);
  }
  const out = [...m.values()].sort((a, b) => a.cluster.localeCompare(b.cluster));
  for (const g of out) g.nodes.sort((a, b) => a.localeCompare(b));
  return out;
}

/** Minutes of runtime from seconds, rounded down; null when unknown. */
export const runtimeMinutes = (s: number | undefined) => (s == null ? null : Math.floor(s / 60));
