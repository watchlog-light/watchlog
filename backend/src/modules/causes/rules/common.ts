// SPDX-License-Identifier: AGPL-3.0-only
// What the object rules (slice 2) share: counts inside the window, terminations, exits,
// the subject's own changes before the symptom, and the objects their steps link to.
// Pure functions of an evidence snapshot.
import { HOST_FULL_RATIO } from '../checks.js';
import {
  COUNT_MS,
  type EvContainer,
  type EvCount,
  type EvEvent,
  type EvMarker,
  type EvPod,
  type EvPodContainer,
  type Evidence,
} from '../evidence.js';
import { containerObject, podObject } from '../resolve.js';
import type { ObjectRef } from '../types.js';

/** A cause this close to the symptom began with it (rank.ts uses the same 60 s). */
export const SAME_MS = 60_000;
/** Docker re-creates a container moments before its change marker (measured: ~13 s). */
export const RECREATE_SLACK_S = 180;
/** A pod created this long before a change still belongs to the new version (clock skew). */
export const ROLLOUT_SLACK_MS = 30_000;
/**
 * A rollout's pods are created within this time of it; pods created later (a scale-up, a
 * rescheduled pod) were not brought by the change.
 */
export const ROLLOUT_PODS_MS = 15 * 60_000;

export const iso = (unixS: number | null | undefined) =>
  unixS === null || unixS === undefined ? null : new Date(unixS * 1000).toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
export const earliest = (...times: (string | null | undefined)[]) =>
  times.filter((t): t is string => !!t && !Number.isNaN(Date.parse(t))).sort()[0] ?? null;

/**
 * When a failure of the object itself began: its earliest evidence. A loop that was already
 * going when the counted hour began may be older than its first restart in that hour: when
 * the hour starts after the symptom, a first restart after the symptom says nothing, so the
 * start is unknown (null), not "after the symptom".
 */
export function failureSince(ev: Evidence, ...times: (string | null | undefined)[]) {
  const s = earliest(...times);
  if (!s || !ev.symptomAt) return s;
  const symptom = ms(ev.symptomAt);
  return ms(s) > symptom + SAME_MS && countedFrom(ev) > symptom ? null : s;
}

/**
 * The focus's first back-off event in the window (any of a workload's pods): a crash loop's
 * start, also for pods that were replaced since.
 */
export function firstBackOff(ev: Evidence): EvEvent | null {
  return (
    ev.events
      .filter((e) => e.reason === 'BackOff' && e.type === 'Warning')
      .sort((a, b) => ms(a.firstSeen) - ms(b.firstSeen))[0] ?? null
  );
}

/** The metrics' hour, or when absent the last hour of the window. */
export function countedFrom(ev: Evidence): number {
  return ev.metrics ? ms(ev.metrics.from) : ms(ev.window.to) - COUNT_MS;
}

/** The snapshot's window ends now (a live problem), so "the last hour from now" fits it. */
const live = (ev: Evidence) => Math.abs(ev.now - ms(ev.window.to)) <= 2 * SAME_MS;

const ZERO: EvCount = { n: 0, first: null, last: null };

/** A pod's restarts in the counted hour; null when the metrics weren't read. */
export function podRestarts(ev: Evidence, p: EvPod): EvCount | null {
  if (!ev.metrics) return null;
  return ev.metrics.restarts[`${p.namespace}/${p.name}`] ?? ZERO;
}

/**
 * Without the metrics, a workload's own `restartsInRange` while the window ends now (it
 * covers the hour before now): the restarts of all its pods, a fallback for one of them.
 */
export function workloadRestarts(ev: Evidence): EvCount | null {
  const n = ev.workload?.restartsInRange;
  return !ev.metrics && live(ev) && typeof n === 'number' ? { n, first: null, last: null } : null;
}

/**
 * A container's restarts in the counted hour: the metrics, else the container's own
 * `restartsInRange` while the window ends now (it always covers the hour before now).
 */
export function containerRestarts(ev: Evidence, c: EvContainer): EvCount | null {
  if (ev.metrics) return ev.metrics.restarts[`${c.host}/${c.name}`] ?? ZERO;
  return live(ev) && c.restartsInRange !== null
    ? { n: c.restartsInRange, first: null, last: null }
    : null;
}

