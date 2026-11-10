// SPDX-License-Identifier: AGPL-3.0-only
// Following dependencies (ADR-146): when the subject's own evidence doesn't explain it, the
// engine follows its failing or slow outgoing edges, at most two hops, asks the same rules
// of the workload or container at the other end, and puts the edge in front of each chain
// it brings back ("frontend calls api → api has 0 ready pods → scaled to 0").
//
// Slice 3 (ADR-153): the far end knows the edge that led there (`ev.via`, with the edge's
// last hour), so the rules across the map can tell a failing edge from one that went quiet.
// On Docker a stopped container's name leaves Docker's DNS, so its callers never connect:
// no failed connects, only the caller's failed lookups and an edge that went quiet (slice 0,
// gap 3). Such edges are followed too, while the caller's lookups fail.
import {
  DNS_ERROR_RATIO,
  dnsTotals,
  EDGE_FAILED_RATIO,
  EDGE_SLOW_P95_S,
  edgeTrouble,
} from './checks.js';
import type { EdgeHistory, EvEdge, Evidence } from './evidence.js';
import { edgeObject } from './resolve.js';
import type { Candidate, CheckTopic, Step } from './types.js';

export const MAX_HOPS = 2;
/** Edges followed from one object. */
export const MAX_DEPENDENCIES = 3;
/** Chain steps shown: the symptom first, where it starts last (the panel rules). */
export const MAX_STEPS = 3;
/** An edge with no connection for this long went quiet (its series lags about a minute). */
export const QUIET_MS = 2 * 60_000;
/** The p95 "before" a slowdown is that of the 5 minutes before it. */
const BEFORE_S = 5 * 60;

/** A dependency the walk may follow: an edge and the map node at its far end. */
export interface Dependency {
  edge: EvEdge;
  /** The far end's map node id: w:<ns>/<Kind>/<name> or c:<container>. */
  target: string;
  /** The edge's last hour, when it was read (the engine reads it before following). */
  history?: EdgeHistory | null;
}

const toObject = (id: string) => id.startsWith('w:') || id.startsWith('c:');

/** The caller's lookups fail (any failure; search misses left out). */
export function lookupsFail(ev: Evidence): boolean {
  const d = dnsTotals(ev);
  return d.errors > 0 && d.errors / Math.max(d.lookups, d.errors) >= DNS_ERROR_RATIO;
}

/**
 * The outgoing edges the walk follows, at most three: failing or slow ones that end at a
 * workload or a container, worst first; then, on Docker while the caller's lookups fail, the
 * edges to containers that carry the least now (a stopped container's edge goes quiet).
 */
export function dependenciesOf(ev: Evidence): Dependency[] {
  const troubled = ev.map.outgoing
    .filter((e) => toObject(e.target) && edgeTrouble(e))
    .sort(
      (a, b) =>
        (b.failedRatio ?? 0) - (a.failedRatio ?? 0) ||
        (b.http?.serverErrorRatio ?? 0) - (a.http?.serverErrorRatio ?? 0) ||
        (b.http?.p95Seconds ?? 0) - (a.http?.p95Seconds ?? 0),
    );
  const quiet =
    ev.platform === 'docker' && lookupsFail(ev)
      ? ev.map.outgoing
          .filter((e) => e.target.startsWith('c:') && !edgeTrouble(e))
          .sort((a, b) => a.connectionsPerSecond - b.connectionsPerSecond)
      : [];
  return [...troubled, ...quiet]
    .slice(0, MAX_DEPENDENCIES)
    .map((edge) => ({ edge, target: edge.target }));
}

/** One edge series of GET /service-map/edge, as far as the walk reads it. */
export interface EdgeSeries {
  step: number;
  connections: [number, number | null][];
  failed: [number, number | null][];
  httpRequests?: [number, number | null][];
  http5xx?: [number, number | null][];
  httpP95?: [number, number | null][];
}

const isoS = (t: number) => new Date(t * 1000).toISOString();

/**
 * The first time of the run of points that lasts to the newest one (`times` ascending); null
 * when the newest isn't in it, or when the run reaches back to the start of the range asked
 * from `fromS` (it began before). A series that begins inside the range (a new edge, a new
 * client) began with its first point.
 */
export function runFrom(
  times: number[],
  is: (t: number) => boolean,
  fromS: number,
  step: number,
): number | null {
  let i = times.length - 1;
  if (i < 0 || !is(times[i]!)) return null;
  while (i > 0 && is(times[i - 1]!)) i--;
  if (i > 0) return times[i]!;
  return times[0]! - fromS > 2 * step ? times[0]! : null;
}

