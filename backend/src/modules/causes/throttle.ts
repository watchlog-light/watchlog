// SPDX-License-Identifier: AGPL-3.0-only
// CPU throttling of the focus (slice 4, cpu_throttled and the "CPU" check). The agent records
// only throttled seconds (watchlog_container_cpu_throttled_seconds_total), no CFS periods
// (slice 0, gap 6), so the share of the time a container is throttled is its throttled
// seconds a second, at most 1: exact for a single-threaded process, an overstatement for one
// whose threads are throttled on several CPUs at once (ADR-154). Pure.
import { runFromTolerant } from './counts.js';
import type { EvContainer, EvPod, Evidence } from './evidence.js';
import { containerObject, podObject } from './resolve.js';
import type { ObjectRef } from './types.js';

/** Throttled for this share of the time or more is a cause (ADR-150, as the default alert). */
export const THROTTLED_SHARE = 0.25;
/** The share now: the mean of the series' last 5 minutes (its newest point lags about a minute). */
const RECENT_S = 5 * 60;
/** Points a throttled minute is judged on (15 s apart). */
const SMOOTH = 4;
/**
 * A dipped minute inside a run doesn't end it (ADR-157 amends ADR-154): on a busy node one
 * scrape's rate falls to a quarter, pulling a minute's mean under the bar, and the throttling
 * then looked newer than the slowdown it explains.
 */
export const THROTTLE_DIP_S = 60;

export interface Throttling {
  /** The pod or container. */
  object: ObjectRef;
  /** The container's name (Kubernetes: the container in the pod; Docker: the container). */
  container: string;
  /** Throttled share of the time now, 0…1. */
  share: number;
  /** When the current run at or above THROTTLED_SHARE began (ISO); null before the hour or unknown. */
  since: string | null;
  /** The container's CPU limit, when known. */
  limitCores: number | null;
}

/** Whether the focus runs with a CPU limit (the only way to be throttled). */
export function hasCpuLimit(ev: Evidence): boolean {
  return ev.platform === 'docker'
    ? ev.containers.some((c) => c.cpuLimitCores !== null && c.cpuLimitCores > 0)
    : ev.pods.some(
        (p) =>
          (p.cpuLimitCores ?? 0) > 0 ||
          (p.containers ?? []).some((c) => (c.cpuLimitCores ?? 0) > 0),
      );
}

/** A Kubernetes container's CPU limit: its own (pod detail), else the pod's when it has one container. */
function podCpuLimit(p: EvPod, container: string): number | null {
  const c = (p.containers ?? []).find((x) => x.name === container && !x.init);
  if (c) return c.cpuLimitCores;
  return p.totalContainers === 1 || (p.containers ?? []).filter((x) => !x.init).length === 1
    ? p.cpuLimitCores
    : null;
}

/** Every container of the focus with its throttled share now, most throttled first. */
export function throttlings(ev: Evidence): Throttling[] | null {
  const series = ev.metrics?.cpuThrottled;
  if (!series) return null;
  const hourFrom = Date.parse(ev.metrics!.from) / 1000;
  const step = ev.metrics!.step;
  const out: Throttling[] = [];
  for (const [key, points] of Object.entries(series)) {
    if (!points.length) continue;
    const last = points[points.length - 1]![0];
    const recent = points.filter(([t]) => t > last - RECENT_S);
    const share = recent.reduce((n, [, v]) => n + Math.min(1, v), 0) / recent.length;
    // A point counts as throttled by its minute (it and the three before it): the rate
    // dips under the bar for a scrape or two while the node is busy (measured on kind).
    const smooth = new Map(
      points.map(([t], i) => {
        const w = points.slice(Math.max(0, i - SMOOTH + 1), i + 1);
        return [t, w.reduce((n, [, v]) => n + Math.min(1, v), 0) / w.length] as const;
      }),
    );
    const times = points.map(([t]) => t);
    const from = runFromTolerant(
      times,
      (t) => (smooth.get(t) ?? 0) >= THROTTLED_SHARE,
      hourFrom,
      step,
      THROTTLE_DIP_S,
    );
    const since = from === null ? null : new Date(from * 1000).toISOString();
    const parts = key.split('/');
    if (ev.platform === 'docker') {
      const c: EvContainer | undefined = ev.containers.find((x) => `${x.host}/${x.name}` === key);
      if (!c) continue;
      out.push({
        object: containerObject(c.host, c.name),
        container: c.name,
        share,
        since,
        limitCores: c.cpuLimitCores,
      });
    } else {
      const [ns, pod, container] = parts as [string, string, string];
      const p = ev.pods.find((x) => x.namespace === ns && x.name === pod);
      if (!p || !container) continue;
      out.push({
        object: podObject(ns, pod),
        container,
        share,
        since,
        limitCores: podCpuLimit(p, container),
      });
    }
  }
  return out.sort((a, b) => b.share - a.share);
}

/** The most throttled container of the focus at or above THROTTLED_SHARE; null otherwise. */
export function throttled(ev: Evidence): Throttling | null {
  const top = throttlings(ev)?.[0];
  return top && top.share >= THROTTLED_SHARE ? top : null;
}

/** A share as the sentences say it: a whole percentage. */
export const sharePct = (share: number) => Math.round(share * 100);
