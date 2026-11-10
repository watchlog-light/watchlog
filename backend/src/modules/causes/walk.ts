// SPDX-License-Identifier: AGPL-3.0-only
// Following dependencies (ADR-146): when the subject's own evidence doesn't explain it, the
// engine follows its failing or slow outgoing edges, at most two hops, asks the same rules
// of the workload or container at the other end, and puts the edge in front of each chain
// it brings back ("frontend calls api → api has 0 ready pods → scaled to 0").
//
// Slice 1 builds the mechanism; the dependency rules (slice 3) decide what counts at the far
// end, and may widen `dependenciesOf` (Docker: an edge seen before its target stopped, gap 3
// in the slice-0 notes).
import { edgeTrouble } from './checks.js';
import type { EvEdge, Evidence } from './evidence.js';
import { edgeObject } from './resolve.js';
import type { Candidate, Step } from './types.js';

export const MAX_HOPS = 2;
/** Edges followed from one object. */
export const MAX_DEPENDENCIES = 3;
/** Chain steps shown: the symptom first, where it starts last (the panel rules). */
export const MAX_STEPS = 3;

/** A dependency the walk may follow: an edge and the map node at its far end. */
export interface Dependency {
  edge: EvEdge;
  /** The far end's map node id: w:<ns>/<Kind>/<name> or c:<container>. */
  target: string;
}

/** The failing or slow outgoing edges that end at a workload or a container, worst first. */
export function dependenciesOf(ev: Evidence): Dependency[] {
  return ev.map.outgoing
    .filter((e) => (e.target.startsWith('w:') || e.target.startsWith('c:')) && edgeTrouble(e))
    .sort(
      (a, b) =>
        (b.failedRatio ?? 0) - (a.failedRatio ?? 0) ||
        (b.http?.serverErrorRatio ?? 0) - (a.http?.serverErrorRatio ?? 0) ||
        (b.http?.p95Seconds ?? 0) - (a.http?.p95Seconds ?? 0),
    )
    .slice(0, MAX_DEPENDENCIES)
    .map((edge) => ({ edge, target: edge.target }));
}

/** The step a followed edge adds in front of a chain: "frontend calls api, and it fails". */
export function edgeStep(ev: Evidence, dep: Dependency): Step {
  const t = edgeTrouble(dep.edge);
  return {
    object: edgeObject(dep.edge, ev.map.nodes, ev.platform),
    source: 'service_map',
    code: `edge_${t?.code ?? 'ok'}`,
    facts: t?.facts ?? {},
    at: null,
    since: null,
    next: 'calls',
  };
}

/** At most MAX_STEPS: the symptom and the steps where it starts, the middle left out. */
export function fitChain(steps: Step[]): Step[] {
  if (steps.length <= MAX_STEPS) return steps;
  return [steps[0]!, ...steps.slice(steps.length - (MAX_STEPS - 1))];
}

/** A cause found at the far end of an edge, as a cause of the near end. */
export function throughEdge(ev: Evidence, dep: Dependency, c: Candidate): Candidate {
  return {
    ...c,
    chain: fitChain([edgeStep(ev, dep), ...c.chain]),
    hops: c.hops + 1,
  };
}
