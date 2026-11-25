// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// Is a recorder recording? (ADR-234) Three signals, each shown on its card:
//   1. the recorder's own state and events: a disk it can write to, and no storage or record
//      failure open on its event stream;
//   2. its iSCSI disk present and healthy (the disks it has had, remembered);
//   3. its write throughput toward the NAS inside its usual band (What changed's baseline), from
//      its switch port's traffic.
// Any one failing for 5 minutes marks it "not recording", naming the signal. A camera going
// offline isn't one of them: that is the camera's alert. Pure: no clock, no I/O.
import type { Recorder, RecorderDisk } from './report.js';

export const NOT_RECORDING_MS = 5 * 60_000;
/** Signal 3 fails only well under the usual: below the band and under half the usual median. */
export const RATE_SHARE = 0.5;
/** A disk with less than this share free is full: the recorder overwrites its oldest footage. */
export const FULL_SHARE = 0.01;

export type SignalKey = 'recorder' | 'disk' | 'rate';
export const SIGNALS: readonly SignalKey[] = ['recorder', 'disk', 'rate'];

/** One signal now: ok, failing, or unknown (no data yet, learning), with why. */
export interface Signal {
  ok: boolean | null;
  why: string;
  /** Failing since (ms), while it fails. */
  since: number | null;
}

/** What a recorder's row keeps (`network_devices.recording`). */
export interface RecordingState {
  signals: Record<SignalKey, Signal>;
  /** False once a signal has failed for 5 minutes; null before anything is known. */
  recording: boolean | null;
  /** The signals that have failed for 5 minutes. */
  failed: SignalKey[];
  /** Not recording since (ms). */
  since: number | null;
  /** The iSCSI disks it has had: one missing later is lost, not "never had". */
  iscsi: string[];
  /** The write rate now (bytes a second) and its usual band, where known. */
  rate?: number | null;
  /**
   * The write rate averaged over the last hour, which "days of recording left" divides by; null
   * until an hour of its port's traffic exists (1.0.0): the instant rate after a restart of the
   * recorder or the poller said "0 days".
   */
  rateHour?: number | null;
  usual?: { low: number; high: number; median: number } | null;
  /** Where the rate is read: the recorder's switch port, or the NAS's. */
  rateFrom?: { device: string; port: string; side: 'recorder' | 'nas' } | null;
  at: number;
}

/** Event codes that say the recorder can't write (its own words, eventManager attach). */
const FAILURE_CODES: Record<string, string> = {
  StorageFailure: 'it reports a storage failure',
  StorageNotExist: 'it reports a disk missing',
  RecordFailure: 'it reports a record failure',
  StorageAbnormal: 'it reports a storage error',
};

/** Signal 1: a healthy disk to write to, and no failure open on its event stream. */
export function recorderSignal(r: Recorder): Pick<Signal, 'ok' | 'why'> {
  const open = (r.active ?? []).find((e) => FAILURE_CODES[e.code]);
  if (open) return { ok: false, why: FAILURE_CODES[open.code]! };
  if (!r.disks.length) return { ok: false, why: 'it reports no disks' };
  if (!r.disks.some((d) => d.healthy)) return { ok: false, why: 'none of its disks is healthy' };
  return {
    ok: true,
    why: r.stream ? 'its disks are healthy, no failure events' : 'its disks are healthy',
  };
}

/** Signal 2: each iSCSI disk it has had is there and healthy. */
export function diskSignal(
  r: Recorder,
  known: string[],
): Pick<Signal, 'ok' | 'why'> & { iscsi: string[] } {
  const now = r.disks.filter((d) => d.iscsi);
  const iscsi = [...new Set([...known, ...now.map((d) => d.name)])].sort();
  if (!iscsi.length) return { ok: null, why: 'no iSCSI disk: it records to its own disks', iscsi };
  const byName = new Map(now.map((d) => [d.name, d]));
  const missing = iscsi.filter((n) => !byName.has(n));
  if (missing.length) return { ok: false, why: `its iSCSI disk ${missing[0]} is gone`, iscsi };
  const bad = now.find((d) => !d.healthy);
  if (bad)
    return { ok: false, why: `its iSCSI disk ${bad.name} is ${bad.state || 'not healthy'}`, iscsi };
  return {
    ok: true,
    why: now.length === 1 ? `${now[0]!.name} is healthy` : `${now.length} iSCSI disks healthy`,
    iscsi,
  };
}

