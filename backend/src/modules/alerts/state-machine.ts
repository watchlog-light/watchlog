// SPDX-License-Identifier: AGPL-3.0-only
// The alert state machine (ADR-076) with silences (ADR-077). Pure: the engine loads
// episodes and observations, calls step() once per fingerprint and cycle, and
// persists the result. Times are milliseconds since the epoch.

export type Severity = 'warning' | 'critical';
export type NotifyKind = 'firing' | 'resolved' | 'renotify' | 'escalated' | 'flapping';

/** A condition that holds now for one fingerprint. Fingerprints not observed are false. */
export interface Observation {
  fingerprint: string;
  severity: Severity;
  labels: Record<string, string>;
  details: Record<string, unknown>;
  /** Since when the condition holds, when the data says (a condition's transition time). */
  since?: number;
}

export interface Episode {
  state: 'pending' | 'firing' | 'resolved';
  severity: Severity;
  labels: Record<string, string>;
  details: Record<string, unknown>;
  startedAt: number;
  firedAt: number | null;
  resolvedAt: number | null;
  falseSince: number | null;
  falseCycles: number;
  lastNotifiedAt: number | null;
  notifiedFiring: boolean;
  silenced: boolean;
  flapping: boolean;
  notifySeq: number;
}

export interface StepContext {
  now: number;
  forMs: number;
  /** 0: never re-notify. */
  renotifyMs: number;
  /** Whether an active silence matches the episode's labels and severity. */
  silenced: (labels: Record<string, string>, severity: Severity) => boolean;
  /** Episodes of this fingerprint that fired within FLAP_WINDOW_MS before now. */
  recentFirings: number;
}

export type StepResult =
  | { action: 'none' }
  | { action: 'delete' }
  | { action: 'insert' | 'update'; episode: Episode; notify: NotifyKind | null };

/** Consecutive false cycles before an alert resolves. */
export const RESOLVE_CYCLES = 2;
export const FLAP_WINDOW_MS = 30 * 60_000;
/** The episode that makes this many firings within the window is flapping. */
export const FLAP_FIRINGS = 3;
/** A flapping alert resolves only after its condition was false this long. */
export const FLAP_QUIET_MS = 15 * 60_000;

const RANK: Record<Severity, number> = { warning: 1, critical: 2 };

export function step(prev: Episode | null, obs: Observation | null, ctx: StepContext): StepResult {
  const { now } = ctx;
  if (!obs) {
    if (!prev) return { action: 'none' };
    if (prev.state === 'pending') return { action: 'delete' };
    if (prev.state === 'resolved') return { action: 'none' };
    const ep: Episode = {
      ...prev,
      falseCycles: prev.falseCycles + 1,
      falseSince: prev.falseSince ?? now,
    };
    const quietEnough = !ep.flapping || now - ep.falseSince! >= FLAP_QUIET_MS;
    if (ep.falseCycles < RESOLVE_CYCLES || !quietEnough) {
      return { action: 'update', episode: ep, notify: null };
    }
    ep.state = 'resolved';
    ep.resolvedAt = now;
    ep.silenced = ctx.silenced(ep.labels, ep.severity);
    const notify = ep.notifiedFiring && !ep.silenced ? 'resolved' : null;
    return { action: 'update', episode: notify ? notified(ep, now) : ep, notify };
  }

  const isNew = !prev || prev.state === 'resolved';
  const ep: Episode = isNew
    ? {
        state: 'pending',
        severity: obs.severity,
        labels: obs.labels,
        details: obs.details,
        startedAt: Math.min(now, obs.since ?? now),
        firedAt: null,
        resolvedAt: null,
        falseSince: null,
        falseCycles: 0,
        lastNotifiedAt: null,
        notifiedFiring: false,
        silenced: false,
        flapping: false,
        notifySeq: 0,
      }
    : { ...prev!, labels: obs.labels, details: obs.details, falseSince: null, falseCycles: 0 };
  const action = isNew ? 'insert' : 'update';
  const silenced = ctx.silenced(obs.labels, obs.severity);

  if (ep.state === 'pending') {
    ep.severity = obs.severity;
    if (now - ep.startedAt < ctx.forMs) return { action, episode: ep, notify: null };
    ep.state = 'firing';
    ep.firedAt = now;
    ep.flapping = ctx.recentFirings + 1 >= FLAP_FIRINGS;
    ep.silenced = silenced;
    if (silenced) return { action, episode: ep, notify: null };
    const notify = ep.flapping ? 'flapping' : 'firing';
    return { action, episode: notified({ ...ep, notifiedFiring: true }, now), notify };
  }

  // Firing.
  const escalated = RANK[obs.severity] > RANK[ep.severity];
  ep.severity = obs.severity;
  ep.silenced = silenced;
  if (silenced) return { action, episode: ep, notify: null };
  let notify: NotifyKind | null = null;
  if (!ep.notifiedFiring) {
    // Fired while silenced and the silence has ended (ADR-077).
    notify = ep.flapping ? 'flapping' : 'firing';
    ep.notifiedFiring = true;
  } else if (ep.flapping) {
    notify = null;
  } else if (escalated) {
    notify = 'escalated';
  } else if (
    ctx.renotifyMs > 0 &&
    ep.lastNotifiedAt !== null &&
    now - ep.lastNotifiedAt >= ctx.renotifyMs
  ) {
    notify = 'renotify';
  }
  return { action, episode: notify ? notified(ep, now) : ep, notify };
}

function notified(ep: Episode, now: number): Episode {
  return { ...ep, lastNotifiedAt: now, notifySeq: ep.notifySeq + 1 };
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return RANK[a] >= RANK[b] ? a : b;
}