/**
 * The edge's last hour from its series (asked from `fromS`, unix seconds): when its trouble and
 * its slowness began, its last connection.
 */
export function edgeHistory(s: EdgeSeries, fromS: number): EdgeHistory {
  const at = (pts: [number, number | null][] | undefined) =>
    new Map((pts ?? []).filter((p) => p[1] !== null).map((p) => [p[0], p[1]!]));
  const conn = at(s.connections);
  const failed = at(s.failed);
  const req = at(s.httpRequests);
  const errs = at(s.http5xx);
  const p95 = at(s.httpP95);
  const times = [...new Set([...conn.keys(), ...failed.keys(), ...req.keys(), ...p95.keys()])].sort(
    (a, b) => a - b,
  );
  const troubled = (t: number) => {
    const c = conn.get(t) ?? 0;
    const f = failed.get(t) ?? 0;
    const r = req.get(t) ?? 0;
    const e = errs.get(t) ?? 0;
    return (
      (f > 0 && f / Math.max(c, f) >= EDGE_FAILED_RATIO) || (r > 0 && e / r >= EDGE_FAILED_RATIO)
    );
  };
  const slow = (t: number) => (p95.get(t) ?? 0) >= EDGE_SLOW_P95_S;
  const runStart = (is: (t: number) => boolean) => runFrom(times, is, fromS, s.step);
  const trouble = runStart(troubled);
  const slowFrom = runStart(slow);
  // The p95 just before the slowdown: the median of the last 5 minutes before it (earlier
  // in the hour it may have been slow already, before a restore).
  const before =
    slowFrom === null
      ? []
      : times
          .filter((t) => t < slowFrom && t >= slowFrom - BEFORE_S && p95.has(t))
          .map((t) => p95.get(t)!)
          .sort((a, b) => a - b);
  const lastConn = [...conn].filter(([, v]) => v > 0).map(([t]) => t);
  return {
    troubleSince: trouble === null ? null : isoS(trouble),
    slowSince: slowFrom === null ? null : isoS(slowFrom),
    p95Before: before.length ? before[Math.floor(before.length / 2)]! : null,
    lastConnectedAt: lastConn.length ? isoS(Math.max(...lastConn)) : null,
    end: times.length ? isoS(times[times.length - 1]!) : null,
  };
}

/** The edge carried no connection for a while (QUIET_MS before `now`). */
export function wentQuiet(edge: EvEdge, history: EdgeHistory | null | undefined, now: number) {
  if (edgeTrouble(edge) || !history) return false;
  return !history.lastConnectedAt || now - Date.parse(history.lastConnectedAt) >= QUIET_MS;
}

/** The step a followed edge adds in front of a chain: "frontend calls api, and it fails". */
export function edgeStep(ev: Evidence, dep: Dependency): Step {
  const t = edgeTrouble(dep.edge);
  const h = dep.history ?? null;
  const step: Step = {
    object: edgeObject(dep.edge, ev.map.nodes, ev.platform),
    source: 'service_map',
    code: `edge_${t?.code ?? 'ok'}`,
    facts: t?.facts ?? {},
    at: null,
    since: t ? ((t.code === 'slow' ? h?.slowSince : h?.troubleSince) ?? null) : null,
    next: 'calls',
  };
  if (!t && wentQuiet(dep.edge, h, ev.now)) {
    const dns = dnsTotals(ev);
    return lookupsFail(ev)
      ? {
          ...step,
          code: 'edge_gone_dns',
          facts: { perMinute: Math.round(dns.errors * 60) },
          since: h?.lastConnectedAt ?? null,
          source: 'dns',
        }
      : { ...step, code: 'edge_gone', facts: {}, since: h?.lastConnectedAt ?? null };
  }
  return step;
}

/** At most MAX_STEPS: the symptom and the steps where it starts, the middle left out. */
export function fitChain(steps: Step[]): Step[] {
  if (steps.length <= MAX_STEPS) return steps;
  return [steps[0]!, ...steps.slice(steps.length - (MAX_STEPS - 1))];
}

/**
 * A cause found at the far end of an edge, as a cause of the near end: the edge in front, and
 * it explains the near end's dependency check (and its DNS check, when the edge step is the
 * failed lookups).
 */
export function throughEdge(ev: Evidence, dep: Dependency, c: Candidate): Candidate {
  const step = edgeStep(ev, dep);
  const explains: CheckTopic[] =
    step.code === 'edge_gone_dns' ? ['dependencies', 'dns'] : ['dependencies'];
  const rest = { ...c };
  delete rest.coversCaller;
  return {
    ...rest,
    chain: fitChain([step, ...c.chain]),
    hops: c.hops + 1,
    explains,
  };
}