/** Signal 3: the write rate against its usual band; unknown while learning or unmeasured. */
export function rateSignal(
  rate: number | null,
  usual: { low: number; median: number; learning?: boolean } | null,
): Pick<Signal, 'ok' | 'why'> {
  if (rate === null) return { ok: null, why: 'no switch port known for it yet' };
  if (!usual || usual.learning) return { ok: null, why: 'learning its usual rate' };
  if (rate < usual.low && rate < RATE_SHARE * usual.median)
    return { ok: false, why: `writing ${rateText(rate)}, usually ${rateText(usual.median)}` };
  return { ok: true, why: `writing ${rateText(rate)}, usually ${rateText(usual.median)}` };
}

export function rateText(bps: number): string {
  const bits = bps * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gb/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
  if (bits >= 1e3) return `${Math.round(bits / 1e3)} kb/s`;
  return `${Math.round(bits)} b/s`;
}

/** The next state from the last one and the signals now: since when each fails, the 5 minutes. */
export function stepRecording(
  prev: Partial<RecordingState> | null | undefined,
  now: Record<SignalKey, Pick<Signal, 'ok' | 'why'>>,
  at: number,
  extra: Partial<RecordingState> = {},
): RecordingState {
  const signals = {} as Record<SignalKey, Signal>;
  const failed: SignalKey[] = [];
  for (const k of SIGNALS) {
    const s = now[k];
    const before = prev?.signals?.[k];
    const since =
      s.ok === false ? (before?.ok === false && before.since ? before.since : at) : null;
    signals[k] = { ok: s.ok, why: s.why, since };
    if (since !== null && at - since >= NOT_RECORDING_MS) failed.push(k);
  }
  const known = SIGNALS.some((k) => signals[k].ok !== null);
  const recording = failed.length ? false : known ? true : null;
  const since = failed.length
    ? prev?.recording === false && prev.since
      ? prev.since
      : Math.min(...failed.map((k) => signals[k].since!)) + NOT_RECORDING_MS
    : null;
  return { iscsi: prev?.iscsi ?? [], ...extra, signals, recording, failed, since, at };
}

/**
 * The write rate "days of recording left" divides by: the hour's average, and only once the
 * port's series is an hour old (`samplesAnHourAgo`: how many of its samples lie 55 to 65 minutes
 * back). Before that it is null, "calculating": a rate over the first minutes after a recorder
 * was added, or after the poller came back, isn't a day's rate.
 */
export function hourRateOf(
  hourRate: number | null | undefined,
  samplesAnHourAgo: number | null | undefined,
): number | null {
  if (!samplesAnHourAgo || hourRate == null || !Number.isFinite(hourRate)) return null;
  return Math.max(0, hourRate);
}

/** The disks its footage goes to: its iSCSI disks, or all when it has none. */
export function recordingDisks(disks: RecorderDisk[]): RecorderDisk[] {
  const iscsi = disks.filter((d) => d.iscsi);
  return iscsi.length ? iscsi : disks;
}

/**
 * Days of recording left: free space / the write rate averaged over the last hour. A full disk
 * (under 1% free) is overwriting its oldest footage, the way recorders are usually set: no
 * countdown. `calculating` while the hour's rate isn't known yet (its port has less than an hour
 * of traffic): never a number from a few minutes' rate. A recorder that wrote nothing in the
 * hour has no countdown either (`days` null, not calculating).
 */
export function daysLeft(
  disks: RecorderDisk[],
  rateHourBps: number | null | undefined,
): { days: number | null; full: boolean; calculating: boolean; free: number; total: number } {
  const ds = recordingDisks(disks).filter((d) => d.healthy);
  const total = ds.reduce((s, d) => s + d.total, 0);
  const free = ds.reduce((s, d) => s + Math.max(0, d.total - d.used), 0);
  const none = { days: null, full: false, calculating: false, free, total };
  if (!total) return none;
  if (free / total < FULL_SHARE) return { ...none, full: true };
  if (rateHourBps == null) return { ...none, calculating: true };
  if (rateHourBps <= 0) return none;
  return { ...none, days: free / rateHourBps / 86_400 };
}

/** The words for a recorder not recording: "its iSCSI disk iscsi0 is gone". */
export function notRecordingWhy(s: Pick<RecordingState, 'signals' | 'failed'>): string {
  return s.failed.map((k) => s.signals[k].why).join(' · ');
}