/** The container's own events (Docker events name the container and its host). */
export const containerEvents = (ev: Evidence, c: EvContainer) =>
  ev.events.filter((e) => e.involvedName === c.name && (!e.host || e.host === c.host));

export const podEvents = (ev: Evidence, p: EvPod) =>
  ev.events.filter((e) => e.involvedKind === 'Pod' && e.involvedName === p.name);

/**
 * Docker OOM kills in the counted hour: the oom-events counter; else the OOMKilled event's
 * count when all of it is inside the hour (Docker events are aggregated per container and
 * reason since the first one, so an older first one says nothing about the hour). Null when
 * the count isn't known.
 */
export function oomKills(ev: Evidence, c: EvContainer): EvCount | null {
  const counted = ev.metrics?.oomKills[`${c.host}/${c.name}`];
  if (counted) return counted;
  const from = countedFrom(ev);
  const e = containerEvents(ev, c).find((x) => x.reason === 'OOMKilled');
  if (e && ms(e.firstSeen) >= from)
    return {
      n: e.count,
      first: Math.floor(ms(e.firstSeen) / 1000),
      last: Math.floor(ms(e.lastSeen) / 1000),
    };
  return null;
}

/** One container termination of a pod: the current one or the last one. */
export interface Termination {
  container: string | null;
  reason: string;
  exitCode: number;
  finishedAt: string | null;
}

/**
 * A pod's terminations, newest first: from its containers when the detail was read (the
 * current terminated state, then the last termination), else the pod's summary.
 */
export function terminations(p: EvPod): Termination[] {
  const out: Termination[] = [];
  for (const c of p.containers ?? []) {
    if (c.init) continue;
    if (c.state === 'terminated' && c.reason)
      out.push({
        container: c.name,
        reason: c.reason,
        exitCode: c.exitCode ?? 0,
        finishedAt: null,
      });
    if (c.lastTermination)
      out.push({
        container: c.name,
        reason: c.lastTermination.reason,
        exitCode: c.lastTermination.exitCode,
        finishedAt: c.lastTermination.finishedAt,
      });
  }
  if (!out.length && p.lastTermination)
    out.push({
      container: p.lastTermination.container ?? null,
      reason: p.lastTermination.reason,
      exitCode: p.lastTermination.exitCode,
      finishedAt: p.lastTermination.finishedAt,
    });
  return out;
}

/**
 * The termination happened in the window: by its time, or (kind reports some without
 * finishedAt, slice 1) because the pod restarted in the counted hour or is failing now.
 */
export function recentTermination(ev: Evidence, p: EvPod, t: Termination): boolean {
  if (t.finishedAt) return ms(t.finishedAt) >= ms(ev.window.from);
  const r = podRestarts(ev, p);
  return (r ? r.n > 0 : p.restarts > 0) || !!p.failing;
}

/** A container of the pod (the detail's), by name, else the only one. */
export function podContainer(p: EvPod, name: string | null): EvPodContainer | undefined {
  const cs = (p.containers ?? []).filter((c) => !c.init);
  return cs.find((c) => c.name === name) ?? (cs.length === 1 ? cs[0] : undefined);
}

/** The memory limit of the container that was killed, else the pod's (one container). */
export function podMemoryLimit(p: EvPod, container: string | null): number | null {
  const c = podContainer(p, container);
  if (c) return c.memoryLimitBytes;
  return p.memoryLimitBytes;
}

/** The node under the pod is short of memory: an OOM there may be the node's, not the limit's. */
export function nodeShortOfMemory(ev: Evidence, node: string | null): boolean {
  const n = ev.nodes.find((x) => x.name === node);
  return !!n?.conditions.some((c) => c.type === 'MemoryPressure' && c.bad);
}

export function hostShortOfMemory(ev: Evidence, host: string): boolean {
  const h = ev.hosts.find((x) => x.name === host);
  return (h?.memoryUtilization ?? 0) >= HOST_FULL_RATIO;
}

/** "Exited with code 3" (Docker's Died event) → 3. */
export const diedCode = (e: EvEvent) => {
  const m = e.reason === 'Died' ? /code (\d+)/.exec(e.message) : null;
  return m ? Number(m[1]) : null;
};

