// SPDX-License-Identifier: AGPL-3.0-only
// dependency_down (ADR-150 #1): what the subject calls has nothing ready. It runs at the far
// end of an edge the walk followed (`ev.via`, slice 3), on the dependency's own evidence:
//   - Kubernetes: the workload has no ready pods: scaled to 0 (the scale marker is where it
//     starts), or every pod failing;
//   - Docker (ADR-149): no container of it runs (stopped or exited). A stopped container's
//     name leaves Docker's DNS, so the caller sees failed lookups and an edge that went quiet
//     rather than failed connects (slice 0, gap 3): either counts as the caller's side.
// The dependency's own cause (the object rules: OOM-killed, crashing, a bad change, an image
// it can't pull…) ends the chain: two hops, the caller, the dependency, why it is down. The
// walk puts the edge in front: "web calls api → api has no pods → scaled from 1 to 0".
//
// It covers the object rules on the dependency (their cause is a step of its chain), and the
// caller's dns_nxdomain on Docker (the name that fails is the stopped container's).
import { shortName } from '../checks.js';
import type { EvMarker, Evidence } from '../evidence.js';
import { workloadObject } from '../resolve.js';
import type { Match, Rule, RuleCode } from '../rules.js';
import type { Candidate, Step } from '../types.js';
import { wentQuiet } from '../walk.js';
import { changeObject, containerRef, SAME_MS } from './common.js';
import { OWN_CODES, ownCause, tail } from './own.js';

/** The newest scale-down to 0 of the workload in the window, not after the symptom. */
function scaledToZero(ev: Evidence): EvMarker | null {
  const until = Date.parse(ev.symptomAt ?? ev.window.to) + SAME_MS;
  return (
    ev.changes
      .filter(
        (m) =>
          m.kind === 'scale' &&
          ev.ownTargets.includes(m.target) &&
          Number((m.details as { to?: unknown }).to) === 0 &&
          Date.parse(m.ts) >= Date.parse(ev.window.from) &&
          Date.parse(m.ts) <= until,
      )
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0] ?? null
  );
}

/** The headline from the dependency's own cause, when there is one. */
function headline(
  name: string,
  target: string,
  own: Candidate | null,
  fallback: Match['headline'],
) {
  const f = own?.facts ?? {};
  if (own?.rule === 'oom_limit' && typeof f.limitBytes === 'number')
    return { code: 'dependency_down_oom', facts: { name, target, limitBytes: f.limitBytes } };
  if (own?.rule === 'crash_exit' && typeof f.exitCode === 'number')
    return { code: 'dependency_down_crash', facts: { name, target, exitCode: f.exitCode } };
  if (own?.rule === 'bad_change')
    return { code: 'dependency_down_change', facts: { name, target } };
  if (own?.rule === 'image_pull' && f.image)
    return { code: 'dependency_down_pull', facts: { name, target, image: f.image } };
  return fallback;
}

function kube(ev: Evidence): Match | null {
  const w = ev.workload;
  if (!w || w.ready === null || w.ready > 0) return null;
  const via = ev.via!;
  const name = via.from;
  const target = shortName(ev);
  const object = workloadObject(w.namespace, w.kind, w.name);
  const scale = (w.desired ?? 0) === 0 ? scaledToZero(ev) : null;
  const own = scale ? null : ownCause(ev);
  const since = scale?.ts ?? own?.since ?? via.history?.troubleSince ?? null;
  const down: Step = {
    object,
    source: 'kubernetes',
    code: (w.desired ?? 0) === 0 ? 'no_pods' : 'no_ready_pods',
    facts: (w.desired ?? 0) === 0 ? {} : { n: w.desired },
    at: null,
    since,
    next: scale || own ? 'because' : null,
  };
  const rest: Step[] = scale
    ? [
        {
          object: changeObject(ev, scale),
          source: 'change_marker',
          code: 'scaled',
          facts: {
            from: Number((scale.details as { from?: unknown }).from ?? 0),
            to: 0,
          },
          at: scale.ts,
          since: null,
          next: null,
        },
      ]
    : own
      ? tail(own.chain, 1)
      : [];
  return {
    code: 'dependency_down',
    facts: { name, target, platform: 'kubernetes', ready: 0, desired: w.desired ?? 0 },
    since,
    chain: [down, ...rest],
    complete: true,
    headline: scale
      ? { code: 'dependency_down_scaled', facts: { name, target } }
      : headline(name, target, own, { code: 'dependency_down', facts: { name, target } }),
    covers: OWN_CODES as RuleCode[],
  };
}

function docker(ev: Evidence): Match | null {
  const via = ev.via!;
  if (!ev.containers.length || ev.containers.some((c) => c.state === 'running')) return null;
  // The caller's side: failed connects, an edge that went quiet, or failed lookups.
  const quiet = wentQuiet(via.edge, via.history, ev.now);
  if (!quiet && via.dnsErrorsPerSecond <= 0 && via.edge.failedPerSecond <= 0) return null;
  const c = [...ev.containers].sort(
    (a, b) => Date.parse(b.finishedAt ?? '') - Date.parse(a.finishedAt ?? ''),
  )[0]!;
  const name = via.from;
  const target = shortName(ev);
  const own = ownCause(ev);
  const since =
    (c.finishedAt && !Number.isNaN(Date.parse(c.finishedAt)) ? c.finishedAt : null) ??
    own?.since ??
    null;
  const stopped: Step = {
    object: containerRef(c),
    source: 'docker',
    code: 'container_stopped',
    facts: { exitCode: c.exitCode },
    at: since,
    since: null,
    next: null,
  };
  return {
    code: 'dependency_down',
    facts: { name, target, platform: 'docker', exitCode: c.exitCode },
    since,
    chain: own ? tail(own.chain, 2) : [stopped],
    complete: true,
    headline: headline(name, target, own, {
      code: 'dependency_down_stopped',
      facts: { name, target, exitCode: c.exitCode },
    }),
    covers: OWN_CODES as RuleCode[],
    coversCaller: ['dns_nxdomain'],
  };
}

export const dependencyDown: Rule = {
  code: 'dependency_down',
  platforms: ['kubernetes', 'docker'],
  // Only at the far end of an edge: on its own, a workload scaled to 0 is no problem.
  applies: (f) => ['workload', 'container', 'compose_service'].includes(f.kind),
  match: (ev) => (!ev.via ? null : ev.platform === 'docker' ? docker(ev) : kube(ev)),
  explains: ['dependencies'],
};
