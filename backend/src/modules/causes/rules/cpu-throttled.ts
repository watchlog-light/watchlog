// SPDX-License-Identifier: AGPL-3.0-only
// cpu_throttled (ADR-150 #11, slice 4, ADR-154): the subject is throttled at its CPU limit for
// 25 % of the time or more while it is slow. The share is the container's throttled seconds a
// second (throttle.ts: no CFS period counter exists, slice 0 gap 6).
//
//   - At the far end of an edge the walk followed for slowness or 5xx (`ev.via`): a slow edge
//     (p95 ≥ 1 s), one answering 5xx, or one whose p95 rose well above its usual one under
//     the slow bar (the e2e hot: 1 ms → 200 ms at a 20m limit). Complete when the throttling
//     began before the slowdown or with it, or both last the whole hour. The walk puts the
//     edge in front: "caller calls hot, its p95 rose from 1 ms to 200 ms → hot is throttled
//     98 % of the time at its 20m CPU limit".
//   - On the object itself: complete when the symptom is the throttling (the "Container CPU
//     throttling" alert) or a caller's calls to it are slow; otherwise a lead (partial).
// Failed connects are not this rule's (dependency_down, connection_refused).
import { edgeTrouble, shortName } from '../checks.js';
import type { Evidence } from '../evidence.js';
import type { Match, Rule } from '../rules.js';
import { sharePct, throttled } from '../throttle.js';
import type { Step } from '../types.js';
import { risenEdge } from '../walk.js';
import { SAME_MS } from './common.js';

/** The default alert rule whose symptom is the throttling itself (ADR-072). */
export const THROTTLING_ALERT = 'k8s.container.throttling';

const ms = (s: string) => Date.parse(s);

/** The throttling began before the slowdown or with it (or both last the whole hour). */
function before(throttledSince: string | null, slowSince: string | null): boolean {
  if (throttledSince === null) return slowSince === null;
  return slowSince !== null && ms(throttledSince) <= ms(slowSince) + SAME_MS;
}

export const cpuThrottled: Rule = {
  code: 'cpu_throttled',
  platforms: ['kubernetes', 'docker'],
  applies: (f) => ['pod', 'workload', 'container', 'compose_service'].includes(f.kind),
  match(ev: Evidence): Match | null {
    const t = throttled(ev);
    if (!t) return null;
    const pct = sharePct(t.share);
    const limit = t.limitCores;
    const step: Step = {
      object: t.object,
      source: 'metrics',
      code: limit ? 'cpu_throttled' : 'cpu_throttled_share',
      facts: limit
        ? { container: t.container, pct, limitCores: limit }
        : { container: t.container, pct },
      at: null,
      since: t.since,
      next: null,
    };
    const target = shortName(ev);
    const via = ev.via;
    if (via) {
      const trouble = edgeTrouble(via.edge);
      const risen = risenEdge(via.edge, via.history);
      if (trouble?.code === 'failed' || !(trouble || risen)) return null;
      const h = via.history;
      const slowSince = trouble
        ? ((trouble.code === 'slow' ? h?.slowSince : h?.troubleSince) ?? null)
        : (h?.risenSince ?? null);
      const p95Ms = Math.round((via.edge.http?.p95Seconds ?? 0) * 1000);
      return {
        code: 'cpu_throttled',
        facts: { name: via.from, target, container: t.container, pct, limitCores: limit, p95Ms },
        since: t.since,
        chain: [step],
        complete: !!h && before(t.since, slowSince),
        headline: limit
          ? {
              code: 'cpu_throttled_dependency',
              facts: { name: via.from, target, pct, limitCores: limit, p95Ms },
            }
          : {
              code: 'cpu_throttled_dependency_share',
              facts: { name: via.from, target, pct, p95Ms },
            },
        explains: ['dependencies'],
      };
    }
    // On the object itself: the throttling alert, or callers whose calls to it are slow.
    const slowCallers = ev.map.incoming.some((e) => {
      const x = edgeTrouble(e);
      return x?.code === 'slow' || x?.code === 'errors';
    });
    return {
      code: 'cpu_throttled',
      facts: { name: target, container: t.container, pct, limitCores: limit },
      since: t.since,
      chain: [step],
      complete: ev.alert?.rule.key === THROTTLING_ALERT || slowCallers,
      headline: limit
        ? { code: 'cpu_throttled', facts: { name: target, pct, limitCores: limit } }
        : { code: 'cpu_throttled_share', facts: { name: target, pct } },
      explains: ['cpu'],
    };
  },
  explains: ['cpu'],
};