/** A container's newest exit in the window: its Died event, else its own exited state. */
export function lastDockerExit(
  ev: Evidence,
  c: EvContainer,
): { exitCode: number; at: string | null } | null {
  const from = ms(ev.window.from);
  const died = containerEvents(ev, c).find((e) => diedCode(e) !== null && ms(e.lastSeen) >= from);
  if (died) return { exitCode: diedCode(died)!, at: died.lastSeen };
  if (c.state !== 'running' && c.finishedAt && ms(c.finishedAt) >= from)
    return { exitCode: c.exitCode, at: c.finishedAt };
  return null;
}

/** The working set of a container over the counted hour. */
export function memoryPoints(ev: Evidence, key: string): [number, number][] {
  return ev.metrics?.memory[key] ?? [];
}

/** Restart noise: the events every crash loop has, which say nothing more than the exit. */
const NOISE = new Set(['BackOff', 'Died', 'OOMKilled', 'Killing', 'Started', 'Created', 'Pulled']);

/** The newest warning event that says something the exit doesn't (a probe failing…). */
export function telling(events: EvEvent[], from: string): EvEvent | null {
  return (
    events.find(
      (e) =>
        e.type === 'Warning' &&
        !NOISE.has(e.reason) &&
        !/^Error: /.test(e.message) &&
        ms(e.lastSeen) >= ms(from),
    ) ?? null
  );
}

/** Changes that bring a new version: what bad_change and image_pull look for. */
export const VERSION_KINDS = ['image', 'recreate', 'rollout', 'compose'] as const;
const PREFER: Record<string, number> = { image: 0, recreate: 1, rollout: 2, compose: 3 };

/**
 * The subject's own version changes inside the window that did not come after the symptom,
 * newest first (an image change before a rollout of the same moment). Kubernetes: its
 * workload; Docker: its containers and their Compose projects. Never a node's.
 */
export function versionChanges(ev: Evidence): EvMarker[] {
  const until = ms(ev.symptomAt ?? ev.window.to) + SAME_MS;
  const from = ms(ev.window.from);
  return ev.changes
    .filter(
      (m) =>
        ev.ownTargets.includes(m.target) &&
        !m.target.startsWith('Node/') &&
        (VERSION_KINDS as readonly string[]).includes(m.kind) &&
        ms(m.ts) >= from &&
        ms(m.ts) <= until,
    )
    .sort((a, b) => ms(b.ts) - ms(a.ts) || (PREFER[a.kind] ?? 9) - (PREFER[b.kind] ?? 9));
}

/** A change marker as a chain's object (the change; `at` on the step). */
export function changeObject(ev: Evidence, m: EvMarker): ObjectRef {
  const parts = m.target.split('/');
  return {
    kind: 'change',
    ref: m.target,
    name: parts.length >= 3 ? parts.slice(-1)[0]! : (parts[1] ?? m.target),
    platform: ev.platform,
    workloadKind: parts[0],
    ...(ev.platform === 'docker' && parts.length >= 3 ? { host: parts[1] } : {}),
  };
}

/** Kubernetes image markers list `container=image`: one container reads as the image alone. */
export function images(v: unknown): string {
  const list = (Array.isArray(v) ? v : [v]).map(String);
  return list.length === 1 ? list[0]!.replace(/^[^=]+=/, '') : list.join(', ');
}

/** The step a version change adds: what changed, from the marker. */
export function changeStep(ev: Evidence, m: EvMarker) {
  const d = m.details as Record<string, unknown>;
  let code: string;
  let facts: Record<string, string | number | null>;
  switch (m.kind) {
    case 'image':
      code = 'changed_image';
      facts = { from: images(d.from), to: images(d.to) };
      break;
    case 'rollout':
      code = 'rolled_out';
      facts = { from: String(d.from ?? '?'), to: String(d.to ?? '?') };
      break;
    case 'recreate':
      code = 'recreated';
      facts = { image: String(d.image ?? '') || '?' };
      break;
    default:
      code = 'compose_up';
      facts = { project: m.target.split('/').slice(-1)[0]! };
  }
  return {
    object: changeObject(ev, m),
    source: 'change_marker' as const,
    code,
    facts,
    at: m.ts,
    since: null,
    next: null,
  };
}

export const podRef = (p: EvPod) => podObject(p.namespace, p.name);
export const containerRef = (c: EvContainer) => containerObject(c.host, c.name);
